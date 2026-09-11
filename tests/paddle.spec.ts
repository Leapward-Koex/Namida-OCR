import { expect, test } from './extension.fixtures';
import { NamidaMessageAction } from '../src/interfaces/message';

test('Paddle returns empty text for blank light and dark images without recognition retries', async ({ page, context, serviceWorker, extensionId }) => {
    test.skip(process.env.NAMIDA_TEST_OCR_BACKEND !== 'paddleonnx', 'Paddle-specific integration contract');
    await context.route(/^https?:\/\//, route => route.abort());
    await serviceWorker.evaluate(async () => {
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set({ OcrBackend: 'paddleonnx', OcrDebugArtifacts: true, PaddleOnnxGpuEnabled: true });
    });
    await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    const result = await page.evaluate(async ({ recognize, debug }) => {
        const images = ['#fff', '#222'].map(color => {
            const canvas = document.createElement('canvas');
            canvas.width = 240; canvas.height = 120;
            const context = canvas.getContext('2d')!;
            context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/png');
        });
        const texts = await Promise.all(images.map(data => chrome.runtime.sendMessage({ action: recognize, data })));
        const snapshot = await chrome.runtime.sendMessage({ action: debug });
        return { texts, snapshot };
    }, { recognize: NamidaMessageAction.RecognizeImage, debug: NamidaMessageAction.GetLastOcrDebugSnapshot });
    expect(result.texts).toEqual(['', '']);
    expect(result.snapshot.pipeline.detectorRuns).toBe(1);
    expect(result.snapshot.pipeline.recognitionRuns).toBe(0);
    expect(result.snapshot.pipeline.recovery).toEqual([]);
});
