//! Offline timing probe using the exact native dictation worker owner.
//! Requires oats/other speech workers to be closed. Never captures/inserts text.
#[path = "../../../src/dictation/engine.rs"]
mod engine;
#[path = "../../../src/dictation/live_delivery.rs"]
mod live_delivery;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::atomic::AtomicBool, thread, time::{Duration, Instant}};

fn live_pcm(wav: &[u8]) -> Result<(usize, usize), String> {
    if wav.len() < 44 || &wav[..4] != b"RIFF" || &wav[8..16] != b"WAVEfmt "
        || wav[16..24] != [16, 0, 0, 0, 1, 0, 1, 0]
        || &wav[36..40] != b"data" || wav[32..36] != [2, 0, 16, 0]
        || wav.len() % 2 != 0 {
        return Err("Live probe requires a canonical mono PCM16 WAV header.".into());
    }
    let rate = u32::from_le_bytes(wav[24..28].try_into().unwrap()) as usize;
    let frames = (wav.len() - 44) / 2;
    if !(8000..=192000).contains(&rate) || frames == 0 || frames > rate * 120
        || u32::from_le_bytes(wav[28..32].try_into().unwrap()) as usize != rate * 2
        || u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize != wav.len() - 8
        || u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize != wav.len() - 44 {
        return Err("Invalid live PCM rate, size or duration (maximum 120 seconds).".into());
    }
    Ok((rate, frames))
}

/// Mirror capture's two-second cadence plus its 100 ms guard, retaining only
/// the latest due prefix when an earlier decode ran across several intervals.
fn latest_live_prefix(elapsed: Duration, rate: usize, frames: usize, next: usize) -> Option<(usize, usize)> {
    let available = (elapsed.as_nanos() * rate as u128 / 1_000_000_000).min(frames as u128) as usize;
    let first = rate * 2 + (rate + 9) / 10;
    if available < first || available >= frames { return None; }
    let index = (available - first) / (rate * 2);
    (index >= next).then_some((index, first + index * rate * 2))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LiveBackend { Trelis, FasterWhisper }

impl LiveBackend {
    fn from_config(config: &Value) -> Result<Self, String> {
        match config.get("dictation_backend") {
            None => Ok(Self::Trelis),
            Some(value) if value.as_str() == Some("trelis") => Ok(Self::Trelis),
            Some(value) if value.as_str() == Some("faster_whisper") => Ok(Self::FasterWhisper),
            _ => Err("Unsupported dictation benchmark backend.".into()),
        }
    }
    fn interval(self) -> usize { if self == Self::FasterWhisper { 1 } else { 2 } }
    fn marker(self) -> &'static str {
        if self == Self::FasterWhisper { "stable_words" } else { "confirmed_phrases" }
    }
}

fn backend_live_prefix(backend: LiveBackend, elapsed: Duration, rate: usize, frames: usize, next: usize) -> Option<(usize, usize)> {
    if backend == LiveBackend::Trelis { return latest_live_prefix(elapsed, rate, frames, next); }
    let available = (elapsed.as_nanos() * rate as u128 / 1_000_000_000).min(frames as u128) as usize;
    let first = rate + (rate + 9) / 10;
    if available < first || available >= frames { return None; }
    let index = (available - first) / rate;
    (index >= next).then_some((index, first + index * rate))
}

#[derive(Default)]
struct DraftProgress { last: String, updates: usize, first_seconds: Option<f64> }

impl DraftProgress {
    fn observe(&mut self, draft: &str, elapsed: f64) {
        if draft != self.last {
            self.last = draft.to_string();
            self.updates += 1;
            if !draft.is_empty() { self.first_seconds.get_or_insert(elapsed); }
        }
    }
}

fn blocked_code(delivery: &live_delivery::Delivery) -> Option<&'static str> {
    delivery.blocked_reason().map(|reason| {
        if reason.contains("revised words") { "committed_prefix_revised" }
        else if reason.contains("control character") { "invalid_control_character" }
        else if reason.contains("too long") { "input_length_limit" }
        else { "other_delivery_block" }
    })
}

/// Diagnostics may contain model text in future worker versions. Retain only
/// numeric/boolean leaves, never arbitrary string values, in the local report.
fn numeric_diagnostics(value: &Value) -> Value {
    match value {
        Value::Number(_) | Value::Bool(_) | Value::Null => value.clone(),
        Value::Array(values) => Value::Array(values.iter().map(numeric_diagnostics).collect()),
        Value::Object(values) => Value::Object(values.iter().filter(|(_, value)| !value.is_string())
            .map(|(key, value)| (key.clone(), numeric_diagnostics(value))).collect()),
        Value::String(_) => Value::Null,
    }
}

fn expected_samples(frames: usize, rate: usize) -> u64 {
    // Match Python round(frames * 16000 / rate), including ties-to-even.
    let numerator = frames as u64 * 16_000;
    let quotient = numerator / rate as u64;
    let twice_remainder = (numerator % rate as u64) * 2;
    quotient + u64::from(twice_remainder > rate as u64
        || (twice_remainder == rate as u64 && quotient % 2 != 0))
}

fn verify_confirmed_response(result: &Value, expected: u64, final_request: bool) -> Result<(u64, u64), String> {
    if result["live_delivery"].as_str() != Some("confirmed_phrases")
        || result["live_endpoint_available"].as_bool().is_none() {
        return Err("Missing finalized-phrase contract.".into());
    }
    let phrases = result["confirmed_phrase_count"].as_u64().ok_or("Invalid confirmed phrase count")?;
    let confirmed = result["confirmed_samples"].as_u64().ok_or("Invalid confirmed sample count")?;
    let audio = result["audio_sample_count"].as_u64().ok_or("Invalid audio sample count")?;
    if audio != expected || confirmed > audio || (final_request && confirmed != audio) {
        return Err("Finalized phrase audio coverage is inconsistent.".into());
    }
    Ok((phrases, confirmed))
}

fn verify_live_response(backend: LiveBackend, result: &Value, expected: u64,
                       session: &str, final_request: bool) -> Result<(u64, u64), String> {
    if result["stream"] != json!({"id":session,"final":final_request,"live":true}) {
        return Err("Live benchmark response belongs to a different stream request.".into());
    }
    if backend == LiveBackend::Trelis { return verify_confirmed_response(result, expected, final_request); }
    let words = result["confirmed_word_count"].as_u64().ok_or("Invalid stable word count")?;
    let confirmed = result["confirmed_samples"].as_u64().ok_or("Invalid stable sample count")?;
    let audio = result["audio_sample_count"].as_u64().ok_or("Invalid audio sample count")?;
    let draft = result["draft_text"].as_str().ok_or("Missing provisional draft")?;
    let text = result["text"].as_str().ok_or("Missing stable text")?;
    if result["live_delivery"].as_str() != Some("stable_words") || audio != expected || audio > 120 * 16_000
        || confirmed > audio || words > 32_768 || (words == 0 && !text.trim().is_empty())
        || (audio == 0 && (words != 0 || !draft.is_empty()))
        || text.encode_utf16().count() > 32_768 || draft.encode_utf16().count() > 32_768
        || draft.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        || (final_request && (confirmed != audio || !draft.is_empty())) {
        return Err("Stable-word streaming contract is inconsistent.".into());
    }
    Ok((words, confirmed))
}

fn verify_confirmed_ranges(result: &Value, wav: &[u8], rate: usize, confirmed: u64) -> Result<(), String> {
    let ranges = result["confirmed_ranges"].as_array().ok_or("Missing confirmed audio ranges")?;
    let mut cursor = 0;
    for range in ranges {
        let start = range["start_sample"].as_u64().ok_or("Invalid range start")?;
        let end = range["end_sample"].as_u64().ok_or("Invalid range end")?;
        if start != cursor || end <= start || end > confirmed {
            return Err("Confirmed audio ranges have gaps or overlap.".into());
        }
        let hash = range["pcm_sha256"].as_str().ok_or("Missing confirmed PCM hash")?;
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid confirmed PCM hash.".into());
        }
        if rate == 16_000 {
            let pcm = wav.get(44 + start as usize * 2..44 + end as usize * 2)
                .ok_or("Confirmed range exceeds input PCM")?;
            if hash != format!("{:x}", Sha256::digest(pcm)) {
                return Err("Confirmed range does not match the original PCM.".into());
            }
        }
        cursor = end;
    }
    if cursor != confirmed { return Err("Confirmed ranges do not cover all consumed audio.".into()); }
    Ok(())
}

fn confirmed_diagnostics(result: &Value) -> Value {
    json!({"confirmed_phrase_count":result["confirmed_phrase_count"],
        "live_endpoint_available":result["live_endpoint_available"],
        "confirmed_samples":result["confirmed_samples"], "audio_sample_count":result["audio_sample_count"],
        "confirmed_ranges":numeric_diagnostics(&result["confirmed_ranges"]),
        "windows":numeric_diagnostics(&result["windows"]),
        "endpoint":numeric_diagnostics(&result["endpoint"])})
}

fn live_diagnostics(backend: LiveBackend, result: &Value) -> Value {
    if backend == LiveBackend::Trelis { return confirmed_diagnostics(result); }
    json!({"confirmed_word_count":result["confirmed_word_count"],
        "confirmed_samples":result["confirmed_samples"], "audio_sample_count":result["audio_sample_count"],
        "alignment_available":result["alignment_available"],
        "windows":numeric_diagnostics(&result["windows"])})
}

fn live_probe(worker: &mut engine::Worker, wav: &[u8], rate: usize, frames: usize,
              reconcile: bool, backend: LiveBackend) -> Result<String, String> {
    // Exact prefix schedule from the first paced 60-second probe. Replay does
    // no sleeping and makes no claim about real-time delivery or throughput.
    let replay_seconds = [2,4,6,8,10,14,20,26,30,34,38,40,44,46,48,50,54,56,58];
    let session = uuid::Uuid::new_v4().to_string();
    let cancelled = AtomicBool::new(false);
    let capture_started = Instant::now();
    let capture_duration = Duration::from_secs_f64(frames as f64 / rate as f64);
    let mut next = 0;
    let mut skipped = 0;
    let mut previews = 0;
    let mut confirmed_phrases = 0;
    let mut confirmed_samples = 0;
    let mut updates = 0;
    let mut first_delivery = None;
    let mut drafts = DraftProgress::default();
    let mut delivery = live_delivery::Delivery::new();
    // This is the only destination: no OS input, microphone or clipboard APIs.
    let mut sent = String::new();
    loop {
        let elapsed = capture_started.elapsed();
        let selected = if reconcile {
            let Some(seconds) = replay_seconds.get(next) else { break; };
            let prefix_frames = *seconds * rate + (rate + 9) / 10;
            if prefix_frames >= frames { break; }
            Some((next, prefix_frames))
        } else {
            if elapsed >= capture_duration { break; }
            backend_live_prefix(backend, elapsed, rate, frames, next)
        };
        let Some((index, prefix_frames)) = selected else {
            let interval = rate * backend.interval();
            let next_frames = (interval + (rate + 9) / 10 + next * interval).min(frames);
            let due = Duration::from_secs_f64(next_frames as f64 / rate as f64);
            thread::sleep(due.saturating_sub(elapsed).min(Duration::from_millis(25)).max(Duration::from_millis(1)));
            continue;
        };
        skipped += index - next;
        next = index + 1;
        let end = 44 + prefix_frames * 2;
        let mut prefix = wav[..end].to_vec();
        prefix[4..8].copy_from_slice(&((end - 8) as u32).to_le_bytes());
        prefix[40..44].copy_from_slice(&((end - 44) as u32).to_le_bytes());
        let requested = capture_started.elapsed().as_secs_f64();
        let began = Instant::now();
        let result = worker.transcribe_live(&uuid::Uuid::new_v4().to_string(), &prefix,
            &cancelled, Duration::from_secs(180), &session, false)?.ok_or("Cancelled live preview")?;
        let request_seconds = began.elapsed().as_secs_f64();
        let (phrases, consumed) = verify_live_response(backend, &result, expected_samples(prefix_frames, rate), &session, false)?;
        if backend == LiveBackend::Trelis { verify_confirmed_ranges(&result, wav, rate, consumed)?; }
        if phrases < confirmed_phrases || consumed < confirmed_samples {
            return Err("Finalized phrase progress moved backwards.".into());
        }
        confirmed_phrases = phrases;
        confirmed_samples = consumed;
        let text = result["text"].as_str().ok_or("Missing confirmed live text")?;
        let draft = if backend == LiveBackend::FasterWhisper { result["draft_text"].as_str().unwrap() } else { "" };
        drafts.observe(draft, capture_started.elapsed().as_secs_f64());
        let before = delivery.inserted_characters();
        delivery.observe(text, false, |suffix| {
            first_delivery.get_or_insert_with(|| capture_started.elapsed().as_secs_f64());
            sent.push_str(suffix); updates += 1; Ok(())
        });
        previews += 1;
        let matches_confirmed = live_delivery::normalize_text(text).map(|value| value == sent).unwrap_or(false);
        println!("{}", json!({"stage":"live_preview", "index":previews-1,
            "prefix_seconds":prefix_frames as f64/rate as f64, "request_started_seconds":requested,
            "native_request_seconds":request_seconds, "response_seconds":capture_started.elapsed().as_secs_f64(),
            "cache_hit_count":result["cache_hit_count"], "timing":numeric_diagnostics(&result["timing"]),
            "confirmed_text_characters":text.chars().count(), "sent_characters":delivery.inserted_characters(),
            "live_delivery":backend.marker(), "draft_characters":draft.chars().count(),
            "draft_updates":drafts.updates, "first_draft_seconds":if reconcile { None } else { drafts.first_seconds },
            "delta_characters":delivery.inserted_characters()-before, "delivery_updates":updates,
            "blocked_reason_code":blocked_code(&delivery), "obsolete_prefixes_skipped":skipped,
            "sent_matches_normalized_confirmed":matches_confirmed,
            "confirmed_pcm_hashes_match":(backend == LiveBackend::Trelis && rate == 16_000).then_some(true),
            "confirmed":live_diagnostics(backend, &result), "paced":!reconcile}));
        if !matches_confirmed || delivery.blocked_reason().is_some() || sent != delivery.committed() {
            return Err("Simulated typing did not deliver exactly the confirmed phrases.".into());
        }
    }
    let updates_before_final = updates;
    let drafts_before_final = drafts.updates;
    let final_submitted = capture_started.elapsed();
    let began = Instant::now();
    let result = worker.transcribe_live(&uuid::Uuid::new_v4().to_string(), wav,
        &cancelled, Duration::from_secs(180), &session, true)?.ok_or("Cancelled live final")?;
    let request_seconds = began.elapsed().as_secs_f64();
    let (phrases, consumed) = verify_live_response(backend, &result, expected_samples(frames, rate), &session, true)?;
    if backend == LiveBackend::Trelis { verify_confirmed_ranges(&result, wav, rate, consumed)?; }
    if phrases < confirmed_phrases || consumed < confirmed_samples {
        return Err("Finalized phrase progress moved backwards at Stop.".into());
    }
    let text = result["text"].as_str().ok_or("Missing live final text")?;
    drafts.observe("", capture_started.elapsed().as_secs_f64());
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    delivery.observe(text, true, |suffix| {
        first_delivery.get_or_insert_with(|| capture_started.elapsed().as_secs_f64());
        sent.push_str(suffix); updates += 1; Ok(())
    });
    if sent != delivery.committed() || delivery.final_text() != Some(text) {
        return Err("Simulated delivery ledger or final result is inconsistent.".into());
    }
    let normalized_matches = live_delivery::normalize_text(text).map(|value| value == sent).unwrap_or(false);
    println!("{}", json!({"stage":"live_final", "audio_seconds":frames as f64/rate as f64,
        "native_request_seconds":request_seconds,
        "final_submission_after_stop_seconds":(!reconcile).then_some(final_submitted.saturating_sub(capture_duration).as_secs_f64()),
        "final_wait_after_stop_seconds":(!reconcile).then_some(capture_started.elapsed().saturating_sub(capture_duration).as_secs_f64()),
        "text_sha256":hash, "text_characters":text.chars().count(),
        "sent_text_sha256":format!("{:x}",Sha256::digest(sent.as_bytes())), "sent_characters":sent.chars().count(),
        "sent_matches_normalized_final":normalized_matches, "first_simulated_delivery_seconds":if reconcile { None } else { first_delivery },
        "delivery_updates":updates, "preview_delivery_updates":updates_before_final,
        "live_delivery":backend.marker(), "draft_updates":drafts.updates,
        "preview_draft_updates":drafts_before_final, "draft_cleared":drafts.last.is_empty(),
        "first_draft_seconds":if reconcile { None } else { drafts.first_seconds },
        "preview_requests":previews, "obsolete_prefixes_skipped":skipped,
        "blocked_reason_code":blocked_code(&delivery), "cache_hit_count":result["cache_hit_count"],
        "timing":numeric_diagnostics(&result["timing"]), "simulation_only":true, "os_input_attempts":0,
        "all_audio_consumed":consumed == expected_samples(frames, rate),
        "confirmed_pcm_hashes_match":(backend == LiveBackend::Trelis && rate == 16_000).then_some(true),
        "confirmed":live_diagnostics(backend, &result), "paced":!reconcile}));
    if !normalized_matches || delivery.blocked_reason().is_some() {
        return Err("Simulated typing did not match the final confirmed transcript.".into());
    }
    Ok(hash)
}

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let streaming = args.len() == 4 && args[3] == "--stream";
    let live = args.len() == 4 && args[3] == "--live";
    let reconcile = args.len() == 4 && args[3] == "--reconcile";
    if args.len() != 3 && !streaming && !live && !reconcile { return Err("Usage: dictation-latency <runtime.json> <dictation_worker.py> <mono-pcm16.wav> [--stream|--live|--reconcile]".into()); }
    let paths: Vec<_> = args.into_iter().take(3).map(PathBuf::from).collect();
    if paths.iter().any(|p| !p.is_absolute() || !p.is_file()) { return Err("Provide three absolute existing file paths.".into()); }
    let config: Value = serde_json::from_slice(&fs::read(&paths[0]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let backend = LiveBackend::from_config(&config)?;
    if reconcile && backend == LiveBackend::FasterWhisper {
        return Err("The fixed Trelis replay schedule does not represent faster-whisper capture; use --live.".into());
    }
    let wav = fs::read(&paths[2]).map_err(|e| e.to_string())?;
    let live_audio = if live || reconcile { Some(live_pcm(&wav)?) } else { None };
    let began = Instant::now();
    let mut worker = engine::Worker::spawn(&config, &paths[1])?;
    let spawn_seconds = began.elapsed().as_secs_f64();
    while !worker.is_ready()? {
        if began.elapsed() > Duration::from_secs(180) { return Err("Warmup exceeded the benchmark deadline.".into()); }
        thread::sleep(Duration::from_millis(15));
    }
    println!("{}", json!({"stage":"ready", "spawn_seconds":spawn_seconds, "warmup_seconds":began.elapsed().as_secs_f64(),
        "audio_sha256":format!("{:x}",Sha256::digest(&wav))}));
    let mut hashes = Vec::new();
    for index in 0..if streaming || live || reconcile { 1 } else { 3 } {
        let began = Instant::now();
        let result = worker.transcribe(&uuid::Uuid::new_v4().to_string(), &wav, &AtomicBool::new(false), Duration::from_secs(180))?
            .ok_or("Benchmark was cancelled.")?;
        let text = result["text"].as_str().ok_or("Missing benchmark text.")?;
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        println!("{}", json!({"stage":"request", "index":index, "native_request_seconds":began.elapsed().as_secs_f64(),
            "audio_seconds":result["audio_seconds"], "text_sha256":hash, "text_characters":text.chars().count(),
            "worker_seconds":result["elapsed_seconds"], "timing":result["timing"], "windows":result["windows"]}));
        hashes.push(hash);
    }
    if streaming {
        // Probe inputs are deliberately canonical PCM WAVs created by the local
        // benchmark script, not a general WAV-container parser.
        if wav.len() < 44 || &wav[..4] != b"RIFF" || &wav[8..16] != b"WAVEfmt "
            || wav[16..24] != [16, 0, 0, 0, 1, 0, 1, 0]
            || &wav[36..40] != b"data" || wav[32..36] != [2, 0, 16, 0] {
            return Err("Streaming probe requires a canonical mono PCM16 WAV header.".into());
        }
        let rate = u32::from_le_bytes(wav[24..28].try_into().unwrap()) as usize;
        if !(8000..=192000).contains(&rate) || wav.len() % 2 != 0 { return Err("Invalid PCM rate/length.".into()); }
        let session = uuid::Uuid::new_v4().to_string();
        let frames = (wav.len() - 44) / 2;
        for seconds in (20..120).step_by(20) {
            let end = (seconds * rate + (rate + 9) / 10) * 2 + 44;
            if end >= wav.len() { break; }
            let mut prefix = wav[..end].to_vec();
            prefix[4..8].copy_from_slice(&((end - 8) as u32).to_le_bytes());
            prefix[40..44].copy_from_slice(&((end - 44) as u32).to_le_bytes());
            let began = Instant::now();
            let result = worker.transcribe_stream(&uuid::Uuid::new_v4().to_string(), &prefix,
                &AtomicBool::new(false), Duration::from_secs(180), &session, false)?.ok_or("Cancelled preview")?;
            if result["text"].as_str() != Some("") { return Err("Preview exposed text.".into()); }
            println!("{}", json!({"stage":"preview", "prefix_seconds":(end-44) as f64/2.0/rate as f64,
                "native_request_seconds":began.elapsed().as_secs_f64(), "cache_hit_count":result["cache_hit_count"],
                "windows":result["windows"]}));
        }
        let began = Instant::now();
        let result = worker.transcribe_stream(&uuid::Uuid::new_v4().to_string(), &wav,
            &AtomicBool::new(false), Duration::from_secs(180), &session, true)?.ok_or("Cancelled final")?;
        let text = result["text"].as_str().ok_or("Missing final text")?;
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        println!("{}", json!({"stage":"stream_final", "audio_seconds":frames as f64/rate as f64,
            "native_request_seconds":began.elapsed().as_secs_f64(), "text_sha256":hash,
            "text_characters":text.chars().count(), "cache_hit_count":result["cache_hit_count"],
            "timing":result["timing"], "windows":result["windows"]}));
        hashes.push(hash);
    }
    if let Some((rate, frames)) = live_audio {
        hashes.push(live_probe(&mut worker, &wav, rate, frames, reconcile, backend)?);
    }
    drop(worker);
    println!("{}", json!({"stage":"complete","same_text":hashes.windows(2).all(|pair|pair[0]==pair[1]),
        "whole_clip_comparison_diagnostic_only":live || reconcile,"worker_reaped":true}));
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        if std::env::args_os().any(|value| value == "--live" || value == "--reconcile") {
            // Runtime failures may contain local paths. Live reports retain an
            // error identity without exposing a path or any model-provided text.
            eprintln!("{}", json!({"stage":"failed", "code":"live_probe_failed",
                "error_sha256":format!("{:x}",Sha256::digest(error.as_bytes()))}));
        } else { eprintln!("{error}"); }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod live_probe_tests {
    use super::*;

    #[test]
    fn latest_prefix_waits_for_guard_skips_obsolete_intervals_and_stops_at_end() {
        let rate = 16_000;
        let frames = rate * 10;
        assert_eq!(latest_live_prefix(Duration::from_millis(2099), rate, frames, 0), None);
        assert_eq!(latest_live_prefix(Duration::from_millis(2100), rate, frames, 0), Some((0, 33_600)));
        assert_eq!(latest_live_prefix(Duration::from_millis(6100), rate, frames, 1), Some((2, 97_600)));
        assert_eq!(latest_live_prefix(Duration::from_millis(7000), rate, frames, 3), None);
        assert_eq!(latest_live_prefix(Duration::from_secs(10), rate, frames, 3), None);
        assert_eq!(latest_live_prefix(Duration::from_secs(3), rate, rate * 2, 0), None);
    }

    #[test]
    fn odd_sample_rate_uses_the_same_ceiling_guard_as_capture() {
        assert_eq!(latest_live_prefix(Duration::from_millis(2100), 47_999, 47_999 * 10, 0), None);
        assert_eq!(latest_live_prefix(Duration::from_millis(2101), 47_999, 47_999 * 10, 0), Some((0, 100_798)));
    }

    #[test]
    fn faster_whisper_cadence_starts_at_one_second_guard_and_skips_old_prefixes() {
        let backend = LiveBackend::FasterWhisper;
        let rate = 16_000;
        let frames = rate * 10;
        assert_eq!(backend_live_prefix(backend, Duration::from_millis(1099), rate, frames, 0), None);
        assert_eq!(backend_live_prefix(backend, Duration::from_millis(1100), rate, frames, 0), Some((0, 17_600)));
        assert_eq!(backend_live_prefix(backend, Duration::from_millis(4100), rate, frames, 1), Some((3, 65_600)));
        assert_eq!(backend_live_prefix(backend, Duration::from_millis(4900), rate, frames, 4), None);
        assert_eq!(backend_live_prefix(backend, Duration::from_secs(10), rate, frames, 4), None);
        assert_eq!(backend_live_prefix(backend, Duration::from_millis(1100), 47_999, 479_990, 0), None);
        assert_eq!(backend_live_prefix(backend, Duration::from_millis(1101), 47_999, 479_990, 0), Some((0, 52_799)));
        assert_eq!(backend_live_prefix(LiveBackend::Trelis, Duration::from_millis(1100), rate, frames, 0), None);
    }

    #[test]
    fn independent_backend_config_and_stream_contract_are_bound_together() {
        assert_eq!(LiveBackend::from_config(&json!({})).unwrap(), LiveBackend::Trelis);
        let backend = LiveBackend::from_config(&json!({"dictation_backend":"faster_whisper",
            "faster_whisper":{"model_path":"local model","cpu_threads":4}})).unwrap();
        assert_eq!(backend, LiveBackend::FasterWhisper);
        for config in [json!({"dictation_backend":null}), json!({"dictation_backend":"unknown"})] {
            assert!(LiveBackend::from_config(&config).is_err());
        }
        let session = uuid::Uuid::new_v4().to_string();
        let mut result = json!({"stream":{"id":session,"final":false,"live":true},
            "live_delivery":"stable_words","text":"hello","draft_text":"changing words",
            "confirmed_word_count":1,"confirmed_samples":0,"audio_sample_count":32_000});
        assert_eq!(verify_live_response(backend, &result, 32_000, &session, false).unwrap(), (1, 0));
        assert!(verify_live_response(LiveBackend::Trelis, &result, 32_000, &session, false).is_err());
        assert!(verify_live_response(backend, &result, 32_001, &session, false).is_err());
        assert!(verify_live_response(backend, &result, 32_000, "different session", false).is_err());
        result["stream"]["final"] = json!(true);
        assert!(verify_live_response(backend, &result, 32_000, &session, true).is_err());
        result["confirmed_samples"] = json!(32_000); result["draft_text"] = json!("");
        assert!(verify_live_response(backend, &result, 32_000, &session, true).is_ok());
        result["confirmed_word_count"] = json!("1");
        assert!(verify_live_response(backend, &result, 32_000, &session, true).is_err());
    }

    #[test]
    fn stable_word_contract_rejects_invalid_drafts_counters_and_marker() {
        let session = uuid::Uuid::new_v4().to_string();
        let baseline = json!({"stream":{"id":session,"final":false,"live":true},
            "live_delivery":"stable_words","text":"hello","draft_text":"draft",
            "confirmed_word_count":1,"confirmed_samples":0,"audio_sample_count":32_000});
        for (key, value) in [("draft_text", json!(null)), ("draft_text", json!("bad\u{0008}control")),
            ("draft_text", json!("x".repeat(32_769))), ("confirmed_word_count", json!(0)),
            ("confirmed_word_count", json!(32_769)), ("confirmed_samples", json!(32_001)),
            ("live_delivery", json!("confirmed_phrases"))] {
            let mut result = baseline.clone(); result[key] = value;
            assert!(verify_live_response(LiveBackend::FasterWhisper, &result, 32_000, &session, false).is_err(), "{key}");
        }
    }

    #[test]
    fn changed_drafts_with_unchanged_stable_text_never_type_twice() {
        let mut drafts = DraftProgress::default();
        let mut delivery = live_delivery::Delivery::new();
        let mut sent = String::new();
        let mut writes = 0;
        for (index, draft) in ["first draft", "revised draft", "revised draft"].iter().enumerate() {
            drafts.observe(draft, index as f64 + 1.0);
            delivery.observe("Stable words", false, |suffix| { sent.push_str(suffix); writes += 1; Ok(()) });
        }
        assert_eq!(sent, "Stable words");
        assert_eq!(writes, 1);
        assert_eq!(drafts.updates, 2);
        assert_eq!(drafts.first_seconds, Some(1.0));
        drafts.observe("", 4.0);
        delivery.observe("Stable words final", true, |suffix| { sent.push_str(suffix); writes += 1; Ok(()) });
        assert!(drafts.last.is_empty());
        assert_eq!(drafts.updates, 3);
        assert_eq!(writes, 2);
        assert_eq!(sent, "Stable words final");
        assert_eq!(sent, delivery.committed());
    }

    #[test]
    fn confirmed_contract_requires_complete_final_audio_and_typed_counters() {
        let mut result = json!({"live_delivery":"confirmed_phrases", "live_endpoint_available":true,
            "confirmed_phrase_count":1, "confirmed_samples":16_000, "audio_sample_count":32_000});
        assert_eq!(verify_confirmed_response(&result, 32_000, false).unwrap(), (1, 16_000));
        assert!(verify_confirmed_response(&result, 32_000, true).is_err());
        result["confirmed_samples"] = json!(32_000);
        assert!(verify_confirmed_response(&result, 32_000, true).is_ok());
        result["confirmed_phrase_count"] = json!("1");
        assert!(verify_confirmed_response(&result, 32_000, true).is_err());
        result["confirmed_phrase_count"] = json!(1);
        result["live_delivery"] = json!("provisional");
        assert!(verify_confirmed_response(&result, 32_000, false).is_err());
    }

    #[test]
    fn confirmed_ranges_match_exact_pcm_without_gaps_or_overlap() {
        let mut wav = vec![0; 44];
        wav.extend_from_slice(&[0, 0, 255, 127, 0, 128]);
        let mut result = json!({"confirmed_ranges":[{"start_sample":0,"end_sample":3,
            "pcm_sha256":format!("{:x}",Sha256::digest(&wav[44..]))}]});
        assert!(verify_confirmed_ranges(&result, &wav, 16_000, 3).is_ok());
        result["confirmed_ranges"][0]["start_sample"] = json!(1);
        assert!(verify_confirmed_ranges(&result, &wav, 16_000, 3).is_err());
        result["confirmed_ranges"][0]["start_sample"] = json!(0);
        wav[44] = 1;
        assert!(verify_confirmed_ranges(&result, &wav, 16_000, 3).is_err());
        assert!(verify_confirmed_ranges(&json!({"confirmed_ranges":[]}), &wav, 16_000, 3).is_err());
        assert!(verify_confirmed_ranges(&json!({"confirmed_ranges":[]}), &wav, 16_000, 0).is_ok());
    }

    #[test]
    fn numeric_diagnostics_exclude_text_even_in_nested_fields() {
        let report = numeric_diagnostics(&json!({"text":"हिन्दी private", "count":2,
            "window":{"text":"never print this","complete":true}, "array":["private",3]}));
        assert_eq!(report, json!({"count":2,"window":{"complete":true},"array":[null,3]}));
    }

    #[test]
    fn normalized_sample_counts_match_ties_to_even() {
        assert_eq!(expected_samples(5, 32_000), 2);
        assert_eq!(expected_samples(7, 32_000), 4);
        assert_eq!(expected_samples(60 * 16_000, 16_000), 960_000);
    }
}
