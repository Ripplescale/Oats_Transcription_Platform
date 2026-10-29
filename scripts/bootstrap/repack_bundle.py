"""Repack verified local parts after a packaging-only correction; no installs."""
import argparse
import bisect
import io
from pathlib import Path
import zipfile

from build_bundle import archive, compile_setup, digest, embed_msvc, read, runtime_file, add_installer_arguments, verify_app_installer


class JoinedReader(io.RawIOBase):
    def __init__(self, paths):
        self.files = [p.open("rb") for p in paths]
        self.starts = []
        self.length, self.position = 0, 0
        for stream in self.files:
            self.starts.append(self.length)
            self.length += stream.seek(0, 2)

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        self.position = (0 if whence == 0 else self.position if whence == 1 else self.length) + offset
        if self.position < 0:
            raise ValueError("Negative archive position")
        return self.position

    def read(self, size=-1):
        if size < 0:
            size = self.length - self.position
        blocks = []
        while size and self.position < self.length:
            index = bisect.bisect_right(self.starts, self.position) - 1
            stream = self.files[index]
            stream.seek(self.position - self.starts[index])
            block = stream.read(min(size, 1024 * 1024))
            if not block:
                raise EOFError("Truncated setup part")
            blocks.append(block)
            self.position += len(block)
            size -= len(block)
        return b"".join(blocks)

    def close(self):
        for stream in self.files:
            stream.close()
        super().close()


class ZipSource:
    def __init__(self, zipped, entry):
        self.zipped, self.name, self.size, self.expected = zipped, entry["path"], entry["size"], entry["sha256"]

    def open(self):
        return self.zipped.open(self.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    add_installer_arguments(parser)
    args = parser.parse_args()
    verify_app_installer(args.app_installer, args.update_feed, args.public_key, args.node)
    original = read(args.source / "bundle.json")
    paths = [args.source / part["name"] for part in original["parts"]]
    for path, part in zip(paths, original["parts"]):
        if path.stat().st_size != part["size"] or digest(path) != part["sha256"]:
            raise ValueError("Repack source part differs")
    target = args.output.resolve() / original["id"]
    if target.exists():
        raise ValueError("Repack output exists")
    with JoinedReader(paths) as stream, zipfile.ZipFile(stream) as zipped:
        import hashlib
        import json
        raw = zipped.read("payload-manifest.json")
        if hashlib.sha256(raw).hexdigest() != original["payload_manifest_sha256"]:
            raise ValueError("Repack source manifest differs")
        files = json.loads(raw)["files"]
        sources = {f["path"]: ZipSource(zipped, f) for f in files if runtime_file(f["path"])}
        result = archive(sources, target, original["id"])
    embed_msvc(result, target, args.inputs)
    compile_setup(result, target, app_installer=args.app_installer, update_feed=args.update_feed,
                  public_key=args.public_key, node=args.node)
    print(json.dumps({"id": result["id"], "files": len(sources), "removed_build_files": len(files) - len(sources), "installed_bytes": result["installed_bytes"], "download_bytes": sum(p["size"] for p in result["parts"])}), flush=True)


if __name__ == "__main__":
    main()
