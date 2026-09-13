import { test, expect } from './extension.fixtures';

test('compact settings separates reading and recognition with keyboard navigation', async ({ context, page, extensionId, serviceWorker }, testInfo) => {
    await context.addInitScript(() => {
        Object.defineProperty(self, 'Translator', { configurable: true, value: {
            availability: async () => 'available',
            create() { throw new Error('Settings must not initialize translation'); },
        } });
    });
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ ShowSpeakButton: false, OcrBackend: 'tesseract' }));
    await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    const reading = page.getByRole('tab', { name: 'Reading', exact: true });
    const recognition = page.getByRole('tab', { name: 'Recognition', exact: true });
    await expect(reading).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#recognition-panel')).toBeHidden();
    await expect(page.locator('#translation-status')).toHaveText('Ready for offline translation.');
    await expect(page.locator('#translation-setup')).toBeHidden();
    await expect(page.locator('#speech-options')).toBeHidden();
    await page.locator('.settings-container').screenshot({ path: testInfo.outputPath('settings-reading.png') });
    const geometry = await page.locator('.settings-container').evaluate(element => ({
        width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
    }));
    expect(geometry).toEqual({ width: 420, height: 580, overflowX: false });
    expect(await page.locator('#translation-target-language').evaluate(element => getComputedStyle(element).fontSize)).toBe('13px');
    await page.setViewportSize({ width: 420, height: 450 });
    expect(await page.locator('.settings-container').evaluate(element => element.getBoundingClientRect().height)).toBe(450);
    await expect(page.locator('#build-version')).toBeInViewport();
    await page.setViewportSize({ width: 1280, height: 900 });
    await reading.focus();
    await reading.press('ArrowRight');
    await expect(recognition).toBeFocused();
    await expect(recognition).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#reading-panel')).toBeHidden();
    await expect(page.locator('#tesseract-settings')).toBeVisible();
    await expect(page.locator('#paddle-settings')).toBeHidden();
    await page.locator('#ocr-backend').selectOption('paddleonnx');
    await expect(page.locator('#tesseract-settings')).toBeHidden();
    await expect(page.locator('#paddle-settings')).toBeVisible();
    await expect(page.locator('#ocr-backend-description')).toHaveText('Better for difficult text. Slower; GPU recommended.');
    await expect(page.locator('#save-ocr-crop')).toBeHidden();
    await page.getByText('Troubleshooting', { exact: true }).click();
    await page.locator('#save-ocr-crop').check();
    await expect.poll(() => serviceWorker.evaluate(() => chrome.storage.sync.get(['OcrBackend', 'SaveOcrCrop']))).toEqual({ OcrBackend: 'paddleonnx', SaveOcrCrop: true });
    await page.locator('.settings-container').screenshot({ path: testInfo.outputPath('settings-recognition.png') });
    await recognition.press('Home');
    await expect(reading).toBeFocused();
    await expect(page.locator('#reading-panel')).toBeVisible();
    expect(await serviceWorker.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
});

test('speech options follow the toggle and recover when a Japanese voice becomes available', async ({ context, page, extensionId, serviceWorker }) => {
    await context.addInitScript(() => {
        (self as any).__settingsVoices = [];
        Object.defineProperty(speechSynthesis, 'getVoices', { value: () => (self as any).__settingsVoices });
    });
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ ShowSpeakButton: true }));
    await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    await expect(page.locator('#speech-options')).toBeVisible();
    await expect(page.locator('#speech-status')).toContainText('No Japanese voice');
    await expect(page.locator('#voice-demo-button')).toBeHidden();
    await page.evaluate(() => {
        (self as any).__settingsVoices = [{ name: 'Japanese test voice', voiceURI: 'ja-test', lang: 'ja-JP' }];
        speechSynthesis.dispatchEvent(new Event('voiceschanged'));
    });
    await expect(page.locator('#voice-selection')).toHaveValue('ja-test');
    await expect(page.locator('#speech-status')).toBeHidden();
    await expect(page.locator('#voice-demo-button')).toBeEnabled();
    await page.locator('#show-speak-button').uncheck();
    await expect(page.locator('#speech-options')).toBeHidden();
    await page.reload();
    await expect(page.locator('#show-speak-button')).not.toBeChecked();
    await expect(page.locator('#speech-options')).toBeHidden();
});

test('popup identifies its bundled build without starting OCR, offline', async ({ context, page, extensionId, serviceWorker }) => {
    await context.setOffline(true);
    await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    await expect(page.locator('#build-version')).toHaveText(manifest.version_name!);
    await expect(page.locator('#build-version')).toHaveAttribute('title', `Extension version ${manifest.version}`);
    const info = await page.evaluate(async () => (await fetch('../build-info.json')).json());
    expect(info.version).toBe(manifest.version);
    expect(info.versionName).toBe(manifest.version_name);
    expect(info.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(info.browser).toBe('chrome');
    expect(await serviceWorker.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
});
