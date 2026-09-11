import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function compile(path) {
    return ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
}

const compiledBackend = compile('../src/background/ocr/TesseractOcrBackend.ts');
const compiledScoring = compile('../src/background/ocr/OcrTextScoring.ts');
const PSM = { AUTO: '3', SINGLE_BLOCK_VERT_TEXT: '5', SINGLE_BLOCK: '6' };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flush() {
    // Drain nested promise continuations without introducing timing-sensitive sleeps.
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function result(text = '日本語', extras = {}) {
    return { data: { text, confidence: 84, symbols: [{ confidence: 70 }, { confidence: 90 }], ...extras } };
}

function fakeWorker() {
    return {
        calls: [],
        parameters: [],
        plans: [],
        terminations: 0,
        async setParameters(parameters) { this.parameters.push(parameters); },
        recognize(...args) {
            this.calls.push(args);
            const plan = this.plans.shift();
            return plan ? plan() : Promise.resolve(result());
        },
        async terminate() { this.terminations += 1; },
    };
}

function harness(globals = {}) {
    const creations = [];
    const workers = [];
    const plans = [];
    const scoringContext = vm.createContext({ exports: {} });
    vm.runInContext(compiledScoring, scoringContext);
    const context = vm.createContext({
        exports: {},
        require(name) {
            if (name === 'tesseract.js') {
                return {
                    OEM: { LSTM_ONLY: 1 },
                    PSM,
                    createWorker(...args) {
                        creations.push(args);
                        const plan = plans.shift();
                        if (plan) return plan();
                        const worker = fakeWorker();
                        workers.push(worker);
                        return Promise.resolve(worker);
                    },
                };
            }
            if (name === '../../interfaces/Storage') return { DEFAULT_OCR_MODEL: 'jpn_vert' };
            if (name === './OcrTextScoring') return scoringContext.exports;
            throw new Error(`Unexpected import ${name}`);
        },
        console: { debug() {}, warn() {}, info() {} },
        ...globals,
    });
    vm.runInContext(compiledBackend, context);
    return { backend: new context.exports.TesseractOcrBackend(), Backend: context.exports.TesseractOcrBackend, creations, workers, plans };
}

function imageHarness({ width = 200, height = 400, canvasError, bitmapPlan } = {}) {
    const image = { width, height, closes: 0, close() { this.closes += 1; } };
    const context = {
        fills: [],
        draws: [],
        fillRect(...args) { this.fills.push(args); },
        drawImage(...args) { this.draws.push(args); },
    };
    const canvas = {
        getContext(kind) {
            assert.equal(kind, '2d');
            return canvasError === 'context' ? null : context;
        },
        toDataURL(type) {
            assert.equal(type, 'image/png');
            if (canvasError === 'encoding') throw new Error('Unable to encode canvas');
            return 'data:image/png;base64,retry-image';
        },
    };
    const blob = {};
    const fetches = [];
    let bitmapCalls = 0;
    return {
        image, context, canvas, fetches,
        get bitmapCalls() { return bitmapCalls; },
        globals: {
            async fetch(url) {
                fetches.push(url);
                return { async blob() { return blob; } };
            },
            async createImageBitmap(input) {
                bitmapCalls += 1;
                assert.equal(input, blob);
                return bitmapPlan ? bitmapPlan(image) : image;
            },
            document: {
                createElement(name) {
                    assert.equal(name, 'canvas');
                    return canvas;
                },
            },
        },
    };
}

test('shares initialization across backend instances and keeps worker assets local', async () => {
    const h = harness();
    const pending = deferred();
    const worker = fakeWorker();
    h.plans.push(() => pending.promise);
    const first = h.backend.init(' jpn_vert ');
    const second = new h.Backend().init('jpn_vert');
    await flush();
    assert.equal(h.creations.length, 1);
    pending.resolve(worker);
    await Promise.all([first, second]);

    const [languages, engine, options] = h.creations[0];
    assert.deepEqual(Array.from(languages), ['jpn_vert']);
    assert.equal(engine, 1);
    assert.equal(options.workerBlobURL, false);
    assert.equal(options.corePath, '/libs/tesseract-core');
    assert.equal(options.workerPath, '/libs/tesseract-worker/worker.min.js');
    assert.equal(options.langPath, '/libs/tesseract-lang');
    assert.equal(options.gzip, true);
    await h.backend.terminate();
    assert.equal(worker.terminations, 1);
});

test('serializes recognition on one model and applies segmentation only to each request', async () => {
    const h = harness();
    await h.backend.init();
    const worker = h.workers[0];
    const pending = deferred();
    worker.plans.push(() => pending.promise, () => Promise.resolve(result('次の文字')));
    const first = h.backend.recognize('first-image', PSM.SINGLE_BLOCK_VERT_TEXT);
    const second = new h.Backend().recognize('second-image', PSM.SINGLE_BLOCK);
    await flush();
    assert.equal(worker.calls.length, 1, 'A cached worker must not receive overlapping recognize jobs');

    pending.resolve(result('最初の文字'));
    assert.equal(await first, '最初の文字');
    assert.equal(await second, '次の文字');
    assert.equal(worker.calls.length, 2);
    for (const [index, mode] of [PSM.SINGLE_BLOCK_VERT_TEXT, PSM.SINGLE_BLOCK].entries()) {
        const [image, options, output] = worker.calls[index];
        assert.equal(image, index === 0 ? 'first-image' : 'second-image');
        assert.equal(options.tessedit_pageseg_mode, mode);
        assert.equal(output.text, true);
        assert.equal(output.blocks, true);
        assert.equal(output.hocr, false);
        assert.equal(output.tsv, false);
    }
    assert.ok(worker.parameters.every((parameters) => parameters.tessedit_pageseg_mode === undefined),
        'Request segmentation must not mutate shared worker parameters');
    await h.backend.terminate();
});

test('different model workers can recognize independently', async () => {
    const h = harness();
    await Promise.all([h.backend.init('jpn_vert'), h.backend.init('jpn')]);
    const firstPending = deferred();
    h.workers[0].plans.push(() => firstPending.promise);
    const vertical = h.backend.recognize('vertical-image', PSM.SINGLE_BLOCK_VERT_TEXT, 'jpn_vert');
    const horizontal = h.backend.recognize('horizontal-image', PSM.SINGLE_BLOCK, 'jpn');
    assert.equal(await horizontal, '日本語');
    assert.equal(h.workers[0].calls.length, 1);
    assert.equal(h.workers[1].calls.length, 1);
    firstPending.resolve(result('縦書き'));
    assert.equal(await vertical, '縦書き');
    await h.backend.terminate();
});

test('termination waits for all accepted jobs, including jobs queued during initialization', async () => {
    const h = harness();
    const initialization = deferred();
    const firstPending = deferred();
    const secondPending = deferred();
    const worker = fakeWorker();
    worker.plans.push(() => firstPending.promise, () => secondPending.promise);
    h.plans.push(() => initialization.promise);
    const first = h.backend.recognize('first-image', PSM.SINGLE_BLOCK_VERT_TEXT);
    const second = h.backend.recognize('second-image', PSM.SINGLE_BLOCK);
    let terminated = false;
    const termination = h.backend.terminate().then(() => { terminated = true; });
    await flush();
    assert.equal(terminated, false);
    initialization.resolve(worker);
    await flush();
    assert.equal(worker.calls.length, 1);
    assert.equal(worker.terminations, 0);

    firstPending.resolve(result('一番'));
    assert.equal(await first, '一番');
    await flush();
    assert.equal(worker.calls.length, 2);
    assert.equal(worker.terminations, 0);
    assert.equal(terminated, false);
    secondPending.resolve(result('二番'));
    assert.equal(await second, '二番');
    await termination;
    assert.equal(worker.terminations, 1);
    await h.backend.terminate();
    assert.equal(worker.terminations, 1);
});

test('failed recognition does not poison subsequent queued work', async () => {
    const h = harness();
    await h.backend.init();
    const worker = h.workers[0];
    const pending = deferred();
    worker.plans.push(() => pending.promise, () => Promise.resolve(result('回復した文字')));
    const failed = h.backend.recognizeCandidate('bad-image', PSM.SINGLE_BLOCK_VERT_TEXT);
    const recovered = h.backend.recognize('good-image', PSM.SINGLE_BLOCK_VERT_TEXT);
    await flush();
    pending.reject(new Error('recognition failed'));
    assert.equal(await failed, null);
    assert.equal(await recovered, '回復した文字');
    assert.equal(worker.calls.length, 2);
    await h.backend.terminate();
    assert.equal(worker.terminations, 1);
});

test('missing symbol output preserves recognized text and uses overall confidence', async () => {
    const h = harness();
    await h.backend.init();
    const worker = h.workers[0];
    worker.plans.push(() => Promise.resolve(result('認識できた', { symbols: undefined })));
    const candidate = await h.backend.recognizeCandidate('image', PSM.SINGLE_BLOCK_VERT_TEXT);
    assert.ok(candidate);
    assert.equal(candidate.cleanedText, '認識できた');
    assert.equal(candidate.confidence, 84);
    assert.equal(candidate.averageSymbolConfidence, 84);
    assert.ok(Number.isFinite(candidate.score));
    await h.backend.terminate();
});

test('retains symbol confidence and existing text cleanup; empty output yields no candidate', async () => {
    const h = harness();
    await h.backend.init();
    const worker = h.workers[0];
    worker.plans.push(
        () => Promise.resolve(result('|日本語/\n次の行\n')),
        () => Promise.resolve(result('   \n')),
    );
    const candidate = await h.backend.recognizeCandidate('image', PSM.SINGLE_BLOCK_VERT_TEXT);
    assert.equal(candidate.cleanedText, '日本語\n次の行');
    assert.equal(candidate.averageSymbolConfidence, 80);
    assert.equal(await h.backend.recognize('empty-image', PSM.SINGLE_BLOCK_VERT_TEXT), undefined);
    await h.backend.terminate();
});

test('initialization failure rejects all waiters, evicts the failure, and allows retry', async () => {
    const h = harness();
    const pending = deferred();
    h.plans.push(() => pending.promise);
    const first = assert.rejects(h.backend.init(), /worker initialization failed/);
    const second = assert.rejects(new h.Backend().init(), /worker initialization failed/);
    await flush();
    pending.reject(new Error('worker initialization failed'));
    await Promise.all([first, second]);
    await h.backend.init();
    assert.equal(h.creations.length, 2);
    assert.equal(await h.backend.recognize('image', PSM.SINGLE_BLOCK_VERT_TEXT), '日本語');
    await h.backend.terminate();
});

test('a retired initialization failure cannot evict a replacement model worker', async () => {
    const h = harness();
    const pending = deferred();
    h.plans.push(() => pending.promise);
    const failed = assert.rejects(h.backend.init(), /retired initialization failed/);
    const termination = h.backend.terminate();
    await h.backend.init();
    pending.reject(new Error('retired initialization failed'));
    await Promise.all([failed, termination]);
    await h.backend.init();
    assert.equal(h.creations.length, 2, 'Old failure must not remove the replacement from the cache');
    assert.equal(h.workers[0].terminations, 0);
    await h.backend.terminate();
    assert.equal(h.workers[0].terminations, 1);
});

test('worker error callback rejects initialization even when v5 leaves its promise pending', async () => {
    const h = harness();
    h.plans.push(() => new Promise(() => {}));
    const initialization = assert.rejects(h.backend.init(), /language load failed/);
    h.creations[0][2].errorHandler(new Error('language load failed'));
    await initialization;
    await h.backend.init();
    assert.equal(h.creations.length, 2);
    await h.backend.terminate();
});

test('invalid model names use the bundled default while horizontal Japanese stays separate', async () => {
    const h = harness();
    await h.backend.init('../remote-model');
    await h.backend.init('  ');
    await h.backend.init('jpn_vert');
    await h.backend.init('jpn');
    assert.equal(h.creations.length, 2);
    assert.deepEqual(h.creations.map(([languages]) => Array.from(languages)), [['jpn_vert'], ['jpn']]);
    await h.backend.terminate();
});

test('confident recognition avoids image preparation and a second OCR pass', async () => {
    const images = imageHarness();
    const h = harness(images.globals);
    await h.backend.init();
    const worker = h.workers[0];
    for (const confidence of [85, 99]) {
        worker.plans.push(() => Promise.resolve(result('日本語', { confidence })));
        const candidate = await h.backend.recognizeCandidate('original-image', PSM.SINGLE_BLOCK_VERT_TEXT);
        assert.equal(candidate.id, 'primary-jpn_vert');
        assert.equal(candidate.confidence, confidence);
    }
    assert.equal(worker.calls.length, 2);
    assert.equal(images.fetches.length, 0);
    assert.equal(images.bitmapCalls, 0);
    await h.backend.terminate();
});

test('an uncertain retry must improve confidence and score while retaining Japanese content', async (t) => {
    const scenarios = [
        { name: 'better candidate', text: '日本の文字', confidence: 90, promoted: true },
        { name: 'lower confidence despite higher score', text: '日本の文字', confidence: 69, symbols: [{ confidence: 99 }] },
        { name: 'equal confidence despite higher score', text: '日本の文字', confidence: 70, symbols: [{ confidence: 99 }] },
        { name: 'higher confidence but lower score', text: '日本の文字', confidence: 71, symbols: [{ confidence: 0 }] },
        { name: 'lower Japanese ratio despite higher score', text: '日本語AB', confidence: 90 },
        { name: 'truncated text despite higher score', text: '日本語', confidence: 99 },
        { name: 'exactly three quarters retained', primaryText: '日本文字', text: '日本語', confidence: 90, promoted: true },
    ];
    for (const scenario of scenarios) {
        await t.test(scenario.name, async () => {
            const images = imageHarness();
            const h = harness(images.globals);
            await h.backend.init();
            const worker = h.workers[0];
            const primaryText = scenario.primaryText ?? '日本語文字';
            worker.plans.push(
                () => Promise.resolve(result(primaryText, { confidence: 70, symbols: undefined })),
                () => Promise.resolve(result(scenario.text, { confidence: scenario.confidence, symbols: scenario.symbols })),
            );
            const candidate = await h.backend.recognizeCandidate('original-image', PSM.SINGLE_BLOCK);
            assert.equal(candidate.id, scenario.promoted ? 'resized-border-jpn_vert' : 'primary-jpn_vert');
            assert.equal(candidate.cleanedText, scenario.promoted ? scenario.text : primaryText);
            assert.equal(worker.calls.length, 2);
            assert.equal(worker.calls[1][0], 'data:image/png;base64,retry-image');
            assert.equal(worker.calls[1][1].tessedit_pageseg_mode, PSM.SINGLE_BLOCK);
            assert.equal(images.image.closes, 1);
            await h.backend.terminate();
        });
    }
});

test('empty and failed retries preserve primary text, and an empty primary can recover', async (t) => {
    const scenarios = [
        { name: 'empty retry', primary: '元の日本語', retry: () => Promise.resolve(result('  \n')), expected: '元の日本語' },
        { name: 'failed retry', primary: '元の日本語', retry: () => Promise.reject(new Error('Retry failed')), expected: '元の日本語' },
        { name: 'empty primary', primary: '  \n', retry: () => Promise.resolve(result('回復した文字')), expected: '回復した文字' },
        { name: 'both empty', primary: '  \n', retry: () => Promise.resolve(result('  \n')), expected: undefined },
    ];
    for (const scenario of scenarios) {
        await t.test(scenario.name, async () => {
            const images = imageHarness();
            const h = harness(images.globals);
            await h.backend.init();
            const worker = h.workers[0];
            worker.plans.push(() => Promise.resolve(result(scenario.primary, { confidence: 60 })), scenario.retry);
            const candidate = await h.backend.recognizeCandidate('original-image', PSM.SINGLE_BLOCK_VERT_TEXT);
            assert.equal(candidate?.cleanedText, scenario.expected);
            assert.equal(worker.calls.length, 2);
            assert.equal(images.image.closes, 1);
            await h.backend.terminate();
        });
    }
});

test('retry preparation adds a white border, preserves small inputs, and closes decoded images on failure', async (t) => {
    for (const scenario of [
        { name: 'large image', width: 200, height: 400, expectedWidth: 120, expectedHeight: 220 },
        { name: 'small image', width: 30, height: 100, expectedWidth: 50, expectedHeight: 120 },
        { name: 'missing canvas context', canvasError: 'context' },
        { name: 'failed canvas encoding', canvasError: 'encoding' },
    ]) {
        await t.test(scenario.name, async () => {
            const images = imageHarness(scenario);
            const h = harness(images.globals);
            await h.backend.init();
            const worker = h.workers[0];
            worker.plans.push(
                () => Promise.resolve(result('元の日本語', { confidence: 60 })),
                () => Promise.resolve(result('次の日本語', { confidence: 90 })),
            );
            const candidate = await h.backend.recognizeCandidate('original-image', PSM.SINGLE_BLOCK_VERT_TEXT);
            assert.deepEqual(images.fetches, ['original-image']);
            assert.equal(images.image.closes, 1);
            if (scenario.canvasError) {
                assert.equal(candidate.cleanedText, '元の日本語');
                assert.equal(worker.calls.length, 1);
            } else {
                assert.equal(candidate.cleanedText, '次の日本語');
                assert.equal(images.canvas.width, scenario.expectedWidth);
                assert.equal(images.canvas.height, scenario.expectedHeight);
                assert.equal(images.context.fillStyle, '#fff');
                assert.deepEqual(images.context.fills, [[0, 0, scenario.expectedWidth, scenario.expectedHeight]]);
                assert.deepEqual(images.context.draws, [[images.image, 10, 10, scenario.expectedWidth - 20, scenario.expectedHeight - 20]]);
            }
            await h.backend.terminate();
        });
    }
});

test('termination and subsequent requests wait for both retry preparation and recognition', async () => {
    const pendingBitmap = deferred();
    const pendingRetry = deferred();
    const images = imageHarness({ bitmapPlan: () => pendingBitmap.promise });
    const h = harness(images.globals);
    await h.backend.init();
    const worker = h.workers[0];
    worker.plans.push(
        () => Promise.resolve(result('元の日本語', { confidence: 60 })),
        () => pendingRetry.promise,
        () => Promise.resolve(result('後の日本語', { confidence: 90 })),
    );
    const first = h.backend.recognizeCandidate('first-image', PSM.SINGLE_BLOCK_VERT_TEXT);
    const second = h.backend.recognizeCandidate('second-image', PSM.SINGLE_BLOCK);
    await flush();
    assert.equal(images.bitmapCalls, 1);
    assert.equal(worker.calls.length, 1);
    let terminated = false;
    const termination = h.backend.terminate().then(() => { terminated = true; });
    await flush();
    assert.equal(terminated, false);
    assert.equal(worker.terminations, 0);

    pendingBitmap.resolve(images.image);
    await flush();
    assert.equal(images.image.closes, 1);
    assert.equal(worker.calls.length, 2);
    assert.equal(worker.calls[1][0], 'data:image/png;base64,retry-image');
    assert.equal(terminated, false);
    assert.equal(worker.terminations, 0);

    pendingRetry.resolve(result('次の日本語', { confidence: 90 }));
    assert.equal((await first).cleanedText, '次の日本語');
    assert.equal((await second).cleanedText, '後の日本語');
    await termination;
    assert.equal(worker.calls.length, 3);
    assert.equal(worker.calls[2][0], 'second-image');
    assert.equal(worker.terminations, 1);
    assert.equal(terminated, true);
});
