"""Build a GitHub-only, split offline setup from explicitly selected local assets.

Maintainer tool. Never walks the app data root or copies user data. The recipient
only needs the generated Oats-Setup.exe. Run tests before publishing a bundle.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tomllib
import zipfile

REPO = Path(__file__).resolve().parents[2]
MAX_PART = 1500 * 1024 * 1024
MAX_INSTALLER = 512 * 1024 * 1024
CPU_SHA = "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c"
APP_SHA = "15de3ba739bafe69a370f7d4a7e98458ca23716a07c7b5540915bf224bed4644"


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def safe_name(name):
    if not name or len(name) > 220 or "\\" in name:
        raise ValueError("Invalid package path: " + name)
    for part in name.split("/"):
        if (not part or part in (".", "..") or part.rstrip(" .") != part
                or re.search(r'[<>:"|?*\x00-\x1f]', part)
                or re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", part.split(".")[0], re.I)):
            raise ValueError("Unsafe package path: " + name)
    return name


def no_links(path):
    for item in (path, *path.parents):
        if item.exists() and (item.is_symlink() or getattr(item.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x400):
            raise ValueError("Linked package input is not supported: " + str(item))


@dataclass
class Source:
    path: Path | None = None
    data: bytes | None = None
    expected: str | None = None

    @property
    def size(self):
        return self.path.stat().st_size if self.path else len(self.data)

    def open(self):
        return self.path.open("rb") if self.path else io.BytesIO(self.data)


class Sources(dict):
    def __init__(self):
        super().__init__()
        self.names = set()

    def add(self, name, path=None, data=None, expected=None, checked_parent=False):
        safe_name(name)
        if name.lower() in self.names:
            raise ValueError("Duplicate package input: " + name)
        if path is not None:
            path = Path(path).absolute()
            if not checked_parent:
                no_links(path)
            metadata = path.stat(follow_symlinks=False)
            if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
                raise ValueError("Linked package input is not supported")
            if not path.is_file():
                raise ValueError("Package input is not a file")
        if (path is None) == (data is None):
            raise ValueError("Select one input type")
        self[name] = Source(path, data, expected)
        self.names.add(name.lower())

    def tree(self, root, prefix, *, skip=()):
        root = Path(root).absolute()
        no_links(root)
        for directory, directories, files in os.walk(root, followlinks=False):
            directories[:] = sorted(d for d in directories if d not in skip)
            for d in directories:
                item = (Path(directory) / d).stat(follow_symlinks=False)
                if stat.S_ISLNK(item.st_mode) or getattr(item, "st_file_attributes", 0) & 0x400:
                    raise ValueError("Linked package folder is not supported")
            for name in sorted(files):
                if name.endswith((".pyc", ".pyo")):
                    continue
                path = Path(directory) / name
                self.add(prefix + "/" + path.relative_to(root).as_posix(), path, checked_parent=True)


class SplitWriter(io.RawIOBase):
    """Nonseekable ZIP64 sink: bounded parts, no duplicate joined ZIP on disk."""
    def __init__(self, folder, identity, limit=MAX_PART):
        super().__init__()
        self.folder, self.identity, self.limit = Path(folder), identity, limit
        self.parts, self.position, self.stream, self.hasher, self.used = [], 0, None, None, 0

    def writable(self):
        return True

    def seekable(self):
        return False

    def tell(self):
        return self.position

    def finish_part(self):
        if self.stream is not None:
            self.stream.flush()
            os.fsync(self.stream.fileno())
            self.stream.close()
            self.parts[-1].update(size=self.used, sha256=self.hasher.hexdigest())
            self.stream = None

    def write(self, data):
        view = memoryview(data)
        length = len(view)
        while view:
            if self.stream is None:
                name = f"oats-runtime-{self.identity}.zip.part{len(self.parts) + 1:03}"
                self.stream = (self.folder / name).open("xb")
                self.hasher, self.used = hashlib.sha256(), 0
                self.parts.append({"name": name, "url": f"https://github.com/Ripplescale/Oats_Transcription_Platform/releases/download/setup-{self.identity}/{name}"})
            block = view[:self.limit - self.used]
            self.stream.write(block)
            self.hasher.update(block)
            self.used += len(block)
            self.position += len(block)
            view = view[len(block):]
            if self.used == self.limit:
                self.finish_part()
        return length

    def close(self):
        self.finish_part()
        super().close()


def scan_public_text(name, data):
    if not name.endswith((".json", ".pth", ".cfg", ".ini", ".xml", ".txt", ".md")):
        return
    # Wheels can include upstream compiler paths; prohibit this maintainer's
    # identity and account material, rather than corrupting third-party code.
    for marker in (b"Users\\74463", b"Users\\\\74463", b"Users/74463", b"OneDrive - Bain"):
        if marker in data:
            raise ValueError("Private build metadata in " + name)
    if re.search(rb"hf_[A-Za-z0-9]{25,}|gh[pousr]_[A-Za-z0-9]{25,}", data):
        raise ValueError("Possible credential in " + name)


def archive(sources, folder, identity, limit=MAX_PART):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    files = []
    with SplitWriter(folder, identity, limit) as sink:
        with zipfile.ZipFile(sink, "w", allowZip64=True, compression=zipfile.ZIP_DEFLATED, compresslevel=1) as zipped:
            for index, (name, source) in enumerate(sorted(sources.items())):
                sha = hashlib.sha256()
                info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
                info.file_size = source.size
                info._compresslevel = 1  # Python 3.12 ZipInfo does not inherit it.
                info.compress_type = zipfile.ZIP_STORED if PurePosixPath(name).suffix in (".safetensors", ".bin", ".exe") else zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                with source.open() as original:
                    with zipped.open(info, "w", force_zip64=True) as target:
                        while block := original.read(1024 * 1024):
                            scan_public_text(name, block)
                            sha.update(block)
                            target.write(block)
                if source.expected and sha.hexdigest() != source.expected:
                    raise ValueError("Source integrity mismatch: " + name)
                files.append({"path": name, "size": source.size, "sha256": sha.hexdigest()})
                if index % 1000 == 0:
                    print(json.dumps({"archived_files": index + 1, "total_files": len(sources), "written_bytes": sink.tell()}), flush=True)
            payload = encoded({"schema": 1, "files": files})
            zipped.writestr("payload-manifest.json", payload)
    manifest = {"schema": 1, "id": identity, "app_version": "0.8.8",
                "payload_manifest_sha256": hashlib.sha256(payload).hexdigest(),
                "installed_bytes": sum(f["size"] for f in files), "parts": sink.parts}
    (folder / "payload-manifest.json").write_bytes(payload)
    (folder / "bundle.json").write_bytes(encoded(manifest))
    return manifest


def collect(runtime, base, inputs):
    """Explicit component allowlist. Never recurse over the user's data root."""
    sources = Sources()
    print('Selecting private Python and installed dependencies', flush=True)
    base, inputs = Path(base), Path(inputs)
    for name in ("python.exe", "pythonw.exe", "python3.dll", "python312.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"):
        sources.add("python/" + name, base / name)
    for name in ("DLLs", "Lib", "tcl"):
        sources.tree(base / name, "python/" + name, skip=("site-packages", "__pycache__", "test", "tests", "idle_test"))
    site = Path(runtime["python_executable"]).parent.parent / "Lib/site-packages"
    # Preserve installed package license metadata. Strip only bytecode caches;
    # some packages import their own test utilities at runtime.
    sources.tree(site, "env/Lib/site-packages", skip=("__pycache__",))
    for name in list(sources):
        if not runtime_file(name):
            del sources[name]
    print(json.dumps({'selected_runtime_files': len(sources)}), flush=True)
    for name, source in list(sources.items()):
        if name.endswith("direct_url.json"):
            # Provenance for this runtime is the version inventory, not private
            # pip file:// install locations.
            del sources[name]
        elif name.endswith(".pth"):
            data = source.path.read_bytes()
            if re.search(rb"[A-Za-z]:[\\/]|file://|/Users/|/home/", data):
                raise ValueError("Nonportable Python path hook: " + name)
    code = "import json,importlib.metadata as m;print(json.dumps({d.metadata['Name']:d.version for d in m.distributions()}))"
    versions = json.loads(subprocess.check_output([runtime["python_executable"], "-I", "-B", "-c", code], text=True))
    sources.add("setup/packages.json", data=encoded(versions))
    registry = read(REPO / "stt_lab/models.json")
    trelis, apex = runtime["models"]["trelis"], runtime["models"]["apex"]
    original = Path(trelis["artifact_path"])
    manifest = read(original / "artifact-manifest.json")
    selected = next(m for m in registry["models"] if m["id"] == "trelis")
    if (manifest["repo_id"], manifest["source_revision"], manifest["license"]) != (selected["repo_id"], selected["source_revision"], "apache-2.0"):
        raise ValueError("Unexpected Trelis artifact identity")
    sources.add("models/trelis/source/artifact-manifest.json", original / "artifact-manifest.json")
    for entry in manifest["files"]:
        sources.add("models/trelis/source/" + safe_name(entry["path"]), original / entry["path"], expected=entry["sha256"])
    export = Path(trelis["export_path"])
    exported = read(export / "export-complete.json")
    receipt = read(export / "conversion-provenance.json")
    if digest(export / "export-complete.json") != receipt["export_manifest_sha256"]:
        raise ValueError("Export receipt differs")
    for name, entry in exported["files"].items():
        sources.add("models/trelis/openvino/" + safe_name(name), export / name, expected=entry["sha256"])
    exported["source"] = selected["repo_id"] + "@" + selected["source_revision"]
    sanitized_export = encoded(exported)
    receipt["export_manifest_sha256"] = hashlib.sha256(sanitized_export).hexdigest()
    sources.add("models/trelis/openvino/export-complete.json", data=sanitized_export)
    sources.add("models/trelis/openvino/conversion-provenance.json", data=encoded(receipt))
    binary = Path(apex["artifact_path"])
    provenance = read(str(binary) + ".provenance.json")
    public_provenance = {k: provenance[k] for k in ("source_repo_id", "source_revision", "source_sha256", "output_sha256")}
    public_provenance["converter"] = {k: provenance["converter"][k] for k in ("name", "revision", "sha256")}
    if "quantization" in provenance:
        # Retain public conversion metadata, never the original command paths.
        q = provenance["quantization"]
        public_provenance["quantization"] = {k: v for k, v in q.items() if k in ("type", "format", "revision", "sha256")} if isinstance(q, dict) else q
    sources.add("models/apex/model.bin", binary, expected=provenance["output_sha256"])
    sources.add("models/apex/model.bin.provenance.json", data=encoded(public_provenance))
    sources.add("models/silero/silero_vad.onnx", runtime["speech_gate"]["model_path"], expected=runtime["speech_gate"]["model_sha256"])
    sources.tree(REPO / "stt_lab/sttbench", "worker/sttbench", skip=("__pycache__",))
    sources.add("worker/models.json", REPO / "stt_lab/models.json")
    sources.add("worker/worker.py", data=b"import runpy\nrunpy.run_module('sttbench.local_worker', run_name='__main__')\n")
    if digest(inputs / "whisper-bin-x64.zip") != CPU_SHA:
        raise ValueError("Portable Apex archive differs from pinned official release")
    with zipfile.ZipFile(inputs / "whisper-bin-x64.zip") as zipped:
        for entry in zipped.infolist():
            if entry.is_dir():
                continue
            name = PurePosixPath(entry.filename).name
            if name.lower() == "whisper-cli.exe" or name.lower().endswith(".dll"):
                sources.add("tools/whisper-cpu/" + name, data=zipped.read(entry))
    if "tools/whisper-cpu/whisper-cli.exe" not in sources:
        raise ValueError("Portable Apex binary missing")
    sources.add("tools/whisper-cpu/LICENSE", inputs / "whisper-LICENSE")
    for name in ("vcruntime140.dll", "vcruntime140_1.dll"):
        if "tools/whisper-cpu/" + name not in sources:
            sources.add("tools/whisper-cpu/" + name, base / name)
    sources.add("tools/whisper-cpu/msvcp140.dll", inputs / "msvcp140.dll")
    sources.add("python/msvcp140.dll", inputs / "msvcp140.dll")
    # App, Microsoft runtime and licenses have an explicit acquisition/verification
    # step in prepare-inputs.ps1. Recheck their identity before archiving.
    if digest(inputs / "oats_0.8.8_x64-setup.exe") != APP_SHA:
        raise ValueError("Released oats installer differs")
    acquired = read(inputs / "verified-inputs.json")
    for name in ("WebView2.exe", "msvcp140.dll"):
        if digest(inputs / name) != acquired["files"][name]["sha256"]:
            raise ValueError("Verified redistributable changed: " + name)
    sources.add("setup/oats.exe", inputs / "oats_0.8.8_x64-setup.exe", expected=APP_SHA)
    sources.add("setup/oats.exe.sig", inputs / "oats_0.8.8_x64-setup.exe.sig")
    sources.add("setup/WebView2.exe", inputs / "WebView2.exe")
    sources.add("setup/configure.py", Path(__file__).with_name("configure.py"))
    sources.add("setup/verified-inputs.json", inputs / "verified-inputs.json")
    sources.add("setup/Apache-2.0.txt", inputs / "Apache-2.0.txt")
    sources.add("setup/Silero-LICENSE", inputs / "Silero-LICENSE")
    sources.add("setup/THIRD-PARTY.md", Path(__file__).with_name("THIRD-PARTY.md"))
    sources.add("setup/LICENSE.md", REPO / "LICENSE.md")
    sources.add("setup/Apex-model-card.md", inputs / "Apex-model-card.md")
    config = {"version": 1, "python_executable": "@PACKAGE@/env/Scripts/python.exe", "worker_script": "@PACKAGE@/worker/worker.py",
              "registry_path": "@PACKAGE@/worker/models.json", "worker_source_id": "bundled-0.8.8",
              "summaries_enabled": False, "network_inference": False, "models": {}}
    allowed = ("threads", "timestamps", "timeout_seconds", "backend", "dtype", "device", "num_beams", "max_new_tokens")
    for name, spec in (("trelis", trelis), ("apex", apex)):
        config["models"][name] = {k: spec[k] for k in allowed if k in spec}
    config["models"]["trelis"].update(artifact_path="@PACKAGE@/models/trelis/source", export_path="@PACKAGE@/models/trelis/openvino", cache_dir="@PACKAGE@/cache/openvino")
    config["models"]["apex"].update(artifact_path="@PACKAGE@/models/apex/model.bin", executable="@PACKAGE@/tools/whisper-cpu/whisper-cli.exe", work_dir="@PACKAGE@/cache/apex", device="cpu")
    config["speech_gate"] = {**runtime["speech_gate"], "model_path": "@PACKAGE@/models/silero/silero_vad.onnx"}
    sources.add("setup/runtime-template.json", data=encoded(config))
    return sources


def runtime_file(name):
    # Development-only material. Do not remove package runtime test utilities,
    # licenses or general modules merely because their names include 'test'.
    return not name.startswith(("env/Lib/site-packages/onnx/backend/test/data/",
                                "env/Lib/site-packages/torch/include/",
                                "env/Lib/site-packages/torch/share/cmake/"))


def embed_msvc(manifest, folder, inputs):
    verified = read(inputs / "verified-inputs.json")["files"]
    files = []
    path = folder / "msvc-runtime.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as zipped:
        for dll in sorted((inputs / "msvc").glob("*.dll")):
            sha = digest(dll)
            if verified["msvc/" + dll.name]["sha256"] != sha:
                raise ValueError("Microsoft redistributable changed: " + dll.name)
            for prefix in ("python/", "tools/whisper-cpu/"):
                name = prefix + safe_name(dll.name)
                zipped.write(dll, name)
                files.append({"path": name, "size": dll.stat().st_size, "sha256": sha})
        if len(files) < 20 or not any(f['path'] == 'python/msvcp140_1.dll' for f in files):
            raise ValueError("Complete Microsoft CRT redistributable is missing")
        payload = encoded({"schema": 1, "files": files})
        zipped.writestr("payload-manifest.json", payload)
    manifest.update(runtime_bytes=sum(f["size"] for f in files), runtime_manifest_sha256=hashlib.sha256(payload).hexdigest())
    (folder / "bundle.json").write_bytes(encoded(manifest))


def source_app_version():
    version = read(REPO / "frontend/package.json")["version"]
    with (REPO / "frontend/src-tauri/Cargo.toml").open("rb") as source:
        native = tomllib.load(source)["package"]["version"]
    if (not re.fullmatch(r"0\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version)
            or native != version or read(REPO / "frontend/src-tauri/tauri.conf.json")["version"] != version):
        raise ValueError("Source app versions must agree before building complete setup")
    return version


def verify_app_installer(installer, feed, public_key, node=None):
    """Use the normal updater's cryptographic and signed-version verifier."""
    installer, feed, public_key = (Path(p).resolve(strict=True) for p in (installer, feed, public_key))
    if not 3 <= installer.stat().st_size <= MAX_INSTALLER:
        raise ValueError("The signed app installer is empty or exceeds the 512 MiB limit")
    node = node or shutil.which("node")
    if not node:
        raise ValueError("Maintainers need Node to verify the signed app installer; pass --node")
    checked = subprocess.run([str(node), str(REPO / "scripts/windows-update-feed.cjs"), "verify",
                              str(feed), str(installer), str(public_key)], capture_output=True,
                             text=True, timeout=90)
    if checked.returncode:
        raise ValueError("The app installer failed updater signature verification: " + checked.stderr[-2000:])
    result = json.loads(checked.stdout)
    version = source_app_version()
    if result.get("version") != version:
        raise ValueError("The signed installer must match the current source app version " + version)
    if result.get("bytes") != installer.stat().st_size or result.get("sha256") != digest(installer):
        raise ValueError("The signed installer changed during verification")
    return {"version": version, "bytes": result["bytes"], "sha256": result["sha256"]}


def add_installer_arguments(parser):
    parser.add_argument("--app-installer", type=Path, required=True, help="Current signed Windows updater installer")
    parser.add_argument("--update-feed", type=Path, required=True, help="Matching signed-version latest.json")
    parser.add_argument("--public-key", type=Path, required=True, help="Trusted existing oats updater public key")
    parser.add_argument("--node", type=Path, help="Maintainer Node executable; recipients never need Node")


def compile_setup(manifest, folder, *, app_installer=None, update_feed=None, public_key=None, node=None, allow_fixture=False):
    folder = Path(folder)
    overlay = folder / ".build/app-installer.exe"
    if not allow_fixture:
        if app_installer is None or update_feed is None or public_key is None:
            raise ValueError("Building complete setup requires the current signed installer, matching feed and trusted public key")
        verified = verify_app_installer(app_installer, update_feed, public_key, node)
        # The archived app remains immutable and is never launched by Setup.
        manifest.setdefault("payload_app_version", manifest["app_version"])
        manifest.update(app_version=verified["version"], app_installer_bytes=verified["bytes"],
                        app_installer_sha256=verified["sha256"])
        overlay.parent.mkdir(exist_ok=True)
        with overlay.open("xb") as output, Path(app_installer).open("rb") as source:
            shutil.copyfileobj(source, output, 1024 * 1024)
        if overlay.stat().st_size != verified["bytes"] or digest(overlay) != verified["sha256"]:
            raise ValueError("The app installer changed before embedding")
        (folder / "bundle.json").write_bytes(encoded(manifest))
    elif manifest.get("app_installer_sha256"):
        raise ValueError("Fixture-only compilation cannot claim a verified installer overlay")
    framework = Path(os.environ.get("WINDIR", "C:/Windows")) / "Microsoft.NET/Framework64/v4.0.30319"
    args = [str(framework / "csc.exe"), "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
            "/out:" + str(folder / "Oats-Setup.exe"), "/resource:" + str(folder / "bundle.json") + ",bundle.json",
            "/win32icon:" + str(REPO / "frontend/src-tauri/icons/icon.ico")]
    args.append("/win32manifest:" + str(Path(__file__).with_name("setup.manifest")))
    args.append("/resource:" + str(folder / "msvc-runtime.zip") + ",msvc-runtime.zip")
    args.append("/resource:" + str(Path(__file__).with_name("configure.py")) + ",configure.py")
    if not allow_fixture:
        args.append("/resource:" + str(overlay) + ",app-installer.exe")
    for assembly in ("System.Net.Http", "System.Web.Extensions", "System.IO.Compression", "System.IO.Compression.FileSystem", "System.Windows.Forms", "System.Drawing"):
        args.append("/reference:" + str(framework / (assembly + ".dll")))
    args.extend(str(Path(__file__).with_name(name)) for name in ("PackageCore.cs", "Setup.cs"))
    subprocess.run(args, check=True)
    repair_args = [arg for arg in args if not arg.startswith(("/out:", "/resource:")) and not arg.endswith(".cs")]
    repair_args.extend(["/out:" + str(folder / "Oats-Repair.exe"), str(Path(__file__).with_name("PackageCore.cs")), str(Path(__file__).with_name("Repair.cs"))])
    subprocess.run(repair_args, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--python-base", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--id", default=None)
    parser.add_argument("--reuse-bundle", type=Path, help="Reuse a verified immutable GitHub payload release; rebuild only the small bootstrap")
    add_installer_arguments(parser)
    args = parser.parse_args()
    verify_app_installer(args.app_installer, args.update_feed, args.public_key, args.node)
    identity = args.id or secrets.token_hex(10)
    if not re.fullmatch("[a-f0-9]{20}", identity):
        raise ValueError("Bundle identity must be 20 hex characters")
    folder = args.output.resolve() / identity
    if folder.exists():
        raise ValueError("Build output already exists; choose a new identity")
    if args.reuse_bundle:
        manifest = read(args.reuse_bundle)
        manifest["payload_id"] = manifest.get("payload_id", manifest["id"])
        manifest["id"] = identity
        folder.mkdir(parents=True)
        file_count = None
    else:
        sources = collect(read(args.runtime), args.python_base, args.inputs)
        manifest = archive(sources, folder, identity)
        file_count = len(sources)
    embed_msvc(manifest, folder, args.inputs)
    compile_setup(manifest, folder, app_installer=args.app_installer, update_feed=args.update_feed,
                  public_key=args.public_key, node=args.node)
    print(json.dumps({"bundle_id": identity, "files": file_count, "download_bytes": sum(p["size"] for p in manifest["parts"]), "installed_bytes": manifest["installed_bytes"]}), flush=True)


if __name__ == "__main__":
    main()
