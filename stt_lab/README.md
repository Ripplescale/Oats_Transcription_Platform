# Local speech workers and evaluation tools

This directory contains oats's offline ASR worker, optional speaker worker, pinned registry, setup helpers, and test utilities. Start with [Windows setup](../docs/SETUP.md) and [how it works](../docs/HOW_IT_WORKS.md).

New settings use **Trelis 10-second original-script transcription** during the call; 5- and 20-second choices are also available. The same job finishes after stopping. Whole microphone windows with no 20 ms frame above RMS 0.006 (about -44.4 dBFS) skip speech detection and decoding, while original audio is retained. This intentional volume rule can omit faint real speech; computer audio and unknown tracks are exempt. A conservative Silero gate checks retained Trelis windows and retains uncertain speech. Long repeated output gets bounded context recovery and shorter retries. Apex 20-second Roman Hinglish remains a separate explicit fallback. Raw outputs and version-specific corrections are retained; “Final” remains machine output awaiting review. Trelis is not broadly transliterated; exact hesitation fillers are displayed in Roman script. Qwen summaries are disabled; Claude handoff is manual.

One heavy worker runs at a time. Saved audio continues accumulating while jobs queue; a draft that never started before stop is skipped, while the Final can still process that recording. Paused/failed Finals require retry, and legacy jobs are never silently rewritten. Manual additional versions remain in Tools. The registry's other window sizes are experimental settings rather than routine recording controls.

| Area | Entry points |
| --- | --- |
| Pinned assets and downloads | `models.json`, `tools/model_assets.py` |
| Adapter and provenance | `sttbench/runtime/api.py`, [contract](sttbench/runtime/README.md) |
| Recording-window jobs and recovery | `sttbench/local_worker.py` |
| Versioned worker installation | `tools/install_local_worker.py` |
| Optional post-call speakers | [setup](SPEAKER_SETUP.md), `sttbench/speaker_worker.py`, `sttbench/speaker_reconciliation.py` |
| Apex conversion and Vulkan | [whisper.cpp setup](tools/WHISPER_CPP_SETUP.md) |
| Tests | `tests/` |

Runtime data belongs outside the repository, normally under `%LOCALAPPDATA%\STTApp`. Weights, audio, references, correction exports, rendered reviews, and machine-specific runbooks are excluded from publication. Historical private experiments remain on the development machine; they are not required to install the worker.

Setup retains exact revisions, hashes, licenses, decoder settings, and conversion provenance. Inference never downloads missing weights. Failures are explicit, so recording and recovery remain independent.

Evaluation preserves complete audio coverage, original output, reference scope, and script compatibility. Synthetic tests verify contracts. They do not establish accuracy on future calls, sustained live performance, or speaker identity accuracy.
