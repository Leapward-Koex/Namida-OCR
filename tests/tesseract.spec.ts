import { expect, test } from './extension.fixtures';
import { NamidaMessageAction } from '../src/interfaces/message';

test('Tesseract recognizes concurrent horizontal snips offline', async ({ context, page, serviceWorker, extensionId }) => {
    test.skip(Boolean(process.env.NAMIDA_TEST_OCR_BACKEND && process.env.NAMIDA_TEST_OCR_BACKEND !== 'tesseract'));
    await serviceWorker.evaluate(async () => {
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set({ OcrBackend: 'tesseract', OcrModel: 'jpn', OcrDebugArtifacts: false });
    });
    await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    // Bundled workers and traineddata must also load with network access disabled.
    await context.setOffline(true);
    const texts = ['日本語', '日本語の文字', '日本語テスト'];
    const results = await page.evaluate(async ({ texts, action }) => {
        const images = texts.map((text) => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 90;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = 'black';
            ctx.font = '48px sans-serif';
            ctx.textBaseline = 'top';
            ctx.fillText(text, 12, 12);
            return canvas.toDataURL('image/png');
        });
        return Promise.all(images.map((data) => chrome.runtime.sendMessage({ action, data })));
    }, { texts, action: NamidaMessageAction.RecognizeImage });
    expect(results.every((text: unknown) => typeof text === 'string'), JSON.stringify(results)).toBe(true);
    expect(results.map((text: string) => text.replace(/\s+/g, ''))).toEqual(texts);
});
