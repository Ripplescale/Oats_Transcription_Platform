//! Isolated local STT jobs. Recorder health never depends on a model process.
use std::{collections::{HashMap, HashSet}, fs, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::Mutex};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::{local_workspace::{data_root, valid_id}, state::AppState};

#[path = "local_worker_policy.rs"]
mod worker_policy;
use worker_policy::{WorkerActivity, WorkerKind};

type WorkerChildren = HashMap<(WorkerKind, String), Child>;
static CHILDREN: Lazy<Mutex<WorkerChildren>> = Lazy::new(|| Mutex::new(HashMap::new()));
static JOB_START_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static RETENTION_JOBS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static RETENTION_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static RETENTION_REQUESTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn prioritize_user_work() {
    RETENTION_REQUESTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}
struct RetentionReservation;
impl Drop for RetentionReservation {
    fn drop(&mut self) { RETENTION_BUSY.store(false, std::sync::atomic::Ordering::SeqCst); }
}

fn schedule_completed_retention(id: String, session: String, speaker: bool) {
    let Ok(mut scheduled) = RETENTION_JOBS.lock() else { return; };
    if !scheduled.insert(id.clone()) { return; }
    drop(scheduled);
    let retry_id = id.clone();
    let generation = RETENTION_REQUESTS.load(std::sync::atomic::Ordering::SeqCst);
    let spawned = std::thread::Builder::new().name("recording-retention".into()).spawn(move || {
        // Allow the automatic post-transcription speaker pass to launch first.
        std::thread::sleep(std::time::Duration::from_secs(15));
        // Keep archive I/O off the command/UI thread. Both gates are also used
        // by capture/recovery and worker launch, in this same acquisition order.
        let result = (|| -> Result<bool, String> {
            let cancelled = || RETENTION_REQUESTS.load(std::sync::atomic::Ordering::SeqCst) != generation;
            if cancelled() { return Ok(false); }
            let Ok(_capture) = crate::audio::recording_commands::CAPTURE_START_LOCK.try_lock() else { return Ok(false); };
            if crate::audio::recording_commands::capture_in_progress() || crate::dictation::is_busy() { return Ok(false); }
            let Ok(mut children) = CHILDREN.try_lock() else { return Ok(false); };
            if worker_activity(&mut children).map_err(|e|e.to_string())?.any_live() { return Ok(false); }
            RETENTION_BUSY.store(true, std::sync::atomic::Ordering::SeqCst);
            let _reservation = RetentionReservation;
            drop(children); // Status reads remain responsive during archive I/O.
            let dir = if speaker { speaker_dir(&id)? } else { job_dir(&id)? };
            if read(&dir.join("status.json"))?["state"] != "complete" { return Ok(false); }
            let (source, _) = capture_session(&session)?;
            let guards = crate::storage_retention::all_worker_guards(&data_root()?).map_err(|e|e.to_string())?;
            crate::audio::source_archive::compact_with_cancel(&source, cancelled).map_err(|e|e.to_string())?;
            drop(guards);
            // A speaker pass may have occupied the earlier ASR cleanup slot.
            // Reclaim completed ASR windows for this source together.
            for entry in fs::read_dir(data_root()?.join("jobs")).map_err(|e|e.to_string())? {
                let job = entry.map_err(|e|e.to_string())?.path();
                let request = read(&job.join("request.json"))?;
                if request["session_dir"].as_str().map(|s| path_key(s) == path_key(&session)).unwrap_or(false) {
                    crate::storage_retention::prune_completed_windows(&job).map_err(|e|e.to_string())?;
                }
            }
            Ok(true)
        })();
        match result {
            Ok(true) => {},
            Ok(false) => {
                // The next ordinary status poll can retry after active work.
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Ok(mut jobs) = RETENTION_JOBS.lock() { jobs.remove(&id); }
            },
            Err(error) => {
                log::warn!("Retained source/cache files for {id}: {error}");
                std::thread::sleep(std::time::Duration::from_secs(60));
                if let Ok(mut jobs) = RETENTION_JOBS.lock() { jobs.remove(&id); }
            },
        }
    });
    if spawned.is_err() { if let Ok(mut jobs) = RETENTION_JOBS.lock() { jobs.remove(&retry_id); } }
}

pub fn profile_parts(profile: &str) -> Result<(&'static str, u32), String> {
    match profile {
        "apex-20" => Ok(("apex",20)),
        "trelis-5" => Ok(("trelis",5)),
        "trelis-10" => Ok(("trelis",10)),
        "trelis-20" => Ok(("trelis",20)),
        _ => Err("Choose Trelis 5s, 10s or 20s, or Apex 20s".into()),
    }
}

fn read(path: &Path) -> Result<Value, String> {
    // Windows can briefly deny a reader while Python atomically replaces a
    // checkpoint. Retry that sharing conflict; malformed data still fails.
    for attempt in 0..4 {
        match fs::read(path) {
            Ok(bytes)=>return serde_json::from_slice(&bytes).map_err(|e|e.to_string()),
            Err(error) if attempt<3 && (error.kind()==std::io::ErrorKind::PermissionDenied || error.raw_os_error()==Some(32)) => {
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            Err(error)=>return Err(error.to_string()),
        }
    }
    unreachable!()
}
fn config_path() -> Result<PathBuf, String> { Ok(data_root()?.join("runtime.json")) }
fn job_dir(id: &str) -> Result<PathBuf, String> { valid_id(id)?; Ok(data_root()?.join("jobs").join(id)) }

fn path_key(path: &str) -> String {
    let normalized=Path::new(path).canonicalize().unwrap_or_else(|_|PathBuf::from(path));
    let text=normalized.to_string_lossy().replace('/',"\\");
    #[cfg(target_os="windows")]
    { return text.strip_prefix("\\\\?\\").unwrap_or(&text).to_lowercase(); }
    #[cfg(not(target_os="windows"))]
    { text }
}

#[tauri::command]
pub fn get_local_stt_profiles() -> Result<Vec<Value>, String> {
    let config = config_path().and_then(|p| read(&p)).ok();
    Ok(local_stt_profiles(config.as_ref()))
}

fn local_stt_profiles(config: Option<&Value>) -> Vec<Value> {
    // The declared UI choices stay fixed; an older installed worker can offer
    // only the subset admitted by its own immutable registry.
    let registry = config.and_then(runtime_registry);
    ["trelis-5","trelis-10","trelis-20","apex-20"].iter().map(|id| {
        let (model,seconds) = profile_parts(id).unwrap();
        let accelerated = config.map(|c| c["models"][model]["backend"] == "openvino"
            && c["models"][model]["device"] == "GPU"
            && c["models"][model]["export_path"].as_str().map(|p|Path::new(p).join("conversion-provenance.json").is_file()).unwrap_or(false)).unwrap_or(false);
        let configured = config.map(|c| ["python_executable","worker_script","registry_path"].iter()
            .all(|key| c[key].as_str().map(|p| Path::new(p).is_file()).unwrap_or(false))
            && c["models"][model]["artifact_path"].as_str().map(|p| Path::new(p).exists()).unwrap_or(false)).unwrap_or(false);
        let supported = registry_supports_profile(registry.as_ref(), id);
        let available = configured && supported;
        let model_name = if model=="trelis" {"Trelis"} else {"Apex"};
        let reason = if !configured {"Local runtime needs setup (STTApp/runtime.json)".to_owned()}
            else if !supported {format!("Local worker needs setup or an update for {model_name} {seconds}s. Update the local STT runtime.")}
            else if model=="apex" {"Available as a separate fallback transcript".to_owned()}
            else if accelerated {format!("Local GPU runtime configured; {seconds}-second audio windows plus processing time")}
            else {"GPU setup is needed for Trelis live transcription; Apex fallback is available".to_owned()};
        json!({"id":id,"model":model,"chunk_seconds":seconds,"available":available,
            "reason":reason,
            "language_modes":["hinglish","english"],"live_qualified":false,
            "backend":config.map(|c|c["models"][model]["backend"].clone()),
            "live_replay_supported":model=="apex" || accelerated,"recommended_timing":if model=="apex" || accelerated {"during-recording"} else {"after-recording"}})
    }).collect()
}

fn runtime_registry(config: &Value) -> Option<Value> {
    config["registry_path"].as_str().and_then(|path| read(Path::new(path)).ok())
}

fn registry_supports_profile(registry: Option<&Value>, profile: &str) -> bool {
    let (model, seconds) = match profile_parts(profile) { Ok(parts) => parts, Err(_) => return false };
    registry.and_then(|registry| registry["application_profiles"][model].as_array())
        .map(|durations| durations.iter().any(|duration| duration.as_u64() == Some(seconds.into())))
        .unwrap_or(false)
}

fn require_runtime_profile(config: &Value, profile: &str) -> Result<(), String> {
    let (model, seconds) = profile_parts(profile)?;
    if registry_supports_profile(runtime_registry(config).as_ref(), profile) { return Ok(()); }
    let model_name = if model=="trelis" {"Trelis"} else {"Apex"};
    Err(format!("The local worker needs setup or an update for {model_name} {seconds}s. Update the local STT runtime before starting this chunk size; saved recordings and existing jobs are preserved."))
}

fn capture_session(directory: &str) -> Result<(PathBuf, Value), String> {
    let root = data_root()?.join("recordings").canonicalize().map_err(|e|e.to_string())?;
    let path = PathBuf::from(directory).canonicalize().map_err(|e|e.to_string())?;
    if path.parent() != Some(root.as_path()) || !path.join("timeline.jsonl").is_file() {
        return Err("Choose a local source recording session".into());
    }
    let session = read(&path.join("session.json"))?;
    let id = session["session_id"].as_str().ok_or("Capture session ID is missing")?;
    uuid::Uuid::parse_str(id).map_err(|_|"Invalid capture session ID")?;
    if path.file_name().and_then(|v|v.to_str()) != Some(id) { return Err("Capture directory does not match its session ID".into()); }
    Ok((path,session))
}

#[tauri::command]
pub async fn ensure_capture_meeting(state: tauri::State<'_,AppState>, session_dir: String) -> Result<Value,String> {
    let (path,session) = capture_session(&session_dir)?;
    // Reuse a previous recovery/import of this recording rather than duplicating it.
    let existing: Vec<(String,String,String)> = sqlx::query_as("SELECT id,title,folder_path FROM meetings WHERE folder_path IS NOT NULL ORDER BY created_at,id")
        .fetch_all(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    let key=path_key(&path.to_string_lossy());
    if let Some((id,title,_))=existing.into_iter().find(|(_,_,folder)|path_key(folder)==key) {
        return Ok(json!({"meeting_id":id,"title":title}));
    }
    let id=format!("meeting-capture-{}",session["session_id"].as_str().unwrap());
    let title=session["meeting_name"].as_str().filter(|s|!s.trim().is_empty()).unwrap_or("Recorded meeting");
    let now=chrono::Utc::now();
    sqlx::query("INSERT OR IGNORE INTO meetings(id,title,created_at,updated_at,folder_path) VALUES(?,?,?,?,?)")
        .bind(&id).bind(title).bind(now).bind(now).bind(path.to_string_lossy().as_ref())
        .execute(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    Ok(json!({"meeting_id":id,"title":title}))
}

fn launch(id: &str) -> Result<(), String> {
    let dir = job_dir(id)?;
    let candidate = crate::bundled_asr_runtime::candidate_config(&dir, &config_path()?)?;
    let snapshot = ensure_job_runtime_snapshot(&dir, &candidate)?;
    launch_process(WorkerKind::Transcription, id, &snapshot, &dir)
}

fn validate_asr_runtime(config: &Value) -> Result<(), String> {
    for key in ["python_executable", "worker_script", "registry_path"] {
        let value = config[key].as_str().filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("ASR runtime is missing {key}"))?;
        let path = Path::new(value);
        if !path.is_absolute() || !path.is_file() {
            return Err(format!("ASR runtime {key} must refer to an existing absolute file"));
        }
    }
    if !config["models"].as_object().map(|models| !models.is_empty()).unwrap_or(false) {
        return Err("ASR runtime has no model configuration".into());
    }
    Ok(())
}

fn ensure_job_runtime_snapshot(dir: &Path, current_config: &Path) -> Result<PathBuf, String> {
    use std::io::Write;
    let snapshot = dir.join("runtime-snapshot.json");
    match fs::metadata(&snapshot) {
        Ok(_) => {
            // An existing job always keeps its original Python, worker,
            // registry and decoding config, even after the global default changes.
            validate_asr_runtime(&read(&snapshot)?)?;
            return Ok(snapshot);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    match fs::metadata(dir.join("status.json")) {
        Ok(_) => return Err("This existing transcription job has no runtime snapshot. Restore its original runtime snapshot before retrying; the recording and transcript are preserved.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    // The installer migrates older jobs before replacing runtime.json. A
    // checkpoint without a migrated snapshot must never adopt today's engine.
    let bytes = fs::read(current_config).map_err(|e| e.to_string())?;
    let config: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    validate_asr_runtime(&config)?;
    let temporary = dir.join(format!(".runtime-snapshot-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        // Linking a complete sibling publishes atomically without replacing an
        // existing snapshot. Concurrent creators use the winner's exact bytes.
        match fs::hard_link(&temporary, &snapshot) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(format!("Could not publish the job runtime snapshot: {error}")),
        }
    })();
    let _ = fs::remove_file(&temporary);
    result?;
    validate_asr_runtime(&read(&snapshot)?)?;
    Ok(snapshot)
}

fn worker_activity(children: &mut WorkerChildren) -> Result<WorkerActivity, std::io::Error> {
    let mut activity = WorkerActivity::default();
    for ((kind, _), child) in children.iter_mut() {
        activity.observe_exit(*kind, child.try_wait()?.is_some());
    }
    Ok(activity)
}

fn launch_process(kind: WorkerKind, id: &str, config_file: &Path, dir: &Path) -> Result<(),String> {
    let _update_start = crate::updates::start_lease()?;
    let mut children = CHILDREN.lock().map_err(|e| e.to_string())?;
    if RETENTION_BUSY.load(std::sync::atomic::Ordering::SeqCst) { return Err("Finishing recording storage cleanup. Try again in a moment.".into()); }
    if crate::dictation::is_busy() { return Err("Finish or cancel dictation before starting local transcription.".into()); }
    if !worker_activity(&mut children).map_err(|e|e.to_string())?.admits(kind) {
        return Err(match kind {
            WorkerKind::Transcription => "A transcription job is already running. Finish or stop it before starting another transcript.",
            WorkerKind::Speaker => "Speaker labeling is already running. Wait for it to finish before starting another speaker job.",
        }.into());
    }
    crate::dictation::release_idle_model();
    // Jobs keep their immutable original Python worker. Restore the exact
    // committed WAV bytes so even workers predating archive support can resume.
    let request = read(&dir.join("request.json"))?;
    if kind == WorkerKind::Transcription {
        let session = request["session_dir"].as_str().ok_or("Missing source session")?;
        let (session, _) = capture_session(session)?;
        crate::audio::source_archive::restore(&session).map_err(|e|e.to_string())?;
    }
    let config = read(config_file)?;
    let python = config["python_executable"].as_str().ok_or("Missing local Python")?;
    let script = config["worker_script"].as_str().ok_or("Missing local worker")?;
    let log = fs::OpenOptions::new().create(true).append(true).open(dir.join("worker.log")).map_err(|e| e.to_string())?;
    let mut command = Command::new(python);
    command.args(["-B",script,"--config"]).arg(config_file).arg("--request").arg(dir.join("request.json"))
        .stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log))
        .env("HF_HUB_OFFLINE","1").env("TRANSFORMERS_OFFLINE","1").env("HF_HUB_DISABLE_TELEMETRY","1").env("DO_NOT_TRACK","1")
        .env("STTAPP_PARENT_PID",std::process::id().to_string());
    #[cfg(target_os="windows")]
    { use std::os::windows::process::CommandExt; command.creation_flags(worker_policy::windows_creation_flags(kind)); }
    let child = command.spawn().map_err(|e| format!("Local worker could not start: {e}"))?;
    children.insert((kind, id.into()), child);
    Ok(())
}

/// Claim dictation while holding the same lock used to launch every ASR/speaker
/// child, so a meeting job cannot race a dictation model into memory.
pub(crate) fn reserve_for_dictation() -> Result<(), String> {
    let mut children = CHILDREN.lock().map_err(|e| e.to_string())?;
    if worker_activity(&mut children).map_err(|e|e.to_string())?.any_live() {
        return Err("Wait for transcription and speaker labeling to finish before starting dictation.".into());
    }
    crate::dictation::try_claim()
}

/// Called under the updater handoff reservation, which excludes all new job
/// starts. Do not terminate or wait for a running worker to authorize an update.
pub(crate) fn update_work_active() -> Result<bool, String> {
    if RETENTION_BUSY.load(std::sync::atomic::Ordering::SeqCst) { return Ok(true); }
    let mut children = CHILDREN.try_lock().map_err(|_| "Local speech work is changing. Try installing again when it finishes.".to_owned())?;
    worker_activity(&mut children).map(|activity| activity.any_live())
        .map_err(|_| "Could not verify that local speech work has stopped.".to_owned())
}

/// The caller holds CAPTURE_START_LOCK. Keep background model preparation under
/// the worker launch lock so a meeting waits for the short process spawn, then
/// evicts the idle model, instead of seeing a false user-dictation reservation.
pub(crate) fn prepare_idle_dictation(prepare: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let _update_start = crate::updates::start_lease()?;
    let mut children = CHILDREN.try_lock().map_err(|_| "Local speech work is busy.".to_owned())?;
    if crate::dictation::is_busy() { return Err("Dictation is already active.".into()); }
    if worker_activity(&mut children).map_err(|e|e.to_string())?.any_live() {
        return Err("Local transcription or speaker labeling is already active.".into());
    }
    prepare()
}

fn speaker_dir(id: &str) -> Result<PathBuf,String> { valid_id(id)?; Ok(data_root()?.join("speaker-jobs").join(id)) }

#[tauri::command]
pub fn get_speaker_setup_status() -> Result<Value,String> {
    let configured=data_root()?.join("speaker-runtime.json");
    let config=read(&configured).ok();
    let available=config.as_ref().map(|c|["python_executable","worker_script"].iter()
        .all(|key|c[key].as_str().map(|p|Path::new(p).is_file()).unwrap_or(false))
        && c["model_path"].as_str().map(|p|Path::new(p).join("config.yaml").is_file()).unwrap_or(false)
        && c["model_revision"].as_str().map(|s|!s.is_empty()).unwrap_or(false)).unwrap_or(false);
    Ok(json!({"available":available,"model_id":"pyannote/speaker-diarization-community-1",
        "enabled":config.as_ref().map(|c|c["enabled"]!=false).unwrap_or(false),
        "reason":if available {"Local post-call speaker model configured"} else {"Enable Hugging Face model access and install the isolated local speaker runtime"},
        "access_url":"https://huggingface.co/pyannote/speaker-diarization-community-1","live_available":false}))
}

#[tauri::command]
pub async fn start_speaker_identification(state: tauri::State<'_,AppState>, transcription_job_id: String, meeting_id: String) -> Result<Value,String> {
    let _update_start = crate::updates::start_lease()?;
    prioritize_user_work();
    while RETENTION_BUSY.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    if get_speaker_setup_status()?["available"]!=true { return Err("The local speaker model needs setup".into()); }
    valid_id(&meeting_id)?;
    let transcript=get_local_transcription_status(transcription_job_id.clone())?;
    if transcript["state"]!="complete" { return Err("Speaker identification starts after final transcription".into()); }
    let folder: Option<String>=sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id=?").bind(&meeting_id)
        .fetch_one(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    if !folder.as_deref().zip(transcript["session_dir"].as_str()).map(|(a,b)|path_key(a)==path_key(b)).unwrap_or(false) {
        return Err("Speaker job and meeting refer to different recordings".into());
    }
    let id=format!("speakers-{transcription_job_id}");
    let dir=speaker_dir(&id)?;
    if dir.join("request.json").is_file() { return get_speaker_job_status(id); }
    fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let mut request=json!({"version":1,"job_id":id,"meeting_id":meeting_id,"session_dir":transcript["session_dir"],
        "transcription_job_id":transcription_job_id,"transcription_status_path":job_dir(&transcription_job_id)?.join("status.json"),
        "created_at":chrono::Utc::now().to_rfc3339()});
    if let Some(previous)=crate::local_workspace::previous_speaker_snapshot(&meeting_id)? {
        let snapshot=dir.join("previous-speakers.json");
        fs::write(&snapshot,serde_json::to_vec_pretty(&previous).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        request["previous_speakers_path"]=json!(snapshot);
    }
    fs::write(dir.join("request.json"),serde_json::to_vec_pretty(&request).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if let Err(error)=launch_process(WorkerKind::Speaker,&id,&data_root()?.join("speaker-runtime.json"),&dir) {
        // Keep the request for an explicit retry, with an actionable result.
        fs::write(dir.join("status.json"),serde_json::to_vec_pretty(&json!({"job_id":id,"state":"failed","error":error})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    }
    get_speaker_job_status(id)
}

#[tauri::command]
pub fn get_speaker_job_status(job_id: String) -> Result<Value,String> {
    let dir=speaker_dir(&job_id)?;
    let request=read(&dir.join("request.json"))?;
    let mut status=if dir.join("status.json").is_file() { read(&dir.join("status.json"))? } else { json!({"job_id":job_id,"state":"running"}) };
    let exited={
        let mut children=CHILDREN.lock().map_err(|e|e.to_string())?;
        match children.get_mut(&(WorkerKind::Speaker,job_id.clone())) { Some(child)=>child.try_wait().map_err(|e|e.to_string())?.is_some(),None=>true }
    };
    if exited && !["complete","failed","stopped"].contains(&status["state"].as_str().unwrap_or("")) {
        status["state"]="failed".into(); status["error"]="Speaker worker stopped. The recording and transcript are preserved; retry when ready.".into();
    }
    project_worker_lifecycle(&mut status, exited);
    if status["state"]=="complete" {
        let meeting=request["meeting_id"].as_str().ok_or("Speaker meeting ID missing")?;
        crate::local_workspace::set_speaker_metadata(meeting,&job_id,&status["result"])?;
        if let Some(session) = request["session_dir"].as_str() {
            schedule_completed_retention(job_id, session.to_owned(), true);
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn retry_speaker_identification(job_id: String) -> Result<Value,String> {
    let _update_start = crate::updates::start_lease()?;
    prioritize_user_work();
    while RETENTION_BUSY.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let status=get_speaker_job_status(job_id.clone())?;
    if !["failed","stopped"].contains(&status["state"].as_str().unwrap_or("")) { return Err("Only interrupted speaker jobs can retry".into()); }
    launch_process(WorkerKind::Speaker,&job_id,&data_root()?.join("speaker-runtime.json"),&speaker_dir(&job_id)?)?;
    Ok(json!({"job_id":job_id,"state":"running"}))
}

#[tauri::command]
pub async fn start_local_transcription(session_dir: String, profile: String, language_mode: String, project_id: Option<String>, workflow_role: Option<String>, final_profile: Option<String>) -> Result<Value, String> {
    let _update_start = crate::updates::start_lease()?;
    prioritize_user_work();
    while RETENTION_BUSY.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    tokio::task::spawn_blocking(move || {
        let _update_start = _update_start;
        start_local_transcription_inner(session_dir, profile, language_mode, project_id, workflow_role, final_profile)
    })
        .await.map_err(|e|e.to_string())?
}

fn start_local_transcription_inner(session_dir: String, profile: String, language_mode: String, project_id: Option<String>, workflow_role: Option<String>, final_profile: Option<String>) -> Result<Value, String> {
    let _start_guard = JOB_START_LOCK.lock().map_err(|e| e.to_string())?;
    profile_parts(&profile)?;
    validate_workflow_role(workflow_role.as_deref(), &profile)?;
    validate_final_profile(final_profile.as_deref())?;
    if !["hinglish","english"].contains(&language_mode.as_str()) { return Err("Choose a declared Hinglish or English decoder profile".into()); }
    if let Some(id) = &project_id { valid_id(id)?; }
    let (session,capture) = capture_session(&session_dir)?;
    // A duplicate stop/start event or reloaded UI must attach to the original
    // pass, not create another model output or overwrite its corrections.
    if let Some(role) = workflow_role.as_deref() {
        if let Some(existing) = find_workflow_job(&session.to_string_lossy(), role)? {
            return get_local_transcription_status(existing);
        }
        if role == "final" && !capture_ready_for_final(&session)? {
            return Err("Finalize or recover the saved recording before starting its final transcript".into());
        }
        if role == "live-final" {
            let config = read(&config_path()?)?;
            if config["models"]["trelis"]["backend"] != "openvino" || config["models"]["trelis"]["device"] != "GPU" {
                return Err("Trelis live transcription needs the local GPU runtime. Recording is preserved; use Apex fallback or finish GPU setup.".into());
            }
        }
    }
    // Check only new jobs against today's worker declaration. Existing jobs
    // resume with their original runtime snapshot rather than this registry.
    require_runtime_profile(&read(&config_path()?)?, &profile)?;
    let job_id = uuid::Uuid::new_v4().to_string();
    let dir = job_dir(&job_id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let request = json!({"version":1,"job_id":job_id,"session_dir":session.to_string_lossy(),"profile":profile,
        "language_mode":language_mode,"project_id":project_id,"workflow_role":workflow_role,"final_profile":final_profile,
        "capture_session_id":capture["session_id"],"created_at":chrono::Utc::now().to_rfc3339()});
    fs::write(dir.join("request.json"),serde_json::to_vec_pretty(&request).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    launch(&job_id)?;
    get_local_transcription_status(job_id)
}

fn capture_ready_for_final(session: &Path) -> Result<bool, String> {
    use sha2::{Digest, Sha256};
    let bytes = fs::read(session.join("timeline.jsonl")).map_err(|e| e.to_string())?;
    let committed = bytes.iter().rposition(|byte| *byte == b'\n').map(|last| &bytes[..=last]).unwrap_or(&[]);
    let records = committed.split(|byte| *byte == b'\n').filter_map(|line| serde_json::from_slice::<Value>(line).ok()).collect::<Vec<_>>();
    if records.iter().any(|entry| entry["kind"] == "capture_finalized") { return Ok(true); }
    // Recovery is a verified completion path too; a stale marker cannot finalize
    // audio whose capture journal has subsequently changed.
    let recovered = read(&session.join("recovery-verified.json")).unwrap_or(Value::Null);
    let metadata = read(&session.join("metadata.json")).unwrap_or(Value::Null);
    let final_time = records.iter().filter_map(|entry| match entry["kind"].as_str() {
        Some("audio_chunk") => entry["end_seconds"].as_f64(),
        Some("capture_stopped") => entry["at_seconds"].as_f64(),
        _ => None,
    }).fold(0.0f64, f64::max);
    let valid_duration = recovered["duration_seconds"].as_f64().map(|duration| duration.is_finite() && duration >= final_time).unwrap_or(false);
    Ok(metadata["status"] == "recovered" && valid_duration && recovered["verified"] == true
        && recovered["source_journal_sha256"] == format!("{:x}", Sha256::digest(&bytes)))
}

fn validate_workflow_role(role: Option<&str>, profile: &str) -> Result<(), String> {
    let (model, _) = profile_parts(profile)?;
    match role {
        None => Ok(()),
        Some("live-draft") if profile == "apex-20" => Ok(()),
        Some("final") | Some("live-final") if model == "trelis" => Ok(()),
        Some("fallback") if profile == "apex-20" => Ok(()),
        _ => Err("Use Trelis 5s, 10s or 20s for the transcript or Apex 20s for its fallback".into()),
    }
}

fn validate_final_profile(profile: Option<&str>) -> Result<(), String> {
    match profile {
        None => Ok(()),
        Some(profile) if profile_parts(profile).map(|(model, _)| model == "trelis").unwrap_or(false) => Ok(()),
        _ => Err("Choose Trelis 5s, 10s or 20s for the final transcript".into()),
    }
}

fn find_workflow_job(session: &str, role: &str) -> Result<Option<String>, String> {
    let root = data_root()?.join("jobs");
    if !root.is_dir() { return Ok(None); }
    let mut matches = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path.join("request.json").is_file() { continue; }
        let request = match read(&path.join("request.json")) {
            Ok(request) => request,
            Err(error) => { log::warn!("Ignoring unreadable old job request at {}: {error}", path.display()); continue; }
        };
        if request["workflow_role"] == role && request["session_dir"].as_str().map(|p| path_key(p) == path_key(session)).unwrap_or(false) {
            if let Some(id) = path.file_name().and_then(|v| v.to_str()) {
                valid_id(id)?;
                matches.push((request["created_at"].as_str().unwrap_or("").to_owned(), id.to_owned()));
            }
        }
    }
    matches.sort();
    Ok(matches.into_iter().next().map(|(_, id)| id))
}

#[tauri::command]
pub fn get_local_transcription_status(job_id: String) -> Result<Value, String> {
    let dir = job_dir(&job_id)?;
    let request = read(&dir.join("request.json"))?;
    // Keep a damaged old checkpoint inspectable instead of failing the entire
    // queue restore. Decide its state only after checking the owned process.
    let checkpoint = read_transcription_checkpoint(&dir);
    let mut children = CHILDREN.lock().map_err(|e| e.to_string())?;
    let exited = match children.get_mut(&(WorkerKind::Transcription,job_id.clone())) {
        Some(child) => child.try_wait().map_err(|e| e.to_string())?.is_some(),
        None => true,
    };
    let result = project_transcription_checkpoint(&job_id, &request, checkpoint, exited);
    drop(children);
    if exited && result["state"] == "complete" {
        if let Some(session) = request["session_dir"].as_str() {
            schedule_completed_retention(job_id, session.to_owned(), false);
        }
    }
    Ok(result)
}

fn read_transcription_checkpoint(dir: &Path) -> Result<Option<Value>, String> {
    let path = dir.join("status.json");
    match fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {},
    }
    let status = read(&path)?;
    if !status.is_object() || !status["segments"].is_array()
        || !["running", "waiting_for_audio", "complete", "failed", "stopped"].contains(&status["state"].as_str().unwrap_or("")) {
        return Err("Checkpoint is missing its state or transcript segments".into());
    }
    Ok(Some(status))
}

fn project_transcription_checkpoint(job_id: &str, request: &Value, checkpoint: Result<Option<Value>, String>, exited: bool) -> Value {
    let mut result = match checkpoint {
        Ok(Some(status)) => status,
        Ok(None) => json!({"job_id":job_id,"session_dir":request["session_dir"],"profile":request["profile"],"state":"running",
            "processed_audio_seconds":0,"available_audio_seconds":0,"backlog_seconds":0,"segments":[]}),
        Err(error) => {
            // This is a read-only projection, never a replacement checkpoint.
            // Omitting segments prevents synthetic empty text from replacing
            // an earlier imported transcript or its corrections.
            let message = if exited {
                "The saved transcript checkpoint could not be read. The recording and previously imported transcript are preserved. Start a new transcript from the recording; this checkpoint cannot resume."
            } else {
                "The transcript checkpoint could not be read while its worker is still running. Waiting for the worker to finish; saved audio and previously imported text are preserved."
            };
            json!({"job_id":job_id,"session_dir":request["session_dir"],"profile":request["profile"],
                "state":if exited {"failed"} else {"running"},"checkpoint_unreadable":true,
                "checkpoint_error":error,"error":message})
        },
    };
    if exited && ["running","waiting_for_audio"].contains(&result["state"].as_str().unwrap_or("")) {
        result["state"] = "failed".into();
        result["error"] = "Worker exited or the application restarted. Saved audio and completed results remain available; resume the job.".into();
    }
    project_worker_lifecycle(&mut result, exited);
    project_request_metadata(&mut result, &request);
    result
}

fn project_request_metadata(status: &mut Value, request: &Value) {
    for key in ["workflow_role", "capture_session_id", "language_mode", "created_at", "final_profile"] {
        status[key] = request[key].clone();
    }
}

fn project_worker_lifecycle(status: &mut Value, exited: bool) {
    // A durable terminal checkpoint precedes Python/model teardown. Keep the
    // queue occupied until that process releases its resources; otherwise the
    // next transcription or automatic speaker job can fail during this gap.
    if !exited && ["complete", "failed", "stopped"].contains(&status["state"].as_str().unwrap_or("")) {
        status["checkpoint_state"] = status["state"].clone();
        status["state"] = "running".into();
    }
}

#[tauri::command]
pub fn stop_local_transcription(job_id: String) -> Result<Value, String> {
    fs::write(job_dir(&job_id)?.join("stop.request"),b"stop after current inference").map_err(|e| e.to_string())?;
    Ok(json!({"job_id":job_id,"state":"stop_requested"}))
}

#[tauri::command]
pub async fn resume_local_transcription(job_id: String) -> Result<Value, String> {
    let _update_start = crate::updates::start_lease()?;
    prioritize_user_work();
    while RETENTION_BUSY.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    tokio::task::spawn_blocking(move || {
        let _update_start = _update_start;
        resume_local_transcription_inner(job_id)
    })
        .await.map_err(|e|e.to_string())?
}

fn resume_local_transcription_inner(job_id: String) -> Result<Value, String> {
    let status = get_local_transcription_status(job_id.clone())?;
    require_readable_transcription_checkpoint(&status)?;
    if !["failed","stopped"].contains(&status["state"].as_str().unwrap_or("")) { return Err("Only failed or stopped jobs can resume".into()); }
    let stop = job_dir(&job_id)?.join("stop.request");
    if stop.is_file() { fs::remove_file(stop).map_err(|e| e.to_string())?; }
    launch(&job_id)?;
    Ok(json!({"job_id":job_id,"state":"running"}))
}

#[tauri::command]
pub fn list_local_transcription_jobs(session_dir: Option<String>) -> Result<Vec<Value>,String> {
    let root = data_root()?.join("jobs");
    if !root.exists() { return Ok(vec![]); }
    let mut jobs = Vec::new();
    for item in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        if let Some(id) = path.file_name().and_then(|p| p.to_str()) {
            if path.join("request.json").is_file() {
                // Filter using the request before reading a potentially large
                // checkpoint, and isolate an unreadable old request to its job.
                let request = match read(&path.join("request.json")) {
                    Ok(request) => request,
                    Err(error) => { log::warn!("Ignoring unreadable old job request at {}: {error}", path.display()); continue; },
                };
                if !session_dir.as_ref().map(|s| request["session_dir"].as_str().map(|p|path_key(p)==path_key(s)).unwrap_or(false)).unwrap_or(true) { continue; }
                // An exit-probe failure must still fail closed rather than
                // hiding a worker whose resources could remain occupied.
                jobs.push(get_local_transcription_status(id.into())?);
            }
        }
    }
    Ok(jobs)
}

async fn has_transcript_bindings(state: &tauri::State<'_, AppState>) -> Result<bool, String> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='local_transcription_bindings'")
        .fetch_one(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    Ok(count > 0)
}

/// Durable navigation metadata. Automatic draft and fallback children are grouped out
/// of the sidebar; existing independent/experimental transcripts remain visible.
#[tauri::command]
pub async fn get_local_transcript_groups(state: tauri::State<'_, AppState>) -> Result<Vec<Value>, String> {
    if !has_transcript_bindings(&state).await? { return Ok(vec![]); }
    let bindings: Vec<(String,String,String)> = sqlx::query_as("SELECT job_id,meeting_id,source_meeting_id FROM local_transcription_bindings")
        .fetch_all(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    let mut groups = Vec::new();
    for (job, meeting, source) in bindings {
        if meeting == source { continue; }
        let request = job_dir(&job).and_then(|dir| read(&dir.join("request.json"))).unwrap_or(Value::Null);
        if request["workflow_role"] == "live-draft" || request["workflow_role"] == "fallback" {
            groups.push(json!({"meeting_id":meeting,"source_meeting_id":source,"workflow_role":request["workflow_role"]}));
        }
    }
    Ok(groups)
}

#[tauri::command]
pub async fn get_local_transcript_layers(state: tauri::State<'_, AppState>, meeting_id: String) -> Result<Value, String> {
    valid_id(&meeting_id)?;
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM meetings WHERE id=?").bind(&meeting_id)
        .fetch_one(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    if exists == 0 { return Err("Conversation not found".into()); }
    let bindings = has_transcript_bindings(&state).await?;
    let mut source = meeting_id.clone();
    if bindings {
        let mut visited = std::collections::HashSet::new();
        while visited.insert(source.clone()) {
            let parent: Option<String> = sqlx::query_scalar("SELECT source_meeting_id FROM local_transcription_bindings WHERE meeting_id=?")
                .bind(&source).fetch_optional(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
            match parent { Some(id) if id != source => source = id, _ => break }
        }
    }
    let rows: Vec<(String,String,Option<String>)> = if bindings {
        sqlx::query_as("WITH RECURSIVE related(id) AS (SELECT ? UNION SELECT b.meeting_id FROM local_transcription_bindings b JOIN related r ON b.source_meeting_id=r.id) SELECT m.id,m.title,b.job_id FROM meetings m JOIN related r ON m.id=r.id LEFT JOIN local_transcription_bindings b ON b.meeting_id=m.id ORDER BY m.created_at,m.id")
            .bind(&source).fetch_all(state.db_manager.pool()).await.map_err(|e| e.to_string())?
    } else {
        sqlx::query_as("SELECT id,title,NULL FROM meetings WHERE id=?")
            .bind(&source).fetch_all(state.db_manager.pool()).await.map_err(|e| e.to_string())?
    };
    let layers = rows.into_iter().map(|(id,title,job)| {
        let status = job.as_ref().and_then(|job| get_local_transcription_status(job.clone()).ok()).unwrap_or(Value::Null);
        json!({"meeting_id":id,"title":title,"profile":status["profile"],"workflow_role":status["workflow_role"],
            "job_id":job,"state":status["state"].as_str().unwrap_or(if job.is_some() { "unavailable" } else { "not_started" }),"primary":id == source})
    }).collect::<Vec<_>>();
    Ok(json!({"source_meeting_id":source,"layers":layers}))
}

#[tauri::command]
pub async fn import_local_transcription(state: tauri::State<'_,AppState>, job_id: String, meeting_id: String, primary: Option<bool>) -> Result<Value,String> {
    let status = get_local_transcription_status(job_id.clone())?;
    let imported=import_status(state.db_manager.pool(),&job_id,&meeting_id,primary.unwrap_or(false),&status).await?;
    if imported["stale_snapshot"]!=true {
        crate::local_workspace::set_job_metadata(imported["meeting_id"].as_str().unwrap(),
            imported["source_meeting_id"].as_str().unwrap(),&job_id,&status)?;
    }
    Ok(imported)
}

#[derive(Clone, Debug)]
struct CanonicalWindow { id:String, text:String, track:String, start:f64, end:f64, snapshot:Value }

fn owned_window(job:&str, value:&Value) -> Result<CanonicalWindow,String> {
    let id=value["id"].as_str().ok_or("Missing segment ID")?;
    valid_id(id)?;
    let suffix=id.strip_prefix(&format!("{job}-")).ok_or("Segment belongs to a different job")?;
    let track=value["source_track"].as_str().ok_or("Missing source track")?;
    if !["microphone","system"].contains(&track) || !suffix.starts_with(&format!("{track}-")) {
        return Err("Segment ID and source track do not match".into());
    }
    let text=value["text"].as_str().ok_or("Invalid raw transcript")?;
    let start=value["start_seconds"].as_f64().ok_or("Missing window time")?;
    let end=value["end_seconds"].as_f64().ok_or("Missing window time")?;
    if !start.is_finite() || !end.is_finite() || start<0. || end<=start { return Err("Invalid window times".into()); }
    Ok(CanonicalWindow{id:id.into(),text:text.into(),track:track.into(),start,end,snapshot:value.clone()})
}

fn canonical_windows(job:&str,status:&Value) -> Result<(Vec<CanonicalWindow>,Vec<CanonicalWindow>,Option<i64>,String),String> {
    valid_id(job)?;
    if status.get("job_id").is_some() && status["job_id"].as_str()!=Some(job) { return Err("Worker job identity changed".into()); }
    let revision=match status.get("segments_revision") {
        None=>None,
        Some(value)=>Some(value.as_u64().filter(|v|*v<=i64::MAX as u64).ok_or("Invalid segments revision")? as i64),
    };
    let active=status["segments"].as_array().ok_or("Worker segments missing")?.iter()
        .map(|value|owned_window(job,value)).collect::<Result<Vec<_>,_>>()?;
    let archive=match status.get("superseded_segments") {
        None=>Vec::new(),
        Some(value)=>value.as_array().ok_or("Invalid superseded segments")?.iter()
            .map(|value|owned_window(job,value)).collect::<Result<Vec<_>,_>>()?,
    };
    let mut ids=HashSet::new();
    for window in &active { if !ids.insert(window.id.clone()) { return Err("Duplicate active segment ID".into()); } }
    let mut ordered:Vec<_>=active.iter().collect();
    ordered.sort_by(|a,b|a.track.cmp(&b.track).then(a.start.total_cmp(&b.start)));
    for pair in ordered.windows(2) {
        if pair[0].track==pair[1].track && pair[1].start<pair[0].end-1e-9 {
            return Err("Active transcript windows overlap on the same track".into());
        }
    }
    let archived:HashMap<_,_>=archive.iter().map(|w|(w.id.as_str(),w.track.as_str())).collect();
    let all:HashMap<_,_>=active.iter().chain(archive.iter()).map(|w|(w.id.as_str(),w.track.as_str())).collect();
    for window in &active {
        if let Some(replaces)=window.snapshot.get("replaces_segment_ids") {
            let mut seen=HashSet::new();
            for id in replaces.as_array().ok_or("Invalid replaced segment IDs")? {
                let id=id.as_str().ok_or("Invalid replaced segment ID")?;
                if !seen.insert(id) || archived.get(id)!=Some(&window.track.as_str()) {
                    return Err("Replacement is missing its same-track archived source".into());
                }
            }
        }
    }
    for window in &archive {
        let by=window.snapshot["superseded_by"].as_array().filter(|by|!by.is_empty()).ok_or("Archive is missing its replacement edge")?;
        for id in by {
            if all.get(id.as_str().ok_or("Invalid replacement edge")?)!=Some(&window.track.as_str()) {
                return Err("Archived replacement belongs to another track or is missing".into());
            }
        }
        let at=window.snapshot["superseded_at_segments_revision"].as_u64().ok_or("Archive revision is missing")?;
        if revision.map(|r|at>r as u64).unwrap_or(true) { return Err("Archive revision exceeds active selection".into()); }
    }
    let mut fingerprint:Vec<_>=active.iter().map(|w|json!([w.id,w.text,w.track,w.start,w.end])).collect();
    fingerprint.sort_by(|a,b|a[0].as_str().cmp(&b[0].as_str()));
    let fingerprint=format!("{:x}",Sha256::digest(serde_json::to_vec(&fingerprint).map_err(|e|e.to_string())?));
    Ok((active,archive,revision,fingerprint))
}

async fn preserve_raw(tx:&mut sqlx::Transaction<'_,sqlx::Sqlite>,job:&str,meeting:&str,snapshot:&Value) -> Result<(),String> {
    let bytes=serde_json::to_vec(snapshot).map_err(|e|e.to_string())?;
    let hash=format!("{:x}",Sha256::digest(&bytes));
    sqlx::query("INSERT OR IGNORE INTO local_transcription_raw_history(job_id,meeting_id,segment_id,raw_text,audio_start_time,audio_end_time,snapshot_sha256,segment_snapshot,archived_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(job).bind(meeting).bind(snapshot["id"].as_str().ok_or("History segment ID missing")?)
        .bind(snapshot["text"].as_str().ok_or("History raw text missing")?)
        .bind(snapshot["start_seconds"].as_f64()).bind(snapshot["end_seconds"].as_f64())
        .bind(hash).bind(String::from_utf8(bytes).map_err(|e|e.to_string())?).bind(chrono::Utc::now().to_rfc3339())
        .execute(&mut **tx).await.map_err(|e|e.to_string())?;
    Ok(())
}

/// Pool-only import keeps replacement validation/history/upserts in one SQLite
/// transaction. Callers publish workspace metadata only after a nonstale import.
async fn import_status(pool:&sqlx::SqlitePool,job_id:&str,meeting_id:&str,primary:bool,status:&Value) -> Result<Value,String> {
    require_readable_transcription_checkpoint(status)?;
    valid_id(meeting_id)?;
    let (active,archive,revision,fingerprint)=canonical_windows(job_id,status)?;
    let title: String = sqlx::query_scalar("SELECT title FROM meetings WHERE id = ?").bind(&meeting_id)
        .fetch_one(pool).await.map_err(|e| e.to_string())?;
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?").bind(&meeting_id)
        .fetch_one(pool).await.map_err(|e|e.to_string())?;
    if !folder.as_deref().zip(status["session_dir"].as_str()).map(|(a,b)|path_key(a)==path_key(b)).unwrap_or(false) {
        return Err("The transcription job belongs to a different recording".into());
    }
    let profile = status["profile"].as_str().ok_or("Job profile missing")?;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("CREATE TABLE IF NOT EXISTS local_transcription_bindings (job_id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE, source_meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE)")
        .execute(&mut *tx).await.map_err(|e|e.to_string())?;
    let binding: Option<(String,String)> = sqlx::query_as("SELECT meeting_id,source_meeting_id FROM local_transcription_bindings WHERE job_id=?")
        .bind(&job_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
    let previously_bound=binding.is_some();
    let source_meeting_id=binding.as_ref().map(|(_,source)|source.clone()).unwrap_or_else(||meeting_id.to_owned());
    let child_id = if let Some((bound,_))=binding { bound } else if primary {
        let occupied: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM transcripts WHERE meeting_id=?) + (SELECT count(*) FROM local_transcription_bindings WHERE meeting_id=?)")
            .bind(&meeting_id).bind(&meeting_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
        if occupied>0 { return Err("This meeting already has a transcript. Import the new version as a separate comparison.".into()); }
        meeting_id.to_owned()
    } else { format!("meeting-local-{job_id}") };
    if !previously_bound && !primary {
        let occupied:i64=sqlx::query_scalar("SELECT count(*) FROM meetings WHERE id=?")
            .bind(&child_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
        if occupied>0 { return Err("The transcript target collides with an unbound meeting".into()); }
    }
    sqlx::query("CREATE TABLE IF NOT EXISTS local_transcription_imports(job_id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL,segments_revision INTEGER,selection_sha256 TEXT NOT NULL,worker_updated_at TEXT)")
        .execute(&mut *tx).await.map_err(|e|e.to_string())?;
    sqlx::query("CREATE TABLE IF NOT EXISTS local_transcription_raw_history(job_id TEXT NOT NULL,meeting_id TEXT NOT NULL,segment_id TEXT NOT NULL,raw_text TEXT NOT NULL,audio_start_time REAL,audio_end_time REAL,snapshot_sha256 TEXT NOT NULL,segment_snapshot TEXT NOT NULL,archived_at TEXT NOT NULL,PRIMARY KEY(job_id,meeting_id,segment_id,snapshot_sha256))")
        .execute(&mut *tx).await.map_err(|e|e.to_string())?;
    let previous:Option<(String,Option<i64>,String,Option<String>)>=sqlx::query_as("SELECT meeting_id,segments_revision,selection_sha256,worker_updated_at FROM local_transcription_imports WHERE job_id=?")
        .bind(job_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
    let updated=status["updated_at"].as_str();
    if let Some((bound,prior,prior_hash,prior_updated))=&previous {
        if bound!=&child_id { return Err("Import checkpoint belongs to another meeting".into()); }
        let stale=match (prior,revision) { (Some(_),None)=>true,(Some(a),Some(b))=>b<*a,_=>false }
            || (prior==&revision && prior_updated.as_deref().zip(updated).and_then(|(a,b)|Some((chrono::DateTime::parse_from_rfc3339(a).ok()?,chrono::DateTime::parse_from_rfc3339(b).ok()?)))
                .map(|(a,b)|b<a).unwrap_or(false));
        if stale { return Ok(json!({"meeting_id":child_id,"source_meeting_id":source_meeting_id,"imported_count":0,"stale_snapshot":true})); }
        if revision.is_some() && prior==&revision && prior_hash!=&fingerprint {
            return Err("Canonical transcript changed without a newer segments revision".into());
        }
    }
    // IDs are globally unique in transcripts; never ignore a collision in
    // another meeting even when the incoming segment happens to share its text.
    for window in active.iter().chain(archive.iter()) {
        let owner:Option<String>=sqlx::query_scalar("SELECT meeting_id FROM transcripts WHERE id=?")
            .bind(&window.id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
        if owner.as_deref().map(|owner|owner!=child_id).unwrap_or(false) { return Err("Segment ID collides with another meeting".into()); }
    }
    let active_ids:HashSet<_>=active.iter().map(|w|w.id.as_str()).collect();
    let archive_ids:HashSet<_>=archive.iter().map(|w|w.id.as_str()).collect();
    let existing:Vec<(String,String,String,Option<f64>,Option<f64>,Option<f64>)>=sqlx::query_as("SELECT id,transcript,timestamp,audio_start_time,audio_end_time,duration FROM transcripts WHERE meeting_id=? AND instr(id,?)=1")
        .bind(&child_id).bind(format!("{job_id}-")).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
    for (id,text,timestamp,start,end,duration) in &existing {
        if !active_ids.contains(id.as_str()) && !archive_ids.contains(id.as_str()) {
            if revision.is_none() { return Ok(json!({"meeting_id":child_id,"source_meeting_id":source_meeting_id,"imported_count":0,"stale_snapshot":true})); }
            return Err("Removed transcript segment is missing its archived snapshot".into());
        }
        let changed=active.iter().find(|w|&w.id==id).map(|w|&w.text!=text || Some(w.start)!=*start || Some(w.end)!=*end).unwrap_or(true);
        if changed {
            preserve_raw(&mut tx,job_id,&child_id,&json!({"id":id,"text":text,"timestamp":timestamp,
                "start_seconds":start,"end_seconds":end,"duration":duration,
                "source_track":id.strip_prefix(&format!("{job_id}-")).and_then(|suffix|suffix.split('-').next()),
                "history_origin":"database_before_replacement"})).await?;
        }
    }
    let now = chrono::Utc::now();
    sqlx::query("INSERT OR IGNORE INTO meetings(id,title,created_at,updated_at,folder_path) VALUES(?,?,?,?,?)")
        .bind(&child_id).bind(format!("{title} — {}", match status["workflow_role"].as_str() { Some("live-draft") => "Apex live draft", Some("fallback") => "Apex fallback", _ => profile })).bind(now).bind(now).bind(status["session_dir"].as_str())
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO local_transcription_bindings(job_id,meeting_id,source_meeting_id) VALUES(?,?,?) ON CONFLICT(job_id) DO NOTHING")
        .bind(&job_id).bind(&child_id).bind(&source_meeting_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
    for window in &archive { preserve_raw(&mut tx,job_id,&child_id,&window.snapshot).await?; }
    let mut removed=0;
    for id in &archive_ids {
        if !active_ids.contains(id) {
            removed+=sqlx::query("DELETE FROM transcripts WHERE meeting_id=? AND id=?")
                .bind(&child_id).bind(id).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
        }
    }
    let mut imported = 0;
    for window in &active {
        // New classifier-skip windows remain absent as before; an existing row
        // selected as empty still updates so stale text cannot survive.
        if window.text.is_empty() && !existing.iter().any(|row|row.0==window.id) { continue; }
        let done = sqlx::query("INSERT INTO transcripts(id,meeting_id,transcript,timestamp,audio_start_time,audio_end_time,duration) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET transcript=excluded.transcript,timestamp=excluded.timestamp,audio_start_time=excluded.audio_start_time,audio_end_time=excluded.audio_end_time,duration=excluded.duration WHERE transcripts.meeting_id=excluded.meeting_id AND (transcripts.transcript IS NOT excluded.transcript OR transcripts.audio_start_time IS NOT excluded.audio_start_time OR transcripts.audio_end_time IS NOT excluded.audio_end_time)")
            .bind(&window.id).bind(&child_id).bind(&window.text)
            .bind(format!("{:02}:{:02}",window.start as u64/60,window.start as u64%60)).bind(window.start).bind(window.end).bind(window.end-window.start)
            .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        imported += done.rows_affected();
    }
    sqlx::query("INSERT INTO local_transcription_imports(job_id,meeting_id,segments_revision,selection_sha256,worker_updated_at) VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET segments_revision=excluded.segments_revision,selection_sha256=excluded.selection_sha256,worker_updated_at=excluded.worker_updated_at WHERE local_transcription_imports.meeting_id=excluded.meeting_id")
        .bind(job_id).bind(&child_id).bind(revision).bind(fingerprint).bind(updated)
        .execute(&mut *tx).await.map_err(|e|e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(json!({"meeting_id":child_id,"source_meeting_id":source_meeting_id,"imported_count":imported,"removed_count":removed,"stale_snapshot":false,"segments_revision":revision}))
}

fn require_readable_transcription_checkpoint(status: &Value) -> Result<(), String> {
    if status["checkpoint_unreadable"] == true {
        return Err("The transcript checkpoint is unreadable. Saved audio and previously imported text are preserved; start a new transcript from the recording.".into());
    }
    Ok(())
}

pub(crate) async fn correction_source_matches(pool:&sqlx::SqlitePool,meeting:&str,id:&str,original:&str) -> Result<bool,String> {
    let current:Option<String>=sqlx::query_scalar("SELECT transcript FROM transcripts WHERE meeting_id=? AND id=?")
        .bind(meeting).bind(id).fetch_optional(pool).await.map_err(|e|e.to_string())?;
    if current.as_deref()==Some(original) { return Ok(true); }
    let history_exists:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='local_transcription_raw_history'")
        .fetch_one(pool).await.map_err(|e|e.to_string())?;
    if history_exists==0 { return Ok(false); }
    let found:i64=sqlx::query_scalar("SELECT count(*) FROM local_transcription_raw_history WHERE meeting_id=? AND segment_id=? AND raw_text=?")
        .bind(meeting).bind(id).bind(original).fetch_one(pool).await.map_err(|e|e.to_string())?;
    Ok(found>0)
}

fn claude_link(mode: &str, file: Option<&Path>) -> Result<String,String> {
    let mut url = url::Url::parse(match mode { "chat"=>"claude://claude.ai/new", "cowork"=>"claude://cowork/new", _=>return Err("Choose chat or cowork".into()) }).map_err(|e| e.to_string())?;
    if mode=="cowork" {
        url.query_pairs_mut().append_pair("q","Please review the attached meeting transcript. Prepare a refined English summary with decisions and action items, citing transcript times. Preserve uncertainty; do not invent owners, dates or quantities.")
            .append_pair("file",&file.ok_or("Missing transcript attachment")?.to_string_lossy());
    }
    Ok(url.into())
}

#[tauri::command]
pub fn open_claude_desktop(mode: String, transcript: String, title: String) -> Result<Value,String> {
    if transcript.trim().is_empty() || transcript.len()>20_000_000 { return Err("Transcript is empty or too large for this handoff".into()); }
    let attachment = if mode=="cowork" {
        let root=data_root()?.join("handoffs"); fs::create_dir_all(&root).map_err(|e|e.to_string())?;
        let path=root.join(format!("transcript-{}.txt",uuid::Uuid::new_v4()));
        fs::write(&path,format!("{title}\n\n{transcript}")).map_err(|e|e.to_string())?; Some(path)
    } else { None };
    let link=claude_link(&mode,attachment.as_deref())?;
    #[cfg(target_os="windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name="shell32")]
        extern "system" { fn ShellExecuteW(hwnd: *mut std::ffi::c_void, operation:*const u16,file:*const u16,params:*const u16,dir:*const u16,show:i32)->isize; }
        let encoded:Vec<u16>=std::ffi::OsStr::new(&link).encode_wide().chain(Some(0)).collect();
        let opened=unsafe { ShellExecuteW(std::ptr::null_mut(),std::ptr::null(),encoded.as_ptr(),std::ptr::null(),std::ptr::null(),1) };
        if opened<=32 { return Err("Windows could not open Claude Desktop. Install/open Claude, then paste the copied transcript or attach the exported TXT.".into()); }
    }
    #[cfg(not(target_os="windows"))]
    { let _=link; return Err("This app handoff currently supports Windows; use Copy for Claude or TXT export.".into()); }
    #[allow(unreachable_code)]
    Ok(json!({"opened":true,"requires_paste":mode=="chat","path":attachment.map(|p|p.to_string_lossy().to_string())}))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn import_pool() -> sqlx::SqlitePool {
        let pool=sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE meetings(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT,updated_at TEXT,folder_path TEXT)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE transcripts(id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES meetings(id),transcript TEXT NOT NULL,timestamp TEXT NOT NULL,audio_start_time REAL,audio_end_time REAL,duration REAL)").execute(&pool).await.unwrap();
        for id in ["source","other"] {
            sqlx::query("INSERT INTO meetings(id,title,folder_path) VALUES(?,?,?)").bind(id).bind(id).bind("/fixture-recording").execute(&pool).await.unwrap();
        }
        pool
    }
    fn window(job:&str,track:&str,suffix:&str,start:f64,end:f64,text:&str) -> Value {
        json!({"id":format!("{job}-{track}-{suffix}"),"source_track":track,"start_seconds":start,"end_seconds":end,"text":text})
    }
    fn checkpoint(job:&str,revision:u64,segments:Vec<Value>,archive:Vec<Value>) -> Value {
        json!({"job_id":job,"profile":"trelis-20","session_dir":"/fixture-recording",
            "segments_revision":revision,"segments":segments,"superseded_segments":archive})
    }
    fn archived(mut value:Value,by:Vec<String>,revision:u64) -> Value {
        value["superseded_by"]=json!(by);value["superseded_at_segments_revision"]=json!(revision);value
    }
    async fn raw_rows(pool:&sqlx::SqlitePool,meeting:&str) -> Vec<(String,String,f64,f64)> {
        sqlx::query_as("SELECT id,transcript,audio_start_time,audio_end_time FROM transcripts WHERE meeting_id=? ORDER BY audio_start_time,id")
            .bind(meeting).fetch_all(pool).await.unwrap()
    }
    #[tokio::test]
    async fn same_count_selection_updates_raw_and_preserves_correction_source_and_revision() {
        let pool=import_pool().await;
        let original=window("job","microphone","0",0.,20.,"जो जो जो");
        let first=checkpoint("job",1,vec![original.clone()],vec![]);
        let result=import_status(&pool,"job","source",false,&first).await.unwrap();
        let meeting=result["meeting_id"].as_str().unwrap();
        let mut selected=original.clone();selected["text"]=json!("recovered speech");
        selected["replaces_segment_ids"]=json!([original["id"]]);
        let second=checkpoint("job",2,vec![selected.clone()],vec![archived(original.clone(),vec![original["id"].as_str().unwrap().into()],2)]);
        assert_eq!(import_status(&pool,"job","source",false,&second).await.unwrap()["imported_count"],1);
        assert_eq!(raw_rows(&pool,meeting).await[0].1,"recovered speech");
        assert!(correction_source_matches(&pool,meeting,"job-microphone-0","जो जो जो").await.unwrap());
        assert!(correction_source_matches(&pool,meeting,"job-microphone-0","recovered speech").await.unwrap());
        assert!(!correction_source_matches(&pool,meeting,"job-microphone-0","invented original").await.unwrap());
        assert!(!correction_source_matches(&pool,"other","job-microphone-0","जो जो जो").await.unwrap());
        let history:i64=sqlx::query_scalar("SELECT count(*) FROM local_transcription_raw_history").fetch_one(&pool).await.unwrap();
        assert!(history>=2); // complete worker snapshot plus database raw/time snapshot
        assert_eq!(import_status(&pool,"job","source",false,&second).await.unwrap()["imported_count"],0);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM local_transcription_raw_history").fetch_one(&pool).await.unwrap(),history);
        assert_eq!(import_status(&pool,"job","source",false,&first).await.unwrap()["stale_snapshot"],true);
        assert_eq!(raw_rows(&pool,meeting).await[0].1,"recovered speech");
        let mut invalid=second;invalid["segments"][0]["text"]=json!("same revision changed text");
        assert!(import_status(&pool,"job","source",false,&invalid).await.unwrap_err().contains("newer segments revision"));
        assert_eq!(raw_rows(&pool,meeting).await[0].1,"recovered speech");
    }
    #[tokio::test]
    async fn context_and_fringe_replace_two_ranges_once_and_preserve_parallel_track() {
        let pool=import_pool().await;
        let core=window("job","microphone","0",0.,20.,"loop");
        let neighbor=window("job","microphone","320000",20.,40.,"neighbor");
        let system=window("job","system","0",0.,20.,"system speech");
        let first=checkpoint("job",1,vec![core.clone(),neighbor.clone(),system.clone()],vec![]);
        import_status(&pool,"job","source",false,&first).await.unwrap();
        let mut context=window("job","microphone","c-0-480000",0.,30.,"recovered context");
        let mut fringe=window("job","microphone","f-480000-640000",30.,40.,"remaining neighbor");
        context["replaces_segment_ids"]=json!([core["id"],neighbor["id"]]);
        fringe["replaces_segment_ids"]=json!([neighbor["id"]]);
        let archive=vec![archived(core.clone(),vec![context["id"].as_str().unwrap().into()],2),
            archived(neighbor.clone(),vec![context["id"].as_str().unwrap().into(),fringe["id"].as_str().unwrap().into()],2)];
        let second=checkpoint("job",2,vec![context.clone(),fringe.clone(),system.clone()],archive);
        let result=import_status(&pool,"job","source",false,&second).await.unwrap();
        assert_eq!(result["removed_count"],2);
        let rows=raw_rows(&pool,"meeting-local-job").await;
        assert_eq!(rows.len(),3);
        assert!(rows.iter().any(|row|row.1=="recovered context" && row.2==0. && row.3==30.));
        assert!(rows.iter().any(|row|row.1=="remaining neighbor" && row.2==30. && row.3==40.));
        assert!(rows.iter().any(|row|row.0=="job-system-0" && row.1=="system speech"));
        assert!(!rows.iter().any(|row|row.0=="job-microphone-0" || row.0=="job-microphone-320000"));
        assert!(correction_source_matches(&pool,"meeting-local-job","job-microphone-320000","neighbor").await.unwrap());
    }
    #[tokio::test]
    async fn collisions_and_unarchived_removal_preserve_other_meetings_and_prior_rows() {
        let pool=import_pool().await;
        let core=window("job","microphone","0",0.,20.,"original");
        import_status(&pool,"job","source",false,&checkpoint("job",1,vec![core.clone()],vec![])).await.unwrap();
        let foreign=checkpoint("job",2,vec![window("another","microphone","0",0.,20.,"wrong job")],vec![]);
        assert!(import_status(&pool,"job","source",false,&foreign).await.unwrap_err().contains("different job"));
        let replacement=checkpoint("job",2,vec![window("job","microphone","c-0-480000",0.,30.,"replacement")],vec![]);
        assert!(import_status(&pool,"job","source",false,&replacement).await.unwrap_err().contains("archived snapshot"));
        sqlx::query("INSERT INTO transcripts(id,meeting_id,transcript,timestamp,audio_start_time,audio_end_time) VALUES('next-microphone-0','other','other raw','00:00',0,20)").execute(&pool).await.unwrap();
        let colliding=checkpoint("next",1,vec![window("next","microphone","0",0.,20.,"new raw")],vec![]);
        assert!(import_status(&pool,"next","source",false,&colliding).await.unwrap_err().contains("another meeting"));
        assert_eq!(raw_rows(&pool,"other").await[0].1,"other raw");
        assert_eq!(raw_rows(&pool,"meeting-local-job").await[0].1,"original");
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM meetings WHERE id='meeting-local-next'").fetch_one(&pool).await.unwrap(),0);
    }
    #[test]
    fn canonical_selection_rejects_duplicate_overlap_and_cross_track_edges() {
        let mic=window("job","microphone","0",0.,20.,"mic");
        let system=window("job","system","0",0.,20.,"system");
        assert!(canonical_windows("job",&checkpoint("job",1,vec![mic.clone(),system.clone()],vec![])).is_ok());
        assert!(canonical_windows("job",&checkpoint("job",1,vec![mic.clone(),mic.clone()],vec![])).unwrap_err().contains("Duplicate"));
        assert!(canonical_windows("job",&checkpoint("job",1,vec![mic.clone(),window("job","microphone","160000",10.,30.,"overlap")],vec![])).unwrap_err().contains("overlap"));
        let mut selected=mic.clone();selected["replaces_segment_ids"]=json!([system["id"]]);
        let invalid=checkpoint("job",2,vec![selected],vec![archived(system,vec![mic["id"].as_str().unwrap().into()],2)]);
        assert!(canonical_windows("job",&invalid).unwrap_err().contains("same-track"));
        let mut missing=mic.clone();missing["replaces_segment_ids"]=json!(["job-microphone-missing"]);
        assert!(canonical_windows("job",&checkpoint("job",2,vec![missing],vec![])).is_err());
    }
    #[tokio::test]
    async fn sql_error_rolls_back_raw_history_deletes_upserts_and_checkpoint() {
        let pool=import_pool().await;
        let original=window("job","microphone","0",0.,20.,"original");
        import_status(&pool,"job","source",false,&checkpoint("job",1,vec![original.clone()],vec![])).await.unwrap();
        sqlx::query("CREATE TRIGGER fixture_abort BEFORE INSERT ON transcripts WHEN NEW.transcript='force-error' BEGIN SELECT RAISE(ABORT,'fixture failure'); END").execute(&pool).await.unwrap();
        let mut changed=window("job","microphone","c-0-480000",0.,30.,"force-error");
        changed["replaces_segment_ids"]=json!([original["id"]]);
        let next=checkpoint("job",2,vec![changed.clone()],vec![archived(original,vec![changed["id"].as_str().unwrap().into()],2)]);
        assert!(import_status(&pool,"job","source",false,&next).await.is_err());
        assert_eq!(raw_rows(&pool,"meeting-local-job").await[0].1,"original");
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM local_transcription_raw_history").fetch_one(&pool).await.unwrap(),0);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT segments_revision FROM local_transcription_imports WHERE job_id='job'").fetch_one(&pool).await.unwrap(),1);
    }
    #[tokio::test]
    async fn legacy_append_only_status_imports_and_older_polls_do_not_rollback() {
        let pool=import_pool().await;
        let mut first=checkpoint("job",0,vec![window("job","microphone","0",0.,20.,"first")],vec![]);
        first.as_object_mut().unwrap().remove("segments_revision");
        first.as_object_mut().unwrap().remove("superseded_segments");
        import_status(&pool,"job","source",false,&first).await.unwrap();
        let mut second=first.clone();second["segments"].as_array_mut().unwrap().push(window("job","microphone","320000",20.,40.,"second"));
        import_status(&pool,"job","source",false,&second).await.unwrap();
        assert_eq!(raw_rows(&pool,"meeting-local-job").await.len(),2);
        assert_eq!(import_status(&pool,"job","source",false,&first).await.unwrap()["stale_snapshot"],true);
        assert_eq!(raw_rows(&pool,"meeting-local-job").await.len(),2);
    }

    #[test]
    fn unreadable_checkpoint_is_failed_only_after_worker_exit_and_never_rewritten() {
        let root = tempfile::tempdir().unwrap();
        let bytes = vec![0u8; 4096];
        fs::write(root.path().join("status.json"), &bytes).unwrap();
        let request = json!({"session_dir":"saved-recording","profile":"trelis-20","workflow_role":"live-final"});
        for exited in [false, true] {
            let status = project_transcription_checkpoint("job", &request, read_transcription_checkpoint(root.path()), exited);
            assert_eq!(status["state"], if exited {"failed"} else {"running"});
            assert_eq!(status["checkpoint_unreadable"], true);
            assert_eq!(status["workflow_role"], "live-final");
            assert_eq!(status["session_dir"], "saved-recording");
            assert!(status.get("segments").is_none());
            assert!(status["checkpoint_error"].as_str().unwrap().contains("expected value"));
            assert!(require_readable_transcription_checkpoint(&status).is_err());
            // Even a frontend cache merge cannot make this projection importable.
            let mut cached = status.clone();
            cached["segments"] = json!([{"text":"previous valid text"}]);
            assert!(require_readable_transcription_checkpoint(&cached).is_err());
            assert_eq!(fs::read(root.path().join("status.json")).unwrap(), bytes);
        }
    }

    #[test]
    fn valid_checkpoint_keeps_segments_revision_and_live_teardown_gate() {
        let root = tempfile::tempdir().unwrap();
        let checkpoint = json!({"job_id":"job","state":"complete","segments":[{"text":"preserved"}],
            "superseded_segments":[{"text":"earlier"}],"segments_revision":12,"identity_sha256":"original-identity"});
        let bytes = serde_json::to_vec(&checkpoint).unwrap();
        fs::write(root.path().join("status.json"), &bytes).unwrap();
        let request = json!({"workflow_role":"live-final","final_profile":"trelis-10"});
        for exited in [false, true] {
            let status = project_transcription_checkpoint("job", &request, read_transcription_checkpoint(root.path()), exited);
            assert_eq!(status["state"], if exited {"complete"} else {"running"});
            assert_eq!(status["segments"], checkpoint["segments"]);
            assert_eq!(status["superseded_segments"], checkpoint["superseded_segments"]);
            assert_eq!(status["segments_revision"], 12);
            assert_eq!(status["identity_sha256"], "original-identity");
            assert_eq!(status["final_profile"], "trelis-10");
            assert!(require_readable_transcription_checkpoint(&status).is_ok());
        }
        assert_eq!(fs::read(root.path().join("status.json")).unwrap(), bytes);
    }

    #[test]
    fn malformed_checkpoint_shape_is_inspectable_instead_of_panicking() {
        let root = tempfile::tempdir().unwrap();
        for checkpoint in [json!(null), json!([]), json!({"state":"complete"}),
            json!({"state":"unknown","segments":[]})] {
            fs::write(root.path().join("status.json"), serde_json::to_vec(&checkpoint).unwrap()).unwrap();
            let status = project_transcription_checkpoint("job", &json!({}), read_transcription_checkpoint(root.path()), true);
            assert_eq!(status["state"], "failed");
            assert_eq!(status["checkpoint_unreadable"], true);
            assert!(status.get("segments").is_none());
        }
    }

    #[test]
    fn absent_checkpoint_keeps_new_worker_startup_and_interrupted_resume_behavior() {
        let root = tempfile::tempdir().unwrap();
        for exited in [false, true] {
            let status = project_transcription_checkpoint("job", &json!({}), read_transcription_checkpoint(root.path()), exited);
            assert_eq!(status["state"], if exited {"failed"} else {"running"});
            assert!(status.get("checkpoint_unreadable").is_none());
            assert_eq!(status["segments"], json!([]));
            assert!(require_readable_transcription_checkpoint(&status).is_ok());
        }
    }

    fn synthetic_asr_runtime(root: &Path, label: &str) -> Value {
        let mut config = json!({"models":{"trelis":{"backend":label}}});
        for key in ["python_executable", "worker_script", "registry_path"] {
            let path = root.join(format!("{label}-{key}"));
            fs::write(&path, b"synthetic fixture; never executed").unwrap();
            config[key] = json!(path);
        }
        fs::write(config["registry_path"].as_str().unwrap(), serde_json::to_vec(&json!({
            "application_profiles":{"apex":[20],"trelis":[5,10,20]}
        })).unwrap()).unwrap();
        config
    }
    #[test] fn asr_runtime_snapshot_keeps_old_runtime_after_global_change() {
        let root = tempfile::tempdir().unwrap();
        let job = root.path().join("job"); fs::create_dir(&job).unwrap();
        let current = root.path().join("runtime.json");
        let old = synthetic_asr_runtime(root.path(), "old-engine");
        let bytes = serde_json::to_vec_pretty(&old).unwrap();
        fs::write(&current, &bytes).unwrap();
        let snapshot = ensure_job_runtime_snapshot(&job, &current).unwrap();
        assert_eq!(fs::read(&snapshot).unwrap(), bytes);
        fs::write(job.join("status.json"), b"{}").unwrap();
        let replacement = synthetic_asr_runtime(root.path(), "new-engine");
        fs::write(&current, serde_json::to_vec(&replacement).unwrap()).unwrap();
        assert_eq!(ensure_job_runtime_snapshot(&job, &current).unwrap(), snapshot);
        assert_eq!(read(&snapshot).unwrap(), old);
        fs::remove_file(&current).unwrap();
        assert_eq!(ensure_job_runtime_snapshot(&job, &current).unwrap(), snapshot);
        assert_eq!(fs::read(&snapshot).unwrap(), bytes);
    }
    #[test] fn asr_runtime_snapshot_rejects_invalid_or_missing_files_without_replacement() {
        let root = tempfile::tempdir().unwrap();
        let job = root.path().join("job"); fs::create_dir(&job).unwrap();
        let current = root.path().join("runtime.json");
        let snapshot = job.join("runtime-snapshot.json");
        assert!(ensure_job_runtime_snapshot(&job, &current).is_err());
        fs::write(&current, b"{broken").unwrap();
        assert!(ensure_job_runtime_snapshot(&job, &current).is_err());
        assert!(!snapshot.exists());
        let config = synthetic_asr_runtime(root.path(), "engine");
        fs::write(&current, serde_json::to_vec(&config).unwrap()).unwrap();
        fs::write(&snapshot, b"{broken").unwrap();
        assert!(ensure_job_runtime_snapshot(&job, &current).is_err());
        assert_eq!(fs::read(&snapshot).unwrap(), b"{broken");
        fs::write(&snapshot, serde_json::to_vec(&config).unwrap()).unwrap();
        for key in ["python_executable", "worker_script", "registry_path"] {
            let path = Path::new(config[key].as_str().unwrap());
            fs::remove_file(path).unwrap();
            assert!(ensure_job_runtime_snapshot(&job, &current).is_err());
            assert_eq!(read(&snapshot).unwrap(), config);
            fs::write(path, b"synthetic fixture").unwrap();
        }
        let mut relative = config.clone(); relative["worker_script"] = json!("worker.py");
        assert!(validate_asr_runtime(&relative).is_err());
    }
    #[test] fn legacy_asr_checkpoint_requires_original_runtime_migration() {
        let root = tempfile::tempdir().unwrap();
        let job = root.path().join("job"); fs::create_dir(&job).unwrap();
        let current = root.path().join("runtime.json");
        fs::write(&current, serde_json::to_vec(&synthetic_asr_runtime(root.path(), "new")).unwrap()).unwrap();
        let status = b"{\"state\":\"stopped\",\"segments\":[{\"text\":\"preserved\"}]}";
        fs::write(job.join("status.json"), status).unwrap();
        assert!(ensure_job_runtime_snapshot(&job, &current).unwrap_err().contains("original runtime"));
        assert!(!job.join("runtime-snapshot.json").exists());
        let old = synthetic_asr_runtime(root.path(), "original");
        fs::write(job.join("runtime-snapshot.json"), serde_json::to_vec(&old).unwrap()).unwrap();
        let chosen = ensure_job_runtime_snapshot(&job, &current).unwrap();
        assert_eq!(read(&chosen).unwrap(), old);
        assert_eq!(fs::read(job.join("status.json")).unwrap(), status);
    }
    #[test] fn concurrent_asr_snapshot_creation_has_one_complete_winner() {
        let root = tempfile::tempdir().unwrap();
        let job = root.path().join("job"); fs::create_dir(&job).unwrap();
        let first = root.path().join("first.json");
        let second = root.path().join("second.json");
        let first_bytes = serde_json::to_vec(&synthetic_asr_runtime(root.path(), "first")).unwrap();
        let second_bytes = serde_json::to_vec(&synthetic_asr_runtime(root.path(), "second")).unwrap();
        fs::write(&first, &first_bytes).unwrap(); fs::write(&second, &second_bytes).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = [first, second].into_iter().map(|config| {
            let dir = job.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); ensure_job_runtime_snapshot(&dir, &config) })
        }).collect();
        for handle in handles { assert!(handle.join().unwrap().is_ok()); }
        let actual = fs::read(job.join("runtime-snapshot.json")).unwrap();
        assert!(actual == first_bytes || actual == second_bytes);
        assert_eq!(fs::read_dir(&job).unwrap().count(), 1);
    }
    #[test] fn automatic_roles_do_not_admit_swapped_models() {
        assert!(validate_workflow_role(Some("live-draft"), "apex-20").is_ok());
        assert!(validate_workflow_role(Some("fallback"), "apex-20").is_ok());
        assert!(validate_workflow_role(Some("live-final"), "apex-20").is_err());
        assert!(validate_workflow_role(Some("final"), "apex-20").is_err());
        assert!(validate_workflow_role(None, "apex-20").is_ok());
        for profile in ["trelis-5", "trelis-10", "trelis-20"] {
            assert!(validate_workflow_role(Some("final"), profile).is_ok());
            assert!(validate_workflow_role(Some("live-final"), profile).is_ok());
            assert!(validate_workflow_role(Some("fallback"), profile).is_err());
            assert!(validate_workflow_role(Some("live-draft"), profile).is_err());
            assert!(validate_workflow_role(None, profile).is_ok());
            assert!(validate_workflow_role(Some("unknown"), profile).is_err());
        }
        for profile in ["trelis-0", "trelis-15", "trelis-30", "apex-5", "apex-10", "unknown"] {
            for role in [None, Some("final"), Some("live-final"), Some("fallback"), Some("live-draft")] {
                assert!(validate_workflow_role(role, profile).is_err());
            }
        }
    }
    #[test] fn final_requires_committed_completion_or_matching_recovery() {
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir().unwrap();
        let timeline = root.path().join("timeline.jsonl");
        fs::write(&timeline, b"{\"kind\":\"capture_finalized\"}").unwrap();
        assert!(!capture_ready_for_final(root.path()).unwrap());
        fs::write(&timeline, b"{\"kind\":\"capture_finalized\"}\n").unwrap();
        assert!(capture_ready_for_final(root.path()).unwrap());
        let interrupted = b"{\"kind\":\"capture_started\"}\n";
        fs::write(&timeline, interrupted).unwrap();
        fs::write(root.path().join("metadata.json"), b"{\"status\":\"recovered\"}").unwrap();
        fs::write(root.path().join("recovery-verified.json"), serde_json::to_vec(&json!({"verified":true,"duration_seconds":1.0,"source_journal_sha256":format!("{:x}",Sha256::digest(interrupted))})).unwrap()).unwrap();
        assert!(capture_ready_for_final(root.path()).unwrap());
        fs::write(root.path().join("metadata.json"), b"{\"status\":\"recording\"}").unwrap();
        assert!(!capture_ready_for_final(root.path()).unwrap());
        fs::write(&timeline, b"changed\n").unwrap();
        assert!(!capture_ready_for_final(root.path()).unwrap());
    }
    #[test] fn only_requested_profiles_are_admitted() {
        for invalid in ["trelis-0", "trelis-1", "trelis-15", "trelis-30", "trelis-05", "trelis-5.0", "apex-5", "apex-10", "apex-15", "apex-30", "unknown", ""] {
            assert!(profile_parts(invalid).is_err(), "Unexpected profile admitted: {invalid}");
        }
        for seconds in [5, 10, 20] {
            assert_eq!(profile_parts(&format!("trelis-{seconds}")).unwrap(),("trelis",seconds));
        }
        // Stored pre-choice transcripts keep the original profile identity.
        assert_eq!(profile_parts("trelis-20").unwrap(),("trelis",20));
        assert_eq!(profile_parts("apex-20").unwrap(),("apex",20));
    }
    #[test] fn final_profile_metadata_admits_only_declared_trelis_profiles() {
        assert!(validate_final_profile(None).is_ok());
        for profile in ["trelis-5", "trelis-10", "trelis-20"] {
            assert!(validate_final_profile(Some(profile)).is_ok());
        }
        for profile in ["apex-20", "trelis-0", "trelis-15", "trelis-30", "unknown", ""] {
            assert!(validate_final_profile(Some(profile)).is_err());
        }
    }
    #[test] fn restored_job_preserves_final_profile_metadata_and_legacy_absence() {
        for profile in ["trelis-5", "trelis-10", "trelis-20"] {
            let request = json!({"profile":"apex-20","workflow_role":"fallback", "final_profile":profile,
                "capture_session_id":"capture", "language_mode":"hinglish", "created_at":"2026-10-07"});
            let mut status = json!({"profile":"apex-20", "state":"complete", "segments":[{"text":"preserved"}]});
            project_request_metadata(&mut status, &request);
            assert_eq!(status["final_profile"], profile);
            assert_eq!(status["workflow_role"], "fallback");
            assert_eq!(status["profile"], "apex-20");
            assert_eq!(status["state"], "complete");
            assert_eq!(status["segments"][0]["text"], "preserved");
        }
        let mut legacy = json!({"profile":"apex-20"});
        project_request_metadata(&mut legacy, &json!({"profile":"apex-20", "workflow_role":"fallback"}));
        assert!(legacy["final_profile"].is_null());
        assert_eq!(legacy["profile"], "apex-20");
    }
    #[test] fn profile_list_shares_runtime_availability_and_reports_each_duration() {
        let missing = local_stt_profiles(None);
        assert_eq!(missing.len(), 4);
        assert!(missing.iter().all(|profile| profile["available"] == false));
        let root = tempfile::tempdir().unwrap();
        let mut config = synthetic_asr_runtime(root.path(), "warm");
        let artifact = root.path().join("trelis"); fs::create_dir(&artifact).unwrap();
        let apex = root.path().join("apex"); fs::create_dir(&apex).unwrap();
        let export = root.path().join("export"); fs::create_dir(&export).unwrap();
        fs::write(export.join("conversion-provenance.json"), b"{}").unwrap();
        config["models"] = json!({"trelis":{"backend":"openvino", "device":"GPU", "artifact_path":artifact, "export_path":export},
            "apex":{"backend":"whisper.cpp", "artifact_path":apex}});
        let profiles = local_stt_profiles(Some(&config));
        assert_eq!(profiles.iter().map(|profile| profile["id"].as_str().unwrap()).collect::<Vec<_>>(),
            ["trelis-5", "trelis-10", "trelis-20", "apex-20"]);
        for profile in &profiles {
            let (model, seconds) = profile_parts(profile["id"].as_str().unwrap()).unwrap();
            assert_eq!(profile["model"], model);
            assert_eq!(profile["chunk_seconds"], seconds);
            assert_eq!(profile["available"], true);
            assert_eq!(profile["language_modes"], json!(["hinglish", "english"]));
            assert_eq!(profile["live_replay_supported"], true);
            assert_eq!(profile["live_qualified"], false);
            assert_eq!(profile["recommended_timing"], "during-recording");
            if model == "trelis" {
                assert_eq!(profile["backend"], "openvino");
                assert!(profile["reason"].as_str().unwrap().contains(&format!("{seconds}-second")));
            }
        }
        config["models"]["trelis"]["device"] = json!("CPU");
        for profile in local_stt_profiles(Some(&config)).iter().filter(|profile| profile["model"] == "trelis") {
            assert_eq!(profile["available"], true);
            assert_eq!(profile["live_replay_supported"], false);
            assert_eq!(profile["recommended_timing"], "after-recording");
        }
        fs::remove_dir(&artifact).unwrap();
        let absent_trelis = local_stt_profiles(Some(&config));
        assert!(absent_trelis.iter().filter(|profile| profile["model"] == "trelis").all(|profile| profile["available"] == false));
        assert_eq!(absent_trelis.iter().find(|profile| profile["model"] == "apex").unwrap()["available"], true);
        fs::remove_file(config["registry_path"].as_str().unwrap()).unwrap();
        assert!(local_stt_profiles(Some(&config)).iter().all(|profile| profile["available"] == false));
    }
    #[test] fn registry_duration_guard_preserves_legacy_and_admits_modern_choices() {
        let root = tempfile::tempdir().unwrap();
        let mut config = synthetic_asr_runtime(root.path(), "installed");
        let artifact = root.path().join("model"); fs::create_dir(&artifact).unwrap();
        config["models"] = json!({"trelis":{"backend":"openvino", "device":"GPU", "artifact_path":artifact},
            "apex":{"backend":"whisper.cpp", "artifact_path":artifact}});
        let registry = Path::new(config["registry_path"].as_str().unwrap());
        let legacy = json!({"application_profiles":{"apex":[15,20,30],"trelis":[15,20]}});
        fs::write(registry, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let legacy_choices = local_stt_profiles(Some(&config));
        assert_eq!(legacy_choices.len(), 4);
        assert!(legacy_choices.iter().all(|profile| !profile["id"].as_str().unwrap().ends_with("-15")));
        for profile in ["apex-20", "trelis-20"] {
            assert!(require_runtime_profile(&config, profile).is_ok());
            assert_eq!(legacy_choices.iter().find(|choice| choice["id"] == profile).unwrap()["available"], true);
        }
        for profile in ["trelis-5", "trelis-10"] {
            assert!(require_runtime_profile(&config, profile).unwrap_err().contains("Update the local STT runtime"));
            let choice = legacy_choices.iter().find(|choice| choice["id"] == profile).unwrap();
            assert_eq!(choice["available"], false);
            assert!(choice["reason"].as_str().unwrap().contains("update"));
        }
        assert!(!registry_supports_profile(Some(&legacy), "trelis-15"));
        assert!(require_runtime_profile(&config, "trelis-15").is_err());
        let modern = json!({"application_profiles":{"apex":[20],"trelis":[5,10,20]}});
        fs::write(registry, serde_json::to_vec(&modern).unwrap()).unwrap();
        assert!(local_stt_profiles(Some(&config)).iter().all(|profile| profile["available"] == true));
        for profile in ["apex-20", "trelis-5", "trelis-10", "trelis-20"] {
            assert!(require_runtime_profile(&config, profile).is_ok());
        }
        let malformed = json!({"application_profiles":{"apex":[20],"trelis":["5",10.0,-20]}});
        assert!(!registry_supports_profile(Some(&malformed), "trelis-5"));
        assert!(!registry_supports_profile(Some(&malformed), "trelis-10"));
        assert!(!registry_supports_profile(Some(&malformed), "trelis-20"));
        for bytes in [b"{broken".as_slice(), b"{}".as_slice()] {
            fs::write(registry, bytes).unwrap();
            assert!(local_stt_profiles(Some(&config)).iter().all(|profile| profile["available"] == false));
            assert!(require_runtime_profile(&config, "trelis-10").is_err());
        }
        fs::remove_file(registry).unwrap();
        assert!(local_stt_profiles(Some(&config)).iter().all(|profile| profile["available"] == false));
        assert!(require_runtime_profile(&config, "trelis-10").is_err());
    }
    #[test] fn claude_chat_never_truncates_transcript_into_uri() {
        assert_eq!(claude_link("chat",None).unwrap(),"claude://claude.ai/new");
        let uri=claude_link("cowork",Some(Path::new("C:/private/a & b.txt"))).unwrap();
        let url=url::Url::parse(&uri).unwrap(); assert_eq!(url.query_pairs().find(|(k,_)| k=="file").unwrap().1,"C:/private/a & b.txt");
        assert!(claude_link("unsupported",None).is_err());
    }
}
