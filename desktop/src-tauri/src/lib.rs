mod connection_profiles;
mod core_process;
mod ssh_tunnel;

use serde_json::Value;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::panic;
use std::path::PathBuf;
use std::process::Command;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

#[tauri::command]
async fn core_bridge(action: String, payload: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_python_bridge(&action, payload))
        .await
        .map_err(|err| format!("Core bridge task failed: {err}"))?
}

fn run_python_bridge(action: &str, payload: Value) -> Result<Value, String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/core_bridge.py");
    if !script.exists() {
        return Err(format!(
            "Core bridge script not found at {}",
            script.display()
        ));
    }

    let payload_text = serde_json::to_string(&payload)
        .map_err(|err| format!("Could not serialize Core bridge payload: {err}"))?;

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
                        "Core bridge returned invalid JSON: {err}. Output: {}",
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
    if let Ok(path) = std::env::var("IRIS_DESKTOP_PYTHON") {
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
    let core_state = core_process::CoreProcessState::default();
    let ssh_state = ssh_tunnel::SshTunnelState::default();
    let builder = tauri::Builder::default()
        .manage(core_state.clone())
        .manage(ssh_state.clone());
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            install_crash_logging(app.handle().clone());
            install_app_menu(app)?;
            let app_handle = app.handle().clone();
            let startup_core_state = core_state.clone();
            tauri::async_runtime::spawn(async move {
                core_process::startup_managed_core(app_handle, startup_core_state).await;
            });

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
                    let _ = app.emit("iris://app-command", "show");
                }
                "refresh" => {
                    show_main_window(app);
                    let _ = app.emit("iris://app-command", "refresh");
                }
                "quit" => {
                    let core = app
                        .state::<core_process::CoreProcessState>()
                        .inner()
                        .clone();
                    let ssh = app.state::<ssh_tunnel::SshTunnelState>().inner().clone();
                    core_process::stop_core_now(&core);
                    ssh_tunnel::stop_all_tunnels(&ssh);
                    app.exit(0);
                }
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
            core_bridge,
            core_process::core_sidecar_status,
            core_process::core_sidecar_start,
            core_process::core_sidecar_stop,
            core_process::core_sidecar_restart,
            connection_profiles::core_install_hermes_plugin,
            connection_profiles::core_service_install,
            connection_profiles::core_service_uninstall,
            connection_profiles::core_service_status,
            connection_profiles::open_core_logs,
            ssh_tunnel::ssh_connection_probe,
            ssh_tunnel::ssh_tunnel_start,
            ssh_tunnel::ssh_tunnel_stop,
            ssh_tunnel::ssh_tunnel_status
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("Iris desktop exited with an unrecoverable Tauri error: {err}");
            std::process::exit(1);
        });

    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            cleanup_managed_processes(app);
        }
        _ => {}
    });
}

fn cleanup_managed_processes(app: &tauri::AppHandle) {
    let core = app
        .state::<core_process::CoreProcessState>()
        .inner()
        .clone();
    let ssh = app.state::<ssh_tunnel::SshTunnelState>().inner().clone();
    core_process::stop_core_now(&core);
    ssh_tunnel::stop_all_tunnels(&ssh);
}

fn install_app_menu(app: &mut tauri::App) -> tauri::Result<()> {
    let about = PredefinedMenuItem::about(app, None, None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let app_separator_one = PredefinedMenuItem::separator(app)?;
    let app_separator_two = PredefinedMenuItem::separator(app)?;
    let app_menu = Submenu::with_items(
        app,
        "Iris",
        true,
        &[
            &about,
            &app_separator_one,
            &hide,
            &hide_others,
            &show_all,
            &app_separator_two,
            &quit,
        ],
    )?;

    let new_chat = MenuItem::with_id(app, "new-chat", "New Chat", true, Some("CmdOrCtrl+KeyN"))?;
    let command_menu = MenuItem::with_id(
        app,
        "command-menu",
        "Command Palette",
        true,
        Some("CmdOrCtrl+KeyK"),
    )?;
    let search_chats = MenuItem::with_id(
        app,
        "search-chats",
        "Search Chats",
        true,
        Some("CmdOrCtrl+KeyG"),
    )?;
    let refresh = MenuItem::with_id(
        app,
        "refresh",
        "Refresh Connection",
        true,
        Some("CmdOrCtrl+KeyR"),
    )?;
    let file_separator_one = PredefinedMenuItem::separator(app)?;
    let file_separator_two = PredefinedMenuItem::separator(app)?;
    let close = PredefinedMenuItem::close_window(app, None)?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_chat,
            &command_menu,
            &search_chats,
            &file_separator_one,
            &refresh,
            &file_separator_two,
            &close,
        ],
    )?;

    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_separator_one = PredefinedMenuItem::separator(app)?;
    let edit_separator_two = PredefinedMenuItem::separator(app)?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &edit_separator_one,
            &cut,
            &copy,
            &paste,
            &edit_separator_two,
            &select_all,
        ],
    )?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let bring_all_to_front = PredefinedMenuItem::bring_all_to_front(app, None)?;
    let window_separator_one = PredefinedMenuItem::separator(app)?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &minimize,
            &fullscreen,
            &window_separator_one,
            &bring_all_to_front,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "new-chat" => {
            show_main_window(app);
            let _ = app.emit("iris://app-command", "new-chat");
        }
        "command-menu" => {
            show_main_window(app);
            let _ = app.emit("iris://app-command", "command-menu");
        }
        "search-chats" => {
            show_main_window(app);
            let _ = app.emit("iris://app-command", "search");
        }
        "refresh" => {
            show_main_window(app);
            let _ = app.emit("iris://app-command", "refresh");
        }
        _ => {}
    });

    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("Iris");
        let _ = window.set_content_protected(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.center();
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
