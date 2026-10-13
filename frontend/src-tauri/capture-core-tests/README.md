# Isolated source-component tests

This small crate compiles the production `audio/durable_capture.rs` directly.
It tests queue draining, independent source tracks, silence/gaps, audio-only
recovery, torn journal tails, corruption retention, and visible queue overflow.

The build script also parses `local_workspace.rs` and compiles its exact
non-command items and tests, omitting only Tauri commands and the two Tauri/app
state imports. Those tests check revision conflicts/history and evidence
requirements for quantities. A separate test parses the modified app source
files with `syn`; it checks syntax only.

Run with `cargo test --manifest-path frontend/src-tauri/capture-core-tests/Cargo.toml --locked`.
The target is intentionally a separate workspace so testing these components
does not initialize devices, download models, or build the app's native engine
dependencies. No microphone or system recording is started.

The suite also includes the production lossless source archive, generated
metadata retention and Windows worker-cache cleanup. It checks complete archive
readback, exact restoration, partial retries, unsafe paths and active-worker
exclusion. `cargo build --release --manifest-path
frontend/src-tauri/capture-core-tests/Cargo.toml --locked --bin storage-retention`
builds the maintenance helper documented in `docs/STORAGE_RETENTION.md`.

On the installed Windows GNU Rust toolchain, the available LLVM-Mingw compiler
uses UCRT, while Rust bundles its own GCC/MSVCRT startup and runtime libraries.
The successful isolated-test configuration uses the direct toolchain
`cargo.exe`, `rustc.exe` and `rustdoc.exe`, the LLVM-Mingw `gcc.exe` linker, and:

```text
RUSTFLAGS=-Clink-self-contained=yes -Lnative=<rust-toolchain>/lib/rustlib/x86_64-pc-windows-gnu/lib/self-contained
CARGO_BUILD_JOBS=1
```

This is **not** a full Tauri typecheck, Windows installer build, device test,
long-call timing test, or speaker integration test. The pinned app's ONNX
bundling script currently requires `x86_64-pc-windows-msvc`.

The dictation engine, pipeline and live delivery state machine are also
compiled directly. Synthetic child tests verify process ownership, exact
stream identity (including the explicit live flag), confirmed-phrase markers,
sample counts and temporary cleanup. Pipeline tests cover final audio replacing
queued previews, cancellation, deadlines and failure propagation. Delivery
tests use synthetic cumulative
confirmed text to check immediate suffix-only insertion, duplicate suppression,
final flushing and strict blocking after a committed-prefix revision or failed
input. Already inserted text is never edited or replayed; interruption retains
the full final result for Copy, and Cancel leaves words already typed in place.
Pure Windows guard tests use simulated target/input-state snapshots. They do
not call Windows foreground input APIs. These tests do not load speech models.

For an explicitly requested local model benchmark, build `--bin dictation-latency`
and pass absolute paths to `runtime.json`, `dictation_worker.py` and a mono PCM16
WAV while oats and other speech workers are closed. Append `--stream` to compare
whole-clip decoding with completed-window reuse; this mode requires a canonical
44-byte WAV header.

Alternatively append `--live` to pace cumulative prefixes in real time, starting
at 2.1 seconds and then every two seconds. This mode also requires a canonical
mono PCM16 WAV. It skips obsolete pending prefixes when decoding runs behind,
then submits the full final audio. The production delivery state machine sends
confirmed suffixes to an in-memory sink. The worker finalizes phrases after
600 ms of VAD quiet with 100 ms of padding and decodes each contiguous finalized
phrase once. Stop processes the remaining audio; unavailable VAD defers unresolved
audio to Stop. Immutable phrase caches require exact normalized PCM prefix
matches, and all source audio is considered in order. The delivered stream must
exactly match the normalized assembled live final transcript, which may differ
from a whole-clip baseline because of phrase boundaries.

Timing therefore describes simulated delivery, not Windows `SendInput`,
microphone startup or actual app consumption.
The two modes are alternatives: use `[--stream|--live]`, not both flags.

The helper reports numeric timings, character counts, hashes and bounded error
codes without printing recognized text, and kills/reaps its child on exit. It
does not capture microphone audio or insert text into another app. Final checks
passed 103 component tests and 31 helper tests (shared tests are repeated; one
synthetic child entry point is intentionally ignored per harness). The paced
60-second sample first delivered at 2.905 seconds, delivered 11 updates before
Stop, and finished 1.318 seconds after Stop. Exact delivered/final text and all
normalized PCM ranges matched. This is one warm in-memory run, not an accuracy
or cross-app guarantee; see `docs/DICTATION.md` for limits and report location.
The historical `--reconcile` mode replays a fixed prefix schedule without pacing
for diagnostics only. Earlier `--stream` timings are not live-insertion results.
Earlier partial-draft probes had committed-word revisions and repeated text
that disappeared later, so draft agreement and reconciliation were removed.
The installed 0.8.1 behavior and historical measurements remain documented in
`docs/DICTATION.md`. This live dictation source update has not been installed
or pushed to GitHub and does not change meeting recording or notes.
