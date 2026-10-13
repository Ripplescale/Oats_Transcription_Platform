//! One cancellable child owned by the dictation session. No shell or nested CLI.
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        // kill is harmless if try_wait already reaped a completed child. Always
        // wait: neither cancellation, timeout nor an I/O error leaves it behind.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(super) fn run(mut command: Command, cancelled: &AtomicBool, timeout: Duration) -> Result<Option<ExitStatus>, String> {
    if cancelled.load(Ordering::Acquire) { return Ok(None); }
    let mut child = ChildGuard(command.spawn().map_err(|error| format!("The local dictation worker could not start: {error}"))?);
    let began = Instant::now();
    loop {
        if cancelled.load(Ordering::Acquire) { return Ok(None); }
        if began.elapsed() >= timeout { return Err("Dictation took too long. Try a shorter phrase.".into()); }
        if let Some(status) = child.0.try_wait().map_err(|error| error.to_string())? {
            return if cancelled.load(Ordering::Acquire) { Ok(None) } else { Ok(Some(status)) };
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, process::Stdio, sync::Arc, time::SystemTime};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("oats-dictation-process-test-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn marker(&self) -> PathBuf { self.0.join("child.pid") }
        fn command(&self, mode: &str) -> Command {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args(["tests::synthetic_child", "--test-threads=1"])
                .env("OATS_DICTATION_TEST_CHILD_MODE", mode).env("OATS_DICTATION_TEST_MARKER", self.marker())
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
            command
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(self.marker());
            // Nonrecursive cleanup only; the fixture owns this one known file.
            fs::remove_dir(&self.0).unwrap();
        }
    }

    #[test]
    fn synthetic_child() {
        let Ok(mode) = std::env::var("OATS_DICTATION_TEST_CHILD_MODE") else { return; };
        fs::write(std::env::var_os("OATS_DICTATION_TEST_MARKER").unwrap(), std::process::id().to_string()).unwrap();
        match mode.as_str() {
            "success" => (),
            "failure" => std::process::exit(7),
            "wait" => {
                let began = Instant::now();
                loop {
                    // A failed test must not leave a fixture process indefinitely.
                    if began.elapsed() > Duration::from_secs(30) { std::process::exit(91); }
                    thread::sleep(Duration::from_millis(25));
                }
            },
            _ => panic!("unknown synthetic mode"),
        }
    }

    #[test]
    fn reports_success_and_failure_status() {
        let fixture = Fixture::new();
        let cancelled = AtomicBool::new(false);
        assert!(run(fixture.command("success"), &cancelled, Duration::from_secs(10)).unwrap().unwrap().success());
        assert_eq!(run(fixture.command("failure"), &cancelled, Duration::from_secs(10)).unwrap().unwrap().code(), Some(7));
    }

    #[test]
    fn cancellation_before_spawn_never_launches_the_command() {
        let fixture = Fixture::new();
        assert!(run(fixture.command("wait"), &AtomicBool::new(true), Duration::from_secs(10)).unwrap().is_none());
        assert!(!fixture.marker().exists());
    }

    #[test]
    fn unavailable_executable_has_a_useful_error() {
        let fixture = Fixture::new();
        let command = Command::new(fixture.0.join("no-such-worker.exe"));
        assert!(run(command, &AtomicBool::new(false), Duration::from_secs(1)).unwrap_err().contains("could not start"));
    }

    #[cfg(windows)]
    mod windows {
        use super::*;
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
            fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
            fn CloseHandle(handle: isize) -> i32;
        }
        struct ProcessHandle(isize);
        impl Drop for ProcessHandle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }

        fn running_child(fixture: &Fixture) -> Result<ProcessHandle, String> {
            let began = Instant::now();
            loop {
                if let Some(pid) = fs::read_to_string(fixture.marker()).ok().and_then(|text| text.parse::<u32>().ok()) {
                    let handle = unsafe { OpenProcess(0x100000, 0, pid) };
                    if handle == 0 { return Err(format!("Could not observe child: {}", std::io::Error::last_os_error())); }
                    return Ok(ProcessHandle(handle));
                }
                if began.elapsed() >= Duration::from_secs(10) { return Err("child never started".into()); }
                thread::sleep(Duration::from_millis(10));
            }
        }

        #[test]
        fn cancellation_kills_and_reaps_the_started_child_before_returning() {
            let fixture = Fixture::new();
            let cancelled = Arc::new(AtomicBool::new(false));
            let owner_cancelled = cancelled.clone();
            let command = fixture.command("wait");
            let owner = thread::spawn(move || run(command, &owner_cancelled, Duration::from_secs(20)));
            let child = running_child(&fixture);
            cancelled.store(true, Ordering::Release);
            assert!(owner.join().unwrap().unwrap().is_none());
            let child = child.unwrap();
            assert_eq!(unsafe { WaitForSingleObject(child.0, 0) }, 0, "child survived cancellation");
        }

        #[test]
        fn timeout_kills_and_reaps_the_started_child_before_returning() {
            let fixture = Fixture::new();
            let command = fixture.command("wait");
            let owner = thread::spawn(move || run(command, &AtomicBool::new(false), Duration::from_secs(3)));
            let child = running_child(&fixture);
            assert!(owner.join().unwrap().unwrap_err().contains("took too long"));
            let child = child.unwrap();
            assert_eq!(unsafe { WaitForSingleObject(child.0, 0) }, 0, "child survived timeout");
        }
    }
}
