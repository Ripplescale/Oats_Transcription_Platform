"""Configure only a verified, unpacked oats runtime; never download anything."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import venv


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_new(path, value):
    encoded = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    path = Path(path)
    descriptor, name = tempfile.mkstemp(prefix=".setup-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(name, path)  # Atomic publication that refuses an existing file.
    finally:
        os.unlink(name)


def rebase(value, bundle):
    if isinstance(value, dict):
        return {k: rebase(v, bundle) for k, v in value.items()}
    if isinstance(value, list):
        return [rebase(v, bundle) for v in value]
    if isinstance(value, str) and value.startswith("@PACKAGE@/"):
        relative = value[len("@PACKAGE@/"):]
        target = (bundle / relative).resolve()
        if not target.is_relative_to(bundle):
            raise ValueError("Runtime configuration leaves its package")
        return str(target)
    return value


def private_environment(bundle):
    env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
               HF_HUB_DISABLE_IMPLICIT_TOKEN="1", PYTHONNOUSERSITE="1", TOKENIZERS_PARALLELISM="false")
    # Probe the package itself; developer PATH/PYTHONPATH must not make it pass.
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    env["PATH"] = os.pathsep.join([str(bundle / "env/Scripts"), str(bundle / "python"),
                                  str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32"),
                                  os.environ.get("SystemRoot", "C:/Windows")])
    return env


def isolated(python, arguments, cwd):
    env = private_environment(cwd)
    completed = subprocess.run([str(python), "-I", "-B", *arguments], cwd=cwd, env=env,
                               capture_output=True, text=True, timeout=600,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if completed.returncode:
        raise RuntimeError("Packaged Python check failed: " + completed.stderr[-1600:])
    return completed.stdout


def probe(bundle):
    environment = bundle / "env"
    python = environment / "Scripts/python.exe"
    # Never copy the developer's venv launchers or absolute pyvenv.cfg.
    venv.EnvBuilder(with_pip=False, symlinks=False).create(environment)
    expected = read(bundle / "setup/packages.json")
    code = (
        "import json,sys,importlib.metadata as m,openvino,torch,transformers,scipy,soundfile,onnxruntime;"
        "print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'prefix':sys.prefix,"
        "'base_prefix':sys.base_prefix,'devices':openvino.Core().available_devices,"
        "'packages':{n:m.version(n) for n in " + repr(list(expected)) + "}}))"
    )
    info = json.loads(isolated(python, ["-c", code], bundle).strip().splitlines()[-1])
    if info["version"] != "3.12.14" or Path(info["prefix"]).resolve() != environment.resolve():
        raise ValueError("Packaged Python identity differs")
    if Path(info["base_prefix"]).resolve() != (bundle / "python").resolve() or info["packages"] != expected:
        raise ValueError("Packaged dependencies differ")
    cli = bundle / "tools/whisper-cpu/whisper-cli.exe"
    process = subprocess.run([str(cli), "--help"], cwd=cli.parent, capture_output=True, timeout=60,
                             env=private_environment(bundle),
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if process.returncode not in (0, 1) or b"usage" not in (process.stdout + process.stderr).lower():
        raise RuntimeError("The portable Apex engine could not start on this PC")
    result = {"gpu_available": any(d == "GPU" or d.startswith("GPU.") for d in info["devices"]), **info}
    path = bundle / "probe.json"
    if path.exists():
        path.unlink()  # This package's own disposable probe, not user data.
    write_new(path, result)
    return result


def prepare(bundle, device):
    config = rebase(read(bundle / "setup/runtime-template.json"), bundle)
    if device == "CPU":
        config["models"]["trelis"].update(backend="transformers", device="cpu", dtype="float32")
        config["models"]["trelis"].pop("export_path", None)
    elif device != "GPU":
        raise ValueError("Choose GPU or explicitly accepted CPU mode")
    python = bundle / "env/Scripts/python.exe"
    worker = bundle / "worker"
    # Validate the same model manifests, conversion receipts, and gate hashes
    # used during ordinary inference. No model inference or network calls here.
    config_path = bundle / "candidate-runtime.json"
    encoded = json.dumps(config, ensure_ascii=False)
    code = (
        "import sys,json;sys.path.insert(0," + repr(str(worker)) + ");"
        "from sttbench.runtime.assets import verify_model_assets,verify_openvino_assets,verify_conversion_provenance;"
        "c=json.loads(" + repr(encoded) + ");"
        "r=json.load(open(c['registry_path'],encoding='utf-8'));"
        "c['models']={m['id']:{**m,**c['models'][m['id']]} for m in r['models']};"
        "a=verify_model_assets(c['models']['apex'],'whisper_cpp');assert a['ok'],a;"
        "p=verify_conversion_provenance(c['models']['apex']);assert p['ok'],p;"
        "s=verify_model_assets(c['models']['trelis']);assert s['ok'],s;"
        "e=verify_openvino_assets(c['models']['trelis'],c['models']['trelis']['export_path'],s) if 'export_path' in c['models']['trelis'] else {'ok':True};"
        "assert e['ok'],e;print('verified')"
    )
    isolated(python, ["-c", code], bundle)
    gate = Path(config["speech_gate"]["model_path"])
    if hashlib.sha256(gate.read_bytes()).hexdigest() != config["speech_gate"]["model_sha256"]:
        raise ValueError("Speech gate integrity check failed")
    if config_path.exists():
        if read(config_path) == config:
            return config
        # Retry can change CPU/GPU selection; only this inactive candidate moves.
        config_path.unlink()
    write_new(config_path, config)
    return config


def activate(bundle, root):
    root.mkdir(parents=True, exist_ok=True)
    if (root / "runtime.json").exists() or (root / "dictation-runtime.json").exists():
        raise ValueError("Existing speech configuration was preserved")
    candidate = read(bundle / "candidate-runtime.json")
    for key in ("python_executable", "worker_script", "registry_path"):
        path = Path(candidate[key]).resolve(strict=True)
        if not path.is_file() or not path.is_relative_to(bundle):
            raise ValueError("Invalid candidate runtime path")
    # Exclusive publication never replaces an existing runtime or its history.
    write_new(root / "runtime.json", candidate)
    return {"activated": True, "device": candidate["models"]["trelis"]["device"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--probe", action="store_true")
    action.add_argument("--prepare", action="store_true")
    action.add_argument("--activate", action="store_true")
    parser.add_argument("--device", choices=("GPU", "CPU"))
    args = parser.parse_args()
    bundle = Path(__file__).resolve().parent.parent
    root = args.root.resolve()
    if bundle.parent != root / "packages":
        raise ValueError("Install this package inside the selected data root")
    if root.is_symlink() or bundle.is_symlink():
        raise ValueError("Linked setup locations are not supported")
    result = probe(bundle) if args.probe else prepare(bundle, args.device) if args.prepare else activate(bundle, root)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
