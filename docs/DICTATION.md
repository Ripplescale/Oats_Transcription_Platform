# Dictation

oats uses the configured local Trelis runtime for Windows dictation. The current packaged worker uses word agreement across successive recognition results, with pauses and Stop finishing the pending tail. Earlier versions used finalized-phrase delivery. See the versioned release notes when checking an older installation.

## Use

Keep oats running, including in the tray, and focus the destination text field. Press **Ctrl+Alt+Shift+D** to start. Confirmed text is typed while recording continues, after recognition and agreement checks. Press the shortcut again, or use **Stop**, to finish the remaining speech.

The **Copilot key** also toggles dictation when it emits **Win+Shift+F23** and Windows permits registration. Settings → Dictation reports registration and whether the key signal has been observed. Physical key behavior varies by device; registration alone does not prove that the key emits the expected signal.

The floating indicator shows microphone activity, status, Stop and Cancel. Drag its grip to change position. Copy recovery and errors expand into a panel. Cancel stops further delivery and keeps words already typed. Capture uses the default Windows microphone and stops automatically after two minutes.

This is append-only streaming with a confirmation delay. Unstable words can remain pending until a later recognition result, a pause or Stop. Recognition preserves the model's mixed Hindi/English scripts; no latency or accuracy guarantee is implied.

## Delivery and focus

Text goes to the original foreground window and focused control only while the target and input checks continue to pass. Oats never restores focus. Pointer movement, hovering, scrolling and dragging the nonactivating indicator do not alone interrupt delivery. Clicking another field, keyboard edits/navigation, changing selection or switching apps stops automatic insertion and retains the remaining result for Copy.

A result stays available for Copy when the destination is elevated, modifiers remain held, the target no longer matches or input is rejected. Partial delivery is reported and never retried automatically. Oats never deletes, selects or replaces existing text. Windows accepting input events does not guarantee that a destination consumed them.

Starting from Settings produces a result to copy. Only an explicit Copy action changes the clipboard. Direct insertion normalizes line breaks and tabs to spaces; it sends no Enter/Tab submission actions. The last result remains in Settings, in memory, until another session or explicit dismissal. Browser fields can share a native focused control, so keep the intended field selected until completion.

## Capture and model lifecycle

One owner thread captures bounded microphone audio. The callback does not wait for inference. A serial decoder keeps only the newest pending cumulative audio prefix; Stop replaces pending previews with the complete captured recording. A slow decoder therefore avoids a growing queue of obsolete work while preserving all source audio.

The worker runs offline through the existing installed runtime adapters. It prepares the Trelis OpenVINO model and optional speech gate in the background while meeting work is idle. Preparation opens no microphone. If it has not completed, model loading can overlap the start of capture.

Successful requests reuse the prepared model. Ten minutes without a completed dictation releases it, checked periodically; starting meeting capture or local transcription/speaker work releases it first. Cancellation, failure, timeout and app exit kill and reap the child. A parent-process watchdog handles abnormal app exit. Cold loading remains possible after idle eviction, meeting work or an early shortcut.

Temporary request audio and results are removed after each response. An abrupt process termination can leave an operating-system temporary directory. Dictation creates no meeting or note.

## Confirmed word protocol

The native Trelis caller sets `stream.live: true` and `stream.stable: true`, and requires the worker's `local_agreement_v1` policy. Cumulative audio is submitted at a bounded preview cadence. The decoder works on a rolling window of at most 20 seconds, rather than repeatedly decoding an ever-growing session.

Two distinct audio prefixes must produce matching words before unfinished speech is eligible for delivery. Two trailing words remain provisional. A detected pause can flush the tail after 600 ms of quiet with 100 ms of padding; Stop processes the final tail. If pause detection is unavailable, word agreement continues and the last words wait for Stop.

When the rolling window advances, the worker requires one unique overlap with the committed text: an anchor of up to eight words, with at least three words available. Ambiguous overlap or revisions to committed words stop automatic delivery instead of guessing a replacement. The observed normalized audio prefix is validated before cache reuse. Earlier non-stable live requests retain their finalized-phrase protocol.

Responses contain cumulative confirmed text and a separate tentative draft. Native delivery appends only the new confirmed suffix after checking the target and input guard. Repeated responses do not type the text again. Already typed words are never selected, deleted or replaced by dictation.

If agreement breaks, finishing can produce a full-clip review result for Copy; it does not automatically reconcile that result with words already typed. Streaming and whole-clip recognition can differ. Synthetic delivery checks are separate from real-speech accuracy and destination-app acceptance. The separate [faster-whisper experiment](FASTER_WHISPER_DICTATION.md) is retired.

## Isolation and compatibility

- Global shortcuts use `RegisterHotKey` with repeat suppression. Win+C is unchanged.
- Session-only interaction monitoring observes interruption signals without logging typed content.
- The popup is nonactivating. Its commands validate the caller window and current session.
- Shared guards exclude overlapping meeting capture, dictation and local speech workers. Call prompts are suppressed while dictation is busy.
- Cancellation, capture failure and the processing deadline discard pending output before releasing the session reservation.
- Legacy non-live requests retain their completed-window behavior. Meeting recognition and saved-note workflows are separate.

## Validation

The automated suites cover capture/PCM handling, serial preview/final ownership, cancellation, process cleanup, stream identity, exact prefix caching, repeated responses, Unicode insertion packets, focus/input classification, shortcut debounce, popup layout and Settings behavior.

Relevant tests are in `frontend/tests/lib/dictation-settings.test.cjs`, `frontend/tests/ui/dictation-popup.test.cjs`, `stt_lab/tests/test_dictation_worker.py` and the native `dictation` modules. Synthetic tests use fixture adapters and in-memory sinks; they do not establish physical microphone, key or destination-app acceptance.

The optional `dictation-latency` component helper accepts explicit runtime, worker and mono PCM16 WAV paths. It reports numeric diagnostics and hashes rather than recognized speech. Use independently owned test audio and keep local reports outside version control.

Release qualification includes the frontend export and Windows native build. Physical Copilot behavior, real target-app typing, Stop/Cancel, focus changes, scaled multi-monitor placement and measured natural-speech latency still need device-specific acceptance. No private recording benchmark is distributed with these docs.

## References

- [WhisperLive single-model mode](https://github.com/collabora/WhisperLive#single-model-mode)
- [WhisperStreaming](https://github.com/ufal/whisper_streaming)
- [Trelis Hinglish checkpoint](https://huggingface.co/Trelis/whisper-hinglish-preview)
- [Windows hotkey registration](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)
- [Unicode input packets](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)
- [Windows input delivery](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
