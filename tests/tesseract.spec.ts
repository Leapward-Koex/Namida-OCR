import { expect, test } from './extension.fixtures';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NamidaMessageAction } from '../src/interfaces/message';
import { ocrCases } from './ocr-cases';

for (const { model, direction, caseNames } of [
    { model: 'jpn', direction: 'horizontal', caseNames: [
        'general-001-horizontal-japanese', 'general-002-mixed-japanese-latin-digits', 'general-010-serif-japanese',
    ] },
    { model: 'jpn_vert', direction: 'vertical', caseNames: ['case-004-genzai'] },
]) {
    test(`Tesseract recognizes ${direction} snips offline with bundled ${model}`, async ({ context, page, serviceWorker, extensionId }) => {
        test.skip(Boolean(process.env.NAMIDA_TEST_OCR_BACKEND && process.env.NAMIDA_TEST_OCR_BACKEND !== 'tesseract'));
        await serviceWorker.evaluate(async (model) => {
            await chrome.storage.sync.clear();
            await chrome.storage.sync.set({ OcrBackend: 'tesseract', OcrModel: model, OcrDebugArtifacts: false });
        }, model);
        await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
        // Each test uses a fresh profile, so cached models cannot hide broken asset loading.
        await context.setOffline(true);
        // Fixed pixels keep this offline/concurrency check independent of OS fonts.
        // Reuse the benchmark's original labels, not text inferred by the OCR engine.
        const cases = caseNames.map((name) => ocrCases.find((entry) => entry.name === name)!);
        const images = cases.map(({ image }) =>
            `data:image/png;base64,${readFileSync(path.join(__dirname, 'fixtures', image)).toString('base64')}`);
        const results = await page.evaluate(async ({ images, action }) => {
            return Promise.all(images.map((data) => chrome.runtime.sendMessage({ action, data })));
        }, { images, action: NamidaMessageAction.RecognizeImage });
        expect(results.every((text: unknown) => typeof text === 'string'), JSON.stringify(results)).toBe(true);
        expect(results.map((text: string) => text.replace(/\s+/g, '')))
            .toEqual(cases.map(({ expectedText }) => expectedText.replace(/\s+/g, '')));
    });
}
