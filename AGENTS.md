# AGENTS.md

## Project Identity

Namida OCR is a browser extension only. It is not a web app, desktop app, or SaaS product.

The extension captures a region of the active tab, optionally upscales it, runs OCR locally with bundled OCR assets, copies the recognized Japanese text, and can add furigana or use browser text-to-speech.

Core constraint: keep this project offline-first and serverless. Do not introduce backend services, hosted APIs, telemetry pipelines, auth flows, or any requirement for a project-owned server. Production behavior should come from bundled extension assets and browser-provided capabilities only.

## Browser Support

- Chrome: build with `npm run build:chrome`. Chromium uses the Manifest V3 service worker plus the `offscreen` document flow defined in `manifests/manifest.chrome.json`.
- Edge: Edge support comes from the Chromium build. There is no separate Edge manifest today, so Edge should be treated as a Chromium target that uses the Chrome build output. The popup already has Edge-specific shortcut handling in `src/ui/index.ts`.
- Firefox: build with `npm run build:firefox`. Firefox uses `manifests/manifest.firefox.json`, background scripts, and does not use the Chromium `offscreen` permission/document flow.

When changing permissions, background execution, popup behavior, or shortcut flows, keep Chrome, Edge, and Firefox aligned. If you introduce a Chromium-only API, provide a Firefox-safe path.

## Key Runtime Files

- `src/background/index.ts`: background orchestration, keyboard shortcut handling, OCR/furigana routing, and Chromium offscreen bootstrap.
- `src/background/ocr/OcrService.ts`: OCR backend selection and lifecycle management for offscreen/background OCR.
- `src/background/ocr/TesseractOcrBackend.ts`: bundled Tesseract worker creation and OCR cleanup/scoring behavior.
- `src/background/ocr/ScribeOcrBackend.ts`: experimental `scribe.js-ocr` backend wired for local extension assets only.
- `src/background/ocr/PaddleOnnxOcrBackend.ts`: experimental PaddleOCR ONNX backend using bundled local ONNX assets plus `onnxruntime-web`, preferring bundled WebGPU-capable JSEP runtime assets when available.
- `src/offscreen/index.ts`: Chromium offscreen document entrypoint for OCR and furigana work when the background context cannot host workers directly.
- `src/content/index.ts`: content-side snipping, OCR flow, clipboard, overlay, and floating window behavior.
- `src/ui/index.ts`: popup settings UI, browser-specific shortcut UX, and speech voice availability messaging.
- `webpack.config.js`: browser-specific manifest merge plus local bundling of OCR language data and runtime assets, including browser-specific PaddleOCR bundle selection.

## Offline and No-Server Rules

- OCR, upscaling, and furigana generation are expected to run locally from the extension bundle.
- Keep traineddata, WASM, and model assets bundled locally. Do not switch this project to CDN downloads or server-backed OCR.
- Any `scribe.js-ocr` integration must continue to use extension-local language/model assets. Do not rely on its CDN fallback.
- Any `paddleonnx` integration must continue to use extension-local ONNX, dictionary, manifest, and ONNX Runtime JSEP/WASM assets. Do not rely on remote model fetches or runtime downloads.
- Keep both committed PaddleOCR bundles local to the repo when Chromium/server and Firefox/mobile packaging are supported, but only copy the browser-appropriate bundle into `dist/` at build time.
- Do not add any extension feature that requires calling an application server to function.
- Browser/system capabilities such as clipboard access or speech synthesis are acceptable. They are not a substitute for adding project servers.
- The only HTTP server in this repo is `tests/serve-fixtures.mjs`, which exists solely to serve local Playwright fixtures during tests. It is not part of product architecture.

## Build and Test Commands

- `npm run build:chrome`
- `npm run build:firefox`
- `npm run prepare:paddleocr-onnx`: downloads the official PP-OCRv5 server repos, converts them to ONNX, normalizes unsupported `MaxPool ceil_mode` attributes for ONNX Runtime Web acceleration, and refreshes the committed server PaddleOCR bundle metadata for the experimental `paddleonnx` backend.
- `npm run prepare:paddleocr-onnx:mobile`: downloads the official PP-OCRv5 mobile repos, converts them to ONNX, normalizes unsupported `MaxPool ceil_mode` attributes for ONNX Runtime Web acceleration, and refreshes the committed Firefox/mobile PaddleOCR bundle metadata for the experimental `paddleonnx` backend.
- `npm run test:e2e`: builds the Chromium extension with the default OCR model and runs the Playwright suite.
- `npm run test:e2e:tesseract`: runs the Chromium Playwright OCR suite with the bundled `tesseract` backend.
- `npm run test:e2e:scribejs`: runs the Chromium Playwright OCR suite with the experimental `scribejs` backend.
- `npm run test:e2e:paddleonnx`: runs the Chromium Playwright OCR suite with the experimental `paddleonnx` backend.
- `npm run test:e2e:paddleonnx:no-fallback`: runs the Chromium Playwright OCR suite with the experimental `paddleonnx` backend and disables the WASM fallback so accelerated-provider failures surface directly.
- `npm run test:e2e:compare-backends`: builds and runs the Playwright OCR dataset against the `tesseract`, experimental `scribejs`, and experimental `paddleonnx` backends, then writes a comparison summary to `test-results/`.
- `npm run test:e2e:compare-models`: runs the OCR dataset against the bundled `jpn*` models and writes comparison output to `test-results/`.

When running Playwright from this repo, always use at least 5 workers/runners so failures surface quickly. The local runner wrappers clamp lower worker values up to `5`.

The default OCR backend is `tesseract`. Normal builds expose popup settings that let users switch between bundled `tesseract` and experimental `paddleonnx` at runtime, while `NAMIDA_OCR_BACKEND` / `--env ocr_backend=...` still choose the build-time default backend.

Firefox builds should package the smaller `mobile_det_server_rec` mixed PaddleOCR bundle by default to stay within Firefox add-on size limits. Chromium builds should continue to package the PP-OCRv5 server detector/recognizer bundle by default unless `NAMIDA_PADDLE_ONNX_MODEL_VARIANT` / `--env paddleonnx_model_variant=...` explicitly overrides that selection.

Playwright currently exercises the Chromium extension harness. Firefox and Edge changes still need build validation and targeted manual verification.

## OCR Test Expectations

- The default OCR model is `jpn_vert`.
- The optional `scribejs` backend is experimental. Treat timeouts or missing OCR output as runtime integration failures first, not as OCR-quality regressions.
- The optional `paddleonnx` backend is experimental and now runs pure PaddleOCR ONNX inference with no Tesseract fallback. Treat startup failures, missing detected regions, ONNX session failures, or empty OCR output as runtime integration failures first, not as OCR-quality regressions.
- Chromium/server and Firefox/mobile PaddleOCR bundles may have different package sizes, startup time, and OCR accuracy characteristics. Evaluate regressions against the bundle that the target browser actually ships.
- The popup presents `tesseract` as the faster/lower-accuracy option and experimental `paddleonnx` as the slower/higher-accuracy option. Tesseract-only and Paddle-only controls should stay scoped to the matching backend in the popup.
- Tesseract popup settings include a text-direction selector that maps to bundled `jpn` vs `jpn_vert` model selection. Keep that mapping local to the bundled extension assets.
- Tesseract page segmentation is not user-configurable in the popup. It should be derived automatically from the selected text direction/model: `jpn_vert` uses single-block vertical and `jpn` uses single-block.
- The OCR dataset includes difficult manga and vertical-text samples. The model is not perfect.
- Do not assume every OCR case will be an exact text match, and do not treat every OCR miss as a pure application bug.
- Some E2E or model-comparison runs may remain non-perfect because OCR quality is a model limitation, not necessarily a regression in extension code.
- When assessing OCR changes, look at the generated summaries in `test-results/` and compare accuracy/regression trends instead of expecting perfect recognition.

## Change Guidance

- Preserve the browser-extension-only architecture.
- Preserve offline behavior and the no-server product boundary.
- Keep Chrome/Edge and Firefox differences explicit in manifests and runtime code.
- Flag `scribe.js-ocr` changes as licensing-sensitive. The npm package is AGPL-3.0, so do not assume it is shippable under the current project license without an explicit licensing decision.
- Flag `paddleonnx` model and runtime asset changes when they materially affect extension package size, startup time, or browser compatibility.
- If a change affects browser support, packaging, or OCR expectations, update this file along with the README or related docs.
