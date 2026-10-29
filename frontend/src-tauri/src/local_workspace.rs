//! Local notes, correction history and source-backed project vaults.
//! Revisions are immutable files; readers never observe an incomplete write.
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::Mutex};
use crate::state::AppState;
use tauri::Manager;

static STORE_LOCK: Mutex<()> = Mutex::new(());

pub fn data_root() -> Result<PathBuf, String> {
    let explicit = std::env::var_os("STTAPP_DATA_DIR").map(PathBuf::from);
    if let Some(root) = explicit { return validate_data_root(root); }
    let default = dirs::data_local_dir().map(|p| p.join("STTApp"))
        .ok_or("Local application data directory is unavailable")?;
    let installed = std::env::current_exe().ok()
        .and_then(|exe| exe.parent().map(|p| p.join("sttapp-local-install.json")));
    resolve_data_root(&default.join("data-location.json"), installed.as_deref(), default)
}

fn validate_data_root(root: PathBuf) -> Result<PathBuf, String> {
    if !root.is_absolute() { return Err("STTAPP_DATA_DIR must be an absolute local directory".into()); }
    if root.components().any(|part| part.as_os_str().to_string_lossy().to_lowercase().starts_with("onedrive")) {
        return Err("Choose a local STTApp directory outside OneDrive".into());
    }
    Ok(root)
}

fn read_data_location(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err("The saved data location must be an ordinary local file".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Could not read the saved data location. {e}"))?;
    validate_data_root(value["data_root"].as_str().map(PathBuf::from)
        .ok_or("The saved data location is missing data_root")?)
}

fn resolve_data_root(location: &Path, installed: Option<&Path>, default: PathBuf) -> Result<PathBuf, String> {
    // An invalid saved choice must fail instead of silently opening empty notes elsewhere.
    if location.try_exists().map_err(|e| e.to_string())? { return read_data_location(location); }
    if let Some(path) = installed {
        if path.try_exists().map_err(|e| e.to_string())? { return read_data_location(path); }
    }
    validate_data_root(default)
}

fn preserve_data_root_at(location: &Path, root: &Path) -> Result<(), String> {
    validate_data_root(root.to_path_buf())?;
    if location.try_exists().map_err(|e| e.to_string())? {
        if read_data_location(location)? == root { return Ok(()); }
        return Err("The current data location differs from the saved choice. Preserve your chosen location before updating.".into());
    }
    let parent = location.parent().ok_or("The saved data location has no parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!("data-location-{}.part", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|e| e.to_string())?;
        let value = serde_json::json!({ "version": 1, "data_root": root });
        file.write_all(&serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        // Linking publishes a complete file without replacing a concurrent saved choice.
        match fs::hard_link(&temporary, location) {
            Ok(()) => Ok(()),
            Err(error) if location.try_exists().unwrap_or(false) => {
                if read_data_location(location)? == root { Ok(()) }
                else { Err(format!("The data location changed while preparing the update. {error}")) }
            }
            Err(error) => Err(error.to_string()),
        }
    })();
    let _ = fs::remove_file(&temporary);
    result
}

/// Keep the chosen location outside the installer before it replaces bundled files.
pub fn preserve_data_root() -> Result<(), String> {
    let root = data_root()?;
    let location = dirs::data_local_dir().map(|p| p.join("STTApp").join("data-location.json"))
        .ok_or("Local application data directory is unavailable")?;
    preserve_data_root_at(&location, &root)
}

#[cfg(test)]
mod data_location_tests {
    use super::*;

    #[test]
    fn saved_location_survives_installer_manifest_removal() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("chosen-notes");
        let default = temporary.path().join("default-data");
        let marker = temporary.path().join("installed").join("sttapp-local-install.json");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(&marker, serde_json::to_vec(&serde_json::json!({ "data_root": root })).unwrap()).unwrap();
        let location = default.join("data-location.json");
        assert_eq!(resolve_data_root(&location, Some(&marker), default.clone()).unwrap(), root);
        preserve_data_root_at(&location, &root).unwrap();
        fs::remove_file(marker).unwrap();
        assert_eq!(resolve_data_root(&location, None, default).unwrap(), root);
    }

    #[test]
    fn preserved_choice_wins_over_a_different_installer_default() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("chosen-notes");
        let location = temporary.path().join("preferences").join("data-location.json");
        preserve_data_root_at(&location, &root).unwrap();
        let marker = temporary.path().join("sttapp-local-install.json");
        fs::write(&marker, serde_json::to_vec(&serde_json::json!({ "data_root": temporary.path().join("other") })).unwrap()).unwrap();
        assert_eq!(resolve_data_root(&location, Some(&marker), temporary.path().join("default")).unwrap(), root);
    }

    #[test]
    fn invalid_saved_location_does_not_silently_open_empty_notes() {
        let temporary = tempfile::tempdir().unwrap();
        let location = temporary.path().join("data-location.json");
        for value in ["unfinished json", "{}", "{\"data_root\":\"relative-folder\"}"] {
            fs::write(&location, value).unwrap();
            assert!(resolve_data_root(&location, None, temporary.path().join("default")).is_err());
        }
    }

    #[test]
    fn preserving_location_never_overwrites_another_saved_choice() {
        let temporary = tempfile::tempdir().unwrap();
        let location = temporary.path().join("data-location.json");
        let root = temporary.path().join("chosen-notes");
        preserve_data_root_at(&location, &root).unwrap();
        let original = fs::read(&location).unwrap();
        preserve_data_root_at(&location, &root).unwrap();
        assert_eq!(fs::read(&location).unwrap(), original);
        assert!(preserve_data_root_at(&location, &temporary.path().join("other")).is_err());
        assert_eq!(fs::read(location).unwrap(), original);
    }
}

pub fn previous_speaker_snapshot(id: &str) -> Result<Option<serde_json::Value>,String> {
    let _guard=STORE_LOCK.lock().map_err(|e|e.to_string())?;
    let dir=object_dir(&data_root()?,"workspaces",id)?;
    let value=with_job_metadata(&dir,latest_revision(&dir)?.unwrap_or_else(||empty_workspace(id)))?;
    let mut result=value["speaker_metadata"].clone();
    if let Some(speakers)=result["speakers"].as_array_mut() {
        for speaker in speakers {
            if let Some(name)=speaker["id"].as_str().and_then(|id|value["speaker_names"][id].as_str()) {
                speaker["display_name"]=name.into();
            }
        }
        Ok(Some(result))
    } else { Ok(None) }
}

pub fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Invalid local object ID".into());
    }
    Ok(())
}

fn object_dir(root: &Path, collection: &str, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    Ok(root.join(collection).join(id))
}

pub fn latest_revision(dir: &Path) -> Result<Option<serde_json::Value>, String> {
    if !dir.exists() { return Ok(None); }
    let mut versions = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if let Some(version) = name.strip_prefix("revision-").and_then(|s| s.strip_suffix(".json")).and_then(|s| s.parse::<u64>().ok()) {
            versions.push((version, path));
        }
    }
    versions.sort_by_key(|v| v.0);
    match versions.last() {
        None => Ok(None),
        Some((revision, path)) => {
            let value: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if value["revision"].as_u64() != Some(*revision) { return Err("Stored revision is inconsistent; previous files were preserved".into()); }
            Ok(Some(value))
        }
    }
}

fn append_revision(dir: &Path, expected: u64, mut value: serde_json::Value) -> Result<serde_json::Value, String> {
    let current = latest_revision(dir)?.and_then(|v| v["revision"].as_u64()).unwrap_or(0);
    if current != expected { return Err("This workspace changed in another window. Reload before saving.".into()); }
    let revision = current.checked_add(1).ok_or("Revision limit reached")?;
    value["revision"] = revision.into();
    value["updated_at"] = Utc::now().to_rfc3339().into();
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let temp = dir.join(format!("{}.part", uuid::Uuid::new_v4()));
    let final_path = dir.join(format!("revision-{revision:012}.json"));
    let mut file = OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if final_path.exists() { return Err("Revision conflict; existing data was preserved".into()); }
    fs::rename(temp, final_path).map_err(|e| e.to_string())?;
    Ok(value)
}

const GENERATED_METADATA_REVISIONS_TO_KEEP: usize = 3;

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

fn generated_metadata_directory(root: &Path, id: &str, kind: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    if !root.is_absolute() || root.components().any(|part| matches!(part, std::path::Component::ParentDir | std::path::Component::CurDir))
        || !matches!(kind, "job-metadata" | "speaker-metadata") {
        return Err("Generated metadata retention received an unsafe path".into());
    }
    let mut path = root.to_path_buf();
    // Never follow a junction or link into another workspace or user history.
    for component in [None, Some("workspaces"), Some(id), Some(kind)] {
        if let Some(component) = component { path.push(component); }
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err("Generated metadata retention requires ordinary local directories".into());
        }
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canonical_dir = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical_dir.starts_with(&canonical_root) {
        return Err("Generated metadata escaped the local data directory".into());
    }
    Ok(canonical_dir)
}

/// Generated snapshots are caches of complete worker metadata. User-authored
/// workspace and vault revision streams never enter this retention path.
fn prune_generated_metadata(root: &Path, id: &str, kind: &str) -> Result<usize, String> {
    use sha2::{Digest, Sha256};
    let dir = generated_metadata_directory(root, id, kind)?;
    let mut revisions = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue; };
        if !name.starts_with("revision-") || !name.ends_with(".json") { continue; }
        let revision = name.strip_prefix("revision-").and_then(|s| s.strip_suffix(".json"))
            .and_then(|s| s.parse::<u64>().ok()).filter(|n| *n > 0)
            .ok_or("Generated metadata contains an invalid revision filename")?;
        if name != format!("revision-{revision:012}.json") {
            return Err("Generated metadata contains a noncanonical revision filename".into());
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || is_link_or_reparse(&metadata) {
            return Err("Generated metadata contains an unsafe revision path".into());
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if value["revision"].as_u64() != Some(revision) {
            return Err("Generated metadata is inconsistent; all snapshots were preserved".into());
        }
        let fingerprint: [u8; 32] = Sha256::digest(&bytes).into();
        revisions.push((revision, path, fingerprint));
    }
    revisions.sort_by_key(|entry| entry.0);
    let remove_count = revisions.len().saturating_sub(GENERATED_METADATA_REVISIONS_TO_KEEP);
    if remove_count == 0 { return Ok(0); }
    // Validate the whole batch before deleting anything. This also preserves
    // every snapshot when the latest file is corrupt or numbering is ambiguous.
    for (_, path, fingerprint) in &revisions {
        let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || is_link_or_reparse(&metadata)
            || <[u8; 32]>::from(Sha256::digest(fs::read(path).map_err(|e| e.to_string())?)) != *fingerprint {
            return Err("Generated metadata changed during retention; snapshots were preserved".into());
        }
    }
    if generated_metadata_directory(root, id, kind)? != dir {
        return Err("Generated metadata directory changed during retention".into());
    }
    for (_, path, _) in revisions.iter().take(remove_count) {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(remove_count)
}

fn retain_generated_metadata(root: &Path, id: &str, kind: &str) {
    // A completed save stays successful if an antivirus, permissions, or a
    // damaged older snapshot prevents optional cleanup. Retry on the next save.
    if let Err(error) = prune_generated_metadata(root, id, kind) {
        log::warn!("Skipped generated metadata retention for {id}/{kind}: {error}");
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Correction {
    pub segment_id: String,
    pub original_text: String,
    pub text: String,
    pub updated_at: String,
}

fn empty_workspace(id: &str) -> serde_json::Value {
    serde_json::json!({"version":1,"meeting_id":id,"revision":0,"notes":"","corrections":[],"project_id":null,"profile":null,"tags":[]})
}

// A folder deletion is one atomic tombstone. Existing workspace revisions and
// source references remain intact, while all readers project its notes as Unfiled.
fn effective_project(root: &Path, project: &serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(id) = project.as_str() {
        if latest_revision(&object_dir(root, "vaults", id)?)?.map(|v|v["archived"] == true).unwrap_or(false) {
            return Ok(serde_json::Value::Null);
        }
    }
    Ok(project.clone())
}

fn require_active_project(root: &Path, id: &str) -> Result<(), String> {
    let project = latest_revision(&object_dir(root, "vaults", id)?)?.ok_or("Folder no longer exists. Choose a folder before saving.")?;
    if project["archived"] == true { return Err("Folder was deleted. Reload before saving.".into()); }
    Ok(())
}

fn apply_notes_document(value: &mut serde_json::Value, document: Option<serde_json::Value>, clear: bool) -> Result<(), String> {
    if let Some(document) = document {
        if document["type"] != "doc" || !document["content"].is_array() || serde_json::to_vec(&document).map_err(|e|e.to_string())?.len() > 4_000_000 {
            return Err("Formatted note must be a document within the local size limit".into());
        }
        value["notes_document"] = document;
    } else if clear {
        value["notes_document"] = serde_json::Value::Null;
    }
    Ok(())
}

fn with_job_metadata(dir: &Path, mut value: serde_json::Value) -> Result<serde_json::Value,String> {
    if let Some(root) = dir.parent().and_then(Path::parent) {
        value["project_id"] = effective_project(root, &value["project_id"])?;
    }
    // Worker progress has its own immutable revision stream. It must not make
    // a user's unsaved notes/corrections stale every twenty seconds.
    if let Some(metadata)=latest_revision(&dir.join("job-metadata"))? {
        for key in ["source_job_id","source_meeting_id","profile","workflow_role","segment_metadata","superseded_segments","segments_revision"] {
            value[key]=metadata[key].clone();
        }
    }
    if let Some(speakers)=latest_revision(&dir.join("speaker-metadata"))? {
        value["speaker_metadata"]=speakers["result"].clone();
        value["speaker_job_id"]=speakers["source_job_id"].clone();
    }
    Ok(value)
}

#[tauri::command]
pub async fn load_transcript_workspace(state: tauri::State<'_, AppState>, meeting_id: String) -> Result<serde_json::Value, String> {
    valid_id(&meeting_id)?;
    let legacy: Option<(Option<String>, Option<String>)> = sqlx::query_as("SELECT notes_markdown, notes_json FROM meeting_notes WHERE meeting_id = ?")
        .bind(&meeting_id).fetch_optional(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = object_dir(&data_root()?, "workspaces", &meeting_id)?;
    if let Some(value)=latest_revision(&dir)? { return with_job_metadata(&dir,value); }
    let mut value=empty_workspace(&meeting_id);
    if let Some((markdown,structured))=legacy {
        value["notes"]=markdown.unwrap_or_default().into();
        value["legacy_notes_json"]=serde_json::to_value(structured).map_err(|e|e.to_string())?;
        let saved=append_revision(&dir,0,value)?;
        return with_job_metadata(&dir,saved);
    }
    with_job_metadata(&dir,value)
}

#[tauri::command]
pub async fn save_transcript_workspace(
    state: tauri::State<'_, AppState>, meeting_id: String, expected_revision: u64,
    notes: String, corrections: Vec<Correction>, project_id: Option<String>, profile: Option<String>,
    speaker_names: Option<std::collections::HashMap<String,String>>,
    notes_document: Option<serde_json::Value>, clear_notes_document: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _update_lease = crate::updates::start_lease()?;
    valid_id(&meeting_id)?;
    if notes.len() > 2_000_000 || corrections.len() > 20000 { return Err("Workspace is too large".into()); }
    if let Some(id) = &project_id { valid_id(id)?; }
    // Historical chunk profiles remain readable/editable even after new jobs
    // are restricted to the selected twenty-second settings.
    if let Some(id) = &profile { valid_id(id)?; }
    let mut ids = HashSet::new();
    for c in &corrections {
        if !ids.insert(&c.segment_id) || c.text.len() > 100_000 { return Err("Duplicate or oversized correction".into()); }
        // An archived correction remains a saved reference. The frontend only
        // applies it when its original_text exactly matches current raw text.
        if !crate::local_transcription::correction_source_matches(state.db_manager.pool(),&meeting_id,&c.segment_id,&c.original_text).await? {
            return Err("A correction no longer matches a verified transcript source. Reload before saving.".into());
        }
    }
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    let root = data_root()?;
    // Historical workspaces can refer to an unavailable folder. Keep those
    // editable, but do not let a stale editor resurrect a deleted folder.
    if let Some(id) = &project_id {
        if latest_revision(&object_dir(&root, "vaults", id)?)?.map(|value|value["archived"] == true).unwrap_or(false) {
            return Err("Folder was deleted. Reload before saving.".into());
        }
    }
    let dir = object_dir(&root, "workspaces", &meeting_id)?;
    let mut value = latest_revision(&dir)?.unwrap_or_else(|| empty_workspace(&meeting_id));
    apply_notes_document(&mut value, notes_document, clear_notes_document.unwrap_or(false))?;
    if let Some(names)=speaker_names {
        if names.len()>100 || names.values().any(|name|name.len()>200) { return Err("Speaker names exceed local limits".into()); }
        for id in names.keys() { valid_id(id)?; }
        value["speaker_names"]=serde_json::to_value(names).map_err(|e|e.to_string())?;
    }
    value["notes"] = notes.into(); value["corrections"] = serde_json::to_value(corrections).map_err(|e|e.to_string())?;
    value["project_id"] = serde_json::to_value(project_id).map_err(|e|e.to_string())?;
    value["profile"] = serde_json::to_value(profile).map_err(|e|e.to_string())?;
    let saved=append_revision(&dir, expected_revision, value)?;
    with_job_metadata(&dir,saved)
}

/// Autosaving a note must never replace transcript corrections or speaker names
/// with a stale copy held by a notes-only editor.
fn save_meeting_note_at(root: &Path, meeting_id: &str, expected_revision: u64,
    notes: String, project_id: Option<String>, legacy: Option<(Option<String>, Option<String>)>,
    notes_document: Option<serde_json::Value>, clear_notes_document: bool,
) -> Result<serde_json::Value, String> {
    valid_id(meeting_id)?;
    if notes.len() > 2_000_000 { return Err("Note is too large".into()); }
    if let Some(id) = &project_id {
        require_active_project(root, id)?;
    }
    let dir = object_dir(root, "workspaces", meeting_id)?;
    let current = latest_revision(&dir)?;
    let mut value = current.clone().unwrap_or_else(|| empty_workspace(meeting_id));
    if current.is_none() {
        if let Some((markdown, structured)) = legacy {
            value["notes"] = markdown.unwrap_or_default().into();
            value["legacy_notes_json"] = serde_json::to_value(structured).map_err(|e|e.to_string())?;
        }
    }
    if value["revision"].as_u64().unwrap_or(0) != expected_revision {
        return Err("This workspace changed in another window. Reload before saving.".into());
    }
    let project = serde_json::to_value(project_id).map_err(|e|e.to_string())?;
    let previous_document = value["notes_document"].clone();
    apply_notes_document(&mut value, notes_document, clear_notes_document)?;
    if current.is_some() && value["notes"] == notes && value["project_id"] == project && value["notes_document"] == previous_document {
        return with_job_metadata(&dir, value);
    }
    value["notes"] = notes.into();
    value["project_id"] = project;
    with_job_metadata(&dir, append_revision(&dir, expected_revision, value)?)
}

#[tauri::command]
pub async fn save_meeting_note(state: tauri::State<'_, AppState>, meeting_id: String,
    expected_revision: u64, notes: String, project_id: Option<String>,
    notes_document: Option<serde_json::Value>, clear_notes_document: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _update_lease = crate::updates::start_lease()?;
    valid_id(&meeting_id)?;
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM meetings WHERE id = ?")
        .bind(&meeting_id).fetch_one(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    if exists == 0 { return Err("Conversation no longer exists. Your draft was not saved.".into()); }
    let legacy: Option<(Option<String>, Option<String>)> = sqlx::query_as("SELECT notes_markdown, notes_json FROM meeting_notes WHERE meeting_id = ?")
        .bind(&meeting_id).fetch_optional(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    save_meeting_note_at(&data_root()?, &meeting_id, expected_revision, notes, project_id, legacy, notes_document, clear_notes_document.unwrap_or(false))
}

pub fn set_speaker_metadata(id: &str, job: &str, result: &serde_json::Value) -> Result<(),String> {
    let _guard=STORE_LOCK.lock().map_err(|e|e.to_string())?;
    set_speaker_metadata_at(&data_root()?,id,job,result)
}

fn set_speaker_metadata_at(root: &Path, id: &str, job: &str, result: &serde_json::Value) -> Result<(),String> {
    if !result["speakers"].is_array() || !result["turns"].is_array() || !result["segment_assignments"].is_object() {
        return Err("Speaker result is incomplete; prior names and assignments were preserved".into());
    }
    let dir=object_dir(root,"workspaces",id)?.join("speaker-metadata");
    let previous=latest_revision(&dir)?;
    if previous.as_ref().map(|p|p["source_job_id"]==job && &p["result"]==result).unwrap_or(false) { return Ok(()); }
    let expected=previous.and_then(|p|p["revision"].as_u64()).unwrap_or(0);
    append_revision(&dir,expected,serde_json::json!({"version":1,"source_job_id":job,"result":result}))?;
    retain_generated_metadata(root,id,"speaker-metadata");
    Ok(())
}

pub fn set_job_metadata(id: &str, parent: &str, job: &str, status: &serde_json::Value) -> Result<(),String> {
    let _guard=STORE_LOCK.lock().map_err(|e|e.to_string())?;
    set_job_metadata_at(&data_root()?,id,parent,job,status)
}

fn set_job_metadata_at(root: &Path, id: &str, parent: &str, job: &str, status: &serde_json::Value) -> Result<(),String> {
    let dir=object_dir(root,"workspaces",id)?.join("job-metadata");
    let mut value=latest_revision(&dir)?.unwrap_or_else(||serde_json::json!({"version":1,"revision":0}));
    if let Some(previous_job)=value["source_job_id"].as_str() {
        if previous_job!=job { return Err("Workspace metadata belongs to another job".into()); }
        let old=value["segments_revision"].as_u64();
        let new=status["segments_revision"].as_u64();
        if old.is_some() && (new.is_none() || new<old) { return Ok(()); }
        if old==new && value["worker_updated_at"].as_str().zip(status["updated_at"].as_str())
            .and_then(|(a,b)|Some((chrono::DateTime::parse_from_rfc3339(a).ok()?,chrono::DateTime::parse_from_rfc3339(b).ok()?)))
            .map(|(a,b)|b<a).unwrap_or(false) { return Ok(()); }
    }
    let mut metadata=serde_json::Map::new();
    for segment in status["segments"].as_array().ok_or("Missing segments")? {
        if let Some(sid)=segment["id"].as_str() {
            let mut item=serde_json::json!({"source_track":segment["source_track"],"timestamp_kind":"audio_window",
                "quality_flags":segment["quality_flags"],"alternative":segment["alternative"],
                "recovery":segment["recovery"],"replaces_segment_ids":segment["replaces_segment_ids"]});
            if let Some(original)=segment["recognition_original"]["text"].as_str() {
                if segment["alternative"]["promoted"]==true || segment["text"].as_str().map(|text|text!=original).unwrap_or(false) {
                    item["original_recognition_text"]=original.into();
                }
            }
            metadata.insert(sid.into(),item);
        }
    }
    let archive=status.get("superseded_segments").cloned().unwrap_or_else(||serde_json::json!([]));
    if !archive.is_array() { return Err("Invalid superseded transcript metadata".into()); }
    if value["source_job_id"]==job && value["segment_metadata"]==serde_json::Value::Object(metadata.clone())
        && value["superseded_segments"]==archive && value["segments_revision"]==status["segments_revision"]
        && value["worker_updated_at"]==status["updated_at"] { return Ok(()); }
    let expected=value["revision"].as_u64().unwrap_or(0);
    value["source_job_id"]=job.into(); value["source_meeting_id"]=parent.into(); value["profile"]=status["profile"].clone();
    value["workflow_role"]=status["workflow_role"].clone();
    value["segment_metadata"]=metadata.into();
    value["superseded_segments"]=archive;
    value["segments_revision"]=status["segments_revision"].clone();
    value["worker_updated_at"]=status["updated_at"].clone();
    append_revision(&dir,expected,value)?;
    retain_generated_metadata(root,id,"job-metadata");
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VaultEntry {
    pub id: String, pub kind: String, pub canonical: String,
    #[serde(default)] pub aliases: Vec<String>,
    pub source: String, pub verified: bool,
    #[serde(default)] pub context: String,
    #[serde(default)] pub unit: String,
    #[serde(default)] pub valid_from: String,
    #[serde(default)] pub valid_to: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VaultRelationship {
    pub subject_id: String, pub predicate: String, pub object_id: String,
    pub source: String, pub verified: bool,
}

fn validate_vault(entries: &[VaultEntry], relationships: &[VaultRelationship]) -> Result<(), String> {
    if entries.len() > 10000 || relationships.len() > 20000 { return Err("Vault exceeds local limits".into()); }
    let mut ids = HashSet::new();
    for entry in entries {
        valid_id(&entry.id)?;
        if !ids.insert(entry.id.as_str()) || entry.canonical.trim().is_empty() || entry.canonical.len() > 1000
            || !["person","organization","place","acronym","term","quantity"].contains(&entry.kind.as_str()) {
            return Err("Each vault entry needs a unique ID, supported type and name".into());
        }
        if entry.aliases.len() > 50 || entry.aliases.iter().any(|a| a.trim().is_empty() || a.len() > 1000) { return Err("Invalid aliases".into()); }
        if entry.source.len() > 10000 || entry.context.len() > 10000 { return Err("Vault source or context is too long".into()); }
        if entry.verified && entry.source.trim().is_empty() { return Err("Verified entries need a source".into()); }
        if entry.verified && entry.kind == "quantity" && (entry.context.trim().is_empty() || entry.unit.trim().is_empty()) {
            return Err("Verified quantities need units and a specific context; a number is not a universal correction".into());
        }
        for date in [&entry.valid_from, &entry.valid_to] {
            if !date.is_empty() && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() { return Err("Validity dates must use YYYY-MM-DD".into()); }
        }
        if !entry.valid_from.is_empty() && !entry.valid_to.is_empty() && entry.valid_from > entry.valid_to { return Err("Validity dates are reversed".into()); }
    }
    for edge in relationships {
        if !ids.contains(edge.subject_id.as_str()) || !ids.contains(edge.object_id.as_str()) || edge.predicate.trim().is_empty()
            || (edge.verified && edge.source.trim().is_empty()) { return Err("Relationships need valid entry IDs, a predicate and a source when verified".into()); }
    }
    Ok(())
}

fn default_vault() -> serde_json::Value {
    serde_json::json!({"version":1,"id":"tapf","name":"TAPF Vault","revision":0,"entries":[],"relationships":[]})
}

#[tauri::command]
pub fn load_project_vault(project_id: String) -> Result<serde_json::Value, String> {
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = object_dir(&data_root()?, "vaults", &project_id)?;
    match latest_revision(&dir)? {
        Some(value) => Ok(value),
        None if project_id == "tapf" => append_revision(&dir, 0, default_vault()),
        None => Err("Project vault does not exist".into()),
    }
}

#[tauri::command]
pub fn list_project_vaults() -> Result<Vec<serde_json::Value>, String> {
    // Ensure the user's requested empty TAPF Vault exists; no guessed facts.
    load_project_vault("tapf".into())?;
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for entry in fs::read_dir(data_root()?.join("vaults")).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() { if let Some(vault) = latest_revision(&path)? { if vault["archived"] != true { result.push(vault); } } }
    }
    result.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_owned());
    Ok(result)
}

#[tauri::command]
pub fn save_project_vault(project_id: String, expected_revision: u64, name: String,
    entries: Vec<VaultEntry>, relationships: Vec<VaultRelationship>) -> Result<serde_json::Value, String> {
    let _update_lease = crate::updates::start_lease()?;
    if name.trim().is_empty() || name.len() > 200 { return Err("A project vault needs a name".into()); }
    validate_vault(&entries, &relationships)?;
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    require_active_project(&data_root()?, &project_id)?;
    append_revision(&object_dir(&data_root()?, "vaults", &project_id)?, expected_revision,
        serde_json::json!({"version":1,"id":project_id,"name":name,"entries":entries,"relationships":relationships}))
}

fn project_summary(vault: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({"id":vault["id"],"name":vault["name"],"revision":vault["revision"],
        "entry_count":vault["entries"].as_array().map(|entries|entries.len()).unwrap_or(0)})
}

fn validate_project_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 || name.chars().any(char::is_control) {
        return Err("Choose a project name between 1 and 200 bytes without control characters".into());
    }
    Ok(name.to_owned())
}

fn create_project_at(root: &Path, name: &str) -> Result<serde_json::Value, String> {
    let name = validate_project_name(name)?;
    let id = uuid::Uuid::new_v4().to_string();
    let value = append_revision(&object_dir(root, "vaults", &id)?, 0,
        serde_json::json!({"version":1,"id":id,"name":name,"entries":[],"relationships":[]}))?;
    Ok(project_summary(&value))
}

fn rename_project_at(root: &Path, project_id: &str, expected_revision: u64, name: &str) -> Result<serde_json::Value, String> {
    let name = validate_project_name(name)?;
    let dir = object_dir(root, "vaults", project_id)?;
    let mut value = latest_revision(&dir)?.ok_or("Project no longer exists")?;
    if value["archived"] == true { return Err("Folder was deleted. Reload before renaming.".into()); }
    value["name"] = name.into();
    Ok(project_summary(&append_revision(&dir, expected_revision, value)?))
}

#[tauri::command]
pub fn create_project(name: String) -> Result<serde_json::Value, String> {
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    create_project_at(&data_root()?, &name)
}

#[tauri::command]
pub fn rename_project(project_id: String, expected_revision: u64, name: String) -> Result<serde_json::Value, String> {
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    rename_project_at(&data_root()?, &project_id, expected_revision, &name)
}

fn archive_project_at(root: &Path, project_id: &str, expected_revision: u64) -> Result<serde_json::Value, String> {
    let dir = object_dir(root, "vaults", project_id)?;
    let mut value = latest_revision(&dir)?.ok_or("Folder no longer exists")?;
    if value["archived"] == true { return Err("Folder was already deleted. Reload your notes.".into()); }
    value["archived"] = true.into();
    value["archived_at"] = Utc::now().to_rfc3339().into();
    append_revision(&dir, expected_revision, value)
}

#[tauri::command]
pub fn archive_project(project_id: String, expected_revision: u64) -> Result<serde_json::Value, String> {
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    archive_project_at(&data_root()?, &project_id, expected_revision)
}

fn normalized_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.len() > 30 { return Err("Use at most 30 tags per note".into()); }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for tag in tags {
        if tag.chars().any(char::is_control) { return Err("Tags cannot contain control characters".into()); }
        let name = tag.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() || name.chars().count() > 50 { return Err("Each tag needs between 1 and 50 characters".into()); }
        if seen.insert(name.to_lowercase()) { result.push(name); }
    }
    result.sort_by_key(|tag|tag.to_lowercase());
    Ok(result)
}

fn workspace_tags(value: &serde_json::Value) -> Result<Vec<String>, String> {
    match value.get("tags") {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(tags) => normalized_tags(serde_json::from_value(tags.clone()).map_err(|_|"Stored tags could not be read")?),
    }
}

fn global_tag_names(root: &Path) -> Result<Vec<String>, String> {
    let dir = root.join("workspaces");
    if !dir.exists() { return Ok(Vec::new()); }
    let mut paths = fs::read_dir(dir).map_err(|e|e.to_string())?.map(|entry|entry.map(|e|e.path()).map_err(|e|e.to_string())).collect::<Result<Vec<_>,_>>()?;
    paths.sort();
    let mut names = std::collections::BTreeMap::new();
    for path in paths {
        if path.is_dir() {
            if let Some(value) = latest_revision(&path)? {
                for tag in workspace_tags(&value)? { names.entry(tag.to_lowercase()).or_insert(tag); }
            }
        }
    }
    Ok(names.into_values().collect())
}

fn metadata_workspace(root: &Path, meeting_id: &str, legacy: Option<(Option<String>, Option<String>)>) -> Result<(PathBuf, serde_json::Value), String> {
    let dir = object_dir(root, "workspaces", meeting_id)?;
    let mut value = latest_revision(&dir)?.unwrap_or_else(||empty_workspace(meeting_id));
    if value["revision"] == 0 {
        if let Some((notes, structured)) = legacy {
            value["notes"] = notes.unwrap_or_default().into();
            value["legacy_notes_json"] = serde_json::to_value(structured).map_err(|e|e.to_string())?;
        }
    }
    Ok((dir, value))
}

fn set_meeting_tags_at(root: &Path, meeting_id: &str, expected_tags: Vec<String>, tags: Vec<String>, legacy: Option<(Option<String>, Option<String>)>) -> Result<serde_json::Value, String> {
    let (dir, mut value) = metadata_workspace(root, meeting_id, legacy)?;
    let current = workspace_tags(&value)?;
    if current != normalized_tags(expected_tags)? { return Err("This note's tags changed. Reload before saving tags.".into()); }
    let names = global_tag_names(root)?;
    let mut tags = normalized_tags(tags)?;
    for tag in &mut tags {
        if let Some(name) = names.iter().find(|name|name.to_lowercase() == tag.to_lowercase()) { *tag = name.clone(); }
    }
    if current == tags { return with_job_metadata(&dir, value); }
    let revision = value["revision"].as_u64().unwrap_or(0);
    value["tags"] = serde_json::to_value(tags).map_err(|e|e.to_string())?;
    with_job_metadata(&dir, append_revision(&dir, revision, value)?)
}

fn move_meeting_to_project_at(root: &Path, meeting_id: &str, expected_project_id: Option<String>, project_id: Option<String>, legacy: Option<(Option<String>, Option<String>)>) -> Result<serde_json::Value, String> {
    let (dir, mut value) = metadata_workspace(root, meeting_id, legacy)?;
    let current = effective_project(root, &value["project_id"])?;
    if current != serde_json::to_value(expected_project_id).map_err(|e|e.to_string())? { return Err("This note moved to another folder. Reload before moving it.".into()); }
    if let Some(id) = &project_id { require_active_project(root, id)?; }
    let next = serde_json::to_value(project_id).map_err(|e|e.to_string())?;
    if current == next { return with_job_metadata(&dir, value); }
    let revision = value["revision"].as_u64().unwrap_or(0);
    value["project_id"] = next;
    with_job_metadata(&dir, append_revision(&dir, revision, value)?)
}

#[tauri::command]
pub async fn set_meeting_tags(state: tauri::State<'_, AppState>, meeting_id: String, expected_tags: Vec<String>, tags: Vec<String>) -> Result<serde_json::Value, String> {
    valid_id(&meeting_id)?;
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as("SELECT n.notes_markdown,n.notes_json FROM meetings m LEFT JOIN meeting_notes n ON n.meeting_id=m.id WHERE m.id=?")
        .bind(&meeting_id).fetch_optional(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    let legacy = row.ok_or("Note no longer exists. Your tags were not saved.")?;
    let _guard = STORE_LOCK.lock().map_err(|e|e.to_string())?;
    set_meeting_tags_at(&data_root()?, &meeting_id, expected_tags, tags, Some(legacy))
}

#[tauri::command]
pub async fn move_meeting_to_project(state: tauri::State<'_, AppState>, meeting_id: String, expected_project_id: Option<String>, project_id: Option<String>) -> Result<serde_json::Value, String> {
    valid_id(&meeting_id)?;
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as("SELECT n.notes_markdown,n.notes_json FROM meetings m LEFT JOIN meeting_notes n ON n.meeting_id=m.id WHERE m.id=?")
        .bind(&meeting_id).fetch_optional(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    let legacy = row.ok_or("Note no longer exists. It was not moved.")?;
    let _guard = STORE_LOCK.lock().map_err(|e|e.to_string())?;
    move_meeting_to_project_at(&data_root()?, &meeting_id, expected_project_id, project_id, Some(legacy))
}

fn library_meeting(root: &Path, id: String, title: String, created_at: String, legacy_notes: Option<String>) -> Result<serde_json::Value, String> {
    // Only materialized assignments count. Loading a legacy/default workspace
    // must not silently file unrelated recordings under the initial vault.
    let workspace = latest_revision(&object_dir(root, "workspaces", &id)?)?;
    let notes = workspace.as_ref().and_then(|value|value["notes"].as_str())
        .or(legacy_notes.as_deref()).unwrap_or("");
    let preview = notes.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(180).collect::<String>();
    Ok(serde_json::json!({"id":id,"title":title,"created_at":created_at,
        "project_id":effective_project(root, &workspace.as_ref().map(|value|value["project_id"].clone()).unwrap_or(serde_json::Value::Null))?,
        "tags":workspace.as_ref().map(workspace_tags).transpose()?.unwrap_or_default(),"notes_preview":preview}))
}

#[tauri::command]
pub async fn list_project_library(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT m.id,m.title,m.created_at,n.notes_markdown FROM meetings m LEFT JOIN meeting_notes n ON n.meeting_id=m.id ORDER BY m.created_at DESC,m.id")
        .fetch_all(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    let grouped = crate::local_transcription::get_local_transcript_groups(state).await?;
    let hidden: HashSet<String> = grouped.iter().filter_map(|group|group["meeting_id"].as_str().map(str::to_owned)).collect();
    let projects = list_project_vaults()?.iter().map(project_summary).collect::<Vec<_>>();
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    let root = data_root()?;
    let meetings = rows.into_iter().filter(|(id,_,_,_)|!hidden.contains(id))
        .map(|(id,title,created_at,legacy)|library_meeting(&root,id,title,created_at,legacy))
        .collect::<Result<Vec<_>,_>>()?;
    Ok(serde_json::json!({"projects":projects,"meetings":meetings}))
}

#[tauri::command]
pub async fn local_get_meeting_audio(app: tauri::AppHandle, state: tauri::State<'_, AppState>, meeting_id: String) -> Result<serde_json::Value, String> {
    let folder: Option<Option<String>> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(meeting_id).fetch_optional(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    let folder=folder.flatten();
    let audio = meeting_audio_path(folder.as_deref());
    if let Some(path) = &audio { app.asset_protocol_scope().allow_file(path).map_err(|e|e.to_string())?; }
    Ok(serde_json::json!({"path":audio.map(|p| p.to_string_lossy().to_string())}))
}

fn meeting_audio_path(folder: Option<&str>) -> Option<PathBuf> {
    let folder=Path::new(folder?);
    // Keep the source folder link for retained timeline/identity metadata, but
    // never offer a preserved/partially removed file after explicit deletion.
    if folder.join("source-audio-deleted.json").exists() { return None; }
    ["audio.mp4", "audio.wav", "mixed.wav", "microphone.wav", "system.wav"].iter()
        .map(|name| folder.join(name)).find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removed_source_audio_is_not_offered_even_if_an_old_audio_file_remains() {
        let root=tempfile::tempdir().unwrap();
        fs::write(root.path().join("audio.wav"),b"partial old audio").unwrap();
        let folder=root.path().to_str().unwrap();
        assert_eq!(meeting_audio_path(Some(folder)),Some(root.path().join("audio.wav")));
        fs::write(root.path().join("source-audio-deleted.json"),br#"{"state":"removing"}"#).unwrap();
        assert_eq!(meeting_audio_path(Some(folder)),None);
        assert_eq!(meeting_audio_path(None),None);
    }
    fn snapshot_files(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files: Vec<_> = fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().path())
            .filter(|path| path.is_file()).map(|path| {
                let bytes = fs::read(&path).unwrap(); (path, bytes)
            }).collect();
        files.sort_by(|a,b| a.0.cmp(&b.0));
        files
    }

    #[test]
    fn generated_retention_preserves_latest_bytes_numbering_and_user_histories() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspaces/meeting-one");
        let vault = root.path().join("vaults/project-one");
        for dir in [&workspace, &vault] {
            for revision in 0..6 {
                append_revision(dir,revision,serde_json::json!({"notes":format!("edit {revision}"),"corrections":[{"text":"mine"}]})).unwrap();
            }
        }
        let user_history = snapshot_files(&workspace);
        let vault_history = snapshot_files(&vault);
        for kind in ["job-metadata", "speaker-metadata"] {
            let dir = workspace.join(kind);
            for revision in 0..7 {
                append_revision(&dir,revision,serde_json::json!({"source_job_id":"job","payload":revision})).unwrap();
            }
            let all = snapshot_files(&dir);
            fs::write(dir.join("unrelated.part"), b"not a revision").unwrap();
            assert_eq!(prune_generated_metadata(root.path(),"meeting-one",kind).unwrap(),4);
            let kept: Vec<_> = snapshot_files(&dir).into_iter().filter(|(path,_)|path.extension().unwrap() == "json").collect();
            assert_eq!(kept,all[4..], "Retained snapshots must remain byte-identical");
            assert_eq!(latest_revision(&dir).unwrap().unwrap()["revision"],7);
            assert!(append_revision(&dir,3,serde_json::json!({"payload":"stale"})).is_err());
            assert_eq!(append_revision(&dir,7,serde_json::json!({"payload":"next"})).unwrap()["revision"],8);
            assert_eq!(fs::read(dir.join("unrelated.part")).unwrap(),b"not a revision");
        }
        assert_eq!(snapshot_files(&workspace),user_history);
        assert_eq!(snapshot_files(&vault),vault_history);
    }

    #[test]
    fn committed_generated_saves_retain_three_snapshots_without_revising_notes() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("workspaces/meeting-one");
        let note = append_revision(&dir,0,serde_json::json!({"notes":"saved draft","corrections":[]})).unwrap();
        let note_bytes = fs::read(dir.join("revision-000000000001.json")).unwrap();
        for revision in 1..=8 {
            let status = serde_json::json!({"segments_revision":revision,"segments":[{"id":"s1","source_track":"system"}]});
            set_job_metadata_at(root.path(),"meeting-one","meeting-one","job-one",&status).unwrap();
            let result = serde_json::json!({"speakers":[],"turns":[],"segment_assignments":{},"generation":revision});
            set_speaker_metadata_at(root.path(),"meeting-one","speaker-job",&result).unwrap();
        }
        for kind in ["job-metadata", "speaker-metadata"] {
            assert_eq!(snapshot_files(&dir.join(kind)).len(),3);
            assert_eq!(latest_revision(&dir.join(kind)).unwrap().unwrap()["revision"],8);
        }
        assert_eq!(latest_revision(&dir).unwrap().unwrap(),note);
        assert_eq!(fs::read(dir.join("revision-000000000001.json")).unwrap(),note_bytes);
        assert_eq!(with_job_metadata(&dir,note).unwrap()["segments_revision"],8);
    }

    #[test]
    fn generated_retention_preserves_every_snapshot_when_latest_is_corrupt_or_inconsistent() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("workspaces/meeting-one/job-metadata");
        for revision in 0..5 { append_revision(&dir,revision,serde_json::json!({"source_job_id":"job"})).unwrap(); }
        for damaged in [b"{broken".as_slice(),br#"{"revision":4}"#.as_slice()] {
            fs::write(dir.join("revision-000000000005.json"),damaged).unwrap();
            let before = snapshot_files(&dir);
            assert!(prune_generated_metadata(root.path(),"meeting-one","job-metadata").is_err());
            assert!(set_job_metadata_at(root.path(),"meeting-one","meeting-one","job",&serde_json::json!({"segments":[]})).is_err());
            assert_eq!(snapshot_files(&dir),before);
        }
    }

    #[test]
    fn generated_retention_rejects_unsafe_paths_and_noncanonical_revision_files() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("workspaces/meeting-one/job-metadata");
        for revision in 0..5 { append_revision(&dir,revision,serde_json::json!({"source_job_id":"job"})).unwrap(); }
        let before = snapshot_files(&dir);
        for (id,kind) in [("../meeting-one","job-metadata"),("meeting-one",".."),("meeting-one","vaults"),("meeting-one","")] {
            assert!(prune_generated_metadata(root.path(),id,kind).is_err());
        }
        assert!(prune_generated_metadata(Path::new("relative"),"meeting-one","job-metadata").is_err());
        assert!(prune_generated_metadata(&root.path().join("workspaces/.."),"meeting-one","job-metadata").is_err());
        assert_eq!(snapshot_files(&dir),before);
        fs::write(dir.join("revision-5.json"),br#"{"revision":5}"#).unwrap();
        let ambiguous = snapshot_files(&dir);
        assert!(prune_generated_metadata(root.path(),"meeting-one","job-metadata").is_err());
        assert_eq!(snapshot_files(&dir),ambiguous);
    }

    #[test]
    fn failed_generated_cleanup_does_not_fail_a_committed_save() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("workspaces/meeting-one/job-metadata");
        for revision in 0..4 { append_revision(&dir,revision,serde_json::json!({"source_job_id":"job"})).unwrap(); }
        fs::write(dir.join("revision-000000000001.json"),b"damaged older history").unwrap();
        let before = snapshot_files(&dir);
        set_job_metadata_at(root.path(),"meeting-one","meeting-one","job",&serde_json::json!({"segments_revision":5,"segments":[]})).unwrap();
        assert_eq!(latest_revision(&dir).unwrap().unwrap()["revision"],5);
        assert_eq!(&snapshot_files(&dir)[..4],before);
    }

    #[cfg(windows)]
    #[test]
    fn generated_retention_rejects_windows_junctions() {
        use std::os::windows::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspaces/meeting-one");
        fs::create_dir_all(&workspace).unwrap();
        for revision in 0..5 { append_revision(outside.path(),revision,serde_json::json!({"source_job_id":"job"})).unwrap(); }
        let before = snapshot_files(outside.path());
        let junction = workspace.join("job-metadata");
        let result = std::process::Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args(["-NoProfile","-NonInteractive","-Command",
                "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:STT_RETENTION_TEST_LINK -Target $env:STT_RETENTION_TEST_TARGET | Out-Null"])
            .env("STT_RETENTION_TEST_LINK",&junction).env("STT_RETENTION_TEST_TARGET",outside.path())
            .output().unwrap();
        assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
        assert!(prune_generated_metadata(root.path(),"meeting-one","job-metadata").is_err());
        assert_eq!(snapshot_files(outside.path()),before);
        fs::remove_dir(junction).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn generated_retention_rejects_directory_and_file_links() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspaces/meeting-one");
        fs::create_dir_all(&workspace).unwrap();
        for revision in 0..5 { append_revision(outside.path(),revision,serde_json::json!({"source_job_id":"job"})).unwrap(); }
        let before = snapshot_files(outside.path());
        std::os::unix::fs::symlink(outside.path(),workspace.join("job-metadata")).unwrap();
        assert!(prune_generated_metadata(root.path(),"meeting-one","job-metadata").is_err());
        fs::create_dir(workspace.join("speaker-metadata")).unwrap();
        std::os::unix::fs::symlink(&before[0].0,workspace.join("speaker-metadata/revision-000000000001.json")).unwrap();
        assert!(prune_generated_metadata(root.path(),"meeting-one","speaker-metadata").is_err());
        assert_eq!(snapshot_files(outside.path()),before);
    }

    #[test]
    fn revisions_reject_conflicts_and_keep_prior_notes() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("workspace");
        append_revision(&dir, 0, serde_json::json!({"notes":"first"})).unwrap();
        assert!(append_revision(&dir, 0, serde_json::json!({"notes":"stale"})).is_err());
        append_revision(&dir, 1, serde_json::json!({"notes":"second"})).unwrap();
        assert_eq!(latest_revision(&dir).unwrap().unwrap()["notes"], "second");
        assert!(fs::read_to_string(dir.join("revision-000000000001.json")).unwrap().contains("first"));
        fs::write(dir.join("orphan.part"), b"broken").unwrap();
        assert_eq!(latest_revision(&dir).unwrap().unwrap()["revision"], 2);
        assert!(valid_id("../other").is_err());
    }
    #[test]
    fn progress_metadata_does_not_invalidate_unsaved_notes() {
        let root=tempfile::tempdir().unwrap();
        let dir=root.path().join("workspace");
        append_revision(&dir,0,serde_json::json!({"notes":"before","corrections":[]})).unwrap();
        append_revision(&dir.join("job-metadata"),0,serde_json::json!({"source_job_id":"job","source_meeting_id":"meeting","profile":"trelis-20","segment_metadata":{"chunk1":{"source_track":"system"}}})).unwrap();
        let saved=append_revision(&dir,1,serde_json::json!({"notes":"user draft","corrections":[]})).unwrap();
        let loaded=with_job_metadata(&dir,saved).unwrap();
        assert_eq!(loaded["revision"],2);
        assert_eq!(loaded["notes"],"user draft");
        assert_eq!(loaded["segment_metadata"]["chunk1"]["source_track"],"system");
        assert!(append_revision(&dir,1,serde_json::json!({"notes":"stale edit"})).is_err());
    }
    #[test]
    fn promoted_retry_metadata_keeps_original_without_revising_notes_or_legacy_jobs() {
        let root=tempfile::tempdir().unwrap();
        let dir=root.path().join("workspaces").join("meeting-one");
        let saved=append_revision(&dir,0,serde_json::json!({"notes":"user notes","corrections":[]})).unwrap();
        let status=serde_json::json!({"profile":"trelis-10","workflow_role":"live-final","segments":[{
            "id":"chunk-one","text":"recovered speech","source_track":"system",
            "quality_flags":["retry_applied","needs_review"],
            "alternative":{"text":"recovered speech","promoted":true},
            "recognition_original":{"text":"जब जब जब जब जब जब जब जब जब जब जब जब"}
        }]});
        set_job_metadata_at(root.path(),"meeting-one","meeting-one","job-one",&status).unwrap();
        let loaded=with_job_metadata(&dir,saved.clone()).unwrap();
        assert_eq!(loaded["notes"],"user notes");
        assert_eq!(loaded["revision"],1);
        assert_eq!(loaded["segment_metadata"]["chunk-one"]["original_recognition_text"],status["segments"][0]["recognition_original"]["text"]);
        assert_eq!(loaded["segment_metadata"]["chunk-one"]["alternative"]["promoted"],true);
        let metadata_dir=dir.join("job-metadata");
        set_job_metadata_at(root.path(),"meeting-one","meeting-one","job-one",&status).unwrap();
        assert_eq!(latest_revision(&metadata_dir).unwrap().unwrap()["revision"],1);
        assert_eq!(latest_revision(&dir).unwrap().unwrap(),saved);

        let legacy=serde_json::json!({"profile":"trelis-20","segments":[{"id":"old-chunk",
            "source_track":"microphone","quality_flags":["retry_available"],
            "alternative":{"text":"comparison only","requires_review":true}}]});
        set_job_metadata_at(root.path(),"meeting-two","meeting-two","old-job",&legacy).unwrap();
        let old=latest_revision(&root.path().join("workspaces/meeting-two/job-metadata")).unwrap().unwrap();
        assert_eq!(old["segment_metadata"]["old-chunk"]["alternative"],legacy["segments"][0]["alternative"]);
        assert!(old["segment_metadata"]["old-chunk"].get("original_recognition_text").is_none());
    }
    #[test]
    fn canonical_recovery_metadata_keeps_archives_and_rejects_stale_revision_without_changing_notes() {
        let root=tempfile::tempdir().unwrap();
        let dir=root.path().join("workspaces/meeting-one");
        let saved=append_revision(&dir,0,serde_json::json!({"notes":"retained notes","corrections":[{
            "segment_id":"job-microphone-0","original_text":"old loop","text":"manual correction","updated_at":"earlier"
        }]})).unwrap();
        let archive=serde_json::json!([{"id":"job-microphone-0","text":"old loop","source_track":"microphone",
            "start_seconds":0,"end_seconds":20,"superseded_by":["job-microphone-c-0-480000"],"superseded_at_segments_revision":2}]);
        let status=serde_json::json!({"profile":"trelis-20","segments_revision":2,"updated_at":"2026-10-07T12:00:00Z",
            "superseded_segments":archive,"segments":[{"id":"job-microphone-c-0-480000","text":"selected context",
                "source_track":"microphone","replaces_segment_ids":["job-microphone-0"],
                "recognition_original":{"text":"old loop"},"recovery":{"state":"complete","method":"context_window_retry"}}]});
        set_job_metadata_at(root.path(),"meeting-one","source","job",&status).unwrap();
        let loaded=with_job_metadata(&dir,saved.clone()).unwrap();
        assert_eq!(loaded["segments_revision"],2);
        assert_eq!(loaded["superseded_segments"],archive);
        assert_eq!(loaded["segment_metadata"]["job-microphone-c-0-480000"]["original_recognition_text"],"old loop");
        assert_eq!(loaded["segment_metadata"]["job-microphone-c-0-480000"]["recovery"]["method"],"context_window_retry");
        assert_eq!(loaded["corrections"],saved["corrections"]);
        assert_eq!(loaded["notes"],"retained notes");
        assert_eq!(loaded["revision"],1);
        let mut stale=status.clone();stale["segments_revision"]=serde_json::json!(1);stale["superseded_segments"]=serde_json::json!([]);
        set_job_metadata_at(root.path(),"meeting-one","source","job",&stale).unwrap();
        assert_eq!(with_job_metadata(&dir,saved.clone()).unwrap()["superseded_segments"],archive);
        let mut old_progress=status.clone();old_progress["updated_at"]=serde_json::json!("2026-10-07T11:00:00Z");
        old_progress["segments"][0]["recovery"]["state"]=serde_json::json!("waiting_for_context");
        set_job_metadata_at(root.path(),"meeting-one","source","job",&old_progress).unwrap();
        assert_eq!(with_job_metadata(&dir,saved).unwrap()["segment_metadata"]["job-microphone-c-0-480000"]["recovery"]["state"],"complete");
        assert!(set_job_metadata_at(root.path(),"meeting-one","source","another-job",&status).is_err());
    }
    #[test]
    fn verified_quantity_requires_evidence_context_and_unit() {
        let mut entry = VaultEntry { id:"q".into(),kind:"quantity".into(),canonical:"7".into(),aliases:vec![],
            source:"".into(),verified:true,context:"".into(),unit:"".into(),valid_from:"".into(),valid_to:"".into() };
        assert!(validate_vault(&[entry.clone()], &[]).is_err());
        entry.source="checked document".into(); entry.context="notebooks per workshop kit".into(); entry.unit="notebooks".into();
        assert!(validate_vault(&[entry.clone()], &[]).is_ok());
        entry.valid_from="2026-10-01".into(); entry.valid_to="2026-09-01".into();
        assert!(validate_vault(&[entry], &[]).is_err());
    }

    #[test]
    fn note_autosave_preserves_corrections_speaker_names_and_progress() {
        let root = tempfile::tempdir().unwrap();
        let project = create_project_at(root.path(), "  Willow  ").unwrap();
        let dir = root.path().join("workspaces").join("meeting-one");
        let mut initial = empty_workspace("meeting-one");
        initial["notes"] = "first note".into();
        initial["corrections"] = serde_json::json!([{"segment_id":"s1","original_text":"बारिश","text":"बारिश है","updated_at":"earlier"}]);
        initial["speaker_names"] = serde_json::json!({"speaker-one":"Maya"});
        initial["profile"] = "trelis-20".into();
        initial["future_field"] = "keep me".into();
        let first = append_revision(&dir,0,initial).unwrap();
        append_revision(&dir.join("job-metadata"),0,serde_json::json!({"source_job_id":"job-one","segment_metadata":{"s1":{"source_track":"system"}},"profile":"trelis-20"})).unwrap();
        let saved = save_meeting_note_at(root.path(),"meeting-one",1,"new note".into(),project["id"].as_str().map(str::to_owned),None,None,false).unwrap();
        assert_eq!(saved["revision"],2);
        assert_eq!(saved["corrections"],first["corrections"]);
        assert_eq!(saved["speaker_names"],first["speaker_names"]);
        assert_eq!(saved["future_field"],"keep me");
        assert_eq!(saved["source_job_id"],"job-one");
        assert_eq!(saved["segment_metadata"]["s1"]["source_track"],"system");
        assert_eq!(saved["project_id"],project["id"]);
        assert_eq!(latest_revision(&dir).unwrap().unwrap()["profile"],"trelis-20");
        assert!(save_meeting_note_at(root.path(),"meeting-one",1,"stale note".into(),None,None,None,false).is_err());
        assert_eq!(latest_revision(&dir).unwrap().unwrap()["notes"],"new note");
        let unchanged = save_meeting_note_at(root.path(),"meeting-one",2,"new note".into(),project["id"].as_str().map(str::to_owned),None,None,false).unwrap();
        assert_eq!(unchanged["revision"],2);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(dir.join("revision-000000000001.json")).unwrap()).unwrap(),first);
    }

    #[test]
    fn note_autosave_rejects_missing_projects_and_keeps_legacy_structure() {
        let root = tempfile::tempdir().unwrap();
        assert!(save_meeting_note_at(root.path(),"meeting-one",0,"draft".into(),Some("missing".into()),None,None,false).is_err());
        assert!(!root.path().join("workspaces").exists());
        assert!(save_meeting_note_at(root.path(),"meeting-one",0,"draft".into(),Some("../other".into()),None,None,false).is_err());
        let saved = save_meeting_note_at(root.path(),"meeting-one",0,"draft".into(),None,
            Some((Some("legacy".into()),Some("{\"original\":true}".into()))),None,false).unwrap();
        assert_eq!(saved["legacy_notes_json"],"{\"original\":true}");
        assert_eq!(saved["notes"],"draft");
        assert!(saved["project_id"].is_null());
    }

    #[test]
    fn project_rename_preserves_evidence_and_rejects_stale_changes() {
        let root = tempfile::tempdir().unwrap();
        let project = create_project_at(root.path(),"  Willow  ").unwrap();
        assert_eq!(project["name"],"Willow");
        let id = project["id"].as_str().unwrap();
        let dir = root.path().join("vaults").join(id);
        let mut value = latest_revision(&dir).unwrap().unwrap();
        value["entries"] = serde_json::json!([{"id":"ref-one","canonical":"Willow","source":"checked note"}]);
        value["relationships"] = serde_json::json!([{"source":"meeting-one"}]);
        let prior = append_revision(&dir,1,value).unwrap();
        let renamed = rename_project_at(root.path(),id,2,"Willow research").unwrap();
        assert_eq!(renamed["entry_count"],1);
        assert_eq!(renamed["revision"],3);
        let after = latest_revision(&dir).unwrap().unwrap();
        assert_eq!(after["entries"],prior["entries"]);
        assert_eq!(after["relationships"],prior["relationships"]);
        assert!(rename_project_at(root.path(),id,2,"stale rename").is_err());
        assert!(create_project_at(root.path()," \n ").is_err());
        assert!(rename_project_at(root.path(),"../escape",0,"bad").is_err());
        assert_eq!(latest_revision(&dir).unwrap().unwrap()["name"],"Willow research");
    }

    #[test]
    fn library_uses_only_saved_project_assignments_and_unicode_safe_previews() {
        let root = tempfile::tempdir().unwrap();
        let legacy = library_meeting(root.path(),"meeting-one".into(),"Old call".into(),"2026-10-01".into(),Some("मेरी\n पुरानी notes".into())).unwrap();
        assert!(legacy["project_id"].is_null());
        assert_eq!(legacy["notes_preview"],"मेरी पुरानी notes");
        assert!(!root.path().join("workspaces").exists());
        let dir = root.path().join("workspaces").join("meeting-two");
        let mut saved = empty_workspace("meeting-two");
        saved["project_id"] = "prior-project".into();
        saved["notes"] = "न".repeat(250).into();
        append_revision(&dir,0,saved).unwrap();
        let row = library_meeting(root.path(),"meeting-two".into(),"Saved call".into(),"2026-10-02".into(),Some("old fallback".into())).unwrap();
        assert_eq!(row["project_id"],"prior-project");
        assert_eq!(row["notes_preview"].as_str().unwrap().chars().count(),180);
        assert!(empty_workspace("new")["project_id"].is_null());
    }

    #[test]
    fn formatted_notes_are_atomic_conflict_safe_and_legacy_calls_preserve_them() {
        let root = tempfile::tempdir().unwrap();
        let doc = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello","marks":[{"type":"bold"}]}]}]});
        let first = save_meeting_note_at(root.path(),"note-one",0,"Hello".into(),None,None,Some(doc.clone()),false).unwrap();
        assert_eq!(first["notes_document"],doc);
        let mut underlined = doc.clone();
        underlined["content"][0]["content"][0]["marks"] = serde_json::json!([{"type":"underline"}]);
        let formatted = save_meeting_note_at(root.path(),"note-one",1,"Hello".into(),None,None,Some(underlined.clone()),false).unwrap();
        assert_eq!(formatted["revision"],2);
        assert!(save_meeting_note_at(root.path(),"note-one",1,"stale".into(),None,None,Some(doc),false).is_err());
        let unchanged = save_meeting_note_at(root.path(),"note-one",2,"Hello".into(),None,None,None,false).unwrap();
        assert_eq!(unchanged["revision"],2);
        assert_eq!(unchanged["notes_document"],underlined);
        let cleared = save_meeting_note_at(root.path(),"note-one",2,"Hello".into(),None,None,None,true).unwrap();
        assert_eq!(cleared["revision"],3);
        assert!(cleared["notes_document"].is_null());
        assert!(save_meeting_note_at(root.path(),"note-one",3,"bad".into(),None,None,Some(serde_json::json!({"type":"html"})),false).is_err());
        assert_eq!(latest_revision(&root.path().join("workspaces/note-one")).unwrap().unwrap()["notes"],"Hello");
    }

    #[test]
    fn tags_and_moves_merge_fresh_metadata_without_replacing_notes_or_references() {
        let root = tempfile::tempdir().unwrap();
        let project = create_project_at(root.path(),"Willow").unwrap();
        let id = project["id"].as_str().unwrap().to_owned();
        let dir = root.path().join("workspaces/note-one");
        let mut initial = empty_workspace("note-one");
        initial["notes"] = "newly saved draft".into();
        initial["notes_document"] = serde_json::json!({"type":"doc","content":[]});
        initial["corrections"] = serde_json::json!([{"text":"retained correction"}]);
        initial["speaker_names"] = serde_json::json!({"one":"speaker"});
        initial["future_field"] = "retained".into();
        let first = append_revision(&dir,0,initial).unwrap();
        let tagged = set_meeting_tags_at(root.path(),"note-one",vec![],vec!["  Follow-up  ".into(),"follow-UP".into(),"Research".into()],None).unwrap();
        assert_eq!(tagged["tags"],serde_json::json!(["Follow-up","Research"]));
        for field in ["notes","notes_document","corrections","speaker_names","future_field"] { assert_eq!(tagged[field],first[field]); }
        let mut newer = latest_revision(&dir).unwrap().unwrap(); newer["notes"] = "draft saved after opening move dialog".into();
        append_revision(&dir,2,newer).unwrap();
        let moved = move_meeting_to_project_at(root.path(),"note-one",None,Some(id.clone()),None).unwrap();
        assert_eq!(moved["revision"],4);
        assert_eq!(moved["notes"],"draft saved after opening move dialog");
        assert_eq!(moved["tags"],tagged["tags"]);
        assert!(move_meeting_to_project_at(root.path(),"note-one",None,None,None).is_err());
        assert!(set_meeting_tags_at(root.path(),"note-one",vec![],vec!["overwrite".into()],None).is_err());
        let second = set_meeting_tags_at(root.path(),"note-two",vec![],vec!["follow-up".into()],Some((Some("legacy note".into()),Some("legacy structure".into())))).unwrap();
        assert_eq!(second["tags"],serde_json::json!(["Follow-up"]));
        assert_eq!(second["notes"],"legacy note");
        assert_eq!(second["legacy_notes_json"],"legacy structure");
        assert!(normalized_tags(vec!["\ninvalid".into()]).is_err());
        assert!(normalized_tags(vec!["x".repeat(51)]).is_err());
        assert!(normalized_tags((0..31).map(|n|format!("tag{n}")).collect()).is_err());
        assert!(move_meeting_to_project_at(root.path(),"note-one",Some(id),Some("../escape".into()),None).is_err());
    }

    #[test]
    fn deleting_a_folder_unfiles_notes_atomically_and_retains_reference_history() {
        let root = tempfile::tempdir().unwrap();
        let project = create_project_at(root.path(),"Willow").unwrap();
        let id = project["id"].as_str().unwrap().to_owned();
        let vault = root.path().join("vaults").join(&id);
        let mut evidence = latest_revision(&vault).unwrap().unwrap();
        evidence["entries"] = serde_json::json!([{"id":"checked","canonical":"reference","source":"original"}]);
        evidence["relationships"] = serde_json::json!([{"source":"original"}]);
        let prior = append_revision(&vault,1,evidence).unwrap();
        save_meeting_note_at(root.path(),"note-one",0,"preserved note".into(),Some(id.clone()),None,None,false).unwrap();
        let workspace = root.path().join("workspaces/note-one");
        let original_bytes = fs::read(workspace.join("revision-000000000001.json")).unwrap();
        assert!(archive_project_at(root.path(),&id,1).is_err());
        let archived = archive_project_at(root.path(),&id,2).unwrap();
        assert_eq!(archived["entries"],prior["entries"]); assert_eq!(archived["relationships"],prior["relationships"]);
        assert_eq!(fs::read(workspace.join("revision-000000000001.json")).unwrap(),original_bytes);
        let loaded = with_job_metadata(&workspace,latest_revision(&workspace).unwrap().unwrap()).unwrap();
        assert!(loaded["project_id"].is_null()); assert_eq!(loaded["notes"],"preserved note");
        let row = library_meeting(root.path(),"note-one".into(),"note".into(),"date".into(),None).unwrap();
        assert!(row["project_id"].is_null());
        assert!(require_active_project(root.path(),&id).is_err());
        assert!(rename_project_at(root.path(),&id,3,"Resurrect").is_err());
        assert!(save_meeting_note_at(root.path(),"note-one",1,"stale draft".into(),Some(id.clone()),None,None,false).is_err());
        let destination = create_project_at(root.path(),"Research").unwrap()["id"].as_str().unwrap().to_owned();
        let moved = move_meeting_to_project_at(root.path(),"note-one",None,Some(destination.clone()),None).unwrap();
        assert_eq!(moved["project_id"],destination);
        assert_eq!(moved["notes"],"preserved note");
    }
}
