# Namida OCR

**Namida OCR** is a local OCR browser extension for **Chrome**, **Firefox**, and **Edge**. It enables you to take a “snip” (screenshot) of any part of your current tab, optionally upscale it with canvas or ESRGAN, and recognize text using bundled OCR assets. The default backend uses Tesseract.js; experimental PaddleOCR ONNX provides a local PP-OCRv6 detector and recognizer. Namida supports Japanese horizontal and vertical text and copies the result to your clipboard for use with dictionaries such as [Yomitan](https://github.com/yomidevs/yomitan) or translation tools. It can also speak recognized text using your browser’s text-to-speech capabilities.


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
   - Your selected OCR backend then recognizes the text locally.

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
  - **Enable GPU support** is only shown for PaddleOCR. It requests a hardware WebGPU adapter and falls back to local CPU (WASM) when unavailable or after a provider failure. The popup shows the current provider and fallback reason; **Retry GPU** creates a fresh runtime after a failure. The browser chooses which GPU to expose. Some ONNX operations can still execute on the CPU within a WebGPU session.

- **Supported Languages**  
  - Japanese horizontal and vertical text (`jpn` / `jpn_vert` for Tesseract).
  - PaddleOCR's shared recognition dictionary also preserves mixed Latin text, digits, punctuation, and spaces.

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
- The OCR runtime and backend implementations live under `src/background/ocr/`.
- The popup can switch between bundled `tesseract` and experimental `paddleonnx` at runtime in normal builds.
- You can still choose the default OCR backend at build time with `NAMIDA_OCR_BACKEND` or `webpack --env ocr_backend=...`.
- Available build-time backends are `tesseract`, experimental `scribejs`, and experimental `paddleonnx`.
- `paddleonnx` uses bundled local assets under `models/paddleocr/` plus matching `onnxruntime-web` JSEP/WASM assets in a dedicated extension worker. WebGPU device loss, provider errors and timeouts terminate the entire worker before retrying once in a fresh CPU worker. This keeps hung ORT state out of the retry. WebNN is excluded because the bundled dynamic models are not validated for that provider.
- Chromium/Edge create this worker from the offscreen document; Firefox creates it from its background document. ONNX proxy workers and WASM threads are disabled; the extension does not require cross-origin isolation. CPU inference remains off the hosting document's event loop. GPU initialization permits 20 seconds per requested model, GPU runs 15 seconds, and CPU commands 120 seconds before terminating their worker.
- AI upscaling loads its local model only on the first AI request. Canvas/None and opening settings do not initialize it. Input/output tensors are disposed after each AI request; model weights remain cached for reuse.
- Paddle source bundles keep their generated `manifest.json`, but builds publish it as `libs/paddleocr/paddleocr-manifest.json` so Chrome Web Store packages contain only the root extension `manifest.json`.
- Chromium builds package the PP-OCRv6 `medium_det` + `medium_rec` bundle by default, while Firefox builds package the smaller PP-OCRv6 `small_det` + `medium_rec` `mobile_det_server_rec` mixed bundle by default to stay under Firefox add-on size limits.
- Override the packaged Paddle bundle with `NAMIDA_PADDLE_ONNX_MODEL_VARIANT=<bundle-name>` or `webpack --env paddleonnx_model_variant=<bundle-name>` when you need a non-default browser/model combination such as `server`, `mobile`, `mobile_det_server_rec`, or `server_det_mobile_rec`.
- Set `NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK=1` or pass `--env paddleonnx_disable_wasm_fallback=true` to make WebGPU failures fatal for no-fallback testing. Failed workers are still discarded. This disables Namida's CPU retry; it does not prohibit ORT from placing individual graph operations on the CPU.
- `npm run prepare:paddleocr-onnx` regenerates the default `server` bundle, `npm run prepare:paddleocr-onnx:firefox` regenerates the Firefox mixed bundle, and `npm run prepare:paddleocr-onnx:mobile` regenerates the compact override. [prepare-paddleocr-onnx.py](prepare-paddleocr-onnx.py) uses pinned repository revisions and verifies ONNX/export-YAML hashes from [sources.json](models/paddleocr/sources.json), preserves `inference.yml`, and extracts the dictionary and model settings. These downloads are development preparation; extension use remains offline.
- `npm run test:e2e:tesseract`, `npm run test:e2e:scribejs`, and `npm run test:e2e:paddleonnx` run the Chromium Playwright OCR suite against a single backend without needing an extra `--backend` flag.
- `npm run test:e2e:paddleonnx:no-fallback` runs the Chromium Playwright OCR suite against `paddleonnx` with CPU retry disabled so WebGPU failures are surfaced directly.
- `npm run test:e2e:compare-backends` runs the Chromium Playwright OCR dataset against the `tesseract`, experimental `scribejs`, and experimental `paddleonnx` backends and writes `test-results/ocr-backend-comparison.json`.
- `.github/workflows/ocr-performance.yml` runs on every branch push, executes `npm run test:e2e:tesseract` and `npm run test:e2e:paddleonnx`, writes [reports/ocr-performance.md](reports/ocr-performance.md), and commits that Markdown report back with `GITHUB_TOKEN`.
- Playwright runs in this repo should use at least 5 workers. The local runner wrappers clamp lower worker counts up to `5`.
- The `scribejs` backend is experimental, must keep using bundled local assets only, and the published `scribe.js-ocr` package is AGPL-3.0 licensed.
- The `paddleonnx` backend is experimental and uses a bundled multilingual recognition model after text detection, with no Tesseract fallback.

### PaddleOCR implementation

The normal path follows the pinned PaddleX detector/recognizer pipeline: BGR image preparation, one detector pass, DB quadrilateral extraction, cubic perspective rectification with tall-line rotation, one recognition pass per region, and greedy CTC decoding. Recognition uses height 48, a base width of 320 expanded up to 3200, and zero padding after normalization. Confidence comes directly from model probabilities; decoded characters, punctuation, and spaces are preserved. There are no language penalties, character substitutions, projection splits, or recognition retries.

The detector uses the pinned standalone PaddleX PP-OCRv6 policy of `960/max`, stride 32, with a separate 1536-pixel browser ceiling for overrides. Bundled export settings supply threshold `0.2`, box score `0.45`, unclip ratio `1.4`, and at most 3000 contour candidates. Reading order is a separate geometry-based policy: horizontal rows or Japanese columns from right to left. Optional document-orientation and layout models are not bundled.

| Module | Responsibility |
| --- | --- |
| [PaddleOnnxOcrBackend.ts](src/background/ocr/PaddleOnnxOcrBackend.ts) | Pipeline orchestration and debug records |
| [PaddleModelPipeline.ts](src/background/ocr/PaddleModelPipeline.ts) | BGR tensors, resize/padding rules, CTC probabilities |
| [PaddleDbPostProcess.ts](src/background/ocr/PaddleDbPostProcess.ts) | Contours, polygon scores, unclip, quadrilaterals |
| [PaddleCropGeometry.ts](src/background/ocr/PaddleCropGeometry.ts) | Cubic perspective crops and vertical rotation |
| [PaddleReadingOrder.ts](src/background/ocr/PaddleReadingOrder.ts) | Ordering detected regions |
| [PaddleOnnxRuntime.ts](src/background/ocr/PaddleOnnxRuntime.ts) | Worker supervision, provider fallback, timeouts and local diagnostics |
| [paddle-worker/worker.ts](src/paddle-worker/worker.ts) | Isolated ORT sessions, hardware adapter selection, device-loss observation and tensor cleanup |
| [PaddleOnnxModelContract.ts](src/background/ocr/PaddleOnnxModelContract.ts) | Output shapes and dictionary cardinality |

Dictionary preparation preserves YAML apostrophe escaping and the appended space class: 18,708 exported characters plus space and CTC blank match 18,710 model classes. Geometry uses bundled `clipper-lib`; source attributions and redistribution terms in [PaddleGeometry-NOTICE.txt](third-party/PaddleGeometry-NOTICE.txt) accompany extension builds. Export YAML remains alongside the local model assets.

### Checking OCR regressions

Run `npm run test:paddle:unit` for model preparation/decoding, geometry, layout, backend/runtime, capture-flow, and regression-checker tests. Dictionary checks use Python 3: `python -m unittest discover -s tests -p test_paddle_dictionary.py`.

The [recorded performance report](reports/ocr-performance.md) is maintained by CI. For changes, supply `--baseline <before-summary.json>` to `npm run test:ocr:regression -- --actual <after-summary.json>` using a controlled run of the current implementation. Without that argument the guard compares against the recorded report. It checks individual cases and aggregate scores; a green Playwright run or higher overall average alone does not establish non-regression. Report the original 20 cases and the added 10 general-text cases separately so one cohort cannot conceal losses in the other.

Screen capture removes the selection overlay, hides existing floating UI, and waits two animation frames before requesting a screenshot. OCR status appears after capture; hidden UI is restored even on failure. [capture.spec.ts](tests/capture.spec.ts) compares real browser-capture pixels across successive snips without running OCR. Inspect captured inputs whenever a snip-mode score changes.

For deterministic backend inputs, set `NAMIDA_TEST_OCR_INPUT_MODE=fixture`. The 30-case dataset retains all 20 original labels and adds [10 synthetic general-text cases](tests/fixtures/GENERAL-OCR-PROVENANCE.md) covering mixed scripts, digits, apostrophes, long lines, color, dark backgrounds, rotation, and multiple lines/columns. Fixed images use each case's configured upscaling; this mode bypasses screen capture. Each `result.input` records its mode and PNG SHA-256, and `--results-subdir` preserves inputs in `ocr-fixture-inputs/`. Compare matching modes and hashes in the same browser environment and exercise the capture tests separately.

Set `NAMIDA_TEST_PADDLE_GPU_ENABLED=0` to run this dataset on CPU and assert WASM execution. On a GPU test host, `NAMIDA_TEST_REQUIRE_WEBGPU=1` makes the dataset require WebGPU sessions and the acceleration integration tests require observed hardware compute dispatches. These are separate test lanes; successful CPU fallback does not count as GPU coverage. The fault tests patch disposable extension copies only. Use `NAMIDA_TEST_EXPECT_STRICT_GPU=1` with the no-fallback build to exercise strict timeout recovery in `tests/paddle-acceleration.spec.ts`.

```powershell
$env:NAMIDA_TEST_OCR_INPUT_MODE = 'fixture'
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir onnx-fixture-before
# After making the change:
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir onnx-fixture-after
npm run test:ocr:regression -- --baseline test-results/onnx-fixture-before/ocr-accuracy-summary.json --actual test-results/onnx-fixture-after/ocr-accuracy-summary.json
Remove-Item Env:NAMIDA_TEST_OCR_INPUT_MODE
```
