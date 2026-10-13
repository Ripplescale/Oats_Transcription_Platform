"""Plan or prune old generated metadata revisions; never prune user note history.

Dry run: --data-root PATH --report plan.json
Apply, with oats and its workers closed: --data-root PATH --apply-plan plan.json
    --report result.json

The apply operation accepts only an unchanged plan made by this program. Every
bucket and retained revision is checked before the first individual deletion.
Original recordings, transcripts, corrections and user revisions are outside
the deletion allowlist. This tool uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid


KEEP = 3
BUCKETS = ("job-metadata", "speaker-metadata")
VALID_ID = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")
REVISION = re.compile(r"revision-([0-9]{12})\.json\Z")
REPARSE_POINT = 0x400


class UnsafeCleanup(ValueError):
    """The input cannot be safely interpreted or no longer matches its plan."""


class PartialCleanup(OSError):
    def __init__(self, report: dict, reason: Exception):
        super().__init__(str(reason))
        self.report = report


def _identity(info: os.stat_result) -> dict:
    return {"device": info.st_dev, "inode": info.st_ino}


def _no_links(path: Path, *, directory: bool | None = None) -> os.stat_result:
    """lstat every existing component; resolve() alone would conceal links."""
    absolute = Path(os.path.abspath(path))
    for component in (*reversed(absolute.parents), absolute):
        try:
            info = component.lstat()
        except OSError as exc:
            raise UnsafeCleanup(f"Cannot inspect {component}: {exc}") from exc
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT:
            raise UnsafeCleanup(f"Link or reparse component is not allowed: {component}")
    if directory is True and not stat.S_ISDIR(info.st_mode):
        raise UnsafeCleanup(f"Expected a directory: {absolute}")
    if directory is False and not stat.S_ISREG(info.st_mode):
        raise UnsafeCleanup(f"Expected a regular file: {absolute}")
    return info


def _read(path: Path) -> tuple[bytes, dict]:
    before = _no_links(path, directory=False)
    # O_NOFOLLOW additionally closes the final-component link race on Unix.
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if _identity(opened) != _identity(before):
            raise UnsafeCleanup(f"File changed while opening: {path}")
        data = stream.read()
        finished = os.fstat(stream.fileno())
    after = _no_links(path, directory=False)
    if (_identity(after) != _identity(before) or before.st_size != len(data)
            or before.st_mtime_ns != after.st_mtime_ns
            or opened.st_mtime_ns != finished.st_mtime_ns
            or opened.st_size != finished.st_size):
        raise UnsafeCleanup(f"File changed while reading: {path}")
    return data, {**_identity(after), "bytes": len(data),
                  "sha256": hashlib.sha256(data).hexdigest()}


def _json_object(data: bytes, path: Path) -> dict:
    def unique_keys(pairs: list[tuple[str, object]]) -> dict:
        result = {}
        for key, value in pairs:
            if key in result:
                raise UnsafeCleanup(f"Duplicate JSON key in {path}: {key}")
            result[key] = value
        return result

    def invalid_constant(value: str) -> None:
        raise UnsafeCleanup(f"Invalid JSON constant in {path}: {value}")

    try:
        value = json.loads(data, object_pairs_hook=unique_keys, parse_constant=invalid_constant)
    except (ValueError, UnicodeError) as exc:
        raise UnsafeCleanup(f"Invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise UnsafeCleanup(f"Expected a JSON object: {path}")
    return value


def _listing(path: Path) -> list[dict]:
    _no_links(path, directory=True)
    entries = []
    for child in sorted(path.iterdir(), key=lambda p: p.name):
        info = _no_links(child)
        if stat.S_ISDIR(info.st_mode):
            kind = "directory"
        elif stat.S_ISREG(info.st_mode):
            kind = "file"
        else:
            raise UnsafeCleanup(f"Unsupported filesystem entry: {child}")
        entries.append({"name": child.name, "kind": kind, **_identity(info)})
    return entries


def _bucket(root: Path, path: Path) -> dict:
    identity = _identity(_no_links(path, directory=True))
    listing = _listing(path)
    revisions = []
    other_files = []
    for entry in listing:
        name = entry["name"]
        match = REVISION.fullmatch(name)
        if entry["kind"] != "file":
            raise UnsafeCleanup(f"Unexpected directory inside metadata bucket: {path / name}")
        data, fingerprint = _read(path / name)
        item = {"path": (path / name).relative_to(root).as_posix(), **fingerprint}
        if match:
            number = int(match[1])
            value = _json_object(data, path / name)
            if number < 1 or type(value.get("revision")) is not int or value["revision"] != number:
                raise UnsafeCleanup(f"Revision field disagrees with filename: {path / name}")
            revisions.append({**item, "revision": number})
        elif name.startswith("revision-"):
            raise UnsafeCleanup(f"Unrecognized revision filename: {path / name}")
        else:
            # Incomplete writes and unrelated files are preserved and bound to
            # the plan, so a changed/new file aborts application as well.
            other_files.append(item)
    revisions.sort(key=lambda entry: entry["revision"])
    if _listing(path) != listing or _identity(_no_links(path, directory=True)) != identity:
        raise UnsafeCleanup(f"Metadata bucket changed while planning: {path}")
    return {"path": path.relative_to(root).as_posix(), "identity": identity,
            "listing": listing, "remove": revisions[:-KEEP],
            "retain": revisions[-KEEP:], "other_files": other_files}


def make_plan(data_root: Path | str) -> dict:
    root = Path(os.path.abspath(data_root))
    root_identity = _identity(_no_links(root, directory=True))
    workspace = root / "workspaces"
    listing = _listing(workspace)
    buckets = []
    workspace_layout = []
    for entry in listing:
        if entry["kind"] != "directory" or not VALID_ID.fullmatch(entry["name"]):
            raise UnsafeCleanup(f"Unexpected workspace entry: {entry['name']}")
        note = workspace / entry["name"]
        children = _listing(note)
        # No note content is opened. The layout detects a new or replaced
        # generated metadata directory between planning and application.
        workspace_layout.append({"path": note.relative_to(root).as_posix(), "listing": children})
        names = {child["name"]: child for child in children}
        for name in BUCKETS:
            if name in names:
                if names[name]["kind"] != "directory":
                    raise UnsafeCleanup(f"Expected a metadata directory: {note / name}")
                buckets.append(_bucket(root, note / name))
    if _listing(workspace) != listing or _identity(_no_links(root, directory=True)) != root_identity:
        raise UnsafeCleanup("Workspace changed while planning")
    return {"schema_version": 1, "policy": "generated-metadata-keep-latest-3",
            "data_root": str(root), "root_identity": root_identity,
            "workspace_identity": _identity(_no_links(workspace, directory=True)),
            "workspace_listing": listing, "workspace_layout": workspace_layout,
            "buckets": buckets}


def summarize(plan: dict) -> dict:
    removed = [item for bucket in plan["buckets"] for item in bucket["remove"]]
    retained = [item for bucket in plan["buckets"] for item in bucket["retain"]]
    return {"metadata_buckets": len(plan["buckets"]),
            "eligible_files": len(removed), "eligible_bytes": sum(item["bytes"] for item in removed),
            "retained_files": len(retained), "retained_bytes": sum(item["bytes"] for item in retained),
            "protected_current_metadata": [bucket["retain"][-1] for bucket in plan["buckets"] if bucket["retain"]]}


def _deletion_path(root: Path, item: dict) -> Path:
    relative = item.get("path", "")
    if not isinstance(relative, str) or "\\" in relative:
        raise UnsafeCleanup("Invalid deletion path")
    pieces = relative.split("/")
    if (len(pieces) != 4 or pieces[0] != "workspaces"
            or not VALID_ID.fullmatch(pieces[1]) or pieces[2] not in BUCKETS
            or not REVISION.fullmatch(pieces[3])):
        raise UnsafeCleanup(f"Deletion path is outside the generated-history allowlist: {relative}")
    path = root.joinpath(*pieces)
    if not path.is_relative_to(root):
        raise UnsafeCleanup(f"Deletion path escaped data root: {path}")
    _no_links(path, directory=False)
    return path


def apply_plan(data_root: Path | str, supplied_plan: dict) -> dict:
    # Recompute every hash and listing, including retained/current metadata,
    # before deleting anything. The supplied plan is untrusted input.
    current = make_plan(data_root)
    if current != supplied_plan:
        raise UnsafeCleanup("Data or cleanup plan changed; no files were deleted. Create a fresh dry-run plan.")
    root = Path(current["data_root"])
    removals = [(item, _deletion_path(root, item))
                for bucket in current["buckets"] for item in bucket["remove"]]
    report = {"schema_version": 1, "mode": "apply", "status": "complete",
              "data_root": str(root), "removed_files": 0, "removed_bytes": 0,
              "removed": [], "protected_current_metadata": summarize(current)["protected_current_metadata"]}
    try:
        for item, path in removals:
            # The app and workers must remain closed throughout application.
            # Recheck this file immediately before deleting it, too.
            _, actual = _read(_deletion_path(root, item))
            if actual != {key: item[key] for key in actual}:
                raise UnsafeCleanup(f"File changed during cleanup: {path}")
            path.unlink()
            report["removed"].append(item)
            report["removed_files"] += 1
            report["removed_bytes"] += item["bytes"]
        # Verify the protected current snapshots are still the same files.
        for item in report["protected_current_metadata"]:
            _, actual = _read(_deletion_path(root, item))
            if actual != {key: item[key] for key in actual}:
                raise UnsafeCleanup("Protected metadata changed during cleanup")
    except (OSError, UnsafeCleanup) as exc:
        report["status"] = "partial" if report["removed_files"] else "aborted"
        report["error"] = str(exc)
        raise PartialCleanup(report, exc) from exc
    return report


def _write_report(path: Path, value: dict, root: Path) -> None:
    path = Path(os.path.abspath(path))
    if path.is_relative_to(root):
        raise UnsafeCleanup("Write reports outside the protected app data directory")
    _no_links(path.parent, directory=True)
    if path.exists() or path.is_symlink():
        _no_links(path, directory=False)
    temporary = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--apply-plan", type=Path)
    args = parser.parse_args(argv)
    root = Path(os.path.abspath(args.data_root))
    report_started = False
    try:
        # Validate the output before any cleanup, including writability.
        initial = {"schema_version": 1, "status": "preflight", "removed_files": 0, "removed_bytes": 0}
        if args.apply_plan and os.path.abspath(args.apply_plan) == os.path.abspath(args.report):
            raise UnsafeCleanup("Keep the original plan and result report in different files")
        _write_report(args.report, initial, root)
        report_started = True
        if args.apply_plan:
            raw, _ = _read(args.apply_plan)
            supplied = _json_object(raw, args.apply_plan)
            report = apply_plan(root, supplied.get("plan"))
        else:
            plan = make_plan(root)
            report = {"schema_version": 1, "mode": "dry-run", "plan": plan, "summary": summarize(plan)}
        _write_report(args.report, report, root)
        public = report["summary"] if "summary" in report else report
        print(json.dumps({key: value for key, value in public.items()
                          if key not in {"removed", "protected_current_metadata"}}))
        return 0
    except PartialCleanup as exc:
        _write_report(args.report, exc.report, root)
        print(str(exc), file=sys.stderr)
        return 2
    except (OSError, UnsafeCleanup) as exc:
        if report_started:
            _write_report(args.report, {"schema_version": 1, "status": "aborted", "error": str(exc),
                                        "removed_files": 0, "removed_bytes": 0}, root)
        print(f"Cleanup refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
