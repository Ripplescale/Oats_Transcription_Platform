"""Local CPU dictation with timestamped LocalAgreement; no meeting runtime imports.

The caller supplies cumulative, normalized PCM16 audio. Confirmed words are
immutable; draft_text is an explicitly provisional suffix. Audio is trimmed only
behind confirmed timestamps, with overlap retained for alignment.
"""
from __future__ import annotations

import hashlib
import math
from numbers import Real
import os
from pathlib import Path
import stat
import time
import uuid

SAMPLE_RATE = 16000
MAX_SAMPLES = 120 * SAMPLE_RATE
MAX_WORDS = 8192
MAX_ALIGNMENT_RECOVERIES = 128
MAX_TEXT_BYTES = 768 * 1024
DEFAULT_CONTEXT_SECONDS = 5
EDGE_GUARD_SAMPLES = 1600
TIMESTAMP_TOLERANCE = 0.35


def _plain(path):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError("Faster-whisper model must be an absolute local directory")
    for part in (path, *path.parents):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Faster-whisper model paths cannot use links or reparse points")
    return path


def validate_settings(settings, path_validator=None):
    if not isinstance(settings, dict):
        raise ValueError("Faster-whisper settings are required")
    model_path = (path_validator or _plain)(Path(settings.get("model_path", "")))
    if not model_path.is_absolute() or not model_path.is_dir():
        raise ValueError("Faster-whisper model must be an absolute local directory")
    count = 0
    for directory, directories, files in os.walk(model_path, followlinks=False):
        for name in directories + files:
            (path_validator or _plain)(Path(directory) / name)
            count += 1
            if count > 1024:
                raise ValueError("Faster-whisper model directory contains too many entries")
    for name in ("model.bin", "config.json", "tokenizer.json"):
        if not (model_path / name).is_file():
            raise ValueError("Faster-whisper converted model assets are incomplete")
    threads = settings.get("cpu_threads", 4)
    if type(threads) is not int or not 1 <= threads <= 64:
        raise ValueError("Faster-whisper cpu_threads must be between 1 and 64")
    context = settings.get("context_seconds", DEFAULT_CONTEXT_SECONDS)
    if type(context) is not int or not 1 <= context <= 10:
        raise ValueError("Faster-whisper context_seconds must be an integer between 1 and 10")
    model_id = settings.get("model_id", model_path.name)
    if not isinstance(model_id, str) or not model_id or len(model_id) > 256:
        raise ValueError("Faster-whisper model_id is invalid")
    language = settings.get("language")
    if language not in (None, "hi", "en"):
        raise ValueError("Faster-whisper language must be null, hi, or en")
    return {"model_path": str(model_path), "cpu_threads": threads,
            "model_id": model_id, "language": language, "context_seconds": context}


def _key(word):
    # Keep script marks, case, numbers, and punctuation; agreement is literal.
    return " ".join(word["text"].split())


def _same(left, right):
    return (_key(left) == _key(right)
            and abs(left["start"] - right["start"]) <= TIMESTAMP_TOLERANCE
            and abs(left["end"] - right["end"]) <= TIMESTAMP_TOLERANCE)


def _frontier_key(word):
    value = _key(word)
    # Context can capitalize or punctuate an immutable earlier word. Ignore
    # only ordinary outer sentence punctuation and ASCII case for alignment;
    # retain Hindi marks, numeric forms, internal punctuation, signs/symbols.
    if any(character.isdecimal() for character in value):
        return value
    value = value.strip(".,;:!?\"'\u201c\u201d\u2018\u2019()[]{}\u0964\u0965")
    return value.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))


def _same_frontier(left, right):
    key = _frontier_key(left)
    return (bool(key) and key == _frontier_key(right)
            and abs(left["start"] - right["start"]) <= TIMESTAMP_TOLERANCE
            and abs(left["end"] - right["end"]) <= TIMESTAMP_TOLERANCE)


def _render(words):
    # Whisper words carry their own leading spaces and attached punctuation.
    return "".join(word["text"] for word in words).strip()


class Backend:
    def __init__(self, settings, path_validator=None, model_factory=None):
        self.settings = validate_settings(settings, path_validator)
        began = time.monotonic()
        if model_factory is None:
            from faster_whisper import WhisperModel
            model_factory = WhisperModel
        self.model = model_factory(self.settings["model_path"], device="cpu", compute_type="int8",
                                   cpu_threads=self.settings["cpu_threads"], num_workers=1,
                                   local_files_only=True)
        self.load_seconds = time.monotonic() - began
        self.clear()

    def clear(self):
        """Forget all session audio/text state while retaining the loaded model."""
        self.identity = None
        self.language = None
        self.confirmed = []
        self.previous = []
        self.buffer_start = 0
        self.verified_samples = 0
        self.prefix_hash = None
        self.last_sample_count = 0
        self.last_audio_key = None
        self.last_words = []
        self.recovery_floor = None
        self.recovery_count = 0
        self.recovery_samples = 0

    def _decode(self, samples, start, language):
        import numpy as np
        if not samples[start:].any():
            return [], 0.0
        began = time.monotonic()
        segments, _info = self.model.transcribe(
            samples[start:].astype(np.float32) / 32768.0, language=language,
            beam_size=1, best_of=1, temperature=0.0, condition_on_previous_text=False,
            word_timestamps=True, vad_filter=False)
        words, previous_start, previous_end = [], 0.0, 0.0
        entry_count = 0
        for segment in segments:  # Consuming the generator performs inference.
            entries = segment.words
            if entries is None:
                raise ValueError("Faster-whisper did not return word timestamps")
            for word in entries:
                entry_count += 1
                if entry_count > MAX_WORDS:
                    raise ValueError("Faster-whisper returned too many words")
                text, word_start, word_end = word.word, word.start, word.end
                if (not isinstance(word_start, Real) or isinstance(word_start, bool)
                        or not isinstance(word_end, Real) or isinstance(word_end, bool)):
                    raise ValueError("Faster-whisper returned invalid timestamped words")
                # faster-whisper emits NumPy scalar times as well as Python
                # floats. Keep result/cache values portable and JSON-safe.
                word_start, word_end = float(word_start), float(word_end)
                if (not isinstance(text, str)
                        or not math.isfinite(word_start) or not math.isfinite(word_end)
                        or word_start < 0 or word_end < word_start
                        or word_start + .05 < previous_start or word_end + .05 < previous_end
                        or word_end > (len(samples) - start) / SAMPLE_RATE + .1):
                    raise ValueError("Faster-whisper returned invalid timestamped words")
                previous_start, previous_end = word_start, word_end
                # The real decoder can emit a trailing zero-duration space.
                # Validate it fully, then exclude formatting-only entries from
                # spoken-word agreement/counts without changing actual words.
                if not text.strip():
                    continue
                words.append({"text": text, "start": word_start + start / SAMPLE_RATE,
                              "end": min(word_end + start / SAMPLE_RATE, len(samples) / SAMPLE_RATE)})
        if sum(len(word["text"].encode("utf-8")) for word in words) > MAX_TEXT_BYTES:
            raise ValueError("Faster-whisper draft is too large")
        return words, time.monotonic() - began

    def _uncommitted(self, words):
        if not self.confirmed:
            return words, True
        frontier = self.confirmed[-1]
        matches = [index for index, word in enumerate(words) if _same_frontier(word, frontier)]
        # Timestamp jitter can make a newly spoken repeated word look closer
        # than the older occurrence. Never choose by nearest timestamp score.
        if len(matches) == 1:
            return words[matches[0] + 1:], True
        # A later start can also be a drifted timestamp on the old word; do not
        # mistake it for proof of new speech. Recovery owns the timestamp tail.
        if not words:
            return words, True
        return [word for word in words if word["start"] >= frontier["end"]], False

    def transcribe(self, samples, stream=None, language_mode="hinglish"):
        final = stream is None or stream.get("final") is True
        try:
            return self._transcribe(samples, stream, language_mode, final)
        except Exception:
            self.clear()
            raise
        finally:
            if final:
                self.clear()

    def _transcribe(self, samples, stream, language_mode, final):
        import numpy as np
        if (not isinstance(samples, np.ndarray) or samples.ndim != 1
                or samples.dtype != np.dtype("<i2") or not 0 < len(samples) <= MAX_SAMPLES):
            raise ValueError("Faster-whisper requires bounded normalized mono PCM16")
        if language_mode not in ("hinglish", "english"):
            raise ValueError("Unsupported dictation language mode")
        language = "en" if language_mode == "english" else self.settings["language"]
        identity = None
        live = False
        if stream is not None:
            identity = stream.get("id")
            if (not isinstance(identity, str) or str(uuid.UUID(identity)) != identity
                    or type(stream.get("final")) is not bool
                    or ("live" in stream and type(stream["live"]) is not bool)
                    or set(stream) - {"id", "final", "live"}):
                raise ValueError("Invalid faster-whisper stream descriptor")
            live = stream.get("live", False)
        state_identity = (identity, live)
        if stream is None or self.identity != state_identity or self.language != language:
            self.clear()
            self.identity, self.language = state_identity, language
        if len(samples) < self.last_sample_count:
            raise ValueError("Cumulative faster-whisper audio cannot be shortened")
        if self.prefix_hash is not None and hashlib.sha256(samples[:self.verified_samples].tobytes()).digest() != self.prefix_hash:
            raise ValueError("Confirmed faster-whisper audio changed")
        if not live and not final:
            self.last_sample_count = len(samples)
            return {"text": "", "draft_text": "", "windows": [], "timing": {"inference_seconds": 0.0},
                    "cache_hit_count": 0}
        start = self.buffer_start
        grew = len(samples) > self.last_sample_count
        audio_key = (start, hashlib.sha256(samples[start:].tobytes()).digest())
        reused = audio_key == self.last_audio_key
        if reused:
            words, elapsed = self.last_words, 0.0
        else:
            words, elapsed = self._decode(samples, start, language)
        windows = [{"start_seconds": start / SAMPLE_RATE,
                    "audio_seconds": (len(samples) - start) / SAMPLE_RATE,
                    "reused": reused, "inference_seconds": elapsed}]
        candidates, aligned = (words, True) if self.recovery_floor is not None else self._uncommitted(words)
        if not aligned:
            if self.recovery_count >= MAX_ALIGNMENT_RECOVERIES:
                raise ValueError("Faster-whisper alignment recovery limit exceeded")
            # Decode at most one additional window per request, starting at the
            # last committed timestamp. This owns the remaining audio without
            # choosing between ambiguous repeated words or a revised old word.
            # Whisper timestamps are estimates: a boundary error can still cut
            # a spoken word, the same limitation as the final-only fallback.
            retry_start = min(len(samples), round(self.confirmed[-1]["end"] * SAMPLE_RATE))
            candidates, retry_elapsed = self._decode(samples, retry_start, language)
            elapsed += retry_elapsed
            windows.append({"start_seconds": retry_start / SAMPLE_RATE,
                            "audio_seconds": (len(samples) - retry_start) / SAMPLE_RATE,
                            "reused": False, "inference_seconds": retry_elapsed,
                            "alignment_recovery": True})
            self.previous = []
            self.buffer_start = retry_start
            self.recovery_floor = retry_start
            self.recovery_count += 1
            self.recovery_samples = retry_start
            # The next growing prefix must use this same owned floor and a
            # fresh hypothesis, without requiring the absent earlier anchor.
            words = candidates
            audio_key = (retry_start, hashlib.sha256(samples[retry_start:].tobytes()).digest())
            aligned = True
        agreed = 0
        if final:
            agreed = len(candidates)
        elif aligned and not reused and grew:
            for previous, current in zip(self.previous, candidates):
                if not _same(previous, current) or current["end"] > len(samples) / SAMPLE_RATE - .3:
                    break
                agreed += 1
            # Keep the trailing word provisional until additional context or Stop.
            agreed = min(agreed, max(0, len(candidates) - 1))
        self.confirmed.extend(candidates[:agreed])
        if agreed:
            # Once fresh tail words agree, their new frontier can again align
            # normal overlapping decodes. The rolling floor never moves back.
            self.recovery_floor = None
        self.previous = candidates[agreed:] if aligned else []
        self.last_audio_key, self.last_words = audio_key, words
        self.last_sample_count = len(samples)
        if len(self.confirmed) + len(self.previous) > MAX_WORDS:
            raise ValueError("Faster-whisper session contains too many words")
        text, draft = _render(self.confirmed), "" if final else _render(candidates[agreed:])
        if len(text.encode("utf-8")) + len(draft.encode("utf-8")) > MAX_TEXT_BYTES:
            raise ValueError("Faster-whisper session text is too large")
        if self.confirmed and not final:
            safe = min(round(self.confirmed[-1]["end"] * SAMPLE_RATE) - self.settings["context_seconds"] * SAMPLE_RATE,
                       len(samples) - EDGE_GUARD_SAMPLES)
            self.buffer_start = max(self.buffer_start, safe, 0)
            self.verified_samples = max(self.verified_samples,
                                        min(round(self.confirmed[-1]["end"] * SAMPLE_RATE),
                                            len(samples) - EDGE_GUARD_SAMPLES))
            self.prefix_hash = hashlib.sha256(samples[:self.verified_samples].tobytes()).digest()
        result = {"text": text, "draft_text": draft,
                  "windows": windows,
                  "timing": {"inference_seconds": elapsed}, "cache_hit_count": int(reused)}
        if live:
            result.update(live_delivery="stable_words", confirmed_word_count=len(self.confirmed),
                          confirmed_samples=len(samples) if final else self.buffer_start,
                          audio_sample_count=len(samples), alignment_available=aligned,
                          alignment_recovery_count=self.recovery_count,
                          alignment_recovery_samples=self.recovery_samples)
        return result
