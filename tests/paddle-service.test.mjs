import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(relativePath, dependencies = {}, globals = {}) {
    const compiled = ts.transpileModule(readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const context = vm.createContext({
        exports: {},
        require(name) {
            if (name in dependencies) return dependencies[name];
            throw new Error(`Unexpected import ${name}`);
        },
        ...globals,
    });
    vm.runInContext(compiled, context);
    return context.exports;
}

function deferred() {
    let resolve;
    const promise = new Promise((yes) => { resolve = yes; });
    return { promise, resolve };
}

const settings = (paddleGpuEnabled, backend = 'paddleonnx') => ({ backend, paddleGpuEnabled });

function harness({ recognize, failSetup = false } = {}) {
    const instances = [];
    const events = [];
    let imports = 0;
    class MockBackend {
        constructor() {
            this.id = instances.length + 1;
            this.gpuEnabled = null;
            this.debugEnabled = false;
            this.snapshot = null;
            this.status = { requestedGpu: true, state: 'ready', provider: 'webgpu', successfulInferences: 1 };
            instances.push(this);
            events.push(`create:${this.id}`);
        }
        async init() {}
        async setDebugEnabled(enabled) { this.debugEnabled = enabled; }
        async setGpuEnabled(enabled) {
            this.gpuEnabled = enabled;
            if (failSetup && this.id === 1) throw new Error('setup failed');
        }
        async recognize(request) {
            events.push(`start:${request}`);
            await recognize?.(request, this);
            if (request === 'fail') throw new Error('inference failed');
            this.snapshot = this.debugEnabled ? { request } : null;
            events.push(`end:${request}`);
            return `${request}:${this.gpuEnabled}`;
        }
        getLastDebugSnapshot() { return this.snapshot; }
        getAccelerationStatus() { return this.status; }
        async retryGpu() { events.push(`retry:${this.id}`); }
        async terminate() { events.push(`terminate:${this.id}`); }
    }
    const selectable = load('background/ocr/RuntimeSelectableOcrBackend.ts', {
        '../../interfaces/Storage': {
            DEFAULT_OCR_BACKEND: 'tesseract',
            Settings: { async getOcrBackend() { return 'paddleonnx'; }, async getPaddleOnnxGpuEnabled() { return true; } },
        },
        './PaddleOnnxOcrBackend': { PaddleOnnxOcrBackend: MockBackend },
        './TesseractOcrBackend': { TesseractOcrBackend: MockBackend },
    });
    const dependencies = {};
    Object.defineProperty(dependencies, 'namida-ocr-backend', { get() { imports++; return selectable; } });
    const { OcrService } = load('background/ocr/OcrService.ts', dependencies);
    return { service: OcrService, Selector: selectable.RuntimeSelectableOcrBackend, instances, events, get imports() { return imports; } };
}

test('concurrent requests retain their GPU settings and terminate the old backend after inference', async () => {
    const h = harness();
    assert.deepEqual(await Promise.all([
        h.service.recognize('off', '3', 'jpn_vert', settings(false)),
        h.service.recognize('on', '3', 'jpn_vert', settings(true)),
    ]), ['off:false', 'on:true']);
    assert.equal(h.imports, 1);
    assert.equal(h.instances.length, 2);
    assert.ok(h.events.indexOf('terminate:1') > h.events.indexOf('end:off'));
});

test('concurrent identical requests share one selected backend', async () => {
    const h = harness();
    await Promise.all(['first', 'second'].map((name) => h.service.recognize(name, '3', 'jpn_vert', settings(false))));
    assert.equal(h.instances.length, 1);
    assert.ok(h.events.indexOf('end:first') < h.events.indexOf('start:second'));
});

test('queued requests copy settings before the caller can mutate its object', async () => {
    const h = harness();
    const requestSettings = settings(false);
    const result = h.service.recognize('immutable', '3', 'jpn_vert', requestSettings);
    requestSettings.paddleGpuEnabled = true;
    assert.equal(await result, 'immutable:false');
});

test('selector independently serializes requests and captures overrides before queuing', async () => {
    const h = harness();
    const selector = new h.Selector();
    await selector.setRuntimeSettings(settings(false));
    const first = selector.recognize('off', '3');
    await selector.setRuntimeSettings(settings(true));
    const second = selector.recognize('on', '3');
    assert.deepEqual(await Promise.all([first, second]), ['off:false', 'on:true']);
    await Promise.all([selector.recognize('same-a', '3'), selector.recognize('same-b', '3')]);
    assert.equal(h.instances.length, 2);
});

test('each concurrent result contains its own debug snapshot and debug preference', async () => {
    const h = harness();
    const [first, second, third] = await Promise.all([
        h.service.recognizeWithDebug('first', '3', 'jpn_vert', settings(true), true),
        h.service.recognizeWithDebug('second', '3', 'jpn_vert', settings(true), false),
        h.service.recognizeWithDebug('third', '3', 'jpn_vert', settings(true), true),
    ]);
    assert.equal(first.debugSnapshot.request, 'first');
    assert.equal(second.debugSnapshot, null);
    assert.equal(third.debugSnapshot.request, 'third');
    assert.equal((await h.service.getLastDebugSnapshot()).request, 'third');
});

test('termination and GPU retry wait for recognition and a following request can initialize again', async () => {
    const started = deferred();
    const release = deferred();
    const h = harness({ async recognize(request) { if (request === 'blocked') { started.resolve(); await release.promise; } } });
    const active = h.service.recognize('blocked', '3', 'jpn_vert', settings(true));
    await started.promise;
    const retry = h.service.retryGpu();
    const terminate = h.service.terminate();
    assert.equal(h.events.some((event) => event.startsWith('retry:') || event.startsWith('terminate:')), false);
    release.resolve();
    await Promise.all([active, retry, terminate]);
    assert.ok(h.events.indexOf('retry:1') > h.events.indexOf('end:blocked'));
    assert.ok(h.events.indexOf('terminate:1') > h.events.indexOf('retry:1'));
    await h.service.recognize('new', '3', 'jpn_vert', settings(true));
    assert.equal(h.instances.length, 2);
});

test('status and retry do not import or construct an unused backend', async () => {
    const h = harness();
    assert.equal(await h.service.getAccelerationStatus(), null);
    assert.equal(await h.service.getLastDebugSnapshot(), null);
    await h.service.retryGpu();
    assert.equal(h.imports, 0);
    assert.equal(h.instances.length, 0);
});

test('status remains readable during an active scan', async () => {
    const started = deferred();
    const release = deferred();
    const h = harness({ async recognize() { started.resolve(); await release.promise; } });
    const scan = h.service.recognize('blocked', '3', 'jpn_vert', settings(true));
    await started.promise;
    assert.equal((await h.service.getAccelerationStatus()).provider, 'webgpu');
    release.resolve();
    await scan;
});

test('inference failure clears the prior snapshot and does not poison later requests', async () => {
    const h = harness();
    await h.service.recognizeWithDebug('before', '3', 'jpn_vert', settings(true), true);
    await assert.rejects(h.service.recognizeWithDebug('fail', '3', 'jpn_vert', settings(true), true), /inference failed/);
    assert.equal(await h.service.getLastDebugSnapshot(), null);
    assert.equal(await h.service.recognize('after', '3', 'jpn_vert', settings(false)), 'after:false');
});

test('failed backend configuration releases that backend and allows the next request to recover', async () => {
    const h = harness({ failSetup: true });
    await assert.rejects(h.service.recognize('first', '3', 'jpn_vert', settings(true)), /setup failed/);
    assert.ok(h.events.includes('terminate:1'));
    assert.equal(await h.service.recognize('second', '3', 'jpn_vert', settings(true)), 'second:true');
});

const { describePaddleAcceleration: describe } = load('ui/OcrAccelerationStatus.ts');

test('GPU status does not claim acceleration until inference has succeeded', () => {
    assert.match(describe(null, true).text, /next scan/);
    const status = { requestedGpu: true, state: 'ready', provider: 'webgpu', successfulInferences: 0 };
    assert.match(describe(status, true).text, /initialized/);
    assert.match(describe({ ...status, successfulInferences: 1 }, true).text, /working/);
});

test('GPU retry is offered for fallback, with preference changes distinguished from current execution', () => {
    const status = { requestedGpu: true, state: 'ready', provider: 'wasm', fallbackReason: 'Adapter unavailable' };
    assert.equal(describe(status, true).retryAvailable, true);
    assert.match(describe(status, true).text, /CPU \(WASM\)/);
    assert.equal(describe(status, true).detail, 'Adapter unavailable');
    assert.equal(describe(status, false).retryAvailable, false);
    assert.match(describe(status, false).text, /changed GPU preference/);
    assert.equal(describe({ ...status, requestedGpu: false, fallbackReason: undefined }, false).retryAvailable, false);
});

test('initializing and failed GPU states remain distinct from a working provider', () => {
    assert.match(describe({ requestedGpu: true, state: 'initializing' }, true).text, /Checking GPU/);
    const failure = describe({ requestedGpu: true, state: 'failed', provider: 'webgpu', lastError: 'GPU lost' }, true);
    assert.match(failure.text, /could not/);
    assert.equal(failure.detail, 'GPU lost');
});

const messageModule = load('interfaces/message.ts');
const actions = messageModule.NamidaMessageAction;

function backgroundHarness({ hasDocument = false, direct = false } = {}) {
    let listener;
    const sent = [];
    const calls = [];
    const status = { requestedGpu: true, state: 'ready', provider: 'webgpu' };
    const snapshot = { request: 'owned' };
    const runtime = {
        getURL: (path) => `extension://local/${path}`,
        onMessage: { addListener(callback) { listener = callback; } },
        async sendMessage(message) { sent.push(message); return status; },
    };
    const service = {
        async init() { calls.push('init'); },
        async getAccelerationStatus() { calls.push('status'); return status; },
        async retryGpu() { calls.push('retry'); },
        async recognizeWithDebug(...args) { calls.push(args); return { recognizedText: 'owned', debugSnapshot: snapshot }; },
    };
    load('background/index.ts', {
        'webextension-polyfill': { runtime, commands: { onCommand: { addListener() {} } }, tabs: {} },
        'tesseract.js': { PSM: { AUTO: '3' } },
        '../interfaces/message': messageModule,
        './Upscaler': { Upscaler: {} },
        '../interfaces/Storage': { Settings: {
            async getOcrDebugArtifacts() { return true; },
            async getOcrModel() { return 'jpn_vert'; },
            async getOcrBackend() { return 'paddleonnx'; },
            async getPaddleOnnxGpuEnabled() { return false; },
        } },
        './FuriganaHandler': { FuriganaHandler: {} },
        'namida-background-ocr-service': { BackgroundOcrService: service },
    }, {
        console: { log() {}, debug() {}, error() {} },
        Worker: direct ? function Worker() {} : undefined,
        chrome: { offscreen: {
            async hasDocument() { return hasDocument; },
            async createDocument() { throw new Error('Status must not create an offscreen document'); },
        } },
    });
    return { dispatch: (action, data) => listener({ action, data }, {}), sent, calls, status, snapshot };
}

test('Chromium status and retry leave an unused offscreen host uncreated', async () => {
    const h = backgroundHarness();
    assert.equal(await h.dispatch(actions.GetOcrAccelerationStatus), null);
    assert.equal(await h.dispatch(actions.RetryOcrGpu), null);
    assert.equal(h.sent.length, 0);
    assert.equal(h.calls.length, 0);
});

test('Chromium status and retry route to an existing offscreen document', async () => {
    const h = backgroundHarness({ hasDocument: true });
    assert.equal(await h.dispatch(actions.GetOcrAccelerationStatus), h.status);
    assert.equal(await h.dispatch(actions.RetryOcrGpu), h.status);
    assert.deepEqual(h.sent.map((message) => message.action), [actions.GetOcrAccelerationStatusOffscreen, actions.RetryOcrGpuOffscreen]);
});

test('Firefox routes status directly and retains the snapshot returned by atomic recognition', async () => {
    const h = backgroundHarness({ direct: true });
    assert.equal(await h.dispatch(actions.GetOcrAccelerationStatus), h.status);
    assert.equal(await h.dispatch(actions.RetryOcrGpu), h.status);
    assert.equal(await h.dispatch(actions.RecognizeImage, 'pixels'), 'owned');
    const args = h.calls.find(Array.isArray);
    assert.equal(args[0], 'pixels');
    assert.equal(args[3].paddleGpuEnabled, false);
    assert.equal(args[4], true);
    assert.equal(await h.dispatch(actions.GetLastOcrDebugSnapshot), h.snapshot);
    assert.equal(h.sent.length, 0);
});

test('offscreen recognition passes settings and debug capture in one service call', async () => {
    let listener;
    const calls = [];
    const result = { recognizedText: 'owned', debugSnapshot: { request: 'owned' } };
    const status = { provider: 'wasm' };
    load('offscreen/index.ts', {
        'webextension-polyfill': { runtime: { onMessage: { addListener(callback) { listener = callback; } } } },
        '../interfaces/message': messageModule,
        '../background/FuriganaHandler': { FuriganaHandler: {} },
        '../background/ocr/OcrService': { OcrService: {
            async recognizeWithDebug(...args) { calls.push(args); return result; },
            async getAccelerationStatus() { calls.push('status'); return status; },
            async retryGpu() { calls.push('retry'); },
        } },
    }, { console: { debug() {} } });
    assert.equal(await listener({ action: actions.RecognizeImageOffscreen, data: {
        imageData: 'pixels', pageSegMode: '3', ocrModel: 'jpn_vert', debugArtifactsEnabled: true,
        runtimeSettings: { ocrBackend: 'paddleonnx', paddleGpuEnabled: false },
    } }), result);
    assert.equal(calls[0][3].paddleGpuEnabled, false);
    assert.equal(calls[0][4], true);
    assert.equal(await listener({ action: actions.GetOcrAccelerationStatusOffscreen }), status);
    assert.equal(await listener({ action: actions.RetryOcrGpuOffscreen }), status);
    assert.deepEqual(calls.slice(1), ['status', 'retry', 'status']);
});
