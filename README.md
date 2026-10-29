# oats

**I listen and I don't judge**

oats is a local Windows desktop app for recording calls, keeping the audio, and working with Hindi–English transcripts. It builds on Meetily Community with a local inference worker and a notes-first workspace.

## Get started

Download **[Oats-Setup.exe](https://github.com/Ripplescale/Oats_Transcription_Platform/releases/download/setup-90c87eedfa370799c4dd/Oats-Setup.exe)**, open it on the PC where you want oats, and click **Install oats** (older copies say **Download and install**). Setup downloads everything needed. When it finishes, open **oats** from the Windows Start menu and check **About → Check for updates**.

The first download is about **11 GB**; keep **30 GB free**. No Python, terminal commands or accounts are needed. See the **[short installation guide](docs/COMPLETE_SETUP.md)**. Only use **Download for another PC** (older wording: **Save for offline setup**) if you need to transfer setup to a PC without internet.

Existing users should use the app's update notification or **About → Check for updates**. Developers building from source can use the **[developer guide](docs/DEVELOPER_SETUP.md)**. **[How it works](docs/HOW_IT_WORKS.md)** explains capture, models, revisions, retries, and storage. **[Privacy](PRIVACY_POLICY.md)** describes local processing and manual export.

![oats compact notes workspace with recording playback and an expandable transcript](docs/assets/xx-workspace.png)

*The screenshot uses fictional conversations, names, and quantities.*

![oats notes library grouped by project](docs/assets/xx-library.png)

## What it does

- Opens in a narrow 680 × 820 window, adjusted to fit the screen. Maximize extends it vertically while retaining its current width; Restore returns to the prior size. The home screen groups notes by project; **New note** immediately starts recording and opens a clean writing space.
- Autosaves notes locally. The microphone/up-arrow **Transcript** control reveals recognition when needed; playback, corrections, versions and export remain available.
- Provides **Project memory**: source-linked saved-note excerpts and checked project references. It does not generate facts or infer a knowledge graph from unverified speech.
- Records microphone and system audio into separate local tracks, with a recovery journal written before transcription.
- Offers a small **Record call / Dismiss** prompt when Zoom or Teams desktop activates its microphone. Recording starts only after you choose; no calendar connection is needed. [Detection limits and settings](docs/MEETING_DETECTION.md).
- Offers **Trelis chunks of 5, 10, or 20 seconds**, with 10 seconds as the default for new settings. OpenVINO GPU FP16 preserves the original Hindi/English script. Silero checks microphone and computer audio separately. Repeating or token-limited text first gets a retry with surrounding audio, then a bounded 5-second fallback if needed. The same job finishes remaining saved audio after you stop.
- Offers **Apex · 20 seconds** as an explicit fallback. Trelis pauses after its current window, then Apex replays the saved audio into a separate Roman Hinglish version.
- Retains raw output, separate corrections, and history. “Final transcript” means the Trelis job completed; it remains unreviewed machine output until you check it.
- Keeps recordings, transcripts, notes, speaker review, and playback together.
- Runs optional Community-1 speaker identification locally after recording and transcription complete.
- Lets you copy a corrected transcript into Claude or export a text attachment. You choose when to send it. There is no Qwen summary model or automatic Claude/API upload.
- Includes an optional evidence-backed project Vault for verified names, terms, and quantities. Vault entries do not silently rewrite what a model heard.

See [oats 0.7.4 release notes](docs/releases/0.7.4.md) for speech recovery, chat bubbles, and the paired desktop/worker update.

Computer speech appears on the left and microphone speech on the right. These labels identify audio sources; optional speaker processing remains separate. The preview below uses fictional text.

![Fictional oats transcript with computer and microphone speech bubbles](docs/assets/oats-transcript-bubbles.png)

The everyday flow is **choose a project → New note → write while oats records → stop → review/export**. The transcript starts collapsed and continues processing in the background. Updates use the chosen chunk length **plus processing and queueing time**, and GPU startup adds initial delay. One heavy worker runs at a time, so back-to-back calls can queue; recording continues independently. A GPU failure is shown explicitly, without silently switching Trelis to CPU. Choose Apex fallback or retry when ready. Existing transcript versions, including older Apex-draft/Trelis-final calls, keep their original workflow and corrections.

Outlook calendar sync and automatically generated pre-meeting recaps are not enabled. An approved calendar integration is required before attendee matching can be connected to saved notes; see [meeting preparation](docs/HOW_IT_WORKS.md#meeting-preparation).

The integrated GPU adapter reproduced **23/23 CPU chunk outputs over 400.15 seconds** of development audio. The earlier acceleration experiment measured **8.14× faster** processing on a matched warm subset. A five-minute replay through the actual worker completed **30/30 windows across two saved-audio streams**, preserving raw output and finishing about **16 seconds after input stopped**. It **missed the strict latency gate**: first text took about 50 seconds; the 95th-percentile delay was about 30 seconds after a window ended. These results came from an Intel Ultra 7 268V / Arc 140V laptop. They do not qualify physical capture, a concurrent calling application, or 90-minute performance. See [timing and validation details](docs/HOW_IT_WORKS.md#models-and-timing).

This is an early Windows implementation. The small app-update installer reuses prepared speech models and Python; the separate complete setup bundles those dependencies for a new PC. Hands-on clean-machine acceptance and broad hardware qualification remain work to do. Optional gated speaker identification is not included in the complete setup. The source repository does not contain private recordings, benchmark references, model weights, or credentials; redistributable speech models are hosted separately as GitHub release assets.

The 10-second default is not a universal accuracy optimum. Names, numbers, units, overlap, and quiet input can still be wrong. Automatic flags and retries help find some failures; they do not prove completeness. Two-hour calls, headset reconnects, and live speaker recognition are not yet fully qualified. Screen video and shared workspaces are outside the current scope.

## Development

The app uses Tauri/Rust, Next.js/React, and SQLite. Local Python workers run the selected speech models and optional diarization. See [contributing](CONTRIBUTING.md) for focused checks and the [runtime guide](stt_lab/README.md) for setup tools.

The repository is named **Hinglish Transcription Platform**; the application is **oats** (previously xx). Its existing `com.sttapp.local` identity and `STTApp` data directory are retained so upgrades preserve local work.

## Attribution

Based on [Meetily Community](https://github.com/Zackriya-Solutions/meetily), pinned at `a2cb62e827da7ef59f65064c97233efb2313878e` (`v0.4.1`). The upstream **Copyright (c) 2024 Zackriya Solutions** and [MIT license](LICENSE.md) are preserved. This fork is independent of Meetily's commercial product. Model and runtime licenses are separate; see [third-party attribution](docs/ATTRIBUTION.md).
