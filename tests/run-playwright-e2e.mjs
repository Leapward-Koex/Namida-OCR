import os from 'node:os';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const cpuCount = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const MIN_PLAYWRIGHT_WORKERS = 5;
const defaultWorkers = String(Math.max(MIN_PLAYWRIGHT_WORKERS, Math.ceil(cpuCount * 1.5)));
const configuredWorkers = process.env.PLAYWRIGHT_WORKERS?.trim();
const workers = configuredWorkers
    ? String(Math.max(MIN_PLAYWRIGHT_WORKERS, Number.parseInt(configuredWorkers, 10)))
    : defaultWorkers;
const testResultsDir = path.resolve(process.cwd(), 'test-results');
const caseResultsDir = path.join(testResultsDir, 'ocr-case-results');
const summaryPath = path.join(testResultsDir, 'ocr-accuracy-summary.json');
const combinedResultsPath = path.join(testResultsDir, 'ocr-case-results.json');
const playwrightCli = path.resolve(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');

await fs.rm(caseResultsDir, { recursive: true, force: true });
await fs.rm(summaryPath, { force: true });
await fs.rm(combinedResultsPath, { force: true });

const playwrightArgs = [playwrightCli, 'test', '--workers', workers];
if (headed) {
    playwrightArgs.push('--headed');
}

const playwrightExitCode = await runCommand(process.execPath, playwrightArgs);
await runCommand(process.execPath, ['./tests/write-ocr-summary.mjs']);
process.exit(playwrightExitCode ?? 1);

function runCommand(command, commandArgs) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, commandArgs, {
            cwd: process.cwd(),
            stdio: 'inherit',
        });

        child.on('error', reject);
        child.on('exit', (code) => resolve(code));
    });
}


