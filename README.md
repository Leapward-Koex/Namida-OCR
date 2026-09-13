# Namida OCR

**Namida OCR** is a local OCR browser extension for **Chrome**, **Firefox**, and **Edge**. It enables you to take a “snip” (screenshot) of any part of your current tab, optionally upscale it with canvas or ESRGAN, and recognize text using bundled OCR assets. The default backend uses Tesseract.js; experimental PaddleOCR ONNX provides a local PP-OCRv6 detector and recognizer. Namida supports Japanese horizontal and vertical text and copies the result to your clipboard for use with dictionaries such as [Yomitan](https://github.com/yomidevs/yomitan) or translation tools. It can also speak recognized text using your browser’s text-to-speech capabilities.

***
<p align="center">
<a href="https://chromewebstore.google.com/detail/namida-ocr/fdcjeigdfljhiinbagbmlhekkbgcdnfc"><img style="height: 70px" src="https://github.com/user-attachments/assets/fc961f30-87a3-4962-856b-5dcfc6df189f" alt="Get Namida OCR for Chrome"></a>
<a href="https://addons.mozilla.org/firefox/addon/namida-ocr/"><img style="height: 70px" src="https://github.com/user-attachments/assets/e1c41eb3-5563-431b-9461-c8a839df92b4" alt="Get Namida OCR for Firefox"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/namida-ocr/idbijkhnllhjdnjmkkfjeicnalemfhnk"><img style="height: 70px" src="https://github.com/user-attachments/assets/4ee20820-86e1-432c-9cd4-47784ffa2cea" alt="Get Namida OCR for Microsoft Edge"></a>
</p>

***

## Features

- **Local OCR**  
  All OCR processing is done locally in your browser using bundled OCR assets. The default backend uses [Tesseract.js](https://github.com/naptha/tesseract.js), and the experimental `paddleonnx` backend uses bundled PaddleOCR ONNX models with `onnxruntime-web`. No external servers are involved.

- **Snip & Upscale**  
  Capture a region of the current tab and optionally enlarge it before recognition:
  - **Linear Upscaling** (fast, basic)  
  - **ESRGAN** (higher-quality AI-based upscaling)

- **Japanese Vertical Text Support**  
  Namida OCR includes trained data for Japanese vertical text recognition, making it ideal for reading manga, visual novels, or other sources with vertical text layout.

- **Clipboard Copy**  
  Upon successful OCR, the recognized text is automatically copied to your clipboard so you can quickly paste it into a dictionary or translation tool.

- **Furigana**  
  Display hiragana or katakana readings above kanji.

- **Local Translation (desktop Chrome and Edge)**
  Translate recognized Japanese text locally using your browser's Translator API, while keeping the original Japanese visible. Requires browser-managed language model setup; see **Settings** below.

- **Text-to-Speech (TTS)**  
  Listen to recognized text using a Japanese voice available in your browser or operating system.

- **Privacy-Friendly**  
  OCR, upscaling, and furigana use local assets bundled with the extension. Optional translation runs locally after browser-managed model setup; no OCR or translation text is sent to a project server. Speech depends on the selected browser/system voice and may use a remote voice.

## Usage

1. **Activate Snip Mode**  
   Press **Alt + Q** on Windows or **Option + Q** on macOS on any web page. A snipping overlay will appear.

2. **Select the Region**  
   Click and drag to highlight the area you want to OCR.

3. **Upscale & OCR**  
   - Namida OCR optionally upscales the snipped region using your chosen method.
   - Your selected OCR backend then recognizes the text locally.

4. **Copy to Clipboard**  
   The recognized text is automatically copied to your clipboard. You can then paste it into any dictionary, translation app, or text editor.

5. **Speak the Text** *(Optional)*  
   If enabled in settings, you can speak the recognized text aloud using your browser’s TTS capabilities. Simply click the "Speak" button in the recognition window.

## Settings

The popup has two views: **Reading** for translation, Japanese display, and speech; **Recognition** for the OCR engine and image preparation. Settings save automatically.

- **Translation (desktop Chrome and Edge)**
  - In **Reading → Translation**, choose a target language (English by default) and click **Download & enable**. Keep the popup open during setup; if interrupted, reopen it to retry.
  - Use **Translate Japanese** to turn automatic translation on or off. By default, it runs when the selected language model is ready. Translation appears below the original text, with a separate copy button. Japanese is still copied automatically.
  - Requires a supported browser and language pair. Setup may need internet access; translation then works offline while the browser retains its models. Downloads only start from the setup button, and each browser needs its own setup. Firefox does not expose this feature.

- **Furigana display**  
  - **Off** – Display no additional kana above kanji
  - **Hiragana** – Displays hiragana above kanji
  - **Katakana** – Displays katakana above kanji

- **Upscaling**
  - **Off** – Recognize the original image.
  - **Standard** – Enlarge with canvas scaling.
  - **AI · slower** – Enlarge with the bundled ESRGAN model.

- **OCR Backend**
  - **Tesseract** – Faster, but usually less accurate.
  - **PaddleOCR** – Slower, but usually more accurate.
  - For Tesseract, choose horizontal or vertical Japanese with **Text direction**.
  - PaddleOCR is experimental and also recognizes mixed Latin text, digits, and punctuation. **Use GPU acceleration** enables WebGPU where available, with local CPU fallback. Expand GPU details to check status or use **Retry GPU** after a failure.

- **Enable TTS**  
  - Option to enable or disable the "Speak" button for recognized text.  

- **Preferred TTS Voice**  
  - Choose from the voices available in your browser and operating system. If no Japanese voice is available, install a Japanese language pack with TTS support. Some voices use an internet connection.

## Development

### Builds and releases

Build locally with `npm run build:chrome` (Chrome and Edge) or `npm run build:firefox`. Output is written to `dist/`.

Pushes to `master` publish an automatic GitHub prerelease tagged `build-<run number>`, with Chrome/Edge and Firefox ZIPs and SHA-256 checksums. Pull requests produce workflow artifacts without publishing. These are unsigned packages, not browser-store submissions: Chromium can load an extracted ZIP in developer mode; Firefox requires temporary loading or Mozilla signing for normal installation.

Extension versions come from the workflow counter; do not manually bump `package.json` for releases. Local builds use `2.0.0` with source identity and a modified-checkout marker. Each package includes `build-info.json` with its source and build metadata. See [AGENTS.md](AGENTS.md#change-guidance) for versioning and release safeguards.

Run `npm run test:build` and `python -m unittest discover -s tests -p test_release_archives.py` to check version ordering and release packaging guards. After a default production build, `node scripts/verify-extension-build.cjs dist chrome` (or `firefox`) checks the generated identity and bundle.

### Runtime and testing

- `node --test tests/translation-*.test.mjs` checks deterministic Translator API behavior. Built-extension translation tests use mocked API states; native desktop Chrome/Edge verification must also check feature detection, setup/download, restart, and offline use.
- The OCR runtime and backend implementations live under `src/background/ocr/`.
- Choose the default OCR backend (`tesseract` unless overridden) at build time with `NAMIDA_OCR_BACKEND` or `webpack --env ocr_backend=...`.
- Available build-time backends are `tesseract`, experimental `scribejs`, and experimental `paddleonnx`.
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

### PaddleOCR implementation

PaddleOCR follows the pinned PaddleX detector/recognizer pipeline: detect text regions, rectify crops, recognize each region, then assemble horizontal rows or Japanese vertical columns. It preserves decoded characters, punctuation, and spaces, with no Tesseract fallback. Mixed-orientation pages remain a limitation.

The implementation lives in [src/background/ocr/](src/background/ocr/) and [src/paddle-worker/](src/paddle-worker/). See [AGENTS.md](AGENTS.md#paddle-reference-pipeline) for model contracts, geometry, and runtime constraints. Bundled geometry attribution and redistribution terms are in [PaddleGeometry-NOTICE.txt](third-party/PaddleGeometry-NOTICE.txt).

### Checking OCR regressions

Run `npm run test:paddle:unit` for model preparation/decoding, geometry, layout, backend/runtime, capture-flow, and regression-checker tests. Dictionary checks use Python 3: `python -m unittest discover -s tests -p test_paddle_dictionary.py`.

The [recorded performance report](reports/ocr-performance.md) is maintained by CI. For changes, supply `--baseline <before-summary.json>` to `npm run test:ocr:regression -- --actual <after-summary.json>` using a controlled run of the current implementation. Without that argument the guard compares against the recorded report. It checks individual cases and aggregate scores; a green Playwright run or higher overall average alone does not establish non-regression. Report the original 20 cases and the added 10 general-text cases separately so one cohort cannot conceal losses in the other.

For capture changes, [capture.spec.ts](tests/capture.spec.ts) checks real browser pixels across successive snips without running OCR. Inspect captured inputs whenever a snip-mode score changes.

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
