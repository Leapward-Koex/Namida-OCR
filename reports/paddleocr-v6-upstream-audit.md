# PP-OCRv6 integration audit

Implementation follow-up: the reference pipeline rewrite is documented in [PaddleOCR reference implementation](paddleocr-reference-implementation.md), on `codex/paddleocr-reference-pipeline`. For that follow-up, the user explicitly allowed documented per-case losses to remove specialization. The historical findings, rejected experiment, and stricter acceptance decision below are preserved as recorded.

Research and validation date: 11 September 2026. Starting revision: `3fce12c35a27b9a2d489f376c49a7ad7f652fc2b`. This report distinguishes the original implementation, retained changes, and the proposed migration. Detailed benchmark evidence is included below.

The validated Paddle implementation and benchmark-tool changes described here are preserved on branch `codex/paddleocr-audit`. The findings and evidence are also retained on `master`; that branch keeps the Tesseract improvements without applying the Paddle implementation changes. Commands for the new regression tooling require the Paddle branch.

## Assessment

Namida uses an appropriate overall architecture: a bundled detector locates text, a bundled recognizer reads cropped text lines, and local code decodes and orders the results. Running the official ONNX exports in a browser does not require installing the Python PaddleOCR application, running a server, or sending screenshots elsewhere. The browser integration necessarily has to implement image preparation and output processing that the Python library normally supplies.

However, the original backend was not a faithful implementation of that inference pipeline. It contained several concrete contract errors, a simplified detector postprocessor, and a substantial collection of Japanese/manga recovery heuristics. These categories need different treatment. Contract errors should be corrected; detector geometry needs a measured implementation change; recovery heuristics should be retained or removed according to evidence rather than their resemblance to upstream code.

The selected models are appropriate for Japanese. PP-OCRv6 medium and small recognizers explicitly support Japanese as part of a shared multilingual model. The directory name `languages/chinese` does not mean that the bundled recognizer is restricted to Chinese. The model family also offers different sizes, so a smaller detector paired with the medium recognizer is a reasonable packaging choice. [Official PP-OCRv6 introduction](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.en.md)

## What was verified

The local review covered `PaddleOnnxOcrBackend.ts`, `OcrTextScoring.ts`, `prepare-paddleocr-onnx.py`, bundle metadata, dictionaries, and cached official `inference.yml` files. Both bundled recognizer sizes were also inspected as actual ONNX graphs. Their input has three channels, height 48 and dynamic width; their output has 18,710 classes. Their final node is `Softmax(axis=2)`. The medium detector ends in `Sigmoid` and emits a one-channel probability map.

The official references below were read during this review. Links to `main` and `develop` are moving references, not permanent version pins. In particular, current PaddleX defaults must not be assumed to match the library revision used when the committed models were exported. For model-specific questions, the bundled graph and cached export configuration are stronger evidence than an unrelated current default. Future asset preparation should preserve upstream revisions and hashes alongside model metadata so this distinction remains reproducible.

No claim about accuracy improvement follows merely from matching an upstream implementation. Namida's manga dataset, browser execution providers and crop selection differ from upstream evaluation conditions. The project's own baseline and per-case benchmark results remain the acceptance criteria.

## Concrete inference-contract problems

### Input channels

The original `imageToTensorData()` writes red, green and blue planes in that order. Both cached model configurations specify `DecodeImage` with `img_mode: BGR`. The official detector export also specifies scale `1/255`, mean `[0.485, 0.456, 0.406]` and standard deviation `[0.229, 0.224, 0.225]`. The recognizer export specifies BGR and a nominal `[3, 48, 320]` image shape. [Official detector export configuration](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/blob/main/inference.yml), [official recognizer export configuration](https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/blob/main/inference.yml)

This is not resolved by seeing an initial RGB reader in PaddleX source. Its recognizer builder iterates through the configured transforms and replaces that reader with one using the configured `img_mode`. [PaddleX recognition predictor, `build_readimg()`](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/text_recognition/predictor.py)

Namida therefore needs BGR tensor planes with normalization applied to the corresponding plane. Grayscale retries can conceal this mistake because all three channels become equal. A mostly monochrome benchmark may consequently understate its importance for colored text or backgrounds.

### Recognition geometry and padding

The original implementation chooses a target width between 48 and 320, rounds widths to multiples of four, paints white padding, and compresses longer lines into the 320-pixel maximum. That interpretation treats a nominal model shape as a hard width limit.

PaddleX's `OCRReisizeNormImg` instead uses height 48, starts from width 320, expands for longer crop aspect ratios, and caps width at 3200. Image pixels are normalized using `(pixel / 255 - 0.5) / 0.5`; unused tensor columns are zero. Its CTC decoder removes repeated adjacent classes and blank, then averages the selected output probabilities. The decoder also appends a space character by default. [PaddleX recognition processors, `OCRReisizeNormImg` and `CTCLabelDecode`](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/text_recognition/processors.py)

Zero after normalization is different from white before normalization: white becomes +1. The original preprocessing therefore changes both the line's shape and the context seen around its end. This can affect recognition even when the model accepts the tensor dimensions without an error.

The preferred implementation should express base width, maximum width, resized content width, and tensor padding separately. If browser performance requires a narrower cap, document it as a resource policy and measure its effect on long lines. Do not represent it as a requirement of the exported ONNX graph.

### CTC confidence

`decodeRecognitionTensor()` originally called `computeSoftmaxConfidence()` on every emitted step. The local graph inspection proves that the input to this function is already a probability distribution. Applying softmax again changes its meaning and compresses confidence differences across the 18,710 classes. It does not change the argmax character, but it changes candidate ranking and filtering downstream.

This agrees with the model implementation: `CTCHead.forward()` applies softmax in evaluation mode. [PaddleOCR CTC head](https://github.com/PaddlePaddle/PaddleOCR/blob/main/ppocr/modeling/heads/rec_ctc_head.py)

The correction is to use the winning probability directly, with a clear 0–1 or 0–100 convention at the scoring boundary. The original blank removal and adjacent-repeat collapse are otherwise appropriate. Because Namida's heuristic scores were operating on distorted confidences, correcting this arithmetic requires evaluating selection behavior, not just checking that decoded individual strings stay the same.

### Dictionary class alignment

The cached export contains 18,708 dictionary entries. Original bundle dictionaries had the same count, but the model emits 18,710 classes. The missing class is the final space: one blank plus 18,708 exported characters plus space accounts for every output class. The training configuration explicitly enables `use_space_char: true`. [Official PP-OCRv6 medium recognition training configuration](https://github.com/PaddlePaddle/PaddleOCR/blob/main/configs/rec/PP-OCRv6/PP-OCRv6_medium_rec.yml)

A second error came from treating YAML as strings with removable outer quotes. The YAML entry `''''` represents one apostrophe; the original parser produced two apostrophes. This did not shift later indices, but it made that class emit two characters.

The dictionary corrections are complete: all four bundled dictionaries now have 18,709 entries, the apostrophe entry is correct, and a final space is present. Preparation defaults to appending space and decodes quoted dictionary entries. Five Python regression checks cover these cases, invalid line entries, explicit space settings, and the committed output-class count. Added runtime validation rejects a model/dictionary cardinality mismatch instead of silently dropping unknown classes.

## Detector postprocessing is a different algorithm

The original `extractDetectedBoxes()` thresholds and dilates the probability map, flood-fills connected components, averages probabilities over the component pixels, and takes axis-aligned bounds. It expands each axis by a fixed minimum or 8% of that axis, then retains at most 24 boxes. This is a plausible lightweight approximation, but it is not standard DB postprocessing.

PaddleX's DB implementation extracts contours, finds minimum-area rectangles, scores a polygon region, and expands the region using `distance = area * unclip_ratio / perimeter`. It then recomputes a minimum-area rectangle and scales coordinates to the source. Default dilation is disabled; its optional dilation uses a 2×2 kernel. Minimum-size checks operate on the rectangle's short side. [PaddleX detector processors, `boxes_from_bitmap()`, `unclip()` and `box_score_fast()`](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/text_detection/processors.py)

These differences have practical consequences. Axis-aligned bounds lose the angle of slanted text and can include adjacent lines. Percentage padding is especially different for a long narrow line: expansion should restore the thickness lost during detector training, rather than grow its long and short dimensions independently. A score over only thresholded component pixels is also not interchangeable with a score over the surrounding rectangle.

A proper replacement should retain quadrilateral coordinates through detection, cropping and debug artifacts. It should implement and test the geometry as a separate module. Introducing a large vision library is an implementation choice, not a model requirement; its extension package size and offline runtime costs would need consideration. A dependency-free approximation was tested during this audit and rejected because individual cases regressed, as recorded below. It did not establish full equivalence with the reference implementation.

Detector resize settings require more care than simply copying one number. Current PaddleX's standalone v6 detector predictor selects 960/max, while exposing parameters that can override it. [PaddleX detector predictor](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/text_detection/predictor.py) Its current OCR pipeline configuration instead supplies 64/min and a 4000 maximum. [PaddleX OCR pipeline configuration](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/configs/pipelines/OCR.yaml) Namida's 736/min and 1536 maximum are therefore application policies. They should be documented and measured, rather than classified automatically as bugs.

## Which complexity is justified?

Some machinery belongs in any browser implementation: loading local assets, preparing tensors, decoding output, keeping sessions reusable, handling execution-provider failures, and exposing useful debug information. These concerns should be separated so a change to GPU recovery cannot accidentally alter text layout rules.

Tall-crop rotation is also upstream behavior. The official crop processor perspective-warps quadrilateral text regions, then rotates them counterclockwise when height/width is at least 1.5. [PaddleX crop processors, `get_rotate_crop_image()`](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/pipelines/components/common/crop_image_regions.py) Namida's equivalent rotation should not be removed merely because it looks heuristic.

Other behavior is application-specific: repeated recognition of original, grayscale and binarized crops; whole-selection recognition; projection and valley-based column splitting; bonuses for Japanese text; penalties for digits or Latin letters; and conversion of character variants. These choices may help the current manga cases, but they can also suppress legitimate mixed-language content or select plausible text that does not match the image.

In particular, a line recognizer should not ordinarily receive a multiline selection as its main input. Whole-selection recognition is best understood as a fallback for failed detection. Japanese right-to-left column ordering is a layout decision; the recognition network does not supply the reading order of multiple independent regions. A benchmark showing useful fallback behavior justifies keeping that fallback, not conflating it with the model's preprocessing contract.

## Recommended structure and acceptance process

The intended pipeline is:

1. Decode the selected screenshot locally and retain source coordinates.
2. Prepare a BGR detector tensor using an explicit browser resource policy.
3. Run the detector once on the normal path and apply DB geometry.
4. Order text regions, rectify each quadrilateral, and rotate tall line crops.
5. Prepare BGR recognition tensors with documented width and padding rules.
6. Decode probabilities using the exact dictionary and blank convention.
7. Assemble text in the appropriate reading order.
8. Apply bounded recovery attempts when detection or recognition warrants them, recording why they ran and which result won.

Session management, model contracts, geometry, layout, and recovery should become separate modules. This makes the backend smaller while preserving useful behavior; reducing file length alone is not an accuracy improvement.

Validation should start by preserving the existing benchmark outputs and defining non-regression per case against `reports/ocr-performance.md`. Apply contract fixes before a detector rewrite so failures remain attributable. Compare decoded text, character accuracy, exact-match counts, and timings, and inspect candidate/debug artifacts when a score falls. Correct confidence values can legitimately change which retry wins, so a green test run that merely records metrics is insufficient.

Additional cases would be most useful where the current dataset cannot expose the discovered errors: colored text, an apostrophe and spaces, a long line exceeding the old width cap, rotated text, and mixed Japanese/Latin content. Browser-specific model packaging should retain separate evaluation evidence. Chrome/Edge and Firefox builds remain necessary even though the current extension E2E harness exercises Chromium.

All production processing should continue to use bundled models, dictionaries and ONNX Runtime assets. The official Python application is a useful reference implementation for development; it is not a proposed product dependency or server.

## Integration and benchmark outcome

### Retained changes

- Corrected apostrophe parsing and the missing space class in the preparation script and all four dictionaries. Model weights and bundle selection are unchanged.
- Extracted session ownership into `PaddleOnnxRuntime.ts`. Retired sessions are now released; in-flight inference finishes before release, and sessions that arrive after an initialization timeout are released too. Cache identity checks prevent an old rejection from evicting a replacement. Local asset loading, provider order, and fallback policy are preserved.
- Added `PaddleOnnxModelContract.ts` to check float32 output buffers, positive safe dimensions, detector shape `[1,1,H,W]`, recognizer shape `[1,T,18710]`, and dictionary cardinality before decoding.
- Added a regression checker that rejects per-case accuracy or exact-match losses even if other cases improve. New cases cannot inflate the original cohort's score. JSON comparisons also reject changed expectations, input modes, or recorded input hashes.
- Added optional fixed-input benchmarking using the existing dataset and scoring format. Default snipping behavior remains available and was separately exercised.

The backend is smaller because session management moved out, but its image-processing and manga recovery logic is still substantial. RGB channel order, compact recognition widths, white padding, approximate detector geometry, and the old selection weighting remain. The second softmax is now explicitly named `computeLegacyRankingConfidence` and documented as an uncalibrated selection weight. Newly decoded spaces do not enter the visible-character confidence average. These compatibility choices preserve current behavior; they are not a claim that the original model contract was correct.

### Why the benchmark needed controlled inputs

Early before/after snipping runs produced different images for the same fixture. The captured evidence includes a [gray selection overlay and dashed border](paddleocr-v6-audit/overlay-input.png) in one run and a [clean crop](paddleocr-v6-audit/clean-input.png) in another. In `SnippingOverlay.endSelection`, the completion callback starts before the overlay is hidden; screenshot capture can precede the next painted frame. This is a separate capture-flow issue, and this patch does not fix it. Those runs cannot isolate an OCR implementation change. The [initial unmodified snip run](paddleocr-v6-audit/snip-before.json) recorded 90.09068% and 14/20 exact matches; the later snip result was lower, which prompted the input investigation and controlled comparisons instead of accepting either uncontrolled score as proof.

`NAMIDA_TEST_OCR_INPUT_MODE=fixture` draws the same fixture at its configured display size and inset, uses fixed white edge pixels and the existing 4× canvas upscale, and sends that image through the extension's normal recognition message and background/offscreen routing. It bypasses selection and screenshot capture. All 20 existing cases and their scoring rules are unchanged. TensorFlow upscaling is explicitly unsupported in this test mode; the dataset uses supported settings.

Each result records its input mode and SHA-256 of the PNG bytes. Fixed input PNGs are saved under `ocr-fixture-inputs/` and preserved by `--results-subdir`. Snip mode instead hashes the backend's padded working PNG when debug data is available. These hashes are conservative checks within the same browser environment, not cross-browser decoded-pixel comparisons. Do not compare hashes across modes or assume browser canvas encoders remain byte-identical across versions.

Another task was editing and testing this checkout concurrently. The final benchmark and browser builds therefore used an isolated copy of the starting revision plus this task's changes, a dedicated fixture-server port, and at least five Playwright workers. Per-test extension copies shared immutable build assets through hard links; each manifest remained independently writable. This avoids interference from concurrent builds. No benchmark improvement is attributed to wall-clock timing from this environment.

### Controlled results

Acceptance was defined as no decrease in **any** existing case's character accuracy or exact-match status, plus no decrease in the original cohort's aggregate scores. All 20 input hashes match across these runs.

| Implementation | Average character accuracy | Exact matches | Cases below controlled original | Decision |
| --- | ---: | ---: | ---: | --- |
| Original backend and original dictionary | 84.93195% | 12/20 | — | Before |
| Retained changes | 84.93195% | 12/20 | 0 | Pass |
| DB/preprocessing experiment | 86.53026% | 12/20 | 3 | Rejected |

The complete case results, expected text, actual text, and input hashes are preserved in [before.json](paddleocr-v6-audit/before.json), [after.json](paddleocr-v6-audit/after.json), and [db-experiment.json](paddleocr-v6-audit/db-experiment.json). The retained changes also preserve every normalized output string in this controlled comparison.

The experiment combined BGR input, reference-like recognition width/zero padding, direct probability confidence, oriented boxes and perspective crops with the existing recovery rules. It used a dependency-free component/convex-hull approximation: contour handling, polygon rasterization and offset quantization were not identical to OpenCV/Pyclipper, and crop sampling was bilinear rather than the reference's cubic interpolation. It therefore tests a proposed replacement, not the exact official Python pipeline.

| Regressing experiment case | Controlled original | Experiment |
| --- | ---: | ---: |
| `manga-ocr-case-005-pinpoon` | 50.0% | 0.0% |
| `case-006-a-sore-zenbu-iinchou-dayo` | 100.0% | 91.7% |
| `case-009-saikin-kurasu-no-fuuki` | 100.0% | 95.0% |

Two formerly exact cases lost their exact match, while other cases gained matches; an unchanged exact-match total concealed those losses. A higher average alone would therefore have accepted a regression. The experimental geometry module and preprocessing changes are excluded from production.

The normal capture-flow sweep also completed 20/20 tests, with 87.59068% character accuracy and 13/20 exact matches; [snip-after.json](paddleocr-v6-audit/snip-after.json) preserves that result. These are integration and capture-path results, not a controlled accuracy improvement over the fixture mode.

### Relationship to the recorded performance report

`reports/ocr-performance.md` is preserved unchanged. It records 83.4% and 9/20 exact matches from revision `9a2ab6c`, dated 18 June 2026. Subsequent revision `4421dfa` changed four expected labels, and the old report has no input hashes. Its numbers are therefore not interchangeable with today's controlled input run.

For transparency, the historical guard still fails: six fixture-mode cases and three final snip-mode cases are below its recorded per-case percentages, despite higher aggregate scores. In the final snip run those cases are `manga-ocr-case-001-sunao-ni-ayamaru-shika` (50.0% versus 63.6%), `manga-ocr-case-007-keisatsu-nimo-sensei-nimo-machijuu-no-hitotachi-ni` (38.7% versus 44.4%), and `case-012-obaachan` (87.5% versus 93.8%). The first unmodified snipping run was also below the recorded scores on the latter two cases. This audit does **not** claim that every historical score has been recovered. It demonstrates that the retained patch introduces no quality regression against the original backend on identical current inputs.

Reproduce the preserved controlled comparison:

```powershell
npm run test:ocr:regression -- --baseline reports/paddleocr-v6-audit/before.json --actual reports/paddleocr-v6-audit/after.json
```

For a new before/after run, use the fixture-mode commands in the README, retain both result directories, and require matching input hashes. Keep the ordinary screenshot tests as a separate integration check.

### Validation and remaining migration

The 30 Node tests for lifecycle, output contracts, and the regression guard pass, as do five Python dictionary tests and TypeScript checking with `--noEmit --skipLibCheck`. Chromium exercised the server bundle. Chrome and Firefox production builds were also checked with their default bundle selection; Firefox retains background scripts without the offscreen permission and uses `mobile_det_server_rec`, while Chrome uses the service worker/offscreen path and `server`. Both include the corrected dictionaries. Build size warnings remain; no model weights or vision-library dependencies were added.

Firefox OCR execution and a separate Edge browser run were not validated by this Chromium harness. Build success alone does not establish their runtime accuracy. GPU timeout/provider failure behavior is covered with mocked lifecycle tests; this review does not establish performance or recovery on every GPU.

The next correctness migration should compare exact reference preprocessing/DB geometry against saved inputs, separate calibrated model probability from recovery selection scores, and measure each recovery rule independently. Keep the original path as an explicit comparison during development until all current cases pass the per-case guard. Add colored, long, rotated and mixed-script cases in the same dataset format before declaring the model contract fully corrected. The safe fixes in this patch provide that foundation, and the failed experiment identifies why replacing the whole backend at once would not meet the requested non-regression condition.
