# AGENTS.md

## Project Identity

Namida OCR is a browser extension only. It is not a web app, desktop app, or SaaS product.

The extension captures a region of the active tab, optionally upscales it, runs OCR locally with bundled Tesseract.js assets, copies the recognized Japanese text, and can add furigana or use browser text-to-speech.

Core constraint: keep this project offline-first and serverless. Do not introduce backend services, hosted APIs, telemetry pipelines, auth flows, or any requirement for a project-owned server. Production behavior should come from bundled extension assets and browser-provided capabilities only.

## Browser Support

- Chrome: build with `npm run build:chrome`. Chromium uses the Manifest V3 service worker plus the `offscreen` document flow defined in `manifests/manifest.chrome.json`.
- Edge: Edge support comes from the Chromium build. There is no separate Edge manifest today, so Edge should be treated as a Chromium target that uses the Chrome build output. The popup already has Edge-specific shortcut handling in `src/ui/index.ts`.
- Firefox: build with `npm run build:firefox`. Firefox uses `manifests/manifest.firefox.json`, background scripts, and does not use the Chromium `offscreen` permission/document flow.

When changing permissions, background execution, popup behavior, or shortcut flows, keep Chrome, Edge, and Firefox aligned. If you introduce a Chromium-only API, provide a Firefox-safe path.

## Key Runtime Files

- `src/background/index.ts`: background orchestration, keyboard shortcut handling, OCR/furigana routing, and Chromium offscreen bootstrap.
- `src/offscreen/index.ts`: Chromium offscreen document entrypoint for OCR and furigana work when the background context cannot host workers directly.
- `src/content/index.ts`: content-side snipping, OCR flow, clipboard, overlay, and floating window behavior.
- `src/ui/index.ts`: popup settings UI, browser-specific shortcut UX, and speech voice availability messaging.
- `src/background/TesseractOcrBackend.ts`: bundled Tesseract worker creation and OCR cleanup/scoring behavior.
- `webpack.config.js`: browser-specific manifest merge plus local bundling of OCR language data and runtime assets.

## Offline and No-Server Rules

- OCR, upscaling, and furigana generation are expected to run locally from the extension bundle.
- Keep traineddata, WASM, and model assets bundled locally. Do not switch this project to CDN downloads or server-backed OCR.
- Do not add any extension feature that requires calling an application server to function.
- Browser/system capabilities such as clipboard access or speech synthesis are acceptable. They are not a substitute for adding project servers.
- The only HTTP server in this repo is `tests/serve-fixtures.mjs`, which exists solely to serve local Playwright fixtures during tests. It is not part of product architecture.

## Build and Test Commands

- `npm run build:chrome`
- `npm run build:firefox`
- `npm run test:e2e`: builds the Chromium extension with the default OCR model and runs the Playwright suite.
- `npm run test:e2e:compare-models`: runs the OCR dataset against the bundled `jpn*` models and writes comparison output to `test-results/`.

Playwright currently exercises the Chromium extension harness. Firefox and Edge changes still need build validation and targeted manual verification.

## OCR Test Expectations

- The default OCR model is `jpn_vert`.
- The OCR dataset includes difficult manga and vertical-text samples. The model is not perfect.
- Do not assume every OCR case will be an exact text match, and do not treat every OCR miss as a pure application bug.
- Some E2E or model-comparison runs may remain non-perfect because OCR quality is a model limitation, not necessarily a regression in extension code.
- When assessing OCR changes, look at the generated summaries in `test-results/` and compare accuracy/regression trends instead of expecting perfect recognition.

## Change Guidance

- Preserve the browser-extension-only architecture.
- Preserve offline behavior and the no-server product boundary.
- Keep Chrome/Edge and Firefox differences explicit in manifests and runtime code.
- If a change affects browser support, packaging, or OCR expectations, update this file along with the README or related docs.
