use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;
use tauri::{AppHandle, Manager};

use crate::core_process::{CoreSidecarConfig, CoreSidecarStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCliResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
    pub parsed: Option<Value>,
    pub error: String,
}

#[tauri::command]
pub async fn core_install_hermes_plugin(
    app: AppHandle,
    config: CoreSidecarConfig,
) -> Result<CoreCliResult, String> {
    run_core_cli(app, config, vec!["install-hermes-plugin".to_string()]).await
}

#[tauri::command]
pub async fn core_service_install(
    app: AppHandle,
    config: CoreSidecarConfig,
    replace: Option<bool>,
) -> Result<CoreCliResult, String> {
    let mut args = vec!["service".to_string(), "install".to_string()];
    if replace.unwrap_or(true) {
        args.push("--replace".to_string());
    }
    run_core_cli(app, config, args).await
}

#[tauri::command]
pub async fn core_service_uninstall(
    app: AppHandle,
    config: CoreSidecarConfig,
) -> Result<CoreCliResult, String> {
    run_core_cli(
        app,
        config,
        vec!["service".to_string(), "uninstall".to_string()],
    )
    .await
}

#[tauri::command]
pub async fn core_service_status(
    app: AppHandle,
    config: CoreSidecarConfig,
) -> Result<CoreCliResult, String> {
    run_core_cli(
        app,
        config,
        vec!["service".to_string(), "status".to_string()],
    )
    .await
}

#[tauri::command]
pub async fn open_core_logs(app: AppHandle) -> Result<CoreSidecarStatus, String> {
    let status = crate::core_process::core_sidecar_status(
        app.state::<crate::core_process::CoreProcessState>(),
    )
    .await?;
    if status.log_path.is_empty() {
        return Ok(status);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open")
            .arg("-R")
            .arg(&status.log_path)
            .status();
    }
    Ok(status)
}

async fn run_core_cli(
    app: AppHandle,
    config: CoreSidecarConfig,
    mut args: Vec<String>,
) -> Result<CoreCliResult, String> {
    let binary = core_binary_path(&app)?;
    if let Some(host) = config.host.filter(|value| !value.trim().is_empty()) {
        args.push("--host".to_string());
        args.push(host);
    }
    if let Some(port) = config.port {
        args.push("--port".to_string());
        args.push(port.to_string());
    }
    if let Some(hermes_home) = config.hermes_home.filter(|value| !value.trim().is_empty()) {
        args.push("--hermes-home".to_string());
        args.push(hermes_home);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new(&binary)
            .args(args)
            .output()
            .map_err(|err| format!("Could not run Iris Core CLI at {}: {err}", binary.display()))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let parsed = stdout
            .lines()
            .find_map(|line| serde_json::from_str::<Value>(line).ok())
            .or_else(|| serde_json::from_str::<Value>(&stdout).ok());
        Ok(CoreCliResult {
            ok: output.status.success(),
            stdout,
            stderr: stderr.clone(),
            status: output.status.code(),
            parsed,
            error: if output.status.success() {
                String::new()
            } else {
                stderr
            },
        })
    })
    .await
    .map_err(|err| format!("Core CLI task failed: {err}"))?
}

fn core_binary_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(path) = std::env::var("IRIS_CORE_BINARY") {
        let candidate = std::path::PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        for name in core_binary_candidates() {
            let candidate = resource_dir.join("binaries").join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            for name in core_binary_candidates() {
                let candidate = exe_dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    let dev_candidate = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("iris-core")
        .join(".venv")
        .join("bin")
        .join("iris-core");
    if dev_candidate.is_file() {
        return Ok(dev_candidate);
    }
    Err(format!(
        "Iris Core binary was not found at {}",
        dev_candidate.display()
    ))
}

fn core_binary_candidates() -> &'static [&'static str] {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        &[
            "iris-core-universal-apple-darwin",
            "iris-core-aarch64-apple-darwin",
            "iris-core",
        ]
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        &[
            "iris-core-universal-apple-darwin",
            "iris-core-x86_64-apple-darwin",
            "iris-core",
        ]
    }
    #[cfg(not(target_os = "macos"))]
    {
        &["iris-core"]
    }
}
