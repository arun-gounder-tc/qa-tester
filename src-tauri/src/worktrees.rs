use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const WORKTREES_DIR: &str = ".qa-tester/worktrees";
const EXCLUDE_FILE: &str = ".git/info/exclude";
const EXCLUDE_LINE: &str = ".qa-tester/";

#[derive(Serialize)]
pub struct WorktreeInfo {
    pub env_id: String,
    pub path: String,
    pub branch: String,
}

#[derive(Serialize)]
pub struct WorktreeListEntry {
    pub path: String,
    pub branch: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectType {
    Frontend,
    Backend,
    Fullstack,
    Unknown,
}

#[derive(Serialize)]
pub struct ProjectTypeInfo {
    pub kind: ProjectType,
    pub framework: Option<String>,
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
    token: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    let cred = format!("x-access-token:{}", token);
    let header = format!(
        "http.extraheader=Authorization: Basic {}",
        STANDARD.encode(cred)
    );
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo_path);
    cmd.arg("-c").arg(header);
    cmd.arg("-c").arg("credential.helper=");
    for a in args {
        cmd.arg(a);
    }
    cmd.output()
        .map_err(|e| format!("git not available: {}. Is git installed?", e))
}

/// Produces a filesystem-safe slug from an arbitrary env name.
/// Keeps lowercase alphanumerics + dashes; collapses everything else.
fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = true;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "env".to_string()
    } else {
        trimmed
    }
}

/// Builds a human-readable, collision-resistant folder name for an env's
/// worktree: `<slug>-<short-id>`. Example: `development-5c257b`.
fn worktree_folder_name(env_id: &str, env_name: &str) -> String {
    let slug = slugify(env_name);
    let short_id: String = env_id.chars().filter(|c| *c != '-').take(6).collect();
    if short_id.is_empty() {
        slug
    } else {
        format!("{}-{}", slug, short_id)
    }
}

fn worktree_path(repo_path: &str, folder_name: &str) -> PathBuf {
    Path::new(repo_path).join(WORKTREES_DIR).join(folder_name)
}

fn local_branch_exists(repo_path: &str, branch: &str) -> bool {
    matches!(
        run_git(
            repo_path,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        ),
        Ok(o) if o.status.success()
    )
}

fn remote_branch_exists(repo_path: &str, branch: &str) -> bool {
    matches!(
        run_git(
            repo_path,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/remotes/origin/{branch}"),
            ],
        ),
        Ok(o) if o.status.success()
    )
}

/// Adds `.qa-tester/` to `.git/info/exclude` so worktrees never appear as
/// untracked files on any branch. Idempotent — safe to call repeatedly.
fn ensure_excluded(repo_path: &str) -> Result<(), String> {
    let exclude_path = Path::new(repo_path).join(EXCLUDE_FILE);
    let existing = fs::read_to_string(&exclude_path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == EXCLUDE_LINE) {
        return Ok(());
    }
    if let Some(parent) = exclude_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir exclude dir: {}", e))?;
    }
    let mut new_content = existing;
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(EXCLUDE_LINE);
    new_content.push('\n');
    fs::write(&exclude_path, new_content).map_err(|e| format!("write exclude: {}", e))
}

/// Creates a git worktree at `<repo>/.qa-tester/worktrees/<env_id>/` checked
/// out to `branch`. Idempotent — re-uses an existing worktree if one is
/// already registered for the same path.
#[tauri::command]
pub async fn create_env_worktree(
    repo_path: String,
    env_id: String,
    env_name: String,
    branch: String,
    token: Option<String>,
) -> Result<WorktreeInfo, String> {
    let repo = Path::new(&repo_path);
    if !repo.exists() {
        return Err(format!("Repository folder not found: {}", repo_path));
    }

    ensure_excluded(&repo_path)?;

    let folder = worktree_folder_name(&env_id, &env_name);
    let path = worktree_path(&repo_path, &folder);
    let path_str = path.to_string_lossy().to_string();

    // Reconcile any prior state for this path.
    let list = run_git(&repo_path, &["worktree", "list", "--porcelain"])?;
    let registered = if list.status.success() {
        let stdout = String::from_utf8_lossy(&list.stdout);
        stdout
            .lines()
            .any(|l| l == format!("worktree {}", path_str))
    } else {
        false
    };

    if registered && path.exists() {
        return Ok(WorktreeInfo {
            env_id,
            path: path_str,
            branch,
        });
    }

    if registered && !path.exists() {
        // Stale registration — git tracks it but folder is gone. Prune.
        let _ = run_git(&repo_path, &["worktree", "remove", "--force", &path_str]);
        let _ = run_git(&repo_path, &["worktree", "prune"]);
    } else if path.exists() {
        // Folder exists but isn't a registered worktree — orphan. Remove.
        fs::remove_dir_all(&path)
            .map_err(|e| format!("Failed to clean stale worktree path: {}", e))?;
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir worktrees dir: {}", e))?;
    }

    // Refresh remote refs so we can find the branch if it's only on the remote.
    if let Some(t) = &token {
        let _ = run_git_with_auth(&repo_path, t, &["fetch", "origin", &branch, "--quiet"]);
    } else {
        let _ = run_git(&repo_path, &["fetch", "origin", &branch, "--quiet"]);
    }

    let result = if local_branch_exists(&repo_path, &branch) {
        run_git(&repo_path, &["worktree", "add", &path_str, &branch])?
    } else if remote_branch_exists(&repo_path, &branch) {
        run_git(
            &repo_path,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &path_str,
                &format!("origin/{branch}"),
            ],
        )?
    } else {
        return Err(format!(
            "Branch '{}' not found locally or on origin.",
            branch
        ));
    };

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("Worktree add failed: {}", stderr.trim()));
    }

    Ok(WorktreeInfo {
        env_id,
        path: path_str,
        branch,
    })
}

/// Removes a worktree by its path. Safe to call even if nothing exists.
#[tauri::command]
pub fn remove_env_worktree(repo_path: String, worktree_path: String) -> Result<(), String> {
    let path = Path::new(&worktree_path);

    if !path.exists() {
        let _ = run_git(&repo_path, &["worktree", "prune"]);
        return Ok(());
    }

    let result = run_git(
        &repo_path,
        &["worktree", "remove", "--force", &worktree_path],
    )?;
    if !result.status.success() {
        // Fallback: nuke the directory and ask git to clean up its ref.
        let _ = fs::remove_dir_all(path);
        let _ = run_git(&repo_path, &["worktree", "prune"]);
    }
    Ok(())
}

#[tauri::command]
pub fn list_worktrees(repo_path: String) -> Result<Vec<WorktreeListEntry>, String> {
    let result = run_git(&repo_path, &["worktree", "list", "--porcelain"])?;
    if !result.status.success() {
        return Err(format!(
            "Failed to list worktrees: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&result.stdout);
    let mut entries: Vec<WorktreeListEntry> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            if let Some(p) = current_path.take() {
                entries.push(WorktreeListEntry {
                    path: p,
                    branch: current_branch.take(),
                });
            }
            current_path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            current_branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string());
        }
    }
    if let Some(p) = current_path {
        entries.push(WorktreeListEntry {
            path: p,
            branch: current_branch,
        });
    }
    Ok(entries)
}

/// Opens a folder in the OS file manager (Finder on macOS, Explorer on
/// Windows, default file manager on Linux). Used because the shell plugin's
/// default scope only permits URL schemes, not filesystem paths.
#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("Folder not found: {}", path));
    }

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&path).output();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg(&path).output();
    #[cfg(target_os = "linux")]
    let result = Command::new("xdg-open").arg(&path).output();

    match result {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
        Err(e) => Err(format!("Failed to open folder: {}", e)),
    }
}

/// Inspects the project root and infers whether it's a frontend, backend,
/// fullstack monorepo, or unknown. Used to give the AI assistant context
/// for selector suggestions in later stages.
#[tauri::command]
pub fn detect_project_type(repo_path: String) -> Result<ProjectTypeInfo, String> {
    let root = Path::new(&repo_path);
    if !root.exists() {
        return Err(format!("Project folder not found: {}", repo_path));
    }

    let pkg_json = root.join("package.json");
    let mut fe_framework: Option<String> = None;
    let mut be_signal = false;

    if pkg_json.exists() {
        if let Ok(content) = fs::read_to_string(&pkg_json) {
            let lc = content.to_lowercase();
            if lc.contains("\"next\"") {
                fe_framework = Some("Next.js".to_string());
            } else if lc.contains("\"@angular/core\"") {
                fe_framework = Some("Angular".to_string());
            } else if lc.contains("\"nuxt\"") {
                fe_framework = Some("Nuxt".to_string());
            } else if lc.contains("\"react\"") {
                fe_framework = Some("React".to_string());
            } else if lc.contains("\"vue\"") {
                fe_framework = Some("Vue".to_string());
            } else if lc.contains("\"svelte\"") || lc.contains("\"@sveltejs/kit\"") {
                fe_framework = Some("Svelte".to_string());
            }
            if lc.contains("\"express\"")
                || lc.contains("\"fastify\"")
                || lc.contains("\"@nestjs/core\"")
                || lc.contains("\"koa\"")
                || lc.contains("\"hono\"")
            {
                be_signal = true;
            }
        }
    }

    // Monorepo with both frontend and backend apps.
    let apps_dir = root.join("apps");
    if apps_dir.exists() {
        let has_fe = apps_dir.join("web").exists()
            || apps_dir.join("frontend").exists()
            || apps_dir.join("client").exists();
        let has_be = apps_dir.join("api").exists()
            || apps_dir.join("backend").exists()
            || apps_dir.join("server").exists();
        if has_fe && has_be {
            return Ok(ProjectTypeInfo {
                kind: ProjectType::Fullstack,
                framework: fe_framework,
            });
        }
    }

    let has_backend_file = root.join("pom.xml").exists()
        || root.join("requirements.txt").exists()
        || root.join("pyproject.toml").exists()
        || root.join("go.mod").exists()
        || root.join("Gemfile").exists()
        || (root.join("Cargo.toml").exists() && fe_framework.is_none());

    let kind = match (fe_framework.is_some(), be_signal || has_backend_file) {
        (true, true) => ProjectType::Fullstack,
        (true, false) => ProjectType::Frontend,
        (false, true) => ProjectType::Backend,
        (false, false) => ProjectType::Unknown,
    };

    Ok(ProjectTypeInfo {
        kind,
        framework: fe_framework,
    })
}
