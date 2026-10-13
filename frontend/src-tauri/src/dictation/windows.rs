//! Windows dictation shortcuts and guarded text delivery. This module never
//! records audio, changes focus, or reads text from another application.
//!
//! RegisterHotKey owns shortcuts. Session-only interaction hooks protect live
//! insertion; they retain interruption flags, never keystrokes or other text.

use serde::Serialize;
use std::{
    cell::RefCell,
    mem::size_of,
    ptr::null_mut,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, GlobalFree, SetLastError, FILETIME, HANDLE, HGLOBAL, HWND,
        LPARAM, LRESULT, POINT, RECT, WPARAM,
    },
    Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, SetWindowRgn, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
    System::{
        DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
        LibraryLoader::GetModuleHandleW,
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Threading::{
            GetCurrentProcessId, GetCurrentThreadId, GetProcessTimes, OpenProcess,
            OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
    UI::{
        Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, IsWindowEnabled, RegisterHotKey, SendInput, UnregisterHotKey, INPUT,
            INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOD_ALT,
            MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, VK_CONTROL, VK_F23, VK_LCONTROL,
            VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN,
            VK_SHIFT,
        },
        Shell::GetScaleFactorForMonitor,
        WindowsAndMessaging::{
            CallNextHookEx, CreateWindowExW, DestroyWindow, GetAncestor, GetForegroundWindow,
            GetGUIThreadInfo, GetMessageW, GetCursorPos,
            GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsWindow, IsWindowVisible, PeekMessageW,
            IsChild, PostThreadMessageW, SetWindowLongPtrW, SetWindowPos, SetWindowsHookExW,
            ShowWindow, UnhookWindowsHookEx, WindowFromPoint, GUITHREADINFO, HHOOK,
            KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, LLKHF_INJECTED, WH_KEYBOARD_LL, WH_MOUSE_LL,
            EVENT_OBJECT_FOCUS, EVENT_OBJECT_SELECTION, EVENT_OBJECT_TEXTSELECTIONCHANGED,
            EVENT_SYSTEM_FOREGROUND, GA_ROOT, WINEVENT_OUTOFCONTEXT,
            GUI_INMENUMODE, GUI_INMOVESIZE, GUI_POPUPMENUMODE, GUI_SYSTEMMENUMODE, GWL_EXSTYLE,
            HWND_MESSAGE, MSG, PM_NOREMOVE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WM_HOTKEY, WM_QUIT,
            WM_KEYDOWN, WM_SYSKEYDOWN, WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN,
            WM_XBUTTONDOWN,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        },
    },
};

const FALLBACK_ID: i32 = 0x5851;
const COPILOT_ID: i32 = 0x5852;
const DEBOUNCE: Duration = Duration::from_millis(250);
const MODIFIER_RELEASE_TIMEOUT: Duration = Duration::from_millis(1200);
const MAX_INSERT_UTF16: usize = 32_768;
const CF_UNICODETEXT: u32 = 13;
pub const INSERTION_CANCELLED: &str = "Dictation insertion was cancelled. Nothing was typed.";

#[derive(Clone, Debug, Serialize)]
pub struct ShortcutBindingStatus {
    pub accelerator: &'static str,
    pub registered: bool,
    /// Registration alone does not establish what a particular Copilot key emits.
    pub observed: bool,
    pub error_code: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ShortcutStatus {
    pub fallback: ShortcutBindingStatus,
    pub copilot: ShortcutBindingStatus,
}

impl Default for ShortcutStatus {
    fn default() -> Self {
        Self {
            fallback: ShortcutBindingStatus {
                accelerator: "Ctrl+Alt+Shift+D",
                registered: false,
                observed: false,
                error_code: None,
            },
            copilot: ShortcutBindingStatus {
                accelerator: "Win+Shift+F23",
                registered: false,
                observed: false,
                error_code: None,
            },
        }
    }
}

/// Keep this guard alive for as long as dictation is enabled. The callback runs
/// on the hotkey thread: snapshot the target synchronously, then queue work. It
/// must not block on audio, the UI thread, or destruction of this guard.
pub struct Hotkeys {
    thread: Option<JoinHandle<()>>,
    thread_id: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
    status: Arc<Mutex<ShortcutStatus>>,
}

impl Hotkeys {
    pub fn start(callback: impl Fn() + Send + Sync + 'static) -> Result<Self, String> {
        let thread_id = Arc::new(AtomicU32::new(0));
        let stopped = Arc::new(AtomicBool::new(false));
        let status = Arc::new(Mutex::new(ShortcutStatus::default()));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker_id = thread_id.clone();
        let worker_stopped = stopped.clone();
        let worker_status = status.clone();
        let worker = thread::Builder::new()
            .name("dictation-hotkeys".into())
            .spawn(move || unsafe {
                // Force creation of the message queue before publishing the ID.
                let mut message = MSG::default();
                PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
                worker_id.store(GetCurrentThreadId(), Ordering::Release);
                let mut registrations = RegisteredHotkeys(Vec::new());
                {
                    let mut current = worker_status.lock().unwrap_or_else(|p| p.into_inner());
                    register_binding(
                        &mut registrations,
                        &mut current.fallback,
                        FALLBACK_ID,
                        MOD_CONTROL | MOD_ALT | MOD_SHIFT,
                        u32::from(b'D'),
                    );
                    register_binding(
                        &mut registrations,
                        &mut current.copilot,
                        COPILOT_ID,
                        MOD_WIN | MOD_SHIFT,
                        u32::from(VK_F23),
                    );
                }
                let _ = ready_tx.send(());
                let mut last_trigger = None;
                while !worker_stopped.load(Ordering::Acquire) {
                    let result = GetMessageW(&mut message, null_mut(), 0, 0);
                    if result <= 0 || worker_stopped.load(Ordering::Acquire) {
                        break;
                    }
                    if message.message != WM_HOTKEY {
                        continue;
                    }
                    let recognized = {
                        let mut current = worker_status.lock().unwrap_or_else(|p| p.into_inner());
                        let binding = match message.wParam as i32 {
                            FALLBACK_ID => Some(&mut current.fallback),
                            COPILOT_ID => Some(&mut current.copilot),
                            _ => None,
                        };
                        match binding {
                            Some(binding) if binding.registered => {
                                binding.observed = true;
                                true
                            }
                            _ => false,
                        }
                    };
                    let now = Instant::now();
                    if recognized && accept_trigger(&mut last_trigger, now) {
                        // A consumer panic must still release both native bindings.
                        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(&callback))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
                drop(registrations);
                let mut current = worker_status.lock().unwrap_or_else(|p| p.into_inner());
                current.fallback.registered = false;
                current.copilot.registered = false;
            })
            .map_err(|error| format!("Could not start dictation shortcuts: {error}"))?;
        let mut guard = Self {
            thread: Some(worker),
            thread_id,
            stopped,
            status,
        };
        if ready_rx.recv_timeout(Duration::from_secs(5)).is_err() {
            guard.request_stop();
            // Do not block app startup if a system call has unexpectedly stalled.
            guard.thread.take();
            return Err("Dictation shortcut registration did not finish.".into());
        }
        Ok(guard)
    }

    pub fn status(&self) -> ShortcutStatus {
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn request_stop(&self) {
        self.stopped.store(true, Ordering::Release);
        let id = self.thread_id.load(Ordering::Acquire);
        if id != 0 {
            unsafe { PostThreadMessageW(id, WM_QUIT, 0, 0) };
        }
    }
}

impl Drop for Hotkeys {
    fn drop(&mut self) {
        self.request_stop();
        if let Some(worker) = self.thread.take() {
            // Avoid self-join if a consumer releases its owner inside the callback.
            if unsafe { GetCurrentThreadId() } != self.thread_id.load(Ordering::Acquire) {
                let _ = worker.join();
            }
        }
    }
}

struct RegisteredHotkeys(Vec<i32>);
impl Drop for RegisteredHotkeys {
    fn drop(&mut self) {
        for id in &self.0 {
            unsafe { UnregisterHotKey(null_mut(), *id) };
        }
    }
}

unsafe fn register_binding(
    registrations: &mut RegisteredHotkeys,
    status: &mut ShortcutBindingStatus,
    id: i32,
    modifiers: u32,
    key: u32,
) {
    if RegisterHotKey(null_mut(), id, modifiers | MOD_NOREPEAT, key) != 0 {
        registrations.0.push(id);
        status.registered = true;
    } else {
        status.error_code = Some(GetLastError());
    }
}

fn accept_trigger(last: &mut Option<Instant>, now: Instant) -> bool {
    if last.is_some_and(|previous| now.saturating_duration_since(previous) < DEBOUNCE) {
        return false;
    }
    *last = Some(now);
    true
}

/// Native window identity only: renderer HWNDs can contain several DOM fields.
/// No application title, text, or clipboard data is collected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub hwnd: usize,
    pub control: usize,
    pub process_id: u32,
    thread_id: u32,
    control_process_id: u32,
    control_thread_id: u32,
    process_created: u64,
    control_process_created: u64,
}

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn os_error(context: &str) -> String {
    format!("{context} (Windows error {}).", unsafe { GetLastError() })
}

unsafe fn process_identity(process_id: u32) -> Result<u64, String> {
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
    if process.is_null() {
        return Err(os_error("Could not verify the destination application"));
    }
    let process = OwnedHandle(process);
    let mut token = null_mut();
    if OpenProcessToken(process.0, TOKEN_QUERY, &mut token) == 0 {
        return Err(os_error("Could not verify destination permissions"));
    }
    let token = OwnedHandle(token);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0;
    if GetTokenInformation(
        token.0,
        TokenElevation,
        (&mut elevation as *mut TOKEN_ELEVATION).cast(),
        size_of::<TOKEN_ELEVATION>() as u32,
        &mut returned,
    ) == 0
    {
        return Err(os_error("Could not verify destination permissions"));
    }
    if elevation.TokenIsElevated != 0 {
        return Err(
            "Dictation cannot type into an elevated application. Your text is available to copy."
                .into(),
        );
    }
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
        return Err(os_error("Could not verify the destination application"));
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

/// Capture synchronously before creating or showing any dictation UI.
pub fn snapshot_target() -> Result<Target, String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() || IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 {
            return Err("No foreground text destination is available.".into());
        }
        let mut process_id = 0;
        let thread_id = GetWindowThreadProcessId(hwnd, &mut process_id);
        if thread_id == 0 || process_id == 0 {
            return Err("The destination application has closed.".into());
        }
        let mut info = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(thread_id, &mut info) == 0 {
            return Err(os_error("Could not determine the focused text destination"));
        }
        if info.flags & (GUI_INMENUMODE | GUI_INMOVESIZE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE)
            != 0
            || info.hwndFocus.is_null()
            || IsWindow(info.hwndFocus) == 0
            || IsWindowEnabled(info.hwndFocus) == 0
            || IsWindowVisible(info.hwndFocus) == 0
        {
            return Err("Focus a text field before starting dictation.".into());
        }
        let mut control_process_id = 0;
        let control_thread_id = GetWindowThreadProcessId(info.hwndFocus, &mut control_process_id);
        if control_thread_id == 0 || control_process_id == 0 {
            return Err("The focused text destination has closed.".into());
        }
        let process_created = process_identity(process_id)?;
        let control_process_created = if process_id == control_process_id {
            process_created
        } else {
            process_identity(control_process_id)?
        };
        if GetForegroundWindow() != hwnd {
            return Err(
                "The foreground application changed. Your text is available to copy.".into(),
            );
        }
        Ok(Target {
            hwnd: hwnd as usize,
            control: info.hwndFocus as usize,
            process_id,
            thread_id,
            control_process_id,
            control_thread_id,
            process_created,
            control_process_created,
        })
    }
}

fn verify_target(target: &Target) -> Result<(), String> {
    if snapshot_target()? != *target {
        return Err(
            "The destination or focused control changed. Your text is available to copy.".into(),
        );
    }
    Ok(())
}

const LIVE_INPUT_INTERRUPTED: u32 = 1;
const LIVE_FOCUS_INTERRUPTED: u32 = 2;
const LIVE_CARET_INTERRUPTED: u32 = 3;
const LIVE_DELIVERY_FAILED: u32 = 4;
const LIVE_MONITOR_STOPPED: u32 = 5;
static NEXT_INPUT_TAG: AtomicUsize = AtomicUsize::new(1);

struct InteractionState {
    target: Target,
    popup: Option<usize>,
    tag: usize,
    interrupted: AtomicU32,
    stopped: AtomicBool,
    alive: AtomicBool,
    clock: Instant,
    own_caret_until_ms: AtomicU64,
}

impl InteractionState {
    fn interrupt(&self, reason: u32) {
        let _ = self.interrupted.compare_exchange(0, reason, Ordering::AcqRel, Ordering::Acquire);
    }
    fn interruption(&self) -> Option<String> {
        let reason = self.interrupted.load(Ordering::Acquire);
        let message = match reason {
            LIVE_INPUT_INTERRUPTED => "Typing or cursor input interrupted live dictation. Automatic typing stopped; the full result will remain available to copy.",
            LIVE_FOCUS_INTERRUPTED => "The destination or focused field changed. Automatic typing stopped; the full result will remain available to copy.",
            LIVE_CARET_INTERRUPTED => "The destination cursor or selection changed. Automatic typing stopped; the full result will remain available to copy.",
            LIVE_DELIVERY_FAILED => "Automatic typing stopped after an input delivery error. Some text may already be present; review it before copying.",
            LIVE_MONITOR_STOPPED => "The live typing guard stopped. The full result will remain available to copy.",
            _ => return None,
        };
        Some(message.into())
    }
    fn elapsed_ms(&self) -> u64 { self.clock.elapsed().as_millis().min(u128::from(u64::MAX)) as u64 }
    fn own_caret_settling(&self) -> bool {
        let until = self.own_caret_until_ms.load(Ordering::Acquire);
        until != 0 && self.elapsed_ms() <= until
    }
    unsafe fn is_popup(&self, hwnd: HWND) -> bool {
        self.popup.is_some_and(|popup| {
            hwnd as usize == popup || IsChild(popup as HWND, hwnd) != 0
                || GetAncestor(hwnd, GA_ROOT) as usize == popup
        })
    }
    unsafe fn is_destination(&self, hwnd: HWND) -> bool {
        hwnd as usize == self.target.hwnd || hwnd as usize == self.target.control
            || IsChild(self.target.control as HWND, hwnd) != 0
    }
}

thread_local! {
    static INTERACTION_STATE: RefCell<Option<Arc<InteractionState>>> = const { RefCell::new(None) };
}

/// Session-owned, no-content interruption monitor. Install before capture and
/// retain through final delivery. All callbacks only set flags and always pass
/// input through; they never read another application's text or restore focus.
/// Native/custom controls differ in accessibility support. Physical input and
/// focus changes are monitored directly; programmatic caret notifications are
/// best-effort, with a short settling allowance for our own accepted input.
pub struct LiveGuard {
    state: Arc<InteractionState>,
    thread_id: Arc<AtomicU32>,
    owner: Option<JoinHandle<()>>,
}

impl LiveGuard {
    pub fn start(target: Target, popup_hwnd: Option<usize>) -> Result<Self, String> {
        verify_target(&target)?;
        let tag = ((unsafe { GetCurrentProcessId() } as usize) << 16)
            ^ 0x4f41_5453 ^ NEXT_INPUT_TAG.fetch_add(1, Ordering::Relaxed);
        let state = Arc::new(InteractionState {
            target, popup: popup_hwnd, tag: tag.max(1), interrupted: AtomicU32::new(0),
            stopped: AtomicBool::new(false), alive: AtomicBool::new(false),
            clock: Instant::now(), own_caret_until_ms: AtomicU64::new(0),
        });
        let thread_id = Arc::new(AtomicU32::new(0));
        let worker_id = thread_id.clone();
        let worker_state = state.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let owner = thread::Builder::new().name("dictation-input-guard".into()).spawn(move || unsafe {
            let mut message = MSG::default();
            PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
            worker_id.store(GetCurrentThreadId(), Ordering::Release);
            INTERACTION_STATE.with(|slot| *slot.borrow_mut() = Some(worker_state.clone()));
            let hooks = InteractionHooks::install();
            match hooks {
                Ok(hooks) => {
                    worker_state.alive.store(true, Ordering::Release);
                    let _ = ready_tx.send(Ok(()));
                    while !worker_state.stopped.load(Ordering::Acquire) {
                        if GetMessageW(&mut message, null_mut(), 0, 0) <= 0 { break; }
                    }
                    drop(hooks);
                }
                Err(error) => { let _ = ready_tx.send(Err(error)); }
            }
            worker_state.alive.store(false, Ordering::Release);
            worker_state.interrupt(LIVE_MONITOR_STOPPED);
            INTERACTION_STATE.with(|slot| slot.borrow_mut().take());
        }).map_err(|error| format!("Could not start the live typing guard: {error}"))?;
        let mut guard = Self { state, thread_id, owner: Some(owner) };
        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => {},
            Ok(Err(error)) => return Err(error),
            Err(_) => {
                guard.request_stop();
                // A stalled Windows registration must not block the audio owner.
                guard.owner.take();
                return Err("The live typing guard did not start. Dictation remains available to copy.".into());
            }
        }
        guard.check()?;
        Ok(guard)
    }

    /// Cheap enough for capture-owner UI updates; never reads keys or text.
    pub fn interruption(&self) -> Option<String> {
        if !self.state.alive.load(Ordering::Acquire) { self.state.interrupt(LIVE_MONITOR_STOPPED); }
        self.state.interruption()
    }

    pub fn check(&self) -> Result<(), String> {
        if let Some(error) = self.interruption() { return Err(error); }
        if let Err(error) = verify_target(&self.state.target) {
            self.state.interrupt(LIVE_FOCUS_INTERRUPTED);
            return Err(error);
        }
        if let Some(error) = self.interruption() { return Err(error); }
        Ok(())
    }

    /// The caller supplies only a newly committed suffix. A failed attempt
    /// permanently closes this guard, including partial SendInput acceptance.
    pub fn insert(&self, text: &str, cancelled: &AtomicBool) -> Result<(), String> {
        let result = insert_text_guarded(&self.state.target, text, cancelled, Some(self));
        if result.is_err() { self.state.interrupt(LIVE_DELIVERY_FAILED); }
        result
    }

    fn request_stop(&self) {
        self.state.stopped.store(true, Ordering::Release);
        let id = self.thread_id.load(Ordering::Acquire);
        if id != 0 { unsafe { PostThreadMessageW(id, WM_QUIT, 0, 0) }; }
    }
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.request_stop();
        if let Some(owner) = self.owner.take() {
            if unsafe { GetCurrentThreadId() } != self.thread_id.load(Ordering::Acquire) {
                let _ = owner.join();
            }
        }
    }
}

const INTERACTION_EVENTS: [u32; 4] = [
    EVENT_SYSTEM_FOREGROUND, EVENT_OBJECT_FOCUS,
    EVENT_OBJECT_SELECTION, EVENT_OBJECT_TEXTSELECTIONCHANGED,
];

struct InteractionHooks { keyboard: HHOOK, mouse: HHOOK, events: Vec<HWINEVENTHOOK> }
impl InteractionHooks {
    unsafe fn install() -> Result<Self, String> {
        let mut hooks = Self { keyboard: null_mut(), mouse: null_mut(), events: Vec::new() };
        let module = GetModuleHandleW(std::ptr::null());
        if module.is_null() { return Err(os_error("Could not identify the live typing guard")); }
        hooks.keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(interaction_keyboard), module, 0);
        if hooks.keyboard.is_null() { return Err(os_error("Could not monitor live typing interruptions")); }
        hooks.mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(interaction_mouse), module, 0);
        if hooks.mouse.is_null() { return Err(os_error("Could not monitor cursor interruptions")); }
        for event in INTERACTION_EVENTS {
            let hook = SetWinEventHook(event, event, null_mut(), Some(interaction_event), 0, 0, WINEVENT_OUTOFCONTEXT);
            if hook.is_null() { return Err(os_error("Could not monitor destination focus")); }
            hooks.events.push(hook);
        }
        Ok(hooks)
    }
}
impl Drop for InteractionHooks {
    fn drop(&mut self) {
        unsafe {
            for hook in &self.events { UnhookWinEvent(*hook); }
            if !self.mouse.is_null() { UnhookWindowsHookEx(self.mouse); }
            if !self.keyboard.is_null() { UnhookWindowsHookEx(self.keyboard); }
        }
    }
}

fn modifier_key(key: u32) -> bool {
    [VK_CONTROL, VK_LCONTROL, VK_RCONTROL, VK_MENU, VK_LMENU, VK_RMENU,
     VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_LWIN, VK_RWIN].iter().any(|value| u32::from(*value) == key)
}

fn allowed_dictation_key(key: u32, control: bool, alt: bool, shift: bool, win: bool) -> bool {
    (key == u32::from(b'D') && control && alt && shift && !win)
        || (key == u32::from(VK_F23) && win && shift && !control && !alt)
}

fn key_interrupts(key: u32, own: bool, injected: bool, modifiers: [bool; 4]) -> bool {
    if (own && injected) || modifier_key(key) { return false; }
    let [control, alt, shift, win] = modifiers;
    // OEM utilities can implement the Copilot key or fallback chord through
    // SendInput. RegisterHotKey still receives those exact chords, so they must
    // be able to stop recording without blocking delivery of the final words.
    !allowed_dictation_key(key, control, alt, shift, win)
}

unsafe extern "system" fn interaction_keyboard(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && data != 0 && [WM_KEYDOWN, WM_SYSKEYDOWN].contains(&(message as u32)) {
        let key = &*(data as *const KBDLLHOOKSTRUCT);
        INTERACTION_STATE.with(|slot| {
            if let Some(state) = slot.borrow().as_ref() {
                let down = |value| GetAsyncKeyState(i32::from(value)) < 0;
                let injected = key.flags & LLKHF_INJECTED != 0;
                if key_interrupts(key.vkCode, key.dwExtraInfo == state.tag && injected, injected,
                    [down(VK_CONTROL), down(VK_MENU), down(VK_SHIFT), down(VK_LWIN) || down(VK_RWIN)]) {
                    state.interrupt(LIVE_INPUT_INTERRUPTED);
                }
            }
        });
    }
    CallNextHookEx(null_mut(), code, message, data)
}

fn mouse_interrupts(message: u32, popup: bool) -> bool {
    // Pointer motion and scrolling do not move the text insertion point. A
    // click outside our nonactivating popup can, even inside the same HWND.
    !popup && [WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN, WM_XBUTTONDOWN].contains(&message)
}

fn event_interruption(
    event: u32, popup: bool, destination: bool, original_foreground: bool, own_caret_settling: bool,
) -> Option<u32> {
    if popup { return None; }
    match event {
        EVENT_SYSTEM_FOREGROUND if !original_foreground => Some(LIVE_FOCUS_INTERRUPTED),
        // Even equal native HWNDs can contain different browser fields.
        EVENT_OBJECT_FOCUS if destination => Some(LIVE_FOCUS_INTERRUPTED),
        EVENT_OBJECT_SELECTION | EVENT_OBJECT_TEXTSELECTIONCHANGED
            if destination && !own_caret_settling => Some(LIVE_CARET_INTERRUPTED),
        // EVENT_OBJECT_LOCATIONCHANGE describes screen geometry, not a logical
        // text selection. Scrolling, layout and moving windows can emit it.
        _ => None,
    }
}

unsafe extern "system" fn interaction_mouse(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && data != 0 && mouse_interrupts(message as u32, false) {
        let mouse = &*(data as *const MSLLHOOKSTRUCT);
        INTERACTION_STATE.with(|slot| {
            if let Some(state) = slot.borrow().as_ref() {
                if mouse_interrupts(message as u32, state.is_popup(WindowFromPoint(mouse.pt))) {
                    state.interrupt(LIVE_INPUT_INTERRUPTED);
                }
            }
        });
    }
    CallNextHookEx(null_mut(), code, message, data)
}

unsafe extern "system" fn interaction_event(
    _hook: HWINEVENTHOOK, event: u32, hwnd: HWND, _object: i32, _child: i32,
    _thread: u32, _time: u32,
) {
    INTERACTION_STATE.with(|slot| {
        if let Some(state) = slot.borrow().as_ref() {
            if let Some(reason) = event_interruption(
                event, state.is_popup(hwnd), state.is_destination(hwnd),
                hwnd as usize == state.target.hwnd, state.own_caret_settling(),
            ) {
                state.interrupt(reason);
            }
        }
    });
}

fn modifiers_held() -> bool {
    // Include generic and left/right variants so AltGr and either Windows key
    // cannot turn a completed transcription into an application shortcut.
    [
        VK_CONTROL,
        VK_LCONTROL,
        VK_RCONTROL,
        VK_MENU,
        VK_LMENU,
        VK_RMENU,
        VK_SHIFT,
        VK_LSHIFT,
        VK_RSHIFT,
        VK_LWIN,
        VK_RWIN,
    ]
    .iter()
    .any(|key| unsafe { GetAsyncKeyState(i32::from(*key)) } < 0)
}

fn unicode_inputs(text: &str) -> Result<Vec<INPUT>, String> {
    let mut normalized = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\r' | '\n' | '\t' => normalized.push(' '),
            value if value.is_control() => {
                return Err("Dictation contains a control character and was not typed. Use Copy to review the text.".into());
            }
            value => normalized.push(value),
        }
    }
    if normalized.trim().is_empty() {
        return Err("There is no dictation text to type.".into());
    }
    let units: Vec<u16> = normalized.encode_utf16().collect();
    if units.len() > MAX_INSERT_UTF16 {
        return Err(
            "This dictation is too long for automatic typing. Your text is available to copy."
                .into(),
        );
    }
    let mut inputs = Vec::with_capacity(units.len() * 2);
    for unit in units {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: unit,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }
    Ok(inputs)
}

fn insertion_result(sent: u32, expected: u32, error_code: u32) -> Result<(), String> {
    if sent == expected {
        Ok(())
    } else {
        Err(format!(
            "Windows accepted {sent} of {expected} dictation input events (error {error_code}). Some text may already be present. Nothing was retried; review the destination before copying."
        ))
    }
}

/// One bounded attempt. Never restores focus, changes the clipboard, or sends
/// Enter/Tab. A partial SendInput result is returned and MUST NOT be retried by
/// the caller. Success means Windows accepted events, not that the app saved text.
pub fn insert_text(target: &Target, text: &str) -> Result<(), String> {
    insert_text_cancellable(target, text, &AtomicBool::new(false))
}

/// Cancellation is checked during modifier release and immediately before the
/// single SendInput call. Cancellation after that call cannot undo delivered text.
pub fn insert_text_cancellable(
    target: &Target,
    text: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    insert_text_guarded(target, text, cancelled, None)
}

fn insert_text_guarded(
    target: &Target,
    text: &str,
    cancelled: &AtomicBool,
    live: Option<&LiveGuard>,
) -> Result<(), String> {
    check_cancelled(cancelled)?;
    if let Some(guard) = live { guard.check()?; }
    let mut inputs = unicode_inputs(text)?;
    if let Some(guard) = live {
        for input in &mut inputs { unsafe { input.Anonymous.ki.dwExtraInfo = guard.state.tag; } }
    }
    verify_target(target)?;
    let started = Instant::now();
    while modifiers_held() {
        check_cancelled(cancelled)?;
        if let Some(guard) = live { guard.check()?; }
        if started.elapsed() >= MODIFIER_RELEASE_TIMEOUT {
            return Err(
                "A shortcut modifier is still held. Your text is available to copy.".into(),
            );
        }
        if unsafe { GetForegroundWindow() } as usize != target.hwnd {
            return Err(
                "The foreground application changed. Your text is available to copy.".into(),
            );
        }
        thread::sleep(
            Duration::from_millis(15)
                .min(MODIFIER_RELEASE_TIMEOUT.saturating_sub(started.elapsed())),
        );
    }
    // Resolve process/window/control identity again after the bounded wait.
    verify_target(target)?;
    if let Some(guard) = live { guard.check()?; }
    if modifiers_held() {
        return Err("A shortcut modifier was pressed. Your text is available to copy.".into());
    }
    unsafe {
        // A final cheap foreground check narrows, but cannot eliminate, the OS
        // race between inspecting focus and delivering a global input stream.
        if !focus_matches(target) {
            return Err(
                "The foreground application changed. Your text is available to copy.".into(),
            );
        }
        check_cancelled(cancelled)?;
        if let Some(guard) = live {
            if let Some(error) = guard.interruption() { return Err(error); }
            // Accessibility caret changes arrive after queued Unicode input.
            // Physical key/mouse and focus interruptions remain active throughout.
            guard.state.own_caret_until_ms.store(
                guard.state.elapsed_ms().saturating_add(1000), Ordering::Release);
        }
        SetLastError(0);
        let sent = SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        );
        insertion_result(sent, inputs.len() as u32, GetLastError())?;
        if let Some(guard) = live {
            if let Some(error) = guard.interruption() { return Err(error); }
        }
        Ok(())
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err(INSERTION_CANCELLED.into())
    } else {
        Ok(())
    }
}

unsafe fn focus_matches(target: &Target) -> bool {
    if GetForegroundWindow() as usize != target.hwnd {
        return false;
    }
    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    GetGUIThreadInfo(target.thread_id, &mut info) != 0
        && info.hwndFocus as usize == target.control
        && info.flags & (GUI_INMENUMODE | GUI_INMOVESIZE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE)
            == 0
}

struct ClipboardMemory(HGLOBAL);
impl Drop for ClipboardMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { GlobalFree(self.0) };
        }
    }
}

struct ClipboardOwner(HWND);
impl Drop for ClipboardOwner {
    fn drop(&mut self) {
        unsafe { DestroyWindow(self.0) };
    }
}

struct ClipboardOpen;
impl Drop for ClipboardOpen {
    fn drop(&mut self) {
        unsafe { CloseClipboard() };
    }
}

/// Only call in response to an explicit Copy action. Unlike automatic typing,
/// this copies the full original text, including its line breaks.
pub fn copy_text(text: &str) -> Result<(), String> {
    if text.contains('\0') {
        return Err("Text containing a null character cannot be copied safely.".into());
    }
    let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = units
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or("Text is too large to copy.")?;
    unsafe {
        let mut memory = ClipboardMemory(GlobalAlloc(GMEM_MOVEABLE, bytes));
        if memory.0.is_null() {
            return Err(os_error("Could not allocate clipboard text"));
        }
        let buffer = GlobalLock(memory.0).cast::<u16>();
        if buffer.is_null() {
            return Err(os_error("Could not prepare clipboard text"));
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), buffer, units.len());
        SetLastError(0);
        if GlobalUnlock(memory.0) == 0 && GetLastError() != 0 {
            return Err(os_error("Could not finish preparing clipboard text"));
        }
        // OpenClipboard(NULL) cannot establish a clipboard owner for writing.
        // A message-only standard window supplies ownership without taking focus.
        let class: [u16; 7] = [83, 84, 65, 84, 73, 67, 0]; // STATIC
        let owner = ClipboardOwner(CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            null_mut(),
            null_mut(),
            std::ptr::null(),
        ));
        if owner.0.is_null() {
            return Err(os_error("Could not create clipboard owner"));
        }
        if OpenClipboard(owner.0) == 0 {
            return Err(os_error("The clipboard is busy; try Copy again"));
        }
        let _opened = ClipboardOpen;
        if EmptyClipboard() == 0 {
            return Err(os_error("Could not replace clipboard contents"));
        }
        if SetClipboardData(CF_UNICODETEXT, memory.0).is_null() {
            return Err(os_error("Could not copy dictation text"));
        }
        memory.0 = null_mut(); // Ownership transferred to Windows.
    }
    Ok(())
}

/// Configure a newly created, hidden overlay on its owning UI thread. Never pass
/// the main window here. Use show_nonactivating rather than Tauri set_focus/show.
pub fn make_nonactivating(hwnd: usize) -> Result<(), String> {
    unsafe {
        let hwnd = hwnd as HWND;
        let mut process_id = 0;
        let owner_thread = GetWindowThreadProcessId(hwnd, &mut process_id);
        if hwnd.is_null()
            || IsWindow(hwnd) == 0
            || process_id != GetCurrentProcessId()
            || owner_thread != GetCurrentThreadId()
        {
            return Err("Dictation overlay must be configured on its owning UI thread.".into());
        }
        SetLastError(0);
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if style == 0 && GetLastError() != 0 {
            return Err(os_error("Could not read dictation overlay style"));
        }
        SetLastError(0);
        if SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            style | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize,
        ) == 0
            && GetLastError() != 0
        {
            return Err(os_error("Could not protect dictation overlay focus"));
        }
        if SetWindowPos(
            hwnd,
            null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
        ) == 0
        {
            return Err(os_error("Could not apply dictation overlay style"));
        }
    }
    Ok(())
}

/// Show without activating; call on the overlay's owning UI thread.
pub fn show_nonactivating(hwnd: usize) -> Result<(), String> {
    make_nonactivating(hwnd)?;
    unsafe { ShowWindow(hwnd as HWND, SW_SHOWNOACTIVATE) };
    Ok(())
}

/// Pair native showing with native hiding: Tao still remembers the overlay's
/// original visible(false), so its hide() can otherwise be a no-op.
pub fn hide_overlay(hwnd: usize) -> Result<(), String> {
    make_nonactivating(hwnd)?;
    unsafe { ShowWindow(hwnd as HWND, SW_HIDE) };
    Ok(())
}

/// Physical desktop pointer coordinates avoid CSS coordinate discontinuities
/// when the user deliberately drags the grip across mixed-DPI monitors.
pub fn overlay_cursor() -> Result<(i32, i32), String> {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) } == 0 { return Err(os_error("Could not locate the popup pointer")); }
    Ok((point.x, point.y))
}

pub fn overlay_display(target: Option<&Target>, anchor: Option<(i32, i32)>) -> Result<((i32, i32, i32, i32), f64), String> {
    unsafe {
        let monitor = if let Some((x, y)) = anchor { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) }
        else {
            let hwnd = target.map(|value| value.hwnd as HWND).filter(|value| IsWindow(*value) != 0).unwrap_or_else(|| GetForegroundWindow());
            MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        };
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if monitor.is_null() || GetMonitorInfoW(monitor, &mut info) == 0 { return Err(os_error("Could not locate the popup display")); }
        let mut scale = 100;
        if GetScaleFactorForMonitor(monitor, &mut scale) < 0 { return Err("Could not determine popup display scale.".into()); }
        Ok(((info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom), f64::from(scale) / 100.0))
    }
}

/// Only our popup's UI thread may call this. Neither movement nor resizing
/// activates it; the destination application retains its keyboard focus.
pub fn place_overlay(hwnd: usize, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    if width <= 0 || height <= 0 || width > 4096 || height > 4096 { return Err("Invalid popup dimensions.".into()); }
    make_nonactivating(hwnd)?;
    let mut previous = RECT::default();
    if unsafe { GetWindowRect(hwnd as HWND, &mut previous) } == 0 {
        return Err(os_error("Could not inspect the dictation popup size"));
    }
    if unsafe { SetWindowPos(hwnd as HWND, null_mut(), x, y, width, height, SWP_NOACTIVATE | SWP_NOZORDER) } == 0 {
        return Err(os_error("Could not move the dictation popup"));
    }
    if previous.right - previous.left != width || previous.bottom - previous.top != height {
        round_overlay(hwnd, width, height)?;
    }
    Ok(())
}

/// Clip the native window itself: CSS rounding alone leaves an opaque rectangle
/// behind the WebView. The system owns a successfully installed region. Movement
/// retains the region; size/DPI changes replace it without activating the popup.
pub fn round_overlay(hwnd: usize, width: i32, height: i32) -> Result<(), String> {
    if width <= 0 || height <= 0 || width > 4096 || height > 4096 {
        return Err("Invalid popup surface dimensions.".into());
    }
    let diameter = ((32.0 * f64::from(width) / 264.0).round() as i32)
        .clamp(2, width.min(height).max(2));
    unsafe {
        let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
        if region.is_null() { return Err(os_error("Could not shape the dictation popup")); }
        if SetWindowRgn(hwnd as HWND, region, 1) == 0 {
            let error = os_error("Could not apply the dictation popup shape");
            DeleteObject(region);
            return Err(error);
        }
        // Do not DeleteObject here: SetWindowRgn transfers ownership to Windows.
    }
    Ok(())
}

fn position_in_work_area(
    work: RECT,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(i32, i32), String> {
    if !width.is_finite()
        || !height.is_finite()
        || !scale.is_finite()
        || width <= 0.0
        || height <= 0.0
        || scale <= 0.0
        || width > 16_384.0
        || height > 16_384.0
        || scale > 16.0
    {
        return Err("Invalid dictation overlay size or display scale.".into());
    }
    let work_width = i64::from(work.right) - i64::from(work.left);
    let work_height = i64::from(work.bottom) - i64::from(work.top);
    if work_width <= 0 || work_height <= 0 {
        return Err("The destination display has no usable work area.".into());
    }
    let physical_width = (width * scale).round() as i64;
    let physical_height = (height * scale).round() as i64;
    let margin = (24.0 * scale).round() as i64;
    let x = i64::from(work.left) + ((work_width - physical_width) / 2).max(0);
    let y = i64::from(work.top) + (work_height - physical_height - margin).max(0);
    Ok((x as i32, y as i32))
}

/// Logical overlay size in, physical screen position out. Resolve the monitor
/// each time; negative coordinates and monitors above/left of primary are valid.
pub fn overlay_position(
    target: Option<&Target>,
    width: f64,
    height: f64,
) -> Result<(i32, i32), String> {
    unsafe {
        let hwnd = target
            .map(|value| value.hwnd as HWND)
            .filter(|value| IsWindow(*value) != 0)
            .unwrap_or_else(|| GetForegroundWindow());
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if monitor.is_null() || GetMonitorInfoW(monitor, &mut info) == 0 {
            return Err(os_error("Could not locate the destination display"));
        }
        // Query the monitor rather than a foreign window whose DPI-unaware
        // process could make GetDpiForWindow report 96 on a scaled monitor.
        let mut scale = 100;
        let result = GetScaleFactorForMonitor(monitor, &mut scale);
        if result < 0 {
            return Err(format!(
                "Could not determine display scale (HRESULT {result})."
            ));
        }
        position_in_work_area(info.rcWork, width, height, f64::from(scale) / 100.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_popup_rounding_removes_rectangular_corners_and_tracks_resize() {
        use windows_sys::{w, Win32::{Graphics::Gdi::{CreateRectRgn, GetWindowRgn, GetRgnBox, PtInRegion}, UI::WindowsAndMessaging::WS_POPUP}};
        struct Owned(HWND);
        impl Drop for Owned { fn drop(&mut self) { unsafe { DestroyWindow(self.0); } } }
        unsafe {
            let foreground = GetForegroundWindow();
            let popup = Owned(CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, w!("STATIC"), w!(""), WS_POPUP,
                0, 0, 264, 48, null_mut(), null_mut(), GetModuleHandleW(null_mut()), null_mut()));
            assert!(!popup.0.is_null());
            round_overlay(popup.0 as usize, 264, 48).unwrap();
            for (width, height) in [(264, 48), (264, 220), (396, 72), (396, 330), (264, 48)] {
                place_overlay(popup.0 as usize, 24, 24, width, height).unwrap();
                let region = CreateRectRgn(0, 0, 0, 0);
                assert!(!region.is_null());
                assert_ne!(GetWindowRgn(popup.0, region), 0);
                let mut bounds = RECT::default();
                assert_ne!(GetRgnBox(region, &mut bounds), 0);
                assert_eq!((bounds.left, bounds.top, bounds.right, bounds.bottom), (0, 0, width, height));
                assert_eq!(PtInRegion(region, 0, 0), 0);
                assert_eq!(PtInRegion(region, width - 1, height - 1), 0);
                assert_ne!(PtInRegion(region, width / 2, height / 2), 0);
                DeleteObject(region);
                assert_eq!(GetForegroundWindow(), foreground);
                assert_eq!(IsWindowVisible(popup.0), 0);
                let style = GetWindowLongPtrW(popup.0, GWL_EXSTYLE) as u32;
                assert_ne!(style & WS_EX_NOACTIVATE, 0);
            }
        }
    }

    #[test]
    #[ignore = "Explicit disposable native-window probe; no real keyboard input or focus changes"]
    fn popup_movement_preserves_foreground_and_owned_edit_delivery() {
        use windows_sys::{w, Win32::UI::WindowsAndMessaging::{GetWindowTextW, SendMessageW, WM_CHAR}};
        struct Owned(HWND);
        impl Drop for Owned { fn drop(&mut self) { unsafe { DestroyWindow(self.0); } } }
        unsafe {
            let foreground = GetForegroundWindow();
            let foreground_thread = GetWindowThreadProcessId(foreground, null_mut());
            let mut before = GUITHREADINFO { cbSize: size_of::<GUITHREADINFO>() as u32, ..Default::default() };
            let has_foreground = !foreground.is_null();
            if has_foreground { assert_ne!(GetGUIThreadInfo(foreground_thread, &mut before), 0, "Foreground focus inspection failed: {}", GetLastError()); }
            eprintln!("popup_probe_foreground_available={has_foreground}");
            let edit = Owned(CreateWindowExW(0, w!("EDIT"), w!(""), 0, 0, 0, 200, 40,
                null_mut(), null_mut(), GetModuleHandleW(null_mut()), null_mut()));
            assert!(!edit.0.is_null());
            let popup = Owned(CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, w!("STATIC"), w!(""), 0, 0, 0, 264, 48,
                null_mut(), null_mut(), GetModuleHandleW(null_mut()), null_mut()));
            assert!(!popup.0.is_null());
            let ((left, top, right, bottom), _) = overlay_display(None, None).unwrap();
            let x = (right - 300).max(left); let y = (bottom - 250).max(top);
            place_overlay(popup.0 as usize, x, y, 264, 48).unwrap();
            show_nonactivating(popup.0 as usize).unwrap();
            for (offset, height) in [(0, 48), (8, 220), (16, 48)] {
                place_overlay(popup.0 as usize, x - offset, y, 264, height).unwrap();
                assert_eq!(GetForegroundWindow(), foreground);
                if has_foreground {
                    let mut after = GUITHREADINFO { cbSize: size_of::<GUITHREADINFO>() as u32, ..Default::default() };
                    assert_ne!(GetGUIThreadInfo(foreground_thread, &mut after), 0);
                    assert_eq!(after.hwndFocus, before.hwndFocus);
                }
                // Direct messages only to this disposable EDIT. Never SendInput,
                // activate it, or deliver a character to an external app.
                SendMessageW(edit.0, WM_CHAR, usize::from(b'a'), 0);
            }
            hide_overlay(popup.0 as usize).unwrap();
            let mut text = [0_u16; 8];
            assert_eq!(GetWindowTextW(edit.0, text.as_mut_ptr(), text.len() as i32), 3);
            assert_eq!(&text[..3], &[97, 97, 97]);
            assert_eq!(GetForegroundWindow(), foreground);
        }
    }

    fn encoded(inputs: &[INPUT]) -> Vec<(u16, u16, u32)> {
        inputs
            .iter()
            .map(|input| {
                assert_eq!(input.r#type, INPUT_KEYBOARD);
                let key = unsafe { input.Anonymous.ki };
                (key.wVk, key.wScan, key.dwFlags)
            })
            .collect()
    }

    #[test]
    fn unicode_preserves_hindi_and_surrogate_pairs_without_virtual_keys() {
        let events = encoded(&unicode_inputs("A हिन्दी 🥣").unwrap());
        let expected: Vec<u16> = "A हिन्दी 🥣".encode_utf16().collect();
        assert_eq!(events.len(), expected.len() * 2);
        for (unit, pair) in expected.iter().zip(events.chunks_exact(2)) {
            assert_eq!(pair[0], (0, *unit, KEYEVENTF_UNICODE));
            assert_eq!(pair[1], (0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
    }

    #[test]
    fn newlines_and_tabs_cannot_submit_or_move_focus() {
        let events = encoded(&unicode_inputs("hello\r\nworld\t!").unwrap());
        let units: Vec<u16> = events.iter().step_by(2).map(|event| event.1).collect();
        assert_eq!(String::from_utf16(&units).unwrap(), "hello  world !");
        assert!(events.iter().all(|event| event.0 == 0 && event.1 >= 32));
    }

    #[test]
    fn other_controls_empty_and_oversized_input_are_rejected_before_delivery() {
        for input in [
            "hello\0",
            "hello\u{1b}",
            "hello\u{7f}",
            "hello\u{85}",
            " \r\n\t",
        ] {
            assert!(unicode_inputs(input).is_err());
        }
        assert!(unicode_inputs(&"x".repeat(MAX_INSERT_UTF16 + 1)).is_err());
        assert!(unicode_inputs(&"🥣".repeat(MAX_INSERT_UTF16 / 2 + 1)).is_err());
    }

    #[test]
    fn partial_delivery_never_claims_success() {
        assert!(insertion_result(8, 8, 0).is_ok());
        let failure = insertion_result(3, 8, 5).unwrap_err();
        assert!(failure.contains("3 of 8"));
        assert!(failure.contains("Nothing was retried"));
        assert!(insertion_result(0, 8, 0).is_err());
    }

    #[test]
    fn hotkey_bursts_trigger_once_without_extending_debounce() {
        let now = Instant::now();
        let mut last = None;
        assert!(accept_trigger(&mut last, now));
        assert!(!accept_trigger(&mut last, now + Duration::from_millis(10)));
        assert!(!accept_trigger(&mut last, now + Duration::from_millis(249)));
        assert!(accept_trigger(&mut last, now + Duration::from_millis(250)));
    }

    #[test]
    fn target_identity_includes_control_and_process_generation() {
        let target = Target {
            hwnd: 1,
            control: 2,
            process_id: 3,
            thread_id: 4,
            control_process_id: 3,
            control_thread_id: 4,
            process_created: 100,
            control_process_created: 100,
        };
        let mut changed = target.clone();
        changed.control = 5;
        assert_ne!(changed, target);
        changed = target.clone();
        changed.process_created = 101;
        assert_ne!(changed, target);
    }

    #[test]
    fn target_and_hotkey_guard_are_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Target>();
        assert_send_sync::<Hotkeys>();
        assert_send_sync::<LiveGuard>();
    }

    #[test]
    fn live_keyboard_classifier_allows_own_input_and_only_expected_shortcuts() {
        let none = [false; 4];
        assert!(!key_interrupts(u32::from(b'A'), true, true, none));
        assert!(key_interrupts(u32::from(b'A'), false, false, none));
        assert!(key_interrupts(0x25, false, false, none)); // Left caret key.
        assert!(key_interrupts(0x08, false, false, none)); // Backspace.
        assert!(key_interrupts(u32::from(b'A'), false, false, [true, false, false, false]));
        assert!(!key_interrupts(u32::from(VK_LCONTROL), false, false, none));
        assert!(!key_interrupts(u32::from(b'D'), false, false, [true, true, true, false]));
        assert!(!key_interrupts(u32::from(VK_F23), false, false, [false, false, true, true]));
        assert!(key_interrupts(u32::from(b'D'), false, false, [true, false, true, false]));
        assert!(key_interrupts(u32::from(VK_F23), false, false, [true, false, true, true]));
    }

    #[test]
    fn injected_stop_chords_allow_final_delivery_but_other_injected_input_interrupts() {
        for injected in [false, true] {
            assert!(!key_interrupts(u32::from(b'D'), false, injected, [true, true, true, false]));
            assert!(!key_interrupts(u32::from(VK_F23), false, injected, [false, false, true, true]));
        }
        for (key, modifiers) in [
            (u32::from(b'D'), [false; 4]),
            (u32::from(b'D'), [true, false, true, false]),
            (u32::from(b'D'), [true, true, true, true]),
            (u32::from(VK_F23), [false, false, false, true]),
            (u32::from(VK_F23), [true, false, true, true]),
            (u32::from(b'A'), [true, false, false, false]),
            (0x25, [false; 4]), // Caret movement.
            (0x08, [false; 4]), // Backspace.
            (0xe7, [false; 4]), // Foreign Unicode SendInput (VK_PACKET).
        ] {
            assert!(key_interrupts(key, false, true, modifiers), "foreign key {key}");
        }
    }

    #[test]
    fn pointer_motion_scrolling_and_popup_drag_do_not_interrupt_typing() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_MOUSEHWHEEL,
            WM_LBUTTONUP, WM_RBUTTONUP, WM_MBUTTONUP, WM_XBUTTONUP,
        };
        // winuser.h values; the optional Controls bindings are not needed by
        // production code or low-level mouse hooks.
        const WM_MOUSEHOVER: u32 = 0x02a1;
        const WM_MOUSELEAVE: u32 = 0x02a3;
        for message in [WM_MOUSEMOVE, WM_MOUSEHOVER, WM_MOUSELEAVE, WM_MOUSEWHEEL,
            WM_MOUSEHWHEEL, WM_LBUTTONUP, WM_RBUTTONUP, WM_MBUTTONUP, WM_XBUTTONUP] {
            assert!(!mouse_interrupts(message, false), "outside pointer event {message}");
            assert!(!mouse_interrupts(message, true), "popup pointer event {message}");
        }
        // A captured popup drag can move outside the popup before pointerup.
        for (message, popup) in [(WM_LBUTTONDOWN, true), (WM_MOUSEMOVE, true),
            (WM_MOUSEMOVE, false), (WM_LBUTTONUP, false)] {
            assert!(!mouse_interrupts(message, popup));
        }
        for message in [WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN, WM_XBUTTONDOWN] {
            assert!(mouse_interrupts(message, false));
            assert!(!mouse_interrupts(message, true));
        }
    }

    #[test]
    fn caret_geometry_does_not_interrupt_but_actual_selection_does() {
        use windows_sys::Win32::UI::WindowsAndMessaging::EVENT_OBJECT_LOCATIONCHANGE;
        assert!(!INTERACTION_EVENTS.contains(&EVENT_OBJECT_LOCATIONCHANGE));
        assert!(INTERACTION_EVENTS.contains(&EVENT_OBJECT_TEXTSELECTIONCHANGED));
        for settling in [false, true] {
            assert_eq!(event_interruption(EVENT_OBJECT_LOCATIONCHANGE, false, true, true, settling), None);
        }
        for event in [EVENT_OBJECT_SELECTION, EVENT_OBJECT_TEXTSELECTIONCHANGED] {
            assert_eq!(event_interruption(event, false, true, true, false), Some(LIVE_CARET_INTERRUPTED));
            assert_eq!(event_interruption(event, false, true, true, true), None);
            assert_eq!(event_interruption(event, false, false, false, false), None);
            assert_eq!(event_interruption(event, true, false, false, false), None);
        }
    }

    #[test]
    fn focus_guards_survive_pointer_relaxation_and_popup_events_are_exempt() {
        assert_eq!(event_interruption(EVENT_SYSTEM_FOREGROUND, false, false, false, false), Some(LIVE_FOCUS_INTERRUPTED));
        assert_eq!(event_interruption(EVENT_SYSTEM_FOREGROUND, false, true, true, false), None);
        // A browser field change can report a new focus object in the same HWND.
        for settling in [false, true] {
            assert_eq!(event_interruption(EVENT_OBJECT_FOCUS, false, true, true, settling), Some(LIVE_FOCUS_INTERRUPTED));
        }
        for event in INTERACTION_EVENTS {
            assert_eq!(event_interruption(event, true, false, false, false), None);
        }
        assert_eq!(event_interruption(EVENT_OBJECT_FOCUS, false, false, false, false), None);
    }

    #[test]
    fn interaction_interruption_is_permanent_and_keeps_the_first_reason() {
        let state = InteractionState {
            target: Target { hwnd: 0, control: 0, process_id: 0, thread_id: 0,
                control_process_id: 0, control_thread_id: 0, process_created: 0, control_process_created: 0 },
            popup: None, tag: 17, interrupted: AtomicU32::new(0), stopped: AtomicBool::new(false),
            alive: AtomicBool::new(true), clock: Instant::now(), own_caret_until_ms: AtomicU64::new(0),
        };
        assert!(state.interruption().is_none());
        assert!(!state.own_caret_settling());
        state.interrupt(LIVE_FOCUS_INTERRUPTED);
        state.interrupt(LIVE_INPUT_INTERRUPTED);
        assert_eq!(state.interrupted.load(Ordering::Acquire), LIVE_FOCUS_INTERRUPTED);
        // Returning to the original focus or entering our insertion allowance
        // never clears an interruption from earlier in the session.
        state.own_caret_until_ms.store(1000, Ordering::Release);
        assert!(state.own_caret_settling());
        assert!(state.interruption().unwrap().contains("focused field changed"));
    }

    #[test]
    fn cancellation_blocks_before_any_windows_or_input_access() {
        let invalid_target = Target {
            hwnd: 0,
            control: 0,
            process_id: 0,
            thread_id: 0,
            control_process_id: 0,
            control_thread_id: 0,
            process_created: 0,
            control_process_created: 0,
        };
        let result = insert_text_cancellable(&invalid_target, "hello", &AtomicBool::new(true));
        assert_eq!(
            result.unwrap_err(),
            "Dictation insertion was cancelled. Nothing was typed."
        );
    }

    #[test]
    fn overlay_uses_scaled_work_area_and_negative_monitor_coordinates() {
        let work = RECT {
            left: -1920,
            top: -200,
            right: 0,
            bottom: 840,
        };
        assert_eq!(
            position_in_work_area(work, 400.0, 200.0, 1.5).unwrap(),
            (-1260, 504)
        );
        let tiny = RECT {
            left: 100,
            top: 50,
            right: 300,
            bottom: 150,
        };
        assert_eq!(
            position_in_work_area(tiny, 400.0, 200.0, 1.5).unwrap(),
            (100, 50)
        );
        assert!(position_in_work_area(work, f64::NAN, 200.0, 1.0).is_err());
        assert!(position_in_work_area(work, 400.0, 200.0, 0.0).is_err());
    }
}
