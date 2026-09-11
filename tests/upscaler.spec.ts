import { writeFile } from 'node:fs/promises';
import { expect, test } from './extension.fixtures';
import { NamidaMessageAction } from '../src/interfaces/message';

// Run through the normal Chromium extension fixtures with --workers 5 or more.
// The model and its shards must load from the extension even when offline.
test('AI upscaling uses one bundled model for repeated offline requests', async ({ context, page, serviceWorker, extensionId }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    await serviceWorker.evaluate(() => {
        const state = globalThis as typeof globalThis & { __namidaUpscaleFetches?: string[] };
        state.__namidaUpscaleFetches = [];
        const originalFetch = globalThis.fetch.bind(globalThis);
        globalThis.fetch = (input, init) => {
            state.__namidaUpscaleFetches!.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
            return originalFetch(input, init);
        };
    });
    await context.setOffline(true);

    // A rejected request must not initialize the AI model or poison the next request.
    const invalid = await page.evaluate(async action => {
        try {
            const result = await chrome.runtime.sendMessage({ action, data: { shape: [8, 8, 3], imageData: [0] } });
            return typeof result?.message === 'string' ? result.message : JSON.stringify(result);
        } catch (error) {
            return String(error);
        }
    }, NamidaMessageAction.UpscaleImage);
    expect(invalid).toContain('valid RGB image');
    const beforeAi = await serviceWorker.evaluate(() => (globalThis as typeof globalThis & { __namidaUpscaleFetches: string[] }).__namidaUpscaleFetches);
    expect(beforeAi.filter(url => url.includes('/libs/tensorflow/'))).toEqual([]);

    const results: Array<{ shape: number[]; imageData: number[]; elapsedMs: number }> = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await page.evaluate(async action => {
            const width = 8;
            const height = 8;
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = 'rgb(32,32,32)';
            ctx.fillRect(0, 0, width / 2, height);
            ctx.fillStyle = 'rgb(224,224,224)';
            ctx.fillRect(width / 2, 0, width / 2, height);
            const rgba = ctx.getImageData(0, 0, width, height).data;
            const rgb: number[] = [];
            for (let offset = 0; offset < rgba.length; offset += 4) rgb.push(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
            const startedAt = performance.now();
            const response = await chrome.runtime.sendMessage({ action, data: {
                shape: [height, width, 3], imageData: rgb, dataUrl: canvas.toDataURL('image/png'),
            } });
            if (response?.__mozWebExtensionPolyfillReject__) throw new Error(response.message);
            if (!response) throw new Error('AI upscaling returned no image');
            // Chromium currently returns serialized RGB tensors. Retain support for
            // an image response if the inference host moves into a document later.
            if (typeof response.dataUrl === 'string') {
                const image = new Image();
                image.src = response.dataUrl;
                await image.decode();
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                ctx.drawImage(image, 0, 0);
                const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                const imageData: number[] = [];
                for (let offset = 0; offset < pixels.length; offset += 4) imageData.push(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
                return { shape: [canvas.height, canvas.width, 3], imageData, elapsedMs: performance.now() - startedAt };
            }
            return { shape: response.shape as number[], imageData: response.imageData as number[], elapsedMs: performance.now() - startedAt };
        }, NamidaMessageAction.UpscaleImage);
        expect(result.shape).toEqual([16, 16, 3]);
        expect(result.imageData).toHaveLength(16 * 16 * 3);
        expect(result.imageData.every(value => Number.isFinite(value) && value >= 0 && value <= 255)).toBe(true);
        expect(Math.max(...result.imageData) - Math.min(...result.imageData)).toBeGreaterThan(64);
        const meanSide = (startX: number, endX: number) => {
            let sum = 0;
            let count = 0;
            for (let y = 2; y < 14; y++) {
                for (let x = startX; x < endX; x++) {
                    sum += result.imageData[(y * 16 + x) * 3];
                    count++;
                }
            }
            return sum / count;
        };
        expect(meanSide(10, 14) - meanSide(2, 6)).toBeGreaterThan(64);
        if (results.length) {
            const maximumChange = Math.max(...result.imageData.map((value, index) => Math.abs(value - results[0].imageData[index])));
            expect(maximumChange).toBeLessThanOrEqual(1);
        }
        results.push(result);
    }
    const fetches = await serviceWorker.evaluate(() => (globalThis as typeof globalThis & { __namidaUpscaleFetches: string[] }).__namidaUpscaleFetches);
    expect(fetches.every(url => url.startsWith(`chrome-extension://${extensionId}/`))).toBe(true);
    expect(fetches.filter(url => url.endsWith('/libs/tensorflow/x2/model.json'))).toHaveLength(1);
    expect(fetches.some(url => url.includes('/libs/tensorflow/x2/') && url.endsWith('.bin'))).toBe(true);
    const evidencePath = testInfo.outputPath('upscaler-offline-results.json');
    await writeFile(evidencePath, JSON.stringify({ fetches, results }, null, 2));
    await testInfo.attach('upscaler-offline-results.json', { path: evidencePath, contentType: 'application/json' });
});
