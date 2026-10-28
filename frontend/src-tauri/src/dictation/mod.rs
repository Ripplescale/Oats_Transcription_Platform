//! Short, local dictation into the foreground app. The microphone and ASR child
//! have one owner; neither creates a meeting nor changes the clipboard implicitly.
mod capture;
mod engine;
mod pipeline;
mod live_delivery;
mod placement;
#[cfg(test)]
mod process;
#[cfg(windows)]
mod windows;

use serde::Serialize;
use serde_json::Value;
use std::{fs, path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex}, thread, time::{Duration, Instant}};
use tauri::{Emitter, Manager};

static BUSY: AtomicBool = AtomicBool::new(false);
static ENGINE: Mutex<Option<engine::Worker>> = Mutex::new(None);
const MODEL_IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);
pub(crate) fn is_busy() -> bool { BUSY.load(Ordering::Acquire) }
pub(crate) fn try_claim() -> Result<(), String> {
    BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| ()).map_err(|_| "Dictation is already running.".into())
}
struct BusyGuard;
impl Drop for BusyGuard { fn drop(&mut self) { BUSY.store(false, Ordering::Release); } }

/// Call under the meeting launch/capture gate, after its dictation-busy check.
/// A cached model must not compete with a meeting's GPU or memory allocation.
pub(crate) fn release_idle_model() {
    if is_busy() { return; }
    let mut engine = ENGINE.lock().unwrap_or_else(|p| p.into_inner());
    if !is_busy() { engine.take(); }
}

fn discard_engine() { ENGINE.lock().unwrap_or_else(|p| p.into_inner()).take(); }

struct SessionEngineGuard { keep: bool }
impl Drop for SessionEngineGuard {
    fn drop(&mut self) { if !self.keep { discard_engine(); } }
}

fn expire_idle_model() {
    if is_busy() { return; }
    let Ok(mut slot) = ENGINE.try_lock() else { return; };
    if is_busy() { return; }
    if slot.as_mut().map(|worker| worker.has_idle_expired(MODEL_IDLE_LIMIT)
        || !worker.is_alive().unwrap_or(false)).unwrap_or(false) { slot.take(); }
}

#[derive(Clone, Serialize)]
pub struct Binding { label: String, registered: bool, observed: bool, error: Option<String> }
#[derive(Clone, Serialize)]
pub struct Shortcuts { fallback: Binding, copilot: Binding }
impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            fallback: Binding { label: "Ctrl+Alt+Shift+D".into(), registered: false, observed: false, error: None },
            copilot: Binding { label: "Copilot (Win+Shift+F23)".into(), registered: false, observed: false, error: None },
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    phase: String, session_id: Option<String>, elapsed_seconds: f64, level: f32,
    text: Option<String>, message: Option<String>, microphone: Option<String>,
    live_typing: bool, inserted_characters: usize, delivery_message: Option<String>,
    backend: String, draft_text: Option<String>,
    shortcuts: Shortcuts, available: bool,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self { phase: "idle".into(), session_id: None, elapsed_seconds: 0.0, level: 0.0,
            text: None, message: None, microphone: None, live_typing: false, inserted_characters: 0,
            delivery_message: None, backend: "trelis".into(), draft_text: None,
            shortcuts: Shortcuts::default(), available: cfg!(windows) }
    }
}
struct Control { commands: mpsc::Sender<capture::CaptureCommand>, cancelled: Arc<AtomicBool> }
struct Inner { snapshot: Snapshot, control: Option<Control> }
struct Service {
    app: tauri::AppHandle, inner: Mutex<Inner>, worker: Mutex<Option<thread::JoinHandle<()>>>,
    popup: Mutex<placement::State>,
    closing: AtomicBool,
    #[cfg(windows)] hotkeys: Mutex<Option<windows::Hotkeys>>,
}
#[derive(Clone)]
pub struct Dictation(Arc<Service>);

/// Installation alone must preserve completed fallback text until the user
/// dismisses it. This deliberately does not change recording/model busy state.
pub(crate) fn has_pending_result(app: &tauri::AppHandle) -> Result<bool, String> {
    let state = app.try_state::<Dictation>().ok_or("Dictation status is unavailable. Try installing again later.")?;
    let inner = state.0.inner.try_lock().map_err(|_| "Dictation status is changing. Try installing again later.")?;
    Ok(crate::updates::policy::dictation_result_pending(&inner.snapshot.phase, inner.snapshot.text.as_deref()))
}
#[cfg(windows)]
type Target = windows::Target;
#[cfg(not(windows))]
#[derive(Clone)]
struct Target;

struct SessionDelivery {
    ledger: live_delivery::Delivery,
    #[cfg(windows)] guard: Option<windows::LiveGuard>,
}

impl SessionDelivery {
    fn new(target: Option<Target>, popup: Option<usize>) -> Self {
        let mut ledger = live_delivery::Delivery::new();
        #[cfg(windows)] {
            let guard = match target {
                Some(target) => match windows::LiveGuard::start(target, popup) {
                    Ok(guard) => Some(guard),
                    Err(error) => { ledger.interrupt(error); None },
                },
                None => { ledger.interrupt("Finish to copy your text. Use the shortcut in another app for live typing.".into()); None },
            };
            Self { ledger, guard }
        }
        #[cfg(not(windows))] {
            let _ = (target, popup);
            ledger.interrupt("Live dictation typing is available on Windows.".into());
            Self { ledger }
        }
    }
    fn observe(&mut self, text: &str, final_request: bool, cancelled: &AtomicBool) {
        #[cfg(windows)] {
            let guard = &self.guard;
            self.ledger.observe(text, final_request, |delta| {
                guard.as_ref().ok_or_else(|| "Finish to copy your text.".to_owned())?.insert(delta, cancelled)
            });
        }
        #[cfg(not(windows))] {
            let _ = cancelled;
            self.ledger.observe(text, final_request, |_| Err("Finish to copy your text.".into()));
        }
    }
    fn interruption(&self) -> Option<String> {
        #[cfg(windows)] { self.guard.as_ref().and_then(|guard| guard.interruption()) }
        #[cfg(not(windows))] { None }
    }
}

fn active(phase: &str) -> bool { matches!(phase, "starting" | "listening" | "transcribing") }
fn same_session(snapshot: &Snapshot, expected: &Option<String>) -> Result<(), String> {
    if snapshot.session_id == *expected { Ok(()) } else { Err("Dictation has changed. Please try that control again.".into()) }
}
fn service(app: &tauri::AppHandle) -> Dictation { app.state::<Dictation>().inner().clone() }
fn allowed(window: &tauri::WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "dictation") { Ok(()) } else { Err("Dictation controls are only available in oats.".into()) }
}

struct Runtime { config: Value, worker: PathBuf }
fn prepare_engine(runtime: &Runtime, closing: &AtomicBool) -> Result<(), String> {
    let mut slot = ENGINE.lock().map_err(|e| e.to_string())?;
    if closing.load(Ordering::Acquire) { return Err("oats is closing.".into()); }
    let reusable = slot.as_mut().map(|worker| worker.matches(&runtime.config, &runtime.worker)
        && !worker.has_idle_expired(MODEL_IDLE_LIMIT) && worker.is_alive().unwrap_or(false)).unwrap_or(false);
    if !reusable {
        slot.take();
        *slot = Some(engine::Worker::spawn(&runtime.config, &runtime.worker)?);
    }
    Ok(())
}
fn runtime(app: &tauri::AppHandle) -> Result<Runtime, String> {
    if !cfg!(windows) { return Err("Dictation shortcuts are available on Windows.".into()); }
    let root = crate::local_workspace::data_root()?;
    let path = if let Some(path) = std::env::var_os("OATS_DICTATION_RUNTIME") {
        let path = PathBuf::from(path);
        if !path.is_absolute() { return Err("The experimental dictation configuration must be an absolute local path.".into()); }
        path
    } else if root.join("dictation-runtime.json").is_file() { root.join("dictation-runtime.json") }
    else { root.join("runtime.json") };
    let config: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "Set up the local speech runtime before dictating.")?).map_err(|_| "The local speech runtime configuration could not be read.")?;
    let selected = engine::backend(&config)?;
    if selected == "trelis" { crate::local_transcription::prepare_model_working_directory(&config, "trelis")?; }
    let keys: &[&str] = if selected == "faster_whisper" { &["python_executable"] }
        else { &["python_executable", "worker_script", "registry_path"] };
    for key in keys {
        let path = config[*key].as_str().map(PathBuf::from).ok_or("The local speech runtime needs setup.")?;
        if !path.is_absolute() || !path.is_file() { return Err("The local speech runtime needs setup.".into()); }
    }
    if selected == "faster_whisper" {
        let model = config["faster_whisper"]["model_path"].as_str().map(PathBuf::from)
            .ok_or("Set up the faster-whisper dictation model first.")?;
        if !model.is_absolute() || !model.is_dir()
            || ["config.json", "model.bin", "tokenizer.json"].iter().any(|name| !model.join(name).is_file()) {
            return Err("The faster-whisper dictation model files are unavailable.".into());
        }
    } else {
    let model = &config["models"]["trelis"];
    if !matches!(model["backend"].as_str().unwrap_or("transformers"), "transformers" | "openvino") {
        return Err("Dictation needs the local Trelis Transformers or OpenVINO runtime.".into());
    }
    if !model["artifact_path"].as_str().map(|p| PathBuf::from(p).exists()).unwrap_or(false) {
        return Err("Set up the local Trelis model before dictating.".into());
    }
    let adapter = PathBuf::from(config["worker_script"].as_str().unwrap()).parent().unwrap().join("sttbench/runtime/api.py");
    if !adapter.is_file() { return Err("The installed speech runtime needs a dictation adapter update.".into()); }
    }
    let mut worker = app.path().resource_dir().map_err(|e| e.to_string())?.join("dictation_worker.py");
    if cfg!(debug_assertions) && !worker.is_file() { worker = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/dictation_worker.py"); }
    if !worker.is_file() { return Err("The dictation worker is missing from this oats build.".into()); }
    if selected == "faster_whisper" && !worker.parent().unwrap().join("faster_whisper_dictation.py").is_file() {
        return Err("The faster-whisper dictation module is missing from this oats build.".into());
    }
    Ok(Runtime { config, worker })
}

impl Dictation {
    /// Build the hidden WebView before the first shortcut, without opening the
    /// microphone or activating a window in the user's foreground application.
    fn prepare_overlay(&self) -> Result<tauri::WebviewWindow, String> {
        if self.0.closing.load(Ordering::Acquire) { return Err("oats is closing.".into()); }
        if let Some(window) = self.0.app.get_webview_window("dictation") { return Ok(window); }
        let window = tauri::WebviewWindowBuilder::new(&self.0.app, "dictation", tauri::WebviewUrl::App("dictation.html".into()))
            .title("Dictation · oats").inner_size(placement::WIDTH, placement::COLLAPSED_HEIGHT).decorations(false).resizable(false)
            .shadow(false).background_color(tauri::window::Color(255, 253, 250, 255))
            .maximizable(false).minimizable(false).always_on_top(true).skip_taskbar(true)
            .focused(false).focusable(false).visible(false).build().map_err(|e| e.to_string())?;
        #[cfg(windows)] {
            let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
            windows::make_nonactivating(hwnd)?;
            let size = window.outer_size().map_err(|e| e.to_string())?;
            windows::round_overlay(hwnd, size.width as i32, size.height as i32)?;
        }
        Ok(window)
    }
    fn snapshot(&self) -> Snapshot {
        let mut snapshot = self.0.inner.lock().unwrap_or_else(|p| p.into_inner()).snapshot.clone();
        match runtime(&self.0.app) {
            Ok(runtime) => {
                snapshot.available = true;
                if !active(&snapshot.phase) { snapshot.backend = engine::backend(&runtime.config).unwrap_or("trelis").into(); }
            },
            Err(error) => { snapshot.available = false; if snapshot.message.is_none() { snapshot.message = Some(error); } }
        }
        #[cfg(windows)]
        if let Some(hotkeys) = self.0.hotkeys.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            let status = hotkeys.status();
            for (binding, actual) in [(&mut snapshot.shortcuts.fallback, status.fallback), (&mut snapshot.shortcuts.copilot, status.copilot)] {
                binding.registered = actual.registered; binding.observed = actual.observed;
                binding.error = actual.error_code.map(|_| "This shortcut is reserved or already in use.".into());
            }
        }
        snapshot
    }
    fn update(&self, id: &str, edit: impl FnOnce(&mut Snapshot)) {
        let snapshot = {
            let mut inner = self.0.inner.lock().unwrap_or_else(|p| p.into_inner());
            if inner.snapshot.session_id.as_deref() != Some(id) { return; }
            edit(&mut inner.snapshot); inner.snapshot.clone()
        };
        let _ = self.0.app.emit_to("dictation", "dictation-status", &snapshot);
        let _ = self.0.app.emit_to("main", "dictation-status", &snapshot);
    }
    fn phase(&self, id: &str, phase: &str, message: Option<String>) {
        self.update(id, |s| { s.phase = phase.into(); s.message = message; s.level = 0.0; });
        self.repaint(id, None);
    }
    fn repaint(&self, id: &str, target: Option<Target>) {
        let this = self.clone(); let id = id.to_owned();
        let _ = self.0.app.run_on_main_thread(move || { let _ = this.paint(&id, target.as_ref()); });
    }
    /// Only called on the window's UI thread. ShowWindow(SW_SHOWNOACTIVATE)
    /// preserves the target app's keyboard focus even when controls are clicked.
    fn paint(&self, id: &str, target: Option<&Target>) -> Result<(), String> {
        if self.0.closing.load(Ordering::Acquire) { return Ok(()); }
        let s = self.0.inner.lock().map_err(|e| e.to_string())?.snapshot.clone();
        if s.session_id.as_deref() != Some(id) { return Ok(()); }
        if s.phase == "idle" {
            self.0.popup.lock().map_err(|_| "Popup placement is unavailable.")?.cancel();
            if let Some(window) = self.0.app.get_webview_window("dictation") {
                #[cfg(windows)] windows::hide_overlay(window.hwnd().map_err(|e| e.to_string())?.0 as usize)?;
                #[cfg(not(windows))] let _ = window.hide();
            }
            return Ok(());
        }
        let window = self.prepare_overlay()?;
        self.position_overlay(&window, &s, target)?;
        #[cfg(windows)] {
            let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
            windows::show_nonactivating(hwnd)?;
        }
        Ok(())
    }
    fn position_overlay(&self, window: &tauri::WebviewWindow, snapshot: &Snapshot, target: Option<&Target>) -> Result<(), String> {
        let mut placement = self.0.popup.lock().map_err(|_| "Popup placement is unavailable.")?;
        placement.session(&snapshot.session_id);
        #[cfg(windows)] {
            let ((left, top, right, bottom), scale) = windows::overlay_display(target, placement.anchor.map(|point| (point.x, point.y)))?;
            let rect = placement.place(placement::Work { left, top, right, bottom }, scale, matches!(snapshot.phase.as_str(), "ready" | "error"))?;
            windows::place_overlay(window.hwnd().map_err(|e| e.to_string())?.0 as usize,
                rect.origin.x, rect.origin.y, rect.width, rect.height)?;
        }
        #[cfg(not(windows))] { let _ = (window, target); }
        Ok(())
    }
    async fn show_before_capture(&self, id: &str, target: Option<Target>) -> Result<(), String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let this = self.clone(); let id = id.to_owned();
        self.0.app.run_on_main_thread(move || { let _ = tx.send(this.paint(&id, target.as_ref())); }).map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "The dictation indicator could not open.".to_owned())?
    }
    async fn toggle(&self, expected: Option<Option<String>>, target: Option<Target>) -> Result<Snapshot, String> {
        crate::local_transcription::prioritize_user_work();
        // Same lock as both recording entry points, including the tray recorder.
        let _capture_lock = crate::audio::recording_commands::CAPTURE_START_LOCK.lock().await;
        if self.0.closing.load(Ordering::Acquire) { return Err("oats is closing.".into()); }
        {
            let inner = self.0.inner.lock().map_err(|e| e.to_string())?;
            if let Some(expected) = &expected { same_session(&inner.snapshot, expected)?; }
            if active(&inner.snapshot.phase) {
                if let Some(control) = &inner.control { let _ = control.commands.send(capture::CaptureCommand::Stop); }
                return Ok(inner.snapshot.clone());
            }
        }
        if crate::audio::recording_commands::is_recording().await { return Err("Finish the meeting recording before starting dictation.".into()); }
        let _update_start = crate::updates::start_lease()?;
        let runtime = runtime(&self.0.app)?;
        crate::local_transcription::reserve_for_dictation()?;
        let claim = BusyGuard;
        let id = uuid::Uuid::new_v4().to_string();
        let (commands, receiver) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut inner = self.0.inner.lock().map_err(|e| e.to_string())?;
            let shortcuts = inner.snapshot.shortcuts.clone();
            inner.snapshot = Snapshot { phase: "starting".into(), session_id: Some(id.clone()), shortcuts,
                backend: engine::backend(&runtime.config)?.into(), ..Snapshot::default() };
            inner.control = Some(Control { commands, cancelled: cancelled.clone() });
        }
        if let Err(error) = self.show_before_capture(&id, target.clone()).await {
            self.finish(&id, Outcome::Error(error.clone())); return Err(error);
        }
        // Publish the child owner under the lock used by shutdown. Once closing
        // starts, every spawned worker must be visible to (and joined by) exit.
        let mut worker_slot = self.0.worker.lock().map_err(|e| e.to_string())?;
        if self.0.closing.load(Ordering::Acquire) { return Err("oats is closing.".into()); }
        let this = self.clone(); let worker_id = id.clone();
        let worker = thread::Builder::new().name("dictation-capture".into()).spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                this.run_session(&worker_id, runtime, receiver, cancelled, target)
            })).unwrap_or_else(|_| Outcome::Error("Dictation stopped unexpectedly. Please try again.".into()));
            // Release exclusion only after CPAL has closed and the child is reaped.
            drop(claim);
            this.finish(&worker_id, outcome);
        });
        match worker {
            Ok(worker) => {
                let previous = worker_slot.replace(worker);
                drop(worker_slot);
                if let Some(previous) = previous { let _ = previous.join(); }
            }
            Err(error) => { self.finish(&id, Outcome::Error(format!("Could not start dictation: {error}"))); return Err(error.to_string()); }
        }
        Ok(self.snapshot())
    }
    fn run_session(&self, id: &str, runtime: Runtime, commands: mpsc::Receiver<capture::CaptureCommand>, cancelled: Arc<AtomicBool>, target: Option<Target>) -> Outcome {
        let mut engine_guard = SessionEngineGuard { keep: false };
        if cancelled.load(Ordering::Acquire) { return Outcome::Cancelled; }
        #[cfg(windows)]
        let popup = self.0.app.get_webview_window("dictation").and_then(|window| window.hwnd().ok()).map(|hwnd| hwnd.0 as usize);
        #[cfg(not(windows))]
        let popup = None;
        let delivery = Arc::new(Mutex::new(SessionDelivery::new(target, popup)));
        {
            let state = delivery.lock().unwrap_or_else(|p| p.into_inner());
            self.update(id, |s| {
                s.live_typing = state.ledger.blocked_reason().is_none();
                s.delivery_message = state.ledger.blocked_reason().map(str::to_owned);
            });
        }
        // Spawning is quick; model import/validation/compilation runs in the
        // child while the microphone is listening, instead of after Stop.
        if let Err(error) = prepare_engine(&runtime, &self.0.closing) { return Outcome::Error(error); }
        let decoding_cancelled = cancelled.clone();
        let decoding_id = id.to_owned();
        let live_delivery = delivery.clone();
        let live_cancelled = cancelled.clone();
        let live_owner = self.clone();
        let live_id = id.to_owned();
        let schedule = if engine::backend(&runtime.config).ok() == Some("faster_whisper") {
            pipeline::PreviewSchedule::streaming()
        } else { pipeline::PreviewSchedule::new() };
        let pipeline = match pipeline::Pipeline::start_stream(cancelled.clone(), move |wav, final_request| {
            transcribe(&decoding_id, wav, &decoding_cancelled, final_request)
        }, move |transcript, final_request| {
            let mut state = live_delivery.lock().unwrap_or_else(|p| p.into_inner());
            if live_cancelled.load(Ordering::Acquire) { return; }
            state.observe(&transcript.text, final_request, &live_cancelled);
            live_owner.update(&live_id, |s| {
                s.text = if transcript.text.trim().is_empty() { None } else { Some(transcript.text.clone()) };
                s.draft_text = if final_request { None } else { transcript.draft_text.clone().filter(|draft| !draft.trim().is_empty()) };
                s.inserted_characters = state.ledger.inserted_characters();
                s.live_typing = state.ledger.blocked_reason().is_none();
                s.delivery_message = state.ledger.blocked_reason().map(str::to_owned);
            });
        }) { Ok(pipeline) => pipeline, Err(error) => return Outcome::Error(error) };
        let began = Instant::now();
        let this = self.clone(); let capture_id = id.to_owned();
        let audio = capture::capture_progress_scheduled(None, commands, move |event| {
            match event {
                capture::CaptureEvent::Started { device_name, sample_rate: _ } => {
                    log::info!("Dictation microphone ready in {:.3}s", began.elapsed().as_secs_f64());
                    this.update(&capture_id, |s| { s.phase = "listening".into(); s.microphone = Some(device_name); });
                },
                capture::CaptureEvent::Level { elapsed_seconds, rms } => this.update(&capture_id, |s| { s.elapsed_seconds = elapsed_seconds; s.level = (rms * 8.0).clamp(0.0, 1.0); }),
            }
        }, || {
            pipeline.health()?;
            // Never stall audio draining while the decoder waits for hotkey
            // modifier release or submits a foreground input batch.
            if let Ok(mut state) = delivery.try_lock() {
                if state.ledger.blocked_reason().is_none() {
                    if let Some(reason) = state.interruption() {
                        state.ledger.interrupt(reason.clone());
                        self.update(id, |s| { s.live_typing = false; s.delivery_message = Some(reason); });
                    }
                }
            }
            Ok(())
        }, |rate, samples| pipeline.preview(|| capture::wav_bytes(rate, samples)), schedule);
        if cancelled.load(Ordering::Acquire) { return Outcome::Cancelled; }
        let audio = match audio { Ok(Some(audio)) => audio, Ok(None) => return Outcome::Cancelled, Err(error) => return Outcome::Error(error) };
        self.update(id, |s| s.elapsed_seconds = audio.duration_seconds);
        self.phase(id, "transcribing", Some("Finishing your last words…".into()));
        let stopped = Instant::now();
        let wav = match audio.wav_bytes() { Ok(wav) => wav, Err(error) => return Outcome::Error(error) };
        let text = match pipeline.finish(wav, Duration::from_secs(300)) {
            Ok(Some(text)) => text, Ok(None) => return Outcome::Cancelled,
            Err(error) => return Outcome::Error(error),
        };
        log::info!("Dictation stop-to-text {:.3}s for {:.3}s audio", stopped.elapsed().as_secs_f64(), audio.duration_seconds);
        if cancelled.load(Ordering::Acquire) { return Outcome::Cancelled; }
        engine_guard.keep = true;
        let state = delivery.lock().unwrap_or_else(|p| p.into_inner());
        if text.trim().is_empty() && state.ledger.inserted_characters() == 0 {
            return Outcome::Ready(None, "No speech was detected. Try again.".into());
        }
        if let Some(reason) = state.ledger.blocked_reason() {
            return Outcome::Ready(Some(text), format!("{reason} Any text already typed is kept. Review the full result before copying."));
        }
        Outcome::Inserted(text)
    }
    fn finish(&self, id: &str, outcome: Outcome) {
        let previous_text = {
            let inner = self.0.inner.lock().unwrap_or_else(|p| p.into_inner());
            if inner.snapshot.session_id.as_deref() != Some(id) { return; }
            inner.snapshot.text.clone()
        };
        let (phase, text, message, hide_after) = match outcome {
            Outcome::Inserted(text) => ("inserted", Some(text), Some("Text sent. A copy is kept in Settings → Dictation.".into()), Some(1400)),
            Outcome::Cancelled => ("cancelled", previous_text, Some("Dictation cancelled. Any words already typed are kept.".into()), Some(1800)),
            Outcome::Ready(text, message) => ("ready", text, Some(message), None),
            Outcome::Error(error) => ("error", previous_text, Some(format!("{error} Any words already typed are kept.")), None),
        };
        {
            let mut inner = self.0.inner.lock().unwrap_or_else(|p| p.into_inner());
            if inner.snapshot.session_id.as_deref() != Some(id) { return; }
            inner.control = None;
        }
        self.update(id, |s| { s.phase = phase.into(); s.text = text; s.draft_text = None; s.message = message; s.level = 0.0; s.live_typing = false; });
        self.repaint(id, None);
        if let Some(delay) = hide_after {
            let this = self.clone(); let id = id.to_owned();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                this.update(&id, |s| { s.phase = "idle".into(); });
                this.repaint(&id, None);
            });
        }
    }
    fn shortcut_error(&self, error: String) {
        // A failed start is visible but cannot replace an existing recording.
        let id = {
            let mut inner = self.0.inner.lock().unwrap_or_else(|p| p.into_inner());
            if active(&inner.snapshot.phase) { return; }
            let id = uuid::Uuid::new_v4().to_string();
            inner.snapshot.session_id = Some(id.clone()); id
        };
        self.finish(&id, Outcome::Error(error));
    }
}
enum Outcome { Inserted(String), Cancelled, Ready(Option<String>, String), Error(String) }

fn transcribe(session_id: &str, wav: &[u8], cancelled: &AtomicBool, final_request: bool) -> Result<Option<pipeline::Transcript>, String> {
    if cancelled.load(Ordering::Acquire) { return Ok(None); }
    let mut slot = ENGINE.lock().map_err(|e| e.to_string())?;
    let worker = slot.as_mut().ok_or("The dictation engine is unavailable. Please try again.")?;
    let result = worker.transcribe_live(&uuid::Uuid::new_v4().to_string(), wav, cancelled, Duration::from_secs(300), session_id, final_request);
    match result {
        Ok(Some(result)) => result["text"].as_str().map(|text| Some(pipeline::Transcript {
            text: text.to_owned(), draft_text: result.get("draft_text").and_then(Value::as_str).map(str::to_owned),
        }))
            .ok_or_else(|| "The local dictation result has no text.".into()),
        other => { slot.take(); other.map(|_| None) }
    }
}

pub fn start(app: &tauri::AppHandle) {
    let anchor = popup_preferences(app).ok().and_then(|path| placement::load(&path).ok()).flatten();
    let this = Dictation(Arc::new(Service { app: app.clone(), inner: Mutex::new(Inner { snapshot: Snapshot::default(), control: None }),
        popup: Mutex::new(placement::State::new(anchor)),
        worker: Mutex::new(None), closing: AtomicBool::new(false), #[cfg(windows)] hotkeys: Mutex::new(None) }));
    app.manage(this.clone());
    // Preparation is outside the shortcut path. The child owns no microphone
    // and captures nothing until the user explicitly starts dictation.
    let preparation = this.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if preparation.0.closing.load(Ordering::Acquire) { return; }
        let overlay = preparation.clone();
        let _ = preparation.0.app.run_on_main_thread(move || {
            if let Err(error) = overlay.prepare_overlay() { log::debug!("Dictation indicator preparation: {error}"); }
        });
        // A meeting takes priority. Do not queue a warmup behind active work.
        if let Ok(_capture_gate) = crate::audio::recording_commands::CAPTURE_START_LOCK.try_lock() {
            if !crate::audio::recording_commands::capture_in_progress() && !preparation.0.closing.load(Ordering::Acquire) {
                if let Ok(runtime) = runtime(&preparation.0.app) {
                    let owner = preparation.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        let result = crate::local_transcription::prepare_idle_dictation(|| prepare_engine(&runtime, &owner.0.closing));
                        if let Err(error) = result { log::debug!("Dictation warmup: {error}"); }
                    }).await;
                }
            }
        }
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if preparation.0.closing.load(Ordering::Acquire) { break; }
            let _ = tokio::task::spawn_blocking(expire_idle_model).await;
        }
    });
    #[cfg(windows)] {
        let callback = this.clone();
        match windows::Hotkeys::start(move || {
            // Snapshot synchronously on the WM_HOTKEY thread before opening UI.
            let target = windows::snapshot_target().ok();
            let this = callback.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = this.toggle(None, target).await { this.shortcut_error(error); }
            });
        }) {
            Ok(guard) => *this.0.hotkeys.lock().unwrap_or_else(|p| p.into_inner()) = Some(guard),
            Err(error) => { let mut inner = this.0.inner.lock().unwrap_or_else(|p| p.into_inner());
                inner.snapshot.shortcuts.fallback.error = Some(error.clone()); inner.snapshot.shortcuts.copilot.error = Some(error); }
        }
    }
}
pub fn shutdown(app: &tauri::AppHandle) {
    let Some(this) = app.try_state::<Dictation>() else { return; };
    this.0.closing.store(true, Ordering::Release);
    if let Some(control) = &this.0.inner.lock().unwrap_or_else(|p| p.into_inner()).control {
        control.cancelled.store(true, Ordering::Release); let _ = control.commands.send(capture::CaptureCommand::Cancel);
    }
    #[cfg(windows)] { this.0.hotkeys.lock().unwrap_or_else(|p| p.into_inner()).take(); }
    let worker = { this.0.worker.lock().unwrap_or_else(|p| p.into_inner()).take() };
    if let Some(worker) = worker { let _ = worker.join(); }
    discard_engine();
}

#[tauri::command]
pub fn dictation_status(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Snapshot, String> { allowed(&window)?; Ok(service(&app).snapshot()) }

fn popup_preferences(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|path| path.join("dictation-placement.json")).map_err(|_| "Popup preferences are unavailable.".into())
}
fn popup_caller(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "dictation" { Ok(()) } else { Err("Only the dictation popup can move or resize itself.".into()) }
}
async fn popup_ui(app: tauri::AppHandle, edit: impl FnOnce(Dictation) -> Result<(), String> + Send + 'static) -> Result<(), String> {
    let owner = service(&app); let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = tx.send(edit(owner)); }).map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "The popup could not update its position.".to_owned())?
}
#[tauri::command]
pub async fn dictation_popup_layout(app: tauri::AppHandle, window: tauri::WebviewWindow, session_id: Option<String>, expanded: bool) -> Result<(), String> {
    popup_caller(&window)?;
    popup_ui(app, move |owner| {
        let snapshot = owner.0.inner.lock().map_err(|_| "Dictation status is unavailable.")?.snapshot.clone();
        same_session(&snapshot, &session_id)?;
        { let mut state = owner.0.popup.lock().map_err(|_| "Popup placement is unavailable.")?;
            state.session(&session_id); state.expanded = expanded; }
        // Initial hidden-page layout must not choose the first session's monitor.
        if snapshot.phase == "idle" { return Ok(()); }
        let window = owner.0.app.get_webview_window("dictation").ok_or("The dictation popup is unavailable.")?;
        owner.position_overlay(&window, &snapshot, None)
    }).await
}
#[tauri::command]
pub async fn dictation_popup_drag(app: tauri::AppHandle, window: tauri::WebviewWindow, session_id: Option<String>, phase: String, delta_x: Option<f64>, delta_y: Option<f64>) -> Result<(), String> {
    popup_caller(&window)?;
    if !matches!(phase.as_str(), "start" | "move" | "end" | "cancel")
        || [delta_x, delta_y].iter().flatten().any(|value| !value.is_finite() || value.abs() > 1_000_000.0) {
        return Err("Invalid popup drag request.".into());
    }
    popup_ui(app, move |owner| {
        let snapshot = owner.0.inner.lock().map_err(|_| "Dictation status is unavailable.")?.snapshot.clone();
        same_session(&snapshot, &session_id)?;
        if phase == "cancel" { owner.0.popup.lock().map_err(|_| "Popup placement is unavailable.")?.cancel(); return Ok(()); }
        if snapshot.phase == "idle" { return Err("Open dictation before moving its popup.".into()); }
        #[cfg(windows)] {
            let (x, y) = windows::overlay_cursor()?;
            { let mut state = owner.0.popup.lock().map_err(|_| "Popup placement is unavailable.")?;
                state.session(&session_id);
                if phase == "start" { return state.begin(placement::Point { x, y }); }
                state.move_to(placement::Point { x, y })?;
            }
            let window = owner.0.app.get_webview_window("dictation").ok_or("The dictation popup is unavailable.")?;
            owner.position_overlay(&window, &snapshot, None)?;
            if phase == "end" {
                let point = owner.0.popup.lock().map_err(|_| "Popup placement is unavailable.")?.end()?;
                let _save = crate::updates::start_lease()?;
                placement::save(&popup_preferences(&owner.0.app)?, point)?;
            }
            Ok(())
        }
        #[cfg(not(windows))] { Err("Popup dragging is available on Windows.".into()) }
    }).await
}
#[tauri::command]
pub async fn dictation_toggle(app: tauri::AppHandle, window: tauri::WebviewWindow, session_id: Option<String>) -> Result<Snapshot, String> {
    allowed(&window)?; service(&app).toggle(Some(session_id), None).await
}
#[tauri::command]
pub fn dictation_cancel(app: tauri::AppHandle, window: tauri::WebviewWindow, session_id: Option<String>) -> Result<(), String> {
    allowed(&window)?; let this = service(&app);
    let inner = this.0.inner.lock().map_err(|e| e.to_string())?; same_session(&inner.snapshot, &session_id)?;
    if let Some(control) = &inner.control { control.cancelled.store(true, Ordering::Release); let _ = control.commands.send(capture::CaptureCommand::Cancel); }
    Ok(())
}
#[tauri::command]
pub fn dictation_dismiss(app: tauri::AppHandle, window: tauri::WebviewWindow, session_id: Option<String>) -> Result<(), String> {
    allowed(&window)?; let this = service(&app);
    let id = { let mut inner = this.0.inner.lock().map_err(|e| e.to_string())?; same_session(&inner.snapshot, &session_id)?;
        if active(&inner.snapshot.phase) { return Err("Stop or cancel dictation first.".into()); }
        inner.snapshot.text = None; inner.snapshot.message = None; inner.snapshot.phase = "idle".into(); inner.snapshot.session_id.clone() };
    if let Some(id) = id { this.repaint(&id, None); } Ok(())
}
#[tauri::command]
pub fn dictation_copy(app: tauri::AppHandle, window: tauri::WebviewWindow, session_id: Option<String>) -> Result<(), String> {
    allowed(&window)?; let this = service(&app);
    let (id, text) = { let inner = this.0.inner.lock().map_err(|e| e.to_string())?; same_session(&inner.snapshot, &session_id)?;
        (inner.snapshot.session_id.clone().ok_or("No dictation to copy.")?, inner.snapshot.text.clone().ok_or("No dictation to copy.")?) };
    #[cfg(windows)] windows::copy_text(&text)?;
    #[cfg(not(windows))] { let _ = text; return Err("Dictation copy is available on Windows.".into()); }
    this.update(&id, |s| s.message = Some("Copied. Paste it wherever you need it.".into())); Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn stale_controls_cannot_change_a_new_session() {
        let s = Snapshot { session_id: Some("new".into()), ..Snapshot::default() };
        assert!(same_session(&s, &Some("old".into())).is_err()); assert!(same_session(&s, &None).is_err());
        assert!(same_session(&s, &Some("new".into())).is_ok());
    }
    #[test] fn only_capture_and_processing_phases_are_active() {
        for phase in ["starting", "listening", "transcribing"] { assert!(active(phase)); }
        for phase in ["idle", "ready", "inserted", "cancelled", "error"] { assert!(!active(phase)); }
    }
}
