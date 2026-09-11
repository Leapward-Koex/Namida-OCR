// From the repository root in PowerShell:
// & 'C:\Program Files\nodejs\node.exe' .\.tmp\gpu-audit\settings-race-repro.mjs
// An optional first argument selects the JSON output path. No production code is modified.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, 'src/background/ocr/OcrService.ts'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('Run this script from inside the Namida repository.');
    root = parent;
}

const paths = {
    service: 'src/background/ocr/OcrService.ts',
    selectable: 'src/background/ocr/RuntimeSelectableOcrBackend.ts',
};
const sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => {
    const source = readFileSync(join(root, path), 'utf8');
    return [key, {
        path,
        sha256: createHash('sha256').update(source).digest('hex'),
        compiled: ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
    }];
}));

function evaluate(compiled, dependencies) {
    const context = vm.createContext({
        exports: {},
        require(name) {
            if (name in dependencies) return dependencies[name];
            throw new Error(`Unexpected source dependency: ${name}`);
        },
    });
    vm.runInContext(compiled, context);
    return context.exports;
}

function harness() {
    const events = [];
    let creations = 0;
    class MockBackend {
        constructor() {
            this.id = ++creations;
            this.gpuEnabled = null;
            events.push({ event: 'create', backendId: this.id });
        }
        async init() {}
        async setDebugEnabled() {}
        async setGpuEnabled(enabled) {
            this.gpuEnabled = enabled;
            events.push({ event: 'setGpuEnabled', backendId: this.id, enabled });
        }
        async recognize(request) {
            events.push({ event: 'recognize', request, backendId: this.id, gpuEnabled: this.gpuEnabled });
            return String(this.gpuEnabled);
        }
        async terminate() { events.push({ event: 'terminate', backendId: this.id }); }
    }
    const selectable = evaluate(sources.selectable.compiled, {
        '../../interfaces/Storage': {
            DEFAULT_OCR_BACKEND: 'tesseract',
            Settings: {
                async getOcrBackend() { return 'paddleonnx'; },
                async getPaddleOnnxGpuEnabled() { return true; },
            },
        },
        './PaddleOnnxOcrBackend': { PaddleOnnxOcrBackend: MockBackend },
        './TesseractOcrBackend': { TesseractOcrBackend: MockBackend },
    });
    const { OcrService } = evaluate(sources.service.compiled, { 'namida-ocr-backend': selectable });
    return { OcrService, events, get creations() { return creations; } };
}

async function runScenario(requests, concurrent) {
    const h = harness();
    const recognize = ({ request, gpuEnabled }) => h.OcrService.recognize(request, '3', 'jpn_vert', {
        backend: 'paddleonnx', paddleGpuEnabled: gpuEnabled,
    });
    const outputs = concurrent
        ? await Promise.all(requests.map(recognize))
        : [await recognize(requests[0]), await recognize(requests[1])];
    return { concurrent, requests, outputs, backendCreations: h.creations, events: h.events };
}

const differentSettings = [
    { request: 'GPU disabled request', gpuEnabled: false },
    { request: 'GPU enabled request', gpuEnabled: true },
];
const sequentialControl = await runScenario(differentSettings, false);
const concurrentDifferentSettings = await runScenario(differentSettings, true);
const concurrentSameSettings = await runScenario([
    { request: 'first GPU disabled request', gpuEnabled: false },
    { request: 'second GPU disabled request', gpuEnabled: false },
], true);
const result = {
    schemaVersion: 1,
    description: 'Actual OcrService and RuntimeSelectable sources; only storage and leaf OCR backends mocked. No model execution or timing sleeps.',
    nodeVersion: process.version,
    sources: Object.values(sources).map(({ path, sha256 }) => ({ path, sha256 })),
    sequentialControl,
    concurrentDifferentSettings,
    concurrentSameSettings,
    settingsRaceReproduced: concurrentDifferentSettings.outputs[0] === 'true',
    duplicateCreationReproduced: concurrentSameSettings.backendCreations === 2,
};
const output = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL('./settings-race-result.json', import.meta.url));
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output, ...result }, null, 2));
assert.deepEqual(sequentialControl.outputs, ['false', 'true'], 'Sequential control must preserve both settings');
assert.deepEqual(concurrentDifferentSettings.outputs, ['true', 'true'], 'Expected the concurrent settings race to reproduce');
assert.equal(concurrentSameSettings.backendCreations, 2, 'Expected duplicate creation for concurrent identical settings');
