import { chromium } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const root = process.cwd();
const fixtureRoot = path.resolve(root, 'tests', 'fixtures');
const testResultsDir = path.resolve(root, 'test-results');
const resultPath = path.join(testResultsDir, 'extension-startup-check.json');

const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.svg', 'image/svg+xml'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
]);

const server = http.createServer(async (request, response) => {
    try {
        const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host}`);
        const pathname = requestUrl.pathname === '/' ? '/ocr-page.html' : decodeURIComponent(requestUrl.pathname);
        const filePath = path.resolve(fixtureRoot, `.${pathname}`);

        if (!filePath.startsWith(fixtureRoot)) {
            response.writeHead(403);
            response.end('Forbidden');
            return;
        }

        const body = await fs.readFile(filePath);
        const extension = path.extname(filePath).toLowerCase();

        response.writeHead(200, {
            'Content-Type': contentTypes.get(extension) ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        response.end(body);
    } catch {
        response.writeHead(404);
        response.end('Not found');
    }
});

main().catch(async (error) => {
    console.error(error);
    try {
        await closeServer();
    } catch {
        // Ignore shutdown failures during error cleanup.
    }
    process.exit(1);
});

async function main() {
    const port = await startServer();
    const extensionPath = path.resolve(root, '.tmp', 'startup-check-extension');
    const userDataDir = path.resolve(root, '.tmp', 'startup-check-user-data');
    const pageLogs = [];
    const serviceWorkerLogs = [];

    await fs.mkdir(path.dirname(extensionPath), { recursive: true });
    await prepareExtensionForTest(extensionPath);
    await fs.rm(userDataDir, { recursive: true, force: true });
    await fs.mkdir(userDataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: !headed,
        viewport: { width: 1280, height: 900 },
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
        ],
    });

    try {
        const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
        const extensionId = new URL(serviceWorker.url()).host;
        serviceWorker.on('console', (message) => {
            pushLog(serviceWorkerLogs, `${message.type()}: ${message.text()}`);
        });

        const page = context.pages()[0] ?? await context.newPage();
        page.on('console', (message) => {
            pushLog(pageLogs, `${message.type()}: ${message.text()}`);
        });
        page.on('pageerror', (error) => {
            pushLog(pageLogs, `pageerror: ${error.stack ?? String(error)}`);
        });

        const hasDebugStateBeforePage = await serviceWorker.evaluate(() => {
            return Boolean(globalThis.__namidaDebugState);
        });

        await page.goto(`http://127.0.0.1:${port}/ocr-page.html?image=images/ocr-case-001.png&label=startup-check`);
        await page.locator('#ocr-sample').waitFor({ state: 'visible', timeout: 10000 });
        await page.bringToFront();
        await page.waitForTimeout(250);

        const hasDebugStateAfterPage = await serviceWorker.evaluate(() => {
            return Boolean(globalThis.__namidaDebugState);
        });

        const manualCaptureAfterPage = await serviceWorker.evaluate(async () => {
            try {
                const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                const dataUrl = await chrome.tabs.captureVisibleTab(activeTab?.windowId, { format: 'png' });
                return {
                    ok: true,
                    dataUrlLength: dataUrl?.length ?? 0,
                    windowId: activeTab?.windowId ?? null,
                };
            } catch (error) {
                return {
                    ok: false,
                    error: String(error),
                };
            }
        });

        const backgroundEvents = await serviceWorker.evaluate(() => {
            return globalThis.__namidaDebugState?.events ?? [];
        });

        const result = {
            checkedAt: new Date().toISOString(),
            extensionId,
            hasDebugStateBeforePage,
            hasDebugStateAfterPage,
            manualCaptureAfterPage,
            backgroundEvents,
            pageLogs,
            serviceWorkerLogs,
            serviceWorkerUrl: serviceWorker.url(),
        };

        await fs.mkdir(testResultsDir, { recursive: true });
        await fs.writeFile(resultPath, JSON.stringify(result, null, 2));

        console.log(`Saved startup check: ${resultPath}`);
        console.log(JSON.stringify({
            hasDebugStateAfterPage: result.hasDebugStateAfterPage,
            manualCaptureOk: result.manualCaptureAfterPage.ok,
        }));

        if (!result.hasDebugStateAfterPage || !result.manualCaptureAfterPage.ok) {
            process.exitCode = 1;
        }
    } finally {
        await context.close();
        await closeServer();
    }
}

function pushLog(logs, message) {
    logs.push(message);
    if (logs.length > 50) {
        logs.shift();
    }
}

async function prepareExtensionForTest(targetPath) {
    const sourcePath = path.resolve(root, 'dist');
    const manifestPath = path.join(targetPath, 'manifest.json');

    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.cp(sourcePath, targetPath, { recursive: true });

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const hostPermissions = new Set(manifest.host_permissions ?? []);

    hostPermissions.add('<all_urls>');
    manifest.host_permissions = [...hostPermissions];

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function startServer() {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Could not determine fixture server port.'));
                return;
            }

            resolve(address.port);
        });
    });
}

function closeServer() {
    return new Promise((resolve, reject) => {
        if (!server.listening) {
            resolve();
            return;
        }

        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}
