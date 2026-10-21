//! Signed GitHub updates through main-window commands only. Downloads never
//! trigger installation. Native activity is checked again at installer handoff.
pub(crate) mod policy;
mod signature;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const ENDPOINT: &str = "https://github.com/Ripplescale/Oats_Transcription_Platform/releases/latest/download/latest.json";
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
static HANDOFF: Lazy<policy::HandoffGate> = Lazy::new(policy::HandoffGate::default);

/// Hold through a native recording/job/save start. The installer reservation
/// fails while this lease exists; new starts fail throughout installer handoff.
pub(crate) fn start_lease() -> Result<policy::StartLease, String> {
    HANDOFF.start()
}

fn public_key() -> Result<&'static str, String> {
    if !cfg!(windows) {
        return Err("In-app installation is available for the Windows release.".into());
    }
    let key = option_env!("OATS_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or("Updates are not configured in this build. A signed public release is required.")?;
    signature::decode_public_key(key)?;
    Ok(key)
}
fn verify_signature(bytes: &[u8], signature: &str, version: &str) -> Result<(), String> {
    signature::verify(bytes, signature, public_key()?, version)
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    state: String,
    current_version: String,
    configured: bool,
    version: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    blocked_reason: Option<String>,
}
struct Inner {
    status: Snapshot,
    candidate: Option<Update>,
    bytes: Option<Arc<Vec<u8>>>,
}
pub struct Service {
    inner: Mutex<Inner>,
    operation: Arc<tokio::sync::Mutex<()>>,
}
impl Service {
    fn snapshot(&self) -> Result<Snapshot, String> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| "Update status is unavailable.")?
            .status
            .clone())
    }
    fn change(
        &self,
        app: &tauri::AppHandle,
        edit: impl FnOnce(&mut Inner),
    ) -> Result<Snapshot, String> {
        let status = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Update status is unavailable.")?;
            edit(&mut inner);
            inner.status.clone()
        };
        let _ = app.emit_to("main", "updates-status", &status);
        Ok(status)
    }
}
pub fn init(app: &tauri::AppHandle) {
    let configuration = public_key();
    app.manage(Service {
        inner: Mutex::new(Inner {
            status: Snapshot {
                state: if configuration.is_ok() {
                    "idle"
                } else {
                    "unconfigured"
                }
                .into(),
                current_version: app.package_info().version.to_string(),
                configured: configuration.is_ok(),
                version: None,
                notes: None,
                published_at: None,
                downloaded_bytes: 0,
                total_bytes: None,
                error: configuration.err(),
                blocked_reason: None,
            },
            candidate: None,
            bytes: None,
        }),
        operation: Arc::new(tokio::sync::Mutex::new(())),
    });
}
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry, tauri_plugin_updater::Config> {
    // No updater permissions are granted to WebViews. Only commands below can
    // reach this plugin. Missing signing configuration remains visibly disabled.
    tauri_plugin_updater::Builder::new()
        .pubkey(option_env!("OATS_UPDATER_PUBLIC_KEY").unwrap_or(""))
        .build()
}
fn allowed(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("App updates can only be managed from the main window.".into())
    }
}
fn asset_allowed(update: &Update) -> bool {
    policy::approved_asset(update.download_url.as_str(), &update.version)
}

#[tauri::command]
pub fn updates_status(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Snapshot, String> {
    allowed(&window)?;
    app.state::<Service>().snapshot()
}

#[tauri::command]
pub async fn updates_check(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Snapshot, String> {
    allowed(&window)?;
    let service = app.state::<Service>();
    if public_key().is_err() {
        return service.snapshot();
    }
    let Ok(_operation) = service.operation.try_lock() else {
        return service.snapshot();
    };
    // A downloaded release remains explicitly installable until app exit.
    if service
        .inner
        .lock()
        .map_err(|_| "Update status is unavailable.")?
        .bytes
        .is_some()
    {
        return service.snapshot();
    }
    service.change(&app, |s| {
        s.status.state = "checking".into();
        s.status.error = None;
        s.status.blocked_reason = None;
    })?;
    let checked = async {
        let updater = app
            .updater_builder()
            .pubkey(public_key()?)
            .endpoints(vec![ENDPOINT
                .parse()
                .map_err(|_| "The update endpoint is invalid.")?])
            .map_err(|_| "The update endpoint is invalid.")?
            .timeout(Duration::from_secs(30))
            // Tauri's default hook hides windows/removes the tray before trying
            // ShellExecute. Preserve them if launch fails or UAC is cancelled.
            // The OS releases UI handles after the plugin confirms handoff/exits.
            .on_before_exit(crate::dictation::release_idle_model)
            .build()
            .map_err(|_| "The updater could not be initialized.")?;
        let candidate = updater
            .check()
            .await
            .map_err(|_| "Could not check GitHub for updates. Try again later.")?;
        if let Some(update) = &candidate {
            if !asset_allowed(update) || update.signature.is_empty() {
                return Err(
                    "The release does not contain an approved signed Windows installer.".into(),
                );
            }
        }
        Ok::<_, String>(candidate)
    }
    .await;
    service.change(&app, |inner| match checked {
        Ok(candidate) => {
            inner.status.state = if candidate.is_some() {
                "available"
            } else {
                "idle"
            }
            .into();
            inner.status.version = candidate.as_ref().map(|v| v.version.clone());
            inner.status.notes = candidate
                .as_ref()
                .and_then(|v| v.body.as_ref().map(|s| s.chars().take(20_000).collect()));
            inner.status.published_at = candidate
                .as_ref()
                .and_then(|v| v.date.map(|d| d.to_string()));
            inner.status.downloaded_bytes = 0;
            inner.status.total_bytes = None;
            inner.candidate = candidate;
        }
        Err(error) => {
            inner.status.state = "error".into();
            inner.status.error = Some(error.into());
            inner.candidate = None;
        }
    })
}

async fn download(app: &tauri::AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    // Bound memory before appending each chunk, then use the same Minisign
    // verification algorithm as the Tauri plugin. No unverified bytes reach install.
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(900))
        .user_agent("oats-updater")
        .build()
        .map_err(|_| "The update connection could not be initialized.")?;
    let mut response = client
        .get(update.download_url.clone())
        .send()
        .await
        .map_err(|_| "The update download failed. Your app was not changed.")?;
    if !response.status().is_success() {
        return Err("GitHub could not provide the update. Try again later.".into());
    }
    let total = response.content_length();
    policy::download_size(0, 0, total, MAX_DOWNLOAD)?;
    let mut bytes = Vec::new();
    let mut last_event = Instant::now();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The update download was interrupted. Try again.")?
    {
        let received = policy::download_size(bytes.len() as u64, chunk.len(), total, MAX_DOWNLOAD)?;
        bytes.extend_from_slice(&chunk);
        if last_event.elapsed() >= Duration::from_millis(150) {
            app.state::<Service>().change(app, |s| {
                s.status.downloaded_bytes = received;
                s.status.total_bytes = total;
            })?;
            last_event = Instant::now();
        }
    }
    if bytes.is_empty()
        || total
            .map(|value| value != bytes.len() as u64)
            .unwrap_or(false)
    {
        return Err("The update download is incomplete. Try again.".into());
    }
    verify_signature(&bytes, &update.signature, &update.version)?;
    Ok(bytes)
}

#[tauri::command]
pub async fn updates_download(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    version: String,
) -> Result<Snapshot, String> {
    allowed(&window)?;
    public_key()?;
    let service = app.state::<Service>();
    let _operation = service
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let candidate = {
        let inner = service
            .inner
            .lock()
            .map_err(|_| "Update status is unavailable.")?;
        policy::version_matches(&version, inner.status.version.as_deref(), true)?;
        if inner.bytes.is_some() {
            return Ok(inner.status.clone());
        }
        inner
            .candidate
            .clone()
            .ok_or("Check for updates before downloading.")?
    };
    if !asset_allowed(&candidate) {
        return Err("The release download is not approved.".into());
    }
    service.change(&app, |s| {
        s.status.state = "downloading".into();
        s.status.error = None;
        s.status.blocked_reason = None;
        s.status.downloaded_bytes = 0;
        s.status.total_bytes = None;
    })?;
    let result = download(&app, &candidate).await;
    service.change(&app, |s| match result {
        Ok(bytes) => {
            s.status.downloaded_bytes = bytes.len() as u64;
            s.status.total_bytes = Some(bytes.len() as u64);
            s.bytes = Some(Arc::new(bytes));
            s.status.state = "downloaded".into();
        }
        Err(error) => {
            s.bytes = None;
            s.status.state = "available".into();
            s.status.error = Some(error);
            s.status.downloaded_bytes = 0;
            s.status.total_bytes = None;
        }
    })
}

#[tauri::command]
pub async fn updates_install(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    version: String,
) -> Result<Snapshot, String> {
    allowed(&window)?;
    public_key()?;
    let service = app.state::<Service>();
    let operation = service
        .operation
        .clone()
        .try_lock_owned()
        .map_err(|_| "An update operation is already running.")?;
    let (candidate, bytes) = {
        let inner = service
            .inner
            .lock()
            .map_err(|_| "Update status is unavailable.")?;
        policy::version_matches(
            &version,
            inner.status.version.as_deref(),
            inner.bytes.is_some(),
        )?;
        (
            inner.candidate.clone().ok_or("Check for updates again.")?,
            inner.bytes.clone().ok_or("Download this update first.")?,
        )
    };
    let install_app = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _operation = operation;
        // Reservation precedes the checks and stays held until install returns
        // with an error or Windows exits. Racing starts cannot cross this point.
        let _handoff = HANDOFF.install()?;
        let _capture = crate::audio::recording_commands::CAPTURE_START_LOCK
            .try_lock()
            .map_err(|_| {
                "Recording or storage work is changing. Try installing again when it finishes."
            })?;
        policy::idle(policy::Activity {
            capture: crate::audio::recording_commands::capture_in_progress()
                || crate::audio::recording_commands::get_active_capture()?.is_some(),
            dictation: crate::dictation::is_busy(),
            local_jobs: crate::local_transcription::update_work_active()?,
            pending_dictation: crate::dictation::has_pending_result(&install_app)?,
        })?;
        let _external_workers =
            crate::storage_retention::all_worker_guards(&crate::local_workspace::data_root()?)
                .map_err(|_| {
                    "Local speech work still owns saved audio. Install after it finishes."
                })?;
        verify_signature(&bytes, &candidate.signature, &candidate.version)?;
        crate::local_workspace::preserve_data_root()?;
        install_app.state::<Service>().change(&install_app, |s| {
            s.status.state = "installing".into();
            s.status.blocked_reason = None;
            s.status.error = None;
        })?;
        candidate.install(bytes.as_slice()).map_err(|_| {
            "The installer could not start. Your downloaded update is still available.".to_owned()
        })
    })
    .await
    .unwrap_or_else(|_| {
        Err("The installer preparation stopped. The app was not intentionally closed.".to_owned())
    });
    match result {
        // Windows install exits, so success cannot normally return here.
        Ok(()) => service.snapshot(),
        Err(reason) => service.change(&app, |s| {
            s.status.state = "downloaded".into();
            s.status.blocked_reason = Some(reason);
        }),
    }
}
