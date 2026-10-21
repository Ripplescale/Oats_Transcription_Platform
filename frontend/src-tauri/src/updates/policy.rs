//! Pure installation policy. Leases are Send and never retain a mutex guard
//! across async work. Installation excludes starts until handoff or failure.
use std::sync::{Arc, Mutex};

pub const HANDOFF_BUSY: &str = "An app update is being installed. Try again after oats restarts.";
const ASSET_PREFIX: &str =
    "https://github.com/Ripplescale/Oats_Transcription_Platform/releases/download/";
const LEGACY_ASSET_PREFIX: &str =
    "https://github.com/Ripplescale/Hinglish-Transcription-Platform/releases/download/";
pub fn approved_asset(address: &str, version: &str) -> bool {
    let Some(rest) = address.strip_prefix(ASSET_PREFIX).or_else(|| address.strip_prefix(LEGACY_ASSET_PREFIX)) else {
        return false;
    };
    let Some((tag, asset)) = rest.split_once('/') else {
        return false;
    };
    !tag.is_empty()
        && tag != "."
        && tag != ".."
        && tag.len() <= 128
        && tag
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"._-".contains(&v))
        && !version.is_empty()
        && version.len() <= 128
        && version
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b".+-".contains(&v))
        && asset == format!("oats_{version}_x64-setup.exe")
}
/// Called only after cryptographic validation of the trusted comment. Release
/// tooling emits an exact stable version; ambiguous/missing metadata fails shut.
pub fn signed_version_matches(trusted_comment: &str, announced: &str) -> Result<(), String> {
    let mut versions = trusted_comment
        .split('\t')
        .filter_map(|field| field.strip_prefix("version:"));
    if versions.next() != Some(announced) || versions.next().is_some() || announced.is_empty() {
        return Err("The installer signature does not confirm this release version. The app was not changed.".into());
    }
    Ok(())
}
#[derive(Default)]
struct Counts {
    starts: usize,
    installing: bool,
}
#[derive(Clone, Default)]
pub struct HandoffGate(Arc<Mutex<Counts>>);
pub struct StartLease(HandoffGate);
pub struct InstallLease(HandoffGate);

impl HandoffGate {
    pub fn start(&self) -> Result<StartLease, String> {
        let mut counts = self
            .0
            .lock()
            .map_err(|_| "The app activity guard is unavailable.".to_owned())?;
        if counts.installing {
            return Err(HANDOFF_BUSY.into());
        }
        counts.starts = counts
            .starts
            .checked_add(1)
            .ok_or("Too many app activities are starting.")?;
        Ok(StartLease(self.clone()))
    }
    pub fn install(&self) -> Result<InstallLease, String> {
        let mut counts = self
            .0
            .lock()
            .map_err(|_| "The app activity guard is unavailable.".to_owned())?;
        if counts.installing {
            return Err(HANDOFF_BUSY.into());
        }
        if counts.starts != 0 {
            return Err(
                "An app activity is starting or saving. Try installing again when it finishes."
                    .into(),
            );
        }
        counts.installing = true;
        Ok(InstallLease(self.clone()))
    }
}
impl Drop for StartLease {
    fn drop(&mut self) {
        if let Ok(mut counts) = self.0 .0.lock() {
            counts.starts -= 1;
        }
    }
}
impl Drop for InstallLease {
    fn drop(&mut self) {
        if let Ok(mut counts) = self.0 .0.lock() {
            counts.installing = false;
        }
    }
}

#[derive(Default)]
pub struct Activity {
    pub capture: bool,
    pub dictation: bool,
    pub local_jobs: bool,
    pub pending_dictation: bool,
}
pub fn dictation_result_pending(phase: &str, text: Option<&str>) -> bool {
    matches!(phase, "ready" | "error") && text.is_some_and(|value| !value.is_empty())
}
pub fn idle(activity: Activity) -> Result<(), String> {
    if activity.capture {
        return Err("Finish the meeting recording before installing the update.".into());
    }
    if activity.dictation {
        return Err("Finish or cancel dictation before installing the update.".into());
    }
    if activity.local_jobs {
        return Err("Wait for local transcription, speaker identification or recording storage work to finish before installing.".into());
    }
    if activity.pending_dictation {
        return Err(
            "Copy or save your dictation text and dismiss its popup before installing the update."
                .into(),
        );
    }
    Ok(())
}
pub fn version_matches(
    requested: &str,
    available: Option<&str>,
    has_download: bool,
) -> Result<(), String> {
    if requested.is_empty() || requested.len() > 128 || available != Some(requested) {
        return Err("The available update changed. Check for updates again.".into());
    }
    if !has_download {
        return Err("Download this update before installing it.".into());
    }
    Ok(())
}
pub fn download_size(
    received: u64,
    next: usize,
    total: Option<u64>,
    limit: u64,
) -> Result<u64, String> {
    let bytes = received
        .checked_add(next as u64)
        .ok_or("The update download is too large.")?;
    if bytes > limit
        || total
            .map(|value| value > limit || bytes > value)
            .unwrap_or(false)
    {
        return Err("The update download is too large or its size changed.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_dictation_text_requires_dismissal_even_after_copy() {
        for phase in ["ready", "error"] {
            assert!(dictation_result_pending(
                phase,
                Some("Text retained for Copy")
            ));
            assert!(!dictation_result_pending(phase, None));
            assert!(!dictation_result_pending(phase, Some("")));
        }
        for phase in ["idle", "inserted", "cancelled"] {
            assert!(!dictation_result_pending(phase, Some("already handled")));
        }
        // Copy leaves ready/text intact; only Dismiss clears this state. No
        // display-message interpretation can accidentally authorize data loss.
        assert!(idle(Activity {
            pending_dictation: true,
            ..Default::default()
        })
        .is_err());
    }
    #[test]
    fn starts_and_installation_exclude_each_other_and_failure_releases() {
        let gate = HandoffGate::default();
        let first = gate.start().unwrap();
        let second = gate.start().unwrap();
        assert!(gate.install().is_err());
        drop(first);
        assert!(gate.install().is_err());
        drop(second);
        let install = gate.install().unwrap();
        assert!(gate.start().is_err());
        assert!(gate.install().is_err());
        drop(install);
        assert!(gate.start().is_ok());
    }
    #[test]
    fn a_concurrent_start_cannot_cross_a_reserved_handoff() {
        let gate = HandoffGate::default();
        let reserved = gate.install().unwrap();
        let other = gate.clone();
        assert!(std::thread::spawn(move || other.start().is_err())
            .join()
            .unwrap());
        drop(reserved);
        assert!(gate.start().is_ok());
    }
    #[test]
    fn leases_are_send_for_async_recording_paths() {
        fn send<T: Send>() {}
        send::<StartLease>();
        send::<InstallLease>();
    }
    #[test]
    fn each_active_operation_blocks_and_idle_allows() {
        assert!(idle(Activity::default()).is_ok());
        for activity in [
            Activity {
                capture: true,
                ..Default::default()
            },
            Activity {
                dictation: true,
                ..Default::default()
            },
            Activity {
                local_jobs: true,
                ..Default::default()
            },
        ] {
            assert!(idle(activity).is_err());
        }
    }
    #[test]
    fn a_download_does_not_authorize_installing_another_version() {
        assert!(version_matches("0.8.3", Some("0.8.3"), true).is_ok());
        for (requested, actual, downloaded) in [
            ("0.8.3", Some("0.8.4"), true),
            ("0.8.3", None, true),
            ("0.8.3", Some("0.8.3"), false),
            ("", Some(""), true),
        ] {
            assert!(version_matches(requested, actual, downloaded).is_err());
        }
    }
    #[test]
    fn bounded_download_checks_declared_and_streamed_sizes() {
        assert_eq!(download_size(4, 6, Some(10), 10).unwrap(), 10);
        assert!(download_size(4, 7, None, 10).is_err());
        assert!(download_size(0, 1, Some(11), 10).is_err());
        assert!(download_size(4, 2, Some(5), 10).is_err());
        assert!(download_size(u64::MAX, 1, None, u64::MAX).is_err());
    }
    #[test]
    fn release_assets_are_bound_to_owner_repository_version_and_installer() {
        let valid = format!("{ASSET_PREFIX}v0.8.3/oats_0.8.3_x64-setup.exe");
        assert!(approved_asset(&valid, "0.8.3"));
        assert!(!approved_asset(&valid, "0.8.4"));
        for invalid in [
            valid.replace("https:", "http:"),
            valid.replace("github.com/", "github.com.evil/"),
            valid.replace("Ripplescale/", "someone/"),
            valid.replace("v0.8.3/", "../"),
            valid.replace("v0.8.3/", "%2e%2e/"),
            valid.replace(".exe", ".msi"),
            format!("{valid}?redirect=elsewhere"),
            format!("{valid}#fragment"),
            valid.replace("/releases/download/", "/raw/"),
        ] {
            assert!(!approved_asset(&invalid, "0.8.3"), "{invalid}");
        }
    }
    #[test]
    fn renamed_repository_and_legacy_redirect_keep_the_same_installer_boundary() {
        for prefix in [ASSET_PREFIX, LEGACY_ASSET_PREFIX] {
            let address = format!("{prefix}v0.8.6/oats_0.8.6_x64-setup.exe");
            assert!(approved_asset(&address, "0.8.6"));
            assert!(!approved_asset(&address, "0.8.5"));
            for invalid in [
                address.replace("github.com/", "github.com.evil/"),
                address.replace("Ripplescale/", "someone/"),
                address.replace("/releases/", "-other/releases/"),
                format!("{address}?redirect=elsewhere"),
            ] {
                assert!(!approved_asset(&invalid, "0.8.6"), "{invalid}");
            }
        }
    }
    #[test]
    fn authenticated_version_cannot_be_missing_relabelled_or_ambiguous() {
        assert!(
            signed_version_matches("timestamp:1\tfile:oats.exe\tversion:0.8.3", "0.8.3").is_ok()
        );
        for comment in [
            "timestamp:1\tfile:oats.exe",
            "version:0.8.2",
            "version:0.8.3\tversion:0.8.2",
            "version:0.8.3\tversion:0.8.3",
            "version:",
        ] {
            assert!(signed_version_matches(comment, "0.8.3").is_err());
        }
        assert!(signed_version_matches("version:", "").is_err());
    }
}
