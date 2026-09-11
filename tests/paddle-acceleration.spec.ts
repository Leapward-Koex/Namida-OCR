import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page, TestInfo, Worker } from '@playwright/test';
import { expect, test } from './extension.fixtures';
import { NamidaMessageAction } from '../src/interfaces/message';
import type { PaddleAccelerationStatus } from '../src/background/ocr/PaddleWorkerProtocol';

const PROBE_STATUS = 9910;
const PROBE_COMMAND = 9911;
const requireWebGpu = process.env.NAMIDA_TEST_REQUIRE_WEBGPU === '1';
const expectStrictGpu = process.env.NAMIDA_TEST_EXPECT_STRICT_GPU === '1';
type Fault = 'healthy' | 'api-unavailable' | 'adapter-unavailable' | 'software-adapter' | 'init-timeout';
type Fixtures = { context: BrowserContext; page: Page; serviceWorker: Worker; extensionId: string };
type Probe = Awaited<ReturnType<typeof prepareProbe>>;

test.describe('Paddle acceleration and recovery', () => {
    test.skip(process.env.NAMIDA_TEST_OCR_BACKEND === 'scribejs', 'The Scribe-only build has no runtime Paddle selector.');
    test.skip(expectStrictGpu, 'The strict build has a dedicated test that forbids CPU retry.');
    test.setTimeout(180_000);

    test('GPU off uses CPU without requesting an adapter; popup status is lazy', async ({ context, page, serviceWorker, extensionId }, testInfo) => {
        const fixtures = { context, page, serviceWorker, extensionId };
        await withProbe(fixtures, testInfo, 'healthy', async (probe) => {
            await probe.setGpu(false);
            await expect(fixtures.page.locator('#paddle-gpu-status')).toContainText('next scan');
            expect(await probe.status()).toBeNull();
            expect(await fixtures.serviceWorker.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
            await probe.scan();
            const status = await probe.status();
            expect(status?.provider).toBe('wasm');
            expect(status?.requestedGpu).toBe(false);
            expect(status?.fallbackReason).toBeUndefined();
            expect((await probe.observations()).workers.every((worker: any) => worker.state?.adapterRequests === 0)).toBe(true);
            await fixtures.page.reload();
            await expect(fixtures.page.locator('#paddle-gpu-status')).toContainText('Using CPU (WASM)');
            await expect(fixtures.page.locator('#retry-paddle-gpu')).toBeHidden();
        });
    });

    test('GPU on performs real compute and switching off replaces it with CPU', async ({ context, page, serviceWorker, extensionId }, testInfo) => {
        const fixtures = { context, page, serviceWorker, extensionId };
        await withProbe(fixtures, testInfo, 'healthy', async (probe) => {
            await probe.scan();
            const before = await requireHardware(probe);
            await fixtures.page.reload();
            await expect(fixtures.page.locator('#paddle-gpu-status')).toContainText('GPU (WebGPU) is working');
            await fixtures.page.locator('#paddle-gpu-details summary').click();
            const detail = fixtures.page.locator('#paddle-gpu-detail-text');
            await expect(detail).toBeVisible();
            await expect(detail).toContainText('WebGPU sessions may still use the CPU for some operations.');
            const adapterFields = before.adapter && [before.adapter.description, before.adapter.vendor, before.adapter.architecture, before.adapter.device].filter(Boolean);
            if (adapterFields?.length) {
                await expect(detail).toContainText('Browser adapter:');
                for (const field of adapterFields) await expect(detail).toContainText(field!);
            }
            await capturePopupDetails(fixtures.page, testInfo, 'popup-healthy-gpu.png');
            const priorAdapterRequests = total(await probe.observations(), 'adapterRequests');
            await probe.setGpu(false);
            await probe.scan();
            const after = await probe.status();
            expect(after?.provider).toBe('wasm');
            expect(after!.generation).toBeGreaterThan(before.generation);
            expect(total(await probe.observations(), 'adapterRequests')).toBe(priorAdapterRequests);
        });
    });

    for (const [fault, reason] of [
        ['api-unavailable', /WebGPU is unavailable/i],
        ['adapter-unavailable', /did not provide.*adapter/i],
        ['software-adapter', /software WebGPU adapter/i],
    ] as const) {
        test(`${fault} falls back once and explicitly retries a fresh worker`, async ({ context, page, serviceWorker, extensionId }, testInfo) => {
        const fixtures = { context, page, serviceWorker, extensionId };
            await withProbe(fixtures, testInfo, fault, async (probe) => {
                await probe.scan();
                const first = await probe.status();
                expect(first?.provider).toBe('wasm');
                expect(first?.fallbackReason).toMatch(reason);
                const count = (await probe.observations()).workers.length;
                await probe.scan();
                expect((await probe.observations()).workers).toHaveLength(count);
                expect((await probe.status())?.generation).toBe(first?.generation);
                await fixtures.page.reload();
                await expect(fixtures.page.locator('#paddle-gpu-status')).toContainText('Using CPU (WASM)');
                await expect(fixtures.page.locator('#retry-paddle-gpu')).toBeVisible();
                if (fault === 'adapter-unavailable') {
                    await fixtures.page.locator('#paddle-gpu-details summary').click();
                    const detail = fixtures.page.locator('#paddle-gpu-detail-text');
                    await expect(detail).toBeVisible();
                    await expect(detail).toContainText(first!.fallbackReason!);
                    await expect(detail).toContainText(reason);
                    await capturePopupDetails(fixtures.page, testInfo, 'popup-no-adapter.png');
                }
                await fixtures.page.locator('#retry-paddle-gpu').click();
                await expect(fixtures.page.locator('#retry-paddle-gpu')).toBeEnabled();
                const retried = await probe.status();
                expect(retried?.provider).toBe('wasm');
                expect(retried?.fallbackReason).toMatch(reason);
                expect(retried!.generation).toBeGreaterThan(first!.generation);
                await probe.scan();
                expect((await probe.observations()).workers.some((worker: any) => worker.terminated)).toBe(true);
            });
        });
    }

    test('initialization timeout terminates its worker and recovers on CPU', async ({ context, page, serviceWorker, extensionId }, testInfo) => {
        const fixtures = { context, page, serviceWorker, extensionId };
        await withProbe(fixtures, testInfo, 'init-timeout', async (probe) => {
            await probe.scan();
            const status = await probe.status();
            expect(status?.provider).toBe('wasm');
            expect(status?.fallbackReason).toMatch(/Timed out initializing ONNX webgpu worker/i);
            const observations = await probe.observations();
            expect(observations.droppedInitializations).toBe(1);
            expect(observations.workers[0].terminated).toBe(true);
            const generation = status?.generation;
            await probe.scan();
            expect((await probe.status())?.generation).toBe(generation);
        });
    });

    test('a lost GPU device recovers on CPU and an explicit retry restores GPU', async ({ context, page, serviceWorker, extensionId }, testInfo) => {
        const fixtures = { context, page, serviceWorker, extensionId };
        await withProbe(fixtures, testInfo, 'healthy', async (probe) => {
            await probe.scan();
            const before = await requireHardware(probe);
            const destroyed = await probe.command('destroy-device');
            expect(destroyed.destroyed).toBeGreaterThan(0);
            await expect.poll(async () => (await probe.status())?.fallbackReason).toMatch(/device lost/i);
            await probe.scan();
            expect((await probe.status())?.provider).toBe('wasm');
            expect((await probe.status())!.generation).toBeGreaterThan(before.generation);
            await probe.command('set-fault', 'healthy');
            await fixtures.page.reload();
            await fixtures.page.locator('#retry-paddle-gpu').click();
            await expect(fixtures.page.locator('#retry-paddle-gpu')).toBeHidden();
            await probe.scan();
            await requireHardware(probe);
        });
    });

    test('device loss during an unfinished GPU run retires the worker and recovers on CPU', async ({ context, page, serviceWorker, extensionId }, testInfo) => {
        const fixtures = { context, page, serviceWorker, extensionId };
        await withProbe(fixtures, testInfo, 'healthy', async (probe) => {
            await probe.scan();
            const before = await requireHardware(probe);
            const armed = await probe.command('destroy-on-next-submit');
            expect(armed.error).toBeUndefined();
            await probe.scan();
            const status = await probe.status();
            expect(status?.provider).toBe('wasm');
            expect(status?.fallbackReason).toMatch(/device lost|ONNX inference failed|ONNX worker failed/i);
            expect(status!.generation).toBeGreaterThan(before.generation);
            const observations = await probe.observations();
            const interrupted = observations.workers.find((worker: any) => worker.state?.destroyedDuringRun === 1);
            expect(interrupted, JSON.stringify(observations)).toBeDefined();
            expect(interrupted.terminated).toBe(true);
            expect(interrupted.state.destroyedWithPendingRunIds.length).toBeGreaterThan(0);
            expect(JSON.stringify({ observations, scans: probe.scans, logs: probe.logs })).not.toMatch(/Session already started/i);
            const generation = status?.generation;
            await probe.scan();
            expect((await probe.status())?.generation).toBe(generation);
        });
    });

    test('a dropped real GPU run reply times out and retires the worker before CPU recovery', async ({ context, page, serviceWorker, extensionId }, testInfo) => {
        const fixtures = { context, page, serviceWorker, extensionId };
        await withProbe(fixtures, testInfo, 'healthy', async (probe) => {
            await probe.scan();
            await requireHardware(probe);
            await probe.command('drop-next-result');
            await probe.scan();
            const status = await probe.status();
            expect(status?.provider).toBe('wasm');
            expect(status?.fallbackReason).toMatch(/Timed out running ONNX webgpu worker/i);
            const observations = await probe.observations();
            expect(total(observations, 'droppedResults')).toBe(1);
            expect(observations.workers.find((worker: any) => worker.state?.droppedResults === 1)?.terminated).toBe(true);
            const generation = status?.generation;
            await probe.scan();
            expect((await probe.status())?.generation).toBe(generation);
        });
    });
});

test.describe('Paddle strict GPU execution', () => {
    test.skip(!expectStrictGpu, 'Set NAMIDA_TEST_EXPECT_STRICT_GPU=1 with the no-CPU-fallback build.');
    test.skip(process.env.NAMIDA_TEST_OCR_BACKEND === 'scribejs', 'The Scribe-only build has no runtime Paddle selector.');
    test.setTimeout(180_000);

    test('strict GPU timeout rejects, terminates its worker, and the next scan starts fresh GPU without CPU retry', async ({ context, page, serviceWorker, extensionId }, testInfo) => {
        const fixtures = { context, page, serviceWorker, extensionId };
        await withProbe(fixtures, testInfo, 'healthy', async (probe) => {
            await probe.scan();
            const before = await requireHardware(probe);
            expect(before.wasmFallbackDisabled).toBe(true);
            const priorWorkers = (await probe.observations()).workers;
            expect(priorWorkers).toHaveLength(1);
            expect(priorWorkers[0].provider).toBe('webgpu');

            const command = await probe.command('drop-next-result');
            expect(command.error).toBeUndefined();
            await probe.scan(/Timed out running ONNX webgpu worker after 15000 ms/i);
            const failed = await probe.status();
            expect(failed?.state).toBe('failed');
            expect(failed?.provider).toBeNull();
            expect(failed?.lastError).toMatch(/Timed out running ONNX webgpu worker after 15000 ms/i);
            expect(failed?.fallbackReason).toBeUndefined();
            expect(probe.scans[1].elapsedMs).toBeGreaterThanOrEqual(14_500);
            const afterFailure = await probe.observations();
            expect(total(afterFailure, 'droppedResults')).toBe(1);
            expect(afterFailure.workers).toHaveLength(priorWorkers.length);
            expect(afterFailure.workers[0].terminated).toBe(true);
            expect(afterFailure.workers.every((worker: any) => worker.provider === 'webgpu')).toBe(true);

            // No explicit retry action: an ordinary subsequent OCR request must
            // construct a new GPU worker while the strict build still forbids CPU.
            await probe.scan();
            const restored = await requireHardware(probe);
            expect(restored.generation).toBeGreaterThan(before.generation);
            expect(restored.wasmFallbackDisabled).toBe(true);
            expect(restored.fallbackReason).toBeUndefined();
            expect(restored.lastError).toBeUndefined();
            const observations = await probe.observations();
            expect(observations.workers).toHaveLength(priorWorkers.length + 1);
            expect(observations.workers.every((worker: any) => worker.provider === 'webgpu')).toBe(true);
            const fresh = observations.workers.at(-1);
            expect(fresh.terminated).toBe(false);
            expect(fresh.state?.adapterRequests).toBeGreaterThan(0);
            expect(fresh.state?.dispatches).toBeGreaterThan(0);
            expect(fresh.state?.submits).toBeGreaterThan(0);
            expect(fresh.state?.hookErrors).toEqual([]);
        });
    });
});

async function capturePopupDetails(page: Page, testInfo: TestInfo, name: string) {
    const panel = page.locator('.section').filter({ has: page.locator('#ocr-backend') });
    const body = await panel.screenshot({ path: testInfo.outputPath(name) });
    await testInfo.attach(name, { body, contentType: 'image/png' });
}

async function requireHardware(probe: Probe): Promise<PaddleAccelerationStatus> {
    const status = await probe.status();
    // CI without a hardware adapter can exercise deterministic fallback tests;
    // acceptance runs set NAMIDA_TEST_REQUIRE_WEBGPU=1 to make GPU failure fatal.
    test.skip(!requireWebGpu && !expectStrictGpu && status?.provider !== 'webgpu', `Hardware WebGPU unavailable: ${status?.fallbackReason ?? status?.lastError}`);
    expect(status?.provider, JSON.stringify(status)).toBe('webgpu');
    expect(status!.successfulInferences).toBeGreaterThan(0);
    const observations = await probe.observations();
    expect(total(observations, 'dispatches'), JSON.stringify(observations)).toBeGreaterThan(0);
    expect(total(observations, 'submits')).toBeGreaterThan(0);
    return status!;
}

function total(observations: any, field: string): number {
    return observations.workers.reduce((sum: number, worker: any) => sum + (worker.state?.[field] ?? 0), 0);
}

async function withProbe(fixtures: Fixtures, testInfo: TestInfo, fault: Fault, run: (probe: Probe) => Promise<void>) {
    const probe = await prepareProbe(fixtures, testInfo, fault);
    try {
        await run(probe);
    } finally {
        const observations = await probe.observations().catch((error) => ({ error: String(error) }));
        const status = await probe.status().catch((error) => ({ error: String(error) }));
        const evidence = { test: testInfo.title, requireWebGpu, expectStrictGpu, fault, status, scans: probe.scans, observations, logs: probe.logs };
        const body = JSON.stringify(evidence, null, 2);
        await testInfo.attach('paddle-acceleration.json', { body, contentType: 'application/json' });
        const directory = path.resolve('.tmp/gpu-fixes');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, `${testInfo.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`), body);
    }
}

async function prepareProbe({ context, page, serviceWorker, extensionId }: Fixtures, testInfo: TestInfo, fault: Fault) {
    const logs: unknown[] = [];
    context.on('console', (message) => { if (logs.length < 300) logs.push({ type: message.type(), text: message.text(), location: message.location() }); });
    context.on('weberror', (event) => { logs.push({ type: 'weberror', message: event.error().message, stack: event.error().stack }); });
    page.on('pageerror', (error) => { logs.push({ type: 'pageerror', message: error.message, stack: error.stack }); });
    const copy = testInfo.outputPath('extension-under-test');
    const hostPath = path.join(copy, 'offscreen/index.js');
    const workerPath = path.join(copy, 'paddle-worker/index.js');
    // Only the per-test extension copy receives fault controls. Neither dist nor
    // production sources contain these message actions or instrumentation.
    await fs.writeFile(hostPath, `(${installHostProbe.toString()})(${JSON.stringify(fault)});\n${await fs.readFile(hostPath, 'utf8')}`);
    await fs.writeFile(workerPath, `(${installWorkerProbe.toString()})();\n${await fs.readFile(workerPath, 'utf8')}`);
    await serviceWorker.evaluate(async () => {
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set({ OcrBackend: 'paddleonnx', PaddleOnnxGpuEnabled: true, OcrDebugArtifacts: true, FuriganaType: 'none' });
    });
    await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    await expect(page.locator('#paddle-settings')).toBeVisible();
    const image = `data:image/png;base64,${(await fs.readFile('tests/fixtures/images/ocr-general-002.png')).toString('base64')}`;
    const scans: Array<{ text?: string; error?: string; elapsedMs: number; status: PaddleAccelerationStatus | null }> = [];
    const status = () => page.evaluate((action) => chrome.runtime.sendMessage({ action }), NamidaMessageAction.GetOcrAccelerationStatus) as Promise<PaddleAccelerationStatus | null>;
    return {
        scans, status, logs,
        observations: () => page.evaluate((action) => chrome.runtime.sendMessage({ action }), PROBE_STATUS),
        command: (command: string, fault?: Fault) => page.evaluate((message) => chrome.runtime.sendMessage(message), { action: PROBE_COMMAND, command, fault }),
        async setGpu(enabled: boolean) {
            await page.locator('#enable-paddle-gpu').setChecked(enabled);
            await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.sync.get('PaddleOnnxGpuEnabled')).PaddleOnnxGpuEnabled)).toBe(enabled);
        },
        async scan(expectedError?: RegExp) {
            const started = Date.now();
            const response = await page.evaluate(async ({ action, data }) => {
                try {
                    const value = await chrome.runtime.sendMessage({ action, data });
                    // Production listeners use webextension-polyfill, which sends
                    // a rejection envelope to this native chrome.* test caller.
                    return typeof value === 'string' ? { text: value } : {
                        error: value?.__mozWebExtensionPolyfillReject__ === true && typeof value.message === 'string'
                            ? value.message : 'Non-string OCR result', value,
                    };
                }
                catch (error) { return { error: String(error) }; }
            }, { action: NamidaMessageAction.RecognizeImage, data: image });
            const current = await status();
            scans.push({ ...response, elapsedMs: Date.now() - started, status: current });
            if (expectStrictGpu) expect(current?.wasmFallbackDisabled, JSON.stringify(current)).toBe(true);
            else test.skip(Boolean(current?.wasmFallbackDisabled), 'Recovery tests require the normal build with CPU fallback enabled.');
            if (expectedError) {
                expect(response.error, JSON.stringify({ response, status: current })).toMatch(expectedError);
                expect(response.text).toBeUndefined();
                return response.error!;
            }
            expect(response.error, JSON.stringify({ response, status: current })).toBeUndefined();
            expect(response.text?.replace(/\s+/g, '')).toBe('日本語OCRTest2026');
            return response.text!;
        },
    };
}

// Runs only in the copied offscreen document. Keep configuration here so a retry
// starts a new worker with the current fault, without relying on old worker state.
function installHostProbe(initialFault: Fault) {
    const NativeWorker = globalThis.Worker;
    const workers: any[] = [];
    let fault = initialFault;
    let droppedInitializations = 0;
    let nextControlId = 0;
    const pending = new Map<number, (value: any) => void>();
    const wrapWorker = function (url: string | URL, options?: WorkerOptions) {
        const worker = new NativeWorker(url, options);
        if (!String(url).includes('/paddle-worker/index.js')) return worker;
        const record: any = { id: workers.length + 1, terminated: false, provider: null, state: null, worker };
        workers.push(record);
        const nativePost = worker.postMessage.bind(worker);
        const nativeTerminate = worker.terminate.bind(worker);
        worker.addEventListener('message', (event) => {
            if (!event.data?.__namidaGpuTest) return;
            event.stopImmediatePropagation();
            record.state = event.data.state;
            const resolve = pending.get(event.data.controlId);
            if (resolve) { pending.delete(event.data.controlId); resolve(event.data.result ?? event.data.state); }
        });
        worker.postMessage = ((message: any, ...args: any[]) => {
            if (message?.type === 'init') {
                record.provider = message.provider;
                if (fault === 'init-timeout' && message.provider === 'webgpu' && droppedInitializations === 0) {
                    droppedInitializations++;
                    return;
                }
            }
            return (nativePost as any)(message, ...args);
        }) as typeof worker.postMessage;
        worker.terminate = () => { record.terminated = true; nativeTerminate(); };
        nativePost({ __namidaGpuTest: true, command: 'configure', fault });
        return worker;
    };
    wrapWorker.prototype = NativeWorker.prototype;
    Object.setPrototypeOf(wrapWorker, NativeWorker);
    globalThis.Worker = wrapWorker as unknown as typeof globalThis.Worker;
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
        if (message.action === 9910) {
            respond({ fault, droppedInitializations, workers: workers.map(({ worker, ...record }) => record) });
        } else if (message.action === 9911) {
            if (message.command === 'set-fault') { fault = message.fault; respond({ fault }); return; }
            const target = [...workers].reverse().find((record) => !record.terminated);
            if (!target) { respond({ error: 'No active test worker' }); return; }
            const controlId = ++nextControlId;
            const timeout = setTimeout(() => { pending.delete(controlId); respond({ error: 'Probe command timed out' }); }, 3000);
            pending.set(controlId, (result) => { clearTimeout(timeout); respond(result); });
            target.worker.postMessage({ __namidaGpuTest: true, command: message.command, controlId });
            return true;
        }
    });
}

// Runs in the copied ONNX worker. Real model/session/run code remains untouched;
// only browser capabilities, GPUDevice destruction, and one reply are controlled.
function installWorkerProbe() {
    const scope: any = globalThis;
    const nativePost = scope.postMessage.bind(scope);
    const devices: any[] = [];
    const state: any = { adapterRequests: 0, devices: 0, submits: 0, dispatches: 0, droppedResults: 0, destroyedDuringRun: 0, activeRunIds: [], destroyedWithPendingRunIds: [], lost: [], hookErrors: [] };
    let dropNextResult = false;
    let destroyOnNextSubmit = false;
    const publish = (controlId?: number, result?: any) => nativePost({ __namidaGpuTest: true, state, controlId, result });
    scope.postMessage = (message: any, transfer?: any) => {
        if (message?.type === 'result' || message?.type === 'error') {
            state.activeRunIds = state.activeRunIds.filter((id: number) => id !== message.id);
        }
        if (message?.type === 'result' && dropNextResult) {
            dropNextResult = false;
            state.droppedResults++;
            publish();
            return;
        }
        nativePost(message, transfer ?? []);
        publish();
    };
    scope.addEventListener('message', (event: MessageEvent) => {
        if (!event.data?.__namidaGpuTest) {
            if (event.data?.type === 'run') state.activeRunIds.push(event.data.id);
            return;
        }
        event.stopImmediatePropagation();
        const command = event.data.command;
        if (command === 'configure') {
            try {
                const fault = event.data.fault;
                if (fault === 'api-unavailable') {
                    Object.defineProperty(navigator, 'gpu', { value: undefined });
                } else if (fault === 'adapter-unavailable' || fault === 'software-adapter') {
                    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => {
                        state.adapterRequests++;
                        return fault === 'adapter-unavailable' ? null : { isFallbackAdapter: true, info: { description: 'SwiftShader test software adapter' } };
                    } } });
                } else if ((navigator as any).gpu) {
                    const gpu = (navigator as any).gpu;
                    const requestAdapter = gpu.requestAdapter.bind(gpu);
                    Object.defineProperty(gpu, 'requestAdapter', { value: async (options: any) => {
                        state.adapterRequests++;
                        const adapter = await requestAdapter(options);
                        if (!adapter) return adapter;
                        const requestDevice = adapter.requestDevice.bind(adapter);
                        Object.defineProperty(adapter, 'requestDevice', { value: async (descriptor: any) => {
                            const device = await requestDevice(descriptor);
                            devices.push(device);
                            state.devices++;
                            const submit = device.queue.submit.bind(device.queue);
                            Object.defineProperty(device.queue, 'submit', { value: (commands: any) => {
                                state.submits++;
                                const result = submit(commands);
                                if (destroyOnNextSubmit) {
                                    destroyOnNextSubmit = false;
                                    state.destroyedDuringRun++;
                                    state.destroyedWithPendingRunIds = [...state.activeRunIds];
                                    device.destroy();
                                    publish();
                                }
                                return result;
                            } });
                            device.lost.then((reason: any) => { state.lost.push({ reason: reason.reason, message: reason.message }); publish(); });
                            return device;
                        } });
                        return adapter;
                    } });
                    if (scope.GPUComputePassEncoder) {
                        for (const key of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
                            const original = scope.GPUComputePassEncoder.prototype[key];
                            scope.GPUComputePassEncoder.prototype[key] = function (...args: any[]) { state.dispatches++; return original.apply(this, args); };
                        }
                    }
                }
            } catch (error) { state.hookErrors.push(String(error)); }
        }
        if (command === 'drop-next-result') dropNextResult = true;
        if (command === 'destroy-on-next-submit') destroyOnNextSubmit = true;
        if (command === 'destroy-device') {
            for (const device of devices) device.destroy();
            publish(event.data.controlId, { destroyed: devices.length });
        } else publish(event.data.controlId);
    });
}
