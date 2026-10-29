//! A worker handle owns only the process tree launched for one immutable job.
use std::{io, process::{Child, Command, ExitStatus}};

pub(super) struct WorkerProcess {
    child: Child,
    pub(super) generation: uuid::Uuid,
    #[cfg(windows)]
    job: Option<ProcessJob>,
}
impl WorkerProcess {
    pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = match ProcessJob::assign(&child) {
            Ok(job) => Some(job),
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); }
        };
        Ok(Self { child, generation: uuid::Uuid::new_v4(), #[cfg(windows)] job })
    }
    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let result = self.child.try_wait()?;
        // A CLI descendant must not keep running after the owned Python exits.
        #[cfg(windows)]
        if result.is_some() { self.job.take(); }
        Ok(result)
    }
    pub(super) fn kill(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        if let Some(job) = &self.job { return job.terminate(); }
        self.child.kill()
    }
}

#[cfg(windows)]
struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);
// The kernel handle has no thread affinity; CHILDREN serializes its ownership.
#[cfg(windows)]
unsafe impl Send for ProcessJob {}
#[cfg(windows)]
impl ProcessJob {
    fn assign(child: &Child) -> io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return Err(io::Error::last_os_error()); }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&limits) as u32) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle().cast()) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }
    fn terminate(&self) -> io::Result<()> {
        if unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn scoped_termination_reaps_only_the_owned_process() {
        use std::{os::windows::process::CommandExt, time::{Duration, Instant}};
        fn sleeper() -> Command { let mut cmd=Command::new("powershell.exe"); cmd.args(["-NoProfile","-NonInteractive","-Command","Start-Sleep -Seconds 30"]); cmd.creation_flags(0x08000000); cmd }
        let mut first=WorkerProcess::spawn(&mut sleeper()).unwrap();
        let mut second=WorkerProcess::spawn(&mut sleeper()).unwrap();
        assert_ne!(first.generation,second.generation);
        first.kill().unwrap();
        let deadline=Instant::now()+Duration::from_secs(5);
        while first.try_wait().unwrap().is_none() { assert!(Instant::now()<deadline); std::thread::sleep(Duration::from_millis(10)); }
        assert!(second.try_wait().unwrap().is_none());
        second.kill().unwrap();
    }
}
