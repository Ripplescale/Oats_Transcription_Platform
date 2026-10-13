"""Manifest validation and reproducible run identities; never opens network URLs."""
from __future__ import annotations

import hashlib
import json
import time
import wave
from pathlib import Path
from typing import Any


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def file_digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def input_manifest_digest(document: dict) -> str:
    """Keep input/split identity fixed while allowing later human annotation."""
    unannotated = dict(document)
    unannotated["samples"] = [
        {key: value for key, value in sample.items()
         if key not in ("reference", "reference_status", "entities")}
        for sample in document["samples"]
    ]
    return digest(unannotated)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"),
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Invalid number: {value}")))


def write_json(path: Path, value: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    formatting = {'indent': None, 'separators': (',', ':')} if compact else {'indent': 2}
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, **formatting) + "\n", encoding="utf-8")
    # Windows readers and antivirus may briefly deny replacement even after
    # the writer has closed its file. Keep the old complete JSON until replace
    # succeeds; never fall back to truncating it in place.
    for attempt in range(12):
        try:
            temporary.replace(path)
            break
        except PermissionError:
            if attempt == 11:
                raise
            time.sleep(min(0.05 * (2 ** attempt), 0.5))


def audio_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as audio:
            if audio.getframerate() <= 0 or audio.getnframes() <= 0:
                raise ValueError(f"Empty WAV: {path}")
            return audio.getnframes() / audio.getframerate()
    except (wave.Error, EOFError) as exc:
        raise ValueError(f"Expected readable PCM WAV at {path}: {exc}") from exc


def load_manifest(path: Path, check_audio: bool = True) -> dict:
    path = path.resolve()
    document = read_json(path)
    if not isinstance(document, dict) or document.get("version") != 1:
        raise ValueError("Manifest must be an object with version=1")
    samples = document.get("samples")
    if not isinstance(samples, list) or not samples:
        raise ValueError("Manifest samples must be a non-empty list")
    views = document.get("required_views", ["roman"])
    if not isinstance(document.get("require_disjoint_speakers", False), bool):
        raise ValueError("require_disjoint_speakers must be a boolean")
    if not isinstance(views, list) or not views or len(set(views)) != len(views) or any(v not in ("original", "roman") for v in views):
        raise ValueError("required_views must contain original and/or roman, without duplicates")
    ids: set[str] = set()
    identities: dict[tuple[str, str], str] = {}
    audio_hashes: dict[str, str] = {}
    enriched = []
    warnings: list[str] = []
    for sample in samples:
        if not isinstance(sample, dict):
            raise ValueError("Each sample must be an object")
        sample_id = sample.get("id")
        if not isinstance(sample_id, str) or not sample_id.strip() or sample_id in ids:
            raise ValueError(f"Missing or duplicate sample id: {sample_id!r}")
        ids.add(sample_id)
        split = sample.get("split")
        if split not in ("dev", "test"):
            raise ValueError(f"{sample_id}: split must be dev or test")
        reference = sample.get("reference", {})
        if not isinstance(reference, dict) or any(not isinstance(reference[v], str) for v in ("original", "roman") if v in reference):
            raise ValueError(f"{sample_id}: references must be strings when supplied (empty allowed for silence)")
        if "original" not in reference:
            warnings.append(f"{sample_id}: no original reference; WER cannot be measured yet")
        if sample.get("reference_status", "pending") not in ("pending", "reviewed"):
            raise ValueError(f"{sample_id}: reference_status must be pending or reviewed")
        if "roman" not in reference:
            warnings.append(f"{sample_id}: no Roman reference; Roman scoring will remain incomplete")
        if not isinstance(sample.get("license"), str) or not sample["license"].strip():
            raise ValueError(f"{sample_id}: provide a license or explicit private-recording permission statement")
        call_id = sample.get("call_id")
        if call_id is not None and (not isinstance(call_id, str) or not call_id.strip()):
            raise ValueError(f"{sample_id}: call_id must be a non-empty string")
        speakers = sample.get("speaker_ids", [])
        if not isinstance(speakers, list) or any(not isinstance(s, str) or not s.strip() for s in speakers):
            raise ValueError(f"{sample_id}: speaker_ids must be a list of non-empty strings")
        if len(set(speakers)) != len(speakers):
            raise ValueError(f"{sample_id}: repeated speaker_ids")
        for kind, identity in ([('call', call_id)] if call_id else []) + [('speaker', s) for s in speakers]:
            key = (kind, identity)
            if key in identities and identities[key] != split:
                if kind == "call" or document.get("require_disjoint_speakers", False):
                    raise ValueError(f"Dev/test leakage: {kind} {identity!r} occurs in both splits")
                warnings.append(f"Speaker {identity!r} occurs in both splits; these calls do not establish unseen-speaker generalization")
            identities[key] = split
        entities = sample.get("entities", [])
        if not isinstance(entities, list):
            raise ValueError(f"{sample_id}: entities must be a list")
        for entity in entities:
            if (not isinstance(entity, dict) or entity.get("kind") not in ("name", "number")
                    or not isinstance(entity.get("text"), str) or not entity["text"].strip()):
                raise ValueError(f"{sample_id}: entities require kind=name|number and non-empty text")
            aliases = entity.get("aliases", [])
            if not isinstance(aliases, list) or any(not isinstance(a, str) or not a.strip() for a in aliases):
                raise ValueError(f"{sample_id}: entity aliases must be non-empty strings")
        slices = sample.get("slices", {})
        if not isinstance(slices, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in slices.items()):
            raise ValueError(f"{sample_id}: slices must map strings to strings")
        audio = sample.get("audio")
        if not isinstance(audio, str) or not audio.strip() or "://" in audio:
            raise ValueError(f"{sample_id}: audio must be a local WAV path")
        audio_path = (path.parent / audio).resolve()
        declared_hash = sample.get("audio_sha256")
        if declared_hash is not None and (not isinstance(declared_hash, str) or len(declared_hash) != 64
                or any(character not in "0123456789abcdefABCDEF" for character in declared_hash)):
            raise ValueError(f"{sample_id}: audio_sha256 must be a 64-character SHA256 hex digest")
        item = dict(sample, _audio_path=audio_path)
        if check_audio:
            if not audio_path.is_file() or audio_path.suffix.lower() != ".wav":
                raise ValueError(f"{sample_id}: missing WAV file: {audio_path}")
            item["_duration_seconds"] = audio_duration(audio_path)
            item["_audio_sha256"] = file_digest(audio_path)
            audio_hash = item["_audio_sha256"]
            if declared_hash is not None and declared_hash.lower() != audio_hash:
                raise ValueError(f"{sample_id}: audio_sha256 does not match the actual WAV bytes")
            if audio_hash in audio_hashes and audio_hashes[audio_hash] != split:
                raise ValueError(f"Dev/test leakage: identical audio bytes occur in both splits ({sample_id})")
            audio_hashes[audio_hash] = split
        enriched.append(item)
    if any(not s.get("call_id") or not s.get("speaker_ids") for s in samples):
        warnings.append("Some samples lack call or speaker identities; complete identity leakage checks were not possible")
    return {"document": document, "samples": enriched, "path": path,
            "manifest_sha256": digest(document), "input_manifest_sha256": input_manifest_digest(document),
            "required_views": views, "warnings": warnings}


def read_jsonl(path: Path, recover_final_line: bool = False) -> list[dict]:
    data = path.read_text(encoding="utf-8-sig")
    lines = data.splitlines(keepends=True)
    records = []
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            record = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Invalid number: {value}")))
            if not isinstance(record, dict):
                raise ValueError("JSONL records must be objects")
        except (json.JSONDecodeError, ValueError) as exc:
            if recover_final_line and index == len(lines) - 1 and not line.endswith("\n"):
                break
            raise ValueError(f"Invalid JSONL at {path}:{index + 1}: {exc}") from exc
        records.append(record)
    return records
