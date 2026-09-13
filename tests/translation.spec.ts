import { expect, test } from './extension.fixtures';
import { NamidaMessageAction as Action } from '../src/interfaces/message';
import type { CDPSession } from '@playwright/test';

test('missing Translator is feature-detected without starting OCR or downloading', async ({ page, context, serviceWorker, extensionId }) => {
    await context.addInitScript(() => { delete (self as any).Translator; });
    await context.setOffline(true);
    await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    expect(await page.evaluate(() => 'Translator' in self)).toBe(false);
    await expect(page.locator('#translation-status')).toHaveText('Local translation is unavailable in this browser');
    await expect(page.locator('#translation-enabled')).toBeDisabled();
    await expect(page.locator('#translation-target-language')).toBeDisabled();
    await expect(page.locator('#translation-setup')).toBeDisabled();
    expect(await serviceWorker.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
});

test('one download click reports progress, verifies readiness and enables translation', async ({ page, context, serviceWorker, extensionId }, testInfo) => {
    await context.addInitScript(installSettingsProbe, { statusAction: Action.GetTranslationStatus });
    await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    expect(await page.evaluate(() => 'Translator' in self)).toBe(true);
    await expect(page.locator('#translation-setup')).toHaveText('Download & enable');
    await expect(page.getByRole('button', { name: 'Open settings in a tab' })).toHaveCount(0);
    await expect(page.locator('#translation-enabled')).not.toBeChecked();
    await expect(page.locator('#translation-target-language')).toHaveValue('en');
    expect(await page.evaluate(() => (self as any).__translationSettingsProbe.created)).toEqual([]);
    expect(await serviceWorker.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
    await page.locator('#translation-target-language').selectOption('fr');
    await expect(page.locator('#translation-setup')).toBeEnabled();
    await page.locator('#translation-setup').click();
    await expect(page.locator('#translation-status')).toContainText('50%');
    await expect(page.locator('#translation-status')).toContainText('Keep this popup open');
    await expect(page.locator('#translation-setup')).toBeHidden();
    await expect(page.locator('#translation-cancel-setup')).toBeVisible();
    await page.locator('.settings-container').screenshot({ path: testInfo.outputPath('settings-downloading.png') });
    expect(await page.evaluate(() => (self as any).__translationSettingsProbe.created)).toEqual([{ sourceLanguage: 'ja', targetLanguage: 'fr', active: true }]);
    await page.evaluate(() => (self as any).__translationSettingsProbe.finish());
    await expect(page.locator('#translation-status')).toHaveText('Ready for offline translation.');
    await expect(page.locator('#translation-setup')).toBeHidden();
    await expect(page.locator('#translation-cancel-setup')).toBeHidden();
    expect(await page.evaluate(() => (self as any).__translationSettingsProbe.destroyed)).toBe(1);
    await expect(page.locator('#translation-enabled')).toBeChecked();
    await expect.poll(() => serviceWorker.evaluate(() => chrome.storage.sync.get(['TranslationEnabled', 'TranslationTargetLanguage']))).toEqual({ TranslationEnabled: true, TranslationTargetLanguage: 'fr' });
    await page.reload();
    await expect(page.locator('#translation-enabled')).toBeChecked();
    await expect(page.locator('#translation-target-language')).toHaveValue('fr');
    expect(await page.evaluate(() => (self as any).__translationSettingsProbe.created)).toEqual([]);
});

test('Japanese appears first, translation is text-only, and copying translation is explicit', async ({ page, context, serviceWorker, extensionId }, testInfo) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await probe.snip();
    await expect(page.getByTestId('namida-floating-window-text')).toHaveText('日本語 OCR 2026');
    await expect(page.getByTestId('namida-translation')).toContainText('Translating');
    expect(await probe.read('copies')).toEqual(['日本語 OCR 2026']);
    await probe.finish(0, '<img src=x onerror=alert(1)> English translation');
    await expect(page.getByTestId('namida-translation-text')).toHaveText('<img src=x onerror=alert(1)> English translation');
    await expect(page.getByTestId('namida-translation-text').locator('img')).toHaveCount(0);
    await expect(page.getByTestId('namida-floating-window-text')).toHaveText('日本語 OCR 2026');
    expect(await probe.read('copies')).toEqual(['日本語 OCR 2026']);
    await expect(page.getByTestId('namida-japanese-actions').getByRole('button', { name: 'Copy Japanese', exact: true })).toBeVisible();
    await expect(page.getByTestId('namida-translation-actions').getByRole('button', { name: 'Copy English', exact: true })).toBeVisible();
    await page.getByTestId('namida-copy-translation').click();
    await expect(page.getByRole('button', { name: 'English copied', exact: true })).toBeVisible();
    expect(await probe.read('copies')).toEqual(['日本語 OCR 2026', '<img src=x onerror=alert(1)> English translation']);
    await page.getByTestId('namida-copy-japanese').click();
    expect(await probe.read('copies')).toEqual(['日本語 OCR 2026', '<img src=x onerror=alert(1)> English translation', '日本語 OCR 2026']);
    await page.screenshot({ path: testInfo.outputPath('translation-result.png') });
});

test('multiline OCR sends every plain Japanese line even when furigana is displayed', async ({ page, context, serviceWorker, extensionId }, testInfo) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    const source = 'いや\n催眠術なんだから\n普通に眠らせる技だろ\n何言ってんだコイツ……';
    const translation = "No.\nIt's hypnosis.\nIt's a technique to put people to sleep.\nWhat is this guy talking about?";
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ FuriganaType: 'hiragana' }));
    await probe.evaluate(`Object.assign(self.__translationContentProbe, ${JSON.stringify({
        sourceText: source,
        furiganaTokens: [
            { surface_form: 'いや\n' }, { surface_form: '催眠術', reading: 'サイミンジュツ' },
            { surface_form: 'なんだから\n普通に眠らせる技だろ\n何言ってんだコイツ……' },
        ],
    })})`);
    await probe.snip();
    await expect(page.getByTestId('namida-floating-window-text').locator('rt')).toHaveText('さいみんじゅつ');
    expect(await probe.read('sources')).toEqual([source]);
    expect(await probe.read('copies')).toEqual([source]);
    await probe.finish(0, translation);
    expect(await page.getByTestId('namida-translation-text').textContent()).toBe(translation);
    await page.getByTestId('namida-floating-window').screenshot({ path: testInfo.outputPath('result-language-actions.png') });
    await page.getByTestId('namida-copy-translation').click();
    expect(await probe.read('copies')).toEqual([source, translation]);
});

test('translation defaults to automatic only when the selected model is ready', async ({ page, context, serviceWorker, extensionId }) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await serviceWorker.evaluate(() => chrome.storage.sync.remove('TranslationEnabled'));
    await probe.evaluate(`self.__translationContentProbe.readiness = 'downloadable'`);
    await probe.snip(false);
    await expect.poll(() => probe.read('statusChecks')).toEqual(['en']);
    expect(await probe.read('targets')).toEqual([]);
    await expect(page.getByTestId('namida-translation')).toBeHidden();
    await probe.evaluate(`self.__translationContentProbe.readiness = 'available'`);
    await probe.snip();
    await probe.finish(0, 'Ready model translation');
    await expect(page.getByTestId('namida-translation-text')).toHaveText('Ready model translation');
    expect(await serviceWorker.evaluate(() => chrome.storage.sync.get('TranslationEnabled'))).toEqual({});
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ TranslationEnabled: false }));
    await probe.snip(false);
    expect(await probe.read('targets')).toEqual(['en']);
    await expect(page.getByTestId('namida-translation')).toBeHidden();
});

test('Speak stays with the Japanese controls and reads the original text after translation', async ({ page, context, serviceWorker, extensionId }) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ ShowSpeakButton: true }));
    await probe.evaluate(`(() => {
        const probe = self.__translationContentProbe;
        probe.spoken = [];
        self.SpeechSynthesisUtterance = class {
            constructor(text) { this.text = text; }
            addEventListener(type, callback) { if (type === 'end') this.end = callback; }
        };
        Object.defineProperties(speechSynthesis, {
            getVoices: { configurable: true, value: () => [{ name: 'Japanese test voice', voiceURI: 'ja-test', lang: 'ja-JP' }] },
            speak: { configurable: true, value: utterance => { probe.spoken.push(utterance.text); queueMicrotask(() => utterance.end()); } },
            cancel: { configurable: true, value: () => {} },
            speaking: { configurable: true, get: () => false },
        });
        speechSynthesis.dispatchEvent(new Event('voiceschanged'));
    })()`);
    await probe.snip();
    await probe.finish(0, 'Translated English');
    const speak = page.getByTestId('namida-japanese-actions').getByRole('button', { name: 'Speak Japanese', exact: true });
    await expect(speak).toBeVisible();
    await speak.click();
    await expect.poll(() => probe.read('spoken')).toEqual(['日本語 OCR 2026']);
});

test('a dismissed result is never reopened by late translation', async ({ page, context, serviceWorker, extensionId }) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await probe.snip();
    await page.getByRole('button', { name: 'Dismiss OCR result' }).click();
    await probe.finish(0, 'Too late');
    await expect(page.getByTestId('namida-floating-window')).toHaveCount(0);
    expect((await probe.read('cancelled')).length).toBeGreaterThan(0);
});

test('target changes and disabling translation discard old results', async ({ page, context, serviceWorker, extensionId }) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await probe.snip();
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ TranslationTargetLanguage: 'fr' }));
    await expect.poll(() => probe.read('targets')).toEqual(['en', 'fr']);
    await probe.finish(0, 'Old English');
    await expect(page.getByTestId('namida-translation-text')).toHaveText('');
    await probe.finish(1, 'Bonjour');
    await expect(page.getByTestId('namida-translation-text')).toHaveText('Bonjour');
    await expect(page.getByTestId('namida-translation-text')).toHaveAttribute('lang', 'fr');
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ TranslationEnabled: false }));
    await expect(page.getByTestId('namida-translation')).toBeHidden();
    await expect(page.getByTestId('namida-floating-window-text')).toHaveText('日本語 OCR 2026');
});

test('capture hides both pending and completed translation; a newer scan wins', async ({ page, context, serviceWorker, extensionId }) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await probe.snip();
    await probe.snip();
    await probe.finish(0, 'Old result');
    await expect(page.getByTestId('namida-translation-text')).toHaveText('');
    await probe.finish(1, 'Current result');
    await expect(page.getByTestId('namida-translation-text')).toHaveText('Current result');
    await probe.snip();
    expect(await probe.read('visibleAtCapture')).toEqual([false, false, false]);
});

test('unsupported API result retains Japanese and offers settings; no feature still allows OCR', async ({ page, context, serviceWorker, extensionId }) => {
    await context.addInitScript(() => { delete (self as any).Translator; });
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await probe.snip();
    await probe.evaluate(`self.__translationContentProbe.finish(0, {ok:false,reason:'unsupported',message:'Local translation is unavailable in this browser'})`);
    await expect(page.getByTestId('namida-translation')).toContainText('Local translation is unavailable in this browser');
    await expect(page.getByTestId('namida-floating-window-text')).toHaveText('日本語 OCR 2026');
    await expect(page.getByRole('button', { name: 'Open translation settings' })).toBeVisible();
});

test('translation errors can be retried without replacing Japanese', async ({ page, context, serviceWorker, extensionId }) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await probe.snip();
    await probe.evaluate(`self.__translationContentProbe.finish(0, {ok:false,reason:'error',message:'Translation failed.'})`);
    await expect(page.getByTestId('namida-floating-window-text')).toHaveText('日本語 OCR 2026');
    await page.getByRole('button', { name: 'Retry translation' }).click();
    await expect.poll(() => probe.read('targets')).toEqual(['en', 'en']);
    await probe.finish(1, 'Retry succeeded');
    await expect(page.getByTestId('namida-translation-text')).toHaveText('Retry succeeded');
    expect(await probe.read('copies')).toEqual(['日本語 OCR 2026']);
});

test('disabled translation and blank OCR do not request translation', async ({ page, context, serviceWorker, extensionId }) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ TranslationEnabled: false }));
    await probe.snip(false);
    await expect(page.getByTestId('namida-floating-window-text')).toHaveText('日本語 OCR 2026');
    await expect(page.getByTestId('namida-translation')).toBeHidden();
    expect(await probe.read('targets')).toEqual([]);
    await probe.evaluate(`self.__translationContentProbe.sourceText = ''`);
    await probe.snip(false);
    await expect(page.getByTestId('namida-floating-window')).toContainText('Failed to recognize text');
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ TranslationEnabled: true }));
    expect(await probe.read('targets')).toEqual([]);
});

test('translation pauses auto-dismiss and restarts its timeout after completion', async ({ page, context, serviceWorker, extensionId }) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ WindowTimeout: '150' }));
    await probe.snip();
    await page.waitForTimeout(400);
    await expect(page.getByTestId('namida-floating-window')).toBeVisible();
    await probe.finish(0, 'Finished');
    await expect(page.getByTestId('namida-floating-window')).toHaveCount(0);
});

test('enabling translation during fade restores the result until translation finishes', async ({ page, context, serviceWorker, extensionId }) => {
    const probe = await prepareContent({ page, context, serviceWorker, extensionId });
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ TranslationEnabled: false, WindowTimeout: '200' }));
    await probe.snip(false);
    // Observe the start of the CSS transition; computed opacity reaches zero
    // only when the scheduled removal is already due.
    await expect.poll(() => page.getByTestId('namida-floating-window').evaluate(element => (element as HTMLElement).style.opacity), { intervals: [20] }).toBe('0');
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ TranslationEnabled: true }));
    await expect.poll(() => probe.read('targets')).toEqual(['en']);
    await page.waitForTimeout(450);
    await expect(page.getByTestId('namida-floating-window')).toBeVisible();
    await probe.finish(0, 'Restored');
    await expect(page.getByTestId('namida-floating-window')).toHaveCount(0);
});

function installSettingsProbe({ statusAction }: { statusAction: number }) {
    const probe = { created: [] as unknown[], destroyed: 0, finish: () => {} };
    (self as any).__translationSettingsProbe = probe;
    let ready = false;
    Object.defineProperty(self, 'Translator', { configurable: true, value: {
        availability: async () => ready ? 'available' : 'downloadable',
        create(options: any) {
            probe.created.push({ sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage, active: navigator.userActivation.isActive });
            options.monitor?.({ addEventListener(_type: string, listener: any) { listener({ loaded: 0.5 }); } });
            return new Promise(resolve => { probe.finish = () => { ready = true; resolve({ destroy() { ++probe.destroyed; } }); }; });
        },
    } });
    // The browser/runtime lifecycle is covered separately; this isolates setup UI.
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((...args: any[]) => {
        const message = args.find(arg => arg && typeof arg === 'object' && 'action' in arg);
        if (message?.action === statusAction) {
            const callback = args.at(-1);
            if (typeof callback === 'function') { queueMicrotask(() => callback({ state: 'available' })); return; }
            return Promise.resolve({ state: 'available' });
        }
        return Reflect.apply(original, chrome.runtime, args);
    }) as any;
}

async function prepareContent({ page, context, serviceWorker, extensionId }: any) {
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ OcrBackend: 'paddleonnx', UpscalingMode: 'none', FuriganaType: 'none', ShowSpeakButton: false, WindowTimeout: '-1', TranslationEnabled: true, TranslationTargetLanguage: 'en' }));
    const cdp: CDPSession = await context.newCDPSession(page);
    const worlds: Array<{ id: number; origin: string }> = [];
    cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
    await cdp.send('Runtime.enable');
    await page.goto('/ocr-page.html');
    await page.evaluate(() => { document.body.innerHTML = ''; document.body.style.background = 'white'; });
    await expect.poll(() => worlds.some(world => world.origin === `chrome-extension://${extensionId}`)).toBe(true);
    const id = worlds.find(world => world.origin === `chrome-extension://${extensionId}`)!.id;
    const evaluate = async (expression: string) => {
        const result = await cdp.send('Runtime.evaluate', { contextId: id, expression, returnByValue: true, awaitPromise: true });
        expect(result.exceptionDetails, JSON.stringify(result.exceptionDetails)).toBeUndefined();
        return result.result.value;
    };
    await evaluate(`(${installContentProbe.toString()})(${JSON.stringify({ recognize: Action.RecognizeImage, preload: Action.PreloadOcr, furigana: Action.GenerateFurigana, translate: Action.TranslateText, status: Action.GetTranslationStatus, cancel: Action.CancelTranslation, capture: Action.CaptureFullScreen })})`);
    let scans = 0;
    return {
        evaluate,
        read: (key: string) => evaluate(`self.__translationContentProbe.${key}`),
        finish: (index: number, text: string) => evaluate(`self.__translationContentProbe.finish(${index}, ${JSON.stringify({ ok: true, text })})`),
        async snip(expectTranslation = true) {
            const expectedTranslations = (await evaluate('self.__translationContentProbe.targets.length')) + 1;
            if (scans) await page.waitForTimeout(600); // captureVisibleTab rate limit
            await page.bringToFront();
            await serviceWorker.evaluate(async (action: number) => {
                const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                await chrome.tabs.sendMessage(tab.id!, { action });
            }, Action.SnipPage);
            await expect(page.getByTestId('namida-snip-overlay')).toBeVisible();
            await page.mouse.move(200, 150);
            await page.mouse.down();
            await page.mouse.move(400, 300, { steps: 3 });
            await page.mouse.up();
            ++scans;
            if (expectTranslation) await expect.poll(() => evaluate('self.__translationContentProbe.targets.length')).toBe(expectedTranslations);
            else await expect.poll(() => evaluate('self.__translationContentProbe.recognized')).toBe(scans);
        },
    };
}

function installContentProbe(actions: Record<string, number>) {
    const callbacks: Array<(value: any) => void> = [];
    const probe = { sourceText: '日本語 OCR 2026', furiganaTokens: undefined as unknown, readiness: 'available', statusChecks: [] as string[], recognized: 0, sources: [] as string[], targets: [] as string[], cancelled: [] as string[], copies: [] as string[], visibleAtCapture: [] as boolean[], finish(index: number, value: any) { callbacks[index](value); } };
    (self as any).__translationContentProbe = probe;
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { probe.copies.push(text); } });
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((...args: any[]) => {
        const message = args.find(arg => arg && typeof arg === 'object' && 'action' in arg);
        let response: any;
        let intercepted = true;
        if (message?.action === actions.recognize) { response = probe.sourceText; ++probe.recognized; }
        else if (message?.action === actions.preload) response = undefined;
        else if (message?.action === actions.furigana) response = probe.furiganaTokens;
        else if (message?.action === actions.cancel) { probe.cancelled.push(message.data.requestId); }
        else if (message?.action === actions.status) { probe.statusChecks.push(message.data.targetLanguage); response = { state: probe.readiness }; }
        else if (message?.action === actions.translate) {
            probe.sources.push(message.data.text);
            probe.targets.push(message.data.targetLanguage);
            const callback = args.at(-1);
            if (typeof callback === 'function') { callbacks.push(callback); return; }
            return new Promise(resolve => callbacks.push(resolve));
        } else intercepted = false;
        if (intercepted) {
            const callback = args.at(-1);
            if (typeof callback === 'function') { queueMicrotask(() => callback(response)); return; }
            return Promise.resolve(response);
        }
        if (message?.action === actions.capture) {
            const element = document.querySelector('[data-testid="namida-floating-window"]');
            probe.visibleAtCapture.push(Boolean(element && getComputedStyle(element).visibility !== 'hidden'));
        }
        return Reflect.apply(original, chrome.runtime, args);
    }) as any;
}
