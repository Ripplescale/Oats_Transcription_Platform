//! Short, input-only capture. Run `capture` on one dedicated owner thread.
//! It never creates a meeting, opens system audio, or changes the meeting recorder.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
#[cfg(test)] use std::io::Write;
#[cfg(test)] use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

pub const MAX_CAPTURE_SECONDS: u32 = 120;

#[derive(Debug)]
pub enum CaptureCommand { Stop, Cancel }

#[derive(Debug, Clone)]
pub enum CaptureEvent {
    Started { device_name: String, sample_rate: u32 },
    Level { elapsed_seconds: f64, rms: f32 },
}

#[derive(Debug)]
pub struct CapturedAudio {
    pub sample_rate: u32,
    pub samples: Vec<f32>,
    pub duration_seconds: f64,
}

impl CapturedAudio {
    pub fn wav_bytes(&self) -> Result<Vec<u8>, String> {
        if self.sample_rate == 0 || self.samples.is_empty() { return Err("No microphone audio was captured".into()); }
        wav_bytes(self.sample_rate, &self.samples)
    }

    /// Preserve the native sample rate; the offline worker normalizes to 16 kHz.
    #[cfg(test)]
    pub fn write_wav(&self, path: &Path) -> Result<(), String> {
        let bytes = self.wav_bytes()?;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
}

fn mono<T: Sample>(data: &[T], channels: usize) -> Vec<f32> where f32: FromSample<T> {
    let used = channels.min(2);
    data.chunks_exact(channels).map(|frame| {
        let sum: f32 = frame.iter().take(used).map(|sample| {
            let value: f32 = (*sample).to_sample();
            if value.is_finite() { value.clamp(-1.0, 1.0) } else { 0.0 }
        }).sum();
        sum / used as f32
    }).collect()
}

fn build_stream<T: SizedSample + Sample>(device: &cpal::Device, config: &cpal::StreamConfig,
    samples: mpsc::SyncSender<Vec<f32>>, errors: mpsc::SyncSender<String>, overflow: Arc<AtomicBool>) -> Result<cpal::Stream, String>
    where f32: FromSample<T> {
    let channels = config.channels as usize;
    device.build_input_stream(config, move |data: &[T], _| {
        if samples.try_send(mono(data, channels)).is_err() { overflow.store(true, Ordering::Relaxed); }
    }, move |error| { let _ = errors.try_send(format!("Microphone capture failed: {error}")); }, None).map_err(|e| format!("Could not open microphone: {e}"))
}

fn select_device(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let name = name.map(str::trim).filter(|value| !value.is_empty()).map(|value| value.strip_suffix(" (input)").unwrap_or(value));
    if let Some(name) = name {
        return host.input_devices().map_err(|e| e.to_string())?.find(|device| device.name().ok().as_deref() == Some(name))
            .ok_or_else(|| "The selected microphone is unavailable. Choose another microphone in Settings.".into());
    }
    host.default_input_device().ok_or_else(|| "No microphone is available. Connect one and try again.".into())
}

/// Returns `None` after cancel or owner disconnection, and a clip after Stop/120s.
/// The CPAL stream is created, used and dropped on this calling thread.
pub fn capture(microphone_name: Option<String>, commands: mpsc::Receiver<CaptureCommand>, notify: impl Fn(CaptureEvent) + Send + 'static) -> Result<Option<CapturedAudio>, String> {
    capture_progress(microphone_name, commands, notify, || Ok(()), |_, _| Ok(()))
}

/// Progress sees a cumulative prefix on this owner thread. The audio callback
/// only enqueues microphone samples and never waits for transcription.
pub fn capture_progress(microphone_name: Option<String>, commands: mpsc::Receiver<CaptureCommand>, notify: impl Fn(CaptureEvent) + Send + 'static,
    health: impl Fn() -> Result<(), String>, progress: impl Fn(u32, &[f32]) -> Result<(), String>) -> Result<Option<CapturedAudio>, String> {
    capture_progress_scheduled(microphone_name, commands, notify, health, progress, super::pipeline::PreviewSchedule::new())
}

pub(super) fn capture_progress_scheduled(microphone_name: Option<String>, commands: mpsc::Receiver<CaptureCommand>, notify: impl Fn(CaptureEvent) + Send + 'static,
    health: impl Fn() -> Result<(), String>, progress: impl Fn(u32, &[f32]) -> Result<(), String>,
    mut previews: super::pipeline::PreviewSchedule) -> Result<Option<CapturedAudio>, String> {
    match commands.try_recv() { Ok(CaptureCommand::Cancel) | Err(mpsc::TryRecvError::Disconnected) => return Ok(None), Ok(CaptureCommand::Stop) => return Err("Dictation stopped before microphone capture started".into()), Err(mpsc::TryRecvError::Empty) => {} }
    let device = select_device(microphone_name.as_deref())?;
    let device_name = device.name().map_err(|e| e.to_string())?;
    let supported = device.default_input_config().map_err(|e| format!("Microphone format is unavailable: {e}"))?;
    let rate = supported.sample_rate().0;
    let config: cpal::StreamConfig = supported.clone().into();
    if !(8000..=192000).contains(&rate) || config.channels == 0 || config.channels > 32 { return Err("This microphone's audio format is not supported for dictation".into()); }
    let (sample_tx, sample_rx) = mpsc::sync_channel(128);
    let (error_tx, error_rx) = mpsc::sync_channel(1);
    let overflow = Arc::new(AtomicBool::new(false));
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, sample_tx, error_tx, overflow.clone()),
        SampleFormat::F64 => build_stream::<f64>(&device, &config, sample_tx, error_tx, overflow.clone()),
        SampleFormat::I8 => build_stream::<i8>(&device, &config, sample_tx, error_tx, overflow.clone()),
        SampleFormat::I16 => build_stream::<i16>(&device, &config, sample_tx, error_tx, overflow.clone()),
        SampleFormat::I32 => build_stream::<i32>(&device, &config, sample_tx, error_tx, overflow.clone()),
        SampleFormat::I64 => build_stream::<i64>(&device, &config, sample_tx, error_tx, overflow.clone()),
        SampleFormat::U8 => build_stream::<u8>(&device, &config, sample_tx, error_tx, overflow.clone()),
        SampleFormat::U16 => build_stream::<u16>(&device, &config, sample_tx, error_tx, overflow.clone()),
        SampleFormat::U32 => build_stream::<u32>(&device, &config, sample_tx, error_tx, overflow.clone()),
        SampleFormat::U64 => build_stream::<u64>(&device, &config, sample_tx, error_tx, overflow.clone()),
        _ => Err("This microphone sample format is not supported".into()),
    }?;
    match commands.try_recv() { Ok(CaptureCommand::Cancel) | Err(mpsc::TryRecvError::Disconnected) => return Ok(None), Ok(CaptureCommand::Stop) => return Err("Dictation stopped before microphone capture started".into()), Err(mpsc::TryRecvError::Empty) => {} }
    stream.play().map_err(|e| format!("Microphone access could not start: {e}"))?;
    notify(CaptureEvent::Started { device_name, sample_rate: rate });
    let began = Instant::now();
    let mut notified = Instant::now();
    let mut samples = Vec::new();
    let limit = rate as usize * MAX_CAPTURE_SECONDS as usize;
    let mut cancelled = false;
    loop {
        match commands.try_recv() { Ok(CaptureCommand::Stop) => break, Ok(CaptureCommand::Cancel) | Err(mpsc::TryRecvError::Disconnected) => { cancelled = true; break; }, Err(mpsc::TryRecvError::Empty) => {} }
        health()?;
        if let Ok(error) = error_rx.try_recv() { return Err(error); }
        if overflow.load(Ordering::Relaxed) { return Err("Microphone audio could not be captured completely. Please try dictation again.".into()); }
        if began.elapsed() >= Duration::from_secs(MAX_CAPTURE_SECONDS.into()) || samples.len() >= limit { break; }
        if let Ok(chunk) = sample_rx.recv_timeout(Duration::from_millis(25)) {
            let keep = chunk.len().min(limit.saturating_sub(samples.len()));
            if notified.elapsed() >= Duration::from_millis(100) {
                let rms = if chunk.is_empty() { 0.0 } else { (chunk.iter().map(|value| value * value).sum::<f32>() / chunk.len() as f32).sqrt() };
                notify(CaptureEvent::Level { elapsed_seconds: began.elapsed().as_secs_f64(), rms }); notified = Instant::now();
            }
            samples.extend_from_slice(&chunk[..keep]);
            if previews.due(rate, samples.len()) { progress(rate, &samples)?; }
        }
        if samples.is_empty() && began.elapsed() >= Duration::from_secs(5) { return Err("The microphone did not deliver audio. Check microphone access and try again.".into()); }
    }
    drop(stream);
    if cancelled { return Ok(None); }
    if let Ok(error) = error_rx.try_recv() { return Err(error); }
    if overflow.load(Ordering::Relaxed) { return Err("Microphone audio was interrupted; dictation was not submitted.".into()); }
    for chunk in sample_rx.try_iter() { let keep = chunk.len().min(limit.saturating_sub(samples.len())); samples.extend_from_slice(&chunk[..keep]); }
    if samples.is_empty() { return Err("No microphone audio was captured".into()); }
    Ok(Some(CapturedAudio { duration_seconds: samples.len() as f64 / rate as f64, sample_rate: rate, samples }))
}

pub(super) fn wav_bytes(rate: u32, samples: &[f32]) -> Result<Vec<u8>, String> {
    let size = u32::try_from(samples.len()).ok().and_then(|count| count.checked_mul(2)).ok_or("Dictation clip is too large")?;
    let mut bytes = Vec::with_capacity(44 + size as usize);
    bytes.extend(b"RIFF"); bytes.extend((36 + size).to_le_bytes()); bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes()); bytes.extend(1u16.to_le_bytes()); bytes.extend(1u16.to_le_bytes());
    bytes.extend(rate.to_le_bytes()); bytes.extend((rate * 2).to_le_bytes());
    bytes.extend(2u16.to_le_bytes()); bytes.extend(16u16.to_le_bytes()); bytes.extend(b"data"); bytes.extend(size.to_le_bytes());
    for sample in samples { let value = if sample.is_finite() { sample.clamp(-1.0, 1.0) } else { 0.0 }; bytes.extend(((value * 32768.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes()); }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn mono_preserves_level_and_ignores_auxiliary_array_channels() {
        assert_eq!(mono(&[0.5f32, 0.5, -1.0, -1.0, 0.25, 0.25, 1.0, 1.0], 4), vec![0.5, 0.25]);
        assert_eq!(mono(&[i16::MIN, i16::MAX], 1).len(), 2);
    }
    #[test] fn nonfinite_samples_become_silence_and_pcm_header_matches_native_rate() {
        assert_eq!(mono(&[f32::NAN, f32::INFINITY, 0.5], 1), vec![0.0, 0.0, 0.5]);
        let wav = wav_bytes(48000, &[-1.0, 0.0, 1.0]).unwrap();
        assert_eq!(&wav[..4], b"RIFF"); assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 48000);
        assert_eq!(wav.len(), 50); assert_eq!(&wav[44..], &[0, 128, 0, 0, 255, 127]);
    }
    #[test] fn cancelled_or_disconnected_owner_never_opens_a_microphone() {
        let (tx, rx) = mpsc::channel(); tx.send(CaptureCommand::Cancel).unwrap();
        assert!(capture(None, rx, |_| panic!("must not open input")).unwrap().is_none());
        let (tx, rx) = mpsc::channel(); drop(tx);
        assert!(capture(None, rx, |_| panic!("must not open input")).unwrap().is_none());
    }
}
