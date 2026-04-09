import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const DEFAULT_OCR_MODEL = 'jpn_vert';
const DEFAULT_OCR_BACKEND = 'tesseract';
const MIN_PLAYWRIGHT_WORKERS = 5;
const baseResultsDir = path.resolve(process.cwd(), 'test-results');
const {
    backend,
    disablePaddleOnnxWasmFallback,
    headed,
    model,
    paddleOnnxModelVariant,
    resultsDir,
    playwrightWorkers,
} = parseArgs(args);
const defaultPlaywrightWorkers = backend === 'paddleonnx' ? String(MIN_PLAYWRIGHT_WORKERS) : '';
const rootCaseResultsDir = path.join(baseResultsDir, 'ocr-case-results');
const rootSummaryPath = path.join(baseResultsDir, 'ocr-accuracy-summary.json');
const rootCombinedResultsPath = path.join(baseResultsDir, 'ocr-case-results.json');

const buildArgs = [
    './node_modules/webpack-cli/bin/cli.js',
    '--env',
    'browser=chrome',
    '--env',
    `ocr_model=${model}`,
    '--env',
    `ocr_backend=${backend}`,
    '--mode',
    'production',
];

if (disablePaddleOnnxWasmFallback && backend === 'paddleonnx') {
    buildArgs.push('--env', 'paddleonnx_disable_wasm_fallback=true');
}

if (backend === 'paddleonnx') {
    buildArgs.push('--env', `paddleonnx_model_variant=${paddleOnnxModelVariant}`);
}

console.log(
    `Building extension with OCR model '${model}' using backend '${backend}'`
    + (backend === 'paddleonnx' ? ` and Paddle model variant '${paddleOnnxModelVariant}'` : '')
    + (disablePaddleOnnxWasmFallback && backend === 'paddleonnx'
        ? ' with Paddle ONNX WASM fallback disabled'
        : ''),
);
const buildExitCode = await runCommand(process.execPath, buildArgs);

if (buildExitCode !== 0) {
    process.exit(buildExitCode ?? 1);
}

const runArgs = ['./tests/run-playwright-e2e.mjs'];
if (headed) {
    runArgs.push('--headed');
}

const childEnv = playwrightWorkers
    ? {
        ...process.env,
        NAMIDA_TEST_OCR_BACKEND: backend,
        NAMIDA_TEST_OCR_MODEL: model,
        NAMIDA_TEST_PADDLE_ONNX_MODEL_VARIANT: backend === 'paddleonnx' ? paddleOnnxModelVariant : '',
        PLAYWRIGHT_WORKERS: playwrightWorkers,
    }
    : defaultPlaywrightWorkers
        ? {
            ...process.env,
            NAMIDA_TEST_OCR_BACKEND: backend,
            NAMIDA_TEST_OCR_MODEL: model,
            NAMIDA_TEST_PADDLE_ONNX_MODEL_VARIANT: backend === 'paddleonnx' ? paddleOnnxModelVariant : '',
            PLAYWRIGHT_WORKERS: defaultPlaywrightWorkers,
        }
        : {
            ...process.env,
            NAMIDA_TEST_OCR_BACKEND: backend,
            NAMIDA_TEST_OCR_MODEL: model,
            NAMIDA_TEST_PADDLE_ONNX_MODEL_VARIANT: backend === 'paddleonnx' ? paddleOnnxModelVariant : '',
        };

if (playwrightWorkers) {
    console.log(`Using PLAYWRIGHT_WORKERS=${playwrightWorkers}`);
} else if (defaultPlaywrightWorkers) {
    console.log(`Using PLAYWRIGHT_WORKERS=${defaultPlaywrightWorkers} for backend '${backend}'`);
}

const testExitCode = await runCommand(process.execPath, runArgs, childEnv);
await mirrorResults(resultsDir, model, backend, paddleOnnxModelVariant, disablePaddleOnnxWasmFallback);
process.exit(testExitCode ?? 1);

async function mirrorResults(
    targetResultsDir,
    selectedModel,
    selectedBackend,
    selectedPaddleOnnxModelVariant,
    selectedDisablePaddleOnnxWasmFallback,
) {
    if (path.resolve(targetResultsDir) === baseResultsDir) {
        await annotateSummary(
            rootSummaryPath,
            selectedModel,
            selectedBackend,
            selectedPaddleOnnxModelVariant,
            selectedDisablePaddleOnnxWasmFallback,
        );
        return;
    }

    await fs.rm(targetResultsDir, { recursive: true, force: true });
    await fs.mkdir(targetResultsDir, { recursive: true });

    await copyIfPresent(rootCaseResultsDir, path.join(targetResultsDir, 'ocr-case-results'));
    await copyIfPresent(rootCombinedResultsPath, path.join(targetResultsDir, 'ocr-case-results.json'));
    await copyIfPresent(rootSummaryPath, path.join(targetResultsDir, 'ocr-accuracy-summary.json'));
    await annotateSummary(
        path.join(targetResultsDir, 'ocr-accuracy-summary.json'),
        selectedModel,
        selectedBackend,
        selectedPaddleOnnxModelVariant,
        selectedDisablePaddleOnnxWasmFallback,
    );
}

async function annotateSummary(
    summaryPath,
    selectedModel,
    selectedBackend,
    selectedPaddleOnnxModelVariant,
    selectedDisablePaddleOnnxWasmFallback,
) {
    try {
        const summaryBody = await fs.readFile(summaryPath, 'utf8');
        const summary = JSON.parse(summaryBody);
        summary.backend = selectedBackend;
        summary.model = selectedModel;
        summary.paddleOnnxModelVariant = selectedBackend === 'paddleonnx'
            ? selectedPaddleOnnxModelVariant
            : null;
        summary.disablePaddleOnnxWasmFallback = Boolean(selectedDisablePaddleOnnxWasmFallback && selectedBackend === 'paddleonnx');
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    } catch {
        // Leave the run output unchanged if the summary was not produced.
    }
}

async function copyIfPresent(sourcePath, targetPath) {
    try {
        await fs.cp(sourcePath, targetPath, { recursive: true });
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return;
        }

        throw error;
    }
}

function parseArgs(commandArgs) {
    let backend = normalizeBackend(process.env.NAMIDA_OCR_BACKEND?.trim() || DEFAULT_OCR_BACKEND);
    let disablePaddleOnnxWasmFallback = normalizeBooleanFlag(process.env.NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK?.trim() || '');
    let headed = false;
    let model = process.env.NAMIDA_OCR_MODEL?.trim() || DEFAULT_OCR_MODEL;
    let paddleOnnxModelVariant = normalizePaddleOnnxModelVariant(
        process.env.NAMIDA_PADDLE_ONNX_MODEL_VARIANT?.trim() || '',
        'server',
    );
    let resultsSubdir = '';
    let playwrightWorkers = normalizeConfiguredWorkers(process.env.PLAYWRIGHT_WORKERS?.trim() || '');

    for (let index = 0; index < commandArgs.length; index += 1) {
        const argument = commandArgs[index];

        if (argument === '--headed') {
            headed = true;
            continue;
        }

        if (argument === '--backend') {
            backend = normalizeBackend(readRequiredValue(commandArgs, index, '--backend'));
            index += 1;
            continue;
        }

        if (argument === '--disable-paddle-wasm-fallback') {
            disablePaddleOnnxWasmFallback = true;
            continue;
        }

        if (argument === '--model') {
            model = readRequiredValue(commandArgs, index, '--model');
            index += 1;
            continue;
        }

        if (argument === '--paddleonnx-model-variant') {
            paddleOnnxModelVariant = normalizePaddleOnnxModelVariant(
                readRequiredValue(commandArgs, index, '--paddleonnx-model-variant'),
                paddleOnnxModelVariant,
            );
            index += 1;
            continue;
        }

        if (argument === '--results-subdir') {
            resultsSubdir = readRequiredValue(commandArgs, index, '--results-subdir');
            index += 1;
            continue;
        }

        if (argument === '--workers') {
            playwrightWorkers = normalizeWorkers(readRequiredValue(commandArgs, index, '--workers'));
            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${argument}`);
    }

    return {
        backend,
        disablePaddleOnnxWasmFallback,
        headed,
        model,
        paddleOnnxModelVariant,
        resultsDir: resolveResultsDir(resultsSubdir),
        playwrightWorkers,
    };
}

function readRequiredValue(commandArgs, index, flagName) {
    const value = commandArgs[index + 1];

    if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${flagName}`);
    }

    return value;
}

function resolveResultsDir(resultsSubdir) {
    if (!resultsSubdir) {
        return baseResultsDir;
    }

    const resolvedResultsDir = path.resolve(baseResultsDir, resultsSubdir);
    const basePrefix = `${baseResultsDir}${path.sep}`;

    if (resolvedResultsDir !== baseResultsDir && !resolvedResultsDir.startsWith(basePrefix)) {
        throw new Error(`Results subdirectory must stay within ${baseResultsDir}`);
    }

    return resolvedResultsDir;
}

function normalizeWorkers(value) {
    const trimmedValue = value.trim();

    if (!/^[1-9]\d*$/.test(trimmedValue)) {
        throw new Error(`Invalid worker count: ${value}`);
    }

    return String(Math.max(MIN_PLAYWRIGHT_WORKERS, Number.parseInt(trimmedValue, 10)));
}

function normalizeConfiguredWorkers(value) {
    if (!value) {
        return '';
    }

    return normalizeWorkers(value);
}

function normalizeBooleanFlag(value) {
    const trimmedValue = value.trim().toLowerCase();
    return trimmedValue === '1'
        || trimmedValue === 'true'
        || trimmedValue === 'yes'
        || trimmedValue === 'on';
}

function normalizeBackend(value) {
    const trimmedValue = value.trim().toLowerCase();

    if (trimmedValue === 'tesseract' || trimmedValue === 'scribejs' || trimmedValue === 'paddleonnx') {
        return trimmedValue;
    }

    throw new Error(`Invalid OCR backend: ${value}`);
}

function normalizePaddleOnnxModelVariant(value, fallbackValue) {
    const trimmedValue = value.trim().toLowerCase();

    if (!trimmedValue) {
        return fallbackValue;
    }

    if (/^[a-z0-9_-]+$/u.test(trimmedValue)) {
        return trimmedValue;
    }

    throw new Error(`Invalid Paddle ONNX model variant: ${value}`);
}

function runCommand(command, commandArgs, env = process.env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, commandArgs, {
            cwd: process.cwd(),
            env,
            stdio: 'inherit',
        });

        child.on('error', reject);
        child.on('exit', (code) => resolve(code));
    });
}
