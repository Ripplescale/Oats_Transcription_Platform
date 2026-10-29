#[path = "../../src/audio/durable_capture.rs"]
pub mod durable_capture;
#[cfg(test)]
#[path = "../../src/audio/recording_shutdown.rs"]
mod recording_shutdown;
#[cfg(test)]
#[path = "../../src/audio/capture_removal.rs"]
mod capture_removal;
#[path = "../../src/audio/source_archive.rs"]
pub mod source_archive;
#[path = "../../src/storage_retention.rs"]
pub mod storage_retention;

#[cfg(test)]
#[path = "../../src/bundled_asr_runtime.rs"]
mod bundled_asr_runtime;

#[cfg(test)]
#[path = "../../src/dictation/engine.rs"]
mod dictation_engine;
#[cfg(test)]
#[path = "../../src/dictation/pipeline.rs"]
mod dictation_pipeline;
#[cfg(test)]
#[path = "../../src/dictation/process.rs"]
mod dictation_process;
#[cfg(test)]
#[path = "../../src/dictation/live_delivery.rs"]
mod dictation_live_delivery;
#[cfg(test)]
#[path = "../../src/local_worker_policy.rs"]
mod local_worker_policy;
#[cfg(test)]
#[path = "../../src/local_worker_process.rs"]
mod local_worker_process;
#[cfg(all(test, windows))]
#[path = "../../src/dictation/windows.rs"]
mod dictation_windows;

#[allow(dead_code)]
mod workspace_components {
    include!(concat!(env!("OUT_DIR"), "/workspace_components.rs"));
}

#[cfg(test)]
mod worker_lifecycle {
    use serde_json::{json, Value};
    use crate::local_worker_policy::{WorkerActivity, WorkerKind};
    include!(concat!(env!("OUT_DIR"), "/worker_lifecycle.rs"));

    #[test]
    fn terminal_checkpoint_does_not_release_a_running_process_slot() {
        for state in ["complete", "failed", "stopped"] {
            let mut status = json!({"state":state,"segments":[{"text":"preserved"}]});
            project_worker_lifecycle(&mut status, false);
            assert_eq!(status["state"], "running");
            assert_eq!(status["checkpoint_state"], state);
            assert_eq!(status["segments"][0]["text"], "preserved");
            for kind in [WorkerKind::Transcription, WorkerKind::Speaker] {
                let mut active = WorkerActivity::default();
                active.observe_exit(kind, false);
                assert!(!active.admits(kind), "{state} checkpoint must not release {kind:?}");
                assert!(active.any_live());
            }
            let mut exited = json!({"state":state});
            project_worker_lifecycle(&mut exited, true);
            assert_eq!(exited["state"], state);
            for kind in [WorkerKind::Transcription, WorkerKind::Speaker] {
                let mut active = WorkerActivity::default();
                active.observe_exit(kind, true);
                assert!(active.admits(kind));
                assert!(!active.any_live());
            }
        }
        let mut waiting = json!({"state":"waiting_for_audio"});
        project_worker_lifecycle(&mut waiting, false);
        assert_eq!(waiting["state"], "waiting_for_audio");
    }
}

#[cfg(test)]
mod worker_process_policy {
    use crate::local_worker_policy::{WorkerActivity, WorkerKind};
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeChild { exited: bool, probe_failed: bool }
    impl FakeChild {
        fn try_wait(&mut self) -> Result<Option<()>, std::io::Error> {
            if self.probe_failed { return Err(std::io::Error::other("synthetic exit probe failure")); }
            Ok(self.exited.then_some(()))
        }
    }
    type WorkerChildren = HashMap<(WorkerKind, String), FakeChild>;
    include!(concat!(env!("OUT_DIR"), "/worker_activity.rs"));

    #[test]
    fn exact_process_probe_keeps_typed_slots_until_actual_exit() {
        let mut children = WorkerChildren::new();
        // Kind is explicit even if two caller-supplied job strings coincide.
        let asr = (WorkerKind::Transcription, "same-id".to_owned());
        let speaker = (WorkerKind::Speaker, "same-id".to_owned());
        children.insert(asr.clone(), FakeChild::default());
        let activity = worker_activity(&mut children).unwrap();
        assert!(!activity.admits(WorkerKind::Transcription));
        assert!(activity.admits(WorkerKind::Speaker));
        children.insert(speaker.clone(), FakeChild::default());
        let activity = worker_activity(&mut children).unwrap();
        assert!(!activity.admits(WorkerKind::Transcription));
        assert!(!activity.admits(WorkerKind::Speaker));
        children.get_mut(&asr).unwrap().exited = true;
        let activity = worker_activity(&mut children).unwrap();
        assert!(activity.admits(WorkerKind::Transcription));
        assert!(!activity.admits(WorkerKind::Speaker));
        assert!(activity.any_live());
        children.get_mut(&speaker).unwrap().exited = true;
        let activity = worker_activity(&mut children).unwrap();
        assert!(!activity.any_live());
    }

    #[test]
    fn failed_exit_probe_fails_closed_for_either_kind() {
        for kind in [WorkerKind::Transcription, WorkerKind::Speaker] {
            let mut children = WorkerChildren::new();
            children.insert((kind, "probe-error".into()), FakeChild { exited: true, probe_failed: true });
            assert!(worker_activity(&mut children).is_err());
        }
    }
}

#[cfg(test)]
mod transcription_checkpoints {
    use serde_json::{json, Value};
    use std::{fs, path::Path, time::Duration};
    include!(concat!(env!("OUT_DIR"), "/transcription_checkpoints.rs"));
}

#[cfg(all(test, windows))]
mod worker_deletion {
    use serde_json::{json,Value};
    use std::{collections::{HashMap,HashSet},fs,path::{Path,PathBuf},process::Command,sync::Mutex,time::{Duration,Instant}};
    use once_cell::sync::Lazy;
    use crate::{local_worker_policy::WorkerKind,local_worker_process::WorkerProcess,workspace_components::valid_id};
    type WorkerChildren=HashMap<(WorkerKind,String),WorkerProcess>;
    static CHILDREN:Lazy<Mutex<WorkerChildren>>=Lazy::new(||Mutex::new(HashMap::new()));
    static DELETING_SESSIONS:Lazy<Mutex<HashSet<String>>>=Lazy::new(||Mutex::new(HashSet::new()));
    include!(concat!(env!("OUT_DIR"),"/worker_deletion.rs"));
}

#[cfg(test)]
mod automatic_workflow {
    use serde_json::{json, Value};
    use std::{fs, path::Path};
    include!(concat!(env!("OUT_DIR"), "/automatic_workflow.rs"));
}

#[cfg(test)]
mod runtime_snapshots {
    use serde_json::{json, Value};
    use std::{fs, path::{Path, PathBuf}};
    include!(concat!(env!("OUT_DIR"), "/runtime_snapshots.rs"));

    #[test]
    fn release_worker_is_snapshotted_for_new_job_and_preserved_on_resume() {
        let root = tempfile::tempdir().unwrap();
        let job = root.path().join("new-job"); fs::create_dir(&job).unwrap();
        let current = root.path().join("runtime.json");
        let original = synthetic_asr_runtime(root.path(), "configured-models");
        let global_bytes = serde_json::to_vec(&original).unwrap();
        fs::write(&current, &global_bytes).unwrap();
        let candidate = crate::bundled_asr_runtime::candidate_config(&job, &current).unwrap();
        let snapshot = ensure_job_runtime_snapshot(&job, &candidate).unwrap();
        let committed = fs::read(&snapshot).unwrap();
        let configured = read(&snapshot).unwrap();
        assert_eq!(configured["models"], original["models"]);
        assert_ne!(configured["worker_script"], original["worker_script"]);
        assert_eq!(fs::read(&current).unwrap(), global_bytes);
        fs::write(job.join("status.json"), br#"{"state":"stopped"}"#).unwrap();
        fs::write(&current, b"unavailable global runtime after update").unwrap();
        let resumed = crate::bundled_asr_runtime::candidate_config(&job, &current).unwrap();
        assert_eq!(ensure_job_runtime_snapshot(&job, &resumed).unwrap(), snapshot);
        assert_eq!(fs::read(snapshot).unwrap(), committed);
    }
}

#[cfg(test)]
mod syntax_checks {
    /// Syntax coverage only: this deliberately does not claim a Tauri typecheck.
    #[test]
    fn modified_application_sources_parse() {
        for (name, source) in [
            ("recording_commands", include_str!("../../src/audio/recording_commands.rs")),
            ("recording_manager", include_str!("../../src/audio/recording_manager.rs")),
            ("recording_state", include_str!("../../src/audio/recording_state.rs")),
            ("recording_saver", include_str!("../../src/audio/recording_saver.rs")),
            ("stream", include_str!("../../src/audio/stream.rs")),
            ("device_monitor", include_str!("../../src/audio/device_monitor.rs")),
            ("pipeline", include_str!("../../src/audio/pipeline.rs")),
            ("local_workspace", include_str!("../../src/local_workspace.rs")),
            ("local_transcription", include_str!("../../src/local_transcription.rs")),
            ("local_worker_policy", include_str!("../../src/local_worker_policy.rs")),
            ("lib", include_str!("../../src/lib.rs")),
            ("dictation", include_str!("../../src/dictation/mod.rs")),
            ("dictation_capture", include_str!("../../src/dictation/capture.rs")),
        ] {
            syn::parse_file(source).unwrap_or_else(|error| panic!("{name}: {error}"));
        }
    }
}
