import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function compile(path) {
    return ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
}
const upscalerCode = compile('../src/background/Upscaler.ts');
const input = { shape: [1, 2, 3], imageData: [12, 34, 56, 78, 90, 123], dataUrl: 'data:image/png;base64,input' };
const plain = value => JSON.parse(JSON.stringify(value));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flush() {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function harness(options = {}) {
    const imports = [];
    const models = [];
    const live = new Set();
    const requests = [];
    const renders = [];
    function tensor(values, shape) {
        const result = {
            values: Array.from(values), shape: [...shape], disposed: false,
            async data() {
                assert.equal(this.disposed, false, 'tensor must remain alive through its data read');
                return Float32Array.from(this.values);
            },
            dispose() { assert.equal(this.disposed, false); this.disposed = true; live.delete(this); },
        };
        live.add(result);
        return result;
    }
    const tf = options.tf ?? { async ready() {}, tensor3d: tensor };
    class FakeUpscaler {
        constructor(config) {
            this.config = config;
            this.disposals = 0;
            models.push(this);
            this.ready = options.ready?.(models.length) ?? Promise.resolve();
        }
        getModel() {
            return options.getModel?.() ?? Promise.resolve({ model: { dispose: () => { this.disposals++; } } });
        }
        async upscale(value, upscaleOptions) {
            if (options.upscale) return options.upscale(value, upscaleOptions, { tensor, models, live });
            return typeof value === 'string' ? 'data:image/png;base64,upscaled' : tensor(value.values, value.shape);
        }
    }
    const context = vm.createContext({
        exports: {},
        require(name) {
            imports.push(name);
            if (name === 'upscaler') {
                options.onImport?.(name);
                return { default: options.Upscaler ?? FakeUpscaler, __esModule: true };
            }
            if (name === '@tensorflow/tfjs') return tf;
            if (name === '../interfaces/message') return { NamidaMessageAction: { UpscaleImage: 2 } };
            if (name === 'webextension-polyfill') return {
                runtime: {
                    getURL: path => `moz-extension://local/${path}`,
                    async sendMessage(message) {
                        requests.push(message);
                        return options.sendMessage ? options.sendMessage(message) : input;
                    },
                },
            };
            throw new Error(`Unexpected import ${name}`);
        },
        ...(options.image ? { Image: class {} } : {}),
        document: {
            createElement(name) {
                assert.equal(name, 'canvas');
                return {
                    width: 0, height: 0,
                    getContext() {
                        return {
                            drawImage() {},
                            createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
                            putImageData(value) { renders.push(value); },
                        };
                    },
                    toDataURL() { return 'data:image/png;base64,rendered'; },
                };
            },
        },
    });
    vm.runInContext(upscalerCode, context);
    return { Upscaler: context.exports.Upscaler, imports, models, live, requests, renders, tensor };
}

function inputCanvas() {
    return {
        width: 2, height: 1,
        toDataURL: () => input.dataUrl,
        getContext: () => ({ getImageData: () => ({ data: Uint8ClampedArray.from([12, 34, 56, 255, 78, 90, 123, 255]) }) }),
    };
}

test('module import and Canvas upscaling do not evaluate TensorFlow/UpscalerJS or initialize a model', () => {
    const h = harness();
    assert.equal(h.Upscaler.upscaleCanvas(inputCanvas(), 4), 'data:image/png;base64,rendered');
    assert.deepEqual(h.imports, ['webextension-polyfill', '../interfaces/message']);
    assert.equal(h.models.length, 0);
    assert.equal(h.live.size, 0);
});

test('settings use the lightweight enum without importing screenshot or upscaler code', () => {
    const enumContext = vm.createContext({ exports: {} });
    vm.runInContext(compile('../src/interfaces/UpscaleMethod.ts'), enumContext);
    const imports = [];
    const context = vm.createContext({
        exports: {}, __NAMIDA_OCR_MODEL__: 'jpn_vert', __NAMIDA_OCR_BACKEND__: 'tesseract',
        require(name) {
            imports.push(name);
            if (name === './UpscaleMethod') return enumContext.exports;
            if (name === 'tesseract.js') return { PSM: {} };
            if (name === '../background/FuriganaHandler') return { FuriganaType: {} };
            throw new Error(`Settings unexpectedly imported ${name}`);
        },
    });
    vm.runInContext(compile('../src/interfaces/Storage.ts'), context);
    assert.ok(imports.includes('./UpscaleMethod'));
    assert.deepEqual(plain(enumContext.exports.UpscaleMethod), { 0: 'None', 1: 'Canvas', 2: 'TensorFlow', None: 0, Canvas: 1, TensorFlow: 2 });
});

test('concurrent AI requests share one local model initialization and retain its weights between requests', async () => {
    const ready = deferred();
    const h = harness({ ready: () => ready.promise });
    const first = h.Upscaler.upscaleImageWithAIFromBackground(input);
    const second = h.Upscaler.upscaleImageWithAIFromBackground(input);
    await flush();
    assert.equal(h.models.length, 1);
    assert.equal(h.live.size, 0, 'inputs are allocated only after initialization succeeds');
    assert.equal(h.models[0].config.model.path, 'moz-extension://local/libs/tensorflow/x2/model.json');
    ready.resolve();
    assert.deepEqual(plain(await first), { shape: input.shape, imageData: input.imageData });
    await second;
    await h.Upscaler.upscaleImageWithAIFromBackground(input);
    assert.equal(h.models.length, 1);
    assert.equal(h.models[0].disposals, 0);
    assert.equal(h.live.size, 0);
});

test('failed imports and failed model initialization are retryable without retaining input tensors', async () => {
    let failImport = true;
    const imported = harness({ onImport() { if (failImport) { failImport = false; throw new Error('module load failed'); } } });
    await assert.rejects(imported.Upscaler.upscaleImageWithAIFromBackground(input), /module load failed/);
    await imported.Upscaler.upscaleImageWithAIFromBackground(input);
    assert.equal(imported.models.length, 1);
    assert.equal(imported.live.size, 0);

    const initialized = harness({ ready: attempt => attempt === 1 ? Promise.reject(new Error('warmup failed')) : Promise.resolve() });
    await assert.rejects(initialized.Upscaler.upscaleImageWithAIFromBackground(input), /warmup failed/);
    assert.equal(initialized.models[0].disposals, 1, 'a model loaded before failed initialization is released');
    await initialized.Upscaler.upscaleImageWithAIFromBackground(input);
    assert.equal(initialized.models.length, 2);
    assert.equal(initialized.models[1].disposals, 0);
    assert.equal(initialized.live.size, 0);
});

test('inputs and outputs survive async reads and are released on inference, data-read and result-validation failures', async () => {
    const read = deferred();
    const pending = harness({ upscale(value, _, { tensor }) { const output = tensor(value.values, value.shape); output.data = () => read.promise; return output; } });
    const result = pending.Upscaler.upscaleImageWithAIFromBackground(input);
    await flush();
    assert.equal(pending.live.size, 2);
    read.resolve(Float32Array.from(input.imageData));
    await result;
    assert.equal(pending.live.size, 0);

    for (const kind of ['inference', 'read', 'shape', 'missing', 'malformed']) {
        const h = harness({ upscale(value, _, { tensor }) {
            if (kind === 'inference') throw new Error('inference failed');
            if (kind === 'missing') return undefined;
            if (kind === 'malformed') return {};
            const output = tensor(value.values, kind === 'shape' ? [1, 1, 3] : value.shape);
            if (kind === 'read') output.data = async () => { throw new Error('read failed'); };
            return output;
        } });
        await assert.rejects(h.Upscaler.upscaleImageWithAIFromBackground(input), /failed|no tensor image|valid RGB/);
        assert.equal(h.live.size, 0, `${kind} must release every caller-owned tensor`);
        assert.equal(h.models[0].disposals, 0);
    }
});

test('Firefox image route returns the encoded image and propagates inference failure', async () => {
    const h = harness({ image: true });
    assert.deepEqual(plain(await h.Upscaler.upscaleImageWithAIFromBackground(input)), { dataUrl: 'data:image/png;base64,upscaled' });
    assert.equal(h.live.size, 0);
    const failed = harness({ image: true, upscale() { throw new Error('image inference failed'); } });
    await assert.rejects(failed.Upscaler.upscaleImageWithAIFromBackground(input), /image inference failed/);
    const missing = harness({ image: true, upscale() { return undefined; } });
    await assert.rejects(missing.Upscaler.upscaleImageWithAIFromBackground(input), /returned no image/);
});

test('content sends equivalent RGB pixels and renders 0–255 results without importing TensorFlow', async () => {
    const h = harness({ sendMessage: () => ({ shape: [1, 2, 3], imageData: [0, 128, 255, 12.6, -2, 270] }) });
    assert.equal(await h.Upscaler.upscaleImageWithAIFromContent(inputCanvas()), 'data:image/png;base64,rendered');
    assert.deepEqual(plain(h.requests[0].data), input);
    assert.deepEqual([...h.renders[0].data], [0, 128, 255, 255, 13, 0, 255, 255]);
    assert.equal(h.models.length, 0);
    assert.ok(!h.imports.includes('@tensorflow/tfjs'));

    const image = harness({ sendMessage: () => ({ dataUrl: 'data:image/png;base64,background' }) });
    assert.equal(await image.Upscaler.upscaleImageWithAIFromContent(inputCanvas()), 'data:image/png;base64,background');
    assert.equal(image.renders.length, 0);
    assert.ok(!image.imports.includes('@tensorflow/tfjs'));
});

test('missing and malformed content results reject clearly', async () => {
    for (const response of [undefined, null, {}, { shape: [1, 2, 3], imageData: [1, 2] }, { shape: [1, 1, 3], imageData: [0, NaN, 2] }]) {
        const h = harness({ sendMessage: () => response });
        await assert.rejects(h.Upscaler.upscaleImageWithAIFromContent(inputCanvas()), /returned no image|valid RGB/);
        assert.equal(h.renders.length, 0);
    }
});

test('repeated inference and failures return real TensorFlow CPU allocations to their baseline', async () => {
    const tf = await import('@tensorflow/tfjs');
    await tf.setBackend('cpu');
    await tf.ready();
    const baseline = tf.memory().numTensors;
    let failRead = false;
    const h = harness({ tf, upscale(value) {
        const output = tf.clone(value);
        if (failRead) output.data = async () => { throw new Error('failed CPU read'); };
        return output;
    } });
    for (let attempt = 0; attempt < 30; attempt += 1) {
        failRead = attempt % 3 === 2;
        if (failRead) await assert.rejects(h.Upscaler.upscaleImageWithAIFromBackground(input), /failed CPU read/);
        else await h.Upscaler.upscaleImageWithAIFromBackground(input);
        assert.equal(tf.memory().numTensors, baseline, `tensor baseline after attempt ${attempt}`);
    }
    assert.equal(h.models.length, 1);
    assert.equal(h.models[0].disposals, 0);
});

test('the bundled ESRGAN model works with the browser UpscalerJS implementation and retains only its weights', async () => {
    const tf = await import('@tensorflow/tfjs');
    await tf.setBackend('cpu');
    await tf.ready();
    const modelUrl = new URL('../node_modules/@upscalerjs/esrgan-medium/models/x2/model.json', import.meta.url);
    const modelJson = JSON.parse(readFileSync(modelUrl, 'utf8'));
    const weightData = Buffer.concat(modelJson.weightsManifest.flatMap(group => group.paths.map(path => readFileSync(new URL(path, modelUrl)))));
    let loads = 0;
    let loadedModel;
    const localTf = { ...tf, async loadLayersModel(url) {
        assert.equal(url, 'moz-extension://local/libs/tensorflow/x2/model.json');
        loads++;
        loadedModel = await tf.loadLayersModel(tf.io.fromMemory({
            modelTopology: modelJson.modelTopology,
            weightSpecs: modelJson.weightsManifest.flatMap(group => group.weights),
            weightData: weightData.buffer.slice(weightData.byteOffset, weightData.byteOffset + weightData.byteLength),
        }));
        return loadedModel;
    } };
    const upscalerModule = { exports: {} };
    const context = vm.createContext({
        module: upscalerModule, exports: upscalerModule.exports, AbortController,
        require(name) {
            if (name === '@tensorflow/tfjs' || name === '@tensorflow/tfjs-core') return localTf;
            if (name === '@upscalerjs/default-model') return {};
            throw new Error(`Unexpected browser UpscalerJS dependency ${name}`);
        },
    });
    vm.runInContext(readFileSync(new URL('../node_modules/upscaler/dist/browser/umd/upscaler.js', import.meta.url), 'utf8'), context);
    const h = harness({ tf: localTf, Upscaler: upscalerModule.exports });
    const beforeModel = tf.memory().numTensors;
    try {
        const result = await h.Upscaler.upscaleImageWithAIFromBackground(input);
        assert.deepEqual(plain(result.shape), [2, 4, 3]);
        assert.equal(result.imageData.length, 24);
        assert.ok(result.imageData.every(value => Number.isFinite(value) && value >= 0 && value <= 255));
        const loadedBaseline = tf.memory().numTensors;
        assert.ok(loadedBaseline > beforeModel, 'model weights remain available between requests');
        for (let attempt = 0; attempt < 4; attempt++) {
            await h.Upscaler.upscaleImageWithAIFromBackground(input);
            assert.equal(tf.memory().numTensors, loadedBaseline, `real model tensor baseline after attempt ${attempt}`);
        }
        assert.equal(loads, 1);
    } finally {
        loadedModel?.dispose();
    }
    assert.equal(tf.memory().numTensors, beforeModel);
});
