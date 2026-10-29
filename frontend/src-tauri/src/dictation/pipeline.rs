//! One serial decoder beside capture. The mailbox holds only the newest full
//! prefix; replacing a preview never drops audio from the final recording.
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

type ResultText = Result<Option<String>, String>;
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Transcript {
    pub text: String,
    pub draft_text: Option<String>,
    pub streaming_message: Option<String>,
    pub delivery_error: Option<String>,
}
struct Job { wav: Vec<u8>, final_request: bool }
#[derive(Default)]
struct Mailbox { pending: Option<Job>, final_requested: bool, done: bool, error: Option<String> }
struct Shared { mailbox: Mutex<Mailbox>, changed: Condvar }

pub(super) struct Pipeline {
    shared: Arc<Shared>,
    cancelled: Arc<AtomicBool>,
    result: mpsc::Receiver<ResultText>,
    owner: Option<JoinHandle<()>>,
}

impl Pipeline {
    pub(super) fn start(cancelled: Arc<AtomicBool>, transcribe: impl FnMut(&[u8], bool) -> ResultText + Send + 'static) -> Result<Self, String> {
        Self::start_with_updates(cancelled, transcribe, |_, _| {})
    }

    /// One observer sees confirmed cumulative text in request order.
    /// The worker owner validates confirmation before this delivery callback.
    pub(super) fn start_with_updates(cancelled: Arc<AtomicBool>, mut transcribe: impl FnMut(&[u8], bool) -> ResultText + Send + 'static,
        mut update: impl FnMut(&str, bool) + Send + 'static) -> Result<Self, String> {
        Self::start_stream(cancelled, move |wav, final_request| {
            transcribe(wav, final_request).map(|value| value.map(|text| Transcript { text, draft_text: None, streaming_message: None, delivery_error: None }))
        }, move |value, final_request| update(&value.text, final_request))
    }

    /// Draft-only revisions still reach the observer, independently of the
    /// immutable prefix used for foreground insertion. One decoder owns order.
    pub(super) fn start_stream(cancelled: Arc<AtomicBool>,
        mut transcribe: impl FnMut(&[u8], bool) -> Result<Option<Transcript>, String> + Send + 'static,
        mut update: impl FnMut(&Transcript, bool) + Send + 'static) -> Result<Self, String> {
        let shared = Arc::new(Shared { mailbox: Mutex::new(Mailbox::default()), changed: Condvar::new() });
        let (sender, result) = mpsc::channel();
        let state = shared.clone();
        let stop = cancelled.clone();
        let owner = thread::Builder::new().name("dictation-decode".into()).spawn(move || {
            let output = loop {
                if stop.load(Ordering::Acquire) { break Ok(None); }
                let job = {
                    let mut mailbox = state.mailbox.lock().unwrap_or_else(|p| p.into_inner());
                    while mailbox.pending.is_none() && !stop.load(Ordering::Acquire) {
                        mailbox = state.changed.wait_timeout(mailbox, Duration::from_millis(25))
                            .unwrap_or_else(|p| p.into_inner()).0;
                    }
                    if stop.load(Ordering::Acquire) { break Ok(None); }
                    mailbox.pending.take().expect("pending job")
                };
                match transcribe(&job.wav, job.final_request) {
                    Ok(Some(text)) => {
                        if stop.load(Ordering::Acquire) { break Ok(None); }
                        update(&text, job.final_request);
                        if stop.load(Ordering::Acquire) { break Ok(None); }
                        if job.final_request { break Ok(Some(text.text)); }
                    },
                    Ok(None) => break Ok(None),
                    Err(error) => break Err(error),
                }
            };
            let mut mailbox = state.mailbox.lock().unwrap_or_else(|p| p.into_inner());
            mailbox.pending.take();
            mailbox.error = output.as_ref().err().cloned();
            mailbox.done = true;
            drop(mailbox);
            let _ = sender.send(output);
        }).map_err(|e| format!("Could not start dictation processing: {e}"))?;
        Ok(Self { shared, cancelled, result, owner: Some(owner) })
    }

    pub(super) fn health(&self) -> Result<(), String> {
        let mailbox = self.shared.mailbox.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(error) = &mailbox.error { return Err(error.clone()); }
        if !self.cancelled.load(Ordering::Acquire)
            && self.owner.as_ref().map(|owner| owner.is_finished()).unwrap_or(false) {
            return Err("Dictation processing stopped unexpectedly.".into());
        }
        Ok(())
    }

    /// Called by the capture owner, never by the CPAL callback. No inference or
    /// disk I/O here, and no wait for a previous preview to finish.
    pub(super) fn preview(&self, make_wav: impl FnOnce() -> Result<Vec<u8>, String>) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) { return Ok(()); }
        let mut mailbox = self.shared.mailbox.lock().unwrap_or_else(|p| p.into_inner());
        if mailbox.done || mailbox.final_requested { return Ok(()); }
        mailbox.pending = Some(Job { wav: make_wav()?, final_request: false });
        self.shared.changed.notify_one();
        Ok(())
    }

    /// Stop replaces queued previews with the complete clip, so a slow decoder
    /// cannot build a backlog. In-flight inference is reused when it matches.
    pub(super) fn finish(mut self, wav: Vec<u8>, timeout: Duration) -> ResultText {
        {
            let mut mailbox = self.shared.mailbox.lock().unwrap_or_else(|p| p.into_inner());
            mailbox.final_requested = true;
            if !mailbox.done { mailbox.pending = Some(Job { wav, final_request: true }); }
            self.shared.changed.notify_one();
        }
        let result = match self.result.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.cancelled.store(true, Ordering::Release);
                self.shared.changed.notify_all();
                Err("Dictation took too long. Try a shorter phrase.".into())
            },
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("Dictation processing stopped unexpectedly.".into()),
        };
        if self.owner.take().expect("decoder owner").join().is_err() {
            return Err("Dictation processing stopped unexpectedly.".into());
        }
        result
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            self.cancelled.store(true, Ordering::Release);
            self.shared.changed.notify_all();
            let _ = owner.join();
        }
    }
}

/// Live dictation checks every second; the legacy capture helper checks every
/// two seconds. Both keep a
/// 100 ms filter-edge guard for normalized audio reused between requests.
/// Slow inference keeps only the latest prefix. This is a submission cadence,
/// not a promise that recognition or stable-word delivery finishes that fast.
pub(super) struct PreviewSchedule { next_seconds: usize, interval: usize }
impl PreviewSchedule {
    pub(super) fn new() -> Self { Self { next_seconds: 2, interval: 2 } }
    pub(super) fn streaming() -> Self { Self { next_seconds: 1, interval: 1 } }
    pub(super) fn due(&mut self, rate: u32, frames: usize) -> bool {
        if rate == 0 || self.next_seconds >= 120 || frames >= rate as usize * 120 { return false; }
        let guard = (rate as usize + 9) / 10;
        if frames < self.next_seconds * rate as usize + guard { return false; }
        while self.next_seconds * rate as usize + guard <= frames { self.next_seconds += self.interval; }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drafts_can_revise_without_changing_the_stable_prefix_and_stop_flushes() {
        let (tx, rx) = mpsc::channel();
        let pipeline = Pipeline::start_stream(Arc::new(AtomicBool::new(false)), |wav, final_request| {
            Ok(Some(Transcript { text: if final_request { "We are ready." } else { "We" }.into(),
                draft_text: if final_request { None } else { Some(if wav[0] == 1 { "were" } else { "are ready" }.into()) }, streaming_message: None, delivery_error: None }))
        }, move |value, final_request| { tx.send((value.clone(), final_request)).unwrap(); }).unwrap();
        pipeline.preview(|| Ok(vec![1])).unwrap();
        let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        pipeline.preview(|| Ok(vec![2])).unwrap();
        let second = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first.0.text, second.0.text);
        assert_eq!(first.0.draft_text.as_deref(), Some("were"));
        assert_eq!(second.0.draft_text.as_deref(), Some("are ready"));
        assert_eq!(pipeline.finish(vec![3], Duration::from_secs(2)).unwrap().as_deref(), Some("We are ready."));
        let final_update = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(final_update.1);
        assert_eq!(final_update.0.draft_text, None);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn cancelling_a_draft_decode_prevents_the_observer() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let pipeline = Pipeline::start_stream(cancelled, move |_, _| {
            stop.store(true, Ordering::Release);
            Ok(Some(Transcript { text: "stable".into(), draft_text: Some("draft".into()), streaming_message: None, delivery_error: None }))
        }, |_, _| panic!("cancelled decode must not publish")).unwrap();
        assert!(pipeline.finish(vec![1], Duration::from_secs(2)).unwrap().is_none());
    }

    #[test]
    fn streaming_cadence_is_one_second_and_keeps_only_the_latest_due_prefix() {
        for rate in [8000, 16000, 44100, 48000, 47999, 192000] {
            let mut schedule = PreviewSchedule::streaming();
            let boundary = rate as usize + (rate as usize + 9) / 10;
            assert!(!schedule.due(rate, boundary - 1));
            assert!(schedule.due(rate, boundary));
            assert!(!schedule.due(rate, boundary));
            assert!(schedule.due(rate, boundary + rate as usize));
            assert!(schedule.due(rate, rate as usize * 80));
            assert!(!schedule.due(rate, rate as usize * 80));
            assert!(!schedule.due(rate, rate as usize * 120));
        }
    }

    #[test]
    fn live_previews_start_before_twenty_seconds_skip_backlog_and_stop_before_limit() {
        for rate in [8000, 16000, 44100, 48000, 47999, 192000] {
            let mut schedule = PreviewSchedule::new();
            let boundary = rate as usize * 2 + (rate as usize + 9) / 10;
            assert!(!schedule.due(rate, boundary - 1));
            assert!(schedule.due(rate, boundary));
            assert!(!schedule.due(rate, boundary + 1));
            assert!(schedule.due(rate, rate as usize * 101));
            assert!(schedule.due(rate, rate as usize * 119));
            assert!(!schedule.due(rate, rate as usize * 120));
        }
    }

    #[test]
    fn live_updates_arrive_before_stop_and_final_is_observed_once() {
        let (sent, updates) = mpsc::channel();
        let pipeline = Pipeline::start_with_updates(Arc::new(AtomicBool::new(false)), |_, final_request| {
            Ok(Some(if final_request { "नमस्ते world." } else { "नमस्ते world" }.into()))
        }, move |text, final_request| { sent.send((text.to_owned(), final_request)).unwrap(); }).unwrap();
        pipeline.preview(|| Ok(vec![1])).unwrap();
        assert_eq!(updates.recv_timeout(Duration::from_secs(2)).unwrap(), ("नमस्ते world".into(), false));
        assert_eq!(pipeline.finish(vec![1, 2], Duration::from_secs(2)).unwrap(), Some("नमस्ते world.".into()));
        assert_eq!(updates.recv_timeout(Duration::from_secs(2)).unwrap(), ("नमस्ते world.".into(), true));
        assert!(updates.try_recv().is_err());
    }

    #[test]
    fn cancelled_inflight_result_cannot_reach_live_delivery() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let (started, waiting) = mpsc::channel();
        let (sent, updates) = mpsc::channel();
        let pipeline = Pipeline::start_with_updates(cancelled.clone(), move |_, _| {
            started.send(()).unwrap();
            while !stop.load(Ordering::Acquire) { thread::sleep(Duration::from_millis(1)); }
            Ok(Some("late text must not type".into()))
        }, move |_, _| { sent.send(()).unwrap(); }).unwrap();
        pipeline.preview(|| Ok(vec![1])).unwrap();
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(pipeline);
        assert!(updates.try_recv().is_err());
    }

    #[test]
    fn slow_preview_cannot_queue_old_audio_ahead_of_complete_final_clip() {
        let (started, waiting) = mpsc::channel();
        let (release, proceed) = mpsc::channel();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = calls.clone();
        let pipeline = Pipeline::start(Arc::new(AtomicBool::new(false)), move |wav, final_request| {
            observed.lock().unwrap().push((wav.to_vec(), final_request));
            if !final_request { started.send(()).unwrap(); proceed.recv().unwrap(); }
            Ok(Some(if final_request { "पूर्ण text" } else { "must never be inserted" }.into()))
        }).unwrap();
        pipeline.preview(|| Ok(vec![1])).unwrap();
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        pipeline.preview(|| Ok(vec![1, 2])).unwrap();
        pipeline.preview(|| Ok(vec![1, 2, 3])).unwrap();
        let state = pipeline.shared.clone();
        let finisher = thread::spawn(move || pipeline.finish(vec![1, 2, 3, 4], Duration::from_secs(2)));
        while !state.mailbox.lock().unwrap().final_requested { thread::yield_now(); }
        release.send(()).unwrap();
        assert_eq!(finisher.join().unwrap().unwrap(), Some("पूर्ण text".into()));
        assert_eq!(*calls.lock().unwrap(), vec![(vec![1], false), (vec![1, 2, 3, 4], true)]);
    }

    #[test]
    fn short_phrase_submits_only_complete_final_audio() {
        let pipeline = Pipeline::start(Arc::new(AtomicBool::new(false)), |wav, final_request| {
            assert!(final_request); assert_eq!(wav, &[1, 2, 3]); Ok(Some("short".into()))
        }).unwrap();
        assert_eq!(pipeline.finish(vec![1, 2, 3], Duration::from_secs(2)).unwrap(), Some("short".into()));
    }

    #[test]
    fn failed_preview_cannot_return_partial_text_or_submit_final() {
        let (started, waiting) = mpsc::channel();
        let pipeline = Pipeline::start(Arc::new(AtomicBool::new(false)), move |_, final_request| {
            assert!(!final_request); started.send(()).unwrap(); Err("model failed".into())
        }).unwrap();
        pipeline.preview(|| Ok(vec![1])).unwrap();
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        while !pipeline.shared.mailbox.lock().unwrap().done { thread::yield_now(); }
        assert_eq!(pipeline.health(), Err("model failed".into()));
        assert_eq!(pipeline.finish(vec![1, 2], Duration::from_secs(2)), Err("model failed".into()));
    }

    #[test]
    fn drop_cancels_inflight_work_and_joins_its_owner() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let exited = Arc::new(AtomicBool::new(false));
        let observed = exited.clone();
        let (started, waiting) = mpsc::channel();
        let pipeline = Pipeline::start(cancelled.clone(), move |_, _| {
            started.send(()).unwrap();
            while !stop.load(Ordering::Acquire) { thread::sleep(Duration::from_millis(1)); }
            observed.store(true, Ordering::Release); Ok(None)
        }).unwrap();
        pipeline.preview(|| Ok(vec![1])).unwrap();
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(pipeline);
        assert!(cancelled.load(Ordering::Acquire)); assert!(exited.load(Ordering::Acquire));
    }

    #[test]
    fn final_deadline_cancels_and_joins_an_inflight_preview() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let (started, waiting) = mpsc::channel();
        let pipeline = Pipeline::start(cancelled.clone(), move |_, _| {
            started.send(()).unwrap();
            while !stop.load(Ordering::Acquire) { thread::sleep(Duration::from_millis(1)); }
            Ok(None)
        }).unwrap();
        pipeline.preview(|| Ok(vec![1])).unwrap();
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(pipeline.finish(vec![1, 2], Duration::from_millis(20)).unwrap_err().contains("too long"));
        assert!(cancelled.load(Ordering::Acquire));
    }
}
