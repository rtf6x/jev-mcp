// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_HTTP_PORT: u16 = 18791;
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// The repository's template: one source of truth for what a fresh `.env` contains.
const ENV_TEMPLATE: &str = include_str!("../../../.env.example");

#[derive(Deserialize)]
struct HealthResponse {
    endpoint: String,
    model: String,
}

struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    running: AtomicBool,
}

struct MenuHandles {
    status_item: MenuItem<tauri::Wry>,
    endpoint_item: MenuItem<tauri::Wry>,
    toggle_item: MenuItem<tauri::Wry>,
    autostart_item: CheckMenuItem<tauri::Wry>,
}

fn config_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().expect("app config dir must resolve");
    fs::create_dir_all(&dir).ok();
    dir
}

fn env_path(app: &AppHandle) -> PathBuf {
    config_dir(app).join(".env")
}

fn log_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_log_dir().expect("app log dir must resolve");
    fs::create_dir_all(&dir).ok();
    dir.join("mcp-server.log")
}

/// Read `KEY=VALUE` lines; blanks, `#` comments and an `export` prefix are handled the same
/// way the server handles them, so the menu shows what the sidecar will actually use.
fn read_env_file(path: &Path) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let Ok(raw) = fs::read_to_string(path) else {
        return values;
    };
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        let quoted = value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')));
        let value = if quoted { &value[1..value.len() - 1] } else { value };
        values.insert(key.trim().to_string(), value.to_string());
    }
    values
}

/// Create the `.env` from the shipped template when it is missing, so the tray always has a
/// file to open and the user has the keys to fill in.
fn ensure_env_file(app: &AppHandle) -> PathBuf {
    let path = env_path(app);
    if !path.exists() {
        let _ = fs::write(&path, ENV_TEMPLATE);
    }
    path
}

fn http_port(app: &AppHandle) -> u16 {
    read_env_file(&env_path(app))
        .get("MCP_HTTP_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_HTTP_PORT)
}

fn endpoint_label(app: &AppHandle) -> String {
    match read_env_file(&env_path(app)).get("JEV_URL") {
        Some(url) if !url.is_empty() => format!("Endpoint: {url}"),
        _ => "Endpoint: set JEV_URL in .env".to_string(),
    }
}

fn reveal_path(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = StdCommand::new("open").arg("-R").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let _ = StdCommand::new("explorer").arg("/select,").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = StdCommand::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn();
}

fn open_in_editor(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = StdCommand::new("open").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let _ = StdCommand::new("cmd").args(["/C", "start", ""]).arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = StdCommand::new("xdg-open").arg(path).spawn();
}

fn start_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if state.running.load(Ordering::SeqCst) {
        return;
    }
    let env_file = ensure_env_file(app);
    let log_file = log_path(app);

    let (mut rx, child) = match app
        .shell()
        .sidecar("mcp-server")
        .expect("mcp-server sidecar must be bundled")
        .env("JEV_MCP_ENV", env_file.to_string_lossy().to_string())
        .env("JEV_MCP_EXIT_WITH_PARENT", "1")
        .spawn()
    {
        Ok(pair) => pair,
        Err(err) => {
            append_log(&log_file, &format!("[desktop] failed to spawn sidecar: {err}\n"));
            set_status(app, "Status: error (see logs)");
            return;
        }
    };

    *state.child.lock() = Some(child);
    state.running.store(true, Ordering::SeqCst);
    set_status(app, "Status: starting…");
    set_toggle_label(app, "Stop server");
    set_endpoint_label(app, &endpoint_label(app));

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let line = match event {
                CommandEvent::Stdout(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                CommandEvent::Stderr(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                CommandEvent::Terminated(payload) => {
                    let state = app_handle.state::<SidecarState>();
                    state.running.store(false, Ordering::SeqCst);
                    *state.child.lock() = None;
                    set_status(&app_handle, "Status: stopped");
                    set_toggle_label(&app_handle, "Start server");
                    set_endpoint_label(&app_handle, &endpoint_label(&app_handle));
                    append_log(
                        &log_path(&app_handle),
                        &format!("[desktop] sidecar exited: {:?}\n", payload.code),
                    );
                    continue;
                }
                _ => continue,
            };
            append_log(&log_path(&app_handle), &line);
        }
    });
}

fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if let Some(child) = state.child.lock().take() {
        let _ = child.kill();
    }
    state.running.store(false, Ordering::SeqCst);
    set_status(app, "Status: stopped");
    set_toggle_label(app, "Start server");
}

fn append_log(path: &Path, text: &str) {
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(text.as_bytes());
    }
}

fn set_status(app: &AppHandle, text: &str) {
    if let Some(menu) = app.try_state::<MenuHandles>() {
        let _ = menu.status_item.set_text(text);
    }
}

fn set_toggle_label(app: &AppHandle, text: &str) {
    if let Some(menu) = app.try_state::<MenuHandles>() {
        let _ = menu.toggle_item.set_text(text);
    }
}

fn set_endpoint_label(app: &AppHandle, text: &str) {
    if let Some(menu) = app.try_state::<MenuHandles>() {
        let _ = menu.endpoint_item.set_text(text);
    }
}

/// Poll `/health` while the sidecar runs: the endpoint answers only once it has bound its
/// port, which is exactly the fact the tray needs to show.
fn poll_health(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        if !app.state::<SidecarState>().running.load(Ordering::SeqCst) {
            continue;
        }
        let url = format!("http://127.0.0.1:{}/health", http_port(&app));
        match ureq::get(&url).timeout(Duration::from_secs(2)).call() {
            Ok(response) => {
                if let Ok(health) = response.into_json::<HealthResponse>() {
                    set_status(&app, "Status: running");
                    set_endpoint_label(&app, &format!("{} · {}", health.endpoint, health.model));
                }
            }
            Err(_) => set_status(&app, "Status: starting…"),
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let status_item = MenuItem::with_id(app, "status", "Status: stopped", false, None::<&str>)?;
    let endpoint_item = MenuItem::with_id(app, "endpoint", "", false, None::<&str>)?;
    let toggle_item = MenuItem::with_id(app, "toggle", "Stop server", true, None::<&str>)?;
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "Launch at startup",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let edit_env_item = MenuItem::with_id(app, "edit-env", "Edit .env", true, None::<&str>)?;
    let open_logs_item = MenuItem::with_id(app, "open-logs", "Open logs", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &endpoint_item,
            &PredefinedMenuItem::separator(app)?,
            &toggle_item,
            &autostart_item,
            &PredefinedMenuItem::separator(app)?,
            &edit_env_item,
            &open_logs_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    app.manage(MenuHandles {
        status_item,
        endpoint_item,
        toggle_item,
        autostart_item,
    });

    TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        // The menu bar gets its own monochrome glyph, not the window icon: macOS paints a
        // template image from its alpha alone, so the colour app icon would land in the bar as a
        // solid tile. `desktop-app/icons-src/tray.svg` is the drawing, `npm run icons` renders it.
        .icon(tauri::include_image!("./icons/tray-template.png"))
        .tooltip("Jev MCP")
        // A template image is recoloured for the light and dark bar and for the highlighted
        // state; without this the glyph is drawn in its own black and disappears on a dark bar.
        // A no-op off macOS.
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                if app.state::<SidecarState>().running.load(Ordering::SeqCst) {
                    stop_sidecar(app);
                } else {
                    start_sidecar(app);
                }
            }
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                if enabled {
                    let _ = manager.disable();
                } else {
                    let _ = manager.enable();
                }
                if let Some(menu) = app.try_state::<MenuHandles>() {
                    let _ = menu.autostart_item.set_checked(!enabled);
                }
            }
            "edit-env" => open_in_editor(&env_path(app)),
            "open-logs" => reveal_path(&log_path(app)),
            "quit" => {
                stop_sidecar(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(SidecarState {
            child: Mutex::new(None),
            running: AtomicBool::new(false),
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            ensure_env_file(&handle);
            // The tray icon is reference-counted and removed as soon as the last handle drops,
            // so it has to be kept in the app's state for the app's lifetime.
            let tray = build_tray(&handle)?;
            app.manage(tray);
            set_endpoint_label(&handle, &endpoint_label(&handle));
            start_sidecar(&handle);
            poll_health(handle);
            Ok(())
        })
        .on_window_event(|_, _| {})
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                stop_sidecar(app_handle);
            }
        });
}
