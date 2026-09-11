import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/background/ocr/PaddleOnnxRuntime.ts', import.meta.url), 'utf8');
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

test('audit: provider errors remain cached and never attempt WASM', async () => {
    for (const message of [
        'GPU device was lost',
        'OperationError: Failed to execute mapAsync on GPUBuffer',
        '[WebGPU] Kernel "[Conv] conv2d" failed. GPU out of memory',
        'failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: GPU validation error',
    ]) {
        const h = harness({ gpu: true });
        const gpu = await h.runtime.ensureSession('recognizer', 'rec.onnx');
        for (let request = 0; request < 2; request++) {
            await assert.rejects(h.runtime.run('recognizer', gpu, async () => { throw new Error(message); }), error => String(error).includes(message));
        }
        assert.equal(h.creations.length, 1);
        assert.equal(await h.runtime.ensureSession('recognizer', 'rec.onnx'), gpu);
        assert.equal(gpu.releases, 0);
    }
});

test('audit: timeout-induced WASM state survives terminate and re-applying enabled GPU setting', async () => {
    const h = harness({ gpu: true });
    const gpu = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    const pending = deferred();
    const result = h.runtime.run('recognizer', gpu, active => active === gpu ? pending.promise : Promise.resolve('WASM'));
    await flush();
    h.expire(15_000);
    assert.equal(await result, 'WASM');
    pending.resolve('late GPU result');
    await flush();
    await h.runtime.terminate();
    await h.runtime.setGpuEnabled(true);
    await h.runtime.ensureSession('recognizer', 'rec.onnx');
    assert.deepEqual(h.creations.map(call => call.options.executionProviders[0].name), ['webgpu', 'wasm', 'wasm']);
    await h.runtime.setGpuEnabled(false);
    await h.runtime.setGpuEnabled(true);
    await h.runtime.ensureSession('recognizer', 'rec.onnx');
    assert.equal(h.creations.at(-1).options.executionProviders[0].name, 'webgpu');
});

test('audit: strict timeout leaves a still-running session available for another inference', async () => {
    const h = harness({ gpu: true, disableFallback: true });
    const gpu = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    const pending = deferred();
    const result = h.runtime.run('recognizer', gpu, () => pending.promise);
    const rejected = assert.rejects(result, /Timed out running ONNX inference/);
    await flush();
    h.expire(15_000);
    await rejected;
    const cached = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    assert.equal(cached, gpu);
    assert.equal(await h.runtime.run('recognizer', cached, async active => active === gpu), true);
    assert.equal(h.creations.length, 1);
    pending.resolve('late');
    await flush();
});

test('audit: actual ORT 1.24.3 JSEP guard rejects timeout fallback while the GPU run remains active', async () => {
    const jsep = readFileSync(new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', import.meta.url), 'utf8');
    const guard = jsep.match(/const (\w+)=(a=>async\(\.\.\.b\)=>\{try\{if\((\w+)\.([^)]*)\)throw Error\("Session already started"\);[^\n]*?finally\{\3\.\4=null\}\});/);
    assert.ok(guard, 'Expected installed ORT shared JSEP session guard');
    const wrapOrtRun = vm.runInNewContext(`(() => { const ${guard[3]} = {}; return (${guard[2]}); })()`);
    const h = harness({ gpu: true });
    const gpu = await h.runtime.ensureSession('recognizer', 'rec.onnx');
    const pending = deferred();
    const run = wrapOrtRun(async active => active === gpu ? pending.promise : 'WASM output');
    const result = h.runtime.run('recognizer', gpu, run);
    const rejected = assert.rejects(result, /Session already started/);
    await flush();
    h.expire(15_000);
    await rejected;
    assert.deepEqual(h.creations.map(call => call.options.executionProviders[0].name), ['webgpu', 'wasm']);
    assert.equal(gpu.releases, 0);
    pending.resolve('late GPU output');
    await flush();
    assert.equal(gpu.releases, 1);
});
