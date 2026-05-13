use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};

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

/// Sends a single user message to Claude, returns the full assistant reply.
/// Claude runs with cwd = repo_path so it sees `CLAUDE.md` (scaffold
/// instructions), the tests/ directory, and the env-config file. Claude
/// can write tests directly via its own filesystem tools; the frontend
/// re-reads the tests list after each turn to pick up changes.
#[tauri::command]
pub async fn chat_send(
    repo_path: String,
    env_context: Option<EnvContext>,
    history: Vec<ChatMessage>,
    message: String,
) -> Result<String, String> {
    let prompt = build_prompt(env_context.as_ref(), &history, &message);

    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        // Why these flags:
        //   --permission-mode acceptEdits  — auto-approves file writes/edits
        //     so the tester never sees raw Claude permission prompts (Claude
        //     would hang in print mode waiting for confirmation otherwise).
        //   --disallowedTools Bash         — keeps the assistant from running
        //     shell commands in the tester's repo. Test execution will get a
        //     proper UI in Stage 5c.
        let mut child = Command::new("claude")
            .arg("-p")
            .arg("--permission-mode")
            .arg("acceptEdits")
            .arg("--disallowedTools")
            .arg("Bash")
            .current_dir(&repo_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
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

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed to read claude output: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Claude exited with error: {}",
                stderr.trim().chars().take(500).collect::<String>()
            ));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?;

    result
}

fn build_prompt(
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
            s.push_str("\n");
            s.push_str("IMPORTANT: When the tester asks about selectors, components, page \
                routes, form fields, or any UI detail, READ files from the source code \
                location above using your Read/Glob/Grep tools to find the answer \
                yourself. Look for `data-testid`, `id`, `name`, role attributes, \
                form labels, route definitions, etc. Do NOT ask the tester for \
                technical details — they don't know them. Read the code.\n");
            s.push_str("\n");
            s.push_str(&format!(
                "Use `{}` as the base URL in `cy.visit()` calls when no specific URL is given.\n",
                env.deployed_url
            ));
        } else {
            s.push_str("\nSource code worktree isn't ready yet — work from the tests/ \
                folder and the deployed URL only. Don't reference source files.\n");
        }
        s.push_str("\n");
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
