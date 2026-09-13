import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function compile(file) {
    return ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
}
const overlayCode = compile('../src/content/SnippingOverlay.ts');
const screenshotCode = compile('../src/content/ScreenshotHandler.ts');
const contentCode = compile('../src/content/index.ts');
const floatingWindowCode = compile('../src/content/FloatingWindowHandler.ts');
const actions = { SnipPage: 0, CaptureFullScreen: 1, PreloadOcr: 13 };
const quietConsole = { debug() {}, error() {}, warn() {} };

async function flush() {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test('removes the overlay before calling selection completion and preserves border/DPR geometry', () => {
    const attached = new Set();
    const elements = [];
    const document = {
        body: { appendChild(element) { attached.add(element); }, removeChild(element) { attached.delete(element); } },
        createElement() {
            const element = {
                style: {}, listeners: new Map(),
                setAttribute() {}, appendChild() {},
                addEventListener(type, callback) { this.listeners.set(type, callback); },
                removeEventListener(type) { this.listeners.delete(type); },
                getBoundingClientRect() {
                    return { left: 100, top: 80, width: 204, height: 104 };
                },
            };
            elements.push(element);
            return element;
        },
    };
    const context = vm.createContext({ exports: {}, document, window: { devicePixelRatio: 2 } });
    vm.runInContext(overlayCode, context);
    let result;
    const overlay = new context.exports.SnipOverlay((selection) => {
        assert.equal(attached.size, 0, 'The screenshot callback must never see the selection overlay attached.');
        result = JSON.parse(JSON.stringify(selection));
    });
    overlay.show();
    const root = elements[0];
    root.listeners.get('mousedown')({ preventDefault() {}, clientX: 100, clientY: 80 });
    root.listeners.get('mousemove')({ clientX: 300, clientY: 180 });
    root.listeners.get('mouseup')({});
    assert.deepEqual(result, { left: 200, top: 160, width: 408, height: 208 });
    assert.equal(root.listeners.size, 0);
});

test('does not request a screenshot before two animation frames have elapsed', async () => {
    const frames = [];
    const requests = [];
    const context = vm.createContext({
        exports: {}, console: quietConsole,
        require(name) {
            if (name === 'webextension-polyfill') return { runtime: { async sendMessage(message) { requests.push(message); return 'data:image/png;base64,screen'; } } };
            if (name === '../interfaces/message') return { NamidaMessageAction: actions };
            if (name === '../interfaces/UpscaleMethod') return { UpscaleMethod: { None: 0, Canvas: 1, TensorFlow: 2 } };
            if (name === '../background/Upscaler') return { Upscaler: {} };
            throw new Error(`Unexpected import ${name}`);
        },
        requestAnimationFrame(callback) { frames.push(callback); },
        Image: class {
            width = 800; height = 600;
            set src(value) { queueMicrotask(() => this.onload()); }
        },
        document: {
            createElement() {
                return { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,crop' };
            },
        },
    });
    vm.runInContext(screenshotCode, context);
    const capture = new context.exports.ScreenshotHandler({ left: 1, top: 2, width: 3, height: 4 });
    const result = capture.captureAndCrop(context.exports.UpscaleMethod.None);
    assert.equal(requests.length, 0);
    assert.equal(frames.length, 1);
    frames.shift()(0);
    await flush();
    assert.equal(requests.length, 0);
    assert.equal(frames.length, 1);
    frames.shift()(16);
    assert.equal(await result, 'data:image/png;base64,crop');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, actions.CaptureFullScreen);
});

function loadFloatingWindow(globals = {}) {
    const context = vm.createContext({
        exports: {},
        require(name) {
            if (name === 'webextension-polyfill') return { runtime: {}, storage: {} };
            if (name === '../interfaces/message') return { NamidaMessageAction: {} };
            if (name === '../translation/TranslatorApi') return { isTranslationPlatformSupported: () => false };
            if (name === '../translation/TranslationLanguages') return { TRANSLATION_LANGUAGES: [] };
            if (name === '../interfaces/Storage') return { Settings: {} };
            if (name === './SpeechHandler') return { SpeechSynthesisHandler: class {} };
            if (name === './TTSWrapper') return { TTSWrapper: {} };
            throw new Error(`Unexpected import ${name}`);
        },
        ...globals,
    });
    vm.runInContext(floatingWindowCode, context);
    return context.exports.FloatingWindow;
}

test('hideForCapture restores the exact previous visibility and handles an absent window', () => {
    const FloatingWindow = loadFloatingWindow();
    FloatingWindow.hideForCapture()();
    for (const previousVisibility of ['', 'visible', 'hidden']) {
        const element = { style: { visibility: previousVisibility } };
        FloatingWindow.floatingMessageEl = element;
        const restore = FloatingWindow.hideForCapture();
        assert.equal(element.style.visibility, 'hidden');
        restore();
        assert.equal(element.style.visibility, previousVisibility);
    }
});

test('nested capture restorers are idempotent and keep existing or newly created UI hidden until all captures finish', () => {
    const FloatingWindow = loadFloatingWindow({
        document: {
            body: { appendChild() {} },
            createElement() { return { style: { visibility: '' }, setAttribute() {}, appendChild() {}, addEventListener() {} }; },
        },
    });
    for (const restoreOrder of [[0, 1], [1, 0]]) {
        const element = { style: { visibility: 'visible' } };
        FloatingWindow.floatingMessageEl = element;
        const restore = [FloatingWindow.hideForCapture(), FloatingWindow.hideForCapture()];
        assert.equal(element.style.visibility, 'hidden');
        restore[restoreOrder[0]]();
        restore[restoreOrder[0]]();
        assert.equal(element.style.visibility, 'hidden', 'Finishing one capture twice must not reveal another capture\'s UI.');
        restore[restoreOrder[1]]();
        assert.equal(element.style.visibility, 'visible');
        restore[0]();
        restore[1]();
        const nextCapture = FloatingWindow.hideForCapture();
        assert.equal(element.style.visibility, 'hidden', 'Duplicate restorers must not corrupt the depth of a later capture.');
        nextCapture();
        assert.equal(element.style.visibility, 'visible');
    }
    FloatingWindow.floatingMessageEl = null;
    const first = FloatingWindow.hideForCapture();
    const second = FloatingWindow.hideForCapture();
    FloatingWindow.ensureWindow();
    const newlyCreated = FloatingWindow.floatingMessageEl;
    assert.equal(newlyCreated.style.visibility, 'hidden');
    first();
    assert.equal(newlyCreated.style.visibility, 'hidden');
    second();
    assert.equal(newlyCreated.style.visibility, '');
});

for (const backend of ['paddleonnx', 'tesseract']) {
    for (const captureFails of [false, true]) {
    test(`restores previous UI after ${backend} capture ${captureFails ? 'failure' : 'success'} and preserves output policy`, async () => {
        const events = [];
        let snipListener;
        let rejectPreload;
        const preload = new Promise((_, reject) => { rejectPreload = reject; });
        let selectionCallback;
        let completeCapture;
        let shownText;
        let copiedText;
        let previousWindowVisible = true;
        const captured = new Promise((resolve) => { completeCapture = resolve; });
        const modules = {
            'webextension-polyfill': { runtime: {
                onMessage: { addListener(callback) { snipListener = callback; } },
                sendMessage(message) { assert.equal(message.action, actions.PreloadOcr); events.push('preload'); return preload; },
            } },
            '../interfaces/message': { NamidaMessageAction: actions },
            './SnippingOverlay': { SnipOverlay: class {
                constructor(callback) { selectionCallback = callback; }
                show() { events.push('overlay'); }
            } },
            './SaveHandler': { SaveHandler: class {} },
            '../background/TesseractOcrHandler': { TesseractOcrHandler: class { async recognizeFromContent(data) { assert.equal(data, 'crop'); events.push('recognize'); return '日本語 OCR 2026'; } } },
            './ScreenshotHandler': { ScreenshotHandler: class { async captureAndCrop() {
                events.push('capture-start');
                assert.equal(previousWindowVisible, false);
                await captured;
                assert.equal(previousWindowVisible, false);
                events.push('capture-end');
                if (captureFails) throw new Error('Capture failed');
                return 'crop';
            } } },
            '../interfaces/Storage': { Settings: { async getUpscalingMode() { return 0; }, async getOcrBackend() { return backend; }, async getSaveOcrCrop() { return false; } } },
            './ClipboardHandler': { ClipboardHandler: { copyText(text) { copiedText = text; } } },
            './FloatingWindowHandler': { FloatingWindow: class {
                constructor({ text }) { shownText = text; events.push('result'); }
                static cancelTranslation() {}
                static hideForCapture() {
                    events.push('hide');
                    previousWindowVisible = false;
                    return () => { previousWindowVisible = true; events.push('restore'); };
                }
                static showStatus() { assert.equal(previousWindowVisible, true); events.push('status'); }
                static showFailure() { assert.equal(previousWindowVisible, true); events.push('failure'); }
            } },
            './TextProcessorHandler': { TextProcessorHandler: { removeSpaces(text) { return text.replace(/ /g, ''); } } },
            '../background/FuriganaHandler': { FuriganaHandler: { async generateFuriganaFromContent() { return undefined; } } },
        };
        const context = vm.createContext({ exports: {}, console: quietConsole, require(name) { assert.ok(name in modules, name); return modules[name]; } });
        vm.runInContext(contentCode, context);
        assert.deepEqual(events, [], 'Loading a page must not trigger preloading.');
        assert.equal(snipListener({ action: actions.SnipPage }), undefined, 'Snipping must not await preload.');
        assert.deepEqual(events, ['overlay', 'preload']);
        events.length = 0;
        const result = selectionCallback({ left: 0, top: 0, width: 20, height: 20 });
        await flush();
        assert.deepEqual(events, ['hide', 'capture-start'], 'Status must not appear while screenshot capture is pending.');
        rejectPreload(new Error('Preload unavailable'));
        await flush();
        assert.deepEqual(events, ['hide', 'capture-start'], 'A rejected preload must not fail the selection/capture.');
        completeCapture();
        await result;
        if (captureFails) {
            assert.deepEqual(events, ['hide', 'capture-start', 'capture-end', 'restore', 'failure']);
            assert.equal(shownText, undefined);
            assert.equal(copiedText, undefined);
            return;
        }
        assert.deepEqual(events, backend === 'paddleonnx'
            ? ['hide', 'capture-start', 'capture-end', 'restore', 'status', 'recognize', 'result']
            : ['hide', 'capture-start', 'capture-end', 'restore', 'recognize', 'result']);
        assert.equal(shownText, backend === 'paddleonnx' ? '日本語 OCR 2026' : '日本語OCR2026');
        assert.equal(copiedText, shownText);
    });
    }
}
