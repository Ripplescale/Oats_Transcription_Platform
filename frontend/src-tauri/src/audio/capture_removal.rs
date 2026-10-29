//! Explicit audio-only removal for interrupted source sessions. Never recursively
//! delete a session: notes, journal, identity and unknown files remain intact.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{fs, io::Write, path::{Path, PathBuf}};

pub const TOMBSTONE: &str = "source-audio-deleted.json";

fn metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(info) => {
            #[cfg(windows)]
            let linked = { use std::os::windows::fs::MetadataExt; info.file_attributes() & 0x400 != 0 };
            #[cfg(not(windows))]
            let linked = info.file_type().is_symlink();
            if linked { bail!("Linked source paths cannot be removed"); }
            Ok(Some(info))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn checked_file(root: &Path, path: &Path) -> Result<Option<u64>> {
    let relative = path.strip_prefix(root).context("Audio path escaped source session")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) { bail!("Invalid source audio path"); }
        current.push(component);
        if let Some(info) = metadata(&current)? {
            if current != path && !info.is_dir() { bail!("A source directory is occupied by a file"); }
        }
    }
    match metadata(path)? {
        Some(info) if info.is_file() => Ok(Some(info.len())),
        Some(_) => { bail!("An audio payload is occupied by a directory; nothing was recursively removed"); }
        None => Ok(None),
    }
}

pub fn removed(directory: &Path) -> bool {
    fs::read(directory.join(TOMBSTONE)).ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok())
        .map(|marker|marker["state"] == "deleted").unwrap_or(false)
}

fn write_marker(root: &Path, value: &Value) -> Result<()> {
    checked_file(root, &root.join(TOMBSTONE))?;
    let temporary = root.join(format!(".source-audio-deleted-{}.part", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?; file.sync_all()?; drop(file);
        fs::rename(&temporary, root.join(TOMBSTONE))?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}

/// Caller holds recording exclusion and a lease stopping this session's workers.
pub fn remove_audio(directory: &Path) -> Result<Value> {
    for ancestor in directory.ancestors() { metadata(ancestor)?; }
    let session:Value = serde_json::from_slice(&fs::read(directory.join("session.json"))?)?;
    let id = session["session_id"].as_str().context("Missing source session identity")?;
    uuid::Uuid::parse_str(id)?;
    if directory.file_name().and_then(|name|name.to_str()) != Some(id) { bail!("Source identity differs from its directory"); }
    if removed(directory) { return Ok(json!({"session_id":id,"audio_removed":true,"already_removed":true})); }
    let mut targets = Vec::<PathBuf>::new();
    for name in ["audio.wav","audio.wav.part","microphone.wav","microphone.wav.part","system.wav","system.wav.part","source-chunks.zip"] {
        let path = directory.join(name);
        if checked_file(directory, &path)?.is_some() { targets.push(path); }
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?; let name = entry.file_name(); let name = name.to_string_lossy();
        if let Some(identity) = name.strip_prefix(".source-chunks-").and_then(|name|name.strip_suffix(".part")) {
            if uuid::Uuid::parse_str(identity).is_ok() && checked_file(directory, &entry.path())?.is_some() { targets.push(entry.path()); }
        }
    }
    for track in ["microphone","system"] {
        let folder = directory.join("tracks").join(track);
        // Also validate parents when the track directory is absent.
        checked_file(directory, &folder.join("00000000.wav"))?;
        if metadata(&folder)?.is_none() { continue; }
        for entry in fs::read_dir(&folder)? {
            let entry = entry?; let path = entry.path();
            let stem = path.file_stem().and_then(|value|value.to_str()).unwrap_or("");
            let ext = path.extension().and_then(|value|value.to_str()).unwrap_or("");
            if stem.len() == 8 && stem.bytes().all(|b|b.is_ascii_digit()) && matches!(ext,"wav"|"part") {
                if checked_file(directory, &path)?.is_some() { targets.push(path); }
            }
        }
    }
    // A durable in-progress marker blocks future inference even if a process
    // crash interrupts deletion. The entry remains available to retry removal.
    write_marker(directory, &json!({"schema_version":1,"session_id":id,"state":"deleting"}))?;
    let mut bytes = 0u64;
    for path in &targets {
        if let Some(size) = checked_file(directory, path)? {
            fs::remove_file(path).with_context(||format!("Could not remove {}. Saved text is retained; retry deletion.",path.display()))?;
            bytes += size;
        }
    }
    let result = json!({"schema_version":1,"session_id":id,"state":"deleted","audio_removed":true,"removed_files":targets.len(),"removed_bytes":bytes,"saved_text_retained":true});
    write_marker(directory, &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let temp=tempfile::tempdir().unwrap(); let id=uuid::Uuid::new_v4().to_string(); let root=temp.path().join(&id);
        fs::create_dir_all(root.join("tracks/system")).unwrap();
        fs::write(root.join("session.json"),serde_json::to_vec(&json!({"session_id":id})).unwrap()).unwrap();
        fs::write(root.join("timeline.jsonl"),b"original journal").unwrap();
        fs::write(root.join("notes.txt"),b"saved notes").unwrap();
        fs::write(root.join("tracks/system/00000000.wav"),b"audio payload").unwrap();
        fs::write(root.join("audio.wav.part"),b"unfinished audio").unwrap();
        (temp,root)
    }
    #[test]
    fn interrupted_audio_removal_preserves_text_identity_journal_and_unknown_files() {
        let (_temp,root)=fixture(); fs::write(root.join("keep.bin"),b"unknown").unwrap();
        let result=remove_audio(&root).unwrap(); assert_eq!(result["removed_files"],2);
        assert!(removed(&root)); assert!(!root.join("tracks/system/00000000.wav").exists());
        assert_eq!(fs::read(root.join("notes.txt")).unwrap(),b"saved notes");
        assert_eq!(fs::read(root.join("timeline.jsonl")).unwrap(),b"original journal");
        assert_eq!(fs::read(root.join("keep.bin")).unwrap(),b"unknown");
        assert!(root.join("session.json").exists()); assert!(remove_audio(&root).is_ok());
        assert!(super::super::durable_capture::recover_capture(&root).unwrap_err().to_string().contains("explicitly removed"));
    }
    #[test]
    fn conflicting_payload_directory_is_preserved_before_any_deletion() {
        let (_temp,root)=fixture(); fs::create_dir(root.join("system.wav")).unwrap();
        assert!(remove_audio(&root).is_err()); assert!(!root.join(TOMBSTONE).exists());
        assert!(root.join("tracks/system/00000000.wav").exists());
    }
    #[test]
    fn eligible_unlinked_completed_capture_keeps_metadata_and_transcript_text() {
        let (_temp,root)=fixture();
        fs::write(root.join("metadata.json"),b"{\"status\":\"completed\"}").unwrap();
        fs::write(root.join("transcripts.json"),b"{\"text\":\"keep this\"}").unwrap();
        remove_audio(&root).unwrap();
        assert_eq!(fs::read(root.join("metadata.json")).unwrap(),b"{\"status\":\"completed\"}");
        assert_eq!(fs::read(root.join("transcripts.json")).unwrap(),b"{\"text\":\"keep this\"}");
    }
    #[test]
    fn interrupted_removal_is_retryable_and_not_hidden_until_complete() {
        let (_temp,root)=fixture();
        write_marker(&root,&json!({"state":"deleting"})).unwrap();
        fs::remove_file(root.join("audio.wav.part")).unwrap();
        assert!(!removed(&root));
        assert!(remove_audio(&root).unwrap()["audio_removed"] == true);
        assert!(removed(&root));
    }
    #[cfg(windows)]
    #[test]
    fn linked_track_directory_is_rejected_without_touching_external_audio() {
        use std::os::windows::process::CommandExt;
        let (_temp,root)=fixture(); let outside=tempfile::tempdir().unwrap();
        fs::write(outside.path().join("00000000.wav"),b"external audio").unwrap();
        fs::remove_file(root.join("tracks/system/00000000.wav")).unwrap();
        fs::remove_dir(root.join("tracks/system")).unwrap();
        let status=std::process::Command::new("powershell.exe").creation_flags(0x08000000)
            .args(["-NoProfile","-NonInteractive","-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:OATS_REMOVAL_TEST_LINK -Target $env:OATS_REMOVAL_TEST_TARGET | Out-Null"])
            .env("OATS_REMOVAL_TEST_LINK",root.join("tracks/system")).env("OATS_REMOVAL_TEST_TARGET",outside.path()).output().unwrap();
        assert!(status.status.success(),"{}",String::from_utf8_lossy(&status.stderr));
        assert!(remove_audio(&root).is_err());
        assert_eq!(fs::read(outside.path().join("00000000.wav")).unwrap(),b"external audio");
        assert!(root.join("audio.wav.part").exists());
        fs::remove_dir(root.join("tracks/system")).unwrap();
    }
}
