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
    {
        name: 'case-003-kako',
        image: 'images/ocr-case-003.png',
        expectedText: '過去',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'case-004-genzai',
        image: 'images/ocr-case-004.png',
        expectedText: '現在',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'case-005-teto-san-kekkon-shiyou',
        image: 'images/ocr-case-005.png',
        expectedText: 'テトさん結婚しよう',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'case-006-a-sore-zenbu-iinchou-dayo',
        image: 'images/ocr-case-006.png',
        expectedText: 'あーそれ\n全部委員長だよ',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'case-007-kawaii',
        image: 'images/ocr-case-007.png',
        expectedText: '可愛い',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'case-008-ore-otoko-no-ko-damon',
        image: 'images/ocr-case-008.png',
        expectedText: '俺男の子だもん\nこれお母さんに\nあげるよ',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'case-009-saikin-kurasu-no-fuuki',
        image: 'images/ocr-case-009.png',
        expectedText: '最近…\nクラスの風紀が\n乱れてる気がするわ…',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
];
