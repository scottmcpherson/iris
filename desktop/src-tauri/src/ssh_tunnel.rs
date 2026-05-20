use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::core_process::probe_core_health;

#[derive(Clone, Default)]
pub struct SshTunnelState {
    inner: Arc<Mutex<HashMap<String, ManagedSshTunnel>>>,
}

struct ManagedSshTunnel {
    child: Child,
    config: SshTunnelConfig,
    status: SshTunnelStatus,
    restart_attempt: usize,
}

struct TunnelStartError {
    kind: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionConfig {
    pub connection_id: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub identity_file: Option<String>,
    pub remote_core_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    pub connection_id: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub identity_file: Option<String>,
    pub remote_core_host: Option<String>,
    pub remote_core_port: u16,
    pub local_forward_port: Option<u16>,
    pub auto_start_remote_core: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbeResult {
    pub ok: bool,
    pub ssh_ok: bool,
    pub core_ok: bool,
    pub remote_core_version: String,
    pub error_kind: String,
    pub error: String,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelStatus {
    pub ok: bool,
    pub connection_id: String,
    pub running: bool,
    pub local_port: u16,
    pub effective_core_api_url: String,
    pub pid: Option<u32>,
    pub reconnecting: bool,
    pub restart_attempt: u32,
    pub error_kind: String,
    pub error: String,
}

#[tauri::command]
pub async fn ssh_connection_probe(config: SshConnectionConfig) -> Result<SshProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || probe_blocking(config))
        .await
        .map_err(|err| format!("SSH probe task failed: {err}"))?
}

#[tauri::command]
pub async fn ssh_tunnel_start(
    state: tauri::State<'_, SshTunnelState>,
    config: SshTunnelConfig,
) -> Result<SshTunnelStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start_tunnel_blocking(&state, config))
        .await
        .map_err(|err| format!("SSH tunnel start task failed: {err}"))?
}

#[tauri::command]
pub async fn ssh_tunnel_stop(
    state: tauri::State<'_, SshTunnelState>,
    connection_id: String,
) -> Result<SshTunnelStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_tunnel_blocking(&state, connection_id))
        .await
        .map_err(|err| format!("SSH tunnel stop task failed: {err}"))?
}

#[tauri::command]
pub async fn ssh_tunnel_status(
    state: tauri::State<'_, SshTunnelState>,
    connection_id: String,
) -> Result<SshTunnelStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || status_tunnel_blocking(&state, connection_id))
        .await
        .map_err(|err| format!("SSH tunnel status task failed: {err}"))?
}

pub fn stop_all_tunnels(state: &SshTunnelState) {
    if let Ok(mut guard) = state.inner.lock() {
        for (_, mut tunnel) in guard.drain() {
            let _ = tunnel.child.kill();
            let _ = tunnel.child.wait();
        }
    }
}

fn probe_blocking(config: SshConnectionConfig) -> Result<SshProbeResult, String> {
    validate_endpoint(&config.user, &config.host)?;
    let mut ssh_command = Command::new("ssh");
    ssh_command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-p")
        .arg(config.port.to_string());
    append_identity_args(&mut ssh_command, config.identity_file.as_deref());
    let ssh = ssh_command
        .arg(ssh_target(&config.user, &config.host))
        .arg("true")
        .output()
        .map_err(|err| format!("Could not run system ssh: {err}"))?;
    let stdout = String::from_utf8_lossy(&ssh.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&ssh.stderr).trim().to_string();
    if !ssh.status.success() {
        let (kind, message) = map_ssh_error(&stderr);
        return Ok(SshProbeResult {
            ok: false,
            ssh_ok: false,
            core_ok: false,
            remote_core_version: String::new(),
            error_kind: kind,
            error: message,
            stdout,
            stderr,
        });
    }

    let mut remote_command = Command::new("ssh");
    remote_command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-p")
        .arg(config.port.to_string());
    append_identity_args(&mut remote_command, config.identity_file.as_deref());
    let remote = remote_command
        .arg(ssh_target(&config.user, &config.host))
        .arg(format!(
            "curl -fsS http://127.0.0.1:{}/v1/health",
            config.remote_core_port
        ))
        .output()
        .map_err(|err| format!("Could not run remote Core probe over ssh: {err}"))?;
    let remote_stdout = String::from_utf8_lossy(&remote.stdout).trim().to_string();
    let remote_stderr = String::from_utf8_lossy(&remote.stderr).trim().to_string();
    if !remote.status.success() {
        return Ok(SshProbeResult {
            ok: false,
            ssh_ok: true,
            core_ok: false,
            remote_core_version: String::new(),
            error_kind: "core-offline".to_string(),
            error: "SSH works, but Iris Core is not running on the remote host.".to_string(),
            stdout: remote_stdout,
            stderr: remote_stderr,
        });
    }
    let parsed: serde_json::Value = serde_json::from_str(&remote_stdout)
        .map_err(|err| format!("Remote Core health returned invalid JSON: {err}"))?;
    Ok(SshProbeResult {
        ok: true,
        ssh_ok: true,
        core_ok: true,
        remote_core_version: parsed
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
        error_kind: String::new(),
        error: String::new(),
        stdout,
        stderr,
    })
}

fn start_tunnel_blocking(
    state: &SshTunnelState,
    config: SshTunnelConfig,
) -> Result<SshTunnelStatus, String> {
    validate_endpoint(&config.user, &config.host)?;
    let connection_id = clean_connection_id(&config.connection_id);
    if connection_id.is_empty() {
        return Err("SSH connection id is required.".to_string());
    }
    let _ = stop_tunnel_blocking(state, connection_id.clone());
    let (child, mut stable_config, status) = match spawn_verified_tunnel(&config, &connection_id) {
        Ok(result) => result,
        Err(error) => {
            return Ok(SshTunnelStatus {
                ok: false,
                connection_id,
                running: false,
                local_port: config.local_forward_port.unwrap_or(0),
                effective_core_api_url: String::new(),
                pid: None,
                reconnecting: false,
                restart_attempt: 0,
                error_kind: error.kind,
                error: error.message,
            });
        }
    };
    stable_config.local_forward_port = Some(status.local_port);
    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "SSH tunnel state is unavailable.".to_string())?;
        guard.insert(
            connection_id.clone(),
            ManagedSshTunnel {
                child,
                config: stable_config,
                status: status.clone(),
                restart_attempt: 0,
            },
        );
    }
    spawn_tunnel_monitor(state.clone(), connection_id);
    Ok(status)
}

fn stop_tunnel_blocking(
    state: &SshTunnelState,
    connection_id: String,
) -> Result<SshTunnelStatus, String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "SSH tunnel state is unavailable.".to_string())?;
    if let Some(mut tunnel) = guard.remove(&connection_id) {
        let _ = tunnel.child.kill();
        let _ = tunnel.child.wait();
        return Ok(SshTunnelStatus {
            ok: true,
            running: false,
            error: "SSH tunnel stopped.".to_string(),
            pid: None,
            reconnecting: false,
            ..tunnel.status
        });
    }
    Ok(SshTunnelStatus {
        ok: true,
        connection_id,
        running: false,
        local_port: 0,
        effective_core_api_url: String::new(),
        pid: None,
        reconnecting: false,
        restart_attempt: 0,
        error_kind: String::new(),
        error: String::new(),
    })
}

fn status_tunnel_blocking(
    state: &SshTunnelState,
    connection_id: String,
) -> Result<SshTunnelStatus, String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "SSH tunnel state is unavailable.".to_string())?;
    if let Some(tunnel) = guard.get_mut(&connection_id) {
        if let Ok(Some(exit)) = tunnel.child.try_wait() {
            tunnel.status.ok = false;
            tunnel.status.running = false;
            tunnel.status.pid = None;
            tunnel.status.reconnecting = true;
            tunnel.status.error_kind = "tunnel-exited".to_string();
            tunnel.status.error = format!("SSH tunnel exited with {exit}.");
            return Ok(tunnel.status.clone());
        }
        tunnel.status.running = true;
        tunnel.status.pid = Some(tunnel.child.id());
        tunnel.status.reconnecting = false;
        return Ok(tunnel.status.clone());
    }
    Ok(SshTunnelStatus {
        ok: false,
        connection_id,
        running: false,
        local_port: 0,
        effective_core_api_url: String::new(),
        pid: None,
        reconnecting: false,
        restart_attempt: 0,
        error_kind: "not-running".to_string(),
        error: "SSH tunnel is not running.".to_string(),
    })
}

fn spawn_verified_tunnel(
    config: &SshTunnelConfig,
    connection_id: &str,
) -> Result<(Child, SshTunnelConfig, SshTunnelStatus), TunnelStartError> {
    let mut last_error: Option<TunnelStartError> = None;
    for _ in 0..5 {
        let local_port = match config.local_forward_port {
            Some(port) if port > 0 => port,
            _ => allocate_local_port().map_err(|message| TunnelStartError {
                kind: "tunnel-failed".to_string(),
                message,
            })?,
        };
        let remote_host = config
            .remote_core_host
            .clone()
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let mut ssh_command = Command::new("ssh");
        ssh_command
            .arg("-N")
            .arg("-L")
            .arg(format!(
                "127.0.0.1:{local_port}:{remote_host}:{}",
                config.remote_core_port
            ))
            .arg("-p")
            .arg(config.port.to_string())
            .arg("-o")
            .arg("ExitOnForwardFailure=yes")
            .arg("-o")
            .arg("ServerAliveInterval=30")
            .arg("-o")
            .arg("ServerAliveCountMax=3")
            .arg("-o")
            .arg("BatchMode=yes");
        append_identity_args(&mut ssh_command, config.identity_file.as_deref());
        let child = ssh_command
            .arg(ssh_target(&config.user, &config.host))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| TunnelStartError {
                kind: "ssh-failed".to_string(),
                message: format!("Could not run system ssh: {err}"),
            })?;
        std::thread::sleep(Duration::from_millis(450));
        let mut child = child;
        if let Ok(Some(exit)) = child.try_wait() {
            let stderr = read_child_stderr(&mut child);
            let (kind, mapped) = map_ssh_error(&stderr);
            let message = if stderr.trim().is_empty() {
                format!("SSH tunnel exited with {exit}.")
            } else {
                mapped
            };
            return Err(TunnelStartError { kind, message });
        }
        match probe_core_health("127.0.0.1", local_port, Duration::from_millis(900)) {
            Ok(_) => {
                let status = SshTunnelStatus {
                    ok: true,
                    connection_id: connection_id.to_string(),
                    running: true,
                    local_port,
                    effective_core_api_url: format!("http://127.0.0.1:{local_port}"),
                    pid: Some(child.id()),
                    reconnecting: false,
                    restart_attempt: 0,
                    error_kind: String::new(),
                    error: String::new(),
                };
                return Ok((child, config.clone(), status));
            }
            Err(error) => {
                last_error = Some(TunnelStartError {
                    kind: "core-offline".to_string(),
                    message: format!(
                        "SSH connected, but Iris Core is not reachable on the remote host at {}:{}. Start Iris Core on the remote host, then retry. {error}",
                        config
                            .remote_core_host
                            .clone()
                            .unwrap_or_else(|| "127.0.0.1".to_string()),
                        config.remote_core_port
                    ),
                });
                let _ = child.kill();
                let _ = child.wait();
                if config.local_forward_port.is_some() {
                    break;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| TunnelStartError {
        kind: "tunnel-failed".to_string(),
        message: "Iris could not open the SSH tunnel. The local port may be in use.".to_string(),
    }))
}

fn read_child_stderr(child: &mut Child) -> String {
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut buffer = String::new();
    let _ = stderr.read_to_string(&mut buffer);
    buffer.trim().to_string()
}

fn spawn_tunnel_monitor(state: SshTunnelState, connection_id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let restart = {
            let mut guard = match state.inner.lock() {
                Ok(guard) => guard,
                Err(_) => break,
            };
            let Some(tunnel) = guard.get_mut(&connection_id) else {
                break;
            };
            match tunnel.child.try_wait() {
                Ok(Some(exit)) => {
                    tunnel.status.ok = false;
                    tunnel.status.running = false;
                    tunnel.status.pid = None;
                    tunnel.status.reconnecting = true;
                    tunnel.status.restart_attempt = tunnel.restart_attempt.saturating_add(1) as u32;
                    tunnel.status.error_kind = "tunnel-exited".to_string();
                    tunnel.status.error = format!("SSH tunnel exited with {exit}; reconnecting.");
                    let delay = reconnect_delay(tunnel.restart_attempt);
                    tunnel.restart_attempt = tunnel.restart_attempt.saturating_add(1);
                    Some((delay, tunnel.config.clone(), tunnel.restart_attempt as u32))
                }
                Ok(None) => {
                    tunnel.status.ok = true;
                    tunnel.status.running = true;
                    tunnel.status.reconnecting = false;
                    tunnel.status.pid = Some(tunnel.child.id());
                    None
                }
                Err(error) => {
                    tunnel.status.ok = false;
                    tunnel.status.error_kind = "tunnel-status-failed".to_string();
                    tunnel.status.error = format!("Could not inspect SSH tunnel: {error}");
                    None
                }
            }
        };
        let Some((delay, config, attempt)) = restart else {
            continue;
        };
        std::thread::sleep(delay);
        match spawn_verified_tunnel(&config, &connection_id) {
            Ok((child, mut stable_config, mut status)) => {
                stable_config.local_forward_port = Some(status.local_port);
                status.restart_attempt = attempt;
                let mut guard = match state.inner.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };
                if let Some(tunnel) = guard.get_mut(&connection_id) {
                    tunnel.child = child;
                    tunnel.config = stable_config;
                    tunnel.status = status;
                } else {
                    let mut child = child;
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
            Err(error) => {
                let mut guard = match state.inner.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };
                if let Some(tunnel) = guard.get_mut(&connection_id) {
                    tunnel.status.ok = false;
                    tunnel.status.running = false;
                    tunnel.status.reconnecting = true;
                    tunnel.status.pid = None;
                    tunnel.status.restart_attempt = attempt;
                    tunnel.status.error_kind = error.kind;
                    tunnel.status.error = error.message;
                } else {
                    break;
                }
            }
        }
    });
}

fn reconnect_delay(attempt: usize) -> Duration {
    const BACKOFF_SECONDS: [u64; 5] = [1, 2, 5, 15, 30];
    Duration::from_secs(BACKOFF_SECONDS[attempt.min(BACKOFF_SECONDS.len() - 1)])
}

fn allocate_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Could not reserve a local SSH tunnel port: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Could not inspect local SSH tunnel port: {err}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn validate_endpoint(user: &str, host: &str) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("SSH host is required.".to_string());
    }
    if user.contains([' ', '@', ':']) || host.contains([' ', '@']) {
        return Err("SSH user and host cannot contain spaces or shell metacharacters.".to_string());
    }
    Ok(())
}

fn ssh_target(user: &str, host: &str) -> String {
    let clean_user = user.trim();
    let clean_host = host.trim();
    if clean_user.is_empty() {
        clean_host.to_string()
    } else {
        format!("{clean_user}@{clean_host}")
    }
}

fn append_identity_args(command: &mut Command, identity_file: Option<&str>) {
    if let Some(path) = identity_file.map(str::trim).filter(|path| !path.is_empty()) {
        command.arg("-i").arg(expand_identity_file_path(path));
    }
}

fn expand_identity_file_path(path: &str) -> String {
    let trimmed = path.trim();
    let Some(rest) = trimmed.strip_prefix("~/") else {
        return trimmed.to_string();
    };
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() => PathBuf::from(home).join(rest).to_string_lossy().to_string(),
        _ => trimmed.to_string(),
    }
}

fn clean_connection_id(value: &str) -> String {
    value
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || "._:-".contains(char) {
                char
            } else {
                '_'
            }
        })
        .collect::<String>()
}

fn map_ssh_error(stderr: &str) -> (String, String) {
    let lower = stderr.to_lowercase();
    if lower.contains("host key verification failed") || lower.contains("no hostkey alg") {
        return (
            "unknown-host-key".to_string(),
            "This SSH host is not trusted yet. Connect once in Terminal with ssh user@host, then retry.".to_string(),
        );
    }
    if lower.contains("permission denied")
        || lower.contains("publickey")
        || lower.contains("authentication")
    {
        return (
            "auth-failed".to_string(),
            "SSH authentication failed. Add a key to ssh-agent or update your ~/.ssh/config."
                .to_string(),
        );
    }
    (
        "ssh-failed".to_string(),
        if stderr.trim().is_empty() {
            "SSH failed.".to_string()
        } else {
            stderr.trim().to_string()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn maps_host_key_and_auth_errors() {
        assert_eq!(
            map_ssh_error("Host key verification failed.").0,
            "unknown-host-key"
        );
        assert_eq!(
            map_ssh_error("Permission denied (publickey).").0,
            "auth-failed"
        );
    }

    #[test]
    fn expands_home_relative_identity_paths() {
        let old_home = std::env::var_os("HOME");
        std::env::set_var("HOME", "/Users/scott");

        assert_eq!(
            expand_identity_file_path("~/.ssh/id_ed25519"),
            "/Users/scott/.ssh/id_ed25519"
        );
        assert_eq!(expand_identity_file_path("/.ssh/id_ed25519"), "/.ssh/id_ed25519");

        match old_home {
            Some(home) => std::env::set_var("HOME", home),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    #[cfg(unix)]
    fn probe_uses_system_ssh_from_path() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("iris-fake-ssh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fake ssh dir");
        let ssh = dir.join("ssh");
        let mut file = fs::File::create(&ssh).expect("create fake ssh");
        writeln!(
            file,
            "#!/bin/sh\ncase \"$*\" in\n  *curl*) printf '%s\\n' '{{\"ok\":true,\"service\":\"iris-core\",\"version\":\"0.1.0\"}}' ; exit 0 ;;\n  *) exit 0 ;;\nesac"
        )
        .expect("write fake ssh");
        let mut permissions = fs::metadata(&ssh).expect("fake ssh metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&ssh, permissions).expect("chmod fake ssh");
        let old_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{old_path}", dir.display()));

        let result = probe_blocking(SshConnectionConfig {
            connection_id: "ssh_test".to_string(),
            user: "scott".to_string(),
            host: "mac-mini.local".to_string(),
            port: 22,
            identity_file: None,
            remote_core_port: 8765,
        })
        .expect("probe");

        std::env::set_var("PATH", old_path);
        let _ = fs::remove_dir_all(&dir);

        assert!(result.ok, "{result:?}");
        assert!(result.ssh_ok);
        assert!(result.core_ok);
        assert_eq!(result.remote_core_version, "0.1.0");
    }
}
