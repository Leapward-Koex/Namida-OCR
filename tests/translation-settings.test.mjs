import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/ui/TranslationSettings.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const keys = { TranslationEnabled: 'TranslationEnabled', TranslationTargetLanguage: 'TranslationTargetLanguage' };
const actions = { ResetTranslation: 'reset', GetTranslationStatus: 'status' };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function harness({ present = true, supported = true, availability, create, settings, hostStatus, save } = {}) {
    const elements = new Map();
    function element() {
        return {
            hidden: false, disabled: false, checked: false, value: '', textContent: '', children: [], listeners: new Map(),
            appendChild(child) { this.children.push(child); },
            addEventListener(type, listener) { this.listeners.set(type, listener); },
            removeAttribute(name) { if (name === 'value') delete this.value; },
            dispatch(type) { return this.listeners.get(type)?.({}); },
        };
    }
    for (const id of ['translation', 'translation-enabled', 'translation-target-language', 'translation-status',
        'translation-download-progress', 'translation-setup', 'translation-cancel-setup']) elements.set(id, element());
    elements.get('translation').hidden = true;
    const calls = { availability: [], create: [], messages: [], saves: [], detection: [], helper: 0, destroyed: 0 };
    const api = {
        availability(pair) { calls.availability.push({ ...pair }); return availability?.(pair) ?? Promise.resolve('downloadable'); },
        create(options) {
            calls.create.push(options);
            return create?.(options) ?? Promise.resolve({ destroy() { calls.destroyed++; } });
        },
    };
    const changes = new Set();
    const pageListeners = new Map();
    const self = new Proxy(present ? { Translator: api } : {}, {
        has(target, key) { calls.detection.push(key); return Reflect.has(target, key); },
    });
    const context = vm.createContext({
        exports: {}, self, AbortController, Number, Math,
        document: { getElementById: (id) => elements.get(id), createElement: () => element() },
        window: { addEventListener: (event, listener) => pageListeners.set(event, listener) },
        require(name) {
            if (name === 'webextension-polyfill') return {
                runtime: {
                    async sendMessage(message) { calls.messages.push(message); return hostStatus ?? { state: 'available' }; },
                },
                storage: {
                    sync: { async set(values) { calls.saves.push(values); await save?.(values); } },
                    onChanged: { addListener(listener) { changes.add(listener); }, removeListener(listener) { changes.delete(listener); } },
                },
            };
            if (name === '../interfaces/Storage') return { StorageKey: keys, Settings: { async getTranslationSettings() { return settings ?? { enabled: false, targetLanguage: 'en' }; } } };
            if (name === '../interfaces/message') return { NamidaMessageAction: actions };
            if (name === '../translation/TranslationLanguages') return {
                TRANSLATION_LANGUAGES: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'French' }],
                normalizeTranslationTarget: (value) => value === 'fr' ? 'fr' : 'en',
            };
            if (name === '../translation/TranslatorApi') return {
                isTranslationPlatformSupported: () => supported,
                getTranslatorApi: () => { calls.helper++; return present ? api : null; },
            };
            throw new Error(`Unexpected import ${name}`);
        },
    });
    vm.runInContext(code, context);
    context.exports.initializeTranslationSettings();
    return {
        calls, elements,
        get: (id) => elements.get(`translation-${id}`),
        close: () => pageListeners.get('pagehide')?.(),
        change: (values) => { for (const listener of changes) listener(values, 'sync'); },
    };
}

test('absent Translator fails documented feature detection without accessing its methods', async () => {
    const h = harness({ present: false });
    await flush();
    assert.deepEqual(h.calls.detection, ['Translator']);
    assert.equal(h.calls.helper, 0, 'No API helper access is allowed before the document feature check.');
    assert.equal(h.get('status').textContent, 'Local translation is unavailable in this browser');
    for (const name of ['enabled', 'target-language', 'setup']) assert.equal(h.get(name).disabled, true);
    assert.equal(h.calls.create.length, 0);
    assert.equal(h.calls.availability.length, 0);
    assert.equal(h.calls.messages.length, 0);
});

test('Firefox/mobile platforms leave the section hidden without Translator access', async () => {
    const h = harness({ supported: false });
    await flush();
    assert.equal(h.elements.get('translation').hidden, true);
    assert.deepEqual(h.calls.detection, []);
    assert.equal(h.calls.helper, 0);
});

test('presence checks selected pair without creating sessions, downloading or starting an offscreen host', async () => {
    const h = harness({ settings: { enabled: true, targetLanguage: 'fr' } });
    await flush();
    assert.deepEqual(h.calls.detection, ['Translator']);
    assert.equal(h.calls.helper, 1);
    assert.deepEqual(h.calls.availability, [{ sourceLanguage: 'ja', targetLanguage: 'fr' }]);
    assert.equal(h.calls.create.length, 0);
    assert.equal(h.calls.messages.length, 0);
    assert.equal(h.get('status').textContent, 'Download the language files to translate on this device.');
    assert.equal(h.get('enabled').checked, true);
    assert.equal(h.get('setup').disabled, false);
    assert.equal(h.get('setup').hidden, false);
    assert.equal(h.get('setup').textContent, 'Download & enable');
});

test('Download & enable starts within click, reports progress, verifies offscreen, and enables translation', async () => {
    const pending = deferred();
    const h = harness({ create: () => pending.promise });
    await flush();
    h.get('setup').dispatch('click');
    assert.equal(h.calls.create.length, 1, 'create must run before the click handler returns, preserving user activation.');
    assert.equal(h.calls.messages.length, 0);
    assert.equal(h.get('setup').hidden, true);
    assert.equal(h.get('target-language').disabled, false, 'Changing the target remains possible during setup.');
    const options = h.calls.create[0];
    assert.equal(options.sourceLanguage, 'ja');
    assert.equal(options.targetLanguage, 'en');
    let progressListener;
    options.monitor({ addEventListener(type, callback) { assert.equal(type, 'downloadprogress'); progressListener = callback; } });
    progressListener({ loaded: 0.45 });
    assert.equal(h.get('download-progress').value, 0.45);
    assert.equal(h.get('status').textContent, 'Downloading… 45% · Keep this popup open.');
    let destroyed = 0;
    pending.resolve({ destroy() { destroyed++; } });
    await flush();
    assert.equal(destroyed, 1);
    assert.equal(h.calls.messages[0].action, 'status');
    assert.equal(h.calls.messages[0].data.targetLanguage, 'en');
    assert.equal(h.calls.messages[0].data.ensureHost, true);
    assert.equal(h.get('status').textContent, 'Ready for offline translation.');
    assert.equal(h.get('enabled').checked, true);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.saves)), [{ TranslationEnabled: true }]);
    assert.equal(h.get('setup').hidden, true);
    assert.equal(h.get('download-progress').hidden, true);
});

test('download failures allow retry and do not save a downloaded flag', async () => {
    let attempts = 0;
    const h = harness({ create: () => ++attempts === 1 ? Promise.reject(new Error('Offline')) : Promise.resolve({ destroy() {} }) });
    await flush();
    h.get('setup').dispatch('click');
    await flush();
    assert.equal(h.get('setup').textContent, 'Download & enable');
    assert.equal(h.get('setup').disabled, false);
    h.get('setup').dispatch('click');
    await flush();
    assert.match(h.get('status').textContent, /Ready for offline/);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.saves)), [{ TranslationEnabled: true }]);
});

test('unsupported pair prevents setup while allowing target selection', async () => {
    const h = harness({ availability: async () => 'unavailable' });
    await flush();
    assert.equal(h.get('setup').disabled, true);
    assert.equal(h.get('enabled').disabled, true);
    assert.equal(h.get('target-language').disabled, false);
    assert.match(h.get('status').textContent, /Choose another language/);
    h.get('setup').dispatch('click');
    assert.equal(h.calls.create.length, 0);
});

test('offscreen feature unavailability after setup disables translation controls', async () => {
    const h = harness({ hostStatus: { state: 'unsupported' } });
    await flush();
    h.get('setup').dispatch('click');
    await flush();
    assert.equal(h.get('status').textContent, 'Local translation is unavailable in this browser');
    for (const name of ['enabled', 'target-language', 'setup']) assert.equal(h.get(name).disabled, true);
});

test('each preference syncs independently without duplicate resets or automatic downloads', async () => {
    const h = harness();
    await flush();
    h.get('enabled').checked = true;
    h.get('enabled').dispatch('change');
    await flush();
    h.get('target-language').value = 'fr';
    h.get('target-language').dispatch('change');
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.saves)), [{ TranslationEnabled: true }, { TranslationTargetLanguage: 'fr' }]);
    assert.equal(h.calls.messages.length, 0, 'The background storage listener owns the session reset.');
    assert.equal(h.calls.availability.at(-1).targetLanguage, 'fr');
    assert.equal(h.calls.create.length, 0);
});

test('synced target change aborts setup and ignores late session/progress completion', async () => {
    const pending = deferred();
    const h = harness({ create: () => pending.promise });
    await flush();
    h.get('setup').dispatch('click');
    const setup = h.calls.create[0];
    let report;
    setup.monitor({ addEventListener(_type, listener) { report = listener; } });
    h.change({ TranslationTargetLanguage: { newValue: 'fr' } });
    await flush();
    assert.equal(setup.signal.aborted, true);
    assert.equal(h.get('target-language').value, 'fr');
    const nextStatus = h.get('status').textContent;
    let destroyed = 0;
    report({ loaded: 0.8 });
    pending.resolve({ destroy() { destroyed++; } });
    await flush();
    assert.equal(destroyed, 1);
    assert.equal(h.get('status').textContent, nextStatus);
    assert.equal(h.calls.messages.length, 0);
});

test('closing setup aborts its signal and disposes sessions which settle after closure', async () => {
    const pending = deferred();
    const h = harness({ create: () => pending.promise });
    await flush();
    h.get('setup').dispatch('click');
    h.close();
    assert.equal(h.calls.create[0].signal.aborted, true);
    let destroyed = 0;
    pending.resolve({ destroy() { destroyed++; } });
    await flush();
    assert.equal(destroyed, 1);
    assert.equal(h.calls.messages.length, 0);
});

test('a stalled setup can be cancelled and retried without accepting its late completion', async () => {
    const pending = deferred();
    let attempt = 0;
    const h = harness({ create: () => ++attempt === 1 ? pending.promise : Promise.resolve({ destroy() {} }) });
    await flush();
    h.get('setup').dispatch('click');
    assert.equal(h.get('cancel-setup').hidden, false);
    h.get('cancel-setup').dispatch('click');
    await flush();
    assert.equal(h.calls.create[0].signal.aborted, true);
    assert.equal(h.get('cancel-setup').hidden, true);
    assert.equal(h.get('setup').disabled, false);
    h.get('setup').dispatch('click');
    await flush();
    assert.match(h.get('status').textContent, /Ready for offline/);
    let destroyed = 0;
    pending.resolve({ destroy() { destroyed++; } });
    await flush();
    assert.equal(destroyed, 1);
    assert.equal(h.calls.messages.length, 1, 'Only the second setup should check the offscreen host.');
    assert.match(h.get('status').textContent, /Ready for offline/);
});

test('synced preferences arriving during initial storage read supersede its older snapshot', async () => {
    const pending = deferred();
    const h = harness({ settings: pending.promise });
    h.change({ TranslationEnabled: { newValue: true }, TranslationTargetLanguage: { newValue: 'fr' } });
    pending.resolve({ enabled: false, targetLanguage: 'en' });
    await flush();
    assert.equal(h.get('enabled').checked, true);
    assert.equal(h.get('target-language').value, 'fr');
    assert.equal(h.calls.availability[0].targetLanguage, 'fr');
});

test('late availability for a previous target cannot replace the current status', async () => {
    const old = deferred();
    const h = harness({ availability: (pair) => pair.targetLanguage === 'en' ? old.promise : Promise.resolve('available') });
    await flush();
    h.change({ TranslationTargetLanguage: { newValue: 'fr' } });
    await flush();
    assert.match(h.get('status').textContent, /Ready for offline/);
    old.resolve('unavailable');
    await flush();
    assert.match(h.get('status').textContent, /Ready for offline/);
});

test('ready models show one status without a setup button or automatically enabling translation', async () => {
    const h = harness({ availability: async () => 'available' });
    await flush();
    assert.equal(h.get('status').textContent, 'Ready for offline translation.');
    assert.equal(h.get('setup').hidden, true);
    assert.equal(h.get('cancel-setup').hidden, true);
    assert.equal(h.get('enabled').checked, false);
    assert.equal(h.get('enabled').disabled, false);
    assert.equal(h.get('target-language').disabled, false);
    assert.equal(h.calls.saves.length, 0);
    assert.equal(h.calls.create.length, 0);
});

test('a browser-managed download already in progress offers Finish setup', async () => {
    const h = harness({ availability: async () => 'downloading' });
    await flush();
    assert.equal(h.get('setup').hidden, false);
    assert.equal(h.get('setup').textContent, 'Finish setup');
    h.get('setup').dispatch('click');
    assert.equal(h.calls.create.length, 1);
    await flush();
    assert.equal(h.get('enabled').checked, true);
});

test('cancel during offscreen verification prevents automatic enabling', async () => {
    const pending = deferred();
    const h = harness({ hostStatus: pending.promise });
    await flush();
    h.get('setup').dispatch('click');
    await flush();
    assert.equal(h.calls.messages.length, 1);
    h.get('cancel-setup').dispatch('click');
    pending.resolve({ state: 'available' });
    await flush();
    assert.equal(h.get('enabled').checked, false);
    assert.equal(h.calls.saves.length, 0);
    assert.equal(h.get('setup').hidden, false);
});

test('target selection during setup cancels it and preserves the new target without enabling', async () => {
    const pending = deferred();
    const h = harness({ hostStatus: pending.promise });
    await flush();
    h.get('setup').dispatch('click');
    await flush();
    h.get('target-language').value = 'fr';
    h.get('target-language').dispatch('change');
    pending.resolve({ state: 'available' });
    await flush();
    assert.equal(h.calls.create[0].signal.aborted, true);
    assert.equal(h.get('target-language').value, 'fr');
    assert.equal(h.get('enabled').checked, false);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.saves)), [{ TranslationTargetLanguage: 'fr' }]);
});

test('an explicit synced disable during verification cancels a pending Download & enable action', async () => {
    const pending = deferred();
    const h = harness({ hostStatus: pending.promise });
    await flush();
    h.get('setup').dispatch('click');
    await flush();
    h.change({ TranslationEnabled: { oldValue: true, newValue: false } });
    pending.resolve({ state: 'available' });
    await flush();
    assert.equal(h.calls.create[0].signal.aborted, true);
    assert.equal(h.get('enabled').checked, false);
    assert.equal(h.calls.saves.length, 0);
});

test('the automatic enable storage event does not cancel successful setup', async () => {
    const h = harness({ save: (values) => {
        h.change({ TranslationEnabled: { oldValue: false, newValue: values.TranslationEnabled } });
    } });
    await flush();
    h.get('setup').dispatch('click');
    await flush();
    assert.equal(h.get('enabled').checked, true);
    assert.equal(h.get('status').textContent, 'Ready for offline translation.');
    assert.equal(h.get('cancel-setup').hidden, true);
    assert.equal(h.calls.availability.length, 1);
});

test('verified setup hides cancellation before committing enable and ignores late download events', async () => {
    const pending = deferred();
    const h = harness({ save: () => pending.promise });
    await flush();
    h.get('setup').dispatch('click');
    let report;
    h.calls.create[0].monitor({ addEventListener(_type, listener) { report = listener; } });
    await flush();
    assert.equal(h.calls.saves.length, 1);
    assert.equal(h.get('cancel-setup').hidden, true);
    assert.equal(h.get('download-progress').hidden, true);
    report({ loaded: 0.9 });
    assert.equal(h.get('status').textContent, 'Ready for offline translation.');
    pending.resolve();
    await flush();
});

test('a failed enable write leaves the downloaded pair ready with a usable toggle', async () => {
    const h = harness({ save: async () => { throw new Error('Storage unavailable'); } });
    await flush();
    h.get('setup').dispatch('click');
    await flush();
    assert.equal(h.get('enabled').checked, false);
    assert.equal(h.get('enabled').disabled, false);
    assert.equal(h.get('setup').hidden, true);
    assert.equal(h.get('status').textContent, 'Downloaded. Turn on Translate Japanese to enable it.');
});

function loadStoredTranslation(values = {}, chromium = true) {
    let reads = 0;
    const compile = (file) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const languages = vm.createContext({ exports: {} });
    vm.runInContext(compile('../src/translation/TranslationLanguages.ts'), languages);
    const context = vm.createContext({
        exports: {}, __NAMIDA_TRANSLATION_ENABLED__: chromium, __NAMIDA_OCR_MODEL__: 'jpn_vert', __NAMIDA_OCR_BACKEND__: 'tesseract',
        chrome: { storage: { sync: { get(_query, callback) { reads++; callback(values); } } }, runtime: {} },
        require(name) {
            if (name === 'tesseract.js') return { PSM: {} };
            if (name === './UpscaleMethod') return { UpscaleMethod: {} };
            if (name === '../background/FuriganaHandler') return { FuriganaType: {} };
            if (name === '../translation/TranslationLanguages') return languages.exports;
            throw new Error(`Unexpected import ${name}`);
        },
    });
    vm.runInContext(compile('../src/interfaces/Storage.ts'), context);
    return { settings: context.exports.Settings.getTranslationSettings(), reads: () => reads };
}

test('unset translation preference defaults to automatic/English and explicit opt-out survives', async () => {
    assert.deepEqual(JSON.parse(JSON.stringify(await loadStoredTranslation().settings)), { targetLanguage: 'en' });
    const invalid = loadStoredTranslation({ TranslationEnabled: 'true', TranslationTargetLanguage: 'ja' });
    assert.deepEqual(JSON.parse(JSON.stringify(await invalid.settings)), { targetLanguage: 'en' });
    assert.deepEqual(JSON.parse(JSON.stringify(await loadStoredTranslation({ TranslationEnabled: false }).settings)), { enabled: false, targetLanguage: 'en' });
    const stored = loadStoredTranslation({ TranslationEnabled: true, TranslationTargetLanguage: ' zh-hant ' });
    assert.deepEqual(JSON.parse(JSON.stringify(await stored.settings)), { enabled: true, targetLanguage: 'zh-Hant' });
});

test('an unset preference follows current model readiness without persisting a downloaded flag', async () => {
    for (const state of ['available', 'downloadable', 'downloading', 'unavailable']) {
        const h = harness({ settings: { targetLanguage: 'en' }, availability: async () => state });
        await flush();
        assert.equal(h.get('enabled').checked, state === 'available');
        assert.equal(h.calls.create.length, 0);
        assert.equal(h.calls.saves.length, 0);
    }
});

test('automatic readiness default follows target changes and respects a subsequent explicit disable', async () => {
    const h = harness({ settings: { targetLanguage: 'en' }, availability: async pair => pair.targetLanguage === 'en' ? 'available' : 'downloadable' });
    await flush();
    assert.equal(h.get('enabled').checked, true);
    h.change({ TranslationTargetLanguage: { newValue: 'fr' } });
    await flush();
    assert.equal(h.get('enabled').checked, false);
    h.change({ TranslationTargetLanguage: { newValue: 'en' }, TranslationEnabled: { newValue: false } });
    await flush();
    assert.equal(h.get('enabled').checked, false);
    h.change({ TranslationEnabled: { newValue: undefined } });
    await flush();
    assert.equal(h.get('enabled').checked, true);
    assert.equal(h.calls.saves.length, 0);
});

test('Firefox ignores synced translation enable preference without reading storage', async () => {
    const firefox = loadStoredTranslation({ TranslationEnabled: true, TranslationTargetLanguage: 'fr' }, false);
    assert.deepEqual(JSON.parse(JSON.stringify(await firefox.settings)), { enabled: false, targetLanguage: 'en' });
    assert.equal(firefox.reads(), 0);
});
