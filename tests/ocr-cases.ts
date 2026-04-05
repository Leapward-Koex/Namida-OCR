export type PageSegModeSetting = 'single-block-vertical' | 'single-block' | 'auto';
export type UpscalingModeSetting = 'none' | 'canvas' | 'tensorflow';

export type OcrCase = {
    name: string;
    image: string;
    expectedText: string;
    pageSegMode?: PageSegModeSetting;
    upscalingMode?: UpscalingModeSetting;
    displayWidth?: number;
    displayHeight?: number;
    selectionInset?: number;
    minimumCharacterAccuracy?: number;
};

// Add new OCR samples here as the dataset grows.
// Store image files in tests/fixtures/images using the ocr-case-###.png naming pattern.
export const ocrCases: OcrCase[] = [
    {
        name: 'case-001-inuda-san',
        image: 'images/ocr-case-001.png',
        expectedText: '犬田さん',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'case-002-hai-owari-mou-dame',
        image: 'images/ocr-case-002.png',
        expectedText: 'はい終わりもうダメ',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
];
