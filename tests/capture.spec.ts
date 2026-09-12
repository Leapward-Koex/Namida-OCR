import { expect, test } from './extension.fixtures';
import { NamidaMessageAction } from '../src/interfaces/message';

test('captures clean pixels without the snip overlay, OCR status, or previous result', async ({ page, context, serviceWorker, extensionId }, testInfo) => {
    await serviceWorker.evaluate(async () => {
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set({
            OcrBackend: 'paddleonnx',
            OcrModel: 'jpn',
            OcrDebugArtifacts: false,
            UpscalingMode: 'none',
            FuriganaType: 'none',
            SaveOcrCrop: false,
            ShowSpeakButton: false,
            WindowTimeout: '-1',
        });
    });
    const cdp = await context.newCDPSession(page);
    const executionContexts: Array<{ id: number; origin: string; name: string }> = [];
    cdp.on('Runtime.executionContextCreated', ({ context }) => executionContexts.push(context));
    await cdp.send('Runtime.enable');
    await page.goto('/ocr-page.html');
    await page.evaluate(() => {
        document.body.innerHTML = '<div id="capture-target"></div>';
        document.body.style.cssText = 'margin:0;background:rgb(255,255,255);';
        const target = document.getElementById('capture-target')!;
        target.style.cssText = 'position:fixed;left:220px;top:180px;width:240px;height:160px;background:rgb(31,93,181);';
        // Distinct flat colors expose tinting and dashed selection borders without
        // making this capture test depend on fonts or recognition accuracy.
        target.innerHTML = '<div style="position:absolute;left:40px;top:30px;width:90px;height:70px;background:rgb(232,151,47)"></div>';
    });
    await page.bringToFront();
    await expect.poll(() => executionContexts.some((entry) => entry.origin === `chrome-extension://${extensionId}`)).toBe(true);
    const contentContext = executionContexts.find((entry) => entry.origin === `chrome-extension://${extensionId}`)!;
    const probe = await cdp.send('Runtime.evaluate', {
        contextId: contentContext.id,
        expression: `(${installCaptureProbe.toString()})(${JSON.stringify({
            captureAction: NamidaMessageAction.CaptureFullScreen,
            recognizeAction: NamidaMessageAction.RecognizeImage,
            preloadAction: NamidaMessageAction.PreloadOcr,
        })})`,
        returnByValue: true,
    });
    expect(probe.exceptionDetails, JSON.stringify(probe.exceptionDetails)).toBeUndefined();

    // Use the same browser capture API as the product for a clean pixel reference.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const reference = await serviceWorker.evaluate(() => chrome.tabs.captureVisibleTab(undefined, { format: 'png' }));
    for (let round = 0; round < 2; round += 1) {
        if (round === 1) {
            // Put the previous result directly over the target so its pixels would
            // certainly corrupt a second snip unless hideForCapture is effective.
            await page.getByTestId('namida-floating-window').evaluate((element) => {
                const window = element as HTMLElement;
                window.style.left = '220px';
                window.style.top = '180px';
                window.style.right = 'auto';
                window.style.bottom = 'auto';
                window.style.width = '240px';
                window.style.height = '160px';
                window.style.opacity = '1';
            });
            await expect(page.getByTestId('namida-floating-window')).toBeVisible();
        }
        // Chromium permits at most two captureVisibleTab calls per second.
        await page.waitForTimeout(600);
        await serviceWorker.evaluate(async (action) => {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (!tab.id) throw new Error('Capture test has no active tab.');
            await chrome.tabs.sendMessage(tab.id, { action });
        }, NamidaMessageAction.SnipPage);
        await expect(page.getByTestId('namida-snip-overlay')).toBeVisible();
        await page.mouse.move(220, 180);
        await page.mouse.down();
        await page.mouse.move(460, 340, { steps: 5 });
        await page.mouse.up();
        await expect.poll(async () => {
            const progress = await cdp.send('Runtime.evaluate', {
                contextId: contentContext.id,
                expression: 'globalThis.__namidaCaptureProbe.recognitionRequests',
                returnByValue: true,
            });
            return progress.result.value;
        }).toBe(round + 1);
        await expect(page.getByTestId('namida-floating-window-text')).toHaveText('日本語 OCR 2026');

        const captured = await cdp.send('Runtime.evaluate', {
            contextId: contentContext.id,
            expression: 'globalThis.__namidaCaptureProbe',
            returnByValue: true,
        });
        const observation = captured.result.value as {
            captureRequests: number;
            overlayAtCapture: boolean;
            statusAtCapture: boolean;
            windowAttachedAtCapture: boolean;
            dataUrl: string;
        };
        expect(observation.captureRequests).toBe(round + 1);
        expect(observation.overlayAtCapture).toBe(false);
        expect(observation.statusAtCapture).toBe(false);
        expect(observation.windowAttachedAtCapture).toBe(round === 1);
        expect(observation.dataUrl).toMatch(/^data:image\/png;base64,/u);
        await testInfo.attach(`captured-clean-crop-${round + 1}.png`, {
            body: Buffer.from(observation.dataUrl.split(',')[1], 'base64'),
            contentType: 'image/png',
        });
        const comparison = await page.evaluate(async ({ reference, crop }) => {
            async function decode(dataUrl: string) {
                const img = new Image();
                img.src = dataUrl;
                await img.decode();
                return img;
            }
            const [screen, actual] = await Promise.all([decode(reference), decode(crop)]);
            const ratio = window.devicePixelRatio;
            // Preserve the existing 2px content-box selection border: width/height +4.
            const width = 244 * ratio;
            const height = 164 * ratio;
            const expectedCanvas = document.createElement('canvas');
            expectedCanvas.width = width;
            expectedCanvas.height = height;
            const expectedContext = expectedCanvas.getContext('2d')!;
            expectedContext.drawImage(screen, 220 * ratio, 180 * ratio, width, height, 0, 0, width, height);
            const actualCanvas = document.createElement('canvas');
            actualCanvas.width = actual.width;
            actualCanvas.height = actual.height;
            const actualContext = actualCanvas.getContext('2d')!;
            actualContext.drawImage(actual, 0, 0);
            const expectedPixels = expectedContext.getImageData(0, 0, width, height).data;
            const actualPixels = actualContext.getImageData(0, 0, actual.width, actual.height).data;
            let differingChannels = 0;
            for (let index = 0; index < expectedPixels.length; index += 1) {
                if (expectedPixels[index] !== actualPixels[index]) differingChannels += 1;
            }
            return { width: actual.width, height: actual.height, expectedWidth: width, expectedHeight: height, differingChannels };
        }, { reference, crop: observation.dataUrl });
        expect(comparison.width).toBe(comparison.expectedWidth);
        expect(comparison.height).toBe(comparison.expectedHeight);
        expect(comparison.differingChannels, JSON.stringify(comparison)).toBe(0);
    }
    await cdp.detach();
});

// Runs in the extension's content-script world. Actual screenshot requests remain
// untouched; only OCR is stubbed so this regression test never loads model assets.
function installCaptureProbe({ captureAction, recognizeAction, preloadAction }: { captureAction: number; recognizeAction: number; preloadAction: number }) {
    const root = globalThis as typeof globalThis & {
        __namidaCaptureProbe?: { captureRequests: number; recognitionRequests: number; overlayAtCapture: boolean; statusAtCapture: boolean; windowAttachedAtCapture: boolean; dataUrl: string };
    };
    const observation = { captureRequests: 0, recognitionRequests: 0, overlayAtCapture: false, statusAtCapture: false, windowAttachedAtCapture: false, dataUrl: '' };
    root.__namidaCaptureProbe = observation;
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((...args: unknown[]) => {
        const message = args.find((arg) => typeof arg === 'object' && arg !== null && 'action' in arg) as { action: number; data?: string } | undefined;
        if (message?.action === preloadAction) {
            const callback = args.at(-1);
            if (typeof callback === 'function') {
                queueMicrotask(() => callback());
                return;
            }
            return Promise.resolve();
        }
        if (message?.action === captureAction) {
            observation.captureRequests += 1;
            observation.overlayAtCapture = Boolean(document.querySelector('[data-testid="namida-snip-overlay"]'));
            const floatingWindow = document.querySelector('[data-testid="namida-floating-window"]');
            observation.windowAttachedAtCapture = Boolean(floatingWindow);
            observation.statusAtCapture = Boolean(floatingWindow
                && getComputedStyle(floatingWindow).visibility !== 'hidden'
                && getComputedStyle(floatingWindow).display !== 'none');
        }
        if (message?.action === recognizeAction) {
            observation.recognitionRequests += 1;
            observation.dataUrl = message.data ?? '';
            const callback = args.at(-1);
            if (typeof callback === 'function') {
                queueMicrotask(() => callback('日本語 OCR 2026'));
                return;
            }
            return Promise.resolve('日本語 OCR 2026');
        }
        return Reflect.apply(originalSendMessage, chrome.runtime, args);
    }) as typeof chrome.runtime.sendMessage;
}
