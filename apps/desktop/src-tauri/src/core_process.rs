use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const DEFAULT_CORE_HOST: &str = "127.0.0.1";
const DEFAULT_CORE_PORT: u16 = 8765;

#[derive(Clone, Default)]
pub struct CoreProcessState {
    inner: Arc<Mutex<ManagedCoreProcess>>,
}

#[derive(Default)]
struct ManagedCoreProcess {
    child: Option<Child>,
    status: CoreSidecarStatus,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSidecarConfig {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub hermes_home: Option<String>,
    pub auto_start: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSidecarStatus {
    pub ok: bool,
    pub running: bool,
    pub ready: bool,
    pub started_by_app: bool,
    pub managed: Option<bool>,
    pub service: String,
    pub version: String,
    pub client_version: String,
    pub bind_host: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub url: String,
    pub log_path: String,
    pub error: String,
}

impl Default for CoreSidecarStatus {
    fn default() -> Self {
        Self {
            ok: false,
            running: false,
            ready: false,
            started_by_app: false,
            managed: None,
            service: String::new(),
            version: String::new(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            bind_host: DEFAULT_CORE_HOST.to_string(),
            port: DEFAULT_CORE_PORT,
            pid: None,
            url: format!("http://{DEFAULT_CORE_HOST}:{DEFAULT_CORE_PORT}"),
            log_path: core_log_path().display().to_string(),
            error: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CoreHealth {
    pub ok: bool,
    pub service: String,
    pub version: String,
    pub pid: Option<u32>,
    pub managed: Option<bool>,
    pub bind_host: String,
    pub port: u16,
}

pub async fn startup_managed_core(app: AppHandle, state: CoreProcessState) {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        start_core_blocking(&handle, &state, CoreSidecarConfig::default())
    })
    .await
    .map_err(|err| format!("Core startup task failed: {err}"))
    .and_then(|value| value);
    if let Ok(status) = result {
        if status.ready {
            let _ = app.emit("iris://core-ready", status);
        }
    }
}

#[tauri::command]
pub async fn core_sidecar_status(
    state: tauri::State<'_, CoreProcessState>,
) -> Result<CoreSidecarStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || status_blocking(&state))
        .await
        .map_err(|err| format!("Core status task failed: {err}"))?
}

#[tauri::command]
pub async fn core_sidecar_start(
    app: AppHandle,
    state: tauri::State<'_, CoreProcessState>,
    config: CoreSidecarConfig,
) -> Result<CoreSidecarStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start_core_blocking(&app, &state, config))
        .await
        .map_err(|err| format!("Core start task failed: {err}"))?
}

#[tauri::command]
pub async fn core_sidecar_stop(
    state: tauri::State<'_, CoreProcessState>,
) -> Result<CoreSidecarStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_core_blocking(&state))
        .await
        .map_err(|err| format!("Core stop task failed: {err}"))?
}

#[tauri::command]
pub async fn core_sidecar_restart(
    app: AppHandle,
    state: tauri::State<'_, CoreProcessState>,
    config: CoreSidecarConfig,
) -> Result<CoreSidecarStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = stop_core_blocking(&state);
        start_core_blocking(&app, &state, config)
    })
    .await
    .map_err(|err| format!("Core restart task failed: {err}"))?
}

pub fn stop_core_now(state: &CoreProcessState) {
    let _ = stop_core_blocking(state);
}

fn status_blocking(state: &CoreProcessState) -> Result<CoreSidecarStatus, String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "Core process state is unavailable.".to_string())?;
    refresh_child_status(&mut guard);
    let host = guard.status.bind_host.clone();
    let port = guard.status.port;
    if let Ok(health) = probe_core_health(&probe_host_for_bind(&host), port, Duration::from_millis(900)) {
        guard.status = status_from_health(health, guard.child.is_some(), "");
    }
    Ok(guard.status.clone())
}

fn start_core_blocking(
    app: &AppHandle,
    state: &CoreProcessState,
    config: CoreSidecarConfig,
) -> Result<CoreSidecarStatus, String> {
    let host = clean_host(config.host.as_deref());
    let port = config.port.unwrap_or(DEFAULT_CORE_PORT);
    let probe_host = probe_host_for_bind(&host);
    let log_path = core_log_path();
    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "Core process state is unavailable.".to_string())?;
        refresh_child_status(&mut guard);
    }

    match probe_core_health(&probe_host, port, Duration::from_millis(900)) {
        Ok(health) => {
            let mut status = status_from_health(health, false, "");
            if status.version != status.client_version {
                status.ok = false;
                status.ready = false;
                status.error = format!(
                    "Version mismatch: Iris Core is {}, but Iris Desktop is {}. Update the remote host or rebuild Iris.",
                    status.version, status.client_version
                );
            }
            let mut guard = state
                .inner
                .lock()
                .map_err(|_| "Core process state is unavailable.".to_string())?;
            guard.status = status.clone();
            return Ok(status);
        }
        Err(error) if !is_connection_absent(&error) => {
            let status = CoreSidecarStatus {
                ok: false,
                running: false,
                ready: false,
                started_by_app: false,
                bind_host: host.clone(),
                port,
                url: format!("http://{host}:{port}"),
                log_path: log_path.display().to_string(),
                error: format!("Port {port} is not a healthy Iris Core: {error}"),
                ..CoreSidecarStatus::default()
            };
            let mut guard = state
                .inner
                .lock()
                .map_err(|_| "Core process state is unavailable.".to_string())?;
            guard.status = status.clone();
            return Ok(status);
        }
        Err(_) => {}
    }

    if config.auto_start == Some(false) {
        let status = CoreSidecarStatus {
            bind_host: host.clone(),
            port,
            url: format!("http://{host}:{port}"),
            log_path: log_path.display().to_string(),
            error: "Iris Core is not running.".to_string(),
            ..CoreSidecarStatus::default()
        };
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "Core process state is unavailable.".to_string())?;
        guard.status = status.clone();
        return Ok(status);
    }

    let binary = core_binary_path(app)?;
    if let Some(parent) = log_path.parent() {
        create_dir_all(parent)
            .map_err(|err| format!("Could not create Core log directory: {err}"))?;
    }
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("Could not open Core log file: {err}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|err| format!("Could not clone Core log file handle: {err}"))?;
    let hermes_home = config.hermes_home.unwrap_or_else(default_hermes_home);
    let mut command = Command::new(&binary);
    command
        .arg("serve")
        .arg("--host")
        .arg(&host)
        .arg("--port")
        .arg(port.to_string())
        .arg("--hermes-home")
        .arg(&hermes_home)
        .env("IRIS_CORE_MANAGED", "1")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().map_err(|err| {
        format!(
            "Could not start bundled Iris Core at {}: {err}",
            binary.display()
        )
    })?;
    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "Core process state is unavailable.".to_string())?;
        guard.child = Some(child);
        guard.status = CoreSidecarStatus {
            ok: true,
            running: true,
            ready: false,
            started_by_app: true,
            bind_host: host.clone(),
            port,
            url: format!("http://{host}:{port}"),
            log_path: log_path.display().to_string(),
            ..CoreSidecarStatus::default()
        };
    }

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match probe_core_health(&probe_host, port, Duration::from_millis(900)) {
            Ok(health) => {
                let mut status = status_from_health(health, true, "");
                status.log_path = log_path.display().to_string();
                if status.version != status.client_version {
                    status.ok = false;
                    status.ready = false;
                    status.error = format!(
                        "Version mismatch: bundled Iris Core is {}, but Iris Desktop is {}.",
                        status.version, status.client_version
                    );
                }
                let mut guard = state
                    .inner
                    .lock()
                    .map_err(|_| "Core process state is unavailable.".to_string())?;
                guard.status = status.clone();
                return Ok(status);
            }
            Err(error) if Instant::now() >= deadline => {
                let mut guard = state
                    .inner
                    .lock()
                    .map_err(|_| "Core process state is unavailable.".to_string())?;
                refresh_child_status(&mut guard);
                guard.status.error =
                    format!("Iris Core did not become ready within 10 seconds: {error}");
                guard.status.ok = false;
                guard.status.ready = false;
                return Ok(guard.status.clone());
            }
            Err(_) => std::thread::sleep(Duration::from_millis(150)),
        }
    }
}

fn stop_core_blocking(state: &CoreProcessState) -> Result<CoreSidecarStatus, String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "Core process state is unavailable.".to_string())?;
    if let Some(mut child) = guard.child.take() {
        terminate_core_child(&mut child, guard.status.pid);
    }
    guard.status = CoreSidecarStatus {
        ok: true,
        running: false,
        ready: false,
        started_by_app: false,
        error: "Stopped the Iris Core process started by this app.".to_string(),
        ..guard.status.clone()
    };
    Ok(guard.status.clone())
}

fn terminate_core_child(child: &mut Child, health_pid: Option<u32>) {
    #[cfg(unix)]
    {
        let process_group = format!("-{}", child.id());
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(&process_group)
            .status();
        std::thread::sleep(Duration::from_millis(150));
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(&process_group)
            .status();
    }
    if let Some(pid) = health_pid.filter(|pid| *pid != child.id()) {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn refresh_child_status(process: &mut ManagedCoreProcess) {
    if let Some(child) = process.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                process.status.running = false;
                process.status.ready = false;
                process.status.ok = false;
                process.status.error = format!("Bundled Iris Core exited with {status}.");
                process.child = None;
            }
            Ok(None) => {
                process.status.running = true;
                process.status.started_by_app = true;
                process.status.pid = Some(child.id());
            }
            Err(error) => {
                process.status.error = format!("Could not inspect Iris Core process: {error}");
            }
        }
    }
}

fn status_from_health(health: CoreHealth, started_by_app: bool, error: &str) -> CoreSidecarStatus {
    let version_match = health.version == env!("CARGO_PKG_VERSION");
    CoreSidecarStatus {
        ok: health.ok && version_match,
        running: health.ok,
        ready: health.ok && version_match,
        started_by_app,
        managed: health.managed,
        service: health.service,
        version: health.version,
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        bind_host: health.bind_host.clone(),
        port: health.port,
        pid: health.pid,
        url: format!("http://{}:{}", health.bind_host, health.port),
        log_path: core_log_path().display().to_string(),
        error: error.to_string(),
    }
}

fn http_get_json(host: &str, port: u16, path: &str, timeout: Duration) -> Result<Value, String> {
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|err| format!("Could not resolve {host}:{port}: {err}"))?
        .next()
        .ok_or_else(|| format!("Could not resolve {host}:{port}"))?;
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|err| format!("Could not connect to {host}:{port}: {err}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| format!("Could not set probe read timeout: {err}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|err| format!("Could not set probe write timeout: {err}"))?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("Could not write probe request: {err}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|err| format!("Could not read probe response: {err}"))?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Probe returned an invalid HTTP response.".to_string())?;
    let status_line = headers.lines().next().unwrap_or_default();
    if !status_line.contains(" 200 ") {
        return Err(format!("Probe returned {status_line}."));
    }
    serde_json::from_str(body.trim()).map_err(|err| format!("Probe returned invalid JSON: {err}"))
}

/// Auth-exempt liveness probe used for Tailscale device discovery. Hits `/v1/ping`,
/// which never requires a bearer token, so it works against a remote Core that is
/// bound to a Tailscale interface and otherwise demands authentication.
pub fn probe_iris_ping(host: &str, port: u16, timeout: Duration) -> Result<String, String> {
    let parsed = http_get_json(host, port, "/v1/ping", timeout)?;
    if parsed.get("service").and_then(Value::as_str) != Some("iris-core") {
        return Err("The service on this port is not Iris Core.".to_string());
    }
    Ok(parsed
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

pub fn probe_core_health(host: &str, port: u16, timeout: Duration) -> Result<CoreHealth, String> {
    let parsed = http_get_json(host, port, "/v1/health", timeout)?;
    if parsed.get("service").and_then(Value::as_str) != Some("iris-core") {
        return Err("The service on this port is not Iris Core.".to_string());
    }
    Ok(CoreHealth {
        ok: parsed.get("ok").and_then(Value::as_bool).unwrap_or(true),
        service: parsed
            .get("service")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        version: parsed
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        pid: parsed
            .get("pid")
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        managed: parsed.get("managed").and_then(Value::as_bool),
        bind_host: parsed
            .get("bindHost")
            .and_then(Value::as_str)
            .unwrap_or(host)
            .to_string(),
        port: parsed
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(port),
    })
}

fn is_connection_absent(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("connection refused")
        || lower.contains("operation timed out")
        || lower.contains("timed out")
}

fn clean_host(value: Option<&str>) -> String {
    let host = value.unwrap_or(DEFAULT_CORE_HOST).trim();
    if host.is_empty() {
        DEFAULT_CORE_HOST.to_string()
    } else {
        host.to_string()
    }
}

fn probe_host_for_bind(host: &str) -> String {
    match host.trim() {
        "0.0.0.0" | "::" | "[::]" => DEFAULT_CORE_HOST.to_string(),
        value => value.to_string(),
    }
}

fn core_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("IRIS_CORE_BINARY") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("binaries").join(core_binary_name());
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            for name in ["iris-core", core_binary_name()] {
                let candidate = exe_dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    let dev_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("iris-core")
        .join(".venv")
        .join("bin")
        .join("iris-core");
    if dev_candidate.is_file() {
        return Ok(dev_candidate);
    }
    Err(format!(
        "Bundled Iris Core binary was not found. Expected {} in the app bundle or {} for development.",
        core_binary_name(),
        dev_candidate.display()
    ))
}

fn core_binary_name() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "iris-core-aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "iris-core-x86_64-apple-darwin"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "iris-core"
    }
}

fn core_log_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
        .join("Library")
        .join("Logs")
        .join("Iris")
        .join("core.log")
}

fn default_hermes_home() -> String {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
        .join(".hermes")
        .display()
        .to_string()
}
