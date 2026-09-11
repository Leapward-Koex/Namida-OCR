# Browser hardware acceleration fixes

12 September 2026. Branch: `codex/paddleocr-reference-pipeline`. Follow-up to the [audit of revision a23ee94](browser-hardware-acceleration-audit.md). ONNX Runtime Web 1.24.3 and the committed PP-OCRv6 model assets are unchanged.

All implementation findings from the audit are addressed. The corrected extension performs real WebGPU compute, recovers from device loss and timeouts in a fresh CPU runtime, and exposes its current provider and recovery reason. Both shipped model pairs retain every previous fixed-input OCR result. CPU and GPU also produce identical text on this dataset.

## What changed

| Audit issue | Implemented correction |
| --- | --- |
| A timed-out GPU operation still owns shared ORT/JSEP state when WASM starts | The complete ORT module, sessions and GPU device now belong to an extension-local worker. The parent terminates that worker before creating the CPU retry. The offscreen/background host stays alive. |
| Settled provider errors and strict timeouts leave broken sessions reusable | Provider errors, worker crashes, watchdog expiry and `GPUDevice.lost` retire the whole context. Normal builds retry once on CPU; strict builds reject and allow the next scan to create a fresh GPU context. Model/input/contract errors remain explicit. |
| WebNN selected for unvalidated dynamic models | Automatic selection is WebGPU then WASM. WebNN is excluded. The existing JSEP-compatible ORT import and matching local runtime assets are preserved. |
| Concurrent requests overwrite settings and create duplicate backends | The service serializes captured settings, backend selection, inference and that request's debug snapshot together. Lifecycle changes share the queue; the selector also snapshots settings and serializes backend creation. |
| Requested provider presented as acceleration evidence | Status distinguishes saved preference, provider, initialization, completed inference, adapter details, runtime generation and failure reason. The popup exposes status, expandable details and Retry GPU. Debug snapshots retain the same diagnostics. |
| Software/null adapters and permanently sticky CPU fallback | Software adapters are rejected; absent APIs and adapters produce an explicit CPU fallback reason. Retry GPU, a preference change or backend termination discards the context and resets fallback state. Repeated ordinary scans reuse a healthy CPU fallback. |
| TensorFlow input/output leaks and eager AI startup | AI libraries/model initialize only on an AI request, sharing a retryable initialization promise. Caller-owned tensors are disposed after async inference/data reads, including failure paths. Content uses native canvas pixels; settings import a lightweight enum. Model weights remain cached. |
| “No fallback” confused with all-GPU operator placement | UI, comments and documentation distinguish Namida's CPU retry from ONNX Runtime's internal CPU node placement. Real dispatches are asserted separately in hardware integration tests. |

The worker uses a worker-compatible webpack entry, single-thread WASM and no ORT proxy worker. All runtime/model URLs point into the extension. GPU initialization allows 20 seconds per requested model, GPU inference 15 seconds, and CPU commands 120 seconds. These are watchdog limits, not expected scan times. A high-performance adapter request remains a browser hint; integrated graphics is valid hardware acceleration.

The runtime design follows ORT's distinction between global environment state and session configuration, and observes the actual device published by ORT rather than constructing a device without its required features/limits. [ORT environment/session documentation](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html), [GPUDevice.lost](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost).

## Browser and fault validation

The Chromium tests used the production extension build in disposable profiles, five configured Playwright workers and `NAMIDA_TEST_REQUIRE_WEBGPU=1`. Fault instrumentation was added only to per-test extension copies. No GPU blocklist or hardware-enabling flags were used.

- A real non-fallback NVIDIA `blackwell` adapter executed 747 compute dispatches and 430 queue submissions on the first small OCR sample. Turning GPU off selected WASM without another adapter request.
- Missing WebGPU API, a null adapter and a software adapter all returned the expected text through CPU fallback. Repeated scans reused that context, and the visible Retry GPU action created a new runtime.
- Deliberately destroying the actual device after successful OCR caused CPU recovery. Explicit retry subsequently restored working GPU inference. The former `Session already started` failure did not recur.
- A separate unfinished-run probe submitted real GPU commands and immediately destroyed the device while inference request 5 was still pending. The old worker was terminated, that OCR request completed with correct text on CPU, and the next scan reused the CPU context. No shared-runtime collision occurred.
- An initialization stall and a deliberately dropped real GPU result exercised the parent watchdogs. Both terminated their worker and completed OCR on CPU. The strict build rejected the timed-out request, terminated its worker, then completed the next scan on a new GPU worker with no CPU worker created.
- Repeated offline AI requests used one bundled model load and produced stable valid 2× images. Unit checks using actual TensorFlow allocations and the bundled ESRGAN weights showed no accumulating per-request tensors.

All nine normal fault/status tests and the strict timeout test passed. The expanded popup details were also visually checked in healthy and fallback states. [Raw acceleration evidence](browser-gpu-fixes/acceleration), [AI evidence](browser-gpu-fixes/upscaler-offline-results.json), [healthy GPU details](browser-gpu-fixes/ui/popup-healthy-gpu.png), [CPU fallback details](browser-gpu-fixes/ui/popup-no-adapter.png).

Installed Firefox 155.0.1 was also exercised with its actual mixed-model build, a fresh headless profile, temporary add-on installation and Mozilla WebDriver BiDi. Three OCR requests returned the exact expected text. The missing headless GPU adapter triggered WASM fallback; the next request reused it; disabling GPU created a fresh CPU context. Firefox's AI image/data-URL route returned a valid 16×16 PNG from an 8×8 input. All owned browser processes were closed. Mozilla's required `--remote-allow-system-access` flag was confined to this isolated automation browser; no GPU or signing overrides were used. [Firefox evidence and reproduction instructions](browser-gpu-fixes/firefox/README.md).

Firefox hardware GPU execution remains unverified because its headless adapter request returned null. Chrome/Edge share the validated Chromium implementation; the prior audit separately verified adapters in installed Chrome and Edge, without running full extension OCR there. Other GPUs, operating systems and real driver resets are not covered by these local tests.

## OCR regression results

The same 30 fixed inputs, original labels and model weights were used. Each comparison checked all input SHA-256 hashes, individual recognized texts and individual accuracy scores. The before baselines are the preserved reference rewrite results, not the older benchmark with different capture pixels.

| Shipped model pair | Before GPU | After GPU | After CPU | Exact matches |
| --- | ---: | ---: | ---: | ---: |
| Chromium: medium detector + medium recognizer | 89.28472034% | 89.28472034% | 89.28472034% | 20/30 throughout |
| Firefox: small detector + medium recognizer | 90.11962819% | 90.11962819% | 90.11962819% | 20/30 throughout |

No case regressed or changed its recognized text. All 120 recorded provider observations matched the requested GPU/CPU lane. Both model-pair datasets were measured in the Chromium fixture harness; the separate Firefox checks above validate Firefox runtime integration. [Complete per-case verification](browser-gpu-fixes/verification.json), [server baseline comparison](browser-gpu-fixes/server/regression.txt), [mixed baseline comparison](browser-gpu-fixes/mixed/regression.txt), [server CPU comparison](browser-gpu-fixes/server-cpu/comparison.txt), [mixed CPU comparison](browser-gpu-fixes/mixed-cpu/comparison.txt).

Validation also passed for 119 Paddle/service/upscaler/capture/regression unit checks, 31 Tesseract unit checks, eight Python preparation checks, TypeScript with `--skipLibCheck`, Chrome and Firefox production builds, clean capture, blank-image behavior, concurrent offline Tesseract requests, and an actual Paddle snip. Builds retain the expected bundled-asset size warnings. [Snip result](browser-gpu-fixes/snip-result.json).

The normal Chrome build remains in `dist/` with the default Tesseract backend and runtime Paddle selection. There are no model downloads at runtime, new permissions, application servers, telemetry, or changed model assets. The benchmark case format and labels remain unchanged; the new tests extend runtime and provider coverage.

## Repeating the checks

Use Node 24 or another supported current Node release. The repository wrappers require at least five configured workers.

```powershell
npm run test:paddle:unit
npm run build:chrome
$env:PLAYWRIGHT_WORKERS = '5'
$env:NAMIDA_TEST_REQUIRE_WEBGPU = '1'
node node_modules/@playwright/test/cli.js test tests/paddle-acceleration.spec.ts --workers 5
```

For the fixed dataset, set `NAMIDA_TEST_OCR_BACKEND=paddleonnx` and `NAMIDA_TEST_OCR_INPUT_MODE=fixture`; run `tests/extension.spec.ts`, then `tests/write-ocr-summary.mjs`. Repeat with the packaged mixed model pair. For CPU, unset `NAMIDA_TEST_REQUIRE_WEBGPU` and set `NAMIDA_TEST_PADDLE_GPU_ENABLED=0`. For the strict timeout test, build with `--env paddleonnx_disable_wasm_fallback=true` and set `NAMIDA_TEST_EXPECT_STRICT_GPU=1`. Restore the normal build afterward. README and AGENTS.md describe these lanes and their limits.
