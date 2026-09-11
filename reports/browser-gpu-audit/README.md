# Hardware acceleration audit evidence

See [the audit report](../browser-hardware-acceleration-audit.md). Source revision: `a23ee94`. These are diagnostic/reproduction tools, not new production behavior or benchmark acceptance thresholds.

Run from the repository root using Node 24 and installed dependencies:

```powershell
# Existing runtime tests plus four reproductions of the current defects.
node --test tests/paddle-runtime.test.mjs reports/browser-gpu-audit/runtime-policy-repro.test.mjs
node reports/browser-gpu-audit/settings-race-repro.mjs

# Use an existing normal Chrome build, or create it:
npm run build:chrome
node node_modules/@playwright/test/cli.js test --config reports/browser-gpu-audit/playwright.config.cjs --workers 5

# Additional installed Chrome/Edge adapter checks, without loading the extension.
node node_modules/@playwright/test/cli.js test --config reports/browser-gpu-audit/adapter.config.cjs --workers 5
```

The extension probe uses normal Playwright fixtures with separate test profiles and extension copies. It prepends local instrumentation to each copy's offscreen script before OCR starts. This records adapter requests, device creation/loss, compute dispatches, queue submissions, and session logs. It deliberately hides APIs, returns a null adapter, or destroys the test's own device in named fault scenarios. `dist/` and source files are not patched. The test only asserts instrumentation availability: review each observed OCR response; a completed probe can expose a product failure.

Fresh extension results are written to `.tmp/gpu-audit/results/`; adapter results to `.tmp/gpu-audit/adapter-results/`. The `extension-probes/` and `adapter-probes/` folders preserve the audited observations. The settings-race script writes its JSON next to the script, or accepts an explicit output path as its first argument. Its backend/storage mocks retain the actual service and runtime-selector source behavior, and record source SHA-256 values.

`runtime-policy-repro.test.mjs` includes one test that extracts the shared execution guard from the installed ORT 1.24.3 JSEP artifact. It may need updating if ORT is upgraded; a failure to find the guard is not a product regression. The other tests reproduce narrow error handling, sticky CPU fallback, and reuse after a strict timeout.

Environment: Windows; Node 24.11.1; Playwright 1.59.1; Chromium 147.0.7727.15; Chrome 152.0.7977.83; Edge 152.0.4191.66. NVIDIA hardware adapter (`blackwell`, non-fallback) was observed. Windows inventory lists NVIDIA RTX 5070 Ti (driver 32.0.15.9621) and Intel UHD Graphics 770 (32.0.101.7088). The browser's adapter data, rather than inventory alone, identifies the device used. No global browser/GPU settings or personal profiles were modified.
