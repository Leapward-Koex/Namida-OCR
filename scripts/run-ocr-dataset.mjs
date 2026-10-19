import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readOcrCases } from './check-ocr-dataset-compatibility.mjs';

const OUTPUTS = [
    'ocr-case-results', 'ocr-fixture-inputs', 'ocr-debug', '.playwright-artifacts',
    'ocr-accuracy-summary.json', 'ocr-case-results.json', 'ocr-run-metadata.json',
];

export function parseDatasetArgs(args, cwd = process.cwd()) {
    const options = { backend: 'paddleonnx' };
    const names = { '--build-dir': 'buildDir', '--results-subdir': 'resultsSubdir', '--backend': 'backend' };
    for (let index = 0; index < args.length; index += 2) {
        const name = names[args[index]];
        if (!name || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid dataset argument: ${args[index]}`);
        options[name] = args[index + 1];
    }
    if (!['tesseract', 'paddleonnx'].includes(options.backend)) throw new Error('Dataset backend must be tesseract or paddleonnx.');
    if (!options.buildDir || !options.resultsSubdir) throw new Error('--build-dir and --results-subdir are required.');
    const resultsRoot = path.resolve(cwd, 'test-results');
    const resultsDir = path.resolve(resultsRoot, options.resultsSubdir);
    if (!resultsDir.startsWith(`${resultsRoot}${path.sep}`)) throw new Error('Dataset results must be a subdirectory of test-results.');
    const relativeResult = path.relative(resultsRoot, resultsDir).split(path.sep)[0];
    if (OUTPUTS.includes(relativeResult)) throw new Error('Dataset results must not overlap temporary test outputs.');
    return { backend: options.backend, buildDir: path.resolve(cwd, options.buildDir), resultsDir };
}

export async function runOcrDataset(options, { cwd = process.cwd(), env = process.env, execute = runCommand } = {}) {
    const resultsRoot = path.resolve(cwd, 'test-results');
    const summaryPath = path.join(resultsRoot, 'ocr-accuracy-summary.json');
    const configuredCases = readOcrCases(await fs.readFile(path.join(cwd, 'tests', 'ocr-cases.ts'), 'utf8'));
    if (!configuredCases.length) throw new Error('The configured OCR dataset must not be empty.');
    await fs.access(path.join(options.buildDir, 'manifest.json'));
    let buildInfo;
    try {
        buildInfo = JSON.parse(await fs.readFile(path.join(options.buildDir, 'build-info.json'), 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const expectedBuild = { browser: 'chrome', ocrBackend: options.backend, ocrModel: 'jpn_vert', paddleOcrModelVariant: 'server' };
    for (const [field, expected] of Object.entries(expectedBuild)) {
        if (field === 'paddleOcrModelVariant' && options.backend !== 'paddleonnx') continue;
        if (buildInfo?.[field] !== undefined && buildInfo[field] !== expected) {
            throw new Error(`Build ${field} is ${buildInfo[field]}; this dataset run requires ${expected}.`);
        }
    }
    for (const name of OUTPUTS) await fs.rm(path.join(resultsRoot, name), { recursive: true, force: true });
    await fs.rm(options.resultsDir, { recursive: true, force: true });
    await fs.mkdir(options.resultsDir, { recursive: true });
    if (buildInfo) await fs.writeFile(path.join(options.resultsDir, 'build-info.json'), JSON.stringify(buildInfo, null, 2));

    const childEnv = {
        ...env,
        NAMIDA_TEST_BUILD_DIR: options.buildDir,
        NAMIDA_TEST_OCR_BACKEND: options.backend,
        NAMIDA_TEST_OCR_MODEL: 'jpn_vert',
        NAMIDA_TEST_PADDLE_ONNX_MODEL_VARIANT: 'server',
        NAMIDA_TEST_OCR_INPUT_MODE: 'fixture',
        NAMIDA_TEST_PADDLE_GPU_ENABLED: '0',
        NAMIDA_TEST_REQUIRE_WEBGPU: '0',
        PLAYWRIGHT_WORKERS: '5',
    };
    const started = Date.now();
    const errors = [];
    let testExitCode = 1;
    let summaryExitCode = 1;
    try {
        testExitCode = await execute(process.execPath, [
            path.join(cwd, 'node_modules', '@playwright', 'test', 'cli.js'),
            'test', 'tests/extension.spec.ts', '--project', 'chromium-extension', '--workers', '5',
        ], { cwd, env: childEnv });
    } catch (error) {
        errors.push(`Playwright could not run: ${error.message}`);
    } finally {
        // Even a failed spawn must leave case/debug artifacts and run metadata.
        try {
            summaryExitCode = await execute(process.execPath, ['./tests/write-ocr-summary.mjs'], { cwd, env: childEnv });
        } catch (error) {
            errors.push(`Summary could not run: ${error.message}`);
        }
    }
    let summary;
    try {
        summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
    } catch (error) {
        errors.push(`OCR dataset did not produce a readable summary: ${error.message}`);
    }
    const names = new Set();
    if (Array.isArray(summary?.cases)) {
        for (const entry of summary.cases) {
            if (names.has(entry.name)) errors.push(`Duplicate OCR dataset result: ${entry.name}`);
            names.add(entry.name);
        }
    }
    const expectedNames = new Set(configuredCases.map((entry) => entry.name));
    for (const name of expectedNames) if (!names.has(name)) errors.push(`Missing configured OCR case: ${name}`);
    for (const name of names) if (!expectedNames.has(name)) errors.push(`Unexpected OCR case: ${name}`);
    for (const error of errors) console.error(error);
    const exitCode = testExitCode || summaryExitCode || (errors.length ? 1 : 0);
    const run = {
        backend: options.backend,
        model: 'jpn_vert',
        paddleOnnxModelVariant: options.backend === 'paddleonnx' ? 'server' : null,
        inputMode: 'fixture',
        provider: options.backend === 'paddleonnx' ? 'wasm' : null,
        playwrightWorkers: 5,
        buildDir: options.buildDir,
        build: buildInfo ?? null,
        errors,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        testDurationMs: Date.now() - started,
        testExitCode,
        summaryExitCode,
        exitCode,
        status: exitCode === 0 ? 'passed' : 'failed',
    };
    await fs.writeFile(path.join(resultsRoot, 'ocr-run-metadata.json'), JSON.stringify(run, null, 2));
    if (summary) {
        Object.assign(summary, { backend: run.backend, model: run.model, paddleOnnxModelVariant: run.paddleOnnxModelVariant, run });
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    }
    for (const name of OUTPUTS) {
        try {
            await fs.cp(path.join(resultsRoot, name), path.join(options.resultsDir, name), { recursive: true });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    return exitCode;
}

function runCommand(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        process.exitCode = await runOcrDataset(parseDatasetArgs(process.argv.slice(2)));
    } catch (error) {
        console.error(`OCR dataset failed: ${error.message}`);
        process.exitCode = 1;
    }
}
