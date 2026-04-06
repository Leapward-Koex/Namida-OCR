import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const MIN_PLAYWRIGHT_WORKERS = 5;
const { headed, comparisonWorkers } = parseArgs(args);
const langDir = path.resolve(process.cwd(), 'lang');
const testResultsDir = path.resolve(process.cwd(), 'test-results');
const comparisonPath = path.join(testResultsDir, 'ocr-model-comparison.json');
const discoveredModels = await discoverModels(langDir);
const jpnModels = discoveredModels.filter((model) => model.startsWith('jpn'));

if (jpnModels.length === 0) {
    throw new Error(`No jpn* OCR models were found in ${langDir}`);
}

const runs = [];

if (comparisonWorkers) {
    console.log(`Running model comparison with PLAYWRIGHT_WORKERS=${comparisonWorkers}`);
} else {
    console.log('Running model comparison with Playwright auto worker selection');
}

for (const model of jpnModels) {
    const runArgs = [
        './run-playwright-e2e.mjs',
        '--model',
        model,
        '--results-subdir',
        path.join('ocr-model-runs', model),
    ];

    if (headed) {
        runArgs.push('--headed');
    }

    if (comparisonWorkers) {
        runArgs.push('--workers', comparisonWorkers);
    }

    console.log('');
    console.log(`Comparing OCR model '${model}'`);

    const exitCode = await runCommand(process.execPath, runArgs);
    const summaryPath = path.join(testResultsDir, 'ocr-model-runs', model, 'ocr-accuracy-summary.json');
    const summary = await readSummary(summaryPath);

    runs.push({
        model,
        exitCode: exitCode ?? 1,
        summaryPath,
        summary,
    });
}

const ranking = runs
    .filter((run) => run.exitCode === 0 && run.summary)
    .map((run) => ({
        model: run.model,
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

        return left.model.localeCompare(right.model);
    });

const failedRuns = runs
    .filter((run) => run.exitCode !== 0 || !run.summary)
    .map((run) => ({
        model: run.model,
        exitCode: run.exitCode,
        summaryPath: run.summaryPath,
    }));

const comparison = {
    generatedAt: new Date().toISOString(),
    comparedModels: jpnModels,
    bestModel: ranking[0]?.model ?? null,
    ranking,
    failedRuns,
};

await fs.mkdir(testResultsDir, { recursive: true });
await fs.writeFile(comparisonPath, JSON.stringify(comparison, null, 2));

console.log('');
console.log('OCR model comparison');
console.table(ranking.map((result) => ({
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
    console.log(`Best model: ${winner.model}`);
    console.log(`Average character accuracy: ${formatPercent(winner.averageCharacterAccuracy)}`);
    console.log(`Exact match rate: ${formatPercent(winner.exactMatchRate)}`);
} else {
    console.log('No model comparisons completed successfully.');
}

console.log(`Saved comparison: ${comparisonPath}`);

if (ranking.length === 0) {
    process.exit(1);
}

async function discoverModels(directoryPath) {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const discovered = new Set();

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        const gzippedMatch = entry.name.match(/^(.*)\.traineddata\.gz$/);
        if (gzippedMatch) {
            discovered.add(gzippedMatch[1]);
            continue;
        }

        const plainMatch = entry.name.match(/^(.*)\.traineddata$/);
        if (plainMatch) {
            discovered.add(plainMatch[1]);
        }
    }

    return [...discovered].sort((left, right) => left.localeCompare(right));
}

function parseArgs(commandArgs) {
    let headed = false;
    let comparisonWorkers = normalizeConfiguredWorkers(process.env.PLAYWRIGHT_WORKERS?.trim() || '');

    for (let index = 0; index < commandArgs.length; index += 1) {
        const argument = commandArgs[index];

        if (argument === '--headed') {
            headed = true;
            continue;
        }

        if (argument === '--workers') {
            comparisonWorkers = normalizeWorkers(readRequiredValue(commandArgs, index, '--workers'));
            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${argument}`);
    }

    return {
        headed,
        comparisonWorkers,
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

