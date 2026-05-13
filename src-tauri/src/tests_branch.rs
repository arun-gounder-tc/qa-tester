use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const TESTS_BRANCH: &str = "tests";
/// Bump this whenever the scaffold contents change. Outdated branches
/// will be detected as `NeedsUpdate` and offered an auto-sync.
const SCAFFOLD_VERSION: u32 = 2;
const SCAFFOLD_VERSION_FILE: &str = ".qa-tester-scaffold";

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum TestsBranchStatus {
    /// Branch exists locally with current scaffold version
    Ready,
    /// Exists on remote but not locally — needs fetch + checkout
    RemoteOnly,
    /// Doesn't exist anywhere — needs bootstrap
    Missing,
    /// Local exists, but missing scaffold files (cypress.config.js, etc.)
    NeedsScaffold,
    /// Local exists with scaffold, but it's an older version — auto-update available
    NeedsUpdate,
}

#[derive(Serialize)]
pub struct TestsBranchInfo {
    pub status: TestsBranchStatus,
    pub current_branch: Option<String>,
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

fn git_succeeded(output: &std::process::Output) -> bool {
    output.status.success()
}

fn current_branch(repo_path: &str) -> Option<String> {
    let out = run_git(repo_path, &["symbolic-ref", "--short", "HEAD"]).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn local_branch_exists(repo_path: &str, branch: &str) -> bool {
    let out = run_git(repo_path, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]);
    matches!(out, Ok(o) if o.status.success())
}

fn remote_branch_exists(
    repo_path: &str,
    branch: &str,
    token: &Option<String>,
) -> Result<bool, String> {
    let out = run_git_with_auth(
        repo_path,
        token,
        &["ls-remote", "--heads", "origin", branch],
    )?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let sanitized = sanitize_token(&stderr, token);
        return Err(format!("Failed to query remote: {}", sanitized.trim()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(!stdout.trim().is_empty())
}

fn has_scaffold_on_disk(repo_path: &str) -> bool {
    Path::new(repo_path).join(SCAFFOLD_VERSION_FILE).exists()
        || Path::new(repo_path).join("cypress.config.js").exists()
}

fn has_scaffold_on_branch(repo_path: &str, branch: &str) -> bool {
    let out = run_git(repo_path, &["ls-tree", "-r", branch, "--name-only"]);
    match out {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // Our explicit marker file is the most reliable signature.
            // Fall back to cypress.config.{js,ts} for v1 scaffolds that
            // predate the marker.
            stdout.lines().any(|line| {
                line == SCAFFOLD_VERSION_FILE
                    || line == "cypress.config.js"
                    || line == "cypress.config.ts"
            })
        }
        _ => false,
    }
}

fn scaffold_version_on_branch(repo_path: &str, branch: &str) -> u32 {
    let out = run_git(
        repo_path,
        &["show", &format!("{}:{}", branch, SCAFFOLD_VERSION_FILE)],
    );
    match out {
        Ok(o) if o.status.success() => {
            let content = String::from_utf8_lossy(&o.stdout);
            content
                .trim()
                .strip_prefix("version=")
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(1)
        }
        // No version file on branch → assume version 1 (old)
        _ => 1,
    }
}

#[tauri::command]
pub fn check_tests_branch(
    repo_path: String,
    token: Option<String>,
) -> Result<TestsBranchInfo, String> {
    let path = Path::new(&repo_path);
    if !path.exists() {
        return Err(format!("Repository folder not found: {}", repo_path));
    }

    let current = current_branch(&repo_path);

    let local = local_branch_exists(&repo_path, TESTS_BRANCH);
    let remote = remote_branch_exists(&repo_path, TESTS_BRANCH, &token).unwrap_or(false);

    let status = if local {
        // Always read the branch's tree via git rather than checking the
        // working directory — the user may be on a different branch, have
        // untracked tooling files, or have the working tree out of sync with
        // the branch HEAD. Git's view of the branch is the source of truth.
        if !has_scaffold_on_branch(&repo_path, TESTS_BRANCH) {
            TestsBranchStatus::NeedsScaffold
        } else {
            let version = scaffold_version_on_branch(&repo_path, TESTS_BRANCH);
            if version < SCAFFOLD_VERSION {
                TestsBranchStatus::NeedsUpdate
            } else {
                TestsBranchStatus::Ready
            }
        }
    } else if remote {
        TestsBranchStatus::RemoteOnly
    } else {
        TestsBranchStatus::Missing
    };

    Ok(TestsBranchInfo {
        status,
        current_branch: current,
    })
}

/// Fetches and checks out an existing remote tests branch.
#[tauri::command]
pub fn checkout_tests_branch(
    repo_path: String,
    token: Option<String>,
) -> Result<(), String> {
    // Ensure we have the latest ref from origin
    let fetch = run_git_with_auth(
        &repo_path,
        &token,
        &["fetch", "origin", TESTS_BRANCH, "--quiet"],
    )?;
    if !fetch.status.success() {
        let stderr = String::from_utf8_lossy(&fetch.stderr);
        return Err(format!(
            "Failed to fetch: {}",
            sanitize_token(&stderr, &token).trim()
        ));
    }

    if !local_branch_exists(&repo_path, TESTS_BRANCH) {
        let out = run_git(
            &repo_path,
            &[
                "checkout",
                "-b",
                TESTS_BRANCH,
                &format!("origin/{TESTS_BRANCH}"),
            ],
        )?;
        if !git_succeeded(&out) {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    } else {
        let out = run_git(&repo_path, &["checkout", TESTS_BRANCH])?;
        if !git_succeeded(&out) {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    Ok(())
}

/// Build the HTTP Basic auth header value GitHub's git server expects.
/// Format: `Basic <base64("x-access-token:TOKEN")>`
fn basic_auth_header(token: &str) -> String {
    let cred = format!("x-access-token:{}", token);
    format!("Basic {}", STANDARD.encode(cred))
}

/// Run a git command with optional authentication via `http.extraheader`.
/// Uses HTTP Basic (the format GitHub's git server expects) and disables
/// credential helpers to prevent OS keychain from interfering with cached creds.
fn run_git_with_auth(
    repo_path: &str,
    token: &Option<String>,
    args: &[&str],
) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo_path);
    if let Some(t) = token {
        cmd.arg("-c")
            .arg(format!("http.extraheader=Authorization: {}", basic_auth_header(t)));
        // Disable any credential helper (e.g. osxkeychain) so the extraheader
        // is the sole auth source — avoids cached/stale credentials taking over.
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

fn write_file(dir: &Path, rel: &str, content: &str) -> Result<(), String> {
    let p = dir.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    fs::write(&p, content).map_err(|e| format!("write {}: {}", p.display(), e))
}

fn write_scaffold(repo_path: &str) -> Result<Vec<PathBuf>, String> {
    let root = Path::new(repo_path);

    // Version marker — read by check_tests_branch to detect outdated scaffolds.
    let version_content = format!("version={}\n", SCAFFOLD_VERSION);
    write_file(root, SCAFFOLD_VERSION_FILE, &version_content)?;

    let written: Vec<(&str, &str)> = vec![
        (
            "cypress.config.js",
            r#"const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    specPattern: 'tests/e2e/**/*.cy.{js,ts}',
    supportFile: 'tests/support/e2e.js',
    fixturesFolder: 'tests/fixtures',
    video: true,
    screenshotOnRunFailure: true,
  },
});
"#,
        ),
        (
            "package.json",
            r#"{
  "name": "qa-tests",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "open": "cypress open",
    "run": "cypress run"
  },
  "devDependencies": {
    "cypress": "^13.0.0"
  }
}
"#,
        ),
        (
            ".gitignore",
            r#"# Dependencies
node_modules/
package-lock.json

# Cypress
cypress/videos/
cypress/screenshots/
cypress/downloads/

# QA Tester local state
.refs/
.env.local

# Build & cache (catch common project tooling left behind)
.angular/
.next/
.nuxt/
.svelte-kit/
dist/
build/
coverage/
.cache/
.parcel-cache/
.turbo/
.vite/
.tsbuildinfo

# IDE / OS
.vscode/
.idea/
.DS_Store
Thumbs.db
*.swp

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
"#,
        ),
        (
            "README.md",
            r#"# QA Tests Branch

This branch holds all automated tests, environment configuration, and AI
instructions for the QA Tester app.

Do not edit application code in this branch — only tests.
"#,
        ),
        (
            "CLAUDE.md",
            r#"# Tester Assistant Instructions

You are helping a manual tester (non-developer) create Cypress tests.

## Communication
- Use plain language, mix of Hindi/English as the user prefers.
- Never show raw code or file paths.
- Present choices as numbered options.
- Always confirm before creating or modifying files.

## Test Generation
- Write tests in `tests/e2e/<feature>/<name>.cy.js`.
- Reuse helpers from `tests/support/commands.js`.
- Centralize selectors in `tests/support/selectors.js`.
- After saving, ask: "Run karke dekhna hai?"

## Conventions
- File naming: feature/test-name.cy.js
- Describe block: feature name
- It block: "should <action>"
"#,
        ),
        (
            ".env-config.json",
            r#"{
  "version": 1,
  "environments": []
}
"#,
        ),
        (
            "tests/support/e2e.js",
            "import './commands';\n",
        ),
        (
            "tests/support/commands.js",
            r#"// Custom Cypress commands live here.
// Example:
//
// Cypress.Commands.add('login', (email, password) => {
//   cy.visit('/login');
//   cy.get('[data-testid="email"]').type(email);
//   cy.get('[data-testid="password"]').type(password);
//   cy.get('[data-testid="submit"]').click();
// });
"#,
        ),
        (
            "tests/support/selectors.js",
            r#"// Centralized selectors — update one place if UI changes.
// export const selectors = {
//   login: {
//     email: '[data-testid="email"]',
//     password: '[data-testid="password"]',
//   },
// };
"#,
        ),
        ("tests/e2e/.gitkeep", ""),
        ("tests/fixtures/.gitkeep", ""),
    ];

    let mut paths = Vec::new();
    for (rel, content) in written {
        write_file(root, rel, content)?;
        paths.push(PathBuf::from(rel));
    }
    Ok(paths)
}

fn ensure_clean_working_tree(repo_path: &str) -> Result<(), String> {
    let status = run_git(repo_path, &["status", "--porcelain"])?;
    if !status.stdout.is_empty() {
        return Err(
            "You have uncommitted changes. Commit or stash them before initializing the tests branch.".to_string(),
        );
    }
    Ok(())
}

fn wipe_working_tree(repo_path: &str) {
    if let Ok(entries) = fs::read_dir(repo_path) {
        for entry in entries.flatten() {
            let p = entry.path();
            let name = entry.file_name();
            if name == ".git" {
                continue;
            }
            if p.is_dir() {
                let _ = fs::remove_dir_all(&p);
            } else {
                let _ = fs::remove_file(&p);
            }
        }
    }
}

fn push_tests_branch(repo_path: &str, token: &Option<String>) -> Result<(), String> {
    let push = run_git_with_auth(
        repo_path,
        token,
        &[
            "push",
            "-u",
            "origin",
            &format!("HEAD:refs/heads/{TESTS_BRANCH}"),
        ],
    )?;
    if !push.status.success() {
        let stderr = String::from_utf8_lossy(&push.stderr);
        let sanitized = sanitize_token(&stderr, token);
        return Err(format!("Push failed: {}", sanitized.trim()));
    }
    Ok(())
}

/// Idempotent: creates or repairs the `tests` branch with scaffold files.
/// Handles three scenarios:
///   1. No local branch → orphan branch + full scaffold + push
///   2. Local branch exists but no scaffold (from failed previous run) → scaffold + push
///   3. Local branch exists with scaffold → no-op success
#[tauri::command]
pub async fn bootstrap_tests_branch(
    repo_path: String,
    token: Option<String>,
) -> Result<(), String> {
    let path = Path::new(&repo_path);
    if !path.exists() {
        return Err(format!("Repository folder not found: {}", repo_path));
    }

    let local = local_branch_exists(&repo_path, TESTS_BRANCH);

    if local {
        // Scenario 2 or 3: branch already exists locally (likely from a
        // partial previous attempt). Switch to it and complete the scaffold.

        ensure_clean_working_tree(&repo_path)?;

        let checkout = run_git(&repo_path, &["checkout", TESTS_BRANCH])?;
        if !checkout.status.success() {
            return Err(String::from_utf8_lossy(&checkout.stderr).trim().to_string());
        }

        // If scaffold already present, just push (in case previous push failed)
        // and exit.
        if has_scaffold_on_disk(&repo_path) {
            return push_tests_branch(&repo_path, &token);
        }

        // Write scaffold over whatever is there (we expect this branch to be
        // a fresh orphan from the partial attempt).
        write_scaffold(&repo_path)?;

        let add = run_git(&repo_path, &["add", "."])?;
        if !add.status.success() {
            return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
        }

        let commit = run_git(
            &repo_path,
            &["commit", "-m", "chore: scaffold tests branch"],
        )?;
        if !commit.status.success() {
            let stderr = String::from_utf8_lossy(&commit.stderr);
            // "nothing to commit" is fine — files might already be committed
            // (e.g., manually). Skip and continue to push.
            if !stderr.contains("nothing to commit") {
                return Err(format!(
                    "Could not commit scaffold. Set 'git config user.name' and 'user.email'. {}",
                    stderr.trim()
                ));
            }
        }

        return push_tests_branch(&repo_path, &token);
    }

    // Scenario 1: fresh — create orphan branch from scratch.
    ensure_clean_working_tree(&repo_path)?;

    let orphan = run_git(&repo_path, &["checkout", "--orphan", TESTS_BRANCH])?;
    if !orphan.status.success() {
        return Err(String::from_utf8_lossy(&orphan.stderr).trim().to_string());
    }

    let _ = run_git(&repo_path, &["rm", "-rf", "--cached", "."]);
    wipe_working_tree(&repo_path);

    write_scaffold(&repo_path)?;

    let add = run_git(&repo_path, &["add", "."])?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }

    let commit = run_git(
        &repo_path,
        &["commit", "-m", "chore: initialize tests branch"],
    )?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        return Err(format!(
            "Could not commit. Set 'git config user.name' and 'user.email'. {}",
            stderr.trim()
        ));
    }

    push_tests_branch(&repo_path, &token)
}

/// Updates scaffold files on an existing tests branch to the latest version.
/// Safe to call repeatedly — only commits and pushes if there are real changes.
#[tauri::command]
pub async fn update_scaffold(
    repo_path: String,
    token: Option<String>,
) -> Result<(), String> {
    let path = Path::new(&repo_path);
    if !path.exists() {
        return Err(format!("Repository folder not found: {}", repo_path));
    }

    if !local_branch_exists(&repo_path, TESTS_BRANCH) {
        return Err("Local tests branch not found. Initialize it first.".to_string());
    }

    ensure_clean_working_tree(&repo_path)?;

    let checkout = run_git(&repo_path, &["checkout", TESTS_BRANCH])?;
    if !checkout.status.success() {
        return Err(String::from_utf8_lossy(&checkout.stderr).trim().to_string());
    }

    // Re-write scaffold files (overwrites with latest content).
    write_scaffold(&repo_path)?;

    // Check if anything actually changed.
    let status = run_git(&repo_path, &["status", "--porcelain"])?;
    if status.stdout.is_empty() {
        // Nothing to do — already up to date.
        return Ok(());
    }

    let add = run_git(&repo_path, &["add", "."])?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }

    let commit = run_git(
        &repo_path,
        &[
            "commit",
            "-m",
            &format!("chore: update tests scaffold to v{}", SCAFFOLD_VERSION),
        ],
    )?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        if !stderr.contains("nothing to commit") {
            return Err(format!(
                "Could not commit scaffold update. {}",
                stderr.trim()
            ));
        }
    }

    push_tests_branch(&repo_path, &token)
}
