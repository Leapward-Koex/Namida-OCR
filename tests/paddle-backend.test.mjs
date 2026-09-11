import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const sourceDirectory = new URL('../src/background/ocr/', import.meta.url);
const compilationCache = new Map();

function loadModule(filename, imports = {}, globals = {}) {
    if (!compilationCache.has(filename)) {
        compilationCache.set(filename, ts.transpileModule(readFileSync(new URL(filename, sourceDirectory), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText);
    }
    const context = vm.createContext({
        exports: {}, Float32Array, Uint8ClampedArray, Uint8Array,
        require(name) {
            assert.ok(name in imports, `Unexpected dependency ${name}: the Paddle pipeline must not use shared script-biased scoring or Tesseract inference`);
            return imports[name];
        },
        ...globals,
    });
    vm.runInContext(compilationCache.get(filename), context);
    return context.exports;
}

const modelPipeline = loadModule('PaddleModelPipeline.ts');
const contracts = loadModule('PaddleOnnxModelContract.ts');
const readingOrder = loadModule('PaddleReadingOrder.ts');
const PSM = { AUTO: '3', SINGLE_BLOCK: '6', SINGLE_BLOCK_VERT_TEXT: '5' };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flush() {
    for (let count = 0; count < 40; count += 1) await Promise.resolve();
}

function pixels(width = 64, height = 32, rgb = [255, 0, 64]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) data.set([...rgb, 255], offset);
    return { width, height, data };
}

function box(x = 5, y = 2, width = 40, height = 12, score = 0.9) {
    return { score, points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function harness() {
    const manifest = JSON.parse(readFileSync(new URL('../models/paddleocr/server/manifest.json', import.meta.url)));
    manifest.detector.limit_side_len = 32;
    manifest.detector.max_side_len = 64;
    const dictionary = ['A', '日', '臺', ' '];
    manifest.recognizer.output_classes = dictionary.length + 1;
    const h = {
        manifest, dictionary, events: [], fetches: [], inputs: [], outputs: [], geometryCalls: [], cropCalls: [],
        detectorPlans: [], recognizerPlans: [], runtimePlans: [], pendingOperations: [],
        detections: [box()], image: pixels(), crop: { ...pixels(32, 16), rotated: false },
        fetchFailures: [],
    };

    class Tensor {
        constructor(type, data, dims) {
            Object.assign(this, { type, data, dims, disposals: 0 });
            h.inputs.push(this);
        }
        dispose() { this.disposals += 1; }
    }

    h.output = (dims, data = new Float32Array(dims.reduce((product, value) => product * value, 1))) => {
        const output = { type: 'float32', dims, data, disposals: 0, dispose() { this.disposals += 1; } };
        h.outputs.push(output);
        return output;
    };
    h.recognizedOutput = (text = 'A 日', confidence = 0.9) => {
        // Separate repeated letters with blank, exactly as a CTC path can encode them.
        const classes = dictionary.length + 1;
        const indices = Array.from(text).flatMap(character => [dictionary.indexOf(character) + 1, 0]);
        if (indices.length === 0) indices.push(0);
        const data = new Float32Array(indices.length * classes);
        indices.forEach((selected, timestep) => {
            for (let index = 0; index < classes; index += 1) data[timestep * classes + index] = index === selected ? confidence : (1 - confidence) / (classes - 1);
        });
        return { output: h.output([1, indices.length, classes], data) };
    };

    const sessions = new Map();
    class FakeRuntime {
        async ensureSession(key, path) {
            h.events.push(`ensure:${key}`);
            assert.equal(path, manifest[key].model_path);
            if (!sessions.has(key)) {
                sessions.set(key, {
                    inputNames: ['image'], outputNames: ['output'],
                    async run(feeds) {
                        const input = feeds.image;
                        assert.equal(input.disposals, 0);
                        h.events.push(`inference:${key}`);
                        const plan = h[`${key}Plans`].shift();
                        if (plan) return plan(input);
                        return key === 'detector'
                            ? { output: h.output([1, 1, 4, 8], new Float32Array(32).fill(0.9)) }
                            : h.recognizedOutput();
                    },
                });
            }
            return sessions.get(key);
        }
        async run(key, session, callback) {
            const operation = callback(session);
            h.pendingOperations.push(operation);
            const plan = h.runtimePlans.shift();
            return plan ? plan(operation, key) : operation;
        }
        async setGpuEnabled(enabled) { h.events.push(`gpu:${enabled}`); }
        async terminate() { h.events.push('terminate'); sessions.clear(); }
    }

    const backendModule = loadModule('PaddleOnnxOcrBackend.ts', {
        'webextension-polyfill': { runtime: { getURL: path => `chrome-extension://local/${path}` } },
        'onnxruntime-web': { Tensor },
        'tesseract.js': { PSM },
        './PaddleOnnxRuntime': { PaddleOnnxRuntime: FakeRuntime },
        './PaddleOnnxModelContract': contracts,
        './PaddleModelPipeline': modelPipeline,
        './PaddleDbPostProcess': {
            postProcessDb(...args) {
                h.geometryCalls.push(args);
                assert.equal(h.outputs.find(output => output.data === args[0]).disposals, 0,
                    'output must remain live while DB postprocessing reads it');
                return h.detections;
            },
        },
        './PaddleCropGeometry': { rectifyTextLine(image, points) { h.cropCalls.push({ image, points }); return h.crop; } },
        './PaddleImage': {
            async decodePaddleImage(url) { h.events.push(`decode:${url}`); return h.image; },
            async encodePaddleImage() { h.events.push('encode'); return 'data:image/png;base64,crop'; },
        },
        './PaddleReadingOrder': readingOrder,
    }, {
        console: { debug() {} }, performance: { now: () => 100 },
        async fetch(url) {
            h.fetches.push(url);
            const failure = h.fetchFailures.shift();
            if (failure) return { ok: false, status: failure };
            return {
                ok: true,
                async json() { return manifest; },
                async text() { return `${dictionary.join('\n')}\n`; },
            };
        },
    });
    h.backend = new backendModule.PaddleOnnxOcrBackend();
    h.createBackend = () => new backendModule.PaddleOnnxOcrBackend();
    return h;
}

test('runs one detector and one recognizer per detected line using real BGR/CTC contracts', async () => {
    const h = harness();
    h.detections = [box(5, 17), box(5, 2)];
    h.recognizerPlans.push(() => h.recognizedOutput('A 日'), () => h.recognizedOutput('臺 A'));
    assert.equal(await h.backend.recognize('data:image/png;base64,source', PSM.AUTO), 'A 日\n臺 A');
    assert.equal(h.events.filter(event => event === 'inference:detector').length, 1);
    assert.equal(h.events.filter(event => event === 'inference:recognizer').length, 2);
    assert.equal(h.geometryCalls.length, 1);
    const [, mapWidth, mapHeight, sourceWidth, sourceHeight, options] = h.geometryCalls[0];
    assert.deepEqual([mapWidth, mapHeight, sourceWidth, sourceHeight], [8, 4, 64, 32]);
    assert.deepEqual(plain(options), { threshold: 0.2, boxThreshold: 0.45, unclipRatio: 1.4, maxCandidates: 3000 });
    assert.equal(h.cropCalls[0].points, h.detections[1].points);
    assert.equal(h.inputs[1].dims[3], 320);
    assert.equal(h.inputs[1].data[0], Math.fround(64 / 127.5 - 1));
    assert.equal(h.inputs[1].data[96], 0, 'recognition padding must be normalized zero');
    assert.ok(h.inputs.every(input => input.disposals === 1));
    assert.ok(h.outputs.every(output => output.disposals === 1));
    assert.ok(!h.events.includes('encode'), 'debug image encoding is optional');
    assert.ok(h.fetches.every(url => url.startsWith('chrome-extension://local/libs/paddleocr/')));
});

test('a blank detection map returns empty text without whole-crop recognition or recovery', async () => {
    const h = harness();
    h.detections = [];
    h.backend.setDebugEnabled(true);
    assert.equal(await h.backend.recognize('data:image/png;base64,blank', PSM.AUTO), '');
    assert.equal(h.inputs.length, 1);
    assert.equal(h.cropCalls.length, 0);
    assert.equal(h.events.filter(event => event === 'inference:recognizer').length, 0);
    const snapshot = h.backend.getLastDebugSnapshot();
    assert.equal(snapshot.pipeline.detectorRuns, 1);
    assert.equal(snapshot.pipeline.recognitionRuns, 0);
    assert.deepEqual(plain(snapshot.pipeline.recovery), []);
    assert.equal(snapshot.candidates.selected, null);
    assert.equal(snapshot.fullCrop, null);
    assert.deepEqual(plain(snapshot.projectedGroups), []);
});

test('debug records quadrilaterals and calibrated confidence with raw multilingual text/spaces', async () => {
    const h = harness();
    h.backend.setDebugEnabled(true);
    h.crop.rotated = true;
    h.recognizerPlans.push(() => h.recognizedOutput(' 臺 A ', 0.8));
    const text = await h.backend.recognize('data:image/png;base64,colored', PSM.AUTO);
    assert.equal(text, ' 臺 A ');
    const snapshot = h.backend.getLastDebugSnapshot();
    assert.equal(snapshot.workingImageDataUrl, 'data:image/png;base64,colored');
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(snapshot.candidates.selected.text, text);
    assert.ok(Math.abs(snapshot.candidates.selected.confidence - 80) < 1e-4);
    assert.equal(snapshot.candidates.fullCrop, null);
    assert.equal(snapshot.candidates.projected, null);
    const group = snapshot.detectedGroups[0];
    assert.equal(group.box.points, h.detections[0].points);
    assert.equal(group.box.averageScore, 0.9);
    assert.equal(group.attempts.length, 1);
    assert.equal(group.attempts[0].rotated, true);
    assert.equal(group.attempts[0].tokens[0].text, ' ');
    assert.ok(Math.abs(group.attempts[0].tokens[0].confidence - 0.8) < 1e-6);
    assert.deepEqual(plain(group.attempts[0].inputShape), [1, 3, 48, 320]);
    h.backend.setDebugEnabled(false);
    assert.equal(h.backend.getLastDebugSnapshot(), null);
});

test('recognition threshold rejects a line without attempting transformed or whole-crop alternatives', async () => {
    const h = harness();
    h.manifest.recognizer.score_threshold = 0.95;
    h.backend.setDebugEnabled(true);
    assert.equal(await h.backend.recognize('data:image/png;base64,low-confidence', PSM.AUTO), '');
    const snapshot = h.backend.getLastDebugSnapshot();
    assert.equal(snapshot.pipeline.recognitionRuns, 1);
    assert.equal(snapshot.detectedGroups[0].selectedCandidate, null);
    assert.equal(snapshot.detectedGroups[0].attempts[0].selected, false);
});

test('explicit horizontal/vertical segmentation affects ordering but never adds recognizer attempts', async () => {
    for (const [mode, firstX] of [[PSM.SINGLE_BLOCK, 5], [PSM.SINGLE_BLOCK_VERT_TEXT, 35]]) {
        const h = harness();
        h.detections = [box(5, 2, 10, 20), box(35, 2, 10, 20)];
        await h.backend.recognize('data:image/png;base64,directions', mode);
        assert.equal(h.cropCalls[0].points[0].x, firstX);
        assert.equal(h.inputs.length, 3);
    }
});

test('requests across instances own the sessions until complete; GPU changes and termination are queued', async () => {
    const h = harness();
    const pending = deferred();
    h.detectorPlans.push(() => pending.promise);
    const first = h.backend.recognize('data:image/png;base64,first', PSM.AUTO);
    const second = h.createBackend().recognize('data:image/png;base64,second', PSM.AUTO);
    const gpu = h.backend.setGpuEnabled(false);
    const termination = h.backend.terminate();
    await flush();
    assert.equal(h.events.filter(event => event.startsWith('decode:')).length, 1);
    assert.ok(!h.events.includes('gpu:false'));
    assert.ok(!h.events.includes('terminate'));
    assert.equal(h.inputs[0].disposals, 0);
    pending.resolve({ output: h.output([1, 1, 4, 8]) });
    assert.equal(await first, 'A 日');
    assert.equal(await second, 'A 日');
    await Promise.all([gpu, termination]);
    assert.ok(h.events.indexOf('gpu:false') > h.events.lastIndexOf('inference:recognizer'));
    assert.ok(h.events.indexOf('terminate') > h.events.indexOf('gpu:false'));
});

test('a failed inference disposes its input and does not poison subsequent queued requests', async () => {
    const h = harness();
    h.detectorPlans.push(async () => { throw new Error('inference failed'); });
    const failed = h.backend.recognize('data:image/png;base64,broken', PSM.AUTO);
    const next = h.backend.recognize('data:image/png;base64,valid', PSM.AUTO);
    await assert.rejects(failed, /inference failed/);
    assert.equal(await next, 'A 日');
    assert.ok(h.inputs.every(input => input.disposals === 1));
});

test('malformed model output fails explicitly and disposes all outputs before the next request', async () => {
    const h = harness();
    h.detectorPlans.push(() => ({ output: h.output([1, 2, 4, 8]), auxiliary: h.output([1]) }));
    await assert.rejects(h.backend.recognize('data:image/png;base64,bad-shape', PSM.AUTO), /model contract mismatch/);
    assert.equal(h.inputs[0].disposals, 1);
    assert.ok(h.outputs.every(output => output.disposals === 1));
    assert.equal(h.cropCalls.length, 0);
    assert.equal(await h.backend.recognize('data:image/png;base64,valid', PSM.AUTO), 'A 日');
});

test('timeout wrappers never dispose tensors while the actual session inference is still running', async () => {
    const h = harness();
    const inference = deferred();
    const timeout = deferred();
    h.detectorPlans.push(() => inference.promise);
    h.runtimePlans.push((operation) => {
        // This is the runtime's timeout boundary; the real operation remains alive.
        operation.catch(() => {});
        return timeout.promise;
    });
    const request = h.backend.recognize('data:image/png;base64,slow', PSM.AUTO);
    await flush();
    timeout.reject(new Error('accelerated inference timed out'));
    await assert.rejects(request, /timed out/);
    assert.equal(h.inputs[0].disposals, 0);
    const lateOutput = h.output([1, 1, 4, 8]);
    inference.resolve({ output: lateOutput });
    await h.pendingOperations[0];
    assert.equal(h.inputs[0].disposals, 1);
    assert.equal(lateOutput.disposals, 1);
});

test('failed local asset loading is retryable and init shares the subsequent cached assets', async () => {
    const h = harness();
    h.fetchFailures.push(503);
    await assert.rejects(h.backend.init(), /local PaddleOCR manifest: 503/);
    await h.backend.init();
    const fetchCount = h.fetches.length;
    await h.backend.init();
    assert.equal(h.fetches.length, fetchCount);
    assert.equal(h.inputs.length, 0);
    assert.ok(h.events.includes('ensure:detector'));
    assert.ok(h.events.includes('ensure:recognizer'));
});

test('old RGB metadata is rejected before inference rather than silently using an incompatible contract', async () => {
    const h = harness();
    h.manifest.detector.channel_order = 'RGB';
    await assert.rejects(h.backend.recognize('data:image/png;base64,source', PSM.AUTO), /supported PP-OCRv6 inference contract/);
    assert.equal(h.inputs.length, 0);
});
