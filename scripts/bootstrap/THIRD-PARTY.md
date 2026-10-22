# Components in the complete oats setup

The setup contains redistributed runtime components, not private notes, recordings,
accounts or training data. Original license files and package `.dist-info`
license/NOTICE metadata are retained alongside each Python distribution.

- oats: Meetily Community fork, MIT. See the included LICENSE.md.
- Python 3.12.14: Python Software Foundation license and bundled component notices,
  included at python/LICENSE.txt and within the standard library.
- Trelis/whisper-hinglish-preview, revision
  eab1188fd2d0e91f2584229b32b3bfe1901c896c: Apache-2.0, model card in
  models/trelis/source/README.md. Includes the original safetensors and an FP16
  OpenVINO conversion. Conversion receipts bind source and exported hashes;
  the source location in export metadata is rebased to its public model identity.
- Oriserve/Whisper-Hindi2Hinglish-Apex, revision
  f3214eed20b4e4d4144e739982d911f87b9cb223: Apache-2.0. Model card in
  setup/Apex-model-card.md. The included model is a q5_0 whisper.cpp conversion.
- whisper.cpp b5130, revision 927cfce34f31707e17f2bff35c349632fb9e2c3a:
  MIT, included tools/whisper-cpu/LICENSE. Official Windows x64 CPU binaries
  select an appropriate available CPU backend at runtime.
- Silero VAD 6.2.3: MIT, copyright Silero Team. Public package provenance and
  pinned ONNX hash appear in setup/runtime-template.json. Its license is
  included at setup/Silero-LICENSE.
- OpenVINO, optimum/optimum-intel, Transformers, PyTorch, ONNX Runtime, NumPy,
  SciPy, SoundFile and transitive dependencies: respective upstream licenses,
  retained in env/Lib/site-packages. Exact versions in setup/packages.json.
- Microsoft Edge WebView2 Evergreen Standalone Runtime: unmodified Microsoft
  redistributable, subject to its included Microsoft license terms. Its installer
  is used only if the WebView2 runtime is missing. Redistribution follows
  https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution.
- Microsoft Visual C++ runtime DLLs: unmodified app-local redistributable files,
  subject to Microsoft Visual Studio distributable-code terms.

The setup does not include optional gated Community-1 speaker identification
weights or Hugging Face credentials. Microphone access is granted separately by
Windows. Compatible GPU drivers remain the PC owner's responsibility.

Apache-2.0 text is included at setup/Apache-2.0.txt. This package's model
conversions do not change the declared model license. No model accuracy or
universal hardware performance claim is made by this packaging.
