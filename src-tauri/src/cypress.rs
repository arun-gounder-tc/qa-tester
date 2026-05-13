use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use tauri::Emitter;

#[derive(Serialize, Clone)]
pub struct CypressStatus {
    pub installed: bool,
    pub node_modules_exists: bool,
}

#[derive(Serialize, Clone)]
pub struct LocalArtifactsInfo {
    pub has_screenshots: bool,
    pub has_videos: bool,
    pub has_downloads: bool,
}

#[derive(Serialize, Clone)]
pub struct CypressDone {
    pub run_id: String,
    pub success: bool,
    pub code: Option<i32>,
    pub error: Option<String>,
    /// Where stdout was saved (only set when an artifacts_dir was provided).
    pub log_path: Option<String>,
    pub artifacts_dir: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct CypressChunk {
    pub run_id: String,
    pub line: String,
    pub stream: &'static str,
}

/// Checks whether Cypress is installed in the repo's node_modules.
#[tauri::command]
pub fn cypress_check(repo_path: String) -> CypressStatus {
    let repo = Path::new(&repo_path);
    let node_modules = repo.join("node_modules");
    let cypress_bin = node_modules.join(".bin").join("cypress");
    CypressStatus {
        installed: cypress_bin.exists(),
        node_modules_exists: node_modules.exists(),
    }
}

/// Reports which of the three cypress output subfolders exist inside the
/// repo. They're orphans left over from runs that didn't route output to
/// the external artifacts folder.
#[tauri::command]
pub fn check_local_artifacts(repo_path: String) -> LocalArtifactsInfo {
    let cypress = Path::new(&repo_path).join("cypress");
    LocalArtifactsInfo {
        has_screenshots: cypress.join("screenshots").exists(),
        has_videos: cypress.join("videos").exists(),
        has_downloads: cypress.join("downloads").exists(),
    }
}

/// Removes the orphan cypress output subfolders from the repo. Only touches
/// `cypress/screenshots`, `cypress/videos`, `cypress/downloads` — never the
/// `cypress.config.js` or anything else.
#[tauri::command]
pub fn clean_local_artifacts(repo_path: String) -> Result<(), String> {
    let cypress = Path::new(&repo_path).join("cypress");
    if !cypress.exists() {
        return Ok(());
    }
    for sub in &["screenshots", "videos", "downloads"] {
        let p = cypress.join(sub);
        if p.exists() {
            fs::remove_dir_all(&p)
                .map_err(|e| format!("Failed to remove {}: {}", p.display(), e))?;
        }
    }
    Ok(())
}

/// Runs `npm install` in the repo to set up Cypress. Streams output via
/// `cypress-output:<run_id>` events; emits `cypress-done:<run_id>` on exit.
#[tauri::command]
pub fn cypress_install(
    app: tauri::AppHandle,
    repo_path: String,
    run_id: String,
) -> Result<(), String> {
    spawn_streaming_process(
        app,
        run_id,
        &["install", "--no-audit", "--no-fund"],
        "npm",
        &repo_path,
        &[],
    )
}

/// Runs a Cypress spec headlessly. CYPRESS_BASE_URL is set from the env's
/// deployed URL so `cy.visit('/')` hits the right environment.
#[tauri::command]
pub fn cypress_run(
    app: tauri::AppHandle,
    repo_path: String,
    run_id: String,
    base_url: String,
    spec: Option<String>,
    headed: bool,
    artifacts_dir: Option<String>,
) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "cypress".to_string(),
        "run".to_string(),
        "--reporter".to_string(),
        "spec".to_string(),
    ];
    if headed {
        args.push("--headed".to_string());
        // Default to Chrome when headed so the tester can actually see what's happening.
        args.push("--browser".to_string());
        args.push("chrome".to_string());
    }

    // Ensure the artifacts dir + subfolders exist so cypress can write into them.
    if let Some(dir) = &artifacts_dir {
        let _ = fs::create_dir_all(dir);
        let _ = fs::create_dir_all(format!("{}/screenshots", dir));
        let _ = fs::create_dir_all(format!("{}/videos", dir));
    }

    // Override the scaffold's folder paths via CLI flags so artifacts go to
    // our external location regardless of what cypress.config.js says. The
    // CLI `--config` flag wins over the config file. We also force
    // `video=true` + `screenshotOnRunFailure=true` so a tester always gets
    // both, even if the scaffold's config has drifted.
    if let Some(dir) = &artifacts_dir {
        args.push("--config".to_string());
        args.push(format!(
            "screenshotsFolder={dir}/screenshots,videosFolder={dir}/videos,video=true,screenshotOnRunFailure=true"
        ));
    }

    if let Some(s) = spec {
        args.push("--spec".to_string());
        args.push(s);
    }
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();

    let mut envs: Vec<(&str, &str)> = vec![
        ("CYPRESS_BASE_URL", base_url.as_str()),
        ("FORCE_COLOR", "0"),
        ("NO_COLOR", "1"),
    ];
    if let Some(dir) = &artifacts_dir {
        // Kept for the scaffold's cypress.config.js fallback path.
        envs.push(("CYPRESS_ARTIFACTS_DIR", dir.as_str()));
    }

    let artifacts_clone = artifacts_dir.clone();
    spawn_streaming_process_with_log(
        app,
        run_id,
        &args_ref,
        "npx",
        &repo_path,
        &envs,
        artifacts_clone,
    )
}

/// Spawns a command, streams stdout/stderr line-by-line via Tauri events,
/// and emits a done event when the process exits.
fn spawn_streaming_process(
    app: tauri::AppHandle,
    run_id: String,
    args: &[&str],
    program: &str,
    cwd: &str,
    env_vars: &[(&str, &str)],
) -> Result<(), String> {
    spawn_streaming_process_with_log(app, run_id, args, program, cwd, env_vars, None)
}

/// Like `spawn_streaming_process` but also writes a complete `output.log`
/// to `artifacts_dir` if provided, and reports the path back on the done event.
fn spawn_streaming_process_with_log(
    app: tauri::AppHandle,
    run_id: String,
    args: &[&str],
    program: &str,
    cwd: &str,
    env_vars: &[(&str, &str)],
    artifacts_dir: Option<String>,
) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    for (k, v) in env_vars {
        cmd.env(k, v);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("Command not found: `{}`. Make sure Node.js and npm are installed and on your PATH.", program)
        } else {
            format!("Failed to spawn {}: {}", program, e)
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture stdout")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture stderr")?;

    let output_event = format!("cypress-output:{}", run_id);
    let done_event = format!("cypress-done:{}", run_id);

    thread::spawn(move || {
        let mut full_log = String::new();

        // Stream stdout line by line.
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            full_log.push_str(&line);
            full_log.push('\n');
            let _ = app.emit(
                &output_event,
                CypressChunk {
                    run_id: run_id.clone(),
                    line,
                    stream: "stdout",
                },
            );
        }

        // After stdout EOF, drain stderr (typically small / error-only).
        let mut err_buf = String::new();
        let _ = stderr.read_to_string(&mut err_buf);
        if !err_buf.trim().is_empty() {
            full_log.push_str("\n--- stderr ---\n");
            full_log.push_str(&err_buf);
            for line in err_buf.lines() {
                let _ = app.emit(
                    &output_event,
                    CypressChunk {
                        run_id: run_id.clone(),
                        line: line.to_string(),
                        stream: "stderr",
                    },
                );
            }
        }

        // Persist output.log to the artifacts directory if one was provided.
        let log_path = if let Some(dir) = &artifacts_dir {
            let _ = fs::create_dir_all(dir);
            let path = Path::new(dir).join("output.log");
            if let Ok(mut f) = fs::File::create(&path) {
                let _ = f.write_all(full_log.as_bytes());
            }
            Some(path.to_string_lossy().to_string())
        } else {
            None
        };

        let payload = match child.wait() {
            Ok(status) => CypressDone {
                run_id: run_id.clone(),
                success: status.success(),
                code: status.code(),
                error: None,
                log_path,
                artifacts_dir: artifacts_dir.clone(),
            },
            Err(e) => CypressDone {
                run_id: run_id.clone(),
                success: false,
                code: None,
                error: Some(format!("Wait failed: {}", e)),
                log_path,
                artifacts_dir: artifacts_dir.clone(),
            },
        };

        let _ = app.emit(&done_event, payload);
    });

    Ok(())
}
