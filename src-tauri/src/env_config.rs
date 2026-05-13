use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

const TESTS_BRANCH: &str = "tests";
const CONFIG_FILE: &str = ".env-config.json";
const CONFIG_VERSION: u32 = 1;
const PUSH_RETRIES: u32 = 2;

#[derive(Serialize, Deserialize, Clone)]
pub struct EnvConfigEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "deployedUrl")]
    pub deployed_url: String,
    #[serde(rename = "codeBranch")]
    pub code_branch: String,
    pub color: String,
}

#[derive(Serialize, Deserialize)]
pub struct EnvConfig {
    pub version: u32,
    pub environments: Vec<EnvConfigEntry>,
}

#[derive(Serialize)]
pub struct SyncResult {
    /// Latest config after sync (with any remote changes merged in).
    pub config: EnvConfig,
    /// ISO timestamp for "last synced at" display.
    pub synced_at: String,
}

fn run_git(repo_path: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo_path);
    for a in args {
        cmd.arg(a);
    }
    cmd.output()
        .map_err(|e| format!("git not available: {}. Is git installed?", e))
}

fn run_git_with_auth(
    repo_path: &str,
    token: &Option<String>,
    args: &[&str],
) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo_path);
    if let Some(t) = token {
        let cred = format!("x-access-token:{}", t);
        cmd.arg("-c").arg(format!(
            "http.extraheader=Authorization: Basic {}",
            STANDARD.encode(cred)
        ));
        cmd.arg("-c").arg("credential.helper=");
    }
    for a in args {
        cmd.arg(a);
    }
    cmd.output()
        .map_err(|e| format!("git not available: {}. Is git installed?", e))
}

fn sanitize_token(text: &str, token: &Option<String>) -> String {
    match token {
        Some(t) if !t.is_empty() => text.replace(t, "***"),
        _ => text.to_string(),
    }
}

fn current_branch(repo_path: &str) -> Option<String> {
    let out = run_git(repo_path, &["symbolic-ref", "--short", "HEAD"]).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // ISO-ish — frontend just needs a stable orderable timestamp string.
    format!("{}Z", secs)
}

/// Reads `.env-config.json` from the local tests branch. Fetches origin
/// first so we see the latest from other testers. Returns an empty config
/// if the file doesn't exist on the branch.
#[tauri::command]
pub async fn read_env_config(
    repo_path: String,
    token: Option<String>,
) -> Result<SyncResult, String> {
    let path = Path::new(&repo_path);
    if !path.exists() {
        return Err(format!("Repository folder not found: {}", repo_path));
    }

    // Refresh remote refs so the tests branch reflects what others pushed.
    let _ = run_git_with_auth(
        &repo_path,
        &token,
        &["fetch", "origin", TESTS_BRANCH, "--quiet"],
    );

    let config = read_config_from_branch(&repo_path)?;
    Ok(SyncResult {
        config,
        synced_at: iso_now(),
    })
}

fn read_config_from_branch(repo_path: &str) -> Result<EnvConfig, String> {
    // Read from origin/tests (remote-tracking ref) rather than local tests
    // branch — this means we always see the latest fetched state without
    // having to fast-forward the local ref (which can fail if tests is
    // currently checked out). Falls back to local `tests` ref if origin
    // isn't set up (e.g., fresh repo before first fetch).
    let out = run_git(
        repo_path,
        &["show", &format!("origin/{TESTS_BRANCH}:{CONFIG_FILE}")],
    )?;
    let out = if out.status.success() {
        out
    } else {
        run_git(
            repo_path,
            &["show", &format!("{TESTS_BRANCH}:{CONFIG_FILE}")],
        )?
    };
    if !out.status.success() {
        return Ok(EnvConfig {
            version: CONFIG_VERSION,
            environments: vec![],
        });
    }
    let content = String::from_utf8_lossy(&out.stdout);
    if content.trim().is_empty() {
        return Ok(EnvConfig {
            version: CONFIG_VERSION,
            environments: vec![],
        });
    }
    serde_json::from_str::<EnvConfig>(&content)
        .map_err(|e| format!("Invalid env config on tests branch: {}", e))
}

/// Writes the given environments to `.env-config.json` on the tests branch,
/// commits, and pushes. Retries with pull-rebase if push is rejected.
#[tauri::command]
pub async fn write_env_config(
    repo_path: String,
    environments: Vec<EnvConfigEntry>,
    token: Option<String>,
) -> Result<SyncResult, String> {
    let path = Path::new(&repo_path);
    if !path.exists() {
        return Err(format!("Repository folder not found: {}", repo_path));
    }

    // The main repo's working tree must be on tests branch — that's where
    // our scaffold lives. Switch if needed (worktrees hold dev/main so this
    // doesn't disrupt the user's app workspaces).
    let current = current_branch(&repo_path);
    if current.as_deref() != Some(TESTS_BRANCH) {
        let checkout = run_git(&repo_path, &["checkout", TESTS_BRANCH])?;
        if !checkout.status.success() {
            let stderr = String::from_utf8_lossy(&checkout.stderr);
            return Err(format!(
                "Cannot switch to tests branch (commit or stash any uncommitted changes first): {}",
                stderr.trim()
            ));
        }
    }

    let config = EnvConfig {
        version: CONFIG_VERSION,
        environments,
    };
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    let mut last_err = String::new();
    for attempt in 0..=PUSH_RETRIES {
        match try_write_commit_push(&repo_path, &json, &token) {
            Ok(()) => {
                // Re-read so we return what's actually on the branch now
                // (in case a pull-rebase pulled in additional entries).
                let merged = read_config_from_branch(&repo_path)?;
                return Ok(SyncResult {
                    config: merged,
                    synced_at: iso_now(),
                });
            }
            Err(e) => {
                last_err = e;
                let lower = last_err.to_lowercase();
                let is_conflict = lower.contains("rejected")
                    || lower.contains("non-fast-forward")
                    || lower.contains("fetch first");
                if is_conflict && attempt < PUSH_RETRIES {
                    if let Err(rebase_err) = pull_rebase(&repo_path, &token) {
                        return Err(format!(
                            "Sync failed during pull-rebase: {}",
                            rebase_err
                        ));
                    }
                    continue;
                }
                return Err(last_err);
            }
        }
    }
    Err(format!("Sync failed after retries: {}", last_err))
}

fn try_write_commit_push(
    repo_path: &str,
    json: &str,
    token: &Option<String>,
) -> Result<(), String> {
    let config_path = Path::new(repo_path).join(CONFIG_FILE);

    // Write file — always overwrite, content includes a trailing newline.
    let mut content = json.to_string();
    if !content.ends_with('\n') {
        content.push('\n');
    }
    fs::write(&config_path, content).map_err(|e| format!("Write failed: {}", e))?;

    let add = run_git(repo_path, &["add", CONFIG_FILE])?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }

    // If nothing changed in the file, skip commit but still try push to
    // flush any commits stranded from a previous failed push.
    let diff = run_git(repo_path, &["diff", "--cached", "--quiet"])?;
    let needs_commit = !diff.status.success();

    if needs_commit {
        let commit = run_git(
            repo_path,
            &["commit", "-m", "chore: sync env config"],
        )?;
        if !commit.status.success() {
            let stderr = String::from_utf8_lossy(&commit.stderr);
            if !stderr.contains("nothing to commit") {
                return Err(format!(
                    "Could not commit env config. Set 'git config user.name' and 'user.email'. {}",
                    stderr.trim()
                ));
            }
        }
    }

    let push = run_git_with_auth(
        repo_path,
        token,
        &["push", "origin", TESTS_BRANCH],
    )?;
    if !push.status.success() {
        let stderr = String::from_utf8_lossy(&push.stderr);
        return Err(format!("Push failed: {}", sanitize_token(&stderr, token).trim()));
    }
    Ok(())
}

fn pull_rebase(repo_path: &str, token: &Option<String>) -> Result<(), String> {
    let pull = run_git_with_auth(
        repo_path,
        token,
        &["pull", "--rebase", "origin", TESTS_BRANCH],
    )?;
    if !pull.status.success() {
        // Conflict during rebase — abort to leave repo clean.
        let _ = run_git(repo_path, &["rebase", "--abort"]);
        let stderr = String::from_utf8_lossy(&pull.stderr);
        return Err(format!(
            "Pull-rebase failed (likely a content conflict): {}",
            sanitize_token(&stderr, token).trim()
        ));
    }
    Ok(())
}
