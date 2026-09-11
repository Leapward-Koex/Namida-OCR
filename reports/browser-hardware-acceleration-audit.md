# Browser hardware acceleration audit

12 September 2026. Audited revision: `a23ee94`, branch `codex/paddleocr-reference-pipeline`. ONNX Runtime Web 1.24.3; TensorFlow.js 4.11.0. This is a read-only production-code audit; the added files contain findings, probes and evidence.

Follow-up: the requested fixes and their validation are recorded in [browser-hardware-acceleration-fixes.md](browser-hardware-acceleration-fixes.md). The findings and evidence below describe the audited revision, not the corrected implementation. The historical reproduction scripts require that revision; current regression tests live under `tests/`.

## Assessment

**The normal Paddle WebGPU path really executes on hardware, but recovery and reporting need changes before it can be described as reliable across users' browsers.** The current bundle/import is correct. Successful OCR with the GPU setting enabled was verified using an actual NVIDIA adapter and intercepted WebGPU compute dispatches, rather than trusting the application's `accelerated: true` log.

The highest-priority defect is timeout/device-loss recovery: the code can attempt WASM inference while the timed-out GPU operation still owns ONNX Runtime's shared execution state. A live reproduction failed with `Session already started` after approximately 15 seconds. Other findings concern cached failed sessions, WebNN dynamic shapes, concurrent settings, and TensorFlow resource ownership.

## Live evidence

The machine exposes an NVIDIA GeForce RTX 5070 Ti and Intel UHD Graphics 770. The browser reported a non-fallback NVIDIA `blackwell` adapter; the audit did not infer actual device selection from the Windows inventory alone. The extension tests used its production Chromium build, with instrumentation prepended only to disposable test copies of the offscreen script. No application inference/provider settings were modified except the named fault injection or GPU preference. All browser invocations configured five workers.

Each extension probe sent the same original fixture, `ocr-general-002.png`, through the actual popup → background → offscreen OCR message route twice. The expected output was `日本語 OCR Test 2026`.

| Scenario | Actual outcome |
| --- | --- |
| GPU enabled, normal environment | Correct text twice; NVIDIA adapter, `isFallbackAdapter: false`; 747 compute dispatches on the first request and another 561 on the second. |
| GPU disabled | Correct text twice; no WebGPU adapter requests or dispatches. |
| `navigator.gpu` / `navigator.ml` unavailable | Correct text twice using local WASM. |
| WebGPU API present but `requestAdapter()` returns null | Correct text twice using local WASM; no GPU work. |
| GPU device deliberately destroyed after successful OCR | First request correct; second took 15,143 ms, logged a WASM detector initialization, then returned a rejected-message payload containing `Session already started`. |

Raw results: [normal GPU](browser-gpu-audit/extension-probes/gpu-enabled.json), [GPU off](browser-gpu-audit/extension-probes/gpu-disabled.json), [missing API](browser-gpu-audit/extension-probes/gpu-api-unavailable.json), [null adapter](browser-gpu-audit/extension-probes/adapter-unavailable.json), [device loss](browser-gpu-audit/extension-probes/gpu-device-lost.json).

The second normal GPU request took 51 ms versus 842 ms for GPU-off in this one probe. Cold GPU startup took 4,622 ms. These are illustrative end-to-end observations under concurrent test load, including IPC and processing; they are not a representative speed benchmark. Compute dispatches and completed OCR output are the evidence of hardware use.

Separate capability probes created real devices in installed Chrome 152.0.7977.83 and Edge 152.0.4191.66, as well as Playwright Chromium 147.0.7727.15. Default and `high-performance` requests selected the same NVIDIA adapter in Chrome/Edge. These were local-page adapter tests, **not** full extension OCR tests in those branded browsers. `navigator.ml` was absent in all probed default environments. Firefox 155.0.1 is installed but was not runtime-tested. [Adapter records](browser-gpu-audit/adapter-probes).

## Findings, in priority order

### P1 — Timeout fallback re-enters an unfinished ORT runtime

`PaddleOnnxRuntime.ts:96–114` races inference against a 15-second timer. The actual inference continues after that timer rejects. `retireSessions()` correctly avoids freeing its live tensors/session, but the fallback then initializes and runs WASM in the same JavaScript/ORT context.

Both providers use the same JSEP module. The installed `ort-wasm-simd-threaded.jsep.mjs` has a shared execution guard that rejects concurrent runs with `Session already started`. The live destroyed-device result above demonstrates the collision. A separate [reproduction](browser-gpu-audit/runtime-policy-repro.test.mjs) extracts and executes the actual guard from the installed runtime, so this conclusion is not based solely on mocks that assume providers are independent.

**Recommendation:** make the inference runtime disposable as a whole. Host it in an explicitly owned worker/context, terminate that context after an unrecoverable hang or device loss, and create a fresh WASM runtime before retrying. Chromium can also recover by deliberately recreating its offscreen execution context, but ownership must account for its other responsibilities and concurrent requests. Firefox needs an equivalent worker/context strategy. Do not simply release sessions or retry a different provider while an old operation is still running. A timeout is not cancellation.

### P2 — Other GPU failures and strict timeouts leave bad sessions reusable

`shouldFallbackToWasm()` at `PaddleOnnxRuntime.ts:241` recognizes only the timeout message and two variants of an old MaxPool error. A unit reproduction using the actual runtime class and simulated provider-error messages shows settled device/operation/validation/allocation failures propagating without invalidating the cached accelerated session, and subsequent requests reusing it. This verifies Namida's cache policy, not the exact error wording every browser emits. In strict builds, the early throw at line 102 also leaves a timed-out, unfinished session available for another request.

**Recommendation:** observe `GPUDevice.lost` explicitly and retire a confirmed failed execution context even when automatic fallback is disabled. Distinguish provider/device failures from malformed inputs, invalid model outputs and application exceptions; indiscriminately retrying every exception would hide real bugs. A strict build should fail clearly and safely, rather than reuse damaged state. Device loss can occur after successful initialization. [GPUDevice.lost documentation](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost).

ORT itself retains backend initialization and the WebGPU device at module scope. In the installed JSEP implementation, `env.webgpu.device` and `adapter` become nonconfigurable properties. Releasing model sessions alone is not a general device-recreation mechanism.

### P2 — WebNN is selected without the dimensions these models require

`PaddleOnnxRuntime.ts:233` requests WebNN GPU execution without `freeDimensionOverrides`. The shipped detector input has symbolic batch, height and width; the recognizer has symbolic batch and width. ORT 1.24.3's WebNN builders reject dynamic dimensions. Unsupported computation can run through the implicitly available CPU provider, while Namida labels the session accelerated solely from the requested provider name.

This is a source-confirmed integration mismatch, not a measured zero-partition result: WebNN was unavailable in the default browsers tested here. The pinned [WebNN shape check](https://github.com/microsoft/onnxruntime/blob/v1.24.3/onnxruntime/core/providers/webnn/builders/helper.cc#L72-L96) and [base builder](https://github.com/microsoft/onnxruntime/blob/v1.24.3/onnxruntime/core/providers/webnn/builders/impl/base_op_builder.cc#L44-L79) establish the restriction; ORT's [implicit CPU provider](https://github.com/microsoft/onnxruntime/blob/v1.24.3/onnxruntime/core/session/inference_session.cc#L1945-L1952) explains why requesting WebNN does not prove GPU execution.

**Recommendation:** remove WebNN from automatic production selection until it has shape-specific session creation and measured compute placement. Alternatively implement bounded session caching keyed by the concrete input dimensions, supply matching free-dimension overrides, and verify actual WebNN partitions/dispatches for both models. WebGPU plus local WASM already provides the verified normal path.

### P2 — Concurrent requests can apply the wrong GPU setting

`OcrService.ts:49–53` mutates a shared settings override and awaits before calling recognition. `RuntimeSelectableOcrBackend.ts:48–53` stores that override globally to the backend instance; `ensureBackend()` at line 66 has no queue or shared creation promise.

A deterministic reproduction using both actual transpiled classes shows simultaneous GPU-off/GPU-on requests both running with GPU-on. Two concurrent requests with identical settings also create two backend instances. The sequential off/on control applies each setting correctly. Leaf OCR backend queues cannot repair a race that occurs before the backend is selected. [Reproduction and source hashes](browser-gpu-audit/settings-race-result.json).

**Recommendation:** pass immutable settings with each request, and serialize selection/settings/inference at the service boundary or provide equivalent ownership guarantees. Ensure concurrent initial selection shares one backend. Preserve correct sequential behavior and test a setting change while another request is running.

### P2 — AI upscaling leaves caller-owned tensors allocated

The background tensor input/output in `Upscaler.ts:30–34`, content `fromPixels()` tensor at line 46, and content output tensor at line 61 are never disposed. The installed UpscalerJS implementation clones input tensors and returns caller-owned tensor output. Repeated AI upscales therefore retain application-owned allocations, which can consume WebGL resources when that backend is selected.

**Recommendation:** dispose these tensors in `finally` blocks after serialization or pixel rendering, including failure paths. Do not wrap an asynchronous operation in a synchronous `tf.tidy()` and assume it owns tensors created after an await. Add a repeated-upscale check that verifies `tf.memory().numTensors` returns to a stable baseline. This ownership defect was verified from source; GPU memory growth was not profiled during this audit. [TensorFlow.js memory management](https://www.tensorflow.org/js/guide/platform_environment#memory_management).

### P2 — AI models initialize when AI upscaling is unused

`Upscaler.ts:8` constructs UpscalerJS at module evaluation, and its constructor starts loading the model. `Storage.ts:2` imports `ScreenshotHandler`, which imports `Upscaler`, so settings consumers bring that initialization into multiple extension contexts. Selecting Canvas/None or turning Paddle GPU off does not prevent this separate initialization.

**Recommendation:** lazily initialize the AI model on the first AI-upscale request, share its promise in the owning inference context, and keep settings enums/types independent of the screenshot/upscaler runtime. The current GPU checkbox controls Paddle inference; it is not a global prohibition on GPU use by TensorFlow or the browser compositor.

## Reporting and policy gaps

`accelerated` at `PaddleOnnxRuntime.ts:178` means that a non-WASM provider was requested. It does not mean a hardware adapter was obtained, all expensive nodes ran there, or the session remained healthy. A WebGPU adapter may be software-emulated; browser settings and driver blocklists can make adapter creation fail. The application currently exposes no actual provider or fallback reason to the user. [Chrome troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips).

After a runtime fallback, `forceWasmOnly` persists through `terminate()` and reapplying `setGpuEnabled(true)`, because the latter returns immediately when the preference is already true. The static Paddle runtime consequently stays on CPU when users switch away from Paddle and back. Off→on resets the flag, but does not by itself repair ORT's cached lost device. A sticky circuit breaker can be reasonable; it needs an observable state and deliberate context-level retry policy.

Record requested preference separately from active execution status: hardware WebGPU, software adapter, WebNN with verified supported computation, or WASM. Include the fallback cause, session/runtime generation, and optional local adapter information in debug snapshots. A small UI status can make a persistent CPU fallback visible without adding telemetry or exposing internal logs in the normal OCR flow. ONNX Runtime supports profiling to establish which work actually runs on the GPU. [Performance diagnostics](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html).

The existing no-WASM-fallback build flag controls Namida's provider retry list. It does not disable ORT's internal CPU node placement, and therefore is not a hardware-acceleration assertion. The normal recognizer already logs that some nodes use CPU. Shape and control operations on CPU can be intentional and efficient; forcing every node onto GPU is not the objective.

## What is already correct

- Webpack resolves the current plain `onnxruntime-web` import to **1.24.3's `ort.bundle.min.mjs`**, which registers JSEP WebGPU and WebNN. The bundled `.jsep.mjs` and `.jsep.wasm` files match it. Blindly changing the import to `/webgpu` based on generic documentation would select a different implementation and require different runtime assets.
- GPU preference defaults to enabled and is correctly carried through the normal sequential background/offscreen route. Chrome and Edge share that offscreen path; Firefox uses a background document.
- GPU-off, missing-API and null-adapter paths use local WASM successfully in the live probes. Local model/runtime URLs preserve offline execution.
- Sessions are reused, actual in-flight work is tracked, and late session completion is cleaned up. These ownership measures are useful; the missing part is safe recovery of the shared runtime after a hang.
- CPU preprocessing, detector geometry and CTC require CPU-readable inputs/outputs. Those tensors do not imply that neural inference is running on CPU. Dynamic image shapes also make unconditional graph capture inappropriate.
- Tesseract uses CPU/WASM with optional SIMD. AI upscaling independently uses TensorFlow's WebGL/CPU selection. They should not be described as Paddle WebGPU workloads.

## Browser expectations

Support depends on OS, driver, browser policy and adapter availability. Windows Chrome/Edge and supported Firefox configurations can use WebGPU; version alone is insufficient. Current Firefox documentation enables WebGPU on Windows and Apple Silicon macOS, with Linux/Intel macOS still subject to its Nightly/platform restrictions. Its service-worker restriction does not directly apply to Namida's Firefox background-document path. [Mozilla status](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features#webgpu_api), [GPUWeb implementation matrix](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status).

Do not promise a dedicated NVIDIA/AMD GPU: integrated graphics is still hardware GPU execution. Chrome's Windows adapter selection can ignore `powerPreference`, and both preferences returned the same device in this audit. A high-performance hint is an optional policy choice, not a guarantee or a substitute for measuring the selected adapter. [Chrome's Windows limitations](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips#windows-specific_limitations).

## Recommended implementation order and acceptance

1. Isolate and recreate failed ORT runtimes; cover device loss, a truly unfinished run, strict timeout, and successful CPU retry without `Session already started`.
2. Make settings/backend ownership atomic and verify concurrent requests with opposing preferences.
3. Remove or complete the WebNN path; add honest per-model execution/fallback diagnostics and a controlled retry action.
4. Make AI upscaling lazy and fix tensor disposal; measure repeated-use allocation stability.
5. Add hardware-aware integration checks that distinguish a real adapter, a software adapter, and no adapter. Keep a CPU-only CI lane; do not count successful fallback OCR as proof of GPU coverage.

For an implementation change, rerun the 30 fixed-input OCR cases and both shipped model pairs using the reference implementation evidence, then exercise actual snipping. GPU/CPU numeric differences should be recorded per case. This audit changed no production inference code, model assets, package configuration or benchmark labels, so it did not rerun the full accuracy benchmark.

## Reproduction files

[Probe and reproduction instructions](browser-gpu-audit/README.md) accompany the retained observations. Five extension probes and five adapter probes completed. Their green status means observations were successfully collected; the deliberately destroyed-device scenario records a **product failure**. Ten existing runtime tests and four additional source/ORT-guard reproductions passed; the latter assert problematic current behavior, not desired recovery. The settings-race script includes its sequential control.

No browser safety flags were enabled, no personal browser profile was opened, and no production code was changed. Firefox execution, mobile devices, other physical GPUs, WebNN dispatch, and memory-pressure-induced driver resets remain unverified. Deliberate `GPUDevice.destroy()` is a deterministic loss probe; it is not a measurement of how frequently real drivers fail.
