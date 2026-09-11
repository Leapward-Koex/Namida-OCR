import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Node 24's built-in WebSocket connects directly to Firefox's official BiDi API.
// No geckodriver, browser download or third-party WebSocket package is required.
const workspace = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    if (flag === '--help') {
        console.log('node validate-firefox.mjs --profile <fresh-profile> [--build dist] [--output <workspace-directory>] [--port 9337] [--launcher-pid <pid>]');
        process.exit(0);
    }
    if (!['--build', '--output', '--profile', '--port', '--launcher-pid'].includes(flag) || !process.argv[index + 1]) {
        throw new Error(`Unknown or incomplete option: ${flag}`);
    }
    flags.set(flag, process.argv[index + 1]);
}
if (!flags.has('--profile')) throw new Error('Pass the fresh test profile with --profile; existing personal profiles must not be used.');
const port = Number(flags.get('--port') ?? 9337);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid debugging port');
const build = path.resolve(workspace, flags.get('--build') ?? 'dist');
const output = await workspacePath(flags.get('--output') ?? `.tmp/firefox-validation-${Date.now()}`);
const expectedProfile = await workspacePath(flags.get('--profile'));
assert.ok(isWithin(expectedProfile, output), 'The fresh profile must be inside the output directory.');
const buildManifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
assert.ok(Array.isArray(buildManifest.background?.scripts) && !buildManifest.background.service_worker
    && buildManifest.browser_specific_settings?.gecko?.id, 'Build must be the Firefox extension output.');
await mkdir(output, { recursive: true });
const addonPath = path.join(output, 'extension-under-test');
// A fresh destination avoids overwriting another run, following a junction, or
// deleting any browser profile. The supplied build itself remains unchanged.
await mkdir(addonPath);
await cp(build, addonPath, { recursive: true, errorOnExist: true, force: false, dereference: true });
const manifest = structuredClone(buildManifest);
manifest.background.scripts.push('bidi-open-popup.js');
await writeFile(path.join(addonPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(path.join(addonPath, 'bidi-open-popup.js'), "browser.tabs.create({url:browser.runtime.getURL('ui/popup.html')});\n");

const evidence = {
    createdAt: new Date().toISOString(), sourceBuild: build,
    launch: { port, profile: expectedProfile, launcherPid: Number(flags.get('--launcher-pid')) || undefined,
        headless: true, systemAccess: true },
    instrumentation: 'An added test background script opens the popup tab. Inference code, model files and extension permissions are unchanged.',
    limitation: 'Headless adapter availability does not establish hardware WebGPU support in a normal Firefox window.',
    commands: [], observations: [],
};
const evidencePath = path.join(output, 'firefox-validation-result.json');
const pending = new Map();
let nextId = 0;
let socket;
let installed;
let sessionCreated = false;
let verifiedProfile = false;
try {
    socket = await connect();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        evidence.commands.push({ method: request.method, response: message });
        message.type === 'error' ? request.reject(new Error(JSON.stringify(message))) : request.resolve(message.result);
    });
    const session = await command('session.new', { capabilities: {} });
    sessionCreated = true;
    assert.equal(session.capabilities.browserName, 'firefox');
    assert.equal(path.resolve(session.capabilities['moz:profile']).toLowerCase(), expectedProfile.toLowerCase(),
        'The BiDi server is not using the supplied fresh profile; refusing to install or close its browser.');
    verifiedProfile = true;
    assert.equal(session.capabilities['moz:headless'], true, 'This probe expects an isolated headless browser.');
    console.log('SESSION', JSON.stringify(session));
    await saveEvidence();
    installed = await command('webExtension.install', { extensionData: { type: 'path', path: addonPath } });
    let tab;
    for (let attempt = 0; attempt < 50; attempt++) {
        const tree = await command('browsingContext.getTree');
        tab = tree.contexts.find(context => context.url.startsWith('moz-extension:') && context.url.endsWith('/ui/popup.html'));
        if (tab) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(tab, 'Namida popup tab unavailable');
    async function evaluate(expression) {
        const result = await command('script.evaluate', { expression, target: { context: tab.context }, awaitPromise: true }, 180_000);
        if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
        assert.equal(result.result.type, 'string', 'Probe expression must return JSON');
        return JSON.parse(result.result.value);
    }
    evidence.metadata = await evaluate('JSON.stringify({extension:browser.runtime.id,worker:typeof Worker,gpu:!!navigator.gpu,userAgent:navigator.userAgent})');
    const image = 'data:image/png;base64,' + (await readFile(path.join(workspace, 'tests/fixtures/images/ocr-general-002.png'))).toString('base64');
    // Resolve action numbers from the source enum without evaluating application code.
    const actionsSource = await readFile(path.join(workspace, 'src/interfaces/message.ts'), 'utf8');
    const actionNames = actionsSource.match(/export enum NamidaMessageAction\s*\{([^}]+)\}/)?.[1].split(',').map(value => value.trim()).filter(Boolean);
    assert.ok(actionNames && actionNames.every(name => /^[A-Za-z]\w*$/.test(name)), 'Message enum format changed; update the probe action mapping.');
    const action = name => { const id = actionNames.indexOf(name); assert.ok(id >= 0, `Missing action ${name}`); return id; };
    for (const gpu of [true, true, false]) {
        const result = await evaluate(`(async()=>{
            await browser.storage.sync.set({OcrBackend:'paddleonnx',PaddleOnnxGpuEnabled:${gpu},OcrDebugArtifacts:true,FuriganaType:'none'});
            const started=performance.now();let text,error;
            try{text=await browser.runtime.sendMessage({action:${action('RecognizeImage')},data:${JSON.stringify(image)}});}catch(e){error=String(e);}
            const status=await browser.runtime.sendMessage({action:${action('GetOcrAccelerationStatus')}});
            const snapshot=await browser.runtime.sendMessage({action:${action('GetLastOcrDebugSnapshot')}});
            return JSON.stringify({gpu:${gpu},text,error,status,elapsedMs:performance.now()-started,pipeline:snapshot?.pipeline});
        })()`);
        evidence.observations.push(result);
        console.log('OCR', JSON.stringify(result));
        await saveEvidence();
        assert.equal(result.error, undefined);
        assert.equal(result.text, '日本語 OCR Test 2026');
        assert.equal(result.status.state, 'ready');
        assert.equal(result.status.requestedGpu, gpu);
        if (!gpu) assert.equal(result.status.provider, 'wasm');
    }
    evidence.upscale = await evaluate(`(async()=>{
        const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
        const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(80,120,160)';ctx.fillRect(0,0,8,8);
        const data={dataUrl:canvas.toDataURL('image/png'),shape:[8,8,3],imageData:Array.from({length:192},(_,i)=>[80,120,160][i%3])};
        try{const result=await browser.runtime.sendMessage({action:${action('UpscaleImage')},data});const img=new Image();img.src=result.dataUrl;await img.decode();return JSON.stringify({width:img.naturalWidth,height:img.naturalHeight,imageResponse:result.dataUrl.startsWith('data:image/')});}
        catch(e){return JSON.stringify({error:String(e)});}
    })()`);
    console.log('UPSCALE', JSON.stringify(evidence.upscale));
    assert.deepEqual(evidence.upscale, { width: 16, height: 16, imageResponse: true });
} catch (error) {
    evidence.error = String(error);
    process.exitCode = 1;
    console.error(error);
} finally {
    if (verifiedProfile) {
        if (installed) {
            try { await command('webExtension.uninstall', { extension: installed.extension }, 5000); }
            catch (error) { evidence.uninstallError = String(error); }
        }
        try { await command('browser.close', {}, 5000); }
        catch (error) { evidence.closeError = String(error); }
    } else if (sessionCreated) {
        // Never close an unrelated browser if the loopback port was misconfigured.
        try { await command('session.end', {}, 5000); } catch { /* Preserve the mismatch error. */ }
    }
    socket?.close();
    await saveEvidence();
    console.log('EVIDENCE', evidencePath);
}

function command(method, params = {}, timeout = 60_000) {
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, timeout);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params }));
    });
}

async function connect() {
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const candidate = new WebSocket(`ws://127.0.0.1:${port}/session`);
                const timer = setTimeout(() => { candidate.close(); reject(new Error('BiDi connection timeout')); }, 1000);
                candidate.addEventListener('open', () => { clearTimeout(timer); resolve(candidate); }, { once: true });
                candidate.addEventListener('error', () => { clearTimeout(timer); candidate.close(); reject(new Error('BiDi connection failed')); }, { once: true });
            });
        } catch {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    throw new Error('Could not connect to the isolated Firefox BiDi server. Check firefox-stderr.log.');
}

function isWithin(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function workspacePath(value) {
    const candidate = path.resolve(workspace, value);
    assert.ok(isWithin(candidate, workspace) && candidate !== workspace, 'Output/profile paths must stay inside the workspace.');
    let ancestor = candidate;
    while (true) {
        try { await stat(ancestor); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
    }
    assert.ok(isWithin(await realpath(ancestor), workspace), 'Output/profile path escapes the workspace through a junction or symlink.');
    return candidate;
}

function saveEvidence() { return writeFile(evidencePath, JSON.stringify(evidence, null, 2)); }
