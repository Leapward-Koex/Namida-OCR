import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ZERO_SHA = /^0+$/;

// Resolve immutable commits before running any candidate build. Never use the
// candidate itself as a baseline when a new branch or manual run has no diff.
export function resolveOcrBaseline(context, git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()) {
    const candidate = git('rev-parse', '--verify', 'HEAD^{commit}');
    let baseline;
    let reason;
    if (context.eventName === 'pull_request') {
        if (!/^[a-f0-9]{40}$/i.test(context.baseSha || '')) throw new Error('A pull request requires its base commit SHA.');
        baseline = git('merge-base', candidate, context.baseSha);
        reason = 'pull request merge base';
    } else if (context.eventName === 'push' && context.before && !ZERO_SHA.test(context.before)) {
        if (!/^[a-f0-9]{40}$/i.test(context.before)) throw new Error('Invalid push before SHA.');
        baseline = git('rev-parse', '--verify', `${context.before}^{commit}`);
        reason = 'previous branch tip';
    } else {
        if (!context.defaultBranch || context.defaultBranch.startsWith('-')) throw new Error('A default branch is required.');
        const defaultTip = git('rev-parse', '--verify', `refs/remotes/origin/${context.defaultBranch}^{commit}`);
        baseline = git('merge-base', candidate, defaultTip);
        reason = 'default branch merge base';
        if (baseline === candidate) {
            baseline = git('rev-parse', '--verify', 'HEAD^1^{commit}');
            reason = 'first parent (candidate already on default branch)';
        }
    }
    if (!/^[a-f0-9]{40}$/i.test(baseline) || baseline === candidate) {
        throw new Error('OCR accuracy comparison requires a distinct, available baseline commit.');
    }
    return { baseline, candidate, reason };
}

async function main() {
    const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const result = resolveOcrBaseline({
        eventName: process.env.GITHUB_EVENT_NAME,
        before: event.before,
        baseSha: event.pull_request?.base?.sha,
        defaultBranch: event.repository?.default_branch,
    });
    console.log(`OCR baseline: ${result.baseline} (${result.reason}); candidate: ${result.candidate}`);
    if (process.env.GITHUB_OUTPUT) {
        await fs.appendFile(process.env.GITHUB_OUTPUT, `baseline=${result.baseline}\ncandidate=${result.candidate}\n`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        await main();
    } catch (error) {
        console.error(`Cannot establish OCR accuracy baseline: ${error.message}`);
        process.exitCode = 1;
    }
}
