#!/usr/bin/env node
'use strict';
// Local release preparation only: no GitHub API, credentials or publication.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPOSITORY = 'Ripplescale/Hinglish-Transcription-Platform';
const MAX_INSTALLER = 512 * 1024 * 1024;
function requireThat(value, message) { if (!value) throw new Error(message); }
function versionName(version) {
  requireThat(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), 'Use a stable three-part release version.');
  return `oats_${version}_x64-setup.exe`;
}
function boundedRead(filename, maximum) {
  const info = fs.lstatSync(filename);
  requireThat(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum, 'Release input must be a bounded ordinary file.');
  const value = fs.readFileSync(filename);
  requireThat(value.length === info.size, 'Release input changed while reading.');
  return value;
}
function base64(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length < 16384 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'Invalid Tauri signing format.');
  const bytes = Buffer.from(value, 'base64');
  requireThat(bytes.toString('base64') === value, 'Noncanonical Tauri signing format.');
  return bytes;
}
function parsePublicKey(encoded) {
  const lines = base64(encoded.trim()).toString('utf8').trimEnd().split(/\r?\n/);
  requireThat(lines.length === 2 && lines[0].startsWith('untrusted comment: '), 'Expected a Tauri .pub file.');
  const bytes = base64(lines[1]);
  requireThat(bytes.length === 42 && ['Ed', 'ED'].includes(bytes.subarray(0, 2).toString()), 'Unsupported updater public key.');
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes.subarray(10)]), format: 'der', type: 'spki' });
  return { key, keyId: bytes.subarray(2, 10) };
}
function verifySignedInstaller(installer, signature, publicKey, version) {
  requireThat(installer.length > 2 && installer.length <= MAX_INSTALLER && installer.subarray(0, 2).toString() === 'MZ', 'Expected the raw Windows NSIS installer.');
  const key = parsePublicKey(publicKey);
  const lines = base64(signature.trim()).toString('utf8').trimEnd().split(/\r?\n/);
  requireThat(lines.length === 4 && lines[0].startsWith('untrusted comment: ') && lines[2].startsWith('trusted comment: '), 'Invalid Minisign signature.');
  const signed = base64(lines[1]);
  const globalSignature = base64(lines[3]);
  requireThat(signed.length === 74 && globalSignature.length === 64 && signed.subarray(2, 10).equals(key.keyId), 'Signature key does not match the public key.');
  const algorithm = signed.subarray(0, 2).toString();
  requireThat(['Ed', 'ED'].includes(algorithm), 'Unsupported Minisign algorithm.');
  // Minisign ED signs BLAKE2b-512(input); Ed signs the original input. The
  // trusted-comment signature covers the 64-byte signature plus its comment.
  // https://github.com/jedisct1/rust-minisign-verify/blob/master/src/lib.rs
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(installer).digest() : installer;
  requireThat(crypto.verify(null, message, key.key, signed.subarray(10)), 'Installer signature verification failed.');
  requireThat(crypto.verify(null, Buffer.concat([signed.subarray(10), Buffer.from(lines[2].slice(17))]), key.key, globalSignature), 'Signature comment verification failed.');
  const signedVersions = lines[2].slice(17).split('\t').filter((part) => part.startsWith('version:')).map((part) => part.slice(8));
  requireThat(signedVersions.length === 1 && signedVersions[0] === version, 'The signature must authenticate the exact release version. Use a Tauri CLI with --app-version support.');
}
function validateManifest(manifest, installerPath, publicKey) {
  const asset = versionName(manifest.version);
  requireThat(path.basename(installerPath) === asset, 'Installer filename and release version differ.');
  requireThat(typeof manifest.notes === 'string' && manifest.notes.length <= 20000, 'Release notes must be at most 20,000 characters.');
  requireThat(typeof manifest.pub_date === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.pub_date) && Number.isFinite(Date.parse(manifest.pub_date)), 'Release date must be RFC 3339.');
  requireThat(manifest.platforms && Object.keys(manifest.platforms).join() === 'windows-x86_64', 'Only the qualified Windows x64 platform is supported.');
  const platform = manifest.platforms['windows-x86_64'];
  requireThat(platform.url === `https://github.com/${REPOSITORY}/releases/download/v${manifest.version}/${asset}`, 'Unexpected release repository, tag or installer URL.');
  const installer = boundedRead(installerPath, MAX_INSTALLER);
  verifySignedInstaller(installer, platform.signature, publicKey, manifest.version);
  return { version: manifest.version, bytes: installer.length, sha256: crypto.createHash('sha256').update(installer).digest('hex') };
}
function createFeed(version, installerPath, keyPath, notesPath, outputDirectory) {
  const signature = boundedRead(`${installerPath}.sig`, 16384).toString('utf8').trim();
  const publicKey = boundedRead(keyPath, 16384).toString('utf8').trim();
  const notes = boundedRead(notesPath, 80000).toString('utf8');
  const asset = versionName(version);
  const manifest = { version, notes, pub_date: new Date().toISOString(), platforms: {
    'windows-x86_64': { url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${asset}`, signature },
  } };
  const result = validateManifest(manifest, installerPath, publicKey);
  const latest = path.join(outputDirectory, 'latest.json');
  const checksums = path.join(outputDirectory, 'SHA256SUMS.txt');
  requireThat(!fs.existsSync(latest) && !fs.existsSync(checksums), 'Refusing to replace an existing release feed.');
  fs.writeFileSync(latest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const sum = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  fs.writeFileSync(checksums, `${result.sha256}  ${asset}\n${sum(installerPath + '.sig')}  ${asset}.sig\n${sum(latest)}  latest.json\n`, { flag: 'wx' });
  return result;
}
function prepareStage(root, version) {
  versionName(version);
  const nativeRoot = path.join(root, 'frontend', 'src-tauri');
  const configPath = path.join(nativeRoot, 'tauri.conf.json');
  const windowsPath = path.join(nativeRoot, 'tauri.windows.conf.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const windows = JSON.parse(fs.readFileSync(windowsPath, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'frontend', 'package.json'), 'utf8'));
  const cargo = fs.readFileSync(path.join(nativeRoot, 'Cargo.toml'), 'utf8');
  requireThat(config.version === version && pkg.version === version && new RegExp(`^version\\s*=\\s*"${version.replaceAll('.', '\\.')}"`, 'm').test(cargo), 'Release versions must agree in package.json, Cargo.toml and tauri.conf.json.');
  requireThat(config.identifier === 'com.sttapp.local' && config.mainBinaryName === 'xx' && config.productName === 'oats', 'Installer identity changed; review data migration before releasing.');
  requireThat(windows.bundle.windows.nsis.template === 'scripts/installer-oats.nsi' && windows.bundle.windows.nsis.installerHooks === 'scripts/oats-installer-hooks.nsh', 'The data-preserving installer hooks are required.');
  // Replace the complete stage resource map; JSON config overlays merge object
  // entries and cannot reliably subtract a workstation-specific resource.
  windows.bundle.resources = {
    templates: 'templates', 'binaries/onnxruntime': '.', 'binaries/msvc-runtime': '.',
    'INSTALL-WINDOWS.txt': 'INSTALL-WINDOWS.txt',
    'scripts/dictation_worker.py': 'dictation_worker.py',
    'scripts/faster_whisper_dictation.py': 'faster_whisper_dictation.py',
  };
  windows.bundle.windows.nsis.installMode = 'currentUser';
  config.bundle.createUpdaterArtifacts = true;
  config.plugins = { ...config.plugins, updater: { pubkey: '', ...config.plugins?.updater, requireSignedVersion: true } };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(windowsPath, JSON.stringify(windows, null, 2) + '\n');
  fs.copyFileSync(path.join(root, 'scripts', 'public-release-WINDOWS.txt'), path.join(nativeRoot, 'INSTALL-WINDOWS.txt'));
  requireThat(!fs.existsSync(path.join(nativeRoot, 'binaries', 'sttapp-local-install.json')), 'A workstation marker must never enter the release stage.');
}
module.exports = { REPOSITORY, MAX_INSTALLER, versionName, parsePublicKey, verifySignedInstaller, validateManifest, createFeed, prepareStage };
if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'create' && args.length === 5) console.log(JSON.stringify(createFeed(...args)));
    else if (command === 'verify' && args.length === 3) console.log(JSON.stringify(validateManifest(JSON.parse(boundedRead(args[0], 128000)), args[1], boundedRead(args[2], 16384).toString('utf8'))));
    else if (command === 'prepare-stage' && args.length === 2) { prepareStage(...args); console.log('Portable release stage prepared.'); }
    else throw new Error('Usage: windows-update-feed.cjs create VERSION INSTALLER PUBLIC_KEY NOTES OUTPUT_DIR | verify MANIFEST INSTALLER PUBLIC_KEY | prepare-stage ROOT VERSION');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
