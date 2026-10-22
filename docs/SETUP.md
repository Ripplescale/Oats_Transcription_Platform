# Windows setup for oats

For a new Windows x64 PC, use **[the complete setup](COMPLETE_SETUP.md)**: one Oats-Setup.exe downloads the app, private Python, speech libraries and models from GitHub. It can also save a complete folder for offline installation. Hardware and clean-PC validation limits are listed there. The remaining instructions on this page cover existing installations and developer setup.

## Using an existing installation

Close any running instance of oats (or its earlier xx version) normally before upgrading, then run the locally supplied oats setup program and open **oats** from Start. The upgrade retains the existing local workspace. Opening oats shows your notes without starting recording.

The default window is a narrow 680 × 820 writing space, fitted to the available screen. Windows' maximize button extends it to the top and bottom of the usable display while keeping its current width. Restore returns to the previous size and position. Drag a side edge to choose another width.

The install includes the desktop application, FFmpeg, and required Microsoft C++ runtime files. It reuses the existing local models and Python environments. Its adjacent `sttapp-local-install.json` points to the data root; do not commit this machine-specific file.

1. Check the local runtime status, microphone, and system-audio device.
2. Choose the call language and Trelis chunk duration: **5, 10, or 20 seconds**. New settings use **10 seconds**, and saved choices are retained. OpenVINO GPU FP16 preserves original Hindi/English script. Model loading adds startup time; each update takes a window plus processing time. Repetition or a reached generation limit first triggers a retry with up to 30 seconds of surrounding audio. If usable text and neighboring speech cannot both be preserved, the original window gets a bounded fallback in pieces of at most 5 seconds. A completed, nonempty combined fallback becomes the displayed and copied text even if repetition remains. Originals and attempts stay available for review.
3. Select a project, then click **New note** at the top right. This immediately starts microphone and system-audio recording and opens a blank notes editor. Notes autosave; the **Transcript** control beside the recording controls reveals live text. For a short test, choose **Finish recording** and let the same job finish remaining audio; there is no second full pass. Check playback and the transcript before relying on a longer call.
4. If Trelis needs attention, choose **Use Apex fallback**. The app pauses Trelis after its current window and imports its last output before Apex replays the saved audio as a separate version. GPU errors are shown, without a silent Trelis CPU fallback.
5. Review the transcript and edit text or speakers where needed. “Final transcript” means processing completed, not that a person checked it. Copy/export into Claude only when you want to review and send it yourself.

Trelis live text may lag or be incomplete. Its raw output and checkpoint remain available if you switch to Apex. Corrections and notes stay with the version you edited; they are not silently copied between models. Additional manual versions remain available through Tools.

One heavy worker runs at a time. Back-to-back calls keep recording while earlier work finishes; a delayed Trelis job can still use all saved audio. Pausing a worker does not stop capture. After choosing Apex fallback, Trelis stays paused until you explicitly retry it after Apex has finished or paused. Existing legacy versions, including the older two-pass workflow, remain unchanged.

Public oats app releases use oats' own signed update feed, with separate approval to download and install. Local developer installers and detached updater signatures are distinct from Windows Authenticode publisher signing. The default live Trelis profile requires a verified OpenVINO GPU runtime; CPU configuration is not qualified for live use. Optional speaker setup is described below.

## Developer prerequisites

Use PowerShell 7, Git, Node.js 22, pnpm, and Windows x64 CPython 3.12. The private Python-copy helper is pinned to the tested **3.12.14** base. Build the native app with Rust's **MSVC** target, Microsoft C++ Build Tools and a Windows SDK; the bundled ONNX build step does not support the GNU target.

Use a local data directory outside OneDrive. The acceleration experiment used a 32 GB laptop with an Intel Ultra 7 268V and Arc 140V GPU; that is a tested engine configuration, not an established minimum requirement or complete-app hardware qualification. Leave headroom for the calling app and run only one heavy model job at a time. Dependency/model setup needs the network and substantial disk space; installed transcription can run offline.

```powershell
git clone https://github.com/Ripplescale/Hinglish-Transcription-Platform.git
Set-Location Hinglish-Transcription-Platform
$sttRoot = Join-Path $env:LOCALAPPDATA 'STTApp'
$sttLab = Join-Path $sttRoot 'lab'
```

The repository is public. No private recordings or reference transcripts are required to install the worker.

## Download the two ASR models

Set `$basePython` to your existing CPython 3.12 executable. The following helper creates an isolated environment; it does not install a system Python:

```powershell
$basePython = 'C:\Python312\python.exe' # replace with your actual installation
.\stt_lab\tools\bootstrap_whisper.ps1 -Python $basePython
$sttPython = Join-Path $sttLab 'venvs\whisper\Scripts\python.exe'
& $sttPython -B stt_lab/tools/model_assets.py fetch apex
& $sttPython -B stt_lab/tools/model_assets.py fetch trelis
& $sttPython -B stt_lab/tools/model_assets.py verify apex
& $sttPython -B stt_lab/tools/model_assets.py verify trelis
```

The bootstrap includes the pinned SciPy resampling dependency used by the capture worker. The model helper uses exact revisions from [`models.json`](../stt_lab/models.json), retains license/source metadata, and writes file hashes. No Qwen model is downloaded. The default download location is `%LOCALAPPDATA%\STTApp\lab`; changing `STTAPP_DATA_DIR` alone does not redirect these download helpers.

## Prepare Apex's local engine

Follow [the pinned whisper.cpp setup](../stt_lab/tools/WHISPER_CPP_SETUP.md) to download the CPU converter/runtime, convert Apex to Q5_0, and build the Vulkan CLI. Retain the generated `.bin.provenance.json` sidecars. The Vulkan build uses portable, pinned tools; it does not install a graphics driver.

The expected paths below follow that guide. Use your actual verified executable if you chose another build directory. A successful build alone does not prove that inference uses the GPU; inspect its runtime log.

## Configure and install the ASR worker

Create the baseline CPU/Apex configuration first, then prepare OpenVINO in the next section. The OpenVINO preparation helper needs the existing original Trelis configuration and its verified checkpoint. **Do not use this baseline as the new live Trelis configuration.**

Create a private configuration directory. The installer's historical `--study` argument means a directory containing `configs/apex.json` and `configs/trelis.json`; it does not require a benchmark or private call data.

```powershell
$sttConfig = Join-Path $sttRoot 'setup\asr'
$sttWork = Join-Path $sttLab 'work'
New-Item -ItemType Directory -Force (Join-Path $sttConfig 'configs'), $sttWork | Out-Null
$apex = @{
  backend = 'whisper_cpp'
  artifact_path = (Join-Path $sttLab 'converted\whisper-cpp-b5130\apex\ggml-model-q5_0.bin')
  executable = (Join-Path $sttLab 'vk\build\bin\whisper-cli.exe')
  work_dir = $sttWork
  device = 'vulkan'; threads = 4; num_beams = 5; timestamps = $false
}
$trelis = @{
  backend = 'transformers'
  artifact_path = (Join-Path $sttLab 'models\trelis\eab1188fd2d0e91f2584229b32b3bfe1901c896c')
  device = 'cpu'; dtype = 'float32'; threads = 4
  num_beams = 1; max_new_tokens = 440; timestamps = $false
}
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $sttConfig 'configs\apex.json'), ($apex | ConvertTo-Json), $utf8)
[IO.File]::WriteAllText((Join-Path $sttConfig 'configs\trelis.json'), ($trelis | ConvertTo-Json), $utf8)
& $sttPython -B stt_lab/tools/install_local_worker.py `
  --data-root $sttRoot --study $sttConfig --python $sttPython
```

This writes a content-addressed copy of the worker and `runtime.json`. It does not copy recordings or download weights. Paths and asset provenance are validated during inference. Keep the original checkpoint and conversion records outside Git.

For the conservative speech gate, supply `--speech-gate-model C:\LocalModels\silero_vad.onnx` to this installer or the OpenVINO preparation tool. New candidates use Silero **6.2.3**, pinned to model SHA-256 `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`. Alternatively, explicitly pass `--download-speech-gate` to fetch the pinned public wheel and extract its verified ONNX asset; this does not install or execute wheel code. Downloading is opt-in, and inference never downloads models. The installer copies the verified asset under `lab/models/silero`; `onnxruntime` is included in the OpenVINO lock. Without the verified model, the worker retains uncertain input and records `speech_gate_unavailable`. Existing jobs retain their historical runtime/model snapshots, including the earlier v4 asset.

For an existing installation, stage the updated worker and speech gate with `install_local_worker.py --data-root $sttRoot --update-existing --no-activate --speech-gate-model C:\LocalModels\silero_vad.onnx`. It retains the current Python and ASR model configuration, creates an immutable candidate, and leaves existing jobs untouched. After saving notes and fully quitting through the tray, run the same command without `--no-activate` to preserve historical runtime snapshots and activate. Deploy the updated desktop app and worker together for recovery and revision-aware selection.

## Prepare Trelis OpenVINO GPU

The GPU path uses a separate, independently installed environment. The experimental environment that borrowed dependencies from another environment is not a deployment dependency. The pinned lock includes Python **3.12.14**, torch **2.8.0+cpu**, transformers **4.57.6**, optimum-intel **2.2.0**, optimum **2.3.0**, and OpenVINO **2026.4.0**. CPU torch is used by the export/runtime support code; OpenVINO performs inference explicitly on the GPU.

Use your verified CPython 3.12.14 executable as `$basePython`:

```powershell
& $basePython -B stt_lab/tools/bootstrap_openvino.py `
  --data-root $sttRoot --base-python $basePython
$ovPython = Join-Path $sttLab 'venvs\openvino-py312\Scripts\python.exe'
```

The bootstrap installs exact versions from [`openvino-windows-py312.lock.txt`](../stt_lab/tools/openvino-windows-py312.lock.txt), checks dependencies and GPU availability, and records wheel hashes. It does not activate the app runtime. `--pip-cache` can select a download cache; use `--direct` only if your network setup requires bypassing proxy environment variables for these downloads.

Next supply an **existing verified FP16 OpenVINO export** of Trelis revision `eab1188fd2d0e91f2584229b32b3bfe1901c896c`. The example path below is a placeholder: it must contain the encoder and decoder IR files, original tokenizer/processor assets, and the matching `export-complete.json` hash record.

```powershell
$verifiedExport = 'C:\LocalModels\trelis-openvino-fp16' # replace with your verified export directory
& $ovPython -B stt_lab/tools/prepare_openvino_runtime.py `
  --data-root $sttRoot --export-source $verifiedExport --python $ovPython
```

This stages durable model files, worker source, and a candidate runtime configuration without activating it. The current export was produced by the reproducible local acceleration experiment using a stateful `automatic-speech-recognition-with-past` export, FP16, and the original tokenizer. A standalone general export/download installer is not provided yet; the repository contains neither converted weights nor private benchmark inputs. Fresh-machine setup remains a developer procedure, not one click.

After checking the candidate and stopping capture and worker processes, activate explicitly:

```powershell
& $ovPython -B stt_lab/tools/prepare_openvino_runtime.py `
  --data-root $sttRoot --export-source $verifiedExport --python $ovPython --activate
```

Activation must retain the original CPU configuration for older jobs and Apex's separate engine. Keep the source checkpoint, export hashes, and environment setup report. Test the actual app's two-track recording-to-transcript path, fallback, recovery, and corrections before treating the installation as qualified. GPU model startup is additional to warm processing; quiet input, two active tracks, retries, and speaker processing can change elapsed time substantially. See [the benchmark limits](HOW_IT_WORKS.md#models-and-timing).

## Optional speaker identification

Follow [Community-1 setup](../stt_lab/SPEAKER_SETUP.md). Accept access conditions on the model publisher's page using your own Hugging Face account, then authenticate through the local token prompt:

```powershell
.\stt_lab\tools\login_speaker_model.ps1
.\stt_lab\tools\setup_speakers.ps1 -DataRoot $sttRoot
```

Do not put the token in a command argument, repository file, chat, or screenshot. A read token does not grant access until the account has accepted the model conditions. The helper uses an isolated environment, verifies downloaded artifacts, and performs an offline deployment check before publishing `speaker-runtime.json`. Speaker accuracy still needs listening-based validation. Omitting this optional setup does not prevent ASR.

## Building the Windows application

From `frontend`, install the locked dependencies and build the interface:

```powershell
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm build
```

The current packaging helper, [`build-local-windows.ps1`](../frontend/src-tauri/scripts/build-local-windows.ps1), expects the prepared `runtime.json`, an isolated MSVC Rust toolchain under `lab/rust`, a libclang distribution under `lab/windows-build`, and Microsoft Build Tools. Its prerequisites are not bootstrapped by the script; inspect its checks before using it on a new PC. From the repository root, after preparing them:

```powershell
.\frontend\src-tauri\scripts\build-local-windows.ps1 `
  -Mode Package -DataRoot $sttRoot -LabRoot $sttLab `
  -BuildToolsPath 'C:\BuildTools-STT' -TargetRoot 'C:\STTBuild\target'
```

Those short build paths are examples; choose writable locations for your installation. The helper creates a machine-specific runtime pointer and bundles verified runtime DLLs. Review licenses before distributing a binary. Inherited upstream CI/release recipes are not a supported oats release pipeline.

An optional [`Install-PrivatePythonBase.ps1`](../frontend/src-tauri/scripts/Install-PrivatePythonBase.ps1) copies and verifies an existing CPython **3.12.14** base and can rebind the prepared environments. Supply `-SourceBase` explicitly. It does not download Python; stop worker processes before using its activation option.

The bundled [`Start-xx.ps1`](../frontend/src-tauri/scripts/Start-xx.ps1) resolves the local pointer and launches the GUI. When running the source copy, pass `-AppPath` pointing to the built `xx.exe`; its default expects the script beside the executable.

## Storage and backups

Data-root discovery uses `STTAPP_DATA_DIR`, then `sttapp-local-install.json` beside the executable, then `%LOCALAPPDATA%\STTApp`. The database, recordings, worker/model assets, corrections, and notes must remain outside the source checkout.

Back up the full root while recording and workers are stopped. Earlier local installations can point into a Windows app package's cache. Resetting or uninstalling the host app can remove such data; inspect the pointer and back up before doing either. Normal inference uses the verified private Python base, not the host app's separate managed interpreter.

Moving data requires updating absolute recording/model/worker/environment paths and verifying history before retiring the old copy. Setting a new environment variable is not a migration. This installer does not move or delete existing recordings.

## Troubleshooting boundaries

- **Runtime unavailable:** verify the data pointer, `runtime.json`, Python executable, and model/configuration paths.
- **Speaker access denied:** use the same account for the access form and local login; preserve a working configuration while retrying setup.
- **OpenVINO GPU unavailable:** check the independent environment and GPU driver/runtime. Recording remains available; choose the explicit Apex fallback or repair setup and retry. Do not silently change Trelis to CPU.
- **Trelis queues slowly:** check whether another heavy worker is active and leave memory/GPU headroom for the call. Twenty-second windows still need processing time, and both tracks cost work. The actual 90-minute app flow is not yet qualified.
- **Missing speech:** check the saved track and input levels, then inspect flags/retry alternatives. Re-running cannot restore missing captured audio.
- **Build failure on GNU Rust:** use the MSVC toolchain required by the pinned native ONNX packaging step.

See [privacy](../PRIVACY_POLICY.md), [architecture](HOW_IT_WORKS.md), and [contribution checks](../CONTRIBUTING.md) for the limits of the current implementation.
