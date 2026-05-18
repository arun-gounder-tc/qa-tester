use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// Sentinel error string for a chat turn the user cancelled. Used to keep
/// the cancel path out of the normal error UI (no toast, no "(error) …"
/// reply — just a graceful stop).
const CANCEL_SENTINEL: &str = "__chat_cancelled__";

/// Tracks one in-flight chat request so `chat_cancel` can kill it.
struct CancelToken {
    /// Set to `true` by `chat_cancel`. Read at safe checkpoints so we
    /// never silently retry / fall back after the user pressed Stop.
    cancelled: AtomicBool,
    /// Handle to the running `claude` child process. Held in an Option
    /// because the child only exists between spawn and wait.
    child: Mutex<Option<Child>>,
}

/// Global request_id → CancelToken registry. Populated by `chat_send`
/// for the duration of one turn, looked up by `chat_cancel`.
fn cancel_registry() -> &'static Mutex<HashMap<String, Arc<CancelToken>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<CancelToken>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

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

/// Auth status returned to the UI. `cli_missing` means the binary isn't on
/// PATH — show the install Claude Code prompt. Otherwise the UI reads
/// `logged_in` to decide between login button vs. the chat composer.
#[derive(Serialize, Default)]
pub struct AuthStatus {
    pub cli_missing: bool,
    pub logged_in: bool,
    pub email: Option<String>,
    pub auth_method: Option<String>,
    pub subscription_type: Option<String>,
}

/// Runs `claude auth status --json` and parses the result. The CLI exits
/// non-zero when not logged in but still prints valid JSON, so we read
/// stdout regardless of exit code.
#[tauri::command]
pub fn chat_auth_status() -> AuthStatus {
    let mut status = AuthStatus::default();

    let output = Command::new("claude")
        .arg("auth")
        .arg("status")
        .arg("--json")
        .stdin(Stdio::null())
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                status.cli_missing = true;
            }
            return status;
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        status.logged_in = value["loggedIn"].as_bool().unwrap_or(false);
        status.email = value["email"].as_str().map(|s| s.to_string());
        status.auth_method = value["authMethod"].as_str().map(|s| s.to_string());
        status.subscription_type = value["subscriptionType"].as_str().map(|s| s.to_string());
    }
    status
}

/// Tracks one in-flight login attempt so the UI can cancel it (user closed
/// the modal without finishing the OAuth flow in the browser).
struct LoginToken {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

fn login_registry() -> &'static Mutex<HashMap<String, Arc<LoginToken>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<LoginToken>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Spawns `claude auth login`. The CLI opens the user's default browser to
/// the Anthropic OAuth page and runs a localhost callback server itself —
/// we just wait for the process to exit. Output is streamed to the UI as
/// `claude-login:<request_id>` events so the user sees what's happening.
/// Returns true when login succeeded (process exit 0 + auth status confirms).
#[tauri::command]
pub async fn chat_login_start(
    app: tauri::AppHandle,
    request_id: String,
    use_console: bool,
) -> Result<bool, String> {
    let token = Arc::new(LoginToken {
        cancelled: AtomicBool::new(false),
        child: Mutex::new(None),
    });
    login_registry()
        .lock()
        .unwrap()
        .insert(request_id.clone(), token.clone());

    let request_id_for_cleanup = request_id.clone();
    let token_for_task = token.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let mut cmd = Command::new("claude");
        cmd.arg("auth").arg("login");
        if use_console {
            cmd.arg("--console");
        } else {
            cmd.arg("--claudeai");
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Claude CLI not found. Install Claude Code first.".to_string()
            } else {
                format!("Failed to start login: {}", e)
            }
        })?;

        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

        *token_for_task.child.lock().unwrap() = Some(child);
        if token_for_task.cancelled.load(Ordering::SeqCst) {
            if let Some(c) = token_for_task.child.lock().unwrap().as_mut() {
                let _ = c.kill();
            }
        }

        // Stream stderr on a side thread (claude prints the auth URL to stderr).
        let app_for_stderr = app.clone();
        let request_id_for_stderr = request_id.clone();
        let stderr_handle = std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                emit_login_line(&app_for_stderr, &request_id_for_stderr, &line);
            }
        });

        // Main thread reads stdout.
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            emit_login_line(&app, &request_id, &line);
        }

        let _ = stderr_handle.join();

        let mut child = token_for_task
            .child
            .lock()
            .unwrap()
            .take()
            .ok_or("Login child missing")?;
        let status = child.wait().map_err(|e| format!("Wait failed: {}", e))?;

        if token_for_task.cancelled.load(Ordering::SeqCst) {
            return Err("__login_cancelled__".to_string());
        }

        if !status.success() {
            return Err(format!(
                "Login exited with code {}",
                status.code().unwrap_or(-1)
            ));
        }

        // Confirm with a fresh status check — login could succeed silently
        // and we want a single source of truth.
        let confirm = chat_auth_status();
        Ok(confirm.logged_in)
    })
    .await;

    login_registry()
        .lock()
        .unwrap()
        .remove(&request_id_for_cleanup);

    match result {
        Ok(r) => r,
        Err(e) => Err(format!("Task error: {}", e)),
    }
}

#[tauri::command]
pub fn chat_login_cancel(request_id: String) -> Result<(), String> {
    let token = login_registry().lock().unwrap().get(&request_id).cloned();
    if let Some(t) = token {
        t.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = t.child.lock() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn chat_logout() -> Result<(), String> {
    let status = Command::new("claude")
        .arg("auth")
        .arg("logout")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to logout: {}", e))?;
    if !status.status.success() {
        let detail = String::from_utf8_lossy(&status.stderr);
        return Err(format!("Logout failed: {}", detail.trim()));
    }
    Ok(())
}

#[derive(Serialize, Clone)]
struct LoginLine {
    request_id: String,
    line: String,
}

fn emit_login_line(app: &tauri::AppHandle, request_id: &str, line: &str) {
    let trimmed = line.trim_end();
    if trimmed.is_empty() {
        return;
    }
    let _ = app.emit(
        &format!("claude-login:{}", request_id),
        LoginLine {
            request_id: request_id.to_string(),
            line: trimmed.to_string(),
        },
    );
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
    attachment_paths: Option<Vec<String>>,
) -> Result<ChatResult, String> {
    let attachments = attachment_paths.unwrap_or_default();
    // Register a cancel token so `chat_cancel` can find and kill this turn.
    let token = Arc::new(CancelToken {
        cancelled: AtomicBool::new(false),
        child: Mutex::new(None),
    });
    cancel_registry()
        .lock()
        .unwrap()
        .insert(request_id.clone(), token.clone());

    let request_id_for_cleanup = request_id.clone();
    let token_for_task = token.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<ChatResult, String> {
        // First attempt: resume the existing session if we have one,
        // otherwise start fresh with the full context.
        let first_prompt = match &session_id {
            Some(_) => build_resume_prompt(&message, &attachments),
            None => build_initial_prompt(env_context.as_ref(), &history, &message, &attachments),
        };

        let attempt = run_claude(
            &app,
            &request_id,
            &repo_path,
            &first_prompt,
            session_id.as_deref(),
            &token_for_task,
        );

        // If the user cancelled, never silently fall back — return the
        // cancel sentinel so the frontend can show a graceful "stopped"
        // message instead of a confusing reconnect.
        if token_for_task.cancelled.load(Ordering::SeqCst) {
            return Err(CANCEL_SENTINEL.to_string());
        }

        match attempt {
            Ok(result) => Ok(result),
            Err(err) => {
                // A resume can fail if the session expired or was cleaned
                // up. Fall back to a fresh session with full context.
                if session_id.is_some() {
                    emit_progress(&app, &request_id, "Reconnecting…");
                    let fresh =
                        build_initial_prompt(env_context.as_ref(), &history, &message, &attachments);
                    let retry = run_claude(
                        &app,
                        &request_id,
                        &repo_path,
                        &fresh,
                        None,
                        &token_for_task,
                    );
                    if token_for_task.cancelled.load(Ordering::SeqCst) {
                        return Err(CANCEL_SENTINEL.to_string());
                    }
                    retry
                } else {
                    Err(err)
                }
            }
        }
    })
    .await;

    // Always clean up the registry entry — even on panics / cancel.
    cancel_registry()
        .lock()
        .unwrap()
        .remove(&request_id_for_cleanup);

    result.map_err(|e| format!("Task error: {}", e))?
}

/// Cancels an in-flight `chat_send` by request id. Sets the cancel flag
/// (so the task won't fall back to a fresh attempt) and kills the running
/// `claude` child process (so the reader loop wakes up immediately).
#[tauri::command]
pub fn chat_cancel(request_id: String) -> Result<(), String> {
    let token = cancel_registry()
        .lock()
        .unwrap()
        .get(&request_id)
        .cloned();
    if let Some(t) = token {
        t.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = t.child.lock() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
            }
        }
    }
    Ok(())
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
    token: &Arc<CancelToken>,
) -> Result<ChatResult, String> {
    // Bail before spawning if the user already pressed Stop.
    if token.cancelled.load(Ordering::SeqCst) {
        return Err(CANCEL_SENTINEL.to_string());
    }

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

    // Hand the child to the cancel token so `chat_cancel` can kill it.
    // If the user cancelled between spawn and registration, kill now.
    *token.child.lock().unwrap() = Some(child);
    if token.cancelled.load(Ordering::SeqCst) {
        if let Some(c) = token.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }

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

    // Take the child back so we can wait on it (also frees the slot so a
    // later `chat_cancel` no-ops cleanly instead of poking a dead handle).
    let mut child = token
        .child
        .lock()
        .unwrap()
        .take()
        .ok_or("Child handle missing")?;
    let status = child.wait().map_err(|e| format!("Wait failed: {}", e))?;
    let stderr_text = stderr_handle.join().unwrap_or_default();

    // Cancel beats any error from the killed process.
    if token.cancelled.load(Ordering::SeqCst) {
        return Err(CANCEL_SENTINEL.to_string());
    }

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
    attachments: &[String],
) -> String {
    let mut s = String::new();

    s.push_str(&choices_instruction());
    s.push('\n');

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
            // Strict tool-use gating. The first message of a thread already
            // includes the full env context above — Claude does NOT need to
            // explore the codebase to orient itself. Only touch files when
            // the tester's request literally requires a new technical
            // detail. This keeps simple chats (greetings, explanations,
            // status questions) fast — no file reads, no extra latency.
            s.push_str(
                "TOOL USE RULES (read carefully):\n\
                1. DEFAULT = no tools. Reply from what you already know and \
                from the context above. Do not run Read / Glob / Grep \
                speculatively to \"orient yourself\" — you are already \
                oriented.\n\
                2. Use Read / Glob / Grep ONLY when the tester's message \
                literally requires a UI detail you do not have (e.g. \"write \
                a test that logs in\" → you may need to find the login form's \
                selectors). Greetings, small talk, conceptual questions, \
                \"what tests exist\", \"explain X\" — answer directly, no \
                file reads.\n\
                3. Never ask the tester for technical details — they don't \
                know selectors / routes / component names. When you genuinely \
                need them, read the source yourself.\n\
                4. Within one conversation, reuse what you read earlier; \
                never re-read the same file.\n",
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
    s.push_str(&format_attachments_block(attachments));
    s.push_str("\n\nRespond to the latest tester message. Follow the conventions in CLAUDE.md.");
    s
}

/// Prompt for a resumed session — Claude already holds the workspace
/// context and every prior turn, so we only send the new message.
fn build_resume_prompt(new_message: &str, attachments: &[String]) -> String {
    let mut s = String::new();
    s.push_str(new_message);
    s.push_str(&format_attachments_block(attachments));
    s.push_str(
        "\n\n(Continuing our conversation — you still have the workspace context \
        and everything you read earlier. Reuse what you already know; only read \
        files if you genuinely need a new detail. Follow CLAUDE.md conventions.)",
    );
    s.push_str(&format!("\n\n{}", choices_instruction()));
    s
}

/// Appends an "Attached files" block telling Claude exactly where each
/// dropped file lives so it can Read them directly without asking the user.
fn format_attachments_block(attachments: &[String]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n\n=== Attached files (the tester uploaded these via the chat UI) ===\n");
    for path in attachments {
        s.push_str(&format!("- {}\n", path));
    }
    s.push_str(
        "\nThese files are inside the workspace, so use the Read tool on the absolute path above \
        to inspect them. Image / PDF / binary files: read them with the Read tool too — it handles \
        non-text content. Do NOT ask the tester for permission or for the file again; you already \
        have access.",
    );
    s
}

/// System instruction telling Claude how to ask multiple-choice questions
/// so the frontend can render them as clickable buttons.
fn choices_instruction() -> String {
    String::from(
        "=== Chat UI capabilities ===\n\
        When you need the tester to pick from a small set of options (e.g. \"Which login form \
        should I target?\"), end your reply with a <choices> block listing the options. The UI \
        will render each <option> as a clickable button and send the tester's pick back as their \
        next message verbatim. Format strictly:\n\n\
        <choices>\n  <option>First choice text</option>\n  <option>Second choice text</option>\n</choices>\n\n\
        Rules: 2–5 options max, each option a short complete phrase the tester can act on, \
        no markdown / numbering / bullets inside <option>. Only use this when a discrete choice \
        is needed — never for open-ended questions or confirmations like \"shall I proceed?\".",
    )
}

/// Saves an uploaded file from the chat UI to `<repo>/.qa-tester/attachments/`
/// and returns its absolute path. The directory lives inside the repo so
/// Claude's normal workspace permissions cover it — no `--add-dir` needed.
/// Filenames are prefixed with an epoch-ms stamp to avoid collisions when the
/// user attaches two files with the same name.
#[tauri::command]
pub fn save_attachment(
    repo_path: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let safe_name = sanitize_filename(&name);
    if safe_name.is_empty() {
        return Err("Empty filename".to_string());
    }

    let dir = PathBuf::from(&repo_path)
        .join(".qa-tester")
        .join("attachments");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create attachment dir: {}", e))?;

    // Ensure .gitignore so attachments don't accidentally get committed.
    let gitignore = PathBuf::from(&repo_path).join(".qa-tester").join(".gitignore");
    if !gitignore.exists() {
        let _ = fs::write(&gitignore, "# QA Tester local cache — do not commit\n*\n");
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let final_name = format!("{}-{}", stamp, safe_name);
    let final_path = dir.join(&final_name);

    fs::write(&final_path, &bytes).map_err(|e| format!("Failed to write attachment: {}", e))?;

    Ok(final_path.to_string_lossy().into_owned())
}

fn sanitize_filename(name: &str) -> String {
    // Strip any path separators / weird chars so the filename can't escape
    // the attachments dir. Keep dots, dashes, underscores, alphanumerics.
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    base.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
