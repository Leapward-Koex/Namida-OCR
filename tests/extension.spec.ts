import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo, Worker } from '@playwright/test';
import { expect, test } from './extension.fixtures';
import type { OcrCase, PageSegModeSetting, UpscalingModeSetting } from './ocr-cases';
import { ocrCases } from './ocr-cases';
import { scoreOcrCase, type OcrCaseResult } from './ocr-metrics';

const SNIP_PAGE_ACTION = 0;

test.describe('OCR accuracy dataset', () => {
    test.describe.configure({ mode: 'parallel' });

    for (const ocrCase of ocrCases) {
        test(`recognizes ${ocrCase.name}`, async ({ page, serviceWorker }, testInfo) => {
            await seedExtensionSettings(
                serviceWorker,
                ocrCase.pageSegMode ?? 'single-block-vertical',
                ocrCase.upscalingMode ?? 'canvas',
            );

            const actualText = await runOcrCase(page, serviceWorker, ocrCase);
            const result = scoreOcrCase(ocrCase, actualText);

            await attachCaseResult(testInfo, result);
            await persistCaseResult(result);

            if (ocrCase.minimumCharacterAccuracy !== undefined) {
                expect(
                    result.characterAccuracy,
                    [
                        `${ocrCase.name} accuracy fell below the allowed threshold.`,
                        `Expected: ${result.normalizedExpectedText}`,
                        `Actual:   ${result.normalizedActualText}`,
                        `Edit distance: ${result.editDistance}`,
                        `Character accuracy: ${formatPercent(result.characterAccuracy)}`,
                    ].join('\n'),
                ).toBeGreaterThanOrEqual(ocrCase.minimumCharacterAccuracy);
            }
        });
    }
});

async function runOcrCase(page: Page, serviceWorker: Worker, ocrCase: OcrCase) {
    await page.goto(buildFixtureUrl(ocrCase));
    await expect(page.locator('#ocr-sample')).toBeVisible();
    await expect.poll(async () => {
        return page.locator('#ocr-sample').evaluate((image) => {
            const img = image as HTMLImageElement;
            return img.complete && img.naturalWidth > 0;
        });
    }).toBe(true);

    await page.bringToFront();
    await page.waitForTimeout(250);

    await expect.poll(async () => {
        return serviceWorker.evaluate(async (action) => {
            const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

            if (!activeTab?.id) {
                return 'missing-tab';
            }

            try {
                await chrome.tabs.sendMessage(activeTab.id, { action });
                return 'sent';
            } catch {
                return 'retry';
            }
        }, SNIP_PAGE_ACTION);
    }).toBe('sent');

    await expect(page.getByTestId('namida-snip-overlay')).toBeVisible();

    const image = page.locator('#ocr-sample');
    const bounds = await image.boundingBox();

    if (!bounds) {
        throw new Error(`Could not read the OCR sample bounds for ${ocrCase.name}.`);
    }

    const inset = ocrCase.selectionInset ?? 0;
    const startX = bounds.x + inset;
    const startY = bounds.y + inset;
    const endX = bounds.x + bounds.width - inset;
    const endY = bounds.y + bounds.height - inset;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 20 });
    await page.mouse.up();

    const result = page.getByTestId('namida-floating-window-text');
    await expect(result).toBeVisible({ timeout: 120_000 });
    return result.textContent();
}

async function seedExtensionSettings(
    serviceWorker: Worker,
    pageSegMode: PageSegModeSetting,
    upscalingMode: UpscalingModeSetting,
) {
    await serviceWorker.evaluate(async ({ configuredPageSegMode, configuredUpscalingMode }) => {
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set({
            FuriganaType: 'none',
            PageSegMode: configuredPageSegMode,
            SaveOcrCrop: false,
            ShowSpeakButton: false,
            UpscalingMode: configuredUpscalingMode,
            WindowTimeout: '-1',
        });
    }, {
        configuredPageSegMode: pageSegMode,
        configuredUpscalingMode: upscalingMode,
    });
}

async function attachCaseResult(testInfo: TestInfo, result: OcrCaseResult) {
    await testInfo.attach('ocr-result.json', {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
    });
}

async function persistCaseResult(result: OcrCaseResult) {
    const resultsDir = path.resolve(process.cwd(), 'test-results', 'ocr-case-results');
    const resultPath = path.join(resultsDir, `${result.name}.json`);

    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
}

function buildFixtureUrl(ocrCase: OcrCase): string {
    const params = new URLSearchParams({
        image: ocrCase.image,
        label: ocrCase.name,
    });

    if (ocrCase.displayWidth) {
        params.set('displayWidth', String(ocrCase.displayWidth));
    }

    if (ocrCase.displayHeight) {
        params.set('displayHeight', String(ocrCase.displayHeight));
    }

    return `/ocr-page.html?${params.toString()}`;
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}
