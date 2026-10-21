//! Ship the reviewed recording worker with the app. New jobs receive an
//! immutable copy; historical snapshots and the global model setup stay intact.
use std::{fs, io::Write, path::{Path, PathBuf}};
use serde_json::Value;
use sha2::{Digest, Sha256};

const FILES: &[(&str, &[u8])] = &[
    ("worker.py", b"import runpy\nrunpy.run_module('sttbench.local_worker', run_name='__main__')\n"),
    ("models.json", include_bytes!("../../../stt_lab/models.json")),
    ("sttbench/__init__.py", include_bytes!("../../../stt_lab/sttbench/__init__.py")),
    ("sttbench/__main__.py", include_bytes!("../../../stt_lab/sttbench/__main__.py")),
    ("sttbench/cli.py", include_bytes!("../../../stt_lab/sttbench/cli.py")),
    ("sttbench/execution.py", include_bytes!("../../../stt_lab/sttbench/execution.py")),
    ("sttbench/local_worker.py", include_bytes!("../../../stt_lab/sttbench/local_worker.py")),
    ("sttbench/manifest.py", include_bytes!("../../../stt_lab/sttbench/manifest.py")),
    ("sttbench/normalization.py", include_bytes!("../../../stt_lab/sttbench/normalization.py")),
    ("sttbench/reporting.py", include_bytes!("../../../stt_lab/sttbench/reporting.py")),
    ("sttbench/scoring.py", include_bytes!("../../../stt_lab/sttbench/scoring.py")),
    ("sttbench/speaker_reconciliation.py", include_bytes!("../../../stt_lab/sttbench/speaker_reconciliation.py")),
    ("sttbench/speaker_supervision.py", include_bytes!("../../../stt_lab/sttbench/speaker_supervision.py")),
    ("sttbench/speaker_worker.py", include_bytes!("../../../stt_lab/sttbench/speaker_worker.py")),
    ("sttbench/speech_gate.py", include_bytes!("../../../stt_lab/sttbench/speech_gate.py")),
    ("sttbench/runtime/__init__.py", include_bytes!("../../../stt_lab/sttbench/runtime/__init__.py")),
    ("sttbench/runtime/api.py", include_bytes!("../../../stt_lab/sttbench/runtime/api.py")),
    ("sttbench/runtime/assets.py", include_bytes!("../../../stt_lab/sttbench/runtime/assets.py")),
];

fn identity() -> String {
    let mut hash = Sha256::new();
    for (name, bytes) in FILES {
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    format!("{:x}", hash.finalize())
}

fn publish(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink()
                || fs::read(path).map_err(|e|e.to_string())? != bytes {
                return Err("Saved recording worker differs from the release; existing bytes were retained.".into());
            }
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.to_string()),
    }
    let parent = path.parent().ok_or("Recording worker parent is missing")?;
    fs::create_dir_all(parent).map_err(|e|e.to_string())?;
    let temporary = parent.join(format!(".worker-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e|e.to_string())?;
        file.write_all(bytes).map_err(|e|e.to_string())?;
        file.sync_all().map_err(|e|e.to_string())?;
        drop(file);
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => publish(path, bytes),
            Err(error) => Err(error.to_string()),
        }
    })();
    let _ = fs::remove_file(&temporary);
    result
}

pub(crate) fn candidate_config(job: &Path, current: &Path) -> Result<PathBuf, String> {
    // Let the existing snapshot validator handle old jobs, including an old
    // checkpoint missing its original snapshot. Never retrofit their engine.
    if job.join("runtime-snapshot.json").try_exists().map_err(|e|e.to_string())?
        || job.join("status.json").try_exists().map_err(|e|e.to_string())? {
        return Ok(current.to_owned());
    }
    let candidate = job.join("release-runtime-input.json");
    if candidate.try_exists().map_err(|e|e.to_string())? { return Ok(candidate); }
    let mut config: Value = serde_json::from_slice(&fs::read(current).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let python = config["python_executable"].as_str().ok_or("Local Python needs setup")?;
    if !Path::new(python).is_absolute() || !Path::new(python).is_file()
        || !config["models"].as_object().map(|models| !models.is_empty()).unwrap_or(false) {
        return Err("Set up the local Python and models before starting transcription.".into());
    }
    let id = identity();
    let directory = job.join(format!("worker-source-{id}"));
    if let Ok(metadata) = fs::symlink_metadata(&directory) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Recording worker directory must be an ordinary directory".into());
        }
    }
    for (name, bytes) in FILES { publish(&directory.join(name), bytes)?; }
    let directory = directory.canonicalize().map_err(|e|e.to_string())?;
    config["worker_script"] = Value::String(directory.join("worker.py").to_string_lossy().into_owned());
    config["registry_path"] = Value::String(directory.join("models.json").to_string_lossy().into_owned());
    config["worker_source_id"] = Value::String(id);
    publish(&candidate, &serde_json::to_vec_pretty(&config).map_err(|e|e.to_string())?)?;
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup(root: &Path) -> (PathBuf, PathBuf, Value) {
        let job = root.join("job"); fs::create_dir(&job).unwrap();
        let python = root.join("python.exe"); fs::write(&python, b"synthetic Python").unwrap();
        let config = json!({"python_executable":python, "worker_script":"old worker", "registry_path":"old registry",
            "models":{"trelis":{"device":"GPU", "artifact_path":"retained model"}},
            "speech_gate":{"threshold":0.15}, "custom_setting":"kept"});
        let current = root.join("runtime.json"); fs::write(&current, serde_json::to_vec(&config).unwrap()).unwrap();
        (job, current, config)
    }

    #[test]
    fn new_job_gets_complete_worker_without_changing_models_or_global_config() {
        let root = tempfile::tempdir().unwrap();
        let (job, current, original) = setup(root.path());
        let before = fs::read(&current).unwrap();
        let candidate = candidate_config(&job, &current).unwrap();
        let configured: Value = serde_json::from_slice(&fs::read(&candidate).unwrap()).unwrap();
        for key in ["models", "python_executable", "speech_gate", "custom_setting"] {
            assert_eq!(configured[key], original[key]);
        }
        assert_eq!(fs::read(&current).unwrap(), before);
        let source = Path::new(configured["worker_script"].as_str().unwrap()).parent().unwrap();
        for (name, bytes) in FILES { assert_eq!(fs::read(source.join(name)).unwrap(), *bytes); }
        assert_eq!(candidate_config(&job, &current).unwrap(), candidate);
    }

    #[test]
    fn existing_or_unmigrated_jobs_never_adopt_release_worker() {
        for marker in ["runtime-snapshot.json", "status.json"] {
            let root = tempfile::tempdir().unwrap();
            let (job, current, _) = setup(root.path());
            fs::write(job.join(marker), b"preserve original").unwrap();
            assert_eq!(candidate_config(&job, &current).unwrap(), current);
            assert_eq!(fs::read_dir(&job).unwrap().count(), 1);
            assert_eq!(fs::read(job.join(marker)).unwrap(), b"preserve original");
        }
    }

    #[test]
    fn incomplete_preparation_rejects_tampered_worker_without_replacing_it() {
        let root = tempfile::tempdir().unwrap();
        let (job, current, _) = setup(root.path());
        let directory = job.join(format!("worker-source-{}", identity()));
        fs::create_dir(&directory).unwrap();
        let worker = directory.join("worker.py"); fs::write(&worker, b"different saved worker").unwrap();
        assert!(candidate_config(&job, &current).is_err());
        assert_eq!(fs::read(worker).unwrap(), b"different saved worker");
        assert!(!job.join("release-runtime-input.json").exists());
    }
}
