"""Conservative whole-window Silero presence gate; recognition audio is unchanged.

The gain pass is analysis-only. Any weak speech evidence, invalid configuration,
missing model or classifier failure keeps the complete original window.
"""
from __future__ import annotations

from functools import lru_cache
import hashlib
import math
from pathlib import Path
import time
import wave


# At 16 kHz, modern Silero consumes 512 new samples plus 64 context samples.
# Legacy snapshots retain their h/c interface and also use 32 ms frames.
FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64


@lru_cache(maxsize=2)
def _load_session(path: str, expected_sha256: str, modified_ns: int, size: int):
    # stat fields invalidate a cached handle if its model file changes in place.
    actual = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if actual != expected_sha256:
        raise ValueError('Silero model digest does not match runtime configuration')
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(path, sess_options=options, providers=['CPUExecutionProvider'])
    names = {item.name for item in session.get_inputs()}
    if {'input', 'sr', 'h', 'c'} <= names:
        interface = 'h_c_512'
    elif {'input', 'sr', 'state'} <= names:
        interface = 'state_512'
    else:
        raise ValueError('Unsupported Silero ONNX interface')
    return session, interface, actual


def _probabilities(session, samples, gain: float, interface: str):
    import numpy as np
    if interface not in ('h_c_512', 'state_512'):
        raise ValueError('Unsupported Silero ONNX interface')
    values = np.clip(samples * gain, -1, 1).astype(np.float32)
    frame_samples = FRAME_SAMPLES
    h = np.zeros((2, 1, 64), dtype=np.float32)
    c = np.zeros_like(h)
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, CONTEXT_SAMPLES), dtype=np.float32)
    probabilities = []
    for offset in range(0, len(values), frame_samples):
        frame = values[offset:offset + frame_samples]
        if len(frame) < frame_samples:
            frame = np.pad(frame, (0, frame_samples - len(frame)))
        inputs = {'input': frame[None, :], 'sr': np.array(16000, dtype=np.int64)}
        if interface == 'h_c_512':
            inputs.update(h=h, c=c)
            probability, h, c = session.run(None, inputs)
        else:
            inputs.update(input=np.concatenate((context, frame[None, :]), axis=1), state=state)
            probability, state = session.run(None, inputs)
            if np.asarray(state).shape != (2, 1, 128) or not np.isfinite(state).all():
                raise ValueError('Silero returned invalid recurrent state')
            context = frame[None, -CONTEXT_SAMPLES:].copy()
        value = float(np.asarray(probability).reshape(-1)[0])
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError('Silero returned an invalid speech probability')
        probabilities.append(value)
    if not probabilities:
        raise ValueError('Silero input contains no samples')
    return probabilities


def assess_window(path: Path, config: dict | None) -> dict:
    """Return a serializable decision; exceptions always retain original audio."""
    began = time.perf_counter()
    report = {'classifier': 'silero_onnx', 'status': 'unavailable', 'skip_stt': False,
              'audio_for_stt_is_unchanged': True, 'decision': 'keep'}
    try:
        if not isinstance(config, dict):
            raise ValueError('Silero runtime configuration is missing')
        model = Path(config['model_path']).resolve(strict=True)
        expected = config['model_sha256']
        if not isinstance(expected, str) or len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected):
            raise ValueError('Invalid Silero model SHA256')
        threshold = float(config.get('threshold', .15))
        boost_peak = float(config.get('boost_peak', .25))
        max_gain = float(config.get('max_gain', 1000))
        if not all(math.isfinite(v) for v in (threshold, boost_peak, max_gain)) or not (
                0 < threshold <= .15 and 0 < boost_peak <= 1 and 1 <= max_gain <= 1000):
            raise ValueError('Invalid conservative Silero gate configuration')
        report.update(model_sha256=expected, threshold=threshold, boost_peak=boost_peak, max_gain=max_gain)
        if config.get('model_version') is not None:
            report['model_version'] = config['model_version']
        info = model.stat()
        session, interface, actual = _load_session(str(model), expected, info.st_mtime_ns, info.st_size)
        if config.get('model_version') == '6.2.3' and interface != 'state_512':
            raise ValueError('Silero 6.2.3 requires its modern state/context interface')
        import numpy as np
        with wave.open(str(path), 'rb') as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise ValueError('Silero gate requires mono 16-bit 16kHz WAV')
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
        peak = float(np.max(np.abs(samples))) if len(samples) else 0
        gain = min(max_gain, max(1., boost_peak / max(peak, 1e-12)))
        raw = _probabilities(session, samples, 1., interface)
        # Unity gain produces the same samples and starts from the same reset
        # recurrent state. Reuse the complete pass without losing diagnostics.
        boosted = raw if gain == 1. else _probabilities(session, samples, gain, interface)
        skip = max(raw) < threshold and max(boosted) < threshold
        frame_samples = FRAME_SAMPLES
        combined = np.maximum(raw, boosted)
        report.update(status='ok', skip_stt=bool(skip), decision='skip' if skip else 'keep',
                      model_sha256=actual, interface=interface, frame_samples=frame_samples,
                      context_samples=CONTEXT_SAMPLES if interface == 'state_512' else 0,
                      duration_seconds=len(samples) / 16000, frame_count=len(raw), analysis_gain=gain,
                      raw_max_probability=max(raw), boosted_max_probability=max(boosted),
                      raw_mean_probability=float(np.mean(raw)), boosted_mean_probability=float(np.mean(boosted)),
                      speech_evidence_seconds=min(len(samples) / 16000,
                                                 float(np.sum(combined >= threshold)) * frame_samples / 16000))
    except Exception as exc:
        report.update(status='unavailable', skip_stt=False, decision='keep',
                      warning='speech_gate_unavailable', error=str(exc))
    report['elapsed_seconds'] = time.perf_counter() - began
    return report
