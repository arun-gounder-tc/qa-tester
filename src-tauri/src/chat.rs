use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize, Clone)]
pub struct EnvContext {
    pub name: String,
    #[serde(rename = "deployedUrl")]
    pub deployed_url: String,
    #[serde(rename = "codeBranch")]
    pub code_branch: String,
    #[serde(rename = "worktreePath")]
    pub worktree_path: Option<String>,
    #[serde(rename = "projectType", default)]
    pub project_type: Option<String>,
    #[serde(rename = "framework", default)]
    pub framework: Option<String>,
}

/// Result of one chat turn — the assistant's reply plus the Claude CLI
/// session id. The frontend stores the session id so the next turn can
/// `--resume` it, which keeps the conversation context warm and avoids
/// re-reading the codebase from scratch every message.
#[derive(Serialize)]
pub struct ChatResult {
    pub reply: String,
    pub session_id: Option<String>,
}

/// Human-readable progress update streamed to the UI while Claude works,
/// so the tester sees "Reading login.cy.js" instead of a frozen spinner.
#[derive(Serialize, Clone)]
struct ChatProgress {
    request_id: String,
    status: String,
}

const MAX_HISTORY_TURNS: usize = 8;

/// Detects whether the Claude CLI is reachable. Used by the workspace to
/// show an "install Claude Code" empty state if it isn't.
#[tauri::command]
pub fn chat_available() -> bool {
    Command::new("claude")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Sends a user message to Claude and returns the assistant reply + session
/// id. When `session_id` is provided the existing Claude session is resumed
/// (fast — context already loaded); otherwise a fresh session is started
/// with the full workspace context and recent history. Progress is streamed
/// to the UI via `chat-progress:<request_id>` events the whole time.
#[tauri::command]
pub async fn chat_send(
    app: tauri::AppHandle,
    request_id: String,
    repo_path: String,
    env_context: Option<EnvContext>,
    history: Vec<ChatMessage>,
    message: String,
    session_id: Option<String>,
) -> Result<ChatResult, String> {
    tokio::task::spawn_blocking(move || -> Result<ChatResult, String> {
        // First attempt: resume the existing session if we have one,
        // otherwise start fresh with the full context.
        let first_prompt = match &session_id {
            Some(_) => build_resume_prompt(&message),
            None => build_initial_prompt(env_context.as_ref(), &history, &message),
        };

        let attempt = run_claude(
            &app,
            &request_id,
            &repo_path,
            &first_prompt,
            session_id.as_deref(),
        );

        match attempt {
            Ok(result) => Ok(result),
            Err(err) => {
                // A resume can fail if the session expired or was cleaned
                // up. Fall back to a fresh session with full context.
                if session_id.is_some() {
                    emit_progress(&app, &request_id, "Reconnecting…");
                    let fresh =
                        build_initial_prompt(env_context.as_ref(), &history, &message);
                    run_claude(&app, &request_id, &repo_path, &fresh, None)
                } else {
                    Err(err)
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Spawns `claude -p` in stream-json mode, relays progress events to the
/// UI as Claude works, and returns the final reply + session id.
///
/// Flags:
///   --output-format stream-json --verbose — emits NDJSON events (tool
///     uses, results) so we can show live progress instead of a frozen wait.
///   --permission-mode acceptEdits — auto-approves file writes so the
///     tester never sees raw Claude permission prompts.
///   --disallowedTools Bash — keeps the assistant from running shell
///     commands; test execution has its own dedicated UI.
///   --resume <id> — continues an existing session (context stays warm).
fn run_claude(
    app: &tauri::AppHandle,
    request_id: &str,
    repo_path: &str,
    prompt: &str,
    resume_session: Option<&str>,
) -> Result<ChatResult, String> {
    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg("acceptEdits")
        .arg("--disallowedTools")
        .arg("Bash");
    if let Some(sid) = resume_session {
        cmd.arg("--resume").arg(sid);
    }
    cmd.current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Claude CLI not found. Install Claude Code and make sure `claude` is on your PATH.".to_string()
        } else {
            format!("Failed to spawn claude: {}", e)
        }
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("Failed to send prompt: {}", e))?;
        // Drop stdin so claude sees EOF and starts processing.
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Drain stderr on a side thread so a chatty stream can't deadlock us.
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf);
        buf
    });

    emit_progress(app, request_id, "Thinking…");

    let mut reply = String::new();
    let mut session = resume_session.map(|s| s.to_string());

    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            handle_event(app, request_id, &value, &mut reply, &mut session);
        }
    }

    let status = child.wait().map_err(|e| format!("Wait failed: {}", e))?;
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        let detail: String = stderr_text.trim().chars().take(500).collect();
        return Err(if detail.is_empty() {
            "Claude exited with an error.".to_string()
        } else {
            format!("Claude error: {}", detail)
        });
    }

    if reply.trim().is_empty() {
        return Err("Claude returned an empty response.".to_string());
    }

    Ok(ChatResult {
        reply: reply.trim().to_string(),
        session_id: session,
    })
}

/// Interprets one stream-json event line: updates the running reply /
/// session id, and emits a friendly progress label to the UI.
fn handle_event(
    app: &tauri::AppHandle,
    request_id: &str,
    value: &serde_json::Value,
    reply: &mut String,
    session: &mut Option<String>,
) {
    match value["type"].as_str().unwrap_or("") {
        "system" => {
            if value["subtype"].as_str() == Some("init") {
                if let Some(sid) = value["session_id"].as_str() {
                    *session = Some(sid.to_string());
                }
                emit_progress(app, request_id, "Getting ready…");
            }
        }
        "assistant" => {
            if let Some(blocks) = value["message"]["content"].as_array() {
                for block in blocks {
                    match block["type"].as_str() {
                        Some("tool_use") => {
                            let name = block["name"].as_str().unwrap_or("");
                            emit_progress(
                                app,
                                request_id,
                                &describe_tool(name, &block["input"]),
                            );
                        }
                        Some("text") => {
                            emit_progress(app, request_id, "Writing response…");
                        }
                        _ => {}
                    }
                }
            }
        }
        "result" => {
            if let Some(sid) = value["session_id"].as_str() {
                *session = Some(sid.to_string());
            }
            if let Some(text) = value["result"].as_str() {
                *reply = text.to_string();
            }
        }
        _ => {}
    }
}

/// Maps a tool name + input into a label a non-technical tester understands.
fn describe_tool(name: &str, input: &serde_json::Value) -> String {
    let basename = |key: &str| -> Option<String> {
        input[key]
            .as_str()
            .and_then(|p| p.rsplit(['/', '\\']).next())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };
    match name {
        "Read" => match basename("file_path") {
            Some(f) => format!("Reading {}", f),
            None => "Reading a file…".to_string(),
        },
        "Edit" | "MultiEdit" => match basename("file_path") {
            Some(f) => format!("Editing {}", f),
            None => "Editing a file…".to_string(),
        },
        "Write" => match basename("file_path") {
            Some(f) => format!("Writing {}", f),
            None => "Writing a file…".to_string(),
        },
        "Glob" => "Looking through files…".to_string(),
        "Grep" => "Searching the code…".to_string(),
        "TodoWrite" => "Planning the steps…".to_string(),
        "Task" => "Researching…".to_string(),
        "WebFetch" | "WebSearch" => "Checking the web…".to_string(),
        _ => "Working…".to_string(),
    }
}

fn emit_progress(app: &tauri::AppHandle, request_id: &str, status: &str) {
    let _ = app.emit(
        &format!("chat-progress:{}", request_id),
        ChatProgress {
            request_id: request_id.to_string(),
            status: status.to_string(),
        },
    );
}

/// Full prompt for the first message of a thread — establishes workspace
/// context + recent history. Later turns use `--resume`, so this is only
/// built once per session (or on a fallback reconnect).
fn build_initial_prompt(
    env: Option<&EnvContext>,
    history: &[ChatMessage],
    new_message: &str,
) -> String {
    let mut s = String::new();

    if let Some(env) = env {
        s.push_str("=== Active workspace context ===\n");
        s.push_str(&format!("Environment: {}\n", env.name));
        s.push_str(&format!("Deployed URL: {}\n", env.deployed_url));
        s.push_str(&format!("Code branch: {}\n", env.code_branch));
        if let Some(framework) = &env.framework {
            s.push_str(&format!("Framework: {}\n", framework));
        }
        if let Some(kind) = &env.project_type {
            s.push_str(&format!("Project type: {}\n", kind));
        }
        if let Some(wt) = &env.worktree_path {
            s.push_str(&format!("Source code location: {}\n", wt));
            s.push('\n');
            s.push_str(
                "IMPORTANT: When the tester asks about selectors, components, page \
                routes, form fields, or any UI detail you don't already know, READ \
                files from the source code location above using your Read/Glob/Grep \
                tools. Look for `data-testid`, `id`, `name`, role attributes, form \
                labels, route definitions, etc. Do NOT ask the tester for technical \
                details — they don't know them.\n",
            );
            s.push('\n');
            s.push_str(
                "SPEED: This is a continuing conversation — you keep full context \
                between messages. Only read a file when you actually need a detail \
                you don't have yet; if you already read it earlier in this \
                conversation, reuse what you learned. For simple questions, answer \
                directly without exploring the codebase. Keep replies fast.\n",
            );
            s.push('\n');
            s.push_str(&format!(
                "Use `{}` as the base URL in `cy.visit()` calls when no specific URL is given.\n",
                env.deployed_url
            ));
        } else {
            s.push_str(
                "\nSource code worktree isn't ready yet — work from the tests/ \
                folder and the deployed URL only. Don't reference source files.\n",
            );
        }
        s.push('\n');
    }

    if !history.is_empty() {
        s.push_str("=== Recent conversation ===\n\n");
        let tail_start = history.len().saturating_sub(MAX_HISTORY_TURNS);
        for msg in &history[tail_start..] {
            let label = if msg.role == "user" { "Tester" } else { "You" };
            s.push_str(&format!("{}: {}\n\n", label, msg.content));
        }
    }

    s.push_str("=== New tester message ===\n");
    s.push_str(new_message);
    s.push_str("\n\nRespond to the latest tester message. Follow the conventions in CLAUDE.md.");
    s
}

/// Prompt for a resumed session — Claude already holds the workspace
/// context and every prior turn, so we only send the new message.
fn build_resume_prompt(new_message: &str) -> String {
    format!(
        "{}\n\n(Continuing our conversation — you still have the workspace context \
        and everything you read earlier. Reuse what you already know; only read \
        files if you genuinely need a new detail. Follow CLAUDE.md conventions.)",
        new_message
    )
}
