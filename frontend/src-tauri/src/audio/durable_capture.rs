//! Source recordings, independent of VAD and transcription workers.
//!
//! A chunk becomes readable only after its WAV is synced and renamed and its
//! newline-terminated journal record is synced. Uncommitted `.part` files are
//! never consumed. A process crash can lose at most the current sub-second
//! buffer plus queued callbacks; committed chunks are retained for recovery.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureInfo {
    pub session_id: String,
    pub session_dir: PathBuf,
    pub timeline_path: PathBuf,
}

enum Message {
    Audio { track: String, rate: u32, start: f64, samples: Vec<f32> },
    Event(Value),
}

#[derive(Clone)]
pub struct CaptureSink {
    sender: Arc<Mutex<Option<mpsc::SyncSender<Message>>>>,
    failure: Arc<Mutex<Option<String>>>,
    dropped: Arc<AtomicU64>,
}

impl CaptureSink {
    /// Never wait on disk or a full queue in an audio callback.
    pub fn audio(&self, track: &str, rate: u32, start: f64, samples: &[f32]) {
        if samples.is_empty() || rate == 0 { return; }
        let message = Message::Audio { track: track.into(), rate, start: start.max(0.0), samples: samples.to_vec() };
        if let Some(sender) = self.sender.lock().unwrap().as_ref() {
            if sender.try_send(message).is_err() {
                self.dropped.fetch_add(samples.len() as u64, Ordering::Relaxed);
                *self.failure.lock().unwrap() = Some("Capture queue overflow or writer unavailable; inspect timeline gaps".into());
            }
        }
    }

    pub fn event(&self, event: Value) {
        if let Some(sender) = self.sender.lock().unwrap().as_ref() {
            if sender.try_send(Message::Event(event)).is_err() {
                *self.failure.lock().unwrap() = Some("Could not persist capture event".into());
            }
        }
    }

    pub fn error(&self) -> Option<String> { self.failure.lock().unwrap().clone() }
}

pub struct DurableRecorder {
    pub info: CaptureInfo,
    pub sink: CaptureSink,
    writer: Option<JoinHandle<Result<()>>>,
}

impl DurableRecorder {
    pub fn start(root: &Path, name: Option<String>, microphone: Option<String>, system: Option<String>) -> Result<Self> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let directory = root.join(&session_id);
        fs::create_dir_all(directory.join("tracks/microphone"))?;
        fs::create_dir_all(directory.join("tracks/system"))?;
        let info = CaptureInfo { session_id, session_dir: directory.clone(), timeline_path: directory.join("timeline.jsonl") };
        let mut metadata = File::create(directory.join("session.json"))?;
        serde_json::to_writer_pretty(&mut metadata, &json!({
            "schema_version": 1, "session_id": info.session_id, "meeting_name": name,
            "created_at": chrono::Utc::now().to_rfc3339(),
            "devices": {"microphone": microphone, "system": system},
            "format": "pcm_s16le_mono_wav", "chunk_target_seconds": 1,
            "timeline_clock": "monotonic_capture_seconds", "timestamp_precision": "approximate_callback_latency_and_sample_clock", "gap_threshold_seconds": 0.1, "transcription_required": false,
            "recovery": "Read committed newline-terminated timeline records; retain source chunks"
        }))?;
        metadata.sync_all()?;
        let journal = OpenOptions::new().create_new(true).write(true).open(&info.timeline_path)?;
        let (sender, receiver) = mpsc::sync_channel(1024);
        let failure = Arc::new(Mutex::new(None));
        let dropped = Arc::new(AtomicU64::new(0));
        let sink = CaptureSink { sender: Arc::new(Mutex::new(Some(sender))), failure: failure.clone(), dropped: dropped.clone() };
        let writer = std::thread::Builder::new().name("durable-source-audio".into()).spawn(move || {
            let result = write_loop(directory, journal, receiver, dropped);
            if let Err(error) = &result { *failure.lock().unwrap() = Some(format!("Source recording failed: {error:#}")); }
            result
        })?;
        Ok(Self { info, sink, writer: Some(writer) })
    }

    /// Drop the shared producer, drain every accepted callback, then acknowledge.
    pub fn finish(&mut self, duration: f64) -> Result<CaptureInfo> {
        if self.writer.is_some() {
            // Control messages may wait here: streams have already stopped.
            if let Some(sender) = self.sink.sender.lock().unwrap().take() {
                sender.send(Message::Event(json!({"kind":"capture_stopped", "at_seconds":duration})))
                    .map_err(|_| anyhow::anyhow!("Source writer stopped before acknowledgement"))?;
                drop(sender);
            }
            self.writer.take().unwrap().join().map_err(|_| anyhow::anyhow!("Source writer panicked"))??;
        }
        // Verification failure leaves every source chunk and journal intact.
        recover_capture(&self.info.session_dir)?;
        if let Some(error) = self.sink.error() { bail!(error); }
        Ok(self.info.clone())
    }
}

impl Drop for DurableRecorder {
    fn drop(&mut self) {
        // Closing the channel still lets the detached writer drain on orderly
        // manager cleanup. Normal stop explicitly joins it above.
        self.sink.sender.lock().unwrap().take();
    }
}

#[derive(Default)]
struct Track {
    rate: u32,
    sequence: u64,
    sample_counter: u64,
    start: f64,
    next: f64,
    buffer: Vec<f32>,
}

fn journal_line(journal: &mut File, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *journal, value)?;
    journal.write_all(b"\n")?;
    journal.sync_data()?;
    Ok(())
}

fn commit(directory: &Path, journal: &mut File, name: &str, track: &mut Track, count: usize) -> Result<()> {
    if count == 0 { return Ok(()); }
    let samples: Vec<f32> = track.buffer.drain(..count).collect();
    let relative = format!("tracks/{name}/{:08}.wav", track.sequence);
    let bytes = wav_bytes(track.rate, &samples);
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let target = directory.join(&relative);
    let temporary = target.with_extension("part");
    let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, &target)?;
    let end = track.start + count as f64 / track.rate as f64;
    journal_line(journal, &json!({
        "kind":"audio_chunk", "track":name, "file":relative,
        "sequence":track.sequence, "sample_rate":track.rate, "sample_count":count,
        "start_sample":track.sample_counter, "end_sample":track.sample_counter + count as u64,
        "start_seconds":track.start, "end_seconds":end, "sha256":hash
    }))?;
    track.sequence += 1;
    track.sample_counter += count as u64;
    track.start = end;
    Ok(())
}

fn write_loop(directory: PathBuf, mut journal: File, receiver: mpsc::Receiver<Message>, dropped: Arc<AtomicU64>) -> Result<()> {
    let mut tracks = BTreeMap::<String, Track>::new();
    journal_line(&mut journal, &json!({"kind":"capture_started", "at_seconds":0.0}))?;
    for message in receiver {
        match message {
            Message::Event(event) => journal_line(&mut journal, &event)?,
            Message::Audio {track: name, rate, start, samples} => {
                if !["microphone", "system"].contains(&name.as_str()) || !start.is_finite() || !(8000..=384000).contains(&rate) {
                    bail!("Invalid source audio metadata");
                }
                let track = tracks.entry(name.clone()).or_default();
                // Sample counting absorbs ordinary callback jitter. A >100ms
                // discontinuity starts a new run and records the missing range.
                // Late/batched callbacks can temporarily be behind the sample
                // clock. Retain their samples without repeatedly fragmenting
                // files; only a forward gap or format change starts a new run.
                let discontinuity = track.rate != rate || start - track.next > 0.1;
                if discontinuity {
                    let buffered = track.buffer.len();
                    commit(&directory, &mut journal, &name, track, buffered)?;
                    if start > track.next + 0.1 {
                        journal_line(&mut journal, &json!({"kind":"gap", "track":name, "start_seconds":track.next, "end_seconds":start, "reason":"capture_unavailable"}))?;
                    } else if track.rate != 0 && start < track.next - 0.1 {
                        journal_line(&mut journal, &json!({"kind":"clock_overlap", "track":name, "observed_start_seconds":start, "retained_start_seconds":track.next}))?;
                    }
                    track.rate = rate;
                    track.start = start.max(track.next);
                    track.next = track.start;
                }
                track.next += samples.len() as f64 / rate as f64;
                track.buffer.extend(samples);
                while track.buffer.len() >= rate as usize { commit(&directory, &mut journal, &name, track, rate as usize)?; }
            }
        }
    }
    for (name, track) in &mut tracks {
        let count = track.buffer.len();
        commit(&directory, &mut journal, name, track, count)?;
    }
    journal_line(&mut journal, &json!({"kind":"capture_finalized", "dropped_samples":dropped.load(Ordering::Relaxed), "tracks":tracks.keys().collect::<Vec<_>>()}))?;
    Ok(())
}

fn wav_bytes(rate: u32, samples: &[f32]) -> Vec<u8> {
    let size = samples.len() as u32 * 2;
    let mut bytes = Vec::with_capacity(44 + size as usize);
    bytes.extend(b"RIFF"); bytes.extend((36 + size).to_le_bytes()); bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes()); bytes.extend(1u16.to_le_bytes()); bytes.extend(1u16.to_le_bytes());
    bytes.extend(rate.to_le_bytes()); bytes.extend((rate * 2).to_le_bytes());
    bytes.extend(2u16.to_le_bytes()); bytes.extend(16u16.to_le_bytes()); bytes.extend(b"data"); bytes.extend(size.to_le_bytes());
    for sample in samples {
        let finite = if sample.is_finite() { sample.clamp(-1.0, 1.0) } else { 0.0 };
        // Cast after clamping, keeping the original mono waveform as PCM16.
        bytes.extend(((finite * i16::MAX as f32).round() as i16).to_le_bytes());
    }
    bytes
}

/// Verify only committed chunks and derive aligned playback files. No source
/// files are deleted, even after success. Incomplete trailing journal data is
/// ignored; a malformed complete record or missing/hash-mismatched WAV fails.
pub fn recover_capture(directory: &Path) -> Result<Value> {
    // Archived originals are restored byte-for-byte before the existing
    // verifier/recovery path runs; playback derivatives are never substitutes.
    super::source_archive::restore(directory)?;
    let bytes = fs::read(directory.join("timeline.jsonl"))?;
    let last_newline = bytes.iter().rposition(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0);
    let mut chunks = BTreeMap::<String, Vec<Value>>::new();
    let mut duration = 0.0f64;
    let mut gaps = Vec::new();
    let mut dropped_samples = 0u64;
    for line in bytes[..last_newline].split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let record: Value = serde_json::from_slice(line).context("Invalid committed capture journal record")?;
        if record["kind"] == "gap" { gaps.push(record.clone()); }
        if record["kind"] == "capture_finalized" { dropped_samples = record["dropped_samples"].as_u64().unwrap_or(0); }
        if record["kind"] == "capture_stopped" {
            let stopped = record["at_seconds"].as_f64().context("Invalid stop time")?;
            if !stopped.is_finite() || !(0.0..=8.0 * 3600.0).contains(&stopped) { bail!("Invalid stop time"); }
            duration = duration.max(stopped);
        }
        if record["kind"] != "audio_chunk" { continue; }
        let track = record["track"].as_str().unwrap_or("");
        let sequence = record["sequence"].as_u64().context("Missing chunk sequence")?;
        if !["microphone", "system"].contains(&track) { bail!("Invalid capture track"); }
        let expected = format!("tracks/{track}/{sequence:08}.wav");
        if record["file"].as_str() != Some(expected.as_str()) { bail!("Invalid capture chunk path"); }
        let path = directory.join(&expected);
        // Canonical containment also rejects symlinks/reparse-point escapes.
        if !fs::canonicalize(&path)?.starts_with(fs::canonicalize(directory)?) { bail!("Capture chunk escaped session directory"); }
        let audio = fs::read(&path)?;
        let count = record["sample_count"].as_u64().context("Missing sample count")?;
        let rate = record["sample_rate"].as_u64().context("Missing sample rate")?;
        if count == 0 || count > rate { bail!("Invalid committed chunk size"); }
        let start = record["start_seconds"].as_f64().context("Missing timestamp")?;
        let end = record["end_seconds"].as_f64().context("Missing timestamp")?;
        if !(8000..=384000).contains(&rate) || !start.is_finite() || !end.is_finite() || start < 0.0 || end < start || end > 8.0 * 3600.0 { bail!("Invalid capture timeline"); }
        if (end - start - count as f64 / rate as f64).abs() > 0.0001 { bail!("Chunk duration does not match sample count"); }
        if audio.len() != 44 + count as usize * 2 || audio[..44] != wav_bytes(rate as u32, &vec![0.0; count as usize])[..44] {
            bail!("Invalid WAV header or length: {expected}");
        }
        if record["sha256"].as_str() != Some(format!("{:x}", Sha256::digest(&audio)).as_str()) { bail!("Capture hash mismatch: {expected}"); }
        let prior = chunks.entry(track.to_string()).or_default();
        if sequence != prior.len() as u64 || prior.last().and_then(|v| v["end_seconds"].as_f64()).unwrap_or(0.0) > start + 0.0001 { bail!("Non-contiguous sequence or overlapping capture chunks"); }
        duration = duration.max(end);
        prior.push(record);
    }
    if chunks.is_empty() { bail!("No committed source audio found; session retained for inspection"); }
    let rate = 48000u32;
    let mut outputs = serde_json::Map::new();
    for (track, records) in chunks {
        let target = directory.join(format!("{track}.wav"));
        let temp = target.with_extension("wav.part");
        let mut file = File::create(&temp)?;
        // Sparse zeros preserve startup, interruptions, pauses and final silence.
        let length = (duration * rate as f64).ceil() as u64;
        let header = wav_bytes(rate, &[]);
        file.write_all(&header)?;
        file.set_len(44 + length * 2)?;
        for record in records {
            let input = fs::read(directory.join(record["file"].as_str().unwrap()))?;
            let source: Vec<i16> = input[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
            let source_rate = record["sample_rate"].as_f64().unwrap();
            let count = (source.len() as f64 * rate as f64 / source_rate).round() as usize;
            let start = (record["start_seconds"].as_f64().unwrap() * rate as f64).round() as u64;
            file.seek(SeekFrom::Start(44 + start * 2))?;
            let mut output = Vec::with_capacity(count * 2);
            for i in 0..count {
                let position = i as f64 * source_rate / rate as f64;
                let left = position.floor() as usize;
                let fraction = position - left as f64;
                let a = source[left.min(source.len() - 1)] as f64;
                let b = source[(left + 1).min(source.len() - 1)] as f64;
                output.extend(((a + (b - a) * fraction).round() as i16).to_le_bytes());
            }
            file.write_all(&output)?;
        }
        file.seek(SeekFrom::Start(4))?; file.write_all(&(36 + length as u32 * 2).to_le_bytes())?;
        file.seek(SeekFrom::Start(40))?; file.write_all(&(length as u32 * 2).to_le_bytes())?;
        file.sync_all()?; drop(file);
        fs::rename(temp, &target)?;
        outputs.insert(track, json!(target));
    }
    // Derived mono playback, streamed in small blocks to keep long calls bounded.
    let mut inputs: Vec<File> = outputs.values().map(|path| File::open(path.as_str().unwrap())).collect::<std::io::Result<_>>()?;
    for input in &mut inputs { input.seek(SeekFrom::Start(44))?; }
    let mixed_path = directory.join("audio.wav");
    let mixed_temp = directory.join("audio.wav.part");
    let mut mixed = File::create(&mixed_temp)?;
    mixed.write_all(&wav_bytes(rate, &[]))?;
    let length = (duration * rate as f64).ceil() as u64;
    let mut position = 0u64;
    while position < length {
        let count = (length - position).min(4096) as usize;
        let mut sums = vec![0i32; count];
        for input in &mut inputs {
            let mut block = vec![0u8; count * 2];
            input.read_exact(&mut block)?;
            for (index, pair) in block.chunks_exact(2).enumerate() { sums[index] += i16::from_le_bytes([pair[0], pair[1]]) as i32; }
        }
        let mut block = Vec::with_capacity(count * 2);
        for sum in sums { block.extend((sum.clamp(i16::MIN as i32, i16::MAX as i32) as i16).to_le_bytes()); }
        mixed.write_all(&block)?;
        position += count as u64;
    }
    mixed.seek(SeekFrom::Start(4))?; mixed.write_all(&(36 + length as u32 * 2).to_le_bytes())?;
    mixed.seek(SeekFrom::Start(40))?; mixed.write_all(&(length as u32 * 2).to_le_bytes())?;
    mixed.sync_all()?; drop(mixed); fs::rename(mixed_temp, &mixed_path)?;
    let report = json!({"schema_version":1, "verified":true, "duration_seconds":duration, "tracks":outputs, "audio_file":mixed_path, "source_chunks_retained":true, "source_journal_sha256":format!("{:x}", Sha256::digest(&bytes)), "gaps":gaps,"dropped_samples":dropped_samples,"ignored_incomplete_journal_bytes":bytes.len()-last_newline});
    let mut verification = File::create(directory.join("recovery-verified.json"))?;
    serde_json::to_writer_pretty(&mut verification, &report)?; verification.sync_all()?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_pending_audio_and_preserves_independent_tracks_and_gaps() {
        let root = tempfile::tempdir().unwrap();
        let mut recorder = DurableRecorder::start(root.path(), None, Some("synthetic".into()), None).unwrap();
        recorder.sink.audio("microphone", 16000, 0.0, &vec![0.25; 8000]);
        recorder.sink.audio("system", 48000, 0.0, &vec![-0.25; 48000]);
        recorder.sink.audio("microphone", 16000, 1.5, &vec![0.5; 8000]);
        let info = recorder.finish(2.5).unwrap();
        let journal = fs::read_to_string(info.timeline_path).unwrap();
        assert!(journal.contains("\"kind\":\"gap\""));
        let microphone = fs::read(info.session_dir.join("microphone.wav")).unwrap();
        let system = fs::read(info.session_dir.join("system.wav")).unwrap();
        assert_eq!(microphone.len(), 44 + 2500 * 48 * 2);
        assert_eq!(system.len(), microphone.len());
        assert_eq!(&microphone[44 + 48000 * 2..44 + 48000 * 2 + 2], &[0, 0]);
        assert_ne!(&microphone[44..46], &system[44..46]);
    }

    #[test]
    fn audio_only_recovery_ignores_torn_tail_but_rejects_modified_audio() {
        let root = tempfile::tempdir().unwrap();
        let mut recorder = DurableRecorder::start(root.path(), None, None, None).unwrap();
        recorder.sink.audio("system", 16000, 0.0, &vec![0.0; 16000]);
        let info = recorder.finish(1.0).unwrap();
        OpenOptions::new().append(true).open(&info.timeline_path).unwrap().write_all(b"{torn").unwrap();
        assert_eq!(recover_capture(&info.session_dir).unwrap()["ignored_incomplete_journal_bytes"], 5);
        let chunk = info.session_dir.join("tracks/system/00000000.wav");
        let mut file = OpenOptions::new().write(true).open(&chunk).unwrap();
        file.seek(SeekFrom::Start(44)).unwrap(); file.write_all(&[1, 0]).unwrap(); drop(file);
        assert!(recover_capture(&info.session_dir).is_err());
        assert!(chunk.exists());
    }

    #[test]
    fn queue_failure_is_visible_and_does_not_block_capture_callback() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let sink = CaptureSink {
            sender: Arc::new(Mutex::new(Some(sender))),
            failure: Arc::new(Mutex::new(None)), dropped: Arc::new(AtomicU64::new(0)),
        };
        sink.audio("microphone", 16000, 0.0, &[0.5; 16]);
        sink.audio("microphone", 16000, 0.001, &[0.5; 16]);
        assert!(sink.error().is_some());
        assert_eq!(sink.dropped.load(Ordering::Relaxed), 16);
    }
}
