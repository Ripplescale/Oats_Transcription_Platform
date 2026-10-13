//! One reusable offline dictation child. The caller serializes access and drops
//! idle workers before meeting work, on shutdown, and after any failed request.
//! Cancellation/timeout also kill and reap immediately, before request cleanup.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const MAX_RESULT_BYTES: u64 = 1_048_576;
const MAX_AUDIO_BYTES: usize = 120 * 192_000 * 2 + 44;
const MAX_REQUESTS: usize = 4096;
const POLL_INTERVAL: Duration = Duration::from_millis(15);
const CLEANUP_RETRY_BUDGET: Duration = Duration::from_millis(80);
const CLEANUP_RETRY_INTERVAL: Duration = Duration::from_millis(20);
const MAX_PENDING_CLEANUPS: usize = 4;
const MAX_PENDING_CLEANUP_BYTES: usize = 64 * 1024 * 1024;
// Input WAV plus the worker's fixed 20-second scratch WAV, two bounded result
// hard links (conservatively counted twice), and the small request descriptor.
const REQUEST_CLEANUP_OVERHEAD: usize = 20 * 16_000 * 2 + 44 + 2 * MAX_RESULT_BYTES as usize + 4096;

struct PendingCleanup {
    path: PathBuf,
    reserved_bytes: usize,
}

pub(super) fn backend(config: &Value) -> Result<&'static str, String> {
    match config.get("dictation_backend").and_then(Value::as_str) {
        None if config.get("dictation_backend").is_none() => Ok("trelis"),
        Some("trelis") => Ok("trelis"),
        Some("faster_whisper") => Ok("faster_whisper"),
        _ => Err("The selected dictation backend is unsupported.".into()),
    }
}

#[derive(PartialEq)]
struct Stamp {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}

#[derive(PartialEq)]
struct Identity {
    config: Value,
    script: PathBuf,
    stamps: Vec<Stamp>,
}

impl Identity {
    fn read(config: &Value, script: &Path) -> Result<Self, String> {
        let mut paths = vec![script.to_path_buf()];
        let faster = backend(config)? == "faster_whisper";
        let keys: &[&str] = if faster { &["python_executable"] } else {
            &["python_executable", "worker_script", "registry_path"]
        };
        for key in keys {
            paths.push(PathBuf::from(
                config[*key]
                    .as_str()
                    .ok_or("The local dictation runtime needs setup.")?,
            ));
        }
        if faster {
            let model = config["faster_whisper"]["model_path"].as_str()
                .map(PathBuf::from).ok_or("Set up the faster-whisper dictation model first.")?;
            if !model.is_absolute() || !model.is_dir() {
                return Err("The faster-whisper dictation model must be a local directory.".into());
            }
            paths.push(script.parent().ok_or("The dictation worker path is invalid.")?
                .join("faster_whisper_dictation.py"));
            for name in ["config.json", "model.bin", "tokenizer.json"] { paths.push(model.join(name)); }
        } else if let Some(root) = paths[2].parent().map(Path::to_path_buf) {
            for name in [
                "sttbench/runtime/api.py",
                "sttbench/runtime/assets.py",
                "sttbench/speech_gate.py",
            ] {
                let path = root.join(name);
                if path.is_file() {
                    paths.push(path);
                }
            }
        }
        let mut stamps = Vec::with_capacity(paths.len());
        for path in paths {
            if !path.is_absolute() {
                return Err("Dictation runtime paths must be absolute.".into());
            }
            let info = fs::metadata(&path)
                .map_err(|_| "The local dictation runtime is unavailable.".to_owned())?;
            if !info.is_file() {
                return Err("The local dictation runtime is unavailable.".into());
            }
            stamps.push(Stamp {
                path: path.canonicalize().map_err(|e| e.to_string())?,
                bytes: info.len(),
                modified: info.modified().map_err(|e| e.to_string())?,
            });
        }
        Ok(Self {
            config: config.clone(),
            script: script.to_path_buf(),
            stamps,
        })
    }
}

pub(super) struct Worker {
    // Drop explicitly reaps the child before TempDir removes its owned directory.
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    root: tempfile::TempDir,
    identity: Identity,
    used_ids: HashSet<String>,
    pending_cleanup: Vec<PendingCleanup>,
    last_used: Instant,
    unusable: bool,
}

impl Worker {
    /// Starts loading the model in the child immediately; never waits for warmup.
    pub(super) fn spawn(config: &Value, script: &Path) -> Result<Self, String> {
        let identity = Identity::read(config, script)?;
        let mut command = Command::new(
            config["python_executable"]
                .as_str()
                .ok_or("Local Python is unavailable.")?,
        );
        command.arg("-B").arg(script);
        Self::spawn_command(identity, command)
    }

    fn spawn_command(identity: Identity, mut command: Command) -> Result<Self, String> {
        let root = tempfile::Builder::new()
            .prefix("oats-dictation-engine-")
            .tempdir()
            .map_err(|e| format!("Could not prepare dictation: {e}"))?;
        let config_path = root.path().join("runtime.json");
        write_new(
            &config_path,
            &serde_json::to_vec(&identity.config).map_err(|e| e.to_string())?,
        )?;
        #[cfg(test)]
        let fixture = command
            .get_envs()
            .any(|(key, _)| key == "OATS_ENGINE_FIXTURE_MODE");
        #[cfg(not(test))]
        let fixture = false;
        if !fixture {
            command.arg("--config").arg(&config_path).arg("--serve");
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("STTAPP_PARENT_PID", std::process::id().to_string())
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("HF_HUB_DISABLE_TELEMETRY", "1")
            .env("DO_NOT_TRACK", "1");
        #[cfg(test)]
        command.env("OATS_ENGINE_FIXTURE_ROOT", root.path());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command
            .spawn()
            .map_err(|e| format!("The local dictation worker could not start: {e}"))?;
        let mut worker = Self {
            child: Some(child),
            stdin: None,
            root,
            identity,
            used_ids: HashSet::new(),
            pending_cleanup: Vec::new(),
            last_used: Instant::now(),
            unusable: false,
        };
        worker.stdin = worker.child.as_mut().and_then(|child| child.stdin.take());
        if worker.stdin.is_none() {
            return Err("The local dictation worker has no request channel.".into());
        }
        Ok(worker)
    }

    /// Metadata invalidation avoids rehashing model weights for every phrase.
    /// The Python adapter still verifies its model manifests on every request.
    pub(super) fn matches(&self, config: &Value, script: &Path) -> bool {
        !self.unusable && self.used_ids.len() + 128 <= MAX_REQUESTS
            && Identity::read(config, script)
                .map(|other| self.identity == other)
                .unwrap_or(false)
    }

    pub(super) fn is_alive(&mut self) -> Result<bool, String> {
        if self.unusable {
            return Ok(false);
        }
        let Some(child) = self.child.as_mut() else {
            return Ok(false);
        };
        match child.try_wait().map_err(|e| e.to_string())? {
            None => Ok(true),
            Some(_) => {
                self.unusable = true;
                Ok(false)
            }
        }
    }

    /// False means warmup has not completed. Deferred means the worker is usable
    /// but this backend loads lazily on its first transcription.
    pub(super) fn is_ready(&mut self) -> Result<bool, String> {
        if !self.is_alive()? {
            return Err("The local dictation worker stopped. Please try again.".into());
        }
        let Some(ready) = read_json_optional(&self.root.path().join("ready.json"))? else {
            return Ok(false);
        };
        if ready["version"] != 1 {
            return Err("The local dictation worker returned an invalid readiness message.".into());
        }
        match ready["status"].as_str() {
            Some("ok" | "deferred") => Ok(true),
            Some("failed") => Err(worker_error(
                &ready,
                "The local speech model could not prepare dictation.",
            )),
            _ => Err("The local dictation worker returned an invalid readiness message.".into()),
        }
    }

    pub(super) fn has_idle_expired(&self, maximum: Duration) -> bool {
        self.last_used.elapsed() >= maximum
    }

    /// At most one request may be outstanding. On cancellation, timeout, invalid
    /// output, or worker failure this kills/reaps the child; the caller must then
    /// discard this Worker. A normal success leaves only the warm model.
    pub(super) fn transcribe(
        &mut self,
        id: &str,
        wav: &[u8],
        cancelled: &AtomicBool,
        timeout: Duration,
    ) -> Result<Option<Value>, String> {
        self.transcribe_request(id, wav, cancelled, timeout, None)
    }

    /// Submit a cumulative preview or final clip for one dictation session.
    /// Request files are removed after every reply; the Python stream cache may
    /// retain verified windows until the final request or worker termination.
    /// Legacy completed-window precomputation; it does not expose preview text.
    pub(super) fn transcribe_stream(
        &mut self,
        id: &str,
        wav: &[u8],
        cancelled: &AtomicBool,
        timeout: Duration,
        session_id: &str,
        final_request: bool,
    ) -> Result<Option<Value>, String> {
        self.transcribe_request(
            id,
            wav,
            cancelled,
            timeout,
            Some((session_id, final_request, false)),
        )
    }

    /// Live text contains the selected backend's immutable confirmed prefix.
    /// A separate draft may revise freely and is never sent to the foreground.
    pub(super) fn transcribe_live(&mut self, id: &str, wav: &[u8], cancelled: &AtomicBool,
        timeout: Duration, session_id: &str, final_request: bool) -> Result<Option<Value>, String> {
        self.transcribe_request(id, wav, cancelled, timeout, Some((session_id, final_request, true)))
    }

    fn transcribe_request(
        &mut self,
        id: &str,
        wav: &[u8],
        cancelled: &AtomicBool,
        timeout: Duration,
        stream: Option<(&str, bool, bool)>,
    ) -> Result<Option<Value>, String> {
        let began = Instant::now();
        let mut request_path = None;
        let reserved_bytes = wav.len().saturating_add(REQUEST_CLEANUP_OVERHEAD);
        let result = (|| {
            if cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            if !self.is_alive()? {
                return Err("The local dictation worker stopped. Please try again.".into());
            }
            let parsed = uuid::Uuid::parse_str(id)
                .map_err(|_| "Invalid dictation request identity.".to_owned())?;
            if parsed.to_string() != id {
                return Err("Invalid dictation request identity.".into());
            }
            let expected_stream = if let Some((session_id, final_request, live)) = stream {
                let parsed = uuid::Uuid::parse_str(session_id)
                    .map_err(|_| "Invalid dictation stream identity.".to_owned())?;
                if parsed.to_string() != session_id {
                    return Err("Invalid dictation stream identity.".into());
                }
                let mut descriptor = json!({"id": session_id, "final": final_request});
                if live { descriptor["live"] = json!(true); }
                Some(descriptor)
            } else {
                None
            };
            if self.used_ids.len() >= MAX_REQUESTS {
                return Err("The dictation worker needs to restart. Please try again.".into());
            }
            if !self.used_ids.insert(id.to_owned()) {
                return Err("This dictation request was already submitted.".into());
            }
            if wav.is_empty() || wav.len() > MAX_AUDIO_BYTES {
                return Err("Dictation audio is empty or too large.".into());
            }
            self.retry_pending_cleanup(Duration::ZERO);
            if self.pending_cleanup.len() >= MAX_PENDING_CLEANUPS
                || self.pending_cleanup.iter().map(|pending| pending.reserved_bytes).sum::<usize>()
                    .saturating_add(reserved_bytes) > MAX_PENDING_CLEANUP_BYTES {
                return Err("Temporary dictation files are still in use. Dictation stopped to avoid retaining more audio; any completed text is kept. Please try again.".into());
            }
            let path = self.root.path().join(id);
            // A fresh UUID directory and create_new files exclude stale results.
            fs::create_dir(&path)
                .map_err(|e| format!("Could not prepare dictation request: {e}"))?;
            request_path = Some(path.clone());
            let audio = path.join("input.wav");
            write_new(&audio, wav)?;
            let mut request = json!({
                "version": 1, "request_id": id, "audio_path": audio,
                "model": "trelis", "language_mode": "hinglish"
            });
            if let Some(stream) = &expected_stream {
                request["stream"] = stream.clone();
            }
            write_new(
                &path.join("request.json"),
                &serde_json::to_vec(&request).map_err(|e| e.to_string())?,
            )?;
            if cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            let mut line = serde_json::to_vec(
                &json!({"version": 1, "action": "transcribe", "request_id": id}),
            )
            .map_err(|e| e.to_string())?;
            line.push(b'\n');
            // This one small command fits the pipe even while initial warmup is
            // running; another command is never sent until a result arrives.
            self.stdin
                .as_mut()
                .ok_or("The dictation request channel is closed.")?
                .write_all(&line)
                .map_err(|e| format!("Could not submit dictation: {e}"))?;
            let output = path.join("result.json");
            loop {
                if cancelled.load(Ordering::Acquire) {
                    return Ok(None);
                }
                if began.elapsed() >= timeout {
                    return Err("Dictation took too long. Try a shorter phrase.".into());
                }
                if let Some(result) = read_json_optional(&output)? {
                    if result["version"] != 1 || result["request_id"] != id {
                        return Err("The local dictation result did not match this request.".into());
                    }
                    if result["status"] != "ok" {
                        return Err(worker_error(
                            &result,
                            "The local speech model could not transcribe this phrase.",
                        ));
                    }
                    if result.get("stream") != expected_stream.as_ref() {
                        return Err(
                            "The local dictation result did not match this stream request.".into(),
                        );
                    }
                    if !result["text"].is_string() {
                        return Err("The local dictation result has no text.".into());
                    }
                    if expected_stream.as_ref().is_some_and(|stream| stream["live"] == true) {
                        validate_live_result(&result, expected_stream.as_ref().unwrap()["final"] == true,
                            backend(&self.identity.config)?)?;
                    }
                    if cancelled.load(Ordering::Acquire) {
                        return Ok(None);
                    }
                    // A ready result from a dead process is not eligible for
                    // reuse and must not mask a failed process exit.
                    if !self.is_alive()? {
                        return Err("The local dictation worker stopped unexpectedly.".into());
                    }
                    return Ok(Some(result));
                }
                if !self.is_alive()? {
                    return Err("The local dictation worker stopped without a result.".into());
                }
                // Surface a warmup error without waiting for the whole deadline.
                self.is_ready()?;
                thread::sleep(POLL_INTERVAL.min(timeout.saturating_sub(began.elapsed())));
            }
        })();
        if !matches!(result, Ok(Some(_))) {
            self.terminate();
        }
        if let Some(path) = request_path {
            if let Err(error) = clean_request(self.root.path(), &path, CLEANUP_RETRY_BUDGET) {
                // Recognition and cleanup have separate outcomes. Windows file
                // scanners and delete-pending handles can outlive publication;
                // never discard validated words or kill a healthy stream for it.
                log::warn!("Dictation temporary cleanup deferred (OS code {:?}); transcription outcome preserved", error.raw_os_error());
                self.pending_cleanup.push(PendingCleanup { path, reserved_bytes });
            }
        }
        self.retry_pending_cleanup(Duration::ZERO);
        self.last_used = Instant::now();
        result
    }

    fn terminate(&mut self) {
        self.unusable = true;
        self.stdin.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn retry_pending_cleanup(&mut self, budget: Duration) {
        let deadline = Instant::now() + budget;
        self.pending_cleanup.retain(|pending| {
            clean_request(self.root.path(), &pending.path, deadline.saturating_duration_since(Instant::now())).is_err()
        });
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.terminate();
        self.retry_pending_cleanup(CLEANUP_RETRY_BUDGET);
    }
}

fn validate_confirmed_live_result(result: &Value, final_request: bool) -> Result<(), String> {
    let valid = (|| {
        let samples = result["audio_sample_count"].as_u64()?;
        let confirmed = result["confirmed_samples"].as_u64()?;
        let phrases = result["confirmed_phrase_count"].as_u64()?;
        result["live_endpoint_available"].as_bool()?;
        Some(result["live_delivery"] == "confirmed_phrases"
            && samples <= 120 * 16_000 && confirmed <= samples && phrases <= 256
            && (!final_request || confirmed == samples)
            && (confirmed != 0 || (phrases == 0 && result["text"].as_str()?.is_empty())))
    })().unwrap_or(false);
    if valid { Ok(()) } else {
        Err("The local dictation worker returned unconfirmed live text. Nothing further was typed.".into())
    }
}

fn validate_live_result(result: &Value, final_request: bool, selected: &str) -> Result<(), String> {
    if selected == "trelis" { return validate_confirmed_live_result(result, final_request); }
    let valid = (|| {
        let samples = result["audio_sample_count"].as_u64()?;
        let confirmed = result["confirmed_samples"].as_u64()?;
        let words = result["confirmed_word_count"].as_u64()?;
        let draft = result["draft_text"].as_str()?;
        let text = result["text"].as_str()?;
        Some(selected == "faster_whisper" && result["live_delivery"] == "stable_words"
            && samples <= 120 * 16_000 && confirmed <= samples && words <= 32_768
            && draft.encode_utf16().count() <= 32_768 && text.encode_utf16().count() <= 32_768
            && !draft.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            && (!final_request || (confirmed == samples && draft.is_empty()))
            && (words != 0 || text.trim().is_empty())
            && (samples != 0 || (words == 0 && draft.is_empty())))
    })().unwrap_or(false);
    if valid { Ok(()) } else {
        Err("The faster-whisper worker returned an invalid streaming result. Nothing further was typed.".into())
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

fn read_json_optional(path: &Path) -> Result<Option<Value>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("The local dictation result is not a regular file.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("The local dictation result must not be a linked file.".into());
        }
    }
    if metadata.len() > MAX_RESULT_BYTES {
        return Err("The local dictation result was too large.".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_RESULT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_RESULT_BYTES {
        return Err("The local dictation result was too large.".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "The local dictation result could not be read.".into())
}

fn worker_error(value: &Value, fallback: &str) -> String {
    value["error"]
        .as_str()
        .or_else(|| value["error"]["message"].as_str())
        .unwrap_or(fallback)
        .chars()
        .take(1000)
        .collect()
}

fn ordinary_entry(path: &Path, directory: bool) -> std::io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || metadata.file_attributes() & 0x400 != 0
    };
    if linked || (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Refusing cleanup of an unexpected dictation path"));
    }
    Ok(true)
}

fn clean_request_once(root: &Path, path: &Path) -> std::io::Result<()> {
    // Only fixed files under the UUID directory we successfully created. Never
    // follow a worker-supplied path or recursively delete an unexpected member.
    let canonical_id = path.file_name().and_then(|name| name.to_str())
        .and_then(|name| uuid::Uuid::parse_str(name).ok().map(|id| id.to_string() == name)) == Some(true);
    if path.parent() != Some(root) || !canonical_id || !root.is_absolute() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Refusing cleanup outside the owned dictation request"));
    }
    if !ordinary_entry(root, true)? || !ordinary_entry(path, true)? { return Ok(()); }
    for name in [
        "input.wav",
        "request.json",
        "dictation-window.wav",
        "result.json",
        "result.part",
    ] {
        let file = path.join(name);
        if !ordinary_entry(&file, false)? { continue; }
        match fs::remove_file(file) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn cleanup_can_retry(error: &std::io::Error) -> bool {
    // ERROR_ACCESS_DENIED (including delete-pending), SHARING_VIOLATION,
    // LOCK_VIOLATION, DIR_NOT_EMPTY (a pending deletion can keep a directory).
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(5 | 32 | 33 | 145)) { return true; }
    error.kind() == std::io::ErrorKind::Interrupted
}

fn clean_request(root: &Path, path: &Path, budget: Duration) -> std::io::Result<()> {
    let deadline = Instant::now() + budget;
    loop {
        match clean_request_once(root, path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if !cleanup_can_retry(&error) || remaining.is_zero() { return Err(error); }
                thread::sleep(CLEANUP_RETRY_INTERVAL.min(remaining));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::sync::Arc;

    struct Fixture {
        root: tempfile::TempDir,
        config: Value,
        script: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let script = root.path().join("worker.py");
            let registry = root.path().join("models.json");
            fs::write(&script, "fixture").unwrap();
            fs::write(&registry, "{}").unwrap();
            let config = json!({"python_executable":std::env::current_exe().unwrap(),
                "worker_script":script,"registry_path":registry});
            Self {
                root,
                config,
                script,
            }
        }
        fn worker(&self, mode: &str) -> Worker {
            let identity = Identity::read(&self.config, &self.script).unwrap();
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "__oats_warm_engine_fixture_child",
                    "--ignored",
                    "--test-threads=1",
                ])
                .env("OATS_ENGINE_FIXTURE_MODE", mode);
            Worker::spawn_command(identity, command).unwrap()
        }
    }

    fn publish(path: &Path, value: &Value) {
        let temp = path.with_extension("part");
        fs::write(&temp, serde_json::to_vec(value).unwrap()).unwrap();
        fs::rename(temp, path).unwrap();
    }

    /// Runs only as a filtered child, never imports a model or opens a microphone.
    #[test]
    #[ignore]
    fn __oats_warm_engine_fixture_child() {
        let mode = std::env::var("OATS_ENGINE_FIXTURE_MODE").unwrap();
        let root = PathBuf::from(std::env::var_os("OATS_ENGINE_FIXTURE_ROOT").unwrap());
        fs::write(root.join("fixture.pid"), std::process::id().to_string()).unwrap();
        // A failing parent test cannot orphan this synthetic process forever.
        thread::spawn(|| {
            thread::sleep(Duration::from_secs(30));
            std::process::exit(90);
        });
        if mode == "failed_ready" {
            publish(
                &root.join("ready.json"),
                &json!({"version":1,"status":"failed","error":"fixture warmup failed"}),
            );
        } else {
            publish(
                &root.join("ready.json"),
                &json!({"version":1,"status":"ok"}),
            );
        }
        let mut count = 0;
        #[cfg(windows)]
        let mut held_audio = Vec::new();
        for line in std::io::stdin().lock().lines() {
            #[cfg(windows)]
            if mode == "delete_pending_wav" { held_audio.clear(); }
            let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let id = request["request_id"].as_str().unwrap();
            let dir = root.join(id);
            if mode == "exit" {
                std::process::exit(7);
            }
            if mode == "wait" || mode == "failed_ready" {
                thread::sleep(Duration::from_secs(25));
                continue;
            }
            count += 1;
            let saved: Value =
                serde_json::from_slice(&fs::read(dir.join("request.json")).unwrap()).unwrap();
            assert_eq!(saved["request_id"], id);
            assert_eq!(saved["model"], "trelis");
            let audio = fs::read(dir.join("input.wav")).unwrap();
            if mode == "locked_wav" || mode == "delete_pending_wav" {
                assert_eq!(audio, synthetic_wav());
                #[cfg(windows)]
                if mode == "locked_wav" {
                    use std::os::windows::fs::OpenOptionsExt;
                    // Mimic an external reader that did not grant delete sharing.
                    held_audio.push(OpenOptions::new().read(true).share_mode(1)
                        .open(dir.join("input.wav")).unwrap());
                } else if count == 1 {
                    use std::os::windows::fs::OpenOptionsExt;
                    let path = dir.join("input.wav");
                    held_audio.push(OpenOptions::new().read(true).share_mode(7).open(&path).unwrap());
                    mark_delete_pending(&path);
                    // New Windows versions may unlink immediately instead of
                    // leaving the legacy access-denied delete-pending entry.
                    assert!(matches!(File::open(&path).unwrap_err().raw_os_error(), Some(2 | 5)));
                }
            } else {
                assert_eq!(audio, b"synthetic pcm");
            }
            if mode == "malformed" {
                fs::write(dir.join("result.json"), b"{no").unwrap();
            } else if mode == "oversized" {
                fs::write(
                    dir.join("result.json"),
                    vec![b' '; MAX_RESULT_BYTES as usize + 1],
                )
                .unwrap();
            } else {
                let result_id = if mode == "stale" { "stale-id" } else { id };
                let mut result = json!({"version":1,"status":"ok","request_id":result_id,
                    "text":"आज की notes are ready.","fixture_count":count});
                if let Some(stream) = saved.get("stream") {
                    result["stream"] = stream.clone();
                    if stream["live"] == true {
                        result["live_delivery"] = json!("confirmed_phrases");
                        result["live_endpoint_available"] = json!(true);
                        result["audio_sample_count"] = json!(32_000);
                        result["confirmed_samples"] = json!(32_000);
                        result["confirmed_phrase_count"] = json!(1);
                    }
                    match mode.as_str() {
                        "stream_wrong_id" => {
                            result["stream"]["id"] = json!(uuid::Uuid::nil().to_string())
                        }
                        "stream_wrong_final" => {
                            result["stream"]["final"] = json!(!stream["final"].as_bool().unwrap())
                        }
                        "stream_wrong_type" => result["stream"]["final"] = json!("false"),
                        "stream_extra" => result["stream"]["unexpected"] = json!(true),
                        "stream_missing" => {
                            result.as_object_mut().unwrap().remove("stream");
                        }
                        _ => (),
                    }
                }
                publish(&dir.join("result.json"), &result);
            }
        }
    }

    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn synthetic_wav() -> Vec<u8> {
        // Valid silent mono PCM16 WAV, with no microphone or recorded speech.
        let mut bytes = Vec::new();
        bytes.extend(b"RIFF"); bytes.extend(40u32.to_le_bytes()); bytes.extend(b"WAVEfmt ");
        bytes.extend(16u32.to_le_bytes()); bytes.extend(1u16.to_le_bytes()); bytes.extend(1u16.to_le_bytes());
        bytes.extend(16000u32.to_le_bytes()); bytes.extend(32000u32.to_le_bytes());
        bytes.extend(2u16.to_le_bytes()); bytes.extend(16u16.to_le_bytes());
        bytes.extend(b"data"); bytes.extend(4u32.to_le_bytes()); bytes.extend([0u8; 4]);
        bytes
    }
    fn transcribe(worker: &mut Worker, id: &str) -> Result<Option<Value>, String> {
        worker.transcribe(
            id,
            b"synthetic pcm",
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
    }
    fn wait_ready(worker: &mut Worker) {
        let began = Instant::now();
        while !worker.is_ready().unwrap() {
            assert!(began.elapsed() < Duration::from_secs(5));
            thread::sleep(POLL_INTERVAL);
        }
    }

    #[test]
    fn reuses_one_child_and_discards_each_completed_request() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("success");
        wait_ready(&mut worker);
        let pid = worker.child.as_ref().unwrap().id();
        for count in 1..=2 {
            let request = id();
            let result = transcribe(&mut worker, &request).unwrap().unwrap();
            assert_eq!(result["text"], "आज की notes are ready.");
            assert_eq!(result["fixture_count"], count);
            assert_eq!(worker.child.as_ref().unwrap().id(), pid);
            assert!(!worker.root.path().join(request).exists());
        }
        let path = worker.root.path().to_path_buf();
        drop(worker);
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_rejects_foreign_roots_non_uuid_paths_and_unexpected_members() {
        let root = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let foreign_request = foreign.path().join(id());
        fs::create_dir(&foreign_request).unwrap();
        fs::write(foreign_request.join("input.wav"), synthetic_wav()).unwrap();
        assert_eq!(clean_request(root.path(), &foreign_request, Duration::ZERO).unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
        assert!(foreign_request.join("input.wav").exists());
        let invalid = root.path().join("not-a-request");
        fs::create_dir(&invalid).unwrap();
        assert!(clean_request(root.path(), &invalid, Duration::ZERO).is_err());
        let request = root.path().join(id());
        fs::create_dir(&request).unwrap();
        fs::create_dir(request.join("input.wav")).unwrap();
        fs::write(request.join("input.wav").join("keep"), b"owned test sentinel").unwrap();
        assert_eq!(clean_request(root.path(), &request, Duration::ZERO).unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
        assert!(request.join("input.wav").join("keep").exists());
    }

    #[cfg(windows)]
    #[test]
    fn locked_windows_wav_is_removed_after_its_reader_closes() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        let request = root.path().join(id());
        fs::create_dir(&request).unwrap();
        let wav = request.join("input.wav");
        write_new(&wav, &synthetic_wav()).unwrap();
        let reader = OpenOptions::new().read(true).share_mode(1).open(&wav).unwrap();
        let error = clean_request(root.path(), &request, Duration::ZERO).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(32));
        let release = thread::spawn(move || { thread::sleep(Duration::from_millis(30)); drop(reader); });
        let result = clean_request(root.path(), &request, Duration::from_millis(250));
        release.join().unwrap();
        result.unwrap();
        assert!(!request.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_delete_pending_audio_preserves_result_and_worker_reuse() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("delete_pending_wav");
        let request = id();
        let result = worker.transcribe(&request, &synthetic_wav(), &AtomicBool::new(false), Duration::from_secs(5)).unwrap().unwrap();
        assert_eq!(result["fixture_count"], 1);
        assert!(!result["text"].as_str().unwrap().is_empty());
        assert!(worker.is_alive().unwrap());
        let wav = worker.root.path().join(&request).join("input.wav");
        // Win32 deletion happened while a reader retained the WAV handle.
        // Windows may unlink immediately; legacy delete-pending state and its
        // access-denied error must also leave the verified result usable.
        assert!(worker.pending_cleanup.len() <= 1);
        let next = worker.transcribe(&id(), &synthetic_wav(), &AtomicBool::new(false), Duration::from_secs(5)).unwrap().unwrap();
        assert_eq!(next["fixture_count"], 2);
        assert_eq!(next["text"], result["text"]);
        assert!(worker.pending_cleanup.is_empty());
        assert!(!wav.parent().unwrap().exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_transient_cleanup_errors_are_retryable_but_unsafe_paths_are_not() {
        for code in [5, 32, 33, 145] {
            assert!(cleanup_can_retry(&std::io::Error::from_raw_os_error(code)));
        }
        assert!(!cleanup_can_retry(&std::io::Error::new(std::io::ErrorKind::InvalidInput, "unexpected path")));
    }

    #[cfg(windows)]
    #[test]
    fn locked_requests_are_bounded_preserve_results_and_cleanup_after_reaping() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("locked_wav");
        wait_ready(&mut worker);
        let process = ProcessHandle::open(worker.child.as_ref().unwrap().id());
        let root = worker.root.path().to_owned();
        let mut completed = Vec::new();
        for _ in 0..MAX_PENDING_CLEANUPS {
            let result = worker.transcribe(&id(), &synthetic_wav(), &AtomicBool::new(false), Duration::from_secs(5)).unwrap().unwrap();
            completed.push(result);
        }
        assert_eq!(worker.pending_cleanup.len(), MAX_PENDING_CLEANUPS);
        assert!(worker.is_alive().unwrap());
        let blocked = id();
        let error = worker.transcribe(&blocked, &synthetic_wav(), &AtomicBool::new(false), Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("Temporary dictation files are still in use"));
        assert!(!root.join(blocked).exists());
        for (index, result) in completed.iter().enumerate() {
            assert_eq!(result["fixture_count"], index + 1);
            assert_eq!(result["text"], completed[0]["text"]);
        }
        process.assert_exited();
        drop(worker);
        assert!(!root.exists());
    }

    #[cfg(windows)]
    #[test]
    fn deferred_audio_byte_budget_stops_before_a_new_request_is_created() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("locked_wav");
        let completed = worker.transcribe(&id(), &synthetic_wav(), &AtomicBool::new(false), Duration::from_secs(5)).unwrap().unwrap();
        // Exercise the byte limit independently of the four-directory limit.
        worker.pending_cleanup[0].reserved_bytes = MAX_PENDING_CLEANUP_BYTES;
        let blocked = id();
        assert!(worker.transcribe(&blocked, &synthetic_wav(), &AtomicBool::new(false), Duration::from_secs(5))
            .unwrap_err().contains("Temporary dictation files are still in use"));
        assert!(!worker.root.path().join(blocked).exists());
        assert_eq!(completed["fixture_count"], 1);
        assert!(!completed["text"].as_str().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_stays_cancelled_when_an_external_reader_delays_cleanup() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let mut worker = fixture.worker("wait");
        wait_ready(&mut worker);
        let process = ProcessHandle::open(worker.child.as_ref().unwrap().id());
        let root = worker.root.path().to_owned();
        let request = id();
        let path = root.join(&request).join("input.wav");
        let cancelled = Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let owner = thread::spawn(move || {
            let result = worker.transcribe(&request, &synthetic_wav(), &cancelled, Duration::from_secs(5));
            (worker, result)
        });
        let began = Instant::now();
        let reader = loop {
            if let Ok(reader) = OpenOptions::new().read(true).share_mode(1).open(&path) { break reader; }
            assert!(began.elapsed() < Duration::from_secs(3), "synthetic request was not created");
            thread::sleep(Duration::from_millis(5));
        };
        signal.store(true, Ordering::Release);
        let (worker, result) = owner.join().unwrap();
        assert!(result.unwrap().is_none());
        process.assert_exited();
        assert_eq!(worker.pending_cleanup.len(), 1);
        drop(reader);
        drop(worker);
        assert!(!root.exists());
    }

    #[test]
    fn stream_previews_and_final_reuse_child_and_bind_each_reply() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("success");
        wait_ready(&mut worker);
        let pid = worker.child.as_ref().unwrap().id();
        let session = id();
        for (index, final_request) in [false, false, true].into_iter().enumerate() {
            let request = id();
            let result = worker
                .transcribe_stream(
                    &request,
                    b"synthetic pcm",
                    &AtomicBool::new(false),
                    Duration::from_secs(5),
                    &session,
                    final_request,
                )
                .unwrap()
                .unwrap();
            assert_eq!(
                result["stream"],
                json!({"id":session,"final":final_request})
            );
            assert_eq!(result["fixture_count"], index + 1);
            assert_eq!(worker.child.as_ref().unwrap().id(), pid);
            assert!(!worker.root.path().join(request).exists());
        }
        let normal = transcribe(&mut worker, &id()).unwrap().unwrap();
        assert_eq!(normal["fixture_count"], 4);
        assert!(normal.get("stream").is_none());
    }

    #[test]
    fn live_delivery_rejects_missing_confirmation_and_incomplete_final_audio() {
        let confirmed = json!({"text":"confirmed phrase", "live_delivery":"confirmed_phrases",
            "audio_sample_count":32000,"confirmed_samples":16000,"confirmed_phrase_count":1,"live_endpoint_available":true});
        assert!(validate_confirmed_live_result(&confirmed, false).is_ok());
        assert!(validate_confirmed_live_result(&confirmed, true).is_err());
        for (key, value) in [("live_delivery", json!("partial_hypothesis")),
            ("confirmed_samples", json!(0)), ("confirmed_samples", json!(32001)),
            ("audio_sample_count", json!(1920001)), ("live_endpoint_available", json!("true")),
            ("confirmed_phrase_count", json!(257))] {
            let mut invalid = confirmed.clone(); invalid[key] = value;
            assert!(validate_confirmed_live_result(&invalid, false).is_err(), "{key}");
        }
        let mut legacy = confirmed.clone(); legacy.as_object_mut().unwrap().remove("live_delivery");
        assert!(validate_confirmed_live_result(&legacy, false).is_err());
        let empty = json!({"text":"", "live_delivery":"confirmed_phrases", "audio_sample_count":32000,
            "confirmed_samples":0,"confirmed_phrase_count":0,"live_endpoint_available":false});
        assert!(validate_confirmed_live_result(&empty, false).is_ok());
    }

    #[test]
    fn streaming_contract_is_bound_to_the_selected_backend_and_draft_never_counts_as_stable() {
        let stable = json!({"text":"hello", "draft_text":"changing words", "live_delivery":"stable_words",
            "audio_sample_count":32000,"confirmed_samples":0,"confirmed_word_count":1});
        assert!(validate_live_result(&stable, false, "faster_whisper").is_ok());
        assert!(validate_live_result(&stable, false, "trelis").is_err());
        assert!(validate_live_result(&stable, true, "faster_whisper").is_err());
        let mut final_result = stable.clone();
        final_result["draft_text"] = json!(""); final_result["confirmed_samples"] = json!(32000);
        assert!(validate_live_result(&final_result, true, "faster_whisper").is_ok());
        for (key, value) in [("live_delivery", json!("confirmed_phrases")), ("confirmed_word_count", json!(0)),
            ("confirmed_samples", json!(32001)), ("draft_text", json!(null)),
            ("draft_text", json!("unexpected\u{0008}control")), ("audio_sample_count", json!(1920001))] {
            let mut invalid = stable.clone(); invalid[key] = value;
            assert!(validate_live_result(&invalid, false, "faster_whisper").is_err(), "{key}");
        }
        let draft_only = json!({"text":"", "draft_text":"unconfirmed", "live_delivery":"stable_words",
            "audio_sample_count":16000,"confirmed_samples":0,"confirmed_word_count":0});
        assert!(validate_live_result(&draft_only, false, "faster_whisper").is_ok());
    }

    #[test]
    fn explicit_backend_selection_never_silently_falls_back() {
        assert_eq!(backend(&json!({})).unwrap(), "trelis");
        assert_eq!(backend(&json!({"dictation_backend":"trelis"})).unwrap(), "trelis");
        assert_eq!(backend(&json!({"dictation_backend":"faster_whisper"})).unwrap(), "faster_whisper");
        for value in [json!(null), json!(true), json!("unknown")] {
            assert!(backend(&json!({"dictation_backend":value})).is_err());
        }
    }

    #[test]
    fn faster_whisper_identity_is_independent_of_meeting_runtime_and_tracks_its_model() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("dictation_worker.py");
        fs::write(&script, b"worker").unwrap();
        fs::write(root.path().join("faster_whisper_dictation.py"), b"backend").unwrap();
        let model = root.path().join("model"); fs::create_dir(&model).unwrap();
        for name in ["config.json", "model.bin", "tokenizer.json"] { fs::write(model.join(name), b"fixture").unwrap(); }
        let config = json!({"python_executable":std::env::current_exe().unwrap(), "dictation_backend":"faster_whisper",
            "faster_whisper":{"model_path":model,"cpu_threads":4}});
        let identity = Identity::read(&config, &script).unwrap();
        assert_eq!(identity.stamps.len(), 6);
        fs::write(model.join("model.bin"), b"changed model bytes").unwrap();
        assert!(identity != Identity::read(&config, &script).unwrap());
        fs::remove_file(model.join("tokenizer.json")).unwrap();
        assert!(Identity::read(&config, &script).is_err());
    }

    #[test]
    fn confirmed_live_phrases_bind_the_descriptor_and_share_the_resident_child() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("success");
        wait_ready(&mut worker);
        let session = id();
        let pid = worker.child.as_ref().unwrap().id();
        for final_request in [false, false, true] {
            let request = id();
            let reply = worker.transcribe_live(&request, b"synthetic pcm", &AtomicBool::new(false),
                Duration::from_secs(5), &session, final_request).unwrap().unwrap();
            assert_eq!(reply["stream"], json!({"id":session,"final":final_request,"live":true}));
            assert!(!reply["text"].as_str().unwrap().is_empty());
            assert_eq!(worker.child.as_ref().unwrap().id(), pid);
            assert!(!worker.root.path().join(request).exists());
        }
    }

    #[test]
    fn mismatched_stream_reply_kills_worker_without_returning_text() {
        for mode in [
            "stream_wrong_id",
            "stream_wrong_final",
            "stream_wrong_type",
            "stream_extra",
            "stream_missing",
        ] {
            let fixture = Fixture::new();
            let mut worker = fixture.worker(mode);
            let request = id();
            let result = worker.transcribe_stream(
                &request,
                b"synthetic pcm",
                &AtomicBool::new(false),
                Duration::from_secs(5),
                &id(),
                false,
            );
            assert!(result.unwrap_err().contains("stream request"), "{mode}");
            assert!(!worker.is_alive().unwrap());
            assert!(!worker.root.path().join(request).exists());
        }
    }

    #[test]
    fn invalid_stream_identity_is_rejected_before_request_publication() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("success");
        let request = id();
        let result = worker.transcribe_stream(
            &request,
            b"synthetic pcm",
            &AtomicBool::new(false),
            Duration::from_secs(5),
            "../outside",
            false,
        );
        assert!(result.unwrap_err().contains("stream identity"));
        assert!(!worker.is_alive().unwrap());
        assert!(!worker.root.path().join(request).exists());
    }

    #[test]
    fn changed_configuration_and_files_invalidate_reuse() {
        let fixture = Fixture::new();
        let worker = fixture.worker("success");
        assert!(worker.matches(&fixture.config, &fixture.script));
        let mut changed = fixture.config.clone();
        changed["language"] = json!("en");
        assert!(!worker.matches(&changed, &fixture.script));
        fs::write(
            fixture.root.path().join("models.json"),
            "{\"changed\":true}",
        )
        .unwrap();
        assert!(!worker.matches(&fixture.config, &fixture.script));
    }

    #[test]
    fn idle_deadline_is_reset_by_success() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("success");
        worker.last_used = Instant::now() - Duration::from_secs(60);
        assert!(worker.has_idle_expired(Duration::from_secs(30)));
        transcribe(&mut worker, &id()).unwrap();
        assert!(!worker.has_idle_expired(Duration::from_secs(30)));
    }

    #[test]
    fn rejects_invalid_and_replayed_request_identities() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("success");
        assert!(transcribe(&mut worker, "../outside")
            .unwrap_err()
            .contains("identity"));
        let mut worker = fixture.worker("success");
        let request = id();
        transcribe(&mut worker, &request).unwrap();
        assert!(transcribe(&mut worker, &request)
            .unwrap_err()
            .contains("already submitted"));
        assert!(!worker.is_alive().unwrap());
    }

    #[test]
    fn malformed_stale_oversized_and_dead_child_never_return_text() {
        for mode in ["malformed", "stale", "oversized", "exit", "failed_ready"] {
            let fixture = Fixture::new();
            let mut worker = fixture.worker(mode);
            let request = id();
            assert!(transcribe(&mut worker, &request).is_err(), "{mode}");
            assert!(!worker.is_alive().unwrap());
            assert!(!worker.root.path().join(request).exists());
        }
    }

    #[test]
    fn cancellation_and_timeout_reap_before_removing_audio() {
        for cancel in [true, false] {
            let fixture = Fixture::new();
            let mut worker = fixture.worker("wait");
            wait_ready(&mut worker);
            #[cfg(windows)]
            let process = ProcessHandle::open(worker.child.as_ref().unwrap().id());
            let flag = Arc::new(AtomicBool::new(false));
            let signal = flag.clone();
            let sender = thread::spawn(move || {
                thread::sleep(Duration::from_millis(60));
                if cancel {
                    signal.store(true, Ordering::Release);
                }
            });
            let request = id();
            let result = worker.transcribe(
                &request,
                b"synthetic pcm",
                &flag,
                Duration::from_millis(180),
            );
            sender.join().unwrap();
            if cancel {
                assert!(result.unwrap().is_none());
            } else {
                assert!(result.unwrap_err().contains("too long"));
            }
            assert!(!worker.is_alive().unwrap());
            assert!(!worker.root.path().join(request).exists());
            #[cfg(windows)]
            process.assert_exited();
        }
    }

    #[test]
    fn dropping_idle_worker_reaps_child_and_removes_root() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("success");
        wait_ready(&mut worker);
        #[cfg(windows)]
        let process = ProcessHandle::open(worker.child.as_ref().unwrap().id());
        let root = worker.root.path().to_owned();
        drop(worker);
        #[cfg(windows)]
        process.assert_exited();
        assert!(!root.exists());
    }

    #[test]
    fn stdin_eof_stops_worker() {
        let fixture = Fixture::new();
        let mut worker = fixture.worker("success");
        wait_ready(&mut worker);
        worker.stdin.take();
        let began = Instant::now();
        while worker.is_alive().unwrap() {
            assert!(began.elapsed() < Duration::from_secs(5));
            thread::sleep(POLL_INTERVAL);
        }
    }

    #[cfg(windows)]
    struct ProcessHandle(isize);
    #[cfg(windows)]
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
        fn CloseHandle(handle: isize) -> i32;
        fn DeleteFileW(path: *const u16) -> i32;
    }
    #[cfg(windows)]
    fn mark_delete_pending(path: &Path) {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        assert_ne!(unsafe { DeleteFileW(wide.as_ptr()) }, 0, "{}", std::io::Error::last_os_error());
    }
    #[cfg(windows)]
    impl ProcessHandle {
        fn open(pid: u32) -> Self {
            let handle = unsafe { OpenProcess(0x100000, 0, pid) };
            assert_ne!(handle, 0);
            Self(handle)
        }
        fn assert_exited(&self) {
            assert_eq!(
                unsafe { WaitForSingleObject(self.0, 0) },
                0,
                "dictation child survived cleanup"
            );
        }
    }
    #[cfg(windows)]
    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
