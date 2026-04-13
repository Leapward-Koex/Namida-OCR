import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo, Worker } from '@playwright/test';
import { expect, test } from './extension.fixtures';
import type { OcrDebugAttemptSnapshot, OcrDebugCropSnapshot, OcrDebugSnapshot } from '../src/background/ocr/OcrDebugSnapshot';
import { NamidaMessageAction } from '../src/interfaces/message';
import type { OcrCase, PageSegModeSetting, UpscalingModeSetting } from './ocr-cases';
import { ocrCases } from './ocr-cases';
import { scoreOcrCase, type OcrCaseResult } from './ocr-metrics';

const SNIP_PAGE_ACTION = NamidaMessageAction.SnipPage;
const GET_LAST_OCR_DEBUG_SNAPSHOT_ACTION = NamidaMessageAction.GetLastOcrDebugSnapshot;
const GET_LAST_OCR_DEBUG_SNAPSHOT_OFFSCREEN_ACTION = NamidaMessageAction.GetLastOcrDebugSnapshotOffscreen;
const TEST_OCR_BACKEND = normalizeTestOcrBackend(process.env.NAMIDA_TEST_OCR_BACKEND);
const TEST_OCR_MODEL = process.env.NAMIDA_TEST_OCR_MODEL?.trim() || 'jpn_vert';
const OCR_RESULT_TIMEOUT_MS = process.env.CI ? 240_000 : 120_000;

test.describe('OCR accuracy dataset', () => {
    test.describe.configure({ mode: 'parallel' });

    for (const [caseIndex, ocrCase] of ocrCases.entries()) {
        test(`recognizes ${ocrCase.name}`, async ({ page, serviceWorker }, testInfo) => {
            await seedExtensionSettings(
                serviceWorker,
                ocrCase.pageSegMode ?? 'single-block-vertical',
                ocrCase.upscalingMode ?? 'canvas',
                TEST_OCR_BACKEND,
                TEST_OCR_MODEL,
            );

            const actualText = await runOcrCase(page, serviceWorker, ocrCase);
            const debugSnapshot = await fetchLastOcrDebugSnapshot(serviceWorker);
            const result = scoreOcrCase(ocrCase, actualText, caseIndex);

            await attachCaseResult(testInfo, result);
            await persistCaseResult(result);
            await attachDebugSnapshot(testInfo, ocrCase.name, debugSnapshot);
            await persistDebugSnapshot(ocrCase.name, debugSnapshot);

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
    await expect(result).toBeVisible({ timeout: OCR_RESULT_TIMEOUT_MS });
    return result.textContent();
}

async function seedExtensionSettings(
    serviceWorker: Worker,
    pageSegMode: PageSegModeSetting,
    upscalingMode: UpscalingModeSetting,
    ocrBackend: 'tesseract' | 'scribejs' | 'paddleonnx',
    ocrModel: string,
) {
    await serviceWorker.evaluate(async ({
        configuredPageSegMode,
        configuredUpscalingMode,
        configuredOcrBackend,
        configuredOcrModel,
    }) => {
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set({
            FuriganaType: 'none',
            OcrBackend: configuredOcrBackend,
            OcrDebugArtifacts: true,
            OcrModel: configuredOcrModel,
            PageSegMode: configuredPageSegMode,
            PaddleOnnxGpuEnabled: true,
            SaveOcrCrop: false,
            ShowSpeakButton: false,
            UpscalingMode: configuredUpscalingMode,
            WindowTimeout: '-1',
        });
    }, {
        configuredPageSegMode: pageSegMode,
        configuredUpscalingMode: upscalingMode,
        configuredOcrBackend: ocrBackend,
        configuredOcrModel: ocrModel,
    });
}

function normalizeTestOcrBackend(
    backend: string | undefined,
): 'tesseract' | 'scribejs' | 'paddleonnx' {
    if (backend === 'scribejs' || backend === 'paddleonnx') {
        return backend;
    }

    return 'tesseract';
}

async function attachCaseResult(testInfo: TestInfo, result: OcrCaseResult) {
    await testInfo.attach('ocr-result.json', {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
    });
}

async function fetchLastOcrDebugSnapshot(serviceWorker: Worker): Promise<OcrDebugSnapshot | null> {
    return serviceWorker.evaluate(async ({ backgroundAction, offscreenAction }) => {
        const cachedSnapshot = await chrome.runtime.sendMessage({
            action: backgroundAction,
            data: null,
        });

        if (cachedSnapshot) {
            return cachedSnapshot;
        }

        return chrome.runtime.sendMessage({
            action: offscreenAction,
            data: null,
        });
    }, {
        backgroundAction: GET_LAST_OCR_DEBUG_SNAPSHOT_ACTION,
        offscreenAction: GET_LAST_OCR_DEBUG_SNAPSHOT_OFFSCREEN_ACTION,
    });
}

async function attachDebugSnapshot(
    testInfo: TestInfo,
    caseName: string,
    snapshot: OcrDebugSnapshot | null,
) {
    if (!snapshot) {
        return;
    }

    const persistedSnapshot = await createPersistedDebugSnapshot(caseName, snapshot);
    await testInfo.attach('ocr-debug.json', {
        body: JSON.stringify(persistedSnapshot, null, 2),
        contentType: 'application/json',
    });
}

async function persistCaseResult(result: OcrCaseResult) {
    const resultsDir = path.resolve(process.cwd(), 'test-results', 'ocr-case-results');
    const resultPath = path.join(resultsDir, `${result.name}.json`);

    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
}

async function persistDebugSnapshot(
    caseName: string,
    snapshot: OcrDebugSnapshot | null,
) {
    if (!snapshot) {
        return;
    }

    const persistedSnapshot = await createPersistedDebugSnapshot(caseName, snapshot);
    const debugDir = path.resolve(process.cwd(), 'test-results', 'ocr-debug', caseName);

    await fs.mkdir(debugDir, { recursive: true });
    await fs.writeFile(
        path.join(debugDir, 'snapshot.json'),
        JSON.stringify(persistedSnapshot, null, 2),
    );
}

async function createPersistedDebugSnapshot(caseName: string, snapshot: OcrDebugSnapshot) {
    const debugDir = path.resolve(process.cwd(), 'test-results', 'ocr-debug', caseName);
    await fs.mkdir(debugDir, { recursive: true });

    return {
        ...omitImageDataUrl(snapshot),
        detectedGroups: await Promise.all(snapshot.detectedGroups.map((group, index) => {
            return persistCropSnapshot(debugDir, `detected-${padIndex(index)}`, group);
        })),
        fullCrop: snapshot.fullCrop
            ? await persistCropSnapshot(debugDir, 'full-crop', snapshot.fullCrop)
            : null,
        projectedGroups: await Promise.all(snapshot.projectedGroups.map((group, index) => {
            return persistCropSnapshot(debugDir, `projected-${padIndex(index)}`, group);
        })),
        workingImagePath: await persistDataUrlAsset(
            debugDir,
            'working-crop.png',
            snapshot.workingImageDataUrl,
        ),
    };
}

async function persistCropSnapshot(
    debugDir: string,
    filePrefix: string,
    snapshot: OcrDebugCropSnapshot,
) {
    return {
        ...omitImageDataUrl(snapshot),
        attempts: await Promise.all(snapshot.attempts.map((attempt, index) => {
            const rotationSuffix = attempt.rotated ? 'rotated' : 'plain';
            return persistAttemptSnapshot(
                debugDir,
                `${filePrefix}-attempt-${padIndex(index)}-${rotationSuffix}`,
                attempt,
            );
        })),
        imagePath: await persistDataUrlAsset(
            debugDir,
            `${filePrefix}-crop.png`,
            snapshot.imageDataUrl,
        ),
    };
}

async function persistAttemptSnapshot(
    debugDir: string,
    filePrefix: string,
    snapshot: OcrDebugAttemptSnapshot,
) {
    return {
        ...omitImageDataUrl(snapshot),
        imagePath: await persistDataUrlAsset(
            debugDir,
            `${sanitizeFilePart(filePrefix)}.png`,
            snapshot.imageDataUrl,
        ),
    };
}

function omitImageDataUrl<T extends { imageDataUrl: string }>(value: T): Omit<T, 'imageDataUrl'> {
    const { imageDataUrl: _imageDataUrl, ...rest } = value;
    return rest;
}

async function persistDataUrlAsset(debugDir: string, fileName: string, dataUrl: string) {
    const outputPath = path.join(debugDir, sanitizeFilePart(fileName));
    await fs.writeFile(outputPath, dataUrlToBuffer(dataUrl));
    return path.relative(debugDir, outputPath);
}

function dataUrlToBuffer(dataUrl: string) {
    const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/u);

    if (!match) {
        throw new Error('Unsupported OCR debug data URL format.');
    }

    return Buffer.from(match[1], 'base64');
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

function padIndex(index: number) {
    return String(index).padStart(2, '0');
}

function sanitizeFilePart(value: string) {
    return value.replace(/[^A-Za-z0-9._-]+/g, '-');
}

