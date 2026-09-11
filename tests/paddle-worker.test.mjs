import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/paddle-worker/worker.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flush() {
    await new Promise(setImmediate);
}

function tensor(data = new Float32Array([0.25, 0.75]), dims = [1, 1, 1, 2], type = 'float32') {
    return { type, data, dims, disposals: 0, dispose() { this.disposals += 1; this.data.fill(0); } };
}

function input(height = 2, width = 2) {
    return { data: new Float32Array(3 * height * width).fill(0.5), dims: [1, 3, height, width] };
}

function session(overrides = {}) {
    return {
        inputNames: ['x'], outputNames: ['output'],
        inputMetadata: [{ name: 'x', isTensor: true, type: 'float32', shape: ['batch', 3, 'height', 'width'] }],
        releases: 0, async release() { this.releases += 1; },
        async run() { return { output: tensor() }; },
        ...overrides,
    };
}

function harness({ gpu = true, adapter = { info: { vendor: 'example', architecture: 'test', isFallbackAdapter: false } } } = {}) {
    const posted = [], creations = [], fetched = [], inputs = [], createPlans = [], fetchPlans = [];
    const lost = deferred();
    const device = { lost: lost.promise };
    let requestId = 0, adapterRequests = 0;
    const scope = {
        location: { href: 'chrome-extension://local/paddle-worker.js' },
        navigator: gpu ? { gpu: { async requestAdapter(options) { adapterRequests += 1; assert.equal(options.powerPreference, 'high-performance'); return adapter; } } } : {},
        onmessage: null,
        async fetch(url) {
            fetched.push(url);
            return fetchPlans.length ? fetchPlans.shift()(url) : { ok: true, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } };
        },
        postMessage(message, transfer = []) {
            posted.push({ message: structuredClone(message, { transfer }), transfers: transfer.length });
        },
    };
    const ort = {
        env: { wasm: {}, webgpu: { device } },
        Tensor: class {
            constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; this.disposals = 0; inputs.push(this); }
            dispose() { this.disposals += 1; }
        },
        InferenceSession: {
            async create(bytes, options) {
                creations.push({ bytes, options });
                return createPlans.length ? createPlans.shift()(bytes, options) : session();
            },
        },
    };
    const context = vm.createContext({ exports: {}, URL, Float32Array, Uint8Array, Error });
    vm.runInContext(compiled, context);
    context.exports.installPaddleWorker(scope, ort);
    function send(request) {
        const id = ++requestId;
        scope.onmessage({ data: { ...request, id } });
        return id;
    }
    const initialize = (provider = 'wasm', models = []) => send({
        type: 'init', provider, models,
        runtimeBaseUrl: 'chrome-extension://local/libs/onnxruntime/', modelBaseUrl: 'chrome-extension://local/libs/paddleocr/',
    });
    const run = (overrides = {}) => send({ type: 'run', key: 'detector', modelPath: 'detection/model.onnx', input: input(), ...overrides });
    function response(id) {
        const found = posted.find(item => item.message.id === id);
        assert.ok(found, `Expected worker response ${id}; got ${JSON.stringify(posted)}`);
        return found.message;
    }
    return { scope, ort, posted, creations, fetched, inputs, createPlans, fetchPlans, lost, device, send, initialize, run, response,
        get adapterRequests() { return adapterRequests; } };
}

test('configures extension-local JSEP assets and one WASM thread without touching WebGPU', async () => {
    const h = harness();
    const id = h.initialize();
    await flush();
    assert.equal(h.response(id).type, 'initialized');
    assert.equal(h.response(id).diagnostics.provider, 'wasm');
    assert.equal(h.ort.env.wasm.proxy, false);
    assert.equal(h.ort.env.wasm.numThreads, 1);
    assert.equal(h.ort.env.wasm.wasmPaths.mjs, 'chrome-extension://local/libs/onnxruntime/ort-wasm-simd-threaded.jsep.mjs');
    assert.equal(h.ort.env.wasm.wasmPaths.wasm, 'chrome-extension://local/libs/onnxruntime/ort-wasm-simd-threaded.jsep.wasm');
    assert.equal(h.adapterRequests, 0);
    assert.equal(h.creations.length, 0);
});

test('repeated matching initialization adds cached models and rejects contradictory providers', async () => {
    const h = harness();
    h.initialize('webgpu', [{ key: 'detector', path: 'detection/model.onnx' }]);
    const repeat = h.initialize('webgpu', [
        { key: 'detector', path: 'detection/model.onnx' }, { key: 'recognizer', path: 'recognition/model.onnx' },
    ]);
    const changed = h.initialize('wasm');
    await flush();
    assert.equal(h.response(repeat).type, 'initialized');
    assert.deepEqual(h.response(repeat).diagnostics.sessionKeys, ['detector', 'recognizer']);
    assert.equal(h.creations.length, 2);
    assert.equal(h.adapterRequests, 1);
    assert.equal(h.creations[0].options.executionProviders[0].name, 'webgpu');
    assert.equal(h.ort.env.webgpu.adapter.info.vendor, 'example');
    assert.equal(h.response(changed).error.kind, 'input');
});

test('null, absent, and software adapters fail before model loading', async () => {
    for (const options of [{ gpu: false }, { adapter: null }, { adapter: { isFallbackAdapter: true } },
        { adapter: { info: { isFallbackAdapter: true } } }, { adapter: { info: { description: 'Google SwiftShader' } } }]) {
        const h = harness(options);
        const id = h.initialize('webgpu', [{ key: 'detector', path: 'detection/model.onnx' }]);
        await flush();
        assert.equal(h.response(id).error.kind, 'provider');
        assert.equal(h.fetched.length, 0);
    }
});

test('rejects remote assets, another extension, path traversal, and mismatched cached model keys', async () => {
    const h = harness();
    const remote = h.send({ type: 'init', provider: 'wasm', runtimeBaseUrl: 'https://cdn.invalid/', modelBaseUrl: 'chrome-extension://local/libs/paddleocr/' });
    h.initialize();
    const ids = ['https://cdn.invalid/model.onnx', 'chrome-extension://another/libs/paddleocr/model.onnx', '../model.onnx',
        'detection/%2f..%2fmodel.onnx', 'model.onnx?remote=true'].map(modelPath => h.run({ modelPath }));
    const valid = h.run();
    const conflict = h.run({ modelPath: 'recognition/model.onnx' });
    await flush();
    for (const id of [remote, ...ids, conflict]) assert.equal(h.response(id).error.kind, 'input');
    assert.equal(h.response(valid).type, 'result');
    assert.deepEqual(h.fetched, ['chrome-extension://local/libs/paddleocr/detection/model.onnx']);
});

test('accepts full extension-local model URLs and copies output before disposing every tensor', async () => {
    const h = harness();
    const first = tensor(), second = tensor(new Float32Array([0.1]), [1]);
    h.createPlans.push(() => session({ async run(feeds) {
        assert.equal(feeds.x, h.inputs[0]);
        return { output: first, auxiliary: second, sameTensorAlias: second };
    } }));
    h.initialize();
    const id = h.run({ modelPath: 'chrome-extension://local/libs/paddleocr/detection/model.onnx' });
    await flush();
    const result = h.response(id);
    assert.equal(result.type, 'result');
    assert.deepEqual([...result.output.data], [0.25, 0.75]);
    assert.deepEqual(result.output.dims, [1, 1, 1, 2]);
    assert.equal(result.output.type, 'float32');
    assert.equal(first.disposals, 1);
    assert.equal(second.disposals, 1);
    assert.equal(h.inputs[0].disposals, 1);
    assert.deepEqual([...first.data], [0, 0]);
    assert.equal(h.posted.find(item => item.message.id === id).transfers, 1);
    assert.equal(result.diagnostics.successfulInferences, 1);
});

test('serializes commands through actual inference settlement and does not dispose in-flight input', async () => {
    const h = harness();
    const pending = deferred();
    let runs = 0;
    h.createPlans.push(() => session({ async run() { runs += 1; return runs === 1 ? pending.promise : { output: tensor() }; } }));
    h.initialize();
    const first = h.run(), second = h.run();
    await flush();
    assert.equal(runs, 1);
    assert.equal(h.inputs.length, 1);
    assert.equal(h.inputs[0].disposals, 0);
    assert.equal(h.posted.some(item => item.message.id === first), false);
    pending.resolve({ output: tensor() });
    await flush();
    assert.equal(h.response(first).type, 'result');
    assert.equal(h.response(second).type, 'result');
    assert.equal(runs, 2);
    assert.equal(h.inputs[0].disposals, 1);
    assert.equal(h.response(second).diagnostics.successfulInferences, 2);
    assert.equal(h.creations.length, 1);
});

test('malformed and incompatible inputs are input errors without poisoning later requests', async () => {
    const h = harness();
    const beforeInit = h.run();
    h.initialize();
    const malformed = [undefined, { data: new Uint8Array(12), dims: [1, 3, 2, 2] },
        { data: new Float32Array(12), dims: [1, 3, 1, 1] }, { data: new Float32Array(12), dims: [1, 3, -2, -2] }]
        .map(value => h.run({ input: value }));
    h.createPlans.push(() => session({ inputMetadata: [{ name: 'x', isTensor: true, type: 'float32', shape: [1, 3, 48, 'width'] }] }));
    const wrongHeight = h.run();
    const valid = h.run({ input: input(48, 2) });
    await flush();
    for (const id of [beforeInit, ...malformed, wrongHeight]) assert.equal(h.response(id).error.kind, 'input');
    assert.equal(h.response(valid).type, 'result');
    assert.equal(h.inputs.length, 1);
});

test('missing and malformed models are model errors while WebGPU initialization failures are provider errors', async () => {
    const missing = harness();
    missing.fetchPlans.push(async () => ({ ok: false, status: 404 }));
    missing.initialize('webgpu');
    const missingId = missing.run();
    await flush();
    assert.equal(missing.response(missingId).error.kind, 'model');
    assert.equal(missing.creations.length, 0);
    for (const [message, expectedKind] of [['Failed to load model because protobuf parsing failed', 'model'], ['GPUDevice creation failed', 'provider']]) {
        const h = harness();
        h.createPlans.push(() => { throw new Error(message); });
        h.initialize('webgpu');
        const id = h.run();
        await flush();
        assert.equal(h.response(id).error.kind, expectedKind);
    }
});

test('run failure preserves input/provider distinction and releases inputs before later requests', async () => {
    const h = harness();
    let runs = 0;
    h.createPlans.push(() => session({ async run() {
        runs += 1;
        if (runs === 1) throw new Error('Invalid dimensions for input: x');
        if (runs === 2) throw new Error('GPU validation error: command buffer');
        return { output: tensor() };
    } }));
    h.initialize('webgpu');
    const badInput = h.run(), providerFailure = h.run(), valid = h.run();
    await flush();
    assert.equal(h.response(badInput).error.kind, 'input');
    assert.equal(h.response(providerFailure).error.kind, 'provider');
    assert.equal(h.response(valid).type, 'result');
    assert.equal(h.response(valid).diagnostics.successfulInferences, 1);
    assert.ok(h.inputs.every(value => value.disposals === 1));
});

test('WASM engine startup failures remain provider errors rather than model corruption reports', async () => {
    const h = harness({ gpu: false });
    h.createPlans.push(() => { throw new Error('WebAssembly.instantiate(): memory allocation failed'); });
    h.initialize();
    const id = h.run();
    await flush();
    assert.equal(h.response(id).error.kind, 'provider');
    assert.match(h.response(id).error.message, /memory allocation/);
});

test('invalid output type is a model error with all output and input resources disposed', async () => {
    const h = harness();
    const output = tensor(new Float32Array([1]), [1], 'int32');
    h.createPlans.push(() => session({ async run() { return { output }; } }));
    h.initialize();
    const id = h.run();
    await flush();
    assert.equal(h.response(id).error.kind, 'model');
    assert.equal(output.disposals, 1);
    assert.equal(h.inputs[0].disposals, 1);
    assert.equal(h.response(id).diagnostics.successfulInferences, 0);
});

test('observes the actual ORT device, emits fatal loss immediately, and suppresses late inference success', async () => {
    const h = harness();
    const pending = deferred();
    const output = tensor();
    h.createPlans.push(() => session({ async run() { return pending.promise; } }));
    h.initialize('webgpu', [{ key: 'detector', path: 'detection/model.onnx' }]);
    const running = h.run();
    await flush();
    h.lost.resolve({ reason: 'destroyed', message: 'device removed' });
    await flush();
    const fatal = h.posted.find(item => item.message.type === 'fatal').message;
    assert.equal(fatal.error.kind, 'device-lost');
    assert.match(fatal.error.message, /device removed/);
    assert.equal(h.inputs[0].disposals, 0);
    pending.resolve({ output });
    const later = h.run();
    await flush();
    assert.equal(h.response(running).error.kind, 'device-lost');
    assert.equal(h.response(later).error.kind, 'device-lost');
    assert.equal(output.disposals, 1);
    assert.equal(h.inputs[0].disposals, 1);
    assert.equal(h.posted.filter(item => item.message.type === 'fatal').length, 1);
    assert.equal(h.creations.length, 1);
});

test('invalid model interfaces and missing ORT devices release sessions that cannot be cached', async () => {
    for (const missingDevice of [false, true]) {
        const h = harness();
        const created = session(missingDevice ? {} : { inputNames: ['first', 'second'] });
        if (missingDevice) h.ort.env.webgpu.device = undefined;
        h.createPlans.push(() => created);
        h.initialize('webgpu');
        const id = h.run();
        await flush();
        assert.equal(h.response(id).error.kind, missingDevice ? 'provider' : 'model');
        assert.equal(created.releases, 1);
        assert.deepEqual(h.response(id).diagnostics.sessionKeys, []);
    }
});
