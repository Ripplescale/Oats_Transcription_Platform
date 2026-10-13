//! Lossless storage for finalized recorder chunks. The journal and each original
//! WAV remain byte-for-byte recoverable; the 48 kHz playback WAV is not a source.
//! Callers must exclude capture and worker launches while compacting/restoring.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub const ARCHIVE_NAME: &str = "source-chunks.zip";
const MANIFEST_NAME: &str = "source-manifest.json";
const MAX_JOURNAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CHUNK_BYTES: u64 = 44 + 384_000 * 2;
static ARCHIVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug)]
struct Chunk { name: String, sha256: String, bytes: u64 }
struct Source {
    root: PathBuf,
    journal_hash: String,
    session_hash: String,
    journal_stamp: (u64, std::time::SystemTime),
    session_stamp: (u64, std::time::SystemTime),
    chunks: Vec<Chunk>,
}

fn sha256(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

fn checked_metadata(path: &Path, allow_missing: bool) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_link(&metadata) => bail!("Source storage rejects symlinks and reparse points: {}", path.display()),
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("Inspecting {}", path.display())),
    }
}

// Inspect the lexical path before canonicalization: canonicalization alone would
// hide junctions or symlinks which redirected a candidate outside this session.
fn checked_path(path: &Path, allow_missing: bool) -> Result<bool> {
    if !path.is_absolute() { bail!("Source storage requires an absolute path"); }
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            bail!("Source storage path is not canonical");
        }
        current.push(component.as_os_str());
        // A Windows drive prefix by itself is not yet an absolute directory.
        if matches!(component, Component::Prefix(_)) || !current.is_absolute() { continue; }
        if checked_metadata(&current, allow_missing)?.is_none() { return Ok(false); }
    }
    Ok(true)
}

// Root ancestry is checked at each complete phase. Within a phase, callers hold
// capture/worker exclusion; check the root and every session-relative component
// on each access instead of repeatedly walking all ancestors of the data root.
fn checked_under_root(root: &Path, path: &Path, allow_missing: bool) -> Result<bool> {
    let relative = path.strip_prefix(root).context("Source path leaves its canonical session")?;
    if !checked_metadata(root, false)?.unwrap().is_dir() { bail!("Source session is not a directory"); }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) { bail!("Source path leaves its canonical session"); }
        current.push(component.as_os_str());
        if checked_metadata(&current, allow_missing)?.is_none() { return Ok(false); }
    }
    Ok(true)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    checked_path(path, false)?;
    read_bounded_checked(path, limit)
}

// Only after a full/shallow no-link path check. The opened file still supplies
// the authoritative length/type check, and reads remain strictly bounded.
fn read_bounded_checked(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > limit { bail!("Invalid or oversized source file: {}", path.display()); }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit { bail!("Source file changed while reading"); }
    Ok(bytes)
}

fn stamp(path: &Path) -> Result<(u64, std::time::SystemTime)> {
    checked_path(path, false)?;
    stamp_leaf(path)
}

fn stamp_leaf(path: &Path) -> Result<(u64, std::time::SystemTime)> {
    let metadata = checked_metadata(path, false)?.unwrap();
    if !metadata.is_file() { bail!("Source metadata is not a regular file"); }
    Ok((metadata.len(), metadata.modified()?))
}

fn check_cancel(cancelled: &dyn Fn() -> bool) -> Result<()> {
    if cancelled() { bail!("Source storage maintenance cancelled; original audio remains preserved"); }
    Ok(())
}

impl Source {
    fn load(directory: &Path) -> Result<Self> {
        Self::load_with_cancel(directory, &|| false)
    }

    fn load_with_cancel(directory: &Path, cancelled: &dyn Fn() -> bool) -> Result<Self> {
        check_cancel(cancelled)?;
        checked_path(directory, false)?;
        let root = fs::canonicalize(directory)?;
        if !root.is_dir() { bail!("Source session is not a directory"); }
        let session = read_bounded(&root.join("session.json"), 1024 * 1024)?;
        let session_json: Value = serde_json::from_slice(&session)?;
        let session_id = session_json["session_id"].as_str().context("Missing source session identity")?;
        uuid::Uuid::parse_str(session_id).context("Invalid source session identity")?;
        if root.file_name().and_then(|s| s.to_str()) != Some(session_id) { bail!("Source session identity differs from its directory"); }
        let journal = read_bounded(&root.join("timeline.jsonl"), MAX_JOURNAL_BYTES)?;
        let journal_hash = sha256(&journal);
        let complete = journal.iter().rposition(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0);
        let mut chunks = Vec::new();
        let mut next = BTreeMap::<String, (u64, f64)>::new();
        let mut finalized = false;
        let mut final_time = 0.0f64;
        for line in journal[..complete].split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            check_cancel(cancelled)?;
            let row: Value = serde_json::from_slice(line).context("Invalid committed source journal record")?;
            match row["kind"].as_str() {
                Some("capture_finalized") => finalized = true,
                Some("capture_stopped") => {
                    let time = row["at_seconds"].as_f64().context("Invalid capture stop time")?;
                    if !time.is_finite() || !(0.0..=28_800.0).contains(&time) { bail!("Invalid capture stop time"); }
                    final_time = final_time.max(time);
                },
                Some("audio_chunk") => {
                    if finalized { bail!("Source audio follows the finalization marker"); }
                    let track = row["track"].as_str().context("Missing source track")?;
                    if !["microphone", "system"].contains(&track) { bail!("Invalid source track"); }
                    let sequence = row["sequence"].as_u64().context("Missing source sequence")?;
                    if sequence >= 100_000_000 { bail!("Invalid source sequence"); }
                    let name = format!("tracks/{track}/{sequence:08}.wav");
                    if row["file"].as_str() != Some(name.as_str()) { bail!("Invalid source chunk path"); }
                    let rate = row["sample_rate"].as_u64().context("Missing source sample rate")?;
                    let count = row["sample_count"].as_u64().context("Missing source sample count")?;
                    if !(8_000..=384_000).contains(&rate) || count == 0 || count > rate { bail!("Invalid source sample count/rate"); }
                    let start = row["start_seconds"].as_f64().context("Missing source start")?;
                    let end = row["end_seconds"].as_f64().context("Missing source end")?;
                    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start || end > 28_800.0
                        || (end - start - count as f64 / rate as f64).abs() > 0.0001 { bail!("Invalid source timeline"); }
                    let prior = next.entry(track.to_owned()).or_insert((0, 0.0));
                    if sequence != prior.0 || prior.1 > start + 0.0001 { bail!("Non-contiguous or overlapping source sequence"); }
                    *prior = (sequence + 1, end);
                    let hash = row["sha256"].as_str().context("Missing source digest")?;
                    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { bail!("Invalid source digest"); }
                    chunks.push(Chunk { name, sha256: hash.to_owned(), bytes: 44 + count * 2 });
                    if chunks.len() > 200_000 { bail!("Too many source chunks"); }
                    final_time = final_time.max(end);
                },
                _ => {},
            }
        }
        if chunks.is_empty() { bail!("No committed source chunks"); }
        if !finalized {
            let metadata: Value = serde_json::from_slice(&read_bounded(&root.join("metadata.json"), 1024 * 1024)?)?;
            let recovery: Value = serde_json::from_slice(&read_bounded(&root.join("recovery-verified.json"), MAX_JOURNAL_BYTES)?)?;
            let duration = recovery["duration_seconds"].as_f64().unwrap_or(f64::NAN);
            if metadata["status"] != "recovered" || recovery["verified"] != true
                || recovery["source_journal_sha256"] != journal_hash || !duration.is_finite() || duration < final_time {
                bail!("Only finalized or verified recovered source sessions can be compacted");
            }
        }
        let journal_stamp = stamp(&root.join("timeline.jsonl"))?;
        let session_stamp = stamp(&root.join("session.json"))?;
        let source = Self { root, journal_hash, session_hash: sha256(&session), journal_stamp, session_stamp, chunks };
        source.unchanged()?;
        Ok(source)
    }

    fn manifest(&self) -> Value {
        json!({"schema_version":1,"source_journal_sha256":self.journal_hash,"source_session_sha256":self.session_hash,
            "chunks":self.chunks.iter().map(|c| json!({"file":c.name,"sha256":c.sha256,"bytes":c.bytes})).collect::<Vec<_>>()})
    }

    fn unchanged(&self) -> Result<()> {
        checked_path(&self.root, false)?;
        let journal = self.root.join("timeline.jsonl");
        let session = self.root.join("session.json");
        checked_under_root(&self.root, &journal, false)?;
        checked_under_root(&self.root, &session, false)?;
        if sha256(&read_bounded_checked(&journal, MAX_JOURNAL_BYTES)?) != self.journal_hash
            || sha256(&read_bounded_checked(&session, 1024 * 1024)?) != self.session_hash {
            bail!("Source journal/session changed; no further cleanup is permitted");
        }
        Ok(())
    }

    fn unchanged_metadata(&self) -> Result<()> {
        // Callers hold capture/worker exclusion. Check for unexpected changes
        // between the full hash checks without rereading a large journal once
        // for each one-second chunk.
        if !checked_metadata(&self.root, false)?.unwrap().is_dir() { bail!("Source session is not a directory"); }
        if stamp_leaf(&self.root.join("timeline.jsonl"))? != self.journal_stamp
            || stamp_leaf(&self.root.join("session.json"))? != self.session_stamp {
            bail!("Source journal/session changed; no further cleanup is permitted");
        }
        Ok(())
    }

    fn original(&self, chunk: &Chunk) -> Result<Option<Vec<u8>>> {
        let path = self.root.join(&chunk.name);
        if !checked_under_root(&self.root, &path, true)? { return Ok(None); }
        let bytes = read_bounded_checked(&path, MAX_CHUNK_BYTES)?;
        verify_chunk(chunk, &bytes)?;
        Ok(Some(bytes))
    }
}

fn verify_chunk(chunk: &Chunk, bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 != chunk.bytes || sha256(bytes) != chunk.sha256 { bail!("Source chunk differs from its journal: {}", chunk.name); }
    Ok(())
}

fn archived_chunk(archive: &mut ZipArchive<File>, chunk: &Chunk) -> Result<Vec<u8>> {
    let mut member = archive.by_name(&chunk.name)?;
    if member.size() != chunk.bytes || member.size() > MAX_CHUNK_BYTES { bail!("Invalid archived chunk length: {}", chunk.name); }
    let mut bytes = Vec::with_capacity(member.size() as usize);
    (&mut member).take(MAX_CHUNK_BYTES + 1).read_to_end(&mut bytes)?;
    verify_chunk(chunk, &bytes)?;
    Ok(bytes)
}

fn verified_archive(source: &Source, path: &Path, cancelled: &dyn Fn() -> bool) -> Result<ZipArchive<File>> {
    check_cancel(cancelled)?;
    source.unchanged()?;
    checked_path(path, false)?;
    if !fs::metadata(path)?.is_file() { bail!("Source archive is not a regular file"); }
    let mut archive = ZipArchive::new(File::open(path)?)?;
    if archive.len() != source.chunks.len() + 1 { bail!("Source archive member count differs from the journal"); }
    let expected: HashSet<&str> = source.chunks.iter().map(|c| c.name.as_str()).chain(std::iter::once(MANIFEST_NAME)).collect();
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        check_cancel(cancelled)?;
        let member = archive.by_index(index)?;
        if !expected.contains(member.name()) || !seen.insert(member.name().to_owned()) || member.is_dir()
            || member.unix_mode().map(|mode| mode & 0o170000 == 0o120000).unwrap_or(false) {
            bail!("Source archive contains an unexpected, duplicate or linked member");
        }
    }
    {
        let mut manifest = archive.by_name(MANIFEST_NAME)?;
        if manifest.size() > MAX_JOURNAL_BYTES { bail!("Source manifest is too large"); }
        let mut bytes = Vec::new();
        (&mut manifest).take(MAX_JOURNAL_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_JOURNAL_BYTES || serde_json::from_slice::<Value>(&bytes)? != source.manifest() {
            bail!("Source archive manifest differs from the original journal/session");
        }
    }
    for chunk in &source.chunks { check_cancel(cancelled)?; archived_chunk(&mut archive, chunk)?; }
    source.unchanged()?;
    Ok(archive)
}

// Publishing a hard link cannot replace existing evidence, unlike rename on Unix.
fn publish_new(root: &Path, temporary: &Path, target: &Path) -> Result<()> {
    checked_under_root(root, temporary, false)?;
    if checked_under_root(root, target, true)? { bail!("Refusing to overwrite existing source evidence: {}", target.display()); }
    fs::hard_link(temporary, target).context("Could not publish complete source file without overwriting")?;
    fs::remove_file(temporary)?;
    Ok(())
}

/// Replace loose committed WAV chunks with one verified, lossless ZIP. Unlisted
/// files and all playback audio, journal, metadata and transcripts are retained.
pub fn compact(directory: &Path) -> Result<Value> {
    compact_with_cancel(directory, || false)
}

/// Cancellation is cooperative between bounded chunk operations. Before archive
/// publication all originals remain; after publication the verified archive and
/// any surviving loose chunks can always be restored by the ordinary API.
pub fn compact_with_cancel(directory: &Path, cancelled: impl Fn() -> bool) -> Result<Value> {
    let _guard = ARCHIVE_LOCK.lock().map_err(|_| anyhow::anyhow!("Source archive lock poisoned"))?;
    let source = Source::load_with_cancel(directory, &cancelled)?;
    let target = source.root.join(ARCHIVE_NAME);
    if !checked_path(&target, true)? {
        // Check every original first, before even creating a candidate archive.
        for chunk in &source.chunks { check_cancel(&cancelled)?; source.original(chunk)?.context("A source chunk is missing and no verified archive exists")?; }
        source.unchanged()?;
        let temporary = source.root.join(format!(".source-chunks-{}.part", uuid::Uuid::new_v4()));
        let outcome = (|| -> Result<()> {
            check_cancel(&cancelled)?;
            let file = OpenOptions::new().create_new(true).write(true).open(&temporary)?;
            let mut writer = ZipWriter::new(file);
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).compression_level(Some(3));
            writer.start_file(MANIFEST_NAME, options)?;
            writer.write_all(&serde_json::to_vec(&source.manifest())?)?;
            for chunk in &source.chunks {
                check_cancel(&cancelled)?;
                writer.start_file(&chunk.name, options)?;
                writer.write_all(&source.original(chunk)?.context("Source disappeared while archiving")?)?;
            }
            writer.finish()?.sync_all()?;
            drop(verified_archive(&source, &temporary, &cancelled)?);
            source.unchanged()?;
            check_cancel(&cancelled)?;
            publish_new(&source.root, &temporary, &target)
        })();
        if outcome.is_err() { let _ = fs::remove_file(&temporary); }
        outcome?;
    }
    // Verify the entire durable archive before deleting even the first source.
    let archive = verified_archive(&source, &target, &cancelled)?;
    // An altered loose file must fail the whole preflight, not be overwritten by
    // an old archive or discovered only after deleting earlier files.
    for chunk in &source.chunks { check_cancel(&cancelled)?; source.original(chunk)?; }
    source.unchanged()?;
    let mut removed = 0u64;
    let mut removed_bytes = 0u64;
    for chunk in &source.chunks {
        check_cancel(&cancelled)?;
        if source.original(chunk)?.is_some() {
            source.unchanged_metadata()?;
            fs::remove_file(source.root.join(&chunk.name))?;
            removed += 1;
            removed_bytes += chunk.bytes;
        }
    }
    source.unchanged()?;
    drop(archive);
    Ok(json!({"source_chunks":source.chunks.len(),"removed_files":removed,"removed_bytes":removed_bytes,
        "archive_bytes":fs::metadata(target)?.len(),"archive":ARCHIVE_NAME,"original_audio_preserved":true}))
}

/// Restore exact original chunk paths for the immutable historical Python worker
/// and native recovery. The archive remains available for subsequent compaction.
pub fn restore(directory: &Path) -> Result<Value> {
    let _guard = ARCHIVE_LOCK.lock().map_err(|_| anyhow::anyhow!("Source archive lock poisoned"))?;
    checked_path(directory, false)?;
    let target = directory.join(ARCHIVE_NAME);
    if !checked_path(&target, true)? { return Ok(json!({"restored_files":0,"archive_present":false})); }
    let source = Source::load(directory)?;
    let mut archive = verified_archive(&source, &target, &|| false)?;
    // Validate every survivor before any restoration; never overwrite changed
    // loose audio and never create output from a partially corrupt archive.
    for chunk in &source.chunks { source.original(chunk)?; }
    source.unchanged()?;
    let mut restored = 0u64;
    for chunk in &source.chunks {
        if source.original(chunk)?.is_some() { continue; }
        let path = source.root.join(&chunk.name);
        let parent = path.parent().unwrap();
        checked_under_root(&source.root, parent, true)?;
        fs::create_dir_all(parent)?;
        checked_under_root(&source.root, parent, false)?;
        let bytes = archived_chunk(&mut archive, chunk)?;
        let temporary = parent.join(format!(".source-{}.part", uuid::Uuid::new_v4()));
        let outcome = (|| -> Result<()> {
            let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary)?;
            file.write_all(&bytes)?; file.sync_all()?; drop(file);
            source.unchanged_metadata()?;
            publish_new(&source.root, &temporary, &path)
        })();
        if outcome.is_err() { let _ = fs::remove_file(&temporary); }
        outcome?;
        restored += 1;
    }
    source.unchanged()?;
    Ok(json!({"restored_files":restored,"archive_present":true,"original_audio_preserved":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, Vec<(String, Vec<u8>)>) {
        let temp = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let root = temp.path().join(&id);
        fs::create_dir_all(root.join("tracks/microphone")).unwrap();
        fs::write(root.join("session.json"), serde_json::to_vec(&json!({"session_id":id,"schema_version":1})).unwrap()).unwrap();
        let mut journal = String::new();
        let mut originals = Vec::new();
        for sequence in 0..3 {
            let name = format!("tracks/microphone/{sequence:08}.wav");
            let mut bytes = vec![0u8; 44];
            bytes[0..4].copy_from_slice(b"RIFF");
            bytes[8..12].copy_from_slice(b"WAVE");
            for sample in 0..8_000 { bytes.extend_from_slice(&((sample * 17 + sequence * 31) as i16).to_le_bytes()); }
            fs::write(root.join(&name), &bytes).unwrap();
            journal.push_str(&json!({"kind":"audio_chunk","track":"microphone","sequence":sequence,"file":name,
                "sample_rate":8000,"sample_count":8000,"start_seconds":sequence,"end_seconds":sequence+1,"sha256":sha256(&bytes)}).to_string());
            journal.push('\n');
            originals.push((name, bytes));
        }
        journal.push_str("{\"kind\":\"capture_finalized\"}\n");
        fs::write(root.join("timeline.jsonl"), journal).unwrap();
        (temp, root, originals)
    }

    #[test]
    fn round_trip_preserves_exact_sources_and_unrelated_files() {
        let (_temp, root, originals) = fixture();
        fs::write(root.join("tracks/microphone/uncommitted.part"), b"unfinished").unwrap();
        fs::write(root.join("audio.wav"), b"playback").unwrap();
        let journal = fs::read(root.join("timeline.jsonl")).unwrap();
        let session = fs::read(root.join("session.json")).unwrap();
        assert_eq!(compact(&root).unwrap()["removed_files"], 3);
        assert!(originals.iter().all(|(name, _)| !root.join(name).exists()));
        assert_eq!(compact(&root).unwrap()["removed_files"], 0);
        assert_eq!(restore(&root).unwrap()["restored_files"], 3);
        assert_eq!(restore(&root).unwrap()["restored_files"], 0);
        for (name, bytes) in originals { assert_eq!(fs::read(root.join(name)).unwrap(), bytes); }
        assert_eq!(fs::read(root.join("timeline.jsonl")).unwrap(), journal);
        assert_eq!(fs::read(root.join("session.json")).unwrap(), session);
        assert_eq!(fs::read(root.join("audio.wav")).unwrap(), b"playback");
        assert_eq!(fs::read(root.join("tracks/microphone/uncommitted.part")).unwrap(), b"unfinished");
    }

    #[test]
    fn retry_after_partial_prune_reuses_immutable_archive() {
        let (_temp, root, originals) = fixture();
        compact(&root).unwrap();
        let archive_hash = sha256(&fs::read(root.join(ARCHIVE_NAME)).unwrap());
        fs::write(root.join(&originals[1].0), &originals[1].1).unwrap();
        assert_eq!(compact(&root).unwrap()["removed_files"], 1);
        assert_eq!(sha256(&fs::read(root.join(ARCHIVE_NAME)).unwrap()), archive_hash);
        assert_eq!(restore(&root).unwrap()["restored_files"], 3);
    }

    #[test]
    fn partial_restore_resumes_without_overwriting_survivors() {
        let (_temp, root, originals) = fixture();
        compact(&root).unwrap();
        fs::write(root.join(&originals[1].0), &originals[1].1).unwrap();
        assert_eq!(restore(&root).unwrap()["restored_files"], 2);
        for (name, bytes) in originals { assert_eq!(fs::read(root.join(name)).unwrap(), bytes); }
    }

    #[test]
    fn changed_source_fails_before_any_prune_or_restore() {
        let (_temp, root, originals) = fixture();
        compact(&root).unwrap();
        fs::write(root.join(&originals[2].0), b"changed source").unwrap();
        assert!(restore(&root).is_err());
        assert!(!root.join(&originals[0].0).exists());
        fs::write(root.join(&originals[0].0), &originals[0].1).unwrap();
        assert!(compact(&root).is_err());
        assert!(root.join(&originals[0].0).is_file());
        assert_eq!(fs::read(root.join(&originals[2].0)).unwrap(), b"changed source");
    }

    #[test]
    fn absent_or_corrupt_original_never_creates_an_archive() {
        for absent in [false, true] {
            let (_temp, root, originals) = fixture();
            if absent { fs::remove_file(root.join(&originals[2].0)).unwrap(); }
            else { fs::write(root.join(&originals[2].0), b"changed").unwrap(); }
            assert!(compact(&root).is_err());
            assert!(!root.join(ARCHIVE_NAME).exists());
            assert_eq!(fs::read(root.join(&originals[0].0)).unwrap(), originals[0].1);
        }
    }

    #[test]
    fn changed_journal_rejects_archive_before_prune() {
        let (_temp, root, originals) = fixture();
        compact(&root).unwrap(); restore(&root).unwrap();
        OpenOptions::new().append(true).open(root.join("timeline.jsonl")).unwrap().write_all(b"{\"kind\":\"changed\"}\n").unwrap();
        assert!(compact(&root).is_err());
        assert!(restore(&root).is_err());
        assert!(originals.iter().all(|(name, _)| root.join(name).exists()));
    }

    #[test]
    fn corrupt_archive_is_never_replaced_and_sources_survive() {
        let (_temp, root, originals) = fixture();
        fs::write(root.join(ARCHIVE_NAME), b"corrupt evidence").unwrap();
        assert!(compact(&root).is_err());
        assert!(restore(&root).is_err());
        assert_eq!(fs::read(root.join(ARCHIVE_NAME)).unwrap(), b"corrupt evidence");
        assert!(originals.iter().all(|(name, _)| root.join(name).exists()));
    }

    #[test]
    fn traversal_or_unfinalized_recording_is_rejected() {
        for traversal in [false, true] {
            let (_temp, root, originals) = fixture();
            let journal = fs::read_to_string(root.join("timeline.jsonl")).unwrap();
            let changed = if traversal { journal.replace(&originals[0].0, "../outside.wav") }
                else { journal.replace("{\"kind\":\"capture_finalized\"}\n", "") };
            fs::write(root.join("timeline.jsonl"), changed).unwrap();
            assert!(compact(&root).is_err());
            assert!(!root.join(ARCHIVE_NAME).exists());
            assert!(originals.iter().all(|(name, _)| root.join(name).exists()));
        }
    }

    #[test]
    fn recovered_session_requires_current_journal_binding() {
        let (_temp, root, _originals) = fixture();
        let journal = fs::read_to_string(root.join("timeline.jsonl")).unwrap().replace("{\"kind\":\"capture_finalized\"}\n", "");
        fs::write(root.join("timeline.jsonl"), &journal).unwrap();
        fs::write(root.join("metadata.json"), b"{\"status\":\"recovered\"}").unwrap();
        fs::write(root.join("recovery-verified.json"), json!({"verified":true,"source_journal_sha256":"wrong","duration_seconds":3}).to_string()).unwrap();
        assert!(compact(&root).is_err());
        fs::write(root.join("recovery-verified.json"), json!({"verified":true,"source_journal_sha256":sha256(journal.as_bytes()),"duration_seconds":3}).to_string()).unwrap();
        assert_eq!(compact(&root).unwrap()["removed_files"], 3);
        assert_eq!(restore(&root).unwrap()["restored_files"], 3);
    }

    #[test]
    fn unexpected_zip_member_cannot_be_extracted() {
        let (_temp, root, originals) = fixture();
        let source = Source::load(&root).unwrap();
        let mut zip = ZipWriter::new(File::create(root.join(ARCHIVE_NAME)).unwrap());
        let options = SimpleFileOptions::default();
        zip.start_file(MANIFEST_NAME, options).unwrap();
        zip.write_all(&serde_json::to_vec(&source.manifest()).unwrap()).unwrap();
        for (index, (name, bytes)) in originals.iter().enumerate() {
            zip.start_file(if index == 2 { "../../escape.wav" } else { name }, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        assert!(restore(&root).is_err());
        assert!(compact(&root).is_err());
        assert!(!root.parent().unwrap().parent().unwrap().join("escape.wav").exists());
        assert!(originals.iter().all(|(name, _)| root.join(name).exists()));
    }

    #[test]
    fn late_archive_digest_failure_prevents_all_restoration_and_pruning() {
        let (_temp, root, originals) = fixture();
        let source = Source::load(&root).unwrap();
        let mut zip = ZipWriter::new(File::create(root.join(ARCHIVE_NAME)).unwrap());
        let options = SimpleFileOptions::default();
        zip.start_file(MANIFEST_NAME, options).unwrap();
        zip.write_all(&serde_json::to_vec(&source.manifest()).unwrap()).unwrap();
        for (index, (name, bytes)) in originals.iter().enumerate() {
            zip.start_file(name, options).unwrap();
            let mut payload = bytes.clone();
            if index == 2 { payload[44] ^= 1; }
            zip.write_all(&payload).unwrap();
        }
        zip.finish().unwrap();
        assert!(compact(&root).is_err());
        assert!(originals.iter().all(|(name, _)| root.join(name).exists()));
        for (name, _) in &originals { fs::remove_file(root.join(name)).unwrap(); }
        assert!(restore(&root).is_err());
        assert!(originals.iter().all(|(name, _)| !root.join(name).exists()));
    }

    #[test]
    fn duplicate_archive_names_are_rejected() {
        let (_temp, root, originals) = fixture();
        compact(&root).unwrap(); restore(&root).unwrap();
        let path = root.join(ARCHIVE_NAME);
        let mut bytes = fs::read(&path).unwrap();
        // Modify local and central-directory names; ZIP CRC covers payloads, so
        // this is a well-formed duplicate-name attack rather than corrupt data.
        let from = originals[2].0.as_bytes();
        let to = originals[1].0.as_bytes();
        let mut position = 0;
        while position + from.len() <= bytes.len() {
            if &bytes[position..position + from.len()] == from {
                bytes[position..position + from.len()].copy_from_slice(to);
                position += from.len();
            } else { position += 1; }
        }
        fs::write(path, bytes).unwrap();
        assert!(compact(&root).is_err());
        assert!(restore(&root).is_err());
        assert!(originals.iter().all(|(name, _)| root.join(name).exists()));
    }

    #[test]
    fn cancelling_candidate_archive_keeps_all_originals_and_removes_part() {
        let (_temp, root, originals) = fixture();
        let result = compact_with_cancel(&root, || {
            fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".source-chunks-"))
        });
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        assert!(!root.join(ARCHIVE_NAME).exists());
        assert!(originals.iter().all(|(name, _)| root.join(name).exists()));
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".part")));
        assert_eq!(compact(&root).unwrap()["removed_files"], 3);
        assert_eq!(restore(&root).unwrap()["restored_files"], 3);
    }

    #[test]
    fn cancelling_partial_prune_leaves_verified_archive_recoverable() {
        let (_temp, root, originals) = fixture();
        let result = compact_with_cancel(&root, || !root.join(&originals[0].0).exists());
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        assert!(root.join(ARCHIVE_NAME).is_file());
        assert!(!root.join(&originals[0].0).exists());
        assert!(root.join(&originals[1].0).exists());
        assert!(root.join(&originals[2].0).exists());
        assert_eq!(restore(&root).unwrap()["restored_files"], 1);
        for (name, bytes) in originals { assert_eq!(fs::read(root.join(name)).unwrap(), bytes); }
    }

    #[test]
    fn relative_file_checks_reject_parent_traversal() {
        let (_temp, root, _originals) = fixture();
        assert!(checked_under_root(&root, &root.join("../outside"), true).is_err());
        assert!(checked_under_root(&root, root.parent().unwrap(), true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_source_directory_is_rejected() {
        let (temp, root, _originals) = fixture();
        let redirected = temp.path().join("redirect");
        std::os::unix::fs::symlink(&root, &redirected).unwrap();
        assert!(compact(&redirected).is_err());
        assert!(restore(&redirected).is_err());
    }
}
