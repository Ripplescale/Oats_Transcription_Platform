# Recording stops after an audio-writer backlog

Investigation on 18 November 2026 found nonzero `dropped_samples` in five of
the six most recent recording journals from that morning. Their writers had
drained and written `capture_finalized`. The affected sessions lasted about
19 seconds to 12 minutes; the most recent session had zero drops.
This supports a transient queue backlog as a cause of the intermittent stops.
It does not establish why Windows or storage temporarily fell behind.

Previously, `CaptureSink` treated both a full queue and a disconnected writer
as a permanent capture error. A single dropped callback made the health
monitor stop the recording, even if the writer immediately caught up.
Finalization then also returned that latched error despite retaining the
accepted source audio.

The recorder now:

- Buffers up to 8,192 messages, with a separate 32 MiB limit on queued PCM.
- Keeps recording after temporary queue overflow and issues an audio-gap
  warning without disabling recording controls.
- Tracks dropped audio separately for each source. It commits a gap before
  the next accepted audio and retains trailing gaps when Finish is pressed.
  Short losses remain silence in aligned playback rather than being closed up.
- Still stops on an unavailable writer, invalid source metadata, a writer
  panic, or a file-write failure, preserving source files for recovery.
- Allows durable capture to survive repeated recoverable device errors;
  permission failures and other nonrecoverable errors still stop it.
- Warns when system-audio recovery fails while the microphone continues,
  instead of putting the whole recording into an error state.

Synthetic tests delay the writer deterministically, exceed the old queue
capacity, force overflow and a real file-write error, and verify saved PCM,
gap metadata, finalization, memory accounting and recording-state behavior.
Frontend tests verify that a gap warning leaves recording and Stop active.
These checks do not replace a live microphone/system-audio or Bluetooth test.
Audio already dropped by an older recording cannot be reconstructed.

Validation in this checkout: all 14 native recording, recording-state and
shutdown checks passed; all 12 focused frontend recording/recovery checks and
TypeScript checking passed. The broader native suite passed 163 checks, skipped
two explicit probes and hit one worker-cleanup deadline; that check passed on
an isolated rerun. Process-lifecycle tests were run outside the sandbox because
its process-inspection restrictions caused access-denied failures.
The full Windows MSVC app check also passed using
`frontend/src-tauri/scripts/build-local-windows.ps1 -Mode Check` with the local
runtime and build cache. Live microphone, system-audio and Bluetooth acceptance
remain unverified.
