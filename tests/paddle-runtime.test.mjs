import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/background/ocr/PaddleOnnxRuntime.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const input = () => ({ data: new Float32Array(12).fill(0.5), dims: [1, 3, 2, 2] });
const model = { key: 'detector', path: 'det/inference.onnx' };
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ strict = false } = {}) {
    const workers = [], events = [], plans = [], timers = new Map();
    let nextTimer = 0;
    class FakeWorker {
        constructor(url) {
            this.url = url; this.index = workers.length; this.terminated = false;
            this.diagnostics = { provider: null, sessionKeys: [], successfulInferences: 0 };
            workers.push(this); events.push('create:' + this.index);
        }
        terminate() { this.terminated = true; events.push('terminate:' + this.index); }
        emit(reply) { this.onmessage({ data: reply }); }
        fail(kind, message, request) { this.emit({ type: 'error', id: request.id, error: { kind, message } }); }
        fatal(message = 'GPU device lost') { this.emit({ type: 'fatal', error: { kind: 'device-lost', message } }); }
        respond(request) {
            if (request.type === 'init') {
                this.diagnostics.provider = request.provider;
                if (request.provider === 'webgpu') this.diagnostics.adapter = { vendor: 'nvidia', isFallbackAdapter: false };
                for (const { key } of request.models) if (!this.diagnostics.sessionKeys.includes(key)) this.diagnostics.sessionKeys.push(key);
                this.emit({ id: request.id, type: 'initialized', diagnostics: this.diagnostics });
            } else {
                this.diagnostics.successfulInferences++;
                this.emit({ id: request.id, type: 'result', output: { type: 'float32', dims: [1, 1, 2, 2], data: new Float32Array([1,2,3,4]) }, diagnostics: this.diagnostics });
            }
        }
        postMessage(request, transfer) {
            assert.equal(transfer, undefined, 'input must remain available for retry');
            events.push({ worker: this.index, request });
            const plan = plans[0];
            if (plan && (!plan.type || plan.type === request.type)) {
                plans.shift();
                queueMicrotask(() => plan.run(this, request));
            } else queueMicrotask(() => this.respond(request));
        }
    }
    const context = vm.createContext({
        exports: {}, Worker: FakeWorker, Float32Array, console: { warn() {} },
        __NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK__: strict,
        require(name) {
            assert.equal(name, 'webextension-polyfill', 'ORT must not be imported in the parent runtime');
            return { runtime: { getURL: path => 'chrome-extension://local/' + path } };
        },
        setTimeout(callback, milliseconds) { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
        clearTimeout(id) { timers.delete(id); },
    });
    vm.runInContext(compiled, context);
    const runtime = new context.exports.PaddleOnnxRuntime();
    return {
        runtime, workers, events, plans, timers,
        run: () => runtime.run(model.key, model.path, input()),
        expire(ms) {
            const timer = [...timers].find(([, value]) => value.milliseconds === ms);
            assert.ok(timer, 'Expected pending timeout ' + ms);
            timers.delete(timer[0]); timer[1].callback();
        },
    };
}

test('status is lazy; local worker caches sessions and reports actual initialized provider/inference count', async () => {
    const h = harness();
    assert.equal(h.runtime.getStatus().provider, null);
    assert.equal(h.workers.length, 0);
    await Promise.all([h.runtime.initialize([model]), h.runtime.initialize([model])]);
    assert.equal(h.workers.length, 1);
    assert.equal(h.workers[0].url, 'chrome-extension://local/paddle-worker/index.js');
    const commands = h.events.filter(event => typeof event === 'object').map(event => event.request);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].runtimeBaseUrl, 'chrome-extension://local/libs/onnxruntime/');
    assert.equal(commands[0].modelBaseUrl, 'chrome-extension://local/libs/paddleocr/');
    assert.equal(h.runtime.getStatus().successfulInferences, 0);
    assert.deepEqual(Array.from((await h.run()).data), [1,2,3,4]);
    assert.equal(h.runtime.getStatus().successfulInferences, 1);
    assert.equal(h.runtime.getStatus().adapter.vendor, 'nvidia');
    const snapshot = h.runtime.getStatus();
    snapshot.sessionKeys.length = 0; snapshot.adapter.vendor = 'changed';
    assert.deepEqual(plain(h.runtime.getStatus().sessionKeys), ['detector']);
    assert.equal(h.runtime.getStatus().adapter.vendor, 'nvidia');
    assert.equal(h.timers.size, 0);
});

test('hung GPU inference is terminated before fresh CPU initialization and original input is retried', async () => {
    const h = harness();
    h.plans.push({ type: 'run', run() {} });
    const original = input();
    const result = h.runtime.run(model.key, model.path, original);
    await flush();
    h.expire(15_000);
    assert.deepEqual(Array.from((await result).data), [1,2,3,4]);
    assert.ok(h.events.indexOf('terminate:0') < h.events.indexOf('create:1'));
    assert.equal(h.runtime.getStatus().provider, 'wasm');
    assert.match(h.runtime.getStatus().fallbackReason, /Timed out running/);
    const runs = h.events.filter(event => event.request?.type === 'run');
    assert.equal(runs.length, 2);
    assert.equal(runs[1].request.input, runs[0].request.input);
    assert.notEqual(runs[1].request.input, original);
    assert.equal(original.data.byteLength, 48);
    await h.run();
    assert.equal(h.workers.length, 2, 'normal requests do not repeatedly probe a broken GPU');
    assert.equal(h.timers.size, 0);
});

test('GPU initialization timeout also cancels the entire realm before CPU recovery', async () => {
    const h = harness();
    h.plans.push({ type: 'init', run() {} });
    const result = h.run(); await flush(); h.expire(20_000);
    await result;
    assert.equal(h.workers[0].terminated, true);
    assert.equal(h.runtime.getStatus().provider, 'wasm');
});

test('settled GPU operation/shader/allocation failures trigger fresh CPU recovery', async () => {
    for (const message of ['OperationError', 'GPU validation failed', 'Shader compilation failed', 'Buffer allocation failed']) {
        const h = harness();
        h.plans.push({ type: 'run', run: (worker, request) => worker.fail('provider', message, request) });
        await h.run();
        assert.equal(h.workers[0].terminated, true);
        assert.equal(h.runtime.getStatus().provider, 'wasm');
        assert.equal(h.runtime.getStatus().fallbackReason, message);
    }
});

test('missing API, null adapter and software adapter use CPU without trying WebNN', async () => {
    for (const message of ['WebGPU unavailable', 'No adapter', 'Software adapter']) {
        const h = harness();
        h.plans.push({ type: 'init', run: (worker, request) => worker.fail('provider', message, request) });
        await h.run();
        assert.deepEqual(h.events.filter(event => event.request?.type === 'init').map(event => event.request.provider), ['webgpu', 'wasm']);
        assert.equal(h.runtime.getStatus().fallbackReason, message);
    }
});

test('idle device loss invalidates sessions immediately and next request starts fresh CPU runtime', async () => {
    const h = harness();
    await h.run();
    h.workers[0].fatal();
    assert.equal(h.workers[0].terminated, true);
    assert.equal(h.runtime.getStatus().provider, null);
    assert.equal(h.runtime.getStatus().state, 'failed');
    await h.run();
    assert.equal(h.runtime.getStatus().provider, 'wasm');
});

test('device loss during inference cancels its pending RPC and stale worker replies cannot alter status', async () => {
    const h = harness(); let pending;
    h.plans.push({ type: 'run', run(worker, request) { pending = request; worker.fatal(); } });
    await h.run();
    const status = plain(h.runtime.getStatus());
    h.workers[0].respond(pending);
    assert.deepEqual(plain(h.runtime.getStatus()), status);
    assert.equal(h.timers.size, 0);
});

test('strict GPU errors and timeouts invalidate context even though CPU retry is disabled', async () => {
    const h = harness({ strict: true });
    h.plans.push({ type: 'run', run() {} });
    const result = h.run(); await flush(); h.expire(15_000);
    await assert.rejects(result, /Timed out/);
    assert.equal(h.workers[0].terminated, true);
    assert.equal(h.runtime.getStatus().state, 'failed');
    assert.equal(h.workers.length, 1);
    await h.run();
    assert.equal(h.workers.length, 2);
    assert.equal(h.runtime.getStatus().provider, 'webgpu');
});

test('input and model errors remain explicit without switching provider', async () => {
    for (const kind of ['input', 'model']) {
        const h = harness();
        h.plans.push({ type: 'run', run: (worker, request) => worker.fail(kind, 'bad ' + kind, request) });
        await assert.rejects(h.run(), new RegExp('bad ' + kind));
        assert.equal(h.workers.length, 1);
        assert.equal(h.workers[0].terminated, false);
        assert.equal(h.runtime.getStatus().fallbackReason, undefined);
        await h.run();
        assert.equal(h.runtime.getStatus().state, 'ready');
        assert.equal(h.runtime.getStatus().lastError, undefined);
    }
});

test('worker crash and unreadable response invalidate context and recover', async () => {
    for (const fail of [worker => worker.onerror({ message: 'crash', preventDefault() {} }), worker => worker.onmessageerror()]) {
        const h = harness();
        h.plans.push({ type: 'run', run: fail });
        await h.run();
        assert.equal(h.workers[0].terminated, true);
        assert.equal(h.runtime.getStatus().provider, 'wasm');
    }
});

test('CPU hang is bounded and a failed CPU retry is never retried indefinitely', async () => {
    const h = harness();
    await h.runtime.setGpuEnabled(false);
    h.plans.push({ type: 'run', run() {} });
    const result = h.run(); await flush(); h.expire(120_000);
    await assert.rejects(result, /Timed out/);
    assert.equal(h.workers[0].terminated, true);
    assert.equal(h.workers.length, 1);
    await h.run();
    assert.equal(h.runtime.getStatus().provider, 'wasm');
});

test('GPU changes and termination wait until the current request completes', async () => {
    const h = harness(); let complete;
    h.plans.push({ type: 'run', run(worker, request) { complete = () => worker.respond(request); } });
    const first = h.run();
    const disable = h.runtime.setGpuEnabled(false);
    const second = h.run();
    const termination = h.runtime.terminate();
    await flush();
    assert.equal(h.workers.length, 1); assert.equal(h.workers[0].terminated, false);
    complete(); await Promise.all([first, disable, second, termination]);
    assert.equal(h.workers.length, 2);
    assert.equal(h.workers[0].terminated, true);
    assert.equal(h.workers[1].terminated, true);
    assert.equal(h.runtime.getStatus().state, 'idle');
});

test('explicit retry, disable/enable and termination clear a previous GPU circuit breaker', async () => {
    for (const reset of [
        runtime => runtime.retryGpu(),
        async runtime => { await runtime.setGpuEnabled(false); await runtime.setGpuEnabled(true); },
        runtime => runtime.terminate(),
    ]) {
        const h = harness();
        h.plans.push({ type: 'run', run: (worker, request) => worker.fail('provider', 'GPU broke', request) });
        await h.run();
        await reset(h.runtime);
        await h.run();
        assert.equal(h.runtime.getStatus().provider, 'webgpu');
        assert.equal(h.runtime.getStatus().fallbackReason, undefined);
        assert.equal(h.workers[1].terminated, true);
    }
});

test('same GPU setting preserves healthy sessions; retry cannot override a saved GPU-off preference', async () => {
    const h = harness();
    await h.run(); await h.runtime.setGpuEnabled(true); await h.run();
    assert.equal(h.workers.length, 1);
    await h.runtime.setGpuEnabled(false);
    await assert.rejects(h.runtime.retryGpu(), /Enable GPU/);
    await h.run();
    assert.equal(h.runtime.getStatus().provider, 'wasm');
    assert.equal(h.runtime.getStatus().fallbackReason, undefined);
});

test('model key conflicts reject before sending an incompatible command', async () => {
    const h = harness(); await h.runtime.initialize([model]);
    await assert.rejects(h.runtime.initialize([{ key: model.key, path: 'other.onnx' }]), /different model path/);
    assert.equal(h.workers.length, 1);
    await h.run();
    assert.equal(h.runtime.getStatus().successfulInferences, 1);
});

test('queued requests keep accepted input pixels and dimensions across caller mutation and CPU retry', async () => {
    const h = harness();
    h.plans.push({ type: 'run', run: (worker, request) => worker.fail('provider', 'GPU broke', request) });
    const source = input();
    const result = h.runtime.run(model.key, model.path, source);
    source.data.fill(99);
    source.dims[3] = 999;
    await result;
    for (const event of h.events.filter(event => event.request?.type === 'run')) {
        assert.deepEqual(Array.from(event.request.input.data), new Array(12).fill(0.5));
        assert.deepEqual(plain(event.request.input.dims), [1, 3, 2, 2]);
    }
});
