# Namida OCR

**Namida OCR** is a completely local OCR browser extension for both **Chrome**, **Firefox**, and **Edge**. It enables you to take a “snip” (screenshot) of any part of your current tab, upscale it (either via basic linear upscaling or ESRGAN), and then perform OCR on the snipped region using bundled OCR assets. The default backend uses Tesseract.js, and the repo also includes an experimental local PaddleOCR ONNX backend. The OCR supports Japanese vertical text at the moment and automatically copies the recognized text to your clipboard, making it easy to use with online dictionaries like [Yomitan](https://github.com/yomidevs/yomitan) or manual translation tools. Additionally, Namida OCR includes the option to speak the recognized text aloud using your browser’s text-to-speech capabilities.


***
<p align="center">
<a href="https://chromewebstore.google.com/detail/namida-ocr/fdcjeigdfljhiinbagbmlhekkbgcdnfc"><img style="height: 70px" src="https://github.com/user-attachments/assets/fc961f30-87a3-4962-856b-5dcfc6df189f" alt="Get Namida ORC for Chrome"></a>
<a href="https://addons.mozilla.org/firefox/addon/namida-ocr/"><img style="height: 70px" src="https://github.com/user-attachments/assets/e1c41eb3-5563-431b-9461-c8a839df92b4" alt="Get Namida ORC for Firefox"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/namida-ocr/idbijkhnllhjdnjmkkfjeicnalemfhnk"><img style="height: 70px" src="https://github.com/user-attachments/assets/4ee20820-86e1-432c-9cd4-47784ffa2cea" alt="Get Namida ORC for Microsoft Edge"></a>
</p>

***

## Features

- **Local OCR**  
  All OCR processing is done locally in your browser using bundled OCR assets. The default backend uses [Tesseract.js](https://github.com/naptha/tesseract.js), and the experimental `paddleonnx` backend uses bundled PaddleOCR ONNX models with `onnxruntime-web`. No external servers are involved.

- **Snip & Upscale**  
  By default, **Alt + Q** on windows and **Option + Q** on mac activates the snipping mode. The selected image region is then upscaled:
  - **Linear Upscaling** (fast, basic)  
  - **ESRGAN** (higher-quality AI-based upscaling)

- **Japanese Vertical Text Support**  
  Namida OCR includes trained data for Japanese vertical text recognition, making it ideal for reading manga, visual novels, or other sources with vertical text layout.

- **Clipboard Copy**  
  Upon successful OCR, the recognized text is automatically copied to your clipboard so you can quickly paste it into a dictionary or translation tool.

- **Furigana**  
  Choose from either Hiragana or Katakana phonetic prnounciation of Kanji

- **Text-to-Speech (TTS)**  
  Namida OCR includes the option to speak the recognized text aloud using your browser’s TTS engine.  
  - **Chrome**: High-quality remote Japanese voices are included by default.  
  - **Firefox & Edge (Windows)**: Requires a Japanese language pack with TTS installed.  
  - **Edge**: Can also use high-quality **“natural”** voices if available via the Windows language pack.

- **Privacy-Friendly**  
  No internet connection is required during OCR, upscaling, or text-to-speech. Everything is handled using local models bundled with the extension.

## Usage

1. **Activate Snip Mode**  
   Press **Alt + Q** on windows or **Option + Q** on mac on any web page. A snipping overlay will appear.

2. **Select the Region**  
   Click and drag to highlight the area you want to OCR.

3. **Upscale & OCR**  
   - Namida OCR upscales the snipped region using your chosen method (linear or ESRGAN).  
   - Tesseract.js then performs OCR on the upscaled image.

4. **Copy to Clipboard**  
   The recognized text is automatically copied to your clipboard. You can then paste it into any dictionary, translation app, or text editor.

5. **Speak the Text** *(Optional)*  
   If enabled in settings, you can speak the recognized text aloud using your browser’s TTS capabilities. Simply click the "Speak" button in the recognition window.

## Settings

- **Furigana display**  
  - **None** – Display no additional kana above kanji
  - **Hiragana** – Displays hiragana above kanji
  - **Katakana** – Displays katakana above kanji

- **Upscaling Mode**  
  - **Linear** – Uses basic canvas scaling (faster but lower quality).  
  - **ESRGAN** – AI-based upscaling for sharper text.

- **OCR Backend**
  - **Tesseract** – Faster, but usually less accurate.
  - **PaddleOCR** – Slower, but usually more accurate.
  - The popup can switch between `tesseract` and experimental `paddleonnx`.
  - Tesseract also exposes a **Text direction** setting in the popup, which switches between `jpn` and `jpn_vert`.
  - Tesseract page segmentation is now chosen automatically from that text direction: vertical uses single-block vertical and horizontal uses single-block.
  - **Enable GPU support** is only shown for PaddleOCR in the popup and controls whether Paddle attempts WebGPU/WebNN before local WASM fallback.

- **Supported Languages**  
  - Japanese (jpn_vert)

- **Enable TTS**  
  - Option to enable or disable the "Speak" button for recognized text.  

- **Preferred TTS Voice**  
  - Choose which TTS voice to use when speaking recognized text. The available options depend on your browser and system configuration:
    - **Chrome**: Includes high-quality remote Japanese voices.  
    - **Firefox & Edge**: Requires a Japanese language pack with TTS support installed.  
    - **Edge (Windows)**: Can use advanced **"natural"** voices from the Windows language pack.

## Notes

- For the best experience with TTS on Firefox or Edge, ensure your system has a Japanese language pack with text-to-speech capabilities installed. On Edge, you can access **natural** voices through the Windows settings.
- Namida OCR is ideal for users looking to OCR Japanese text, including vertical text layouts commonly found in manga, visual novels, or other Japanese media.
- All processing is performed locally within the browser, ensuring privacy and offline functionality.

## Development

- The default OCR backend is `tesseract`.
- Tesseract keeps the original recognition as its baseline. Uncertain results get one local retry with a small white border and reduced image size for larger crops; a retry replaces the original only when confidence, text score, Japanese-character ratio, and text retention checks agree. Confident results use a single pass.
- Tesseract worker requests and Chromium offscreen creation are serialized to handle simultaneous snips safely. `node --test tests/tesseract-backend.test.mjs` checks worker/retry behavior; `tests/tesseract.spec.ts` checks concurrent horizontal OCR with networking disabled.
- See [the Tesseract audit](reports/tesseract-upstream-audit.md) for official guidance, measured accuracy changes, and regression evidence.
- The OCR runtime and backend implementations live under `src/background/ocr/`.
- The popup can switch between bundled `tesseract` and experimental `paddleonnx` at runtime in normal builds.
- You can still choose the default OCR backend at build time with `NAMIDA_OCR_BACKEND` or `webpack --env ocr_backend=...`.
- Available build-time backends are `tesseract`, experimental `scribejs`, and experimental `paddleonnx`.
- `paddleonnx` uses bundled local assets under `models/paddleocr/` plus bundled `onnxruntime-web` JSEP/WASM assets so it can prefer WebGPU when the browser exposes it and fall back to WASM locally.
- Paddle source bundles keep their generated `manifest.json`, but builds publish it as `libs/paddleocr/paddleocr-manifest.json` so Chrome Web Store packages contain only the root extension `manifest.json`.
- Chromium builds package the PP-OCRv6 `medium_det` + `medium_rec` bundle by default, while Firefox builds package the smaller PP-OCRv6 `small_det` + `medium_rec` `mobile_det_server_rec` mixed bundle by default to stay under Firefox add-on size limits.
- Override the packaged Paddle bundle with `NAMIDA_PADDLE_ONNX_MODEL_VARIANT=<bundle-name>` or `webpack --env paddleonnx_model_variant=<bundle-name>` when you need a non-default browser/model combination such as `server`, `mobile`, `mobile_det_server_rec`, or `server_det_mobile_rec`.
- Set `NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK=1` or pass `--env paddleonnx_disable_wasm_fallback=true` to make accelerated provider failures fatal for no-fallback testing.
- `npm run prepare:paddleocr-onnx` regenerates the default `server` bundle, `npm run prepare:paddleocr-onnx:firefox` regenerates the Firefox default mixed bundle, and `npm run prepare:paddleocr-onnx:mobile` regenerates the compact override bundle. These use [prepare-paddleocr-onnx.py](/c:/Dev/Namida/prepare-paddleocr-onnx.py) to download official PP-OCRv6 ONNX repos, extract the recognition dictionary from `inference.yml`, and refresh the committed bundle metadata.
- `npm run test:e2e:tesseract`, `npm run test:e2e:scribejs`, and `npm run test:e2e:paddleonnx` run the Chromium Playwright OCR suite against a single backend without needing an extra `--backend` flag.
- `npm run test:e2e:paddleonnx:no-fallback` runs the Chromium Playwright OCR suite against `paddleonnx` with WASM fallback disabled so WebGPU/WebNN failures are surfaced directly.
- `npm run test:e2e:compare-backends` runs the Chromium Playwright OCR dataset against the `tesseract`, experimental `scribejs`, and experimental `paddleonnx` backends and writes `test-results/ocr-backend-comparison.json`.
- `.github/workflows/ocr-performance.yml` runs on every branch push, executes `npm run test:e2e:tesseract` and `npm run test:e2e:paddleonnx`, writes [reports/ocr-performance.md](/c:/Dev/Namida/reports/ocr-performance.md), and commits that Markdown report back with `GITHUB_TOKEN`.
- Playwright runs in this repo should use at least 5 workers. The local runner wrappers clamp lower worker counts up to `5`.
- The `scribejs` backend is experimental, must keep using bundled local assets only, and the published `scribe.js-ocr` package is AGPL-3.0 licensed.
- The `paddleonnx` backend is experimental, uses bundled local ONNX models only, currently targets the bundled Chinese/Japanese PaddleOCR recognition model with a bundled detection model for full-crop OCR, and does not fall back to Tesseract.

### PaddleOCR implementation

[`PaddleOnnxOcrBackend.ts`](src/background/ocr/PaddleOnnxOcrBackend.ts) handles image preparation, text layout recovery, recognition, and candidate selection. [`PaddleOnnxRuntime.ts`](src/background/ocr/PaddleOnnxRuntime.ts) owns local ONNX sessions, provider fallback, and safe cleanup after pending work settles. [`PaddleOnnxModelContract.ts`](src/background/ocr/PaddleOnnxModelContract.ts) checks output types, shapes, lengths, and dictionary class counts so model integration errors are reported explicitly.

Dictionary preparation preserves YAML apostrophe escaping and the appended space class. Each bundled recognizer has 18,708 exported characters plus space and CTC blank, matching its 18,710 output classes.

The [PP-OCRv6 upstream audit](reports/paddleocr-v6-upstream-audit.md) explains the remaining differences from PaddleOCR. RGB channel order, recognition width/padding, and applying softmax twice remain known issues pending a coordinated preprocessing and candidate-ranking migration. Extracting session management and fixing dictionaries does not by itself establish better OCR accuracy or a fully standard PaddleOCR pipeline.

### Checking OCR regressions

Run `npm run test:paddle:unit` for session lifecycle, model-contract, and regression-checker tests. Dictionary checks use Python 3: `python -m unittest discover -s tests -p test_paddle_dictionary.py`.

The [recorded performance report](reports/ocr-performance.md) remains the historical reference. `npm run test:ocr:regression -- --actual <summary.json>` compares against it; the underlying command is `node scripts/check-ocr-regression.mjs`. The guard checks original cases individually as well as aggregate accuracy and exact matches, so added cases cannot hide a regression. Supply `--baseline <before-summary.json>` for a controlled comparison.

The normal capture benchmark also exercises screenshot behavior. Its OCR input can include the snipping overlay; differing captured before/after images were confirmed during the audit. Compare actual inputs before attributing a score change to the OCR model. Keep the recorded reports and use preserved runs to distinguish capture differences from model changes.

For deterministic backend inputs, set `NAMIDA_TEST_OCR_INPUT_MODE=fixture`. This uses the same 20 cases and scoring format, drawing fixed fixture images through canvas and bypassing screen capture. The per-case `result.input` records the mode and SHA-256 of the PNG bytes, and `--results-subdir` preserves the images in `ocr-fixture-inputs/`. Use matching modes and input hashes from the same browser environment for before/after model comparisons, and run capture tests separately to validate the screenshot flow. The [audit results](reports/paddleocr-v6-upstream-audit.md#controlled-results) include the original and retained implementation's complete comparison.

```powershell
$env:NAMIDA_TEST_OCR_INPUT_MODE = 'fixture'
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir onnx-fixture-before
# After making the change:
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir onnx-fixture-after
npm run test:ocr:regression -- --baseline test-results/onnx-fixture-before/ocr-accuracy-summary.json --actual test-results/onnx-fixture-after/ocr-accuracy-summary.json
Remove-Item Env:NAMIDA_TEST_OCR_INPUT_MODE
```
