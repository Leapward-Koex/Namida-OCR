const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function integer(value, name, maximum) {
    if (String(value).trim() !== String(value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
        throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
    }
    return Number(value);
}

function validateVersion(version) {
    if (version.trim() !== version || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)
        || version.split('.').some(part => Number(part) > 65535)
        || version.split('.').every(part => Number(part) === 0)) {
        throw new Error(`Invalid browser extension version: ${version}`);
    }
    return version;
}

function readGitInfo() {
    const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replace(/\\/g, '/')}`, ...args],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
        return { commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain', '--untracked-files=normal')) };
    } catch {
        return { commit: null, dirty: null };
    }
}

function createBuildInfo({ env = process.env, git = readGitInfo(), versionOverride, now = new Date() } = {}) {
    const sequence = env.NAMIDA_BUILD_SEQUENCE === undefined ? null
        : integer(env.NAMIDA_BUILD_SEQUENCE, 'NAMIDA_BUILD_SEQUENCE', 4294967295);
    const attempt = sequence === null ? null : integer(env.NAMIDA_BUILD_ATTEMPT || '1', 'NAMIDA_BUILD_ATTEMPT', 65535);
    if (sequence !== null && versionOverride !== undefined) throw new Error('CI build versions cannot be overridden.');
    if (sequence !== null && (!/^[a-f0-9]{40}$/.test(git.commit || '') || git.dirty !== false)) {
        throw new Error('Numbered builds require a clean Git checkout with a full commit SHA.');
    }
    if (sequence !== null && env.GITHUB_SHA && env.GITHUB_SHA !== git.commit) {
        throw new Error('The build checkout does not match GITHUB_SHA.');
    }
    // Epoch 2 sorts after all previous 1.x releases. Split the counter to stay
    // within Chrome's component limit of 65535. Reruns retain the same version
    // so a partial matrix rerun can reuse another browser's successful artifact.
    const version = validateVersion(String(versionOverride ?? (sequence === null ? '2.0.0'
        : `2.${Math.floor(sequence / 65536)}.${sequence % 65536}`)));
    const shortCommit = git.commit?.slice(0, 12) || 'source-archive';
    const buildId = sequence === null ? `local-${shortCommit}${git.dirty ? '-dirty' : ''}`
        : `${sequence}.${attempt}-${shortCommit}`;
    return {
        version, versionName: sequence === null ? `Local ${shortCommit}${git.dirty ? ' (modified)' : ''}`
            : `Build ${sequence}.${attempt} (${shortCommit})`,
        buildId, sequence, attempt, commit: git.commit, dirty: git.dirty,
        builtAt: now.toISOString(), runId: env.GITHUB_RUN_ID || null,
        tag: sequence === null ? null : `build-${sequence}`,
    };
}

module.exports = { createBuildInfo, validateVersion };

if (require.main === module) {
    const info = createBuildInfo();
    if (process.argv.includes('--github-output')) {
        if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${info.version}\ntag=${info.tag}\nbuild_id=${info.buildId}\n`);
    }
    console.log(JSON.stringify(info, null, 2));
}
