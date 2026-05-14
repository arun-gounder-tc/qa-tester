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
    /// `describe`/`it` blocks found inside the file, in source order — used
    /// to render a Cypress-style test tree without opening each file.
    pub test_cases: Vec<TestCase>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum TestCaseKind {
    /// A `describe(...)` / `context(...)` grouping block.
    Suite,
    /// An `it(...)` / `specify(...)` individual test.
    Test,
}

#[derive(Serialize)]
pub struct TestCase {
    pub kind: TestCaseKind,
    pub title: String,
    /// Nesting level — number of enclosing `describe`/`context` blocks.
    pub depth: u32,
    /// 1-based line number where the block starts.
    pub line: u32,
}

fn is_test_file(name: &str) -> bool {
    name.ends_with(".cy.js") || name.ends_with(".cy.ts")
}

/// Pulls the first string-literal argument out of the text following a
/// `(`. Handles `'`, `"`, and backtick quotes plus simple escapes.
fn extract_first_string(s: &str) -> Option<String> {
    let s = s.trim_start();
    let mut chars = s.chars();
    let quote = chars.next()?;
    if quote != '\'' && quote != '"' && quote != '`' {
        return None;
    }
    let mut result = String::new();
    let mut escaped = false;
    for ch in chars {
        if escaped {
            result.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == quote {
            return Some(result);
        } else {
            result.push(ch);
        }
    }
    None
}

/// If `line` starts a call to `name` (optionally `.only` / `.skip`), returns
/// the substring just after the opening `(`.
fn strip_call<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(name)?;
    let rest = rest.trim_start();
    if let Some(after) = rest.strip_prefix('(') {
        return Some(after);
    }
    if rest.starts_with('.') {
        let paren = rest.find('(')?;
        let modifier = &rest[1..paren];
        if !modifier.is_empty() && modifier.chars().all(|c| c.is_alphanumeric()) {
            return Some(&rest[paren + 1..]);
        }
    }
    None
}

/// Detects a `describe`/`context`/`it`/`specify` call at the start of a
/// (left-trimmed) line and returns its kind + title.
fn match_test_call(line: &str) -> Option<(TestCaseKind, String)> {
    let (kind, rest) = if let Some(r) = strip_call(line, "describe") {
        (TestCaseKind::Suite, r)
    } else if let Some(r) = strip_call(line, "context") {
        (TestCaseKind::Suite, r)
    } else if let Some(r) = strip_call(line, "it") {
        (TestCaseKind::Test, r)
    } else if let Some(r) = strip_call(line, "specify") {
        (TestCaseKind::Test, r)
    } else {
        return None;
    };
    let title = extract_first_string(rest)?;
    Some((kind, title))
}

/// Extracts the `describe`/`it` tree from a test file's source. Uses naive
/// brace counting to track nesting — good enough for the simple, generated
/// test files this app produces; it isn't a real JS parser.
fn parse_test_cases(content: &str) -> Vec<TestCase> {
    let mut entries: Vec<TestCase> = Vec::new();
    let mut brace_depth: i32 = 0;
    // Brace depth at which each currently-open suite was declared.
    let mut suite_stack: Vec<i32> = Vec::new();

    for (idx, raw_line) in content.lines().enumerate() {
        let trimmed = raw_line.trim_start();
        let call_depth = brace_depth;

        if let Some((kind, title)) = match_test_call(trimmed) {
            // Close any suites we've stepped out of (siblings or deeper).
            while suite_stack.last().is_some_and(|&d| d >= call_depth) {
                suite_stack.pop();
            }
            entries.push(TestCase {
                kind: kind.clone(),
                title,
                depth: suite_stack.len() as u32,
                line: (idx + 1) as u32,
            });
            if matches!(kind, TestCaseKind::Suite) {
                suite_stack.push(call_depth);
            }
        }

        for ch in raw_line.chars() {
            match ch {
                '{' => brace_depth += 1,
                '}' => brace_depth -= 1,
                _ => {}
            }
        }
    }

    entries
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

        let test_cases = fs::read_to_string(&path)
            .map(|c| parse_test_cases(&c))
            .unwrap_or_default();

        out.push(TestFile {
            path: path.to_string_lossy().to_string(),
            name: name_str,
            relative_path: relative,
            directory,
            size_bytes,
            test_cases,
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
