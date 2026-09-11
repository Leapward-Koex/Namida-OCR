import { test, expect } from './extension.fixtures';

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
