import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveOcrBaseline } from '../scripts/resolve-ocr-baseline.mjs';
import { checkDatasetCompatibility, readOcrCases } from '../scripts/check-ocr-dataset-compatibility.mjs';
import { parseDatasetArgs, runOcrDataset } from '../scripts/run-ocr-dataset.mjs';

const candidate = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const defaultTip = 'c'.repeat(40);
const mergeBase = 'd'.repeat(40);

function fakeGit(responses) {
    return (...args) => {
        const key = args.join(' ');
        if (!Object.hasOwn(responses, key)) throw new Error(`Commit unavailable: ${key}`);
        return responses[key];
    };
}

test('PR comparisons use the immutable base SHA merge base, and pushes use the pre-push tip', () => {
    const git = fakeGit({
        'rev-parse --verify HEAD^{commit}': candidate,
        [`merge-base ${candidate} ${defaultTip}`]: mergeBase,
        [`rev-parse --verify ${previous}^{commit}`]: previous,
    });
    assert.equal(resolveOcrBaseline({ eventName: 'pull_request', baseSha: defaultTip }, git).baseline, mergeBase);
    assert.equal(resolveOcrBaseline({ eventName: 'push', before: previous }, git).baseline, previous);
});

test('new-branch and manual runs use the default merge base, or the first parent when identical', () => {
    const responses = {
        'rev-parse --verify HEAD^{commit}': candidate,
        'rev-parse --verify refs/remotes/origin/master^{commit}': defaultTip,
        [`merge-base ${candidate} ${defaultTip}`]: mergeBase,
        'rev-parse --verify HEAD^1^{commit}': previous,
    };
    assert.equal(resolveOcrBaseline({ eventName: 'push', before: '0'.repeat(40), defaultBranch: 'master' }, fakeGit(responses)).baseline, mergeBase);
    assert.equal(resolveOcrBaseline({ eventName: 'workflow_dispatch', defaultBranch: 'master' }, fakeGit({
        ...responses, [`merge-base ${candidate} ${defaultTip}`]: candidate,
    })).baseline, previous);
});

test('an unavailable, identical, or malformed baseline fails closed', () => {
    const git = fakeGit({ 'rev-parse --verify HEAD^{commit}': candidate, [`rev-parse --verify ${candidate}^{commit}`]: candidate });
    assert.throws(() => resolveOcrBaseline({ eventName: 'push', before: previous }, git), /unavailable/);
    assert.throws(() => resolveOcrBaseline({ eventName: 'push', before: candidate }, git), /distinct/);
    assert.throws(() => resolveOcrBaseline({ eventName: 'pull_request', baseSha: '--bad' }, git), /base commit SHA/);
    assert.throws(() => resolveOcrBaseline({ eventName: 'workflow_dispatch', defaultBranch: 'master' }, git), /unavailable/);
});

async function temporaryRoot(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'namida-accuracy-gate-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

const fixtureCase = { name: 'original-one', image: 'images/sample.png', expectedText: '日本語 123', upscalingMode: 'none' };

async function writeDataset(root, cases, imageBytes = 'same fixture bytes') {
    await fs.mkdir(path.join(root, 'tests', 'fixtures', 'images'), { recursive: true });
    await fs.writeFile(path.join(root, 'tests', 'ocr-cases.ts'), `export const ocrCases: OcrCase[] = ${JSON.stringify(cases)};`);
    await fs.writeFile(path.join(root, 'tests', 'fixtures', 'images', 'sample.png'), imageBytes);
}

test('dataset preflight preserves old labels/settings/bytes while allowing new cases', async (t) => {
    const root = await temporaryRoot(t);
    const baseline = path.join(root, 'baseline');
    const actual = path.join(root, 'candidate');
    await writeDataset(baseline, [fixtureCase]);
    await writeDataset(actual, [fixtureCase, { ...fixtureCase, name: 'general-new' }]);
    assert.deepEqual(await checkDatasetCompatibility(baseline, actual), { baselineCases: 1, addedCases: 1 });
    for (const [field, value] of [['expectedText', '日本語123'], ['upscalingMode', 'canvas'], ['image', 'images/renamed.png']]) {
        await writeDataset(actual, [{ ...fixtureCase, [field]: value }]);
        await assert.rejects(checkDatasetCompatibility(baseline, actual), new RegExp(`${field} changed`));
    }
    await writeDataset(actual, []);
    await assert.rejects(checkDatasetCompatibility(baseline, actual), /removed/);
    await writeDataset(actual, [fixtureCase], 'replaced fixture bytes');
    await assert.rejects(checkDatasetCompatibility(baseline, actual), /image bytes changed/);
});

test('dataset declarations cannot execute code or use duplicate names or escaped image paths', async (t) => {
    assert.throws(() => readOcrCases('export const ocrCases = getCases();'), /static array/);
    assert.throws(() => readOcrCases('export const ocrCases = [{ ...other }];'), /literal names/);
    assert.throws(() => readOcrCases(`export const ocrCases = ${JSON.stringify([fixtureCase, fixtureCase])};`), /Duplicate/);
    const root = await temporaryRoot(t);
    await writeDataset(root, [{ ...fixtureCase, image: '../outside.png' }]);
    await assert.rejects(checkDatasetCompatibility(root, root), /outside tests\/fixtures/);
});

test('dataset output directories cannot escape or overlap temporary output', () => {
    for (const directory of ['..', '.', 'ocr-debug/nested', 'ocr-case-results', '.playwright-artifacts/nested']) {
        assert.throws(() => parseDatasetArgs(['--build-dir', 'dist', '--results-subdir', directory]), /subdirectory|overlap/);
    }
    assert.throws(() => parseDatasetArgs(['--build-dir', 'dist', '--results-subdir', 'runs/before', '--backend', 'invalid']), /backend/);
});

test('paired dataset runs enforce identical fixture/CPU settings and preserve each run including failures', async (t) => {
    const root = await temporaryRoot(t);
    const beforeBuild = path.join(root, 'before-build');
    const afterBuild = path.join(root, 'after-build');
    for (const build of [beforeBuild, afterBuild]) {
        await fs.mkdir(build);
        await fs.writeFile(path.join(build, 'manifest.json'), '{}');
        await fs.writeFile(path.join(build, 'build-info.json'), JSON.stringify({ commit: build === beforeBuild ? previous : candidate, browser: 'chrome', ocrBackend: 'paddleonnx', ocrModel: 'jpn_vert', paddleOcrModelVariant: 'server' }));
    }
    await writeDataset(root, [fixtureCase]);
    const resultsRoot = path.join(root, 'test-results');
    const commands = [];
    let testFailure = false;
    const execute = async (command, args, options) => {
        commands.push({ command, args, ...options });
        if (args.includes('test')) {
            await fs.mkdir(path.join(resultsRoot, 'ocr-debug'), { recursive: true });
            await fs.writeFile(path.join(resultsRoot, 'ocr-debug', 'snapshot.json'), JSON.stringify({ build: options.env.NAMIDA_TEST_BUILD_DIR }));
            return testFailure ? 1 : 0;
        }
        await fs.writeFile(path.join(resultsRoot, 'ocr-accuracy-summary.json'), JSON.stringify({ cases: [{ name: fixtureCase.name }] }));
        return 0;
    };
    const env = { NAMIDA_TEST_OCR_INPUT_MODE: 'snip', NAMIDA_TEST_PADDLE_GPU_ENABLED: '1', NAMIDA_TEST_REQUIRE_WEBGPU: '1', PLAYWRIGHT_WORKERS: '1' };
    const run = (build, label) => runOcrDataset(parseDatasetArgs(['--build-dir', build, '--results-subdir', `paired/${label}`], root), { cwd: root, env, execute });
    assert.equal(await run(beforeBuild, 'before'), 0);
    testFailure = true;
    assert.equal(await run(afterBuild, 'after'), 1);
    for (const invocation of commands) {
        assert.equal(invocation.env.NAMIDA_TEST_OCR_INPUT_MODE, 'fixture');
        assert.equal(invocation.env.NAMIDA_TEST_PADDLE_GPU_ENABLED, '0');
        assert.equal(invocation.env.NAMIDA_TEST_REQUIRE_WEBGPU, '0');
        assert.equal(invocation.env.PLAYWRIGHT_WORKERS, '5');
    }
    assert.deepEqual(commands[0].args.slice(1), ['test', 'tests/extension.spec.ts', '--project', 'chromium-extension', '--workers', '5']);
    for (const [label, build, exitCode] of [['before', beforeBuild, 0], ['after', afterBuild, 1]]) {
        const destination = path.join(resultsRoot, 'paired', label);
        const summary = JSON.parse(await fs.readFile(path.join(destination, 'ocr-accuracy-summary.json')));
        assert.equal(summary.run.provider, 'wasm');
        assert.equal(summary.run.exitCode, exitCode);
        assert.equal(summary.run.buildDir, build);
        assert.equal(summary.paddleOnnxModelVariant, 'server');
        assert.equal(JSON.parse(await fs.readFile(path.join(destination, 'build-info.json'))).commit, label === 'before' ? previous : candidate);
        assert.equal(JSON.parse(await fs.readFile(path.join(destination, 'ocr-debug', 'snapshot.json'))).build, build);
    }
});

test('a successful process without an OCR summary still fails the dataset run', async (t) => {
    const root = await temporaryRoot(t);
    await fs.mkdir(path.join(root, 'dist'));
    await fs.writeFile(path.join(root, 'dist', 'manifest.json'), '{}');
    await writeDataset(root, [fixtureCase]);
    const options = parseDatasetArgs(['--build-dir', 'dist', '--results-subdir', 'missing-summary'], root);
    assert.equal(await runOcrDataset(options, { cwd: root, env: {}, execute: async () => 0 }), 1);
});

test('missing, duplicated or unexpected cases fail even when Playwright exits successfully', async (t) => {
    const root = await temporaryRoot(t);
    await writeDataset(root, [fixtureCase, { ...fixtureCase, name: 'second' }]);
    await fs.mkdir(path.join(root, 'dist'));
    await fs.writeFile(path.join(root, 'dist', 'manifest.json'), '{}');
    const options = parseDatasetArgs(['--build-dir', 'dist', '--results-subdir', 'incomplete'], root);
    for (const caseNames of [[fixtureCase.name], [fixtureCase.name, fixtureCase.name, 'second'], [fixtureCase.name, 'second', 'unconfigured']]) {
        const execute = async () => {
            await fs.writeFile(path.join(root, 'test-results', 'ocr-accuracy-summary.json'), JSON.stringify({ cases: caseNames.map((name) => ({ name })) }));
            return 0;
        };
        assert.equal(await runOcrDataset(options, { cwd: root, env: {}, execute }), 1);
    }
});

test('spawn failures preserve diagnostics and build metadata, and incompatible builds are rejected', async (t) => {
    const root = await temporaryRoot(t);
    await writeDataset(root, [fixtureCase]);
    const build = path.join(root, 'dist');
    await fs.mkdir(build);
    await fs.writeFile(path.join(build, 'manifest.json'), '{}');
    await fs.writeFile(path.join(build, 'build-info.json'), JSON.stringify({ commit: previous, ocrBackend: 'paddleonnx' }));
    const options = parseDatasetArgs(['--build-dir', 'dist', '--results-subdir', 'spawn-failure'], root);
    const execute = async () => {
        await fs.mkdir(path.join(root, 'test-results', 'ocr-debug'), { recursive: true });
        await fs.writeFile(path.join(root, 'test-results', 'ocr-debug', 'failure.txt'), 'kept');
        throw new Error('spawn ENOENT');
    };
    assert.equal(await runOcrDataset(options, { cwd: root, env: {}, execute }), 1);
    assert.equal(await fs.readFile(path.join(options.resultsDir, 'ocr-debug', 'failure.txt'), 'utf8'), 'kept');
    assert.equal(JSON.parse(await fs.readFile(path.join(options.resultsDir, 'build-info.json'))).commit, previous);
    assert.match(JSON.parse(await fs.readFile(path.join(options.resultsDir, 'ocr-run-metadata.json'))).errors.join('\n'), /spawn ENOENT/);
    await fs.writeFile(path.join(build, 'build-info.json'), JSON.stringify({ ocrBackend: 'tesseract' }));
    await assert.rejects(runOcrDataset(options, { cwd: root, env: {}, execute }), /requires paddleonnx/);
});
