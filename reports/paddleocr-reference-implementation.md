# PP-OCRv6 reference pipeline implementation

Implementation and validation: 11–12 September 2026. Branch: `codex/paddleocr-reference-pipeline`, based on audit revision `90b76fd`. The [original audit](paddleocr-v6-upstream-audit.md) and its evidence remain intact.

Namida now implements the bundled PP-OCRv6 detector/line-recognizer contract directly. It uses BGR tensors, reference DB quadrilateral geometry, perspective-rectified text lines, dynamic recognition width, zero tensor padding, and greedy CTC decoding of the model's existing probabilities. The previous manga recovery and candidate-selection system is removed. The browser still performs all work locally using the existing model weights and ONNX Runtime assets.

The user changed the acceptance criterion for this migration: documented losses on specialized examples are acceptable when replacing behavior that may have overfit those examples. We therefore require reference-contract checks, complete before/after case evidence, separate old/new cohorts, and functioning capture/runtime paths. We do **not** interpret a green Playwright run as proof of unchanged accuracy, or change labels to conceal losses.

## Implementation

| Audit recommendation | Result |
| --- | --- |
| Separate session ownership from image processing | `PaddleOnnxRuntime.ts` retains local provider selection, timeout handling, fallback and safe session retirement. The backend queues complete requests, GPU changes and termination across shared sessions. |
| Correct channel order and normalization | `PaddleModelPipeline.ts` produces BGR NCHW tensors, with detector mean/std in exported channel order and recognizer values in −1…1. Browser decoding/compositing is isolated in `PaddleImage.ts`. |
| Implement DB geometry rather than connected-component bounds | `PaddleDbPostProcess.ts` traces external and hole contours in reference order, finds minimum-area rectangles, scores their polygon area, applies round Clipper offsets, and maps quadrilaterals back to the source. It does not dilate or impose the old 24-box cap. |
| Preserve oriented geometry through cropping | `PaddleCropGeometry.ts` refits rounded quads, perspective-warps with cubic interpolation and replicated borders, and rotates crops counterclockwise when height/width ≥ 1.5. Debug artifacts retain each quad. |
| Respect dynamic recognition width and padding | Each rectified line becomes height 48, nominal width 320, expanding to at most 3200. Unused columns contain normalized zero. Lines exceeding the cap are compressed in full; debug metadata flags this condition. |
| Decode the model's probabilities correctly | Greedy CTC removes blank and adjacent repeats, then averages emitted probabilities, including spaces. No second softmax, Japanese/Latin/digit penalty, Unicode normalization or character-variant substitution remains. |
| Separate layout from recognition | `PaddleReadingOrder.ts` orders horizontal rows left-to-right/top-to-bottom and Japanese vertical columns right-to-left/top-to-bottom using geometry. It does not inspect recognized text. |
| Make recovery explicit and bounded | This implementation has no OCR recovery attempts. One detector pass is followed by one recognition per usable region. Missing detections return empty text. `pipeline.recovery` is an empty list; there is no whole-selection, grayscale, thresholded or projected alternative competing with the model result. |
| Preserve exact vocabulary and source evidence | Preparation verifies pinned source revisions and SHA-256 hashes, retains the exact export YAML, and derives dictionary/config metadata. The previous audit's apostrophe/space correction remains. |
| Broaden validation and isolate screenshot behavior | Ten additional fixtures use the existing dataset format. Deterministic input hashes separate backend comparisons from real capture tests. The overlay capture race is fixed and tested using actual browser pixels. |

Removing recovery is a deliberate choice under the revised scope. The old whole-selection recognizer and image variants helped some manga selections, but also lost ordinary mixed-script and long-line content. None has been retained without a general, independently evaluated trigger and selection rule. Provider fallback to local WASM remains a runtime reliability feature; it does not select between competing OCR strings.

The recognition vocabulary is 18,708 exported entries plus space and CTC blank: 18,710 classes. Returned model characters and spaces reach the clipboard/result unchanged; Tesseract keeps its separate existing cleanup policy. Debug candidate confidence is expressed as percent for compatibility, while per-token confidence remains 0–1. These are model probabilities, **not** a calibrated estimate that a whole string is correct.

## Reference and resource policy

The implementation references PaddleX revision [`c50f5da858020db473a2285f089bb8c7bbd6afdc`](https://github.com/PaddlePaddle/PaddleX/tree/c50f5da858020db473a2285f089bb8c7bbd6afdc). Its [recognition processors](https://github.com/PaddlePaddle/PaddleX/blob/c50f5da858020db473a2285f089bb8c7bbd6afdc/paddlex/inference/models/text_recognition/processors.py) define resize/normalization and CTC behavior; its [detector processors](https://github.com/PaddlePaddle/PaddleX/blob/c50f5da858020db473a2285f089bb8c7bbd6afdc/paddlex/inference/models/text_detection/processors.py) and [crop processors](https://github.com/PaddlePaddle/PaddleX/blob/c50f5da858020db473a2285f089bb8c7bbd6afdc/paddlex/inference/pipelines/components/common/crop_image_regions.py) define the geometry.

Detector sizing is explicitly `960/max`, stride 32, matching the pinned [standalone v6 detector predictor](https://github.com/PaddlePaddle/PaddleX/blob/c50f5da858020db473a2285f089bb8c7bbd6afdc/paddlex/inference/models/text_detection/predictor.py). It scales large images down, without forcing normal small selections up to a 736-pixel short side. The retained browser ceiling of 1536 is inactive under the standard 960 setting. PaddleX permits different pipeline resize overrides; this is a supported configuration, not a claim that every PaddleOCR entry point has one universal default.

The actual export YAML supplies DB threshold `0.2`, polygon score threshold `0.45`, unclip ratio `1.4`, and 3000 candidate contours. No dilation and fast polygon scoring come from the pinned PaddleX defaults; these two keys are absent from the export YAML. Recognition uses the upstream pipeline's default score threshold of zero. These parameters apply uniformly, without fixture IDs, recognized-character checks or per-case overrides. Tiny-image padding and Python-style ties-to-even stride rounding are covered by tests.

The [source lock](../models/paddleocr/sources.json) records exact Hugging Face commits and file hashes. For example, the [medium detector export](https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_det_onnx/blob/61323801669c338b7891481ec7bac61ce31b576a/inference.yml) and [medium recognizer export](https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/blob/50c7eacafc52fa7bcf4194e8cd08e46f8558504b/inference.yml) remain the source of model-specific metadata. `prepare-paddleocr-onnx.py --metadata-only --skip-download --variant server` can verify existing local assets and refresh metadata without copying model weights. The regular preparation commands still support pinned downloads during development; production makes no remote model requests.

## Controlled accuracy results

All 20 original case names, expectations and image settings are unchanged. Ten original synthetic samples add ordinary horizontal Japanese, mixed Latin/digits, an ASCII apostrophe/date, a long line, colored text, white-on-dark text, rotation, three vertical columns, three horizontal lines and a serif font. Their [provenance and regeneration instructions](../tests/fixtures/GENERAL-OCR-PROVENANCE.md) include font and PNG hashes. New samples run at native resolution without upscaling; original samples retain their existing settings.

Before runs use the retained audit implementation. After runs use this reference pipeline. Both execute through the extension's real background/offscreen route in Chromium, with five workers and identical fixture PNG input hashes. The scoring formula still normalizes whitespace, so exact space preservation is checked separately in CTC/backend and content/capture tests.

| Chromium `server` bundle | Before accuracy | After accuracy | Before exact | After exact |
| --- | ---: | ---: | ---: | ---: |
| Original 20 | 84.9319% | 84.2604% | 12/20 | 11/20 |
| New general 10 | 83.8095% | 99.3333% | 6/10 | 9/10 |
| Combined 30 | 84.5578% | 89.2847% | 18/30 | 20/30 |

Evidence: [server before](paddleocr-reference/before/summary.json) and [server after](paddleocr-reference/after/summary.json). All 30 input hashes match. Six cases improve, four regress, and twenty are unchanged by character accuracy. The old cohort declines by 0.6715 percentage points, while the combined score rises by 4.7269 points. The new synthetic cohort is a collection of targeted contract probes, not a representative estimate of general OCR quality.

| Changed server case | Before | After |
| --- | ---: | ---: |
| `manga-ocr-case-001-sunao-ni-ayamaru-shika` | 33.33% | 75.00% |
| `manga-ocr-case-002-tachikawa-de-mita-ana-no-shita-no-kyodaina-me-wa` | 47.83% | 44.44% |
| `case-006-a-sore-zenbu-iinchou-dayo` | 100.00% | 91.67% |
| `case-011-zundamon-senpai-tsumetai-kute-kimochi-ii` | 88.89% | 38.89% |
| `case-012-obaachan` | 87.50% | 94.12% |
| `general-002-mixed-japanese-latin-digits` | 78.57% | 100.00% |
| `general-003-apostrophe-date` | 92.86% | 100.00% |
| `general-004-long-horizontal` | 0.00% | 100.00% |
| `general-006-white-on-dark` | 100.00% | 93.33% |
| `general-009-horizontal-three-lines` | 66.67% | 100.00% |

The most serious retained loss is the outlined, colored two-column `case-011`: the detector merges columns, leaving one unsuitable recognition region. On the initial rewrite, `case-002` had the same type of failure. Reprocessing the actual detector probability maps using the Python OpenCV/Pyclipper reference reproduced the JavaScript boxes and scores exactly; [the comparison](paddleocr-reference/geometry-reference-checks.json) preserves that diagnosis. This supports a detector/layout limitation for those inputs, rather than an unexplained discrepancy in the new DB implementation.

The [first rewrite experiment](paddleocr-reference/first/summary.json) retained the old `736/min` sizing and scored 79.5080% on the original cohort, 86.1164% combined. Changing the one uniform sizing policy to the reference `960/max` recovered `case-002` and produced the final scores above. The [sizing experiment](paddleocr-reference/reference960/summary.json) and final build have identical per-case output and accuracy. `case-011` remains a loss; the previous specialized recovery has not been reintroduced to conceal it. Other losses include an added punctuation mark and the long-vowel mark recognized as the kanji 一.

The historical [performance report](ocr-performance.md) is unchanged. Its older labels and uncontrolled capture inputs are not interchangeable with these fixed-input results. The existing strict regression guard intentionally reports the four controlled losses above; it has not been weakened or given new passing thresholds. Future changes should compare against this implementation's controlled evidence, inspect every changed case and report both cohorts.

The Firefox default model pair was also compared using the same Chromium extension harness, selecting `mobile_det_server_rec` explicitly for both builds. This measures the shipped **weights** independently; it does not establish Firefox runtime behavior.

| Firefox model pair, executed in Chromium | Before accuracy | After accuracy | Before exact | After exact |
| --- | ---: | ---: | ---: | ---: |
| Original 20 | 82.2556% | 85.5128% | 12/20 | 11/20 |
| New general 10 | 83.5317% | 99.3333% | 6/10 | 9/10 |
| Combined 30 | 82.6810% | 90.1196% | 18/30 | 20/30 |

Evidence: [mixed before](paddleocr-reference/mixed-before/summary.json) and [mixed after](paddleocr-reference/mixed-after/summary.json), with all 30 input hashes matching. Nine cases improve, six regress, and fifteen are unchanged. `case-011` also loses substantially with this detector, from 100% to 38.89%; improved aggregate scores do not remove that limitation. The mixed pair is stronger than the server pair on this particular sample mix, which is insufficient evidence to change the browser packaging defaults.

## Capture, packaging and limits

The audit found that the snipping overlay could appear in OCR screenshots. `SnippingOverlay` now hides before its completion callback; `ScreenshotHandler` waits for two animation frames before requesting the screenshot. The content flow also hides any previous result during capture and shows the new OCR status afterward. Visibility restoration is safe for errors and overlapping capture requests. Selection geometry and the existing four-pixel crop margin remain unchanged.

The dedicated browser test intercepts recognition only, while using the real `captureVisibleTab` route. It compares captured RGBA pixels with a clean browser reference, including a second selection deliberately covered by the previous result window. Thus the capture check does not depend on whether an OCR model happens to read contaminated pixels successfully. Normal snipping benchmarks remain a separate integration path; their scores should not be mixed with fixed-fixture comparisons.

Production still contains only the browser-appropriate model pair: Chromium/Edge use medium detector + medium recognizer; Firefox uses small detector + medium recognizer. Model bytes and ONNX Runtime version are unchanged. The new production dependency is `clipper-lib` 6.4.2, rather than a full OpenCV runtime. Each packaged pair additionally includes about 152 KB of exact export YAML plus source metadata and bundled third-party notices. Python, OpenCV and Pyclipper are development reference tools, not extension dependencies.

Reference geometry tests compare 50 seeded contour maps, 28 polygon masks, round offsets, 26 detection maps including 19 angles, and ten crop outputs across five quadrilateral examples. Tested DB coordinates and scores match the Python fixtures; cubic crop bytes differ by at most one level, with mean error below 0.02. Bilinear model resizing is independently checked against OpenCV within one uint8 level. These measurements establish useful numerical agreement, not bit-identical behavior for every possible polygon or floating-point tie. Source and license attribution is retained in [the geometry notice](../third-party/PaddleGeometry-NOTICE.txt).

A final edge-case review also found that scaling a valid detector rectangle onto a one-pixel-wide source can collapse it to a line. The DB module now discards only source quads that cannot yield a positive-size rectified crop. The regression test also preserves a usable one-pixel-wide crop; no generic three-pixel source threshold or older PaddleOCR wrapper filter was introduced.

This remains detection plus line recognition, not the full PaddleX document-analysis stack. There is no added document unwarping, page orientation classifier, text-line orientation model, handwriting specialist or layout model. Geometry chooses a dominant reading direction for a snip; mixed-direction pages, isolated square glyphs, furigana and joined columns can remain ambiguous. Upside-down text, extreme perspective and lines compressed at width 3200 also need broader evaluation. No production recovery or model-quality claim has been inferred from passing synthetic examples alone.

## Final validation

Validation used Node 24.11.1 and Playwright 1.59.1 on Windows, with five configured workers for every browser invocation. The final default Chromium build also supports switching to Paddle at runtime; testing was not limited to a build with Paddle as its default.

| Check | Result |
| --- | --- |
| Paddle contracts, lifecycle, geometry, layout, backend orchestration, capture flow and regression checker | 73 Node tests passed |
| Existing Tesseract unit tests | 31 passed |
| Dictionary extraction, source provenance and asset verification | 8 Python tests passed |
| TypeScript | `--noEmit --skipLibCheck` passed |
| Final Chromium/server fixed-input dataset | 30 passed, 20 exact, 89.2847% character accuracy |
| Final mixed-pair fixed-input dataset and blank-image contract | 31 passed; dataset 20 exact, 90.1196% |
| Final Chromium real snipping, clean capture and blank-image contract | 32 passed; dataset 21 exact, 89.7937% |
| Tesseract concurrent recognition with external networking disabled | Passed |
| Default Chrome/Edge package and default Firefox package | Both production builds passed |
| Strict before/after regression guard | Expected failure: four server-case losses, retained and disclosed above |

The [final snipping results](paddleocr-reference/snip-after/summary.json) record 85.0239% and 12/20 exact on the original cohort, and 99.3333% and 9/10 exact on the general cohort. These scores validate the current capture path, not a controlled improvement over the old capture race. The complete fixed-input before/after comparisons remain the accuracy evidence.

Package inspection confirmed browser-specific background execution and permissions, the intended model pair, exact model and YAML hashes, the 18,710-class dictionary contract, local runtime assets and third-party notices. Only the root extension file is named `manifest.json`. The largest packaged JavaScript file is the existing Tesseract runtime at 3,937,911 bytes, below the four-MiB packaging check used here. Uncompressed output is 262,472,601 bytes for Chromium and 210,521,309 for Firefox; these are directory totals, not store upload archive sizes. [Chrome package record](paddleocr-reference/chrome-package.json), [Firefox package record](paddleocr-reference/firefox-package.json). Git attributes preserve exact export YAML bytes across Windows checkouts so line-ending conversion cannot invalidate their source hashes.

Webpack still reports asset/entrypoint size warnings. No model weights, model sizes or ONNX Runtime version changed. Firefox execution, a separate Edge session, hardware-specific GPU behavior and a no-WASM-fallback run were not exercised. The shared runtime's provider failure/timeout paths are covered by unit tests. Wall-clock benchmark durations include parallel browser startup, model copying and fixture-server effects; this migration makes no measured latency or throughput improvement claim.

To reproduce new fixed-input runs using the current build and preserve artifacts:

```powershell
$env:NAMIDA_TEST_OCR_INPUT_MODE = 'fixture'
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir reference-server
$env:NAMIDA_PADDLE_ONNX_MODEL_VARIANT = 'mobile_det_server_rec'
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir reference-mixed
Remove-Item Env:NAMIDA_PADDLE_ONNX_MODEL_VARIANT
Remove-Item Env:NAMIDA_TEST_OCR_INPUT_MODE
npm run test:e2e:paddleonnx -- --workers 5 --results-subdir reference-snip
npm run test:paddle:unit
python -m unittest discover -s tests -p test_paddle_dictionary.py
npm run build:firefox
npm run build:chrome
```

Before evidence was collected by building the preserved audit source separately and setting `NAMIDA_TEST_BUILD_DIR` to that build while running the expanded dataset from this checkout. The server and mixed baselines retained the audit's original inference metadata. This avoids mixing model changes with fixture changes. For future development, preserve a fresh current-build baseline and compare matching input hashes before deciding whether to accept a change.
