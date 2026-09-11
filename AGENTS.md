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
- `src/background/ocr/PaddleOnnxOcrBackend.ts`: orchestrates the local PP-OCRv6 detector, rectified text regions, recognizer, and debug records.
- `src/background/ocr/PaddleModelPipeline.ts`: BGR tensor preparation, detector/recognizer resize and padding, and greedy CTC decoding of model probabilities.
- `src/background/ocr/PaddleDbPostProcess.ts`: reference DB contours, polygon scoring, Clipper unclip, and quadrilateral output.
- `src/background/ocr/PaddleCropGeometry.ts`: cubic perspective rectification and counterclockwise rotation of tall text lines.
- `src/background/ocr/PaddleReadingOrder.ts`: geometry-based horizontal row or Japanese vertical column ordering, independent of recognized text.
- `src/background/ocr/PaddleImage.ts`: local bitmap decoding and debug-image encoding.
- `src/background/ocr/PaddleOnnxRuntime.ts`: owns extension-local ONNX sessions, WebGPU/WebNN selection, WASM fallback, and safe release after pending initialization/inference settles.
- `src/background/ocr/PaddleOnnxModelContract.ts`: validates float32 detector/recognizer output shapes, buffer lengths, and recognition dictionary cardinality; malformed outputs are integration errors.
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
- Keep the built PaddleOCR metadata file named `libs/paddleocr/paddleocr-manifest.json`; Chrome Web Store uploads must not include nested `manifest.json` files beyond the root extension manifest.
- Keep pinned model revisions and ONNX/export-YAML SHA-256 hashes in `models/paddleocr/sources.json`. Preparation verifies these assets and preserves `inference.yml` beside each model. Update the lock deliberately when changing model sources.
- Preserve bundled `clipper-lib` and `third-party/` attribution/license notices when packaging the reference geometry implementation.
- Do not add any extension feature that requires calling an application server to function.
- Browser/system capabilities such as clipboard access or speech synthesis are acceptable. They are not a substitute for adding project servers.
- The only HTTP server in this repo is `tests/serve-fixtures.mjs`, which exists solely to serve local Playwright fixtures during tests. It is not part of product architecture.

## Build and Test Commands

- `npm run build:chrome`
- `npm run build:firefox`
- `npm run prepare:paddleocr-onnx`: downloads the official PP-OCRv6 medium detector/recognizer ONNX repos, extracts the recognition dictionary from `inference.yml`, and refreshes the committed Chromium/server PaddleOCR bundle metadata for the experimental `paddleonnx` backend.
- `npm run prepare:paddleocr-onnx:firefox`: downloads the official PP-OCRv6 small detector plus medium recognizer ONNX repos, extracts the recognition dictionary from `inference.yml`, and refreshes the committed Firefox default mixed PaddleOCR bundle metadata for the experimental `paddleonnx` backend.
- `npm run prepare:paddleocr-onnx:mobile`: downloads the compact PP-OCRv6 tiny detector plus small recognizer ONNX repos, extracts the recognition dictionary from `inference.yml`, and refreshes the compact override PaddleOCR bundle metadata for the experimental `paddleonnx` backend.
- `npm run test:e2e`: builds the Chromium extension with the default OCR model and runs the Playwright suite.
- `npm run test:e2e:tesseract`: runs the Chromium Playwright OCR suite with the bundled `tesseract` backend.
- `npm run test:e2e:scribejs`: runs the Chromium Playwright OCR suite with the experimental `scribejs` backend.
- `npm run test:e2e:paddleonnx`: runs the Chromium Playwright OCR suite with the experimental `paddleonnx` backend.
- `npm run test:e2e:paddleonnx:no-fallback`: runs the Chromium Playwright OCR suite with the experimental `paddleonnx` backend and disables the WASM fallback so accelerated-provider failures surface directly.
- `npm run test:e2e:compare-backends`: builds and runs the Playwright OCR dataset against the `tesseract`, experimental `scribejs`, and experimental `paddleonnx` backends, then writes a comparison summary to `test-results/`.
- `npm run test:e2e:compare-models`: runs the OCR dataset against the bundled `jpn*` models and writes comparison output to `test-results/`.
- `npm run test:paddle:unit`: runs preparation/CTC, geometry, reading-order, backend/runtime, capture-flow, and regression-guard tests without loading OCR models.
- `npm run test:ocr:regression -- --actual <summary.json>`: runs `node scripts/check-ocr-regression.mjs` against `reports/ocr-performance.md` by default. Use `--baseline <before-summary.json>` for a controlled before/after comparison. It checks each original case plus aggregate character accuracy and exact matches; extra cases cannot offset a regression.
- `python -m unittest discover -s tests -p test_paddle_dictionary.py`: validates dictionary extraction and the committed PP-OCRv6 vocabulary. Use a Python 3 interpreter.

When running Playwright from this repo, always use at least 5 workers/runners so failures surface quickly. The local runner wrappers clamp lower worker values up to `5`.

The default OCR backend is `tesseract`. Normal builds expose popup settings that let users switch between bundled `tesseract` and experimental `paddleonnx` at runtime, while `NAMIDA_OCR_BACKEND` / `--env ocr_backend=...` still choose the build-time default backend.

Firefox builds should package the smaller PP-OCRv6 `mobile_det_server_rec` mixed PaddleOCR bundle (`small_det` + `medium_rec`) by default to stay within Firefox add-on size limits. Chromium builds should continue to package the PP-OCRv6 `server` bundle (`medium_det` + `medium_rec`) by default unless `NAMIDA_PADDLE_ONNX_MODEL_VARIANT` / `--env paddleonnx_model_variant=...` explicitly overrides that selection.

Playwright currently exercises the Chromium extension harness. Firefox and Edge changes still need build validation and targeted manual verification.

## OCR Test Expectations

- The default OCR model is `jpn_vert`.
- The optional `scribejs` backend is experimental. Treat timeouts or missing OCR output as runtime integration failures first, not as OCR-quality regressions.
- The optional `paddleonnx` backend is experimental and runs pure PaddleOCR ONNX inference with no Tesseract fallback. Investigate startup/session failures and unexpected missing regions or empty output on known-text fixtures as integration issues first. A blank image should return no text.
- Chromium/server and Firefox/mobile PaddleOCR bundles may have different package sizes, startup time, and OCR accuracy characteristics. Evaluate regressions against the bundle that the target browser actually ships.
- The popup presents `tesseract` as the faster/lower-accuracy option and experimental `paddleonnx` as the slower/higher-accuracy option. Tesseract-only and Paddle-only controls should stay scoped to the matching backend in the popup.
- Tesseract popup settings include a text-direction selector that maps to bundled `jpn` vs `jpn_vert` model selection. Keep that mapping local to the bundled extension assets.
- Tesseract page segmentation is not user-configurable in the popup. It should be derived automatically from the selected text direction/model: `jpn_vert` uses single-block vertical and `jpn` uses single-block.
- Tesseract retains the original OCR candidate and makes at most one resize/white-border retry for empty or low-confidence results. Preserve its conservative confidence, score, Japanese-ratio, and text-retention guards; unconditional preprocessing regresses existing samples. Keep these heuristics scoped to Tesseract.
- Tesseract queues entire recognition requests, including preprocessing/retries, per cached worker. Termination must drain accepted work. Chromium offscreen document checks/creation also share a promise to support simultaneous first requests.
- Use bitmap decoding for Tesseract retry preparation: `Image.decode()` can stall in Chromium's hidden offscreen document. Keep preprocessing local and retain the original result if it fails.
- The OCR dataset has 30 cases: 20 unchanged original manga/Japanese cases and 10 known-label synthetic general-text cases. The latter cover mixed Japanese/Latin/digits, apostrophes, long lines, colors, dark backgrounds, rotation, and multiple rows/columns; their provenance is in `tests/fixtures/GENERAL-OCR-PROVENANCE.md`.
- Do not assume every OCR case will be an exact text match, and do not treat every OCR miss as a pure application bug.
- Some E2E or model-comparison runs may remain non-perfect because OCR quality is a model limitation, not necessarily a regression in extension code.
- When assessing OCR changes, look at the generated summaries in `test-results/` and compare accuracy/regression trends instead of expecting perfect recognition.
- PP-OCRv6 dictionaries contain 18,708 exported entries plus an appended space, with CTC blank supplied separately by the decoder: 18,710 output classes in total. Preserve YAML apostrophe escaping when regenerating dictionaries; a quoted apostrophe must decode to one character.
- Preserve decoded Paddle characters, punctuation, and spaces. Its CTC confidence is the mean of emitted model probabilities, including spaces; do not apply softmax again, Japanese-only scoring, or Tesseract text cleanup.

## Paddle Reference Pipeline

- The normal path is one BGR detector pass, DB quadrilaterals, cubic perspective crops, rotation when crop height/width is at least 1.5, one BGR recognition pass per region, greedy CTC, then line assembly. It has no grayscale/binarized retries, whole-selection fallback, projection splits, character substitutions, or language penalties.
- Detector preprocessing follows pinned PaddleX standalone PP-OCRv6 `960/max` with stride 32. The separate 1536-pixel ceiling bounds explicit browser-policy overrides. Bundled export DB settings are threshold `0.2`, box score `0.45`, unclip ratio `1.4`, and 3000 contour candidates. Fast polygon scoring and no dilation follow the pinned PaddleX defaults.
- Recognition uses height 48, base width 320 expanding to 3200, and zero padding after normalization. Overlong lines are resized completely to the 3200-pixel cap; they are not silently truncated. Width clamping is recorded in debug data.
- Japanese right-to-left column ordering is an application layout policy in `PaddleReadingOrder.ts`, inferred from detected geometry when the background requests `PSM.AUTO`. Optional document/orientation/layout models are not bundled; mixed-orientation pages remain a limitation.
- The migration changes preprocessing/postprocessing and adds bundled geometry code, notices, and export YAML. It leaves the ONNX weights and browser-specific model selections unchanged.
- [reports/paddleocr-reference-implementation.md](reports/paddleocr-reference-implementation.md) records the current controlled comparison, implementation limits, and documented losses accepted for the explicitly authorized reference migration. [reports/paddleocr-v6-upstream-audit.md](reports/paddleocr-v6-upstream-audit.md) describes the preceding implementation and remains historical evidence.

## Paddle ONNX Reliability Workflow

- Preserve `reports/ocr-performance.md` and the upstream audit as historical baselines. Use the reference implementation report and a preserved current-build run for new controlled comparisons; do not rewrite historical scores or labels to make a run pass.
- When improving one `paddleonnx` OCR case, do not rerun the whole ONNX suite on every edit. Rebuild once, then run only the target case until it reaches the task's target pass rate. After the focused case is stable, run the full ONNX suite and confirm that the other cases did not regress.
- If fixing a regression introduced by a later `paddleonnx` change, rerun the full suite after the focused case recovers. Compare every case and both the original-20 and general-10 cohorts against matching current-baseline inputs. The accepted losses from the reference migration are not automatic authorization for further regressions.
- For this workflow, define "pass" up front for the task. In practice that usually means either exact match or hitting a chosen `characterAccuracy` threshold for the case. The current Playwright OCR dataset mostly records metrics instead of enforcing per-case Paddle thresholds, so use the generated JSON results for pass-rate tracking instead of relying only on Playwright's green/red status.
- Keep Playwright at `5` workers or more even for filtered runs. The local wrappers clamp worker counts up to `5`, and direct Playwright invocations should do the same.
- Preserve before/after data when useful with `--results-subdir ...` on the wrapper runs so you can compare summaries instead of relying on memory.
- Verify the OCR input before attributing a score change to the model. The historical overlay-capture race is fixed: hide the selection and floating UI, wait two animation frames before capture, restore UI in `finally`, then show OCR status. Preserve the nested/idempotent hide handling. `tests/capture.spec.ts` compares actual browser pixels over successive snips without OCR; `tests/capture-flow.test.mjs` covers ordering and failure restoration.
- Set `NAMIDA_TEST_OCR_INPUT_MODE=fixture` for deterministic input preparation: all 30 cases use fixed images, each case's configured upscaling, and the existing scoring format, bypassing capture. Each result records its mode and PNG SHA-256 in `result.input`. Compare matching modes and hashes from the same browser environment; exercise capture mode separately. Playwright success alone is not an accuracy gate, and a combined average can hide cohort or individual-case losses.

PowerShell example for controlled backend comparison (run the `before` sweep before editing):

```powershell
$env:NAMIDA_TEST_OCR_INPUT_MODE = 'fixture'
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir onnx-fixture-before
# Apply the change, then rebuild and run the same cases through the wrapper.
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir onnx-fixture-after
npm run test:ocr:regression -- --baseline test-results/onnx-fixture-before/ocr-accuracy-summary.json --actual test-results/onnx-fixture-after/ocr-accuracy-summary.json
Remove-Item Env:NAMIDA_TEST_OCR_INPUT_MODE
```

PowerShell example for a focused single-case pass-rate loop:

```powershell
node .\node_modules\webpack-cli\bin\cli.js --env browser=chrome --env ocr_backend=paddleonnx --env ocr_model=jpn_vert --env paddleonnx_model_variant=server --mode production

$env:NAMIDA_TEST_OCR_BACKEND = 'paddleonnx'
$env:NAMIDA_TEST_OCR_MODEL = 'jpn_vert'
$env:NAMIDA_TEST_OCR_INPUT_MODE = 'fixture'
$env:PLAYWRIGHT_WORKERS = '5'

$case = 'case-008-ore-otoko-no-ko-damon'
$targetAccuracy = 0.80
$runs = 10
$passes = 0

for ($i = 1; $i -le $runs; $i++) {
    node .\node_modules\@playwright\test\cli.js test .\tests\extension.spec.ts --project chromium-extension --workers 5 --grep "recognizes $case"
    $result = Get-Content ".\test-results\ocr-case-results\$case.json" | ConvertFrom-Json
    if ($result.characterAccuracy -ge $targetAccuracy) {
        $passes += 1
    }
}

"{0}/{1} runs met target ({2:P1})" -f $passes, $runs, ($passes / $runs)
```

After the focused case meets the target pass rate, run the full regression sweep:

```powershell
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir onnx-full-after
Remove-Item Env:NAMIDA_TEST_OCR_INPUT_MODE
```

- The main focused-run artifacts are `test-results/ocr-case-results/<case>.json` and `test-results/ocr-debug/<case>/`.
- `tests/extension.spec.ts` always enables `OcrDebugArtifacts` for the OCR dataset and persists `snapshot.json` plus PNG crops/attempt images under `test-results/ocr-debug/<case>/`.
- Schema-v2 `snapshot.json` records detector/recognizer parameters, tensor shapes, run counts, inferred direction, and region quadrilaterals. `candidates.detected` and `candidates.selected` describe assembled lines; `fullCrop`/`projected` are null and `projectedGroups` is empty by design.
- `working-crop.png` is the input image before detector resizing. Each detected-group PNG is the rectified line actually recognized. Its single attempt records rotation, input shape/content width, width clamping, decoded tokens and probabilities, and acceptance.
- Missing or merged regions require inspecting `PaddleModelPipeline.ts` detector resizing and `PaddleDbPostProcess.ts` thresholds/contours/unclip. Wrong crop geometry belongs in `PaddleCropGeometry.ts`; wrong line ordering belongs in `PaddleReadingOrder.ts`.
- A wrong line with correct geometry requires inspecting recognition tensor preparation and `decodeCtcProbabilities()` in `PaddleModelPipeline.ts`, the dictionary, and token probabilities. There is no candidate-ranking or projection recovery path to tune.
- If runs vary because of runtime/provider behavior instead of OCR quality, inspect ONNX provider logs and fallback behavior in `PaddleOnnxRuntime.ts`. Search for messages such as `Initialized ONNX session`, `Failed to create ONNX session`, and `Disabling accelerated execution provider after runtime failure`.

## Change Guidance

- Preserve the browser-extension-only architecture.
- Preserve offline behavior and the no-server product boundary.
- Keep Chrome/Edge and Firefox differences explicit in manifests and runtime code.
- Flag `scribe.js-ocr` changes as licensing-sensitive. The npm package is AGPL-3.0, so do not assume it is shippable under the current project license without an explicit licensing decision.
- Flag `paddleonnx` model and runtime asset changes when they materially affect extension package size, startup time, or browser compatibility.
- If a change affects browser support, packaging, or OCR expectations, update this file along with the README or related docs.
