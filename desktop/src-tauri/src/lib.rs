use serde_json::Value;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::panic;
use std::path::PathBuf;
use std::process::Command;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

#[tauri::command]
async fn hermes_bridge(action: String, payload: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_python_bridge(&action, payload))
        .await
        .map_err(|err| format!("Hermes bridge task failed: {err}"))?
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
        .invoke_handler(tauri::generate_handler![hermes_bridge])
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
