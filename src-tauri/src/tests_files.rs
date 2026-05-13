use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const TESTS_DIR: &str = "tests";
const E2E_DIR: &str = "e2e";

#[derive(Serialize)]
pub struct TestFile {
    /// Absolute path to the file on disk.
    pub path: String,
    /// Filename (e.g., `login.cy.js`).
    pub name: String,
    /// Path relative to `tests/e2e/` (e.g., `auth/login.cy.js`).
    pub relative_path: String,
    /// Parent directory under `tests/e2e/` (e.g., `auth`), or empty for top-level.
    pub directory: String,
    pub size_bytes: u64,
}

fn is_test_file(name: &str) -> bool {
    name.ends_with(".cy.js") || name.ends_with(".cy.ts")
}

fn collect_test_files(
    root: &Path,
    current: &Path,
    out: &mut Vec<TestFile>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|e| format!("read_dir {}: {}", current.display(), e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy().to_string();

        if name_str.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            collect_test_files(root, &path, out)?;
            continue;
        }

        if !is_test_file(&name_str) {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name_str.clone());

        let directory = Path::new(&relative)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let size_bytes = entry
            .metadata()
            .map(|m| m.len())
            .unwrap_or(0);

        out.push(TestFile {
            path: path.to_string_lossy().to_string(),
            name: name_str,
            relative_path: relative,
            directory,
            size_bytes,
        });
    }
    Ok(())
}

/// Lists every Cypress test (`*.cy.js`, `*.cy.ts`) under `tests/e2e/` in
/// the repo's working tree. Assumes the main repo is checked out on the
/// `tests` branch (which is our app's invariant — worktrees handle other
/// branches separately).
#[tauri::command]
pub fn list_test_files(repo_path: String) -> Result<Vec<TestFile>, String> {
    let root: PathBuf = Path::new(&repo_path).join(TESTS_DIR).join(E2E_DIR);
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    collect_test_files(&root, &root, &mut out)?;
    // Stable order: directory first, then filename.
    out.sort_by(|a, b| {
        a.directory
            .cmp(&b.directory)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Reads a Cypress test file. Validates the path is inside the repo's
/// `tests/` directory so the caller can't read arbitrary files.
#[tauri::command]
pub fn read_test_file(repo_path: String, file_path: String) -> Result<String, String> {
    let tests_root = Path::new(&repo_path).join(TESTS_DIR);
    let canonical_root = tests_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve tests dir: {}", e))?;

    let target = Path::new(&file_path);
    let canonical_target = target
        .canonicalize()
        .map_err(|e| format!("Cannot resolve file: {}", e))?;

    if !canonical_target.starts_with(&canonical_root) {
        return Err("Refused: file is outside the tests directory".to_string());
    }

    fs::read_to_string(&canonical_target)
        .map_err(|e| format!("Read failed: {}", e))
}
