mod state;
#[cfg(windows)]
mod windows;

use std::{sync::Mutex, time::Instant};
use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize)]
pub struct Prompt {
    id: u64,
    app: String,
}
#[derive(Clone, serde::Serialize)]
pub struct Status {
    enabled: bool,
    supported: bool,
    error: Option<String>,
}
struct Inner {
    enabled: bool,
    ready: bool,
    pending: Option<(Prompt, Instant)>,
    next_id: u64,
    record_requested: bool,
    error: Option<String>,
}
pub struct MeetingDetection(Mutex<Inner>);

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Main window required".into());
    }
    Ok(())
}
fn preference_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("meeting-detection.json"))
}
#[tauri::command]
pub fn meeting_detection_status(
    window: tauri::WebviewWindow,
    state: tauri::State<MeetingDetection>,
) -> Result<Status, String> {
    main_only(&window)?;
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(Status {
        enabled: inner.enabled,
        supported: cfg!(windows),
        error: inner.error.clone(),
    })
}
#[tauri::command]
pub fn set_meeting_detection(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<MeetingDetection>,
    enabled: bool,
) -> Result<(), String> {
    main_only(&window)?;
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let path = preference_path(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("Missing settings directory")?)
        .map_err(|e| e.to_string())?;
    std::fs::write(
        path,
        serde_json::to_vec(&enabled).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    inner.enabled = enabled;
    inner.pending = None;
    if !enabled {
        inner.record_requested = false;
    }
    drop(inner);
    close_prompt(&app);
    Ok(())
}
#[tauri::command]
pub fn meeting_detection_ready(
    window: tauri::WebviewWindow,
    state: tauri::State<MeetingDetection>,
    ready: bool,
) -> Result<(), String> {
    main_only(&window)?;
    state.0.lock().map_err(|e| e.to_string())?.ready = ready;
    Ok(())
}
#[tauri::command]
pub fn meeting_detection_take_request(
    window: tauri::WebviewWindow,
    state: tauri::State<MeetingDetection>,
) -> Result<bool, String> {
    main_only(&window)?;
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(std::mem::take(&mut inner.record_requested))
}
#[tauri::command]
pub fn meeting_prompt(state: tauri::State<MeetingDetection>) -> Result<Option<Prompt>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .pending
        .as_ref()
        .map(|p| p.0.clone()))
}
#[tauri::command]
pub async fn respond_to_meeting(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, MeetingDetection>,
    id: u64,
    record: bool,
) -> Result<(), String> {
    if window.label() != "meeting-prompt" {
        return Err("Meeting prompt required".into());
    }
    {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        let valid = inner
            .pending
            .as_ref()
            .is_some_and(|(p, time)| p.id == id && time.elapsed().as_secs() < 45);
        if !valid {
            return Err("This call prompt has expired".into());
        }
        if record && (!inner.enabled || !inner.ready) {
            return Err("Open oats and finish setup first".into());
        }
        inner.pending = None;
        if record {
            inner.record_requested = true;
        }
    }
    close_prompt(&app);
    if record {
        crate::tray::focus_main_window(&app);
        app.emit_to("main", "meeting-record-requested", ())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn close_prompt(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("meeting-prompt") {
        let _ = window.close();
    }
}

#[cfg(windows)]
fn show_prompt(app: &tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let inner = handle.state::<MeetingDetection>();
            // A disable/record command can race the queued window creation.
            if inner.0.lock().map_err(|e| e.to_string())?.pending.is_none() {
                return Ok(());
            }
            close_prompt(&handle);
            let window = tauri::WebviewWindowBuilder::new(
                &handle,
                "meeting-prompt",
                tauri::WebviewUrl::App("meeting-prompt.html".into()),
            )
            .title("Call detected · oats")
            .inner_size(370.0, 270.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
            if let Some(monitor) = handle
                .get_webview_window("main")
                .and_then(|w| w.current_monitor().ok().flatten())
            {
                let area = monitor.work_area();
                let scale = monitor.scale_factor();
                let x = area.position.x + area.size.width as i32 - (390.0 * scale) as i32;
                let y = area.position.y + (40.0 * scale) as i32;
                window
                    .set_position(tauri::PhysicalPosition::new(x.max(area.position.x), y))
                    .map_err(|e| e.to_string())?;
            }
            window.show().map_err(|e| e.to_string())
        })();
        if let Err(error) = result {
            if let Ok(mut inner) = handle.state::<MeetingDetection>().0.lock() {
                inner.pending = None;
                inner.error = Some(error);
            }
        }
    })
    .map_err(|e| e.to_string())
}

pub fn start(app: &tauri::AppHandle) {
    // Corrupt/unreadable existing preferences fail closed. New installs default on.
    let enabled = preference_path(app)
        .ok()
        .map(|path| match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice::<bool>(&bytes).unwrap_or(false),
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        })
        .unwrap_or(false);
    app.manage(MeetingDetection(Mutex::new(Inner {
        enabled,
        ready: false,
        pending: None,
        next_id: 0,
        record_requested: false,
        error: None,
    })));
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let probe = match windows::AudioProbe::new() {
                Ok(probe) => probe,
                Err(error) => {
                    app.state::<MeetingDetection>().0.lock().unwrap().error = Some(error);
                    return;
                }
            };
            let start = Instant::now();
            let mut detector = state::Detector::default();
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let state = app.state::<MeetingDetection>();
                let enabled = {
                    let inner = state.0.lock().unwrap();
                    inner.enabled && inner.ready
                };
                if !enabled {
                    detector = state::Detector::default();
                    close_prompt(&app);
                    continue;
                }
                let active = match probe.active_apps() {
                    Ok(active) => active,
                    Err(error) => {
                        let mut inner = state.0.lock().unwrap();
                        inner.error = Some(error);
                        inner.pending = None;
                        drop(inner);
                        close_prompt(&app);
                        continue;
                    }
                };
                let recording = crate::dictation::is_busy() || crate::audio::recording_commands::get_active_capture()
                    .map(|s| s.is_some())
                    .unwrap_or(true)
                    || tauri::async_runtime::block_on(
                        crate::audio::recording_commands::is_recording(),
                    );
                let mut inner = state.0.lock().unwrap();
                inner.error = None;
                if inner.pending.as_ref().is_some_and(|(p, t)| {
                    t.elapsed().as_secs() >= 45
                        || recording
                        || !active.iter().any(|a| a.label() == p.app)
                }) {
                    inner.pending = None;
                    close_prompt(&app);
                }
                // Suppress concurrent calls while a prompt is already being handled.
                let next = detector.update(
                    start.elapsed().as_secs(),
                    &active,
                    recording || inner.pending.is_some() || inner.record_requested,
                );
                if let Some(call) = next {
                    if !inner.enabled || !inner.ready {
                        continue;
                    }
                    inner.next_id += 1;
                    inner.pending = Some((
                        Prompt {
                            id: inner.next_id,
                            app: call.label().into(),
                        },
                        Instant::now(),
                    ));
                    drop(inner);
                    if let Err(error) = show_prompt(&app) {
                        let mut inner = state.0.lock().unwrap();
                        inner.pending = None;
                        inner.error = Some(error);
                    }
                }
            }
        });
    }
}
