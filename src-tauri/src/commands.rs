use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

// ============================================================
// IMPORTANT: Replace this with your own GitHub OAuth App
// Client ID after registering at:
//   https://github.com/settings/applications/new
// (Enable "Device Flow" in the app settings)
// ============================================================
const GITHUB_CLIENT_ID: &str = "Ov23lilShsUgeAB4G4hT";
const OAUTH_SCOPES: &str = "repo read:user";

// -------- Repo / Git commands --------

#[derive(Serialize)]
pub struct RepoStatus {
    pub exists: bool,
    pub is_git_repo: bool,
    pub remote_url: Option<String>,
}

#[tauri::command]
pub fn check_local_repo(path: String) -> Result<RepoStatus, String> {
    let target = Path::new(&path);

    if !target.exists() {
        return Ok(RepoStatus {
            exists: false,
            is_git_repo: false,
            remote_url: None,
        });
    }

    let git_dir = target.join(".git");
    let is_git = git_dir.exists();

    let remote_url = if is_git {
        Command::new("git")
            .args(["-C", &path, "remote", "get-url", "origin"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
    } else {
        None
    };

    Ok(RepoStatus {
        exists: true,
        is_git_repo: is_git,
        remote_url,
    })
}

#[tauri::command]
pub async fn clone_repo(
    url: String,
    target_path: String,
    token: Option<String>,
) -> Result<(), String> {
    let target = Path::new(&target_path);

    if target.exists() {
        return Err(format!("Path already exists: {}", target_path));
    }

    if let Some(parent) = target.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    // Use HTTP Basic auth via http.extraheader — the format GitHub's git
    // server expects. Disable credential helpers so cached/stale credentials
    // from the OS keychain don't override our token.
    let mut cmd = Command::new("git");
    if let Some(t) = &token {
        let cred = format!("x-access-token:{}", t);
        let encoded = STANDARD.encode(cred);
        cmd.arg("-c")
            .arg(format!("http.extraheader=Authorization: Basic {}", encoded));
        cmd.arg("-c").arg("credential.helper=");
    }
    cmd.args(["clone", "--progress", &url, &target_path]);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git: {}. Is git installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let sanitized = match &token {
            Some(t) if !t.is_empty() => stderr.replace(t.as_str(), "***"),
            _ => stderr.to_string(),
        };
        return Err(sanitized.trim().to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn check_git_installed() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// -------- GitHub OAuth Device Flow --------

#[derive(Serialize, Deserialize, Clone)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Deserialize)]
struct DeviceCodeRaw {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct PollSuccess {
    access_token: String,
}

#[derive(Deserialize)]
struct PollError {
    error: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PollResult {
    Authorized { access_token: String },
    Pending,
    SlowDown,
    Expired,
    Denied,
}

#[tauri::command]
pub async fn start_device_flow() -> Result<DeviceCode, String> {
    if GITHUB_CLIENT_ID == "REPLACE_WITH_YOUR_CLIENT_ID" {
        return Err(
            "GitHub OAuth Client ID is not configured. Update GITHUB_CLIENT_ID in src-tauri/src/commands.rs."
                .to_string(),
        );
    }

    let client = reqwest::Client::new();
    let response = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", GITHUB_CLIENT_ID), ("scope", OAUTH_SCOPES)])
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub responded {}: {}", status, body));
    }

    let raw: DeviceCodeRaw = response
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    Ok(DeviceCode {
        device_code: raw.device_code,
        user_code: raw.user_code,
        verification_uri: raw.verification_uri,
        expires_in: raw.expires_in,
        interval: raw.interval,
    })
}

#[tauri::command]
pub async fn poll_for_token(device_code: String) -> Result<PollResult, String> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", GITHUB_CLIENT_ID),
            ("device_code", device_code.as_str()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code",
            ),
        ])
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let body = response
        .text()
        .await
        .map_err(|e| format!("Read error: {}", e))?;

    if let Ok(success) = serde_json::from_str::<PollSuccess>(&body) {
        return Ok(PollResult::Authorized {
            access_token: success.access_token,
        });
    }

    if let Ok(err) = serde_json::from_str::<PollError>(&body) {
        return Ok(match err.error.as_str() {
            "authorization_pending" => PollResult::Pending,
            "slow_down" => PollResult::SlowDown,
            "expired_token" => PollResult::Expired,
            "access_denied" => PollResult::Denied,
            other => return Err(format!("OAuth error: {}", other)),
        });
    }

    Err(format!("Unexpected response: {}", body))
}
