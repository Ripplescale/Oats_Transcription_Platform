//! Disposable inference WAVs. Callers serialize against capture/recovery and
//! worker launch; the worker lock additionally excludes an external worker.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn regular(path: &Path, directory: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt;
      if metadata.file_attributes() & 0x400 != 0 { bail!("Refusing reparse point: {}", path.display()); }
    }
    if metadata.file_type().is_symlink() || metadata.is_dir() != directory
        || (!directory && !metadata.is_file()) { bail!("Unexpected storage path: {}", path.display()); }
    Ok(())
}

fn window_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".wav") else { return false; };
    let mut parts = stem.split('-');
    if !matches!(parts.next(), Some("microphone" | "system")) { return false; }
    let parts: Vec<_> = parts.collect();
    let number = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match parts.as_slice() {
        [start] => number(start),
        [start, "retry", attempt] => number(start) && number(attempt),
        ["context" | "fringe", start, end] => number(start) && number(end),
        ["context" | "fringe", start, end, "retry", attempt] => number(start) && number(end) && number(attempt),
        _ => false,
    }
}

pub fn worker_guard(job: &Path) -> Result<fs::File> {
    for ancestor in job.ancestors().filter(|p| !p.as_os_str().is_empty()) { regular(ancestor, true)?; }
    if !matches!(job.parent().and_then(Path::file_name).and_then(|s|s.to_str()), Some("jobs" | "speaker-jobs")) {
        bail!("Expected a direct worker job directory");
    }
    let path = job.join("worker.lock");
    if path.try_exists()? { regular(&path, false)?; }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0); }
    #[cfg(not(windows))]
    bail!("Window retention requires the Windows exclusive worker handle");
    let mut file = options.open(path).context("Worker still owns its job; retention skipped")?;
    if file.metadata()?.len() == 0 {
        use std::io::Write;
        file.write_all(b"0")?;
        file.sync_all()?;
    }
    Ok(file)
}

/// Guard every existing job, including a worker started outside this app.
/// Caller excludes native launches while these handles are held.
pub fn all_worker_guards(root: &Path) -> Result<Vec<fs::File>> {
    let mut guards = Vec::new();
    for kind in ["jobs", "speaker-jobs"] {
        let parent = root.join(kind);
        if !parent.try_exists()? { continue; }
        regular(&parent, true)?;
        for entry in fs::read_dir(parent)? {
            let job = entry?.path();
            regular(&job, true)?;
            // Reserve even a not-yet-launched request's lock. Python opens it
            // before reading source audio, so it cannot race this maintenance.
            regular(&job.join("request.json"), false)?;
            guards.push(worker_guard(&job)?);
        }
    }
    Ok(guards)
}

/// Only derived windows from a durable complete checkpoint are candidates.
/// Status, requests, runtime snapshots and all transcript provenance survive.
pub fn prune_completed_windows(job: &Path) -> Result<Value> {
    // Refuse links in every component, including ancestors supplied by callers.
    for ancestor in job.ancestors().filter(|p| !p.as_os_str().is_empty()) { regular(ancestor, true)?; }
    if job.parent().and_then(Path::file_name).and_then(|s| s.to_str()) != Some("jobs") {
        bail!("Expected a direct transcription job directory");
    }
    let id = job.file_name().and_then(|s| s.to_str()).context("Missing job identity")?;
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        bail!("Invalid job identity");
    }
    let status_path = job.join("status.json");
    let request_path = job.join("request.json");
    regular(&status_path, false)?; regular(&request_path, false)?;
    let status_bytes = fs::read(&status_path)?;
    let status: Value = serde_json::from_slice(&status_bytes)?;
    let request_bytes = fs::read(&request_path)?;
    let request: Value = serde_json::from_slice(&request_bytes)?;
    if status["job_id"] != id || request["job_id"] != id { bail!("Job identity mismatch"); }
    if status["state"] != "complete" { return Ok(json!({"removed_files":0,"removed_bytes":0,"skipped":"unfinished"})); }
    let windows = job.join("windows");
    if !windows.try_exists()? { return Ok(json!({"removed_files":0,"removed_bytes":0})); }
    regular(&windows, true)?;
    let _lock = worker_guard(job)?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&windows)? {
        let entry = entry?;
        let path = entry.path();
        regular(&path, false)?;
        if !window_name(&entry.file_name().to_string_lossy()) { bail!("Unexpected inference cache member; preserving directory"); }
        candidates.push((path, entry.metadata()?.len()));
    }
    if status_bytes != fs::read(&status_path)? || request_bytes != fs::read(&request_path)? { bail!("Job changed before cleanup"); }
    let mut removed_bytes = 0;
    for (path, bytes) in &candidates {
        regular(path, false)?;
        fs::remove_file(path)?;
        removed_bytes += bytes;
    }
    Ok(json!({"removed_files":candidates.len(),"removed_bytes":removed_bytes}))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let job = root.path().join("jobs/example");
        fs::create_dir_all(job.join("windows")).unwrap();
        fs::write(job.join("worker.lock"), b"0").unwrap();
        fs::write(job.join("request.json"), br#"{"job_id":"example"}"#).unwrap();
        fs::write(job.join("status.json"), br#"{"job_id":"example","state":"complete","segments":[{"text":"preserve"}]}"#).unwrap();
        fs::write(job.join("windows/system-0.wav"), b"derived").unwrap();
        (root, job)
    }
    #[test] fn preserves_transcript_and_nonterminal_jobs() {
        let (_root, job) = fixture();
        let original = fs::read(job.join("status.json")).unwrap();
        assert_eq!(prune_completed_windows(&job).unwrap()["removed_files"], 1);
        assert_eq!(fs::read(job.join("status.json")).unwrap(), original);
        assert_eq!(prune_completed_windows(&job).unwrap()["removed_files"], 0);
        fs::write(job.join("windows/system-0.wav"), b"derived").unwrap();
        fs::write(job.join("status.json"), br#"{"job_id":"example","state":"failed"}"#).unwrap();
        assert_eq!(prune_completed_windows(&job).unwrap()["removed_files"], 0);
        assert!(job.join("windows/system-0.wav").is_file());
    }
    #[test] fn busy_or_unexpected_files_prevent_all_deletion() {
        let (_root, job) = fixture();
        let busy = fs::File::open(job.join("worker.lock")).unwrap();
        assert!(prune_completed_windows(&job).is_err());
        drop(busy);
        fs::write(job.join("windows/keep.txt"), b"unknown").unwrap();
        assert!(prune_completed_windows(&job).is_err());
        assert!(job.join("windows/system-0.wav").is_file());
    }
    #[test] fn cache_names_are_strict() {
        assert!(window_name("microphone-context-0-960000-retry-1.wav"));
        assert!(!window_name("audio.wav"));
        assert!(!window_name("../system-0.wav"));
    }
}
