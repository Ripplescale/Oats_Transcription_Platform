# Retired faster-whisper dictation experiment

This experimental dictation backend is retired after natural-speech recognition failed acceptance. Its launcher intentionally refuses to run. The supported path uses [Trelis phrase dictation](DICTATION.md).

The retained implementation and synthetic tests document a streaming experiment; they are not a recommended setup, an enabled release mode or an accuracy claim.

## Architecture

The experiment uses converted multilingual Whisper models through faster-whisper with CPU int8 inference. It has no dedicated Hinglish fine-tuning. Its isolated runtime selection does not change meeting transcription or notes.

One resident decoder receives cumulative audio at a one-second cadence after the first request. Newer prefixes replace obsolete queued previews. Word timestamps align overlapping decodes; agreement across consecutive hypotheses promotes words into an immutable confirmed prefix. A separate tentative draft can change and is never automatically copied or inserted.

Confirmed audio is trimmed behind the last confirmed timestamp with retained context. Unconfirmed audio is not discarded to satisfy a buffer target. Stop decodes the remainder and clears the draft; Cancel leaves already delivered words in place. Existing focus and interaction guards apply.

When alignment fails, bounded recovery restarts at an estimated word boundary and requires fresh agreement. Timestamp errors can cut words, while disagreement at the first unconfirmed word can stall subsequent delivery. Clean synthetic replay did not establish reliable natural-speech or mixed-script recognition.

## Runtime contract retained for tests

The worker runs offline with `local_files_only=True`. An explicit `OATS_DICTATION_RUNTIME` selects a configuration; otherwise the app checks `dictation-runtime.json` in its configured data root before falling back to Trelis `runtime.json`. Invalid explicit selections fail rather than silently switching engines.

A configuration uses absolute paths to its independently provisioned Python interpreter and converted model directory:

```json
{
  "version": 1,
  "python_executable": "C:/Example/DictationRuntime/venv/Scripts/python.exe",
  "dictation_backend": "faster_whisper",
  "faster_whisper": {
    "model_path": "C:/Example/DictationRuntime/models/base",
    "model_id": "Systran/faster-whisper-base",
    "cpu_threads": 4,
    "context_seconds": 5,
    "language": null
  }
}
```

The model directory contains `model.bin`, `config.json` and `tokenizer.json`. Configuration, worker-module and model-file changes invalidate reuse. This schema description does not re-enable the retired launcher or provision an environment.

## Validation and limits

Synthetic Python tests cover timestamp alignment, changing/retracted drafts, repeated words, prefix integrity, session resets and Stop. Native tests cover backend-bound results, runtime identity, serial draft delivery and cancellation. UI tests keep tentative text separate from confirmed text and hide it on terminal or new-session states.

No private microphone transcript, recording or workstation benchmark is published here. The experiment does not qualify physical keys, target-app insertion, natural English/Hinglish accuracy or a guaranteed delivery delay.

## References

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [Systran converted base model](https://huggingface.co/Systran/faster-whisper-base)
- [OpenAI multilingual Whisper base](https://huggingface.co/openai/whisper-base)
- [CTranslate2 installation](https://opennmt.net/CTranslate2/installation.html)
