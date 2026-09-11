import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/background/ocr/PaddleOnnxRuntime.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flush() {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function fakeSession(name) {
    return { name, releases: 0, async release() { this.releases += 1; } };
}

function harness({ gpu = false, ml = false, disableFallback = false } = {}) {
    const timers = new Map();
    const creations = [];
    const plans = [];
    let nextTimer = 0;
    const ort = {
        env: { wasm: {} },
        InferenceSession: {
            create(url, options) {
                const plan = plans.shift();
                creations.push({ url, options });
                return plan ? plan() : Promise.resolve(fakeSession(`session-${creations.length}`));
            },
        },
    };
    const context = vm.createContext({
        exports: {},
        require(name) {
            if (name === 'onnxruntime-web') return ort;
            if (name === 'webextension-polyfill') return { runtime: { getURL: (path) => `moz-extension://local/${path}` } };
            throw new Error(`Unexpected import ${name}`);
        },
        navigator: { ...(gpu ? { gpu: {} } : {}), ...(ml ? { ml: {} } : {}) },
        __NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK__: disableFallback,
        console: { info() {}, warn() {} },
        setTimeout(callback, milliseconds) { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
        clearTimeout(id) { timers.delete(id); },
    });
    vm.runInContext(compiled, context);
    return {
        runtime: new context.exports.PaddleOnnxRuntime(),
        creations,
        plans,
        ort,
        expire(milliseconds) {
            const entry = [...timers].find(([, timer]) => timer.milliseconds === milliseconds);
            assert.ok(entry, `Expected a pending ${milliseconds} ms timeout`);
            timers.delete(entry[0]);
            entry[1].callback();
        },
    };
}

test('shares model initialization, loads extension-local assets, and releases once on termination', async () => {
    const h = harness();
    const [first, second] = await Promise.all([
        h.runtime.ensureSession('recognizer', 'recognition/model.onnx'),
        h.runtime.ensureSession('recognizer', 'recognition/model.onnx'),
    ]);
    assert.equal(first, second);
    assert.equal(h.creations.length, 1);
    assert.equal(h.creations[0].url, 'moz-extension://local/libs/paddleocr/recognition/model.onnx');
    assert.equal(h.creations[0].options.executionProviders[0].name, 'wasm');
    assert.equal(h.ort.env.wasm.proxy, false);
    assert.equal(h.ort.env.wasm.wasmPaths.wasm, 'moz-extension://local/libs/onnxruntime/ort-wasm-simd-threaded.jsep.wasm');
    await h.runtime.terminate();
    await h.runtime.terminate();
    assert.equal(first.releases, 1);
    await assert.rejects(h.runtime.run('recognizer', first, async () => 'unexpected'), /no active model/);
});

test('termination waits to release until every underlying inference has settled', async () => {
    const h = harness();
    const session = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    const first = deferred();
    const second = deferred();
    const runFirst = h.runtime.run('recognizer', session, () => first.promise);
    const runSecond = h.runtime.run('recognizer', session, () => second.promise);
    await flush();
    await h.runtime.terminate();
    assert.equal(session.releases, 0);
    first.resolve('first');
    assert.equal(await runFirst, 'first');
    assert.equal(session.releases, 0);
    second.resolve('second');
    assert.equal(await runSecond, 'second');
    await flush();
    assert.equal(session.releases, 1);
});

test('late initialization after termination is released and cannot evict the replacement', async () => {
    const h = harness();
    const pending = deferred();
    const abandoned = fakeSession('abandoned');
    h.plans.push(() => pending.promise);
    const oldInitialization = h.runtime.ensureSession('recognizer', 'rec.onnx');
    const rejected = assert.rejects(oldInitialization, /retired during initialization/);
    await h.runtime.terminate();
    const replacement = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    pending.resolve(abandoned);
    await rejected;
    assert.equal(abandoned.releases, 1);
    assert.equal(await h.runtime.ensureSession('recognizer', 'rec.onnx'), replacement);
    assert.equal(h.creations.length, 2);
});

test('an old initialization rejection cannot evict a replacement cache entry', async () => {
    const h = harness();
    const pending = deferred();
    h.plans.push(() => pending.promise);
    const oldInitialization = h.runtime.ensureSession('recognizer', 'rec.onnx');
    const rejected = assert.rejects(oldInitialization, /old creation failed/);
    await h.runtime.terminate();
    const replacement = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    pending.reject(new Error('old creation failed'));
    await rejected;
    assert.equal(await h.runtime.ensureSession('recognizer', 'rec.onnx'), replacement);
    assert.equal(h.creations.length, 2);
});

test('timed-out accelerated initialization releases its late session without disturbing WASM', async () => {
    const h = harness({ gpu: true });
    const pending = deferred();
    const abandoned = fakeSession('late-gpu');
    h.plans.push(() => pending.promise);
    const initialization = h.runtime.ensureSession('recognizer', 'rec.onnx');
    h.expire(20_000);
    const wasm = await initialization;
    assert.equal(h.creations[0].options.executionProviders[0].name, 'webgpu');
    assert.equal(h.creations[1].options.executionProviders[0].name, 'wasm');
    pending.resolve(abandoned);
    await flush();
    assert.equal(abandoned.releases, 1);
    assert.equal(wasm.releases, 0);
    assert.equal(await h.runtime.ensureSession('recognizer', 'rec.onnx'), wasm);
});

test('inference timeout falls back immediately but releases GPU only when its actual work settles', async () => {
    const h = harness({ gpu: true });
    const gpu = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    const detector = await h.runtime.ensureSession('detector', 'det.onnx');
    const pending = deferred();
    const used = [];
    const result = h.runtime.run('recognizer', gpu, (active) => {
        used.push(active);
        return active === gpu ? pending.promise : Promise.resolve('wasm result');
    });
    await flush();
    h.expire(15_000);
    assert.equal(await result, 'wasm result');
    assert.equal(gpu.releases, 0);
    assert.equal(detector.releases, 1);
    assert.equal(used.length, 2);
    assert.equal(h.creations.at(-1).options.executionProviders[0].name, 'wasm');
    pending.resolve('ignored late GPU result');
    await flush();
    assert.equal(gpu.releases, 1);
    assert.equal(used[1].releases, 0);
});

test('provider-specific failure retries WASM; an ordinary inference error propagates', async () => {
    const h = harness({ gpu: true });
    const gpu = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    await assert.rejects(h.runtime.run('recognizer', gpu, async () => { throw new Error('bad input shape'); }), /bad input shape/);
    assert.equal(h.creations.length, 1);
    assert.equal(gpu.releases, 0);
    const result = await h.runtime.run('recognizer', gpu, async (active) => {
        if (active === gpu) throw new Error('using ceil() in shape computation is not yet supported for MaxPool');
        return 'fallback result';
    });
    assert.equal(result, 'fallback result');
    assert.equal(gpu.releases, 1);
    const wasm = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    await assert.rejects(h.runtime.run('recognizer', wasm, async () => { throw new Error('bad input shape'); }), /bad input shape/);
    assert.equal(h.creations.length, 2);
});

test('disabled fallback still defers release of a timed-out inference until it really finishes', async () => {
    const h = harness({ gpu: true, disableFallback: true });
    const gpu = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    const pending = deferred();
    const result = h.runtime.run('recognizer', gpu, () => pending.promise);
    const rejected = assert.rejects(result, /Timed out running ONNX inference/);
    await flush();
    h.expire(15_000);
    await rejected;
    await h.runtime.terminate();
    assert.equal(h.creations.length, 1);
    assert.equal(gpu.releases, 0);
    pending.reject(new Error('late provider error'));
    await flush();
    assert.equal(gpu.releases, 1);
});

test('GPU settings retire active sessions safely and stale handles resolve to the current provider', async () => {
    const h = harness({ gpu: true });
    const gpu = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    const pending = deferred();
    const oldRun = h.runtime.run('recognizer', gpu, () => pending.promise);
    await flush();
    await h.runtime.setGpuEnabled(false);
    assert.equal(gpu.releases, 0);
    const provider = await h.runtime.run('recognizer', gpu, async (active) => active.name);
    assert.notEqual(provider, gpu.name);
    assert.equal(h.creations.at(-1).options.executionProviders[0].name, 'wasm');
    pending.resolve('done');
    await oldRun;
    await flush();
    assert.equal(gpu.releases, 1);
});

test('keeps WebGPU then WebNN then WASM creation order and honors disabled fallback', async () => {
    const h = harness({ gpu: true, ml: true });
    h.plans.push(() => Promise.reject(new Error('gpu unavailable')), () => Promise.reject(new Error('webnn unavailable')));
    await h.runtime.ensureSession('recognizer', 'rec.onnx');
    assert.deepEqual(h.creations.map((creation) => creation.options.executionProviders[0].name), ['webgpu', 'webnn', 'wasm']);
    const strict = harness({ disableFallback: true });
    await assert.rejects(strict.runtime.ensureSession('recognizer', 'rec.onnx'), /WASM fallback is disabled/);
    assert.equal(strict.creations.length, 0);
    const strictGpu = harness({ gpu: true, disableFallback: true });
    const session = await strictGpu.runtime.ensureSession('recognizer', 'rec.onnx');
    await assert.rejects(strictGpu.runtime.run('recognizer', session, async () => {
        throw new Error('MaxPool not yet supported');
    }), /MaxPool not yet supported/);
    assert.equal(strictGpu.creations.length, 1);
});
