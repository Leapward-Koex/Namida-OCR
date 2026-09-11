import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBuildInfo, validateVersion } = require('../scripts/build-info.cjs');
const { verifyExtensionBuild } = require('../scripts/verify-extension-build.cjs');
const commit = 'abcdef012345' + 'a'.repeat(28);
const make = (sequence, attempt = 1, extra = {}) => createBuildInfo({ env: {
    NAMIDA_BUILD_SEQUENCE: String(sequence), NAMIDA_BUILD_ATTEMPT: String(attempt), GITHUB_SHA: commit,
}, git: { commit, dirty: false }, ...extra });
const compare = (a, b) => {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
    return 0;
};

test('automatic versions sort after old releases and across counter rollover; reruns retain version', () => {
    const versions = ['1.2.65535', make(1).version, make(2).version,
        make(65535, 65535).version, make(65536).version, make(4294967295, 65535).version];
    for (let i = 1; i < versions.length; i++) assert.ok(compare(versions[i], versions[i - 1]) > 0);
    assert.equal(make(65536).version, '2.1.0');
    assert.equal(make(1, 2).version, make(1).version);
    assert.notEqual(make(1, 2).buildId, make(1).buildId);
    assert.equal(make(42, 3).versionName, 'Build 42.3 (abcdef012345)');
    assert.equal(make(42, 3).tag, 'build-42');
});

test('invalid counters, overflowing components and ambiguous versions fail', () => {
    for (const value of [0, -1, '01', '1.5', 'NaN', 'Infinity', 4294967296]) assert.throws(() => make(value));
    for (const value of [0, '01', 65536]) assert.throws(() => make(1, value));
    for (const value of ['0', '0.0.0.0', '01.2', '2.65536', '2.1.2.3.4', '2.1-beta', '2\n']) {
        assert.throws(() => validateVersion(value));
    }
});

test('numbered builds cannot hide modified, missing or mismatched source', () => {
    assert.throws(() => make(1, 1, { git: { commit, dirty: true } }), /clean Git checkout/);
    assert.throws(() => make(1, 1, { git: { commit: null, dirty: null } }), /clean Git checkout/);
    assert.throws(() => make(1, 1, { git: { commit: 'b'.repeat(40), dirty: false } }), /GITHUB_SHA/);
    assert.throws(() => make(1, 1, { versionOverride: '9.0' }), /cannot be overridden/);
});

test('local builds identify modified source and support explicit legacy numeric versions', () => {
    const info = createBuildInfo({ env: {}, git: { commit, dirty: true }, versionOverride: '7.12' });
    assert.equal(info.version, '7.12');
    assert.equal(info.buildId, 'local-abcdef012345-dirty');
    assert.match(info.versionName, /modified/);
    const archive = createBuildInfo({ env: {}, git: { commit: null, dirty: null } });
    assert.match(archive.versionName, /source-archive/);
    assert.equal(archive.sequence, null);
});

test('packaging verifier rejects stale identity, wrong browser bundle and nested manifests', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'namida-build-test-'));
    const info = { ...make(42), browser: 'chrome', paddleOcrModelVariant: 'server' };
    const write = (name, value) => {
        const target = path.join(directory, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
    };
    try {
        const manifest = { version: info.version, version_name: info.versionName,
            background: { service_worker: 'background/index.js' }, permissions: ['offscreen'] };
        write('manifest.json', manifest);
        write('build-info.json', info);
        write('libs/paddleocr/paddleocr-manifest.json', { variant: 'server' });
        for (const filename of ['ui/index.js', 'ui/popup.html', 'paddle-worker/index.js',
            'libs/paddleocr/detection/v6/det.onnx', 'libs/paddleocr/languages/chinese/rec.onnx']) write(filename, 'fixture');
        assert.equal(verifyExtensionBuild(directory, 'chrome', info).buildId, info.buildId);
        assert.throws(() => verifyExtensionBuild(directory, 'chrome', make(43)), /identity mismatch/);
        write('libs/paddleocr/paddleocr-manifest.json', { variant: 'mobile' });
        assert.throws(() => verifyExtensionBuild(directory, 'chrome', info));
        write('libs/paddleocr/paddleocr-manifest.json', { variant: 'server' });
        write('nested/manifest.json', {});
        assert.throws(() => verifyExtensionBuild(directory, 'chrome', info), /Nested manifest/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
