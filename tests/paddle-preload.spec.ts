import { expect, test } from './extension.fixtures';
import { NamidaMessageAction } from '../src/interfaces/message';
import type { PaddleAccelerationStatus } from '../src/background/ocr/PaddleWorkerProtocol';

test('entering snip mode preloads both local Paddle sessions before capture and reuses them for a scan', async ({ page, context, serviceWorker, extensionId }) => {
    test.skip(process.env.NAMIDA_TEST_OCR_BACKEND === 'scribejs', 'Scribe-only builds do not expose Paddle.');
    test.skip(process.env.NAMIDA_TEST_EXPECT_STRICT_GPU === '1', 'This test explicitly selects CPU execution.');
    test.setTimeout(180_000);
    await serviceWorker.evaluate(async () => {
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set({
            OcrBackend: 'paddleonnx', PaddleOnnxGpuEnabled: false,
            UpscalingMode: 'none', FuriganaType: 'none', SaveOcrCrop: false,
            ShowSpeakButton: false, OcrDebugArtifacts: true,
        });
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    const status = () => popup.evaluate((action) => chrome.runtime.sendMessage({ action }),
        NamidaMessageAction.GetOcrAccelerationStatus) as Promise<PaddleAccelerationStatus | null>;
    expect(await status()).toBeNull();
    expect(await serviceWorker.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);

    await page.goto('/ocr-page.html');
    await page.evaluate(() => {
        document.body.innerHTML = '';
        document.body.style.cssText = 'margin:0;min-height:100vh;background:white';
    });
    await page.bringToFront();
    await serviceWorker.evaluate(async (action) => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab.id) throw new Error('No active tab to snip');
        await chrome.tabs.sendMessage(tab.id, { action });
    }, NamidaMessageAction.SnipPage);
    await expect(page.getByTestId('namida-snip-overlay')).toBeVisible();
    await expect.poll(async () => (await status())?.state, { timeout: 120_000 }).toBe('ready');
    const preloaded = (await status())!;
    expect(preloaded.provider).toBe('wasm');
    expect(preloaded.requestedGpu).toBe(false);
    expect(preloaded.sessionKeys).toEqual(['detector', 'recognizer']);
    expect(preloaded.successfulInferences).toBe(0);
    await expect(page.getByTestId('namida-snip-overlay')).toBeVisible();

    // A repeated activation must keep the loaded models and runtime generation.
    await popup.evaluate((action) => chrome.runtime.sendMessage({ action }), NamidaMessageAction.PreloadOcr);
    expect((await status())?.generation).toBe(preloaded.generation);
    await page.mouse.move(220, 180);
    await page.mouse.down();
    await page.mouse.move(460, 340, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('namida-snip-overlay')).toHaveCount(0);
    await expect.poll(async () => (await status())?.successfulInferences, { timeout: 60_000 }).toBe(1);
    const scanned = (await status())!;
    expect(scanned.generation).toBe(preloaded.generation);
    expect(scanned.sessionKeys).toEqual(preloaded.sessionKeys);
    expect(scanned.fallbackReason).toBeUndefined();
    // A blank selection should finish through the normal OCR path with no text.
    await expect.poll(() => popup.evaluate((action) => chrome.runtime.sendMessage({ action }),
        NamidaMessageAction.GetLastOcrDebugSnapshot)).toMatchObject({
        backend: 'paddleonnx', pipeline: { detectorRuns: 1, recognitionRuns: 0 },
    });
});
