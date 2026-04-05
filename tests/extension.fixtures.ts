import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

type ExtensionFixtures = {
    context: BrowserContext;
    page: Page;
    serviceWorker: Worker;
    extensionId: string;
};

export const test = base.extend<ExtensionFixtures>({
    context: async ({ }, use, testInfo) => {
        const extensionPath = testInfo.outputPath('extension-under-test');
        const userDataDir = testInfo.outputPath('user-data-dir');
        const headless = testInfo.project.use.headless !== false;

        await prepareExtensionForTest(extensionPath);
        await fs.mkdir(userDataDir, { recursive: true });

        const context = await chromium.launchPersistentContext(userDataDir, {
            channel: 'chromium',
            headless,
            viewport: { width: 1280, height: 900 },
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
            ],
        });

        await use(context);
        await context.close();
    },

    page: async ({ context }, use) => {
        const page = context.pages()[0] ?? await context.newPage();
        await use(page);
    },

    serviceWorker: async ({ context }, use) => {
        let [serviceWorker] = context.serviceWorkers();

        if (!serviceWorker) {
            serviceWorker = await context.waitForEvent('serviceworker');
        }

        await use(serviceWorker);
    },

    extensionId: async ({ serviceWorker }, use) => {
        await use(new URL(serviceWorker.url()).host);
    },
});

async function prepareExtensionForTest(targetPath: string): Promise<void> {
    const sourcePath = path.resolve(process.cwd(), 'dist');
    const manifestPath = path.join(targetPath, 'manifest.json');

    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.cp(sourcePath, targetPath, { recursive: true });

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
        host_permissions?: string[];
    };
    const hostPermissions = new Set(manifest.host_permissions ?? []);

    // The real product flow gets activeTab from a user shortcut. Tests do not.
    hostPermissions.add('<all_urls>');
    manifest.host_permissions = [...hostPermissions];

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

export { expect } from '@playwright/test';
