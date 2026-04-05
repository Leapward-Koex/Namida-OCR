import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const DEFAULT_OCR_MODEL = 'jpn_vert';
const baseResultsDir = path.resolve(process.cwd(), 'test-results');
const { headed, model, resultsDir, playwrightWorkers } = parseArgs(args);
const rootCaseResultsDir = path.join(baseResultsDir, 'ocr-case-results');
const rootSummaryPath = path.join(baseResultsDir, 'ocr-accuracy-summary.json');
const rootCombinedResultsPath = path.join(baseResultsDir, 'ocr-case-results.json');

console.log(`Building extension with OCR model '${model}'`);
const buildExitCode = await runCommand(process.execPath, [
    './node_modules/webpack-cli/bin/cli.js',
    '--env',
    'browser=chrome',
    '--env',
    `ocr_model=${model}`,
    '--mode',
    'production',
]);

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
        PLAYWRIGHT_WORKERS: playwrightWorkers,
    }
    : process.env;

if (playwrightWorkers) {
    console.log(`Using PLAYWRIGHT_WORKERS=${playwrightWorkers}`);
}

const testExitCode = await runCommand(process.execPath, runArgs, childEnv);
await mirrorResults(resultsDir, model);
process.exit(testExitCode ?? 1);

async function mirrorResults(targetResultsDir, selectedModel) {
    if (path.resolve(targetResultsDir) === baseResultsDir) {
        await annotateSummary(rootSummaryPath, selectedModel);
        return;
    }

    await fs.rm(targetResultsDir, { recursive: true, force: true });
    await fs.mkdir(targetResultsDir, { recursive: true });

    await copyIfPresent(rootCaseResultsDir, path.join(targetResultsDir, 'ocr-case-results'));
    await copyIfPresent(rootCombinedResultsPath, path.join(targetResultsDir, 'ocr-case-results.json'));
    await copyIfPresent(rootSummaryPath, path.join(targetResultsDir, 'ocr-accuracy-summary.json'));
    await annotateSummary(path.join(targetResultsDir, 'ocr-accuracy-summary.json'), selectedModel);
}

async function annotateSummary(summaryPath, selectedModel) {
    try {
        const summaryBody = await fs.readFile(summaryPath, 'utf8');
        const summary = JSON.parse(summaryBody);
        summary.model = selectedModel;
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
    let headed = false;
    let model = process.env.NAMIDA_OCR_MODEL?.trim() || DEFAULT_OCR_MODEL;
    let resultsSubdir = '';
    let playwrightWorkers = process.env.PLAYWRIGHT_WORKERS?.trim() || '';

    for (let index = 0; index < commandArgs.length; index += 1) {
        const argument = commandArgs[index];

        if (argument === '--headed') {
            headed = true;
            continue;
        }

        if (argument === '--model') {
            model = readRequiredValue(commandArgs, index, '--model');
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
        headed,
        model,
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

    return trimmedValue;
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
