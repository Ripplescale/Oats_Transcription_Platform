//! Admission is based on actual process exit, never a worker's checkpoint.
//! Each kind has one slot; dictation, updates and retention require both idle.

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum WorkerKind {
    Transcription,
    Speaker,
}

#[derive(Default)]
pub(super) struct WorkerActivity {
    transcription: bool,
    speaker: bool,
}

impl WorkerActivity {
    pub(super) fn observe_exit(&mut self, kind: WorkerKind, exited: bool) {
        if !exited {
            match kind {
                WorkerKind::Transcription => self.transcription = true,
                WorkerKind::Speaker => self.speaker = true,
            }
        }
    }

    pub(super) fn admits(&self, kind: WorkerKind) -> bool {
        match kind {
            WorkerKind::Transcription => !self.transcription,
            WorkerKind::Speaker => !self.speaker,
        }
    }

    pub(super) fn any_live(&self) -> bool {
        self.transcription || self.speaker
    }
}

#[cfg(windows)]
pub(super) fn windows_creation_flags(kind: WorkerKind) -> u32 {
    use windows_sys::Win32::System::Threading::{BELOW_NORMAL_PRIORITY_CLASS, CREATE_NO_WINDOW};
    CREATE_NO_WINDOW | match kind {
        WorkerKind::Transcription => 0,
        WorkerKind::Speaker => BELOW_NORMAL_PRIORITY_CLASS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn either_kind_can_start_first_and_only_the_other_can_join() {
        for (first, second) in [
            (WorkerKind::Transcription, WorkerKind::Speaker),
            (WorkerKind::Speaker, WorkerKind::Transcription),
        ] {
            let mut active = WorkerActivity::default();
            assert!(active.admits(first));
            assert!(active.admits(second));
            assert!(!active.any_live());
            active.observe_exit(first, false);
            assert!(!active.admits(first));
            assert!(active.admits(second));
            active.observe_exit(second, false);
            assert!(!active.admits(first));
            assert!(!active.admits(second));
            assert!(active.any_live());
        }
    }

    #[test]
    fn exited_children_free_only_their_own_slot() {
        for (exited, running) in [
            (WorkerKind::Transcription, WorkerKind::Speaker),
            (WorkerKind::Speaker, WorkerKind::Transcription),
        ] {
            let mut active = WorkerActivity::default();
            active.observe_exit(exited, true);
            active.observe_exit(running, false);
            assert!(active.admits(exited));
            assert!(!active.admits(running));
            assert!(active.any_live());
        }
        let mut all_exited = WorkerActivity::default();
        all_exited.observe_exit(WorkerKind::Transcription, true);
        all_exited.observe_exit(WorkerKind::Speaker, true);
        assert!(!all_exited.any_live());
    }

    #[test]
    fn exclusive_work_waits_for_either_or_both_kinds() {
        for (transcription_exited, speaker_exited) in [
            (true, true), (false, true), (true, false), (false, false),
        ] {
            let mut active = WorkerActivity::default();
            active.observe_exit(WorkerKind::Transcription, transcription_exited);
            active.observe_exit(WorkerKind::Speaker, speaker_exited);
            assert_eq!(active.any_live(), !transcription_exited || !speaker_exited);
        }
    }

    #[test]
    fn exited_history_never_erases_a_live_slot() {
        for kind in [WorkerKind::Transcription, WorkerKind::Speaker] {
            for exits in [[false, true], [true, false]] {
                let mut active = WorkerActivity::default();
                for exited in exits { active.observe_exit(kind, exited); }
                assert!(!active.admits(kind));
                assert!(active.any_live());
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn speaker_priority_is_lower_and_both_kinds_stay_hidden() {
        assert_eq!(windows_creation_flags(WorkerKind::Transcription), 0x08000000);
        assert_eq!(windows_creation_flags(WorkerKind::Speaker), 0x08004000);
    }
}
