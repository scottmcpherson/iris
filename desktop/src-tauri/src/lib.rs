use serde_json::Value;
use std::collections::HashMap;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::io::{BufRead, BufReader, Read};
use std::panic;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

type RunningProcess = Arc<Mutex<Child>>;

static RUNNING_STREAMS: OnceLock<Mutex<HashMap<String, RunningProcess>>> = OnceLock::new();

#[tauri::command]
async fn hermes_bridge(action: String, payload: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_python_bridge(&action, payload))
        .await
        .map_err(|err| format!("Hermes bridge task failed: {err}"))?
}

#[tauri::command]
async fn hermes_stream_message(
    app: tauri::AppHandle,
    request_id: String,
    payload: Value,
) -> Result<Value, String> {
    let request_id_for_task = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_python_bridge_stream(app, request_id_for_task, payload)
    });

    Ok(serde_json::json!({
        "ok": true,
        "requestId": request_id
    }))
}

#[tauri::command]
async fn hermes_cancel_message(request_id: String) -> Result<Value, String> {
    let streams = RUNNING_STREAMS.get_or_init(|| Mutex::new(HashMap::new()));
    let process = streams
        .lock()
        .map_err(|_| "Hermes process registry is unavailable.".to_string())?
        .remove(&request_id);

    if let Some(process) = process {
        let mut child = process
            .lock()
            .map_err(|_| "Hermes subprocess is unavailable.".to_string())?;
        child
            .kill()
            .map_err(|err| format!("Could not cancel Hermes request: {err}"))?;
        Ok(serde_json::json!({ "ok": true, "requestId": request_id }))
    } else {
        Ok(serde_json::json!({
            "ok": false,
            "requestId": request_id,
            "error": "No active Hermes request matched that id."
        }))
    }
}

fn run_python_bridge(action: &str, payload: Value) -> Result<Value, String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/hermes_bridge.py");
    if !script.exists() {
        return Err(format!("Hermes bridge script not found at {}", script.display()));
    }

    let payload_text = serde_json::to_string(&payload)
        .map_err(|err| format!("Could not serialize Hermes bridge payload: {err}"))?;

    let mut last_error = String::new();
    for python in python_candidates() {
        let output = Command::new(&python)
            .arg(&script)
            .arg(action)
            .arg(&payload_text)
            .output();

        match output {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                return serde_json::from_str(stdout.trim()).map_err(|err| {
                    format!(
                        "Hermes bridge returned invalid JSON: {err}. Output: {}",
                        stdout.trim()
                    )
                });
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                last_error = format!(
                    "{python} exited with {}. stderr: {} stdout: {}",
                    output.status,
                    stderr.trim(),
                    stdout.trim()
                );
            }
            Err(err) => {
                last_error = format!("{python} failed to launch: {err}");
            }
        }
    }

    Err(last_error)
}

fn run_python_bridge_stream(
    app: tauri::AppHandle,
    request_id: String,
    mut payload: Value,
) -> Result<(), String> {
    let script = bridge_script()?;
    payload["requestId"] = Value::String(request_id.clone());
    let payload_text = serde_json::to_string(&payload)
        .map_err(|err| format!("Could not serialize Hermes bridge payload: {err}"))?;

    let mut last_error = String::new();
    for python in python_candidates() {
        let mut child = match Command::new(&python)
            .arg(&script)
            .arg("stream_message")
            .arg(&payload_text)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                last_error = format!("{python} failed to launch: {err}");
                continue;
            }
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let process = Arc::new(Mutex::new(child));
        RUNNING_STREAMS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "Hermes process registry is unavailable.".to_string())?
            .insert(request_id.clone(), process.clone());

        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    let _ = app.emit("hermes://stream", event);
                }
            }
        }

        let status = process
            .lock()
            .map_err(|_| "Hermes subprocess is unavailable.".to_string())?
            .wait()
            .map_err(|err| format!("Hermes stream wait failed: {err}"))?;

        RUNNING_STREAMS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "Hermes process registry is unavailable.".to_string())?
            .remove(&request_id);

        if status.success() {
            return Ok(());
        }

        let mut stderr_text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut stderr_text);
        }
        let event = serde_json::json!({
            "ok": false,
            "requestId": request_id,
            "type": "error",
            "error": stderr_text.trim()
        });
        let _ = app.emit("hermes://stream", event);
        return Ok(());
    }

    let event = serde_json::json!({
        "ok": false,
        "requestId": request_id,
        "type": "error",
        "error": last_error
    });
    let _ = app.emit("hermes://stream", event);
    Ok(())
}

fn bridge_script() -> Result<PathBuf, String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/hermes_bridge.py");
    if !script.exists() {
        return Err(format!("Hermes bridge script not found at {}", script.display()));
    }
    Ok(script)
}

fn python_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("HERMES_DESKTOP_PYTHON") {
        if !path.trim().is_empty() {
            candidates.push(path);
        }
    }
    candidates.push("python3".to_string());
    candidates.push("python".to_string());
    candidates
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            install_crash_logging(app.handle().clone());

            let show = MenuItem::with_id(app, "show", "Show Iris", true, None::<&str>)?;
            let refresh =
                MenuItem::with_id(app, "refresh", "Refresh Connection", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Iris", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &refresh, &separator, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Iris")
                .menu(&menu)
                .show_menu_on_left_click(true);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event: MenuEvent| match event.id().as_ref() {
                "show" => {
                    show_main_window(app);
                    let _ = app.emit("hermes://app-command", "show");
                }
                "refresh" => {
                    show_main_window(app);
                    let _ = app.emit("hermes://app-command", "refresh");
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray: &TrayIcon<tauri::Wry>, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    show_main_window(app);
                }
            })
            .build(app)?;

            show_main_window(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hermes_bridge,
            hermes_stream_message,
            hermes_cancel_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn install_crash_logging(app: tauri::AppHandle) {
    let log_path = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Iris"))
        .join("crash.log");

    panic::set_hook(Box::new(move |info| {
        if let Some(parent) = log_path.parent() {
            let _ = create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
            let _ = writeln!(file, "panic: {info}");
        }
    }));
}
