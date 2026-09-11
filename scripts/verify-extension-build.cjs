const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBuildInfo, validateVersion } = require('./build-info.cjs');

function verifyExtensionBuild(directory, browser, expected = createBuildInfo()) {
    const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    const manifest = read('manifest.json');
    const info = read('build-info.json');
    const paddle = read('libs/paddleocr/paddleocr-manifest.json');
    assert.ok(['chrome', 'firefox'].includes(browser), 'Unknown browser');
    validateVersion(manifest.version);
    for (const key of ['version', 'versionName', 'buildId', 'commit', 'sequence', 'attempt']) {
        assert.equal(info[key], expected[key], `Build identity mismatch: ${key}`);
    }
    assert.equal(manifest.version, info.version);
    assert.equal(manifest.version_name, info.versionName);
    assert.equal(info.browser, browser);
    const variant = browser === 'chrome' ? 'server' : 'mobile_det_server_rec';
    assert.equal(info.paddleOcrModelVariant, variant);
    assert.equal(paddle.variant, variant);
    if (browser === 'chrome') {
        assert.equal(manifest.background.service_worker, 'background/index.js');
        assert.ok(manifest.permissions.includes('offscreen'));
    } else {
        assert.deepEqual(manifest.background.scripts, ['background/index.js']);
        assert.ok(!manifest.permissions.includes('offscreen'));
    }
    function walk(folder) {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const filename = path.join(folder, entry.name);
            if (entry.isDirectory()) walk(filename);
            else if (entry.name === 'manifest.json') assert.equal(filename, path.join(directory, 'manifest.json'), 'Nested manifest');
        }
    }
    walk(directory);
    for (const filename of ['ui/index.js', 'ui/popup.html', 'paddle-worker/index.js',
        'libs/paddleocr/detection/v6/det.onnx', 'libs/paddleocr/languages/chinese/rec.onnx']) {
        assert.ok(fs.statSync(path.join(directory, filename)).size > 0, `Missing/empty ${filename}`);
    }
    return info;
}

module.exports = { verifyExtensionBuild };
if (require.main === module) {
    const info = verifyExtensionBuild(path.resolve(process.argv[2] || 'dist'), process.argv[3]);
    console.log(`Verified ${info.browser} ${info.versionName} (${info.version})`);
}
