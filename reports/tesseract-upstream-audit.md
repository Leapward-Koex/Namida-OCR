# Tesseract upstream audit and regression results

Date: 2026-09-11. Library: bundled Tesseract.js 5.1.1, LSTM-only. Default model: jpn_vert.

## Result

Average character accuracy improved from 71.83% to 73.50% on the existing 20-case Chromium screenshot dataset. Exact matches remained 7/20. Two cases improved; none regressed. These results describe this dataset, not a guarantee for unseen images.

| Case | Before | After | Change (percentage points) |
| --- | ---: | ---: | ---: |
| manga-ocr-case-001-sunao-ni-ayamaru-shika | 32.00% | 32.00% | 0.00 |
| manga-ocr-case-002-tachikawa-de-mita-ana-no-shita-no-kyodaina-me-wa | 1.29% | 1.29% | 0.00 |
| manga-ocr-case-003-jissen-kenjutsu-mo-ichiryuu-desu | 55.56% | 66.67% | 11.11 |
| manga-ocr-case-004-gya | 100.00% | 100.00% | 0.00 |
| manga-ocr-case-005-pinpoon | 18.75% | 18.75% | 0.00 |
| manga-ocr-case-006-faia-panchi | 42.86% | 42.86% | 0.00 |
| manga-ocr-case-007-keisatsu-nimo-sensei-nimo-machijuu-no-hitotachi-ni | 27.59% | 27.59% | 0.00 |
| case-001-inuda-san | 100.00% | 100.00% | 0.00 |
| case-002-hai-owari-mou-dame | 100.00% | 100.00% | 0.00 |
| case-003-kako | 50.00% | 50.00% | 0.00 |
| case-004-genzai | 100.00% | 100.00% | 0.00 |
| case-005-teto-san-kekkon-shiyou | 100.00% | 100.00% | 0.00 |
| case-006-a-sore-zenbu-iinchou-dayo | 100.00% | 100.00% | 0.00 |
| case-007-kawaii | 75.00% | 75.00% | 0.00 |
| case-008-ore-otoko-no-ko-damon | 90.00% | 90.00% | 0.00 |
| case-009-saikin-kurasu-no-fuuki | 100.00% | 100.00% | 0.00 |
| case-010-daiji-na-no-wa-konten-tsu-daro | 85.71% | 85.71% | 0.00 |
| case-011-zundamon-senpai-tsumetai-kute-kimochi-ii | 94.44% | 94.44% | 0.00 |
| case-012-obaachan | 94.12% | 94.12% | 0.00 |
| case-013 | 69.23% | 91.67% | 22.44 |

## Changes

- Retain the original image/PSM result. For empty output or confidence below 85, make at most one retry with a 10px white border. Inputs whose smaller dimension is at least 80px are also reduced to half size; smaller inputs retain their resolution. Normal capture already upscales 4x, so this offers an alternative glyph size without changing the user's setting.
- Accept a retry only when overall confidence and candidate score both increase, the Japanese-character ratio does not decrease, and at least 75% of the original text length is retained. An empty/failed retry preserves the original result. This is a conservative heuristic validated against the dataset; confidence is not an accuracy guarantee.
- Queue each complete recognition request, including preprocessing and retries, on its cached model worker. Termination drains accepted jobs, and rejected requests do not poison the queue.
- Pass PSM as a request-local recognize option. Request text and blocks (for symbol confidence); omit unused hOCR/TSV output. Handle missing symbols and initialization errors explicitly.
- Share Chromium offscreen existence checking and creation across simultaneous first requests. Firefox keeps its existing background-worker path.
- Decode retry images with createImageBitmap and close the bitmap in a finally block. In an actual Chromium offscreen document, Image.onload fired but Image.decode() did not settle; bitmap decoding resolved the same image.

All models, workers, WASM, and image processing remain extension-local. No dependency/model/permission changes, hosted services, or Paddle backend edits were introduced by this work.

## Guidance and rejected experiments

[Tesseract image-quality guidance](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html) recommends suitable resolution, small borders, and an appropriate page-segmentation mode. Existing local LSTM assets and the model-driven PSM mapping were retained. Unconditional padding/resizing regressed several samples; unbordered downscaling and automatic deskew also caused regressions in the experiments. Alternate threshold settings and DPI300 did not improve the tested outputs, so they were not added. Retry selection uses only image/OCR signals, not sample identities or expected text.

[Tesseract.js v5 API documentation](https://github.com/naptha/tesseract.js/blob/v5.1.1/docs/api.md) documents per-recognition parameters and output options. [Worker guidance](https://github.com/naptha/tesseract.js/blob/v5.1.1/docs/workers_vs_schedulers.md) motivates worker reuse and queueing. [Local installation guidance](https://github.com/naptha/tesseract.js/blob/v5.1.1/docs/local-installation.md) supports retaining the bundled SIMD/non-SIMD LSTM core directory.

## Validation

- Full Chromium suite: 21 passed with 5 workers, including the 20 existing screenshot OCR cases and a new concurrent horizontal jpn test with networking disabled. Final test process exited successfully.
- Worker/retry unit tests: 31 passed via node --test tests/tesseract-backend.test.mjs.
- TypeScript application check: tsc --noEmit --skipLibCheck passed. Unfiltered tsc reports existing dependency/ambient declaration problems unrelated to this change.
- Chrome and Firefox production builds passed (existing webpack size warnings only).
- Compared every case's characterAccuracy and exact-match counts, not just Playwright's status; dataset tests otherwise mostly record metrics without thresholds.

Builds and tests used an isolated snapshot under test-results/tesseract-audit-workspace so concurrent Paddle work and the main dist/test results were not overwritten. Only Tesseract changes and the offscreen startup fix were applied to its product source. A short artifact path avoided Windows Chromium profile path-length errors. Browser tests ran with normal Windows process access after sandboxed Chromium cleanup stalled.

Preserved evidence: [before](tesseract-audit/before.json), [after](tesseract-audit/after.json), [per-case comparison](tesseract-audit/comparison.json). Final local log: test-results/tesseract-audit-workspace/final-regression.log. The published reports/ocr-performance.md was left unchanged; these percentages use a fresh local baseline.

Firefox and Edge were not manually exercised; Firefox production packaging is checked separately and Edge shares the Chromium build.
