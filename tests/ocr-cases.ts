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
    // The following cases are a handpicked selection of challenging manga text samples, which are expected to have lower OCR accuracy. They serve to identify specific weaknesses in the OCR engine and guide future improvements. These pass in the OCR engine "manga-ocr" https://github.com/kha-white/manga-ocr
    {
        name: 'manga-ocr-case-001-sunao-ni-ayamaru-shika',
        image: 'images/manga-ocr-case-01.jpg',
        expectedText: '素直にあやまるしか',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'manga-ocr-case-002-tachikawa-de-mita-ana-no-shita-no-kyodaina-me-wa',
        image: 'images/manga-ocr-case-02.jpg',
        expectedText: '立川で見た〝穴〟の下の巨大な眼は...',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'manga-ocr-case-003-jissen-kenjutsu-mo-ichiryuu-desu',
        image: 'images/manga-ocr-case-03.jpg',
        expectedText: '実戦剣術も一流です',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'manga-ocr-case-004-gya',
        image: 'images/manga-ocr-case-04.jpg',
        expectedText: 'ぎゃっ',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'manga-ocr-case-005-pinpoon',
        image: 'images/manga-ocr-case-05.jpg',
        expectedText: 'ピンポーーン',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'manga-ocr-case-006-faia-panchi',
        image: 'images/manga-ocr-case-06.jpg',
        expectedText: 'ファイアパンチ',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },
    {
        name: 'manga-ocr-case-007-keisatsu-nimo-sensei-nimo-machijuu-no-hitotachi-ni',
        image: 'images/manga-ocr-case-07.jpg',
        expectedText: '警察にも先生にも町中の人達に！！',
        pageSegMode: 'single-block-vertical',
        upscalingMode: 'canvas',
    },

    // Below are simpler cases using computer-rendered text, which serve as a baseline for OCR accuracy.
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
