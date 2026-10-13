"""Offline dictation requests; no meeting database, recording journal or network.

The packaged entry point imports adapters from the runtime snapshot selected by
the native caller. It never modifies that installed runtime or downloads assets.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import socket
import stat
import sys
import threading
import time
import uuid
import wave

MAX_SECONDS = 120
WINDOW_SECONDS = 20
MAX_JSON_BYTES = 1024 * 1024
MAX_PROTOCOL_BYTES = 4096
MAX_WORKER_REQUESTS = 4096
MAX_STREAM_WINDOWS = MAX_SECONDS // WINDOW_SECONDS
MAX_LIVE_PHRASES = 256
LIVE_SILENCE_SAMPLES = 9600  # 600 ms, rounded up to complete Silero frames
LIVE_PADDING_SAMPLES = 1600
LIVE_NORMALIZATION_GUARD_SAMPLES = 1600
OFFLINE = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
           "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1", "TOKENIZERS_PARALLELISM": "false",
           "NNCF_TELEMETRY_DISABLED": "1", "OPENVINO_TELEMETRY_DISABLED": "1"}


def _watch_parent(stop, alive, terminate):
    while not stop.wait(0.5):
        if not alive():
            # Inference may hold the main Python thread. Terminate this isolated
            # process, which is never allowed to spawn a model CLI child.
            terminate(3)
            return


def start_parent_watchdog():
    """Stop in-flight inference after abnormal app exit, not just between clips."""
    pid = int(os.environ.get("STTAPP_PARENT_PID", "0"))
    stop = threading.Event()
    if pid <= 0:
        return stop
    release = lambda: None
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        dll = ctypes.WinDLL("kernel32", use_last_error=True)
        dll.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        dll.OpenProcess.restype = wintypes.HANDLE
        dll.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        dll.WaitForSingleObject.restype = wintypes.DWORD
        dll.CloseHandle.argtypes = (wintypes.HANDLE,)
        # Keep one handle: a reused PID cannot be mistaken for the original app.
        handle = dll.OpenProcess(0x100000, False, pid)
        if not handle:
            raise RuntimeError("The dictation owner is no longer available")
        alive = lambda: dll.WaitForSingleObject(handle, 0) == 258
        release = lambda: dll.CloseHandle(handle)
    else:
        def alive():
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False
            except PermissionError:
                return True
    def watch():
        try:
            _watch_parent(stop, alive, os._exit)
        finally:
            release()
    threading.Thread(target=watch, name="dictation-parent-watch", daemon=True).start()
    return stop


@contextlib.contextmanager
def offline():
    previous = {key: os.environ.get(key) for key in OFFLINE}
    functions = (socket.socket.connect, socket.socket.connect_ex, socket.create_connection)
    def blocked(*_args, **_kwargs):
        raise OSError("Dictation is offline; network connections are disabled")
    os.environ.update(OFFLINE)
    socket.socket.connect = socket.socket.connect_ex = socket.create_connection = blocked
    try:
        yield
    finally:
        socket.socket.connect, socket.socket.connect_ex, socket.create_connection = functions
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def plain_path(path: Path, *, missing=False):
    """Reject links/junctions before resolving any request-owned path."""
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Dictation paths must be absolute local paths")
    for candidate in reversed((path, *path.parents)):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            if missing and candidate == path:
                continue
            raise
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Dictation paths cannot contain links or reparse points")
    return path


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate dictation JSON field")
        result[key] = value
    return result


def parse_json(raw):
    def invalid_constant(_value):
        raise ValueError("Nonfinite dictation JSON value")
    result = json.loads(raw, object_pairs_hook=_json_object, parse_constant=invalid_constant)
    if not isinstance(result, dict):
        raise ValueError("Dictation JSON must be an object")
    return result


def read_json(path: Path):
    plain_path(path)
    if not path.is_file() or path.stat().st_size > MAX_JSON_BYTES:
        raise ValueError("Dictation configuration is too large")
    with path.open("rb") as source:
        raw = source.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError("Dictation configuration is too large")
    return parse_json(raw.decode("utf-8-sig"))


def publish_json(path: Path, payload):
    """Publish a complete bounded result without replacing existing evidence."""
    raw = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError("Dictation result is too large")
    plain_path(path, missing=True)
    temporary = path.with_suffix(".part")
    plain_path(temporary, missing=True)
    if path.exists():
        raise ValueError("Dictation result already exists")
    created = False
    try:
        with temporary.open("xb") as target:
            created = True
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
        plain_path(path, missing=True)
        # Hard-link publication is atomic and fails if the destination exists.
        os.link(temporary, path)
    finally:
        if created:
            temporary.unlink(missing_ok=True)


def canonical_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Dictation request ID must be a canonical UUID")
    return value


def stream_descriptor(request):
    if "stream" not in request:
        return None
    stream = request["stream"]
    if (not isinstance(stream, dict) or not {"id", "final"} <= set(stream)
            or set(stream) - {"id", "final", "live"} or type(stream["final"]) is not bool):
        raise ValueError("Dictation stream requires a canonical UUID and a boolean final flag")
    descriptor = {"id": canonical_id(stream["id"]), "final": stream["final"]}
    if "live" in stream:
        if type(stream["live"]) is not bool:
            raise ValueError("Dictation stream live flag must be a boolean")
        descriptor["live"] = stream["live"]
    return descriptor


class StreamCache:
    """One session: legacy completed windows or immutable finalized live phrases."""
    def __init__(self):
        self.clear()

    def clear(self):
        if getattr(self, "backend", None) is not None:
            self.backend.clear()
        self.backend = None
        self.identity = None
        self.settings = None
        self.adapters = None
        self.windows = {}
        self.partial = None
        self.phrases = []
        self.confirmed_samples = 0
        self.endpoint_failed = False

    def configure(self, stream, spec, runtime, gate_config, infer, gate, complete_samples, endpoint=None):
        if stream is None:
            self.clear()
            return
        settings = hashlib.sha256(json.dumps(
            [spec, runtime, gate_config, stream.get("live", False)],
            sort_keys=True, allow_nan=False).encode("utf-8")).digest()
        if self.identity != stream["id"] or self.settings != settings or self.adapters != (infer, gate, endpoint):
            self.clear()
            self.identity, self.settings, self.adapters = stream["id"], settings, (infer, gate, endpoint)
        # A shortened/replaced cumulative clip cannot leave unseen tail entries.
        self.windows = {offset: value for offset, value in self.windows.items() if offset < complete_samples}
        if self.partial is not None and (not stream.get("live", False) or self.partial["offset"] != complete_samples):
            self.partial = None

    def remember(self, offset, digest, text, window, complete=True):
        if complete and offset not in self.windows and len(self.windows) >= MAX_STREAM_WINDOWS:
            raise ValueError("Dictation stream exceeds its completed-window limit")
        text_bytes = len(text.encode("utf-8"))
        full_bytes = sum(value["text_bytes"] for index, value in self.windows.items() if index != offset)
        partial_bytes = self.partial["text_bytes"] if complete and self.partial is not None else 0
        if text_bytes + full_bytes + partial_bytes > MAX_JSON_BYTES:
            raise ValueError("Dictation stream text is too large")
        entry = {"offset": offset, "digest": digest, "text": text, "text_bytes": text_bytes,
                 "state": window["state"], "gate_available": window.get("gate_available")}
        if complete:
            self.windows[offset] = entry
        else:
            self.partial = entry


def model_configuration(config, model, language):
    if model not in ("trelis", "apex") or language not in ("hinglish", "english"):
        raise ValueError("Choose an available dictation model and language mode")
    registry_path = Path(config["registry_path"])
    if not registry_path.is_absolute():
        raise ValueError("Speech model registry must be an absolute local path")
    registry = read_json(registry_path)
    spec = copy.deepcopy(next((item for item in registry["models"] if item.get("id") == model), None))
    if spec is None or model not in config.get("models", {}):
        raise ValueError(f"The selected {model} dictation model is not configured")
    runtime = copy.deepcopy(config["models"][model])
    # The parent owns exactly one child, including during warmup/cancellation.
    if runtime.get("backend", "transformers") not in ("transformers", "openvino"):
        raise ValueError("Dictation requires the configured Transformers or OpenVINO local runtime")
    runtime.update(timestamps=False, reuse_model=True)
    if model == "trelis":
        spec.setdefault("decoding", {}).update(language="en" if language == "english" else "hi", mixed_code=language != "english")
    return spec, runtime


def runtime_adapters(config: dict):
    entry = Path(config["worker_script"])
    plain_path(entry)
    if not entry.is_absolute() or not entry.is_file():
        raise ValueError("Installed local speech runtime is unavailable")
    runtime_root = entry.resolve().parent
    if not (runtime_root / "sttbench/runtime/api.py").is_file():
        raise ValueError("Installed speech runtime does not provide a dictation adapter")
    sys.path.insert(0, str(runtime_root))
    from sttbench.runtime import transcribe
    from sttbench.speech_gate import assess_window
    return transcribe, assess_window


def numeric_timings(result):
    """Do not carry model diagnostics, prompts or transcripts into telemetry."""
    allowed = ("load_seconds", "compile_seconds", "inference_seconds", "total_seconds",
               "verification_seconds", "conversion_verification_seconds")
    timing = result.get("timing", {})
    if not isinstance(timing, dict):
        return {}
    return {key: timing[key] for key in allowed
            if type(timing.get(key)) in (float, int) and math.isfinite(timing[key]) and timing[key] >= 0}


def warm_gate(config):
    """Load the existing optional VAD cache without capturing or inferring audio."""
    try:
        from sttbench.speech_gate import _load_session
        settings = config["speech_gate"]
        model = plain_path(Path(settings["model_path"]))
        digest = settings["model_sha256"]
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            return False
        info = model.stat()
        _load_session(str(model), digest, info.st_mtime_ns, info.st_size)
        return True
    except Exception:
        # The established gate keeps audio when unavailable; warmup does too.
        return False


def warm_runtime(config, *, infer=None, gate=None, warmup=None):
    began = time.monotonic()
    if dictation_backend(config) == "faster_whisper":
        import numpy  # noqa: F401
        import scipy.signal  # noqa: F401
        backend = faster_whisper_backend(config)
        ready = {"version": 1, "status": "ok", "model": backend.settings["model_id"],
                 "dictation_backend": "faster_whisper", "language_mode": "hinglish",
                 "elapsed_seconds": time.monotonic() - began,
                 "timing": {"load_seconds": backend.load_seconds}, "gate_warmed": False}
        return ready, backend, None, (config, None, None)
    spec, runtime = model_configuration(config, "trelis", "hinglish")
    imports_started = time.monotonic()
    import numpy  # noqa: F401 -- retain import costs before the first phrase
    import scipy.signal  # noqa: F401
    if infer is None or gate is None:
        actual_infer, actual_gate = runtime_adapters(config)
        infer, gate = infer or actual_infer, gate or actual_gate
    if warmup is None:
        from sttbench.runtime.api import warmup
    import_seconds = time.monotonic() - imports_started
    gate_started = time.monotonic()
    gate_warmed = warm_gate(config)
    gate_seconds = time.monotonic() - gate_started
    result = warmup(spec, runtime)
    status = "ok" if result.get("status") == "ok" else "failed"
    error = result.get("error") or {}
    if runtime.get("backend", "transformers") == "transformers" and error.get("code") == "warmup_unsupported":
        status = "deferred"
    ready = {"version": 1, "status": status, "model": "trelis", "language_mode": "hinglish",
             "elapsed_seconds": time.monotonic() - began, "import_seconds": import_seconds,
             "gate_warmup_seconds": gate_seconds, "gate_warmed": gate_warmed,
             "timing": numeric_timings(result)}
    if status == "failed":
        ready["error"] = str(error.get("message", "Local dictation warmup failed"))[:2000]
    return ready, infer, gate, (config, spec, runtime)


def dictation_backend(config):
    backend = config.get("dictation_backend", "trelis")
    if backend not in ("trelis", "faster_whisper"):
        raise ValueError("Unsupported dictation backend")
    return backend


_FASTER_WHISPER_MODULE = None


def faster_whisper_backend(config):
    global _FASTER_WHISPER_MODULE
    if _FASTER_WHISPER_MODULE is None:
        # Resolve the packaged sibling, never a same-named module on PYTHONPATH.
        source = plain_path(Path(__file__).absolute().with_name("faster_whisper_dictation.py"))
        spec = importlib.util.spec_from_file_location("oats_faster_whisper_dictation", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _FASTER_WHISPER_MODULE = module
    return _FASTER_WHISPER_MODULE.Backend(config.get("faster_whisper"), path_validator=plain_path)


def normalized_audio(path: Path):
    import numpy as np
    from scipy.signal import resample_poly
    with wave.open(str(path), "rb") as source:
        rate, frames = source.getframerate(), source.getnframes()
        if source.getcomptype() != "NONE" or source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError("Dictation input must be a mono PCM16 WAV")
        if not 8000 <= rate <= 192000 or frames < 1 or frames > rate * MAX_SECONDS:
            raise ValueError("Dictation audio must contain between one sample and 120 seconds")
        raw = source.readframes(frames)
        if len(raw) != frames * 2:
            raise ValueError("Dictation audio is incomplete")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    divisor = math.gcd(rate, 16000)
    converted = resample_poly(samples, 16000 // divisor, rate // divisor) if rate != 16000 else samples
    expected = round(frames * 16000 / rate)
    converted = converted[:expected]
    if len(converted) < expected:
        converted = np.pad(converted, (0, expected - len(converted)))
    return np.clip(np.rint(converted * 32768), -32768, 32767).astype("<i2"), frames / rate


def find_live_endpoints(samples, start_sample, config):
    """Conservative silence boundaries, never character/token-derived cuts."""
    try:
        import numpy as np
        from sttbench.speech_gate import _load_session, _probabilities, FRAME_SAMPLES
        if FRAME_SAMPLES != 512 or not isinstance(config, dict):
            raise ValueError("Unsupported live speech gate")
        model = plain_path(Path(config["model_path"]))
        digest = config["model_sha256"]
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("Invalid speech gate digest")
        threshold, boost_peak, max_gain = (float(config.get(key, default)) for key, default in
                                           (("threshold", .15), ("boost_peak", .25), ("max_gain", 1000)))
        if not all(math.isfinite(v) for v in (threshold, boost_peak, max_gain)) or not (
                0 < threshold <= .15 and 0 < boost_peak <= 1 and 1 <= max_gain <= 1000):
            raise ValueError("Invalid conservative speech gate settings")
        info = model.stat()
        session, interface, _digest = _load_session(str(model), digest, info.st_mtime_ns, info.st_size)
        if config.get("model_version") == "6.2.3" and interface != "state_512":
            raise ValueError("Invalid speech gate interface")
        pending = samples[start_sample:].astype(np.float32) / 32768
        if not len(pending):
            return {"available": True, "endpoints": []}
        peak = float(np.max(np.abs(pending)))
        gain = min(max_gain, max(1., boost_peak / max(peak, 1e-12)))
        raw = _probabilities(session, pending, 1., interface)
        boosted = raw if gain == 1. else _probabilities(session, pending, gain, interface)
        expected = (len(pending) + FRAME_SAMPLES - 1) // FRAME_SAMPLES
        if len(raw) != expected or len(boosted) != expected:
            raise ValueError("Invalid speech gate frame count")
        combined = np.maximum(raw, boosted)
        if not np.isfinite(combined).all() or np.any(combined < 0) or np.any(combined > 1):
            raise ValueError("Invalid speech gate probabilities")
        endpoints, speech_end, silence = [], None, 0
        # Ignore the zero-padded last classifier frame. No endpoint uses future
        # padding as evidence of silence or mutable resampler edge samples.
        for index, probability in enumerate(combined[:len(pending) // FRAME_SAMPLES]):
            if probability >= threshold:
                speech_end, silence = (index + 1) * FRAME_SAMPLES, 0
            elif speech_end is not None:
                silence += FRAME_SAMPLES
                end = speech_end + LIVE_PADDING_SAMPLES
                if silence >= LIVE_SILENCE_SAMPLES and len(pending) - end >= LIVE_NORMALIZATION_GUARD_SAMPLES:
                    endpoints.append({"end_sample": start_sample + end,
                                      "vad_speech_end_sample": start_sample + speech_end,
                                      "confirmed_silence_samples": silence,
                                      "padding_samples": LIVE_PADDING_SAMPLES,
                                      "normalization_guard_samples": len(pending) - end,
                                      "vad_frame_samples": FRAME_SAMPLES})
                    speech_end, silence = None, 0
        return {"available": True, "endpoints": endpoints}
    except Exception:
        # No unqualified partial hypothesis is allowed to replace this fallback.
        return {"available": False, "endpoints": []}


def decode_confirmed_phrase(samples, start, end, directory, spec, runtime, config, infer, gate):
    """Decode all of a finalized range, using the existing 20-second policy."""
    temporary = directory / "dictation-window.wav"
    plain_path(temporary, missing=True)
    if temporary.exists():
        raise ValueError("Dictation scratch audio already exists")
    pieces, windows = [], []
    timing = {"gate_seconds": 0.0, "inference_seconds": 0.0}
    try:
        for offset in range(start, end, WINDOW_SECONDS * 16000):
            pcm = samples[offset:min(end, offset + WINDOW_SECONDS * 16000)]
            window = {"start_seconds": offset / 16000, "audio_seconds": len(pcm) / 16000,
                      "complete": len(pcm) == WINDOW_SECONDS * 16000, "finalized": True, "reused": False}
            if not pcm.any():
                windows.append({**window, "state": "silence"})
                continue
            plain_path(temporary, missing=True)
            with temporary.open("xb") as target, wave.open(target, "wb") as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(pcm.tobytes())
            began = time.monotonic()
            decision = gate(temporary, config.get("speech_gate"))
            elapsed = time.monotonic() - began
            timing["gate_seconds"] += elapsed
            window.update(gate_seconds=elapsed, gate_available=decision.get("status") == "ok")
            if decision.get("status") == "ok" and decision.get("skip_stt") is True:
                windows.append({**window, "state": "no_speech"})
                temporary.unlink()
                continue
            began = time.monotonic()
            result = infer(spec, temporary, runtime)
            elapsed = time.monotonic() - began
            timing["inference_seconds"] += elapsed
            if result.get("status") != "ok":
                error = result.get("error") or {}
                raise RuntimeError(f"Local dictation failed: {error.get('message', error.get('code', 'unknown model error'))}")
            text = result.get("text")
            if not isinstance(text, str):
                raise ValueError("Local dictation returned invalid text")
            if text.strip():
                pieces.append(text.strip())
            windows.append({**window, "state": "transcribed", "inference_seconds": elapsed,
                            "runtime_timing": numeric_timings(result),
                            "model_reused": result.get("provenance", {}).get("model_reused") is True})
            temporary.unlink()
    finally:
        temporary.unlink(missing_ok=True)
    return " ".join(pieces), windows, timing


def confirmed_live(samples, directory, stream, spec, runtime, config, infer, gate, cache, endpoint):
    cache = cache if cache is not None else StreamCache()
    endpoint = endpoint or find_live_endpoints
    cache.configure(stream, spec, runtime, config.get("speech_gate"), infer, gate, 0, endpoint)
    if cache.confirmed_samples > len(samples):
        raise ValueError("Confirmed dictation audio cannot be shortened")
    for phrase in cache.phrases:
        pcm = samples[phrase["start_sample"]:phrase["end_sample"]].tobytes()
        if hashlib.sha256(pcm).hexdigest() != phrase["pcm_sha256"]:
            raise ValueError("Confirmed dictation audio changed")
    cache_hits = len(cache.phrases)
    began = time.monotonic()
    decision = {"available": False, "endpoints": []}
    if not cache.endpoint_failed:
        try:
            decision = endpoint(samples, cache.confirmed_samples, config.get("speech_gate"))
            if not isinstance(decision, dict) or decision.get("available") is not True:
                cache.endpoint_failed = True
        except Exception:
            cache.endpoint_failed = True
    if cache.endpoint_failed:
        decision = {"available": False, "endpoints": []}
    timings = {"endpoint_seconds": time.monotonic() - began, "gate_seconds": 0.0, "inference_seconds": 0.0}
    endpoints = decision.get("endpoints", [])
    previous = cache.confirmed_samples
    try:
        if not isinstance(endpoints, list):
            raise ValueError("Invalid finalized dictation endpoints")
        for boundary in endpoints:
            end = boundary.get("end_sample") if isinstance(boundary, dict) else None
            speech_end = boundary.get("vad_speech_end_sample") if isinstance(boundary, dict) else None
            silence = boundary.get("confirmed_silence_samples") if isinstance(boundary, dict) else None
            if (type(end) is not int or type(speech_end) is not int or type(silence) is not int
                    or not previous < speech_end <= end < len(samples)
                    or end - speech_end != LIVE_PADDING_SAMPLES or silence < LIVE_SILENCE_SAMPLES
                    or len(samples) - speech_end < silence
                    or len(samples) - end < LIVE_NORMALIZATION_GUARD_SAMPLES):
                raise ValueError("Invalid finalized dictation boundary")
            previous = end
    except (TypeError, ValueError):
        # Broken endpoint diagnostics are an unavailable detector, never a
        # reason to expose an unfinished hypothesis or lose confirmed phrases.
        cache.endpoint_failed = True
        endpoints, previous = [], cache.confirmed_samples
    if stream["final"] and previous < len(samples):
        endpoints = [*endpoints, {"end_sample": len(samples), "vad_speech_end_sample": None,
                                  "confirmed_silence_samples": 0, "padding_samples": 0,
                                  "normalization_guard_samples": 0, "vad_frame_samples": 512}]
    windows = []
    for boundary in endpoints:
        if len(cache.phrases) >= MAX_LIVE_PHRASES:
            raise ValueError("Dictation exceeds its finalized phrase limit")
        start, end = cache.confirmed_samples, boundary["end_sample"]
        text, decoded_windows, decoded_timing = decode_confirmed_phrase(
            samples, start, end, directory, spec, runtime, config, infer, gate)
        if len(text.encode("utf-8")) + sum(p["text_bytes"] for p in cache.phrases) > MAX_JSON_BYTES:
            raise ValueError("Dictation stream text is too large")
        phrase = {"start_sample": start, "end_sample": end,
                  "pcm_sha256": hashlib.sha256(samples[start:end].tobytes()).hexdigest(),
                  "boundary": "stop" if boundary["vad_speech_end_sample"] is None else "silence",
                  "vad_speech_end_sample": boundary["vad_speech_end_sample"],
                  "confirmed_silence_samples": boundary["confirmed_silence_samples"],
                  "padding_samples": end - boundary["vad_speech_end_sample"] if boundary["vad_speech_end_sample"] is not None else 0,
                  "normalization_guard_samples": len(samples) - end,
                  "vad_frame_samples": 512,
                  "text": text, "text_bytes": len(text.encode("utf-8"))}
        cache.phrases.append(phrase)
        cache.confirmed_samples = end
        windows.extend(decoded_windows)
        for key in ("gate_seconds", "inference_seconds"):
            timings[key] += decoded_timing[key]
    return {"text": " ".join(p["text"] for p in cache.phrases if p["text"]), "windows": windows,
            "cache_hit_count": cache_hits, "live_delivery": "confirmed_phrases",
            "confirmed_phrase_count": len(cache.phrases), "live_endpoint_available": not cache.endpoint_failed,
            "confirmed_samples": cache.confirmed_samples, "audio_sample_count": len(samples),
            "confirmed_ranges": [{k: v for k, v in p.items() if k not in ("text", "text_bytes")} for p in cache.phrases],
            "timing": timings}


def run(config_path: Path, request_path: Path, *, infer=None, gate=None, prepared=None, cache=None, endpoint=None):
    result = None
    try:
        result = _run(config_path, request_path, infer=infer, gate=gate, prepared=prepared, cache=cache, endpoint=endpoint)
        return result
    finally:
        if cache is not None and (result is None or result.get("stream", {}).get("final", True)):
            cache.clear()


def _run(config_path: Path, request_path: Path, *, infer=None, gate=None, prepared=None, cache=None, endpoint=None):
    started = time.monotonic()
    config = prepared[0] if prepared is not None else read_json(config_path)
    plain_path(request_path)
    request = read_json(request_path)
    if type(request.get("version")) is not int or request["version"] != 1:
        raise ValueError("Unsupported dictation request version")
    request_id = canonical_id(request["request_id"])
    stream = stream_descriptor(request)
    live = stream is not None and stream.get("live", False)
    model = request.get("model", "trelis")
    language = request.get("language_mode", "hinglish")
    source = plain_path(Path(request["audio_path"]))
    if source.parent != request_path.parent or source.suffix.lower() != ".wav":
        raise ValueError("Dictation audio must belong to this temporary request")
    if dictation_backend(config) == "faster_whisper":
        with offline():
            phase_started = time.monotonic()
            samples, duration = normalized_audio(source)
            normalization_seconds = time.monotonic() - phase_started
            backend = infer if prepared is not None else faster_whisper_backend(config)
            if cache is not None:
                if cache.backend is not backend:
                    cache.clear()
                    cache.backend = backend
            result = backend.transcribe(samples, stream, language)
            result["timing"]["normalization_seconds"] = normalization_seconds
            result.update(version=1, request_id=request_id, status="ok", model=backend.settings["model_id"],
                          dictation_backend="faster_whisper", language_mode=language,
                          audio_seconds=duration, elapsed_seconds=time.monotonic() - started)
            if stream is not None:
                result["stream"] = stream
            return result
    if prepared is not None:
        if model != "trelis" or language != "hinglish":
            raise ValueError("Warm dictation requires the configured Trelis Hinglish model")
        spec, runtime = copy.deepcopy(prepared[1:])
    else:
        spec, runtime = model_configuration(config, model, language)
    timings = {"normalization_seconds": 0.0, "adapter_import_seconds": 0.0,
               "gate_seconds": 0.0, "inference_seconds": 0.0}
    with offline():
        phase_started = time.monotonic()
        samples, duration = normalized_audio(source)
        timings["normalization_seconds"] = time.monotonic() - phase_started
        if infer is None or gate is None:
            phase_started = time.monotonic()
            actual_infer, actual_gate = runtime_adapters(config)
            infer = infer or actual_infer
            gate = gate or actual_gate
            timings["adapter_import_seconds"] = time.monotonic() - phase_started
        if live:
            result = confirmed_live(samples, request_path.parent, stream, spec, runtime, config,
                                    infer, gate, cache, endpoint)
            result["timing"].update(normalization_seconds=timings["normalization_seconds"],
                                    adapter_import_seconds=timings["adapter_import_seconds"])
            result.update(version=1, request_id=request_id, status="ok", stream=stream,
                          model=model, language_mode=language, audio_seconds=duration,
                          elapsed_seconds=time.monotonic() - started)
            return result
        pieces, windows = [], []
        cache_hits = 0
        window_samples = WINDOW_SECONDS * 16000
        complete_samples = len(samples) // window_samples * window_samples
        complete_only = stream is not None and not stream["final"] and not live
        sample_limit = complete_samples if complete_only else len(samples)
        if cache is not None:
            cache.configure(stream, spec, runtime, config.get("speech_gate"), infer, gate, complete_samples)

        def remember(offset, digest, text, window, complete):
            if text:
                pieces.append(text)
            if stream is not None:
                window["reused"] = False
                window["complete"] = complete
                if cache is not None and (complete or live):
                    cache.remember(offset, digest, text, window, complete)
            windows.append(window)

        temporary = request_path.parent / "dictation-window.wav"
        plain_path(temporary, missing=True)
        if temporary.exists():
            raise ValueError("Dictation scratch audio already exists")
        try:
            for offset in range(0, sample_limit, window_samples):
                pcm = samples[offset:offset + window_samples]
                raw = pcm.tobytes()
                complete = len(pcm) == window_samples
                digest = hashlib.sha256(raw).digest() if stream is not None and (complete or live) else None
                cached = None
                if cache is not None and stream is not None:
                    cached = cache.windows.get(offset) if complete else cache.partial if live else None
                if cached is not None and cached["offset"] != offset:
                    cached = None
                if cached is not None and cached["digest"] == digest:
                    # Hash the exact normalized PCM, including resampling tails;
                    # a prefix at a different FIR boundary must be recomputed.
                    if cached["text"]:
                        pieces.append(cached["text"])
                    window = {"start_seconds": offset / 16000, "state": cached["state"], "reused": True, "complete": complete,
                              "gate_seconds": 0.0, "inference_seconds": 0.0, "runtime_timing": {}}
                    if cached["gate_available"] is not None:
                        window["gate_available"] = cached["gate_available"]
                    windows.append(window)
                    cache_hits += 1
                    continue
                # Exact digital silence cannot contain speech. Quiet nonzero
                # speech still goes through the existing conservative VAD gate.
                if not pcm.any():
                    remember(offset, digest, "", {"start_seconds": offset / 16000, "state": "silence"}, complete)
                    continue
                plain_path(temporary, missing=True)
                with temporary.open("xb") as target, wave.open(target, "wb") as wav:
                    wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(raw)
                phase_started = time.monotonic()
                decision = gate(temporary, config.get("speech_gate"))
                gate_seconds = time.monotonic() - phase_started
                timings["gate_seconds"] += gate_seconds
                if decision.get("status") == "ok" and decision.get("skip_stt") is True:
                    remember(offset, digest, "", {"start_seconds": offset / 16000, "state": "no_speech",
                             "gate_seconds": gate_seconds, "gate_available": True}, complete)
                    temporary.unlink()
                    continue
                phase_started = time.monotonic()
                result = infer(spec, temporary, runtime)
                inference_seconds = time.monotonic() - phase_started
                timings["inference_seconds"] += inference_seconds
                if result.get("status") != "ok":
                    error = result.get("error") or {}
                    raise RuntimeError(f"Local dictation failed: {error.get('message', error.get('code', 'unknown model error'))}")
                text = result.get("text")
                if not isinstance(text, str):
                    raise ValueError("Local dictation returned invalid text")
                remember(offset, digest, text.strip(), {
                    "start_seconds": offset / 16000, "state": "transcribed",
                    "gate_available": decision.get("status") == "ok", "gate_seconds": gate_seconds,
                    "inference_seconds": inference_seconds, "runtime_timing": numeric_timings(result),
                    "model_reused": result.get("provenance", {}).get("model_reused") is True}, complete)
                temporary.unlink()
        finally:
            temporary.unlink(missing_ok=True)
    result = {"version": 1, "request_id": request_id, "status": "ok",
              "text": "" if complete_only else " ".join(pieces),
              "model": model, "language_mode": language, "audio_seconds": duration,
              "elapsed_seconds": time.monotonic() - started, "timing": timings, "windows": windows}
    if stream is not None:
        result.update(stream=stream, cache_hit_count=cache_hits)
    return result


def serve(config_path: Path, stream=None, *, infer=None, gate=None, warmup=None):
    """One warm model and bounded serial requests, owned by the native parent."""
    plain_path(config_path)
    root = config_path.parent
    if config_path.name != "runtime.json":
        raise ValueError("Warm dictation requires runtime.json in its temporary root")
    try:
        with offline(), contextlib.redirect_stdout(sys.stderr):
            config = read_json(config_path)
            ready, infer, gate, prepared = warm_runtime(config, infer=infer, gate=gate, warmup=warmup)
    except Exception as error:
        ready = {"version": 1, "status": "failed", "error": str(error)[:2000]}
    publish_json(root / "ready.json", ready)
    if ready["status"] == "failed":
        return 1
    stream = stream if stream is not None else sys.stdin.buffer
    cache = StreamCache()
    try:
        return serve_requests(config_path, root, stream, infer, gate, prepared, cache)
    finally:
        cache.clear()


def serve_requests(config_path, root, stream, infer, gate, prepared, cache):
    seen = set()
    while True:
        line = stream.readline(MAX_PROTOCOL_BYTES + 1)
        if not line:
            return 0
        if len(line) > MAX_PROTOCOL_BYTES or not line.endswith(b"\n"):
            raise ValueError("Dictation command exceeds its bounded line protocol")
        command = parse_json(line.decode("utf-8"))
        if (set(command) != {"version", "action", "request_id"}
                or type(command["version"]) is not int or command["version"] != 1
                or command["action"] != "transcribe"):
            raise ValueError("Unsupported dictation command")
        request_id = canonical_id(command["request_id"])
        if request_id in seen or len(seen) >= MAX_WORKER_REQUESTS:
            raise ValueError("Duplicate dictation request or worker request limit reached")
        seen.add(request_id)
        directory = plain_path(root / request_id)
        if not directory.is_dir():
            raise ValueError("Dictation request directory is unavailable")
        output = plain_path(directory / "result.json", missing=True)
        if output.exists():
            raise ValueError("Dictation result already exists")
        request = result = request_stream = None
        try:
            request = read_json(directory / "request.json")
            if request.get("request_id") != request_id:
                raise ValueError("Dictation request identity does not match its command")
            request_stream = stream_descriptor(request)
            with offline(), contextlib.redirect_stdout(sys.stderr):
                result = run(config_path, directory / "request.json", infer=infer, gate=gate, prepared=prepared, cache=cache)
            publish_json(output, result)
        except Exception as error:
            cache.clear()
            result = {"version": 1, "request_id": request_id, "status": "failed", "text": "",
                      "error": str(error)[:2000]}
            if request_stream is not None:
                result.update(stream=request_stream, cache_hit_count=0)
                if request_stream.get("live", False):
                    if dictation_backend(prepared[0]) == "faster_whisper":
                        result.update(live_delivery="stable_words", confirmed_word_count=0, draft_text="",
                                      confirmed_samples=0, audio_sample_count=0, alignment_available=False)
                    else:
                        result.update(live_delivery="confirmed_phrases", confirmed_phrase_count=0,
                                      live_endpoint_available=False, confirmed_samples=0,
                                      audio_sample_count=0, confirmed_ranges=[])
            publish_json(output, result)
        finally:
            # Only the bounded active-stream cache may retain unfinished text.
            del request, result, request_stream


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--request", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    if args.serve:
        if args.request is not None or args.output is not None:
            parser.error("--serve does not accept --request or --output")
        stop = start_parent_watchdog()
        try:
            # Keep the guard active while idle too: imported libraries may
            # retain background threads after load/compile has completed.
            with offline():
                return serve(args.config)
        finally:
            stop.set()
    if args.request is None or args.output is None:
        parser.error("one-shot dictation requires --request and --output")
    root = plain_path(args.request).parent
    output = plain_path(args.output, missing=True)
    if output.parent != root or output.name != "result.json":
        raise ValueError("Dictation result must stay inside this temporary request")
    stop = None
    try:
        stop = start_parent_watchdog()
        result = run(args.config, args.request)
    except Exception as error:
        result = {"version": 1, "status": "failed", "text": "", "error": str(error)}
    finally:
        if stop is not None:
            stop.set()
    publish_json(output, result)
    print(json.dumps({"status": result["status"]}), flush=True)
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
