import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleNames = ['TranslatorApi', 'TranslationLanguages', 'TranslationInput', 'TranslationService'];
const compiled = Object.fromEntries(moduleNames.map((name) => [name, compile(`../src/translation/${name}.ts`)]));
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function harness({ enabled = true, userAgent = 'Chrome/152.0', self = {}, api = null } = {}) {
    const timers = new Map();
    let nextTimer = 0;
    const modules = {};
    for (const name of moduleNames) {
        const context = vm.createContext({
            exports: {}, self, navigator: { userAgent }, AbortController,
            __NAMIDA_TRANSLATION_ENABLED__: enabled,
            setTimeout(callback, milliseconds) { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
            clearTimeout(id) { timers.delete(id); },
            require(path) { return modules[path.replace('./', '')]; },
        });
        vm.runInContext(compiled[name], context);
        modules[name] = context.exports;
    }
    const service = new modules.TranslationService.TranslationService(() => api ?? modules.TranslatorApi.getTranslatorApi());
    return { ...modules, service, timers, expire() { for (const timer of [...timers.values()]) timer.callback(); } };
}

function factory({ availability = 'available', translate = async (text) => `English: ${text}`, create } = {}) {
    const events = [], sessions = [];
    return {
        events, sessions,
        api: {
            async availability(pair) { events.push(['availability', plain(pair)]); return typeof availability === 'function' ? availability(pair) : availability; },
            async create(options) {
                events.push(['create', options.targetLanguage]);
                const session = create ? await create(options) : {
                    async translate(text, options) { events.push(['translate', text]); return translate(text, options); },
                    destroy() { events.push(['destroy']); },
                };
                sessions.push(session);
                return session;
            },
        },
    };
}

const request = (requestId, targetLanguage = 'en', text = 'こんにちは') => ({ requestId, targetLanguage, text });

test('uses the documented feature check before accessing Translator; absence calls no methods', async () => {
    const checks = [];
    const self = new Proxy({}, {
        has(target, property) { checks.push(['has', property]); return false; },
        get(target, property) { throw new Error(`Must not access absent ${String(property)}`); },
    });
    const h = harness({ self });
    assert.equal(h.TranslatorApi.getTranslatorApi(), null);
    assert.deepEqual(checks, [['has', 'Translator']]);
    assert.deepEqual(plain(await h.service.getStatus('en')), { state: 'unsupported', message: 'Local translation is unavailable in this browser' });
    assert.equal((await h.service.translate(request('one'))).reason, 'unsupported');
});

test('present API passes feature detection but still checks the selected pair before use', async () => {
    const f = factory({ availability: 'downloadable' });
    const checks = [];
    const self = new Proxy({ Translator: f.api }, {
        has(target, property) { checks.push(property); return Reflect.has(target, property); },
    });
    const h = harness({ self });
    assert.equal(h.TranslatorApi.getTranslatorApi(), f.api);
    assert.equal((await h.service.translate(request('one', 'fr'))).reason, 'setup-required');
    assert.ok(checks.includes('Translator'));
    assert.deepEqual(f.events, [['availability', { sourceLanguage: 'ja', targetLanguage: 'fr' }]]);
});

test('Firefox builds and mobile platforms never inspect or call Translator', () => {
    for (const options of [{ enabled: false }, { userAgent: 'Chrome/152 Android Mobile' }, { userAgent: 'iPad EdgiOS/152' }]) {
        const h = harness({ ...options, self: new Proxy({}, { has() { throw new Error('Must not inspect API'); } }) });
        assert.equal(h.TranslatorApi.isTranslationPlatformSupported(), false);
        assert.equal(h.TranslatorApi.getTranslatorApi(), null);
    }
});

test('catalog excludes Japanese and normalizes stored target codes', () => {
    const { TranslationLanguages: languages } = harness();
    assert.equal(languages.TRANSLATION_LANGUAGES.length, 38);
    assert.ok(!languages.TRANSLATION_LANGUAGES.some(({ code }) => code === 'ja'));
    assert.equal(languages.normalizeTranslationTarget(' zh-hant '), 'zh-Hant');
    for (const invalid of [undefined, null, 1, 'ja', 'invalid']) assert.equal(languages.normalizeTranslationTarget(invalid), 'en');
});

test('status checks every documented state without creating any translator', async () => {
    for (const state of ['unavailable', 'downloadable', 'downloading', 'available']) {
        const f = factory({ availability: state });
        const h = harness({ api: f.api });
        assert.equal((await h.service.getStatus('en')).state, state);
        assert.equal(f.sessions.length, 0);
        if (state !== 'available') {
            assert.equal((await h.service.translate(request('one'))).reason, state === 'unavailable' ? 'unavailable' : 'setup-required');
            assert.equal(f.sessions.length, 0, 'Automatic translation must not trigger model downloads');
        }
    }
});

test('availability rejection and unknown states return a recoverable error without creation', async () => {
    for (const availability of [() => { throw new Error('Policy unavailable'); }, 'unexpected']) {
        const f = factory({ availability });
        const h = harness({ api: f.api });
        assert.equal((await h.service.getStatus('en')).state, 'error');
        assert.equal((await h.service.translate(request('one'))).reason, 'error');
        assert.equal(f.sessions.length, 0);
    }
});

test('blank OCR bypasses the API entirely', async () => {
    const f = factory();
    const h = harness({ api: f.api });
    assert.deepEqual(plain(await h.service.translate(request('empty', 'en', ' \n '))), { ok: true, text: '' });
    assert.equal(f.events.length, 0);
});

test('unwraps the reported Japanese passage in one native call without losing its context', async () => {
    const source = 'いや\n催眠術なんだから\n普通に眠らせる技だろ\n何言ってんだコイツ……';
    const prepared = 'いや催眠術なんだから普通に眠らせる技だろ何言ってんだコイツ……';
    const complete = "No, it's hypnosis, so it's a technique that puts you to sleep normally What is this guy saying...";
    // Reproduce Chrome 152's observed whole-input omission. Per-line translation
    // also loses context (e.g. isolated いや becomes "Disagreeable").
    const f = factory({ translate: async text => text === prepared ? complete : "No, it's hypnosis, isn't it?" });
    const h = harness({ api: f.api });
    const input = request('multiline', 'en', source);
    assert.deepEqual(plain(await h.service.translate(input)), { ok: true, text: complete });
    assert.deepEqual(f.events.filter(([event]) => event === 'translate'), [['translate', prepared]]);
    assert.equal(input.text, source, 'Original OCR must stay intact for display, clipboard, and speech');
});

test('translation preparation handles OCR line wraps without merging Latin words or rewriting punctuation', () => {
    const { prepareTranslationInput } = harness().TranslationInput;
    for (const [input, expected] of [
        ['  催\r\n 眠\r術\u2028なんだから\u2029普通だろ  ', '催眠術なんだから普通だろ'],
        ['いや\n\n \t\n催眠術なんだから', 'いや催眠術なんだから'],
        ['「催眠術」\nって何？', '「催眠術」って何？'],
        ['ポケモン\nゲーム', 'ポケモンゲーム'],
        ['𠮷\n野家', '𠮷野家'],
        ['OCR\nの結果は\nHello world\n2026 123', 'OCRの結果はHello world 2026 123'],
        ['Hello\nworld\n123\n456', 'Hello world 123 456'],
        ['hello,\nworld', 'hello, world'],
        ['Ａ\nＢ\n１２\n３４', 'Ａ Ｂ １２ ３４'],
        ['ｹﾞｰﾑ\nの話', 'ｹﾞｰﾑの話'],
        ['日本語  OCR\n結果\n1200円', '日本語  OCR結果1200円'],
        ['日本語 OCR 2026', '日本語 OCR 2026'],
        ['いや\\催眠術なんだから', 'いや\\催眠術なんだから'],
        [' \r\n\t\u2028 ', ''],
    ]) assert.equal(prepareTranslationInput(input), expected, JSON.stringify(input));
});

test('serializes translations and reuses a ready pair session', async () => {
    const first = deferred();
    const f = factory({ translate: async (text) => text === 'first' ? first.promise : 'second translation' });
    const h = harness({ api: f.api });
    const one = h.service.translate(request('one', 'en', 'first'));
    const two = h.service.translate(request('two', 'en', 'second'));
    await flush();
    assert.equal(f.events.filter(([event]) => event === 'translate').length, 1);
    first.resolve('first translation');
    assert.deepEqual(plain(await one), { ok: true, text: 'first translation' });
    assert.deepEqual(plain(await two), { ok: true, text: 'second translation' });
    assert.equal(f.sessions.length, 1);
    assert.equal(h.timers.size, 0);
});

test('changing pairs destroys the previous session', async () => {
    const f = factory();
    const h = harness({ api: f.api });
    await h.service.translate(request('one'));
    await h.service.translate(request('two', 'fr'));
    assert.equal(f.sessions.length, 2);
    assert.equal(f.events.filter(([event]) => event === 'destroy').length, 1);
});

test('active cancellation settles a browser call that ignores abort and allows a fresh session', async () => {
    const hanging = deferred();
    const f = factory({ translate: (text) => text === 'hang' ? hanging.promise : Promise.resolve('next') });
    const h = harness({ api: f.api });
    const first = h.service.translate(request('one', 'en', 'hang'));
    await flush();
    h.service.cancel('one');
    assert.equal((await first).reason, 'cancelled');
    assert.deepEqual(plain(await h.service.translate(request('two'))), { ok: true, text: 'next' });
    assert.equal(f.sessions.length, 2);
    hanging.resolve('stale');
    await flush();
    assert.equal(f.events.filter(([event]) => event === 'destroy').length, 1);
});

test('queued cancellation does not destroy the active session', async () => {
    const first = deferred();
    const f = factory({ translate: () => first.promise });
    const h = harness({ api: f.api });
    const one = h.service.translate(request('one'));
    const two = h.service.translate(request('two'));
    await flush();
    h.service.cancel('two');
    assert.equal((await two).reason, 'cancelled');
    assert.equal(f.events.filter(([event]) => event === 'destroy').length, 0);
    first.resolve('hello');
    assert.equal((await one).ok, true);
    assert.equal(f.events.filter(([event]) => event === 'translate').length, 1);
});

test('60-second deadline includes queued work, aborts hanging API calls, and permits retry', async () => {
    const f = factory({ translate: () => new Promise(() => {}) });
    const h = harness({ api: f.api });
    const one = h.service.translate(request('one'));
    const two = h.service.translate(request('two'));
    await flush();
    assert.deepEqual([...h.timers.values()].map(({ milliseconds }) => milliseconds), [60_000, 60_000]);
    h.expire();
    assert.equal((await one).reason, 'timeout');
    assert.equal((await two).reason, 'timeout');
    assert.equal(f.events.filter(([event]) => event === 'translate').length, 1);
    assert.equal(f.events.filter(([event]) => event === 'destroy').length, 1);
    f.api.create = async () => ({ async translate() { return 'recovered'; }, destroy() {} });
    assert.equal((await h.service.translate(request('retry'))).text, 'recovered');
});

test('a session created after cancellation is destroyed rather than cached', async () => {
    const creating = deferred();
    let destroyed = 0;
    const f = factory({ create: () => creating.promise });
    const h = harness({ api: f.api });
    const one = h.service.translate(request('one'));
    await flush();
    h.service.cancel('one');
    assert.equal((await one).reason, 'cancelled');
    creating.resolve({ async translate() { throw new Error('Must not translate'); }, destroy() { destroyed++; } });
    await flush();
    assert.equal(destroyed, 1);
});

test('reset cancels active and queued requests and disposes only translation state', async () => {
    const f = factory({ translate: () => new Promise(() => {}) });
    const h = harness({ api: f.api });
    const one = h.service.translate(request('one'));
    const two = h.service.translate(request('two'));
    await flush();
    h.service.reset();
    assert.equal((await one).reason, 'cancelled');
    assert.equal((await two).reason, 'cancelled');
    assert.equal(f.events.filter(([event]) => event === 'destroy').length, 1);
});

test('translation failure destroys the session and retries through a new session', async () => {
    let fail = true;
    const f = factory({ translate: async () => { if (fail) throw new Error('Session disconnected'); return 'hello'; } });
    const h = harness({ api: f.api });
    assert.equal((await h.service.translate(request('one'))).reason, 'error');
    fail = false;
    assert.equal((await h.service.translate(request('two'))).text, 'hello');
    assert.equal(f.sessions.length, 2);
    assert.equal(f.events.filter(([event]) => event === 'destroy').length, 1);
});

const backgroundCode = compile('../src/background/index.ts');
const messageCode = compile('../src/interfaces/message.ts');
const messageContext = vm.createContext({ exports: {} });
vm.runInContext(messageCode, messageContext);
const actions = messageContext.exports.NamidaMessageAction;

function backgroundHarness({ existingHost = false, createDocument, sendMessage, enabled = true, settings = { enabled: true, targetLanguage: 'en' } } = {}) {
    let dispatch, changed;
    const sent = [], creations = [], contextChecks = [], popups = [];
    const runtime = {
        onMessage: { addListener(listener) { dispatch = listener; } },
        getURL: (path) => `chrome-extension://test/${path}`,
        async sendMessage(message) {
            sent.push(message);
            if (sendMessage) await sendMessage(message);
            return message.action === actions.GetTranslationStatusOffscreen ? { state: 'available' } : { ok: true, text: 'hello' };
        },
    };
    const modules = {
        'webextension-polyfill': { runtime, commands: { onCommand: { addListener() {} } }, tabs: {} },
        'tesseract.js': { PSM: {} },
        '../interfaces/message': messageContext.exports,
        './Upscaler': { Upscaler: {} },
        '../interfaces/Storage': { Settings: { async getTranslationSettings() { return settings; } }, StorageKey: { TranslationEnabled: 'TranslationEnabled', TranslationTargetLanguage: 'TranslationTargetLanguage' } },
        './FuriganaHandler': { FuriganaHandler: {} },
        'namida-background-ocr-service': { BackgroundOcrService: { init() { throw new Error('Opening translation must not initialize OCR'); } } },
        '../translation/TranslatorApi': { isTranslationPlatformSupported: () => enabled },
    };
    vm.runInContext(backgroundCode, vm.createContext({
        exports: {}, __NAMIDA_TRANSLATION_ENABLED__: enabled,
        require(name) { assert.ok(name in modules, name); return modules[name]; },
        console: { log() {}, warn() {} },
        chrome: {
            action: { async openPopup(options) { popups.push(plain(options)); } },
            runtime: {
                ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
                async getContexts(filter) { contextChecks.push(plain(filter)); return existingHost ? [{}] : []; },
            },
            storage: { onChanged: { addListener(listener) { changed = listener; } } },
            offscreen: { Reason: { WORKERS: 'WORKERS' }, async createDocument(options) {
                creations.push(options);
                if (createDocument) await createDocument();
                existingHost = true;
            } },
        },
    }));
    return { sent, creations, contextChecks, popups, changed, dispatch: (action, data, tabId = 1) => dispatch({ action, data }, { tab: { id: tabId, windowId: 7 } }) };
}

test('translation settings opens the toolbar popup without creating a tab or offscreen host', async () => {
    const h = backgroundHarness();
    await h.dispatch(actions.OpenTranslationSettings);
    assert.deepEqual(h.popups, [{ windowId: 7 }]);
    assert.equal(h.creations.length, 0);
    assert.equal(h.sent.length, 0);
    const firefox = backgroundHarness({ enabled: false });
    await firefox.dispatch(actions.OpenTranslationSettings);
    assert.equal(firefox.popups.length, 0);
});

test('background accepts the automatic default but rejects an explicit off preference', async () => {
    const automatic = backgroundHarness({ settings: { targetLanguage: 'en' } });
    assert.equal((await automatic.dispatch(actions.TranslateText, request('auto'))).ok, true);
    const disabled = backgroundHarness({ settings: { enabled: false, targetLanguage: 'en' } });
    assert.equal((await disabled.dispatch(actions.TranslateText, request('off'))).reason, 'cancelled');
    assert.equal(disabled.creations.length, 0);
});

test('regular status checks leave an unused host untouched; post-setup checks share getContexts/create', async () => {
    const h = backgroundHarness();
    assert.equal((await h.dispatch(actions.GetTranslationStatus, { targetLanguage: 'en' })).state, 'error');
    assert.equal(h.creations.length, 0);
    await Promise.all([1, 2].map(() => h.dispatch(actions.GetTranslationStatus, { targetLanguage: 'en', ensureHost: true })));
    assert.equal(h.creations.length, 1);
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.contextChecks[0], { contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: ['chrome-extension://test/offscreen/offscreen.html'] });
});

test('routes IDs per sender tab and cancellation cannot target another tab', async () => {
    const h = backgroundHarness({ existingHost: true });
    await h.dispatch(actions.TranslateText, request('same-id'), 4);
    await h.dispatch(actions.TranslateText, request('same-id'), 9);
    await h.dispatch(actions.CancelTranslation, { requestId: 'same-id' }, 4);
    assert.deepEqual(h.sent.map(({ data }) => data.requestId), ['4:same-id', '9:same-id', '4:same-id']);
});

test('cancellation during offscreen creation prevents subsequent translation dispatch', async () => {
    const creating = deferred();
    const h = backgroundHarness({ createDocument: () => creating.promise });
    const translating = h.dispatch(actions.TranslateText, request('pending'));
    await flush();
    await h.dispatch(actions.CancelTranslation, { requestId: 'pending' });
    creating.resolve();
    assert.equal((await translating).reason, 'cancelled');
    assert.equal(h.sent.length, 0);
});

test('sync preference changes reset translation in an existing host without OCR activity', async () => {
    const h = backgroundHarness({ existingHost: true });
    h.changed({ TranslationEnabled: { newValue: false } }, 'sync');
    await flush();
    assert.equal(h.sent.at(-1).action, actions.ResetTranslationOffscreen);
});

test('new requests wait for a pending settings reset without being cancelled by that reset', async () => {
    const resetting = deferred();
    const h = backgroundHarness({ existingHost: true, sendMessage(message) {
        if (message.action === actions.ResetTranslationOffscreen) return resetting.promise;
    } });
    h.changed({ TranslationTargetLanguage: { newValue: 'en' } }, 'sync');
    const translating = h.dispatch(actions.TranslateText, request('new-target'));
    await flush();
    assert.deepEqual(h.sent.map(({ action }) => action), [actions.ResetTranslationOffscreen]);
    resetting.resolve();
    assert.equal((await translating).text, 'hello');
    assert.deepEqual(h.sent.map(({ action }) => action), [actions.ResetTranslationOffscreen, actions.TranslateTextOffscreen]);
});

test('Firefox translation requests do not touch Chromium host APIs', async () => {
    const h = backgroundHarness({ enabled: false });
    assert.equal((await h.dispatch(actions.TranslateText, request('one'))).reason, 'unsupported');
    assert.equal((await h.dispatch(actions.GetTranslationStatus, { targetLanguage: 'en', ensureHost: true })).state, 'unsupported');
    assert.equal(h.contextChecks.length, 0);
    assert.equal(h.creations.length, 0);
    assert.equal(h.sent.length, 0);
});
