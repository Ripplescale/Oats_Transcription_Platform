//! Bounded observation of an owned stop task. A deadline never cancels device
//! teardown or releases the capture quarantine.
use std::time::Duration;
use tokio::sync::watch;

pub const STOP_WAIT: Duration = Duration::from_secs(15);
pub const STOP_PENDING: &str = "Recording has stopped accepting audio. Windows is still releasing an audio device or saving the source files. New recording stays unavailable until this finishes. Retry Finish to check again; original source chunks are retained.";
pub type Completion = Option<Result<(), String>>;

pub fn stop_reason(recording: bool, duration: f64, writer_error: Option<String>) -> Option<String> {
    if let Some(error) = writer_error { return Some(error); }
    if duration >= super::durable_capture::MAX_CAPTURE_SECONDS {
        return Some("The eight-hour recording limit was reached. Finishing this recording automatically; start a new recording when saving completes.".into());
    }
    (!recording).then(|| "Audio capture stopped after a device error. Source chunks are retained.".into())
}

pub async fn wait(mut receiver: watch::Receiver<Completion>, deadline: Duration) -> Result<(), String> {
    let completed = async {
        loop {
            if let Some(result) = receiver.borrow().clone() { return result; }
            receiver.changed().await.map_err(|_| "Recording shutdown acknowledgement was interrupted; source chunks are retained.".to_string())?;
        }
    };
    tokio::time::timeout(deadline, completed).await.map_err(|_| STOP_PENDING.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn timeout_does_not_cancel_owned_stop_and_repeated_observers_receive_completion() {
        let (sender, receiver) = watch::channel(None);
        let retry = receiver.clone();
        assert_eq!(wait(receiver, Duration::from_millis(5)).await.unwrap_err(), STOP_PENDING);
        assert!(sender.send(Some(Ok(()))).is_ok());
        assert!(wait(retry, Duration::from_millis(5)).await.is_ok());
    }
    #[tokio::test]
    async fn failed_finalization_remains_an_error_for_every_observer() {
        let (_sender, receiver) = watch::channel(Some(Err("disk full; source retained".into())));
        assert_eq!(wait(receiver.clone(), Duration::from_secs(1)).await.unwrap_err(), "disk full; source retained");
        assert!(wait(receiver, Duration::from_secs(1)).await.is_err());
    }
    #[test]
    fn automatic_stop_handles_writer_failure_stopped_capture_and_duration_cap() {
        assert_eq!(stop_reason(true, 1.0, Some("disk full".into())), Some("disk full".into()));
        assert!(stop_reason(false, 1.0, None).unwrap().contains("device error"));
        assert!(stop_reason(true, super::super::durable_capture::MAX_CAPTURE_SECONDS, None).unwrap().contains("eight-hour"));
        assert!(stop_reason(true, 1.0, None).is_none());
    }
}
