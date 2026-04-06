import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const MIN_PLAYWRIGHT_WORKERS = 5;
const { backend, headed, model, comparisonWorkers, startupCheck } = parseArgs(args);
const testResultsDir = path.resolve(process.cwd(), 'test-results');
const comparisonPath = path.join(testResultsDir, 'ocr-backend-comparison.json');
const startupCheckPath = path.join(testResultsDir, 'ocr-backend-startup-check.json');
const backends = backend ? [backend] : ['tesseract', 'scribejs', 'paddleonnx'];
const runs = [];

if (startupCheck) {
    await runStartupChecks();
    process.exit(0);
}

if (comparisonWorkers) {
    console.log(`Running backend comparison with PLAYWRIGHT_WORKERS=${comparisonWorkers}`);
} else {
    console.log('Running backend comparison with Playwright auto worker selection');
}

for (const backend of backends) {
    const runArgs = [
        './run-playwright-e2e.mjs',
        '--backend',
        backend,
        '--model',
        model,
        '--results-subdir',
        path.join('ocr-backend-runs', backend),
    ];

    if (headed) {
        runArgs.push('--headed');
    }

    if (comparisonWorkers) {
        runArgs.push('--workers', comparisonWorkers);
    }

    console.log('');
    console.log(`Comparing OCR backend '${backend}' using model '${model}'`);

    const exitCode = await runCommand(process.execPath, runArgs);
    const summaryPath = path.join(testResultsDir, 'ocr-backend-runs', backend, 'ocr-accuracy-summary.json');
    const summary = await readSummary(summaryPath);

    runs.push({
        backend,
        exitCode: exitCode ?? 1,
        summaryPath,
        summary,
    });
}

const ranking = runs
    .filter((run) => run.exitCode === 0 && run.summary)
    .map((run) => ({
        backend: run.backend,
        model: run.summary.model ?? model,
        totalCases: run.summary.totalCases,
        exactMatches: run.summary.exactMatches,
        exactMatchRate: run.summary.exactMatchRate,
        averageCharacterAccuracy: run.summary.averageCharacterAccuracy,
        summaryPath: run.summaryPath,
    }))
    .sort((left, right) => {
        if (right.averageCharacterAccuracy !== left.averageCharacterAccuracy) {
            return right.averageCharacterAccuracy - left.averageCharacterAccuracy;
        }

        if (right.exactMatchRate !== left.exactMatchRate) {
            return right.exactMatchRate - left.exactMatchRate;
        }

        if (right.exactMatches !== left.exactMatches) {
            return right.exactMatches - left.exactMatches;
        }

        return left.backend.localeCompare(right.backend);
    });

const failedRuns = runs
    .filter((run) => run.exitCode !== 0 || !run.summary)
    .map((run) => ({
        backend: run.backend,
        exitCode: run.exitCode,
        summaryPath: run.summaryPath,
    }));

const tiedBestBackends = ranking.length > 0
    ? ranking
        .filter((result) => hasSameScore(result, ranking[0]))
        .map((result) => result.backend)
    : [];

const comparison = {
    generatedAt: new Date().toISOString(),
    comparedBackends: backends,
    model,
    bestBackend: tiedBestBackends.length === 1 ? tiedBestBackends[0] : null,
    tiedBestBackends,
    ranking,
    failedRuns,
};

await fs.mkdir(testResultsDir, { recursive: true });
await fs.writeFile(comparisonPath, JSON.stringify(comparison, null, 2));

console.log('');
console.log('OCR backend comparison');
console.table(ranking.map((result) => ({
    backend: result.backend,
    model: result.model,
    averageCharacterAccuracy: formatPercent(result.averageCharacterAccuracy),
    exactMatches: `${result.exactMatches}/${result.totalCases}`,
    exactMatchRate: formatPercent(result.exactMatchRate),
})));

if (failedRuns.length > 0) {
    console.log('Failed runs:');
    console.table(failedRuns);
}

if (ranking.length > 0) {
    const winner = ranking[0];
    if (tiedBestBackends.length === 1) {
        console.log(`Best backend: ${winner.backend}`);
    } else {
        console.log(`Best backends (tie): ${tiedBestBackends.join(', ')}`);
    }
    console.log(`Average character accuracy: ${formatPercent(winner.averageCharacterAccuracy)}`);
    console.log(`Exact match rate: ${formatPercent(winner.exactMatchRate)}`);
} else {
    console.log('No backend comparisons completed successfully.');
}

console.log(`Saved comparison: ${comparisonPath}`);

if (ranking.length === 0) {
    process.exit(1);
}

function parseArgs(commandArgs) {
    let backend = '';
    let headed = false;
    let model = process.env.NAMIDA_OCR_MODEL?.trim() || 'jpn_vert';
    let comparisonWorkers = normalizeConfiguredWorkers(process.env.PLAYWRIGHT_WORKERS?.trim() || '');
    let startupCheck = false;

    for (let index = 0; index < commandArgs.length; index += 1) {
        const argument = commandArgs[index];

        if (argument === '--backend') {
            backend = normalizeBackend(readRequiredValue(commandArgs, index, '--backend'));
            index += 1;
            continue;
        }

        if (argument === '--headed') {
            headed = true;
            continue;
        }

        if (argument === '--model') {
            model = readRequiredValue(commandArgs, index, '--model');
            index += 1;
            continue;
        }

        if (argument === '--workers') {
            comparisonWorkers = normalizeWorkers(readRequiredValue(commandArgs, index, '--workers'));
            index += 1;
            continue;
        }

        if (argument === '--startup-check') {
            startupCheck = true;
            continue;
        }

        throw new Error(`Unknown argument: ${argument}`);
    }

    if (startupCheck && !backend) {
        throw new Error('--startup-check requires --backend');
    }

    return {
        backend,
        headed,
        model,
        comparisonWorkers,
        startupCheck,
    };
}

function readRequiredValue(commandArgs, index, flagName) {
    const value = commandArgs[index + 1];

    if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${flagName}`);
    }

    return value;
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

function normalizeBackend(value) {
    const trimmedValue = value.trim().toLowerCase();

    if (trimmedValue === 'tesseract' || trimmedValue === 'scribejs' || trimmedValue === 'paddleonnx') {
        return trimmedValue;
    }

    throw new Error(`Invalid OCR backend: ${value}`);
}

function hasSameScore(left, right) {
    return left.averageCharacterAccuracy === right.averageCharacterAccuracy
        && left.exactMatchRate === right.exactMatchRate
        && left.exactMatches === right.exactMatches
        && left.totalCases === right.totalCases;
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

async function runStartupChecks() {
    const results = [];

    for (const selectedBackend of backends) {
        console.log(`Running startup check for backend '${selectedBackend}' using model '${model}'`);

        const buildExitCode = await runCommand(process.execPath, [
            './node_modules/webpack-cli/bin/cli.js',
            '--env',
            'browser=chrome',
            '--env',
            `ocr_model=${model}`,
            '--env',
            `ocr_backend=${selectedBackend}`,
            '--mode',
            'production',
        ]);

        let result = null;
        let startupExitCode = buildExitCode;

        if (buildExitCode === 0) {
            const startupArgs = ['./tests/check-extension-startup.mjs'];
            if (headed) {
                startupArgs.push('--headed');
            }

            startupExitCode = await runCommand(process.execPath, startupArgs);
            result = await readSummary(path.join(testResultsDir, 'extension-startup-check.json'));
        }

        results.push({
            backend: selectedBackend,
            buildExitCode: buildExitCode ?? 1,
            startupExitCode: startupExitCode ?? 1,
            result,
        });
    }

    await fs.mkdir(testResultsDir, { recursive: true });
    await fs.writeFile(startupCheckPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        model,
        results,
    }, null, 2));

    console.table(results.map((entry) => ({
        backend: entry.backend,
        buildExitCode: entry.buildExitCode,
        startupExitCode: entry.startupExitCode,
        hasDebugState: entry.result?.hasDebugStateAfterPage ?? entry.result?.hasDebugState ?? false,
        manualCaptureOk: entry.result?.manualCaptureAfterPage?.ok ?? false,
    })));

    console.log(`Saved startup check: ${startupCheckPath}`);

    const failedCheck = results.find((entry) => entry.buildExitCode !== 0 || entry.startupExitCode !== 0);
    if (failedCheck) {
        process.exit(failedCheck.startupExitCode || failedCheck.buildExitCode || 1);
    }
}

async function readSummary(summaryPath) {
    try {
        const summaryBody = await fs.readFile(summaryPath, 'utf8');
        return JSON.parse(summaryBody);
    } catch {
        return null;
    }
}

function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}

