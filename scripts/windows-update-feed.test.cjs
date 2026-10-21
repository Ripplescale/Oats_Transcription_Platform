'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPOSITORY, DOWNLOAD_REPOSITORY, prepareStage, createFeed, validateManifest, verifySignedInstaller, versionName } = require('./windows-update-feed.cjs');
const root = path.resolve(__dirname, '..');
const fixtures = path.join(root, 'target', 'update-feed-tests');
fs.mkdirSync(fixtures, { recursive: true });
const temporary = () => fs.mkdtempSync(path.join(fixtures, 'case-'));
function signed(bytes, version = '0.8.3', algorithm = 'ED', comment) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicBytes = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const keyId = crypto.randomBytes(8);
  const encode = (text) => Buffer.from(text).toString('base64');
  const publicKey = encode(`untrusted comment: ephemeral test key\n${Buffer.concat([Buffer.from('Ed'), keyId, publicBytes]).toString('base64')}\n`);
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(bytes).digest() : bytes;
  const signature = crypto.sign(null, message, pair.privateKey);
  const trusted = comment ?? `timestamp:1\tfile:oats_${version}_x64-setup.exe\tversion:${version}`;
  const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trusted)]), pair.privateKey);
  return { publicKey, signature: encode(`untrusted comment: ephemeral test signature\n${Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`) };
}
function fixture() {
  const dir = temporary();
  const installer = Buffer.from('MZ synthetic fixture only; never execute');
  const values = signed(installer);
  const filename = path.join(dir, 'oats_0.8.3_x64-setup.exe');
  fs.writeFileSync(filename, installer);
  fs.writeFileSync(filename + '.sig', values.signature);
  const key = path.join(dir, 'ephemeral.pub');
  fs.writeFileSync(key, values.publicKey);
  const notes = path.join(dir, 'notes.txt');
  fs.writeFileSync(notes, 'Synthetic signed release. हिंदी');
  return { dir, installer, filename, key, notes, ...values };
}
test('creates a verified Windows feed and refuses replacing release metadata', () => {
  const f = fixture();
  const summary = createFeed('0.8.3', f.filename, f.key, f.notes, f.dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, 'latest.json')));
  assert.equal(summary.bytes, f.installer.length);
  assert.equal(manifest.notes, 'Synthetic signed release. हिंदी');
  assert.equal(manifest.platforms['windows-x86_64'].signature, f.signature);
  assert.equal(REPOSITORY, 'Ripplescale/Oats_Transcription_Platform');
  assert.equal(DOWNLOAD_REPOSITORY, 'Ripplescale/Hinglish-Transcription-Platform');
  assert.equal(manifest.platforms['windows-x86_64'].url, 'https://github.com/Ripplescale/Hinglish-Transcription-Platform/releases/download/v0.8.3/oats_0.8.3_x64-setup.exe');
  assert.deepEqual(validateManifest(manifest, f.filename, f.publicKey), summary);
  assert.throws(() => createFeed('0.8.3', f.filename, f.key, f.notes, f.dir), /replace/);
});
test('verifies standard and prehashed Minisign but rejects tampered bytes, signatures and keys', () => {
  const bytes = Buffer.from('MZ input');
  for (const algorithm of ['Ed', 'ED']) {
    const value = signed(bytes, '0.8.3', algorithm);
    verifySignedInstaller(bytes, value.signature, value.publicKey, '0.8.3');
    assert.throws(() => verifySignedInstaller(Buffer.from('MZ other'), value.signature, value.publicKey, '0.8.3'), /verification/);
    assert.throws(() => verifySignedInstaller(bytes, value.signature, signed(bytes).publicKey, '0.8.3'), /key/);
    const text = Buffer.from(value.signature, 'base64').toString().replace('timestamp:1', 'timestamp:2');
    assert.throws(() => verifySignedInstaller(bytes, Buffer.from(text).toString('base64'), value.publicKey, '0.8.3'), /comment verification/);
  }
});
test('authenticated version cannot be relabeled, missing, duplicated or embedded inside a filename field', () => {
  const bytes = Buffer.from('MZ input');
  const valid = signed(bytes);
  assert.throws(() => verifySignedInstaller(bytes, valid.signature, valid.publicKey, '0.8.4'), /exact release version/);
  for (const comment of ['timestamp:1\tfile:version:0.8.3', 'version:0.8.3\tversion:0.8.3', 'timestamp:1\tfile:oats_0.8.3_x64-setup.exe']) {
    const value = signed(bytes, '0.8.3', 'ED', comment);
    assert.throws(() => verifySignedInstaller(bytes, value.signature, value.publicKey, '0.8.3'), /exact release version/);
  }
});
test('rejects wrong release origin, filename, platform and unsupported version syntax', () => {
  const f = fixture(); createFeed('0.8.3', f.filename, f.key, f.notes, f.dir);
  const original = JSON.parse(fs.readFileSync(path.join(f.dir, 'latest.json')));
  const modified = structuredClone(original);
  modified.platforms['windows-x86_64'].url = modified.platforms['windows-x86_64'].url.replace('Ripplescale', 'someone');
  assert.throws(() => validateManifest(modified, f.filename, f.publicKey), /Unexpected/);
  modified.platforms = { 'linux-x86_64': original.platforms['windows-x86_64'] };
  assert.throws(() => validateManifest(modified, f.filename, f.publicKey), /Windows x64/);
  assert.throws(() => validateManifest(original, f.filename + '.zip', f.publicKey), /filename/);
  for (const version of ['0.8.3.1', '../0.8.3', 'v0.8.3', '01.8.3', '0.8.3-beta']) assert.throws(() => versionName(version));
});
test('portable stage preserves app identity, excludes workstation marker and leaves original source untouched', () => {
  const dir = temporary();
  const native = path.join(dir, 'frontend', 'src-tauri');
  fs.mkdirSync(native, { recursive: true }); fs.mkdirSync(path.join(dir, 'scripts'));
  for (const relative of ['frontend/package.json', 'frontend/src-tauri/Cargo.toml', 'frontend/src-tauri/tauri.conf.json', 'frontend/src-tauri/tauri.windows.conf.json', 'scripts/public-release-WINDOWS.txt']) fs.copyFileSync(path.join(root, relative), path.join(dir, relative));
  const original = fs.readFileSync(path.join(root, 'frontend/src-tauri/tauri.windows.conf.json'));
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'frontend/package.json'))).version;
  prepareStage(dir, version);
  const windows = JSON.parse(fs.readFileSync(path.join(native, 'tauri.windows.conf.json')));
  const config = JSON.parse(fs.readFileSync(path.join(native, 'tauri.conf.json')));
  assert.equal(config.identifier, 'com.sttapp.local');
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.plugins.updater.requireSignedVersion, true);
  assert.equal(windows.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(JSON.stringify(windows).includes('sttapp-local-install.json'), false);
  assert.equal(JSON.stringify(windows).includes('Start-xx.ps1'), false);
  assert.deepEqual(fs.readFileSync(path.join(root, 'frontend/src-tauri/tauri.windows.conf.json')), original);
  fs.mkdirSync(path.join(native, 'binaries'));
  fs.writeFileSync(path.join(native, 'binaries/sttapp-local-install.json'), '{}');
  assert.throws(() => prepareStage(dir, version), /workstation marker/);
});
