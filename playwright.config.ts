import { defineConfig } from '@playwright/test';

const fixturePort = Number(process.env.PLAYWRIGHT_FIXTURE_PORT ?? 3210);

export default defineConfig({
    testDir: './tests',
    testMatch: /.*\.spec\.ts/,
    timeout: 120_000,
    expect: {
        timeout: 20_000,
    },
    fullyParallel: false,
    use: {
        baseURL: `http://127.0.0.1:${fixturePort}`,
        viewport: { width: 1280, height: 900 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium-extension',
            use: {
                browserName: 'chromium',
            },
        },
    ],
    webServer: {
        command: `node ./tests/serve-fixtures.mjs ${fixturePort}`,
        url: `http://127.0.0.1:${fixturePort}/ocr-page.html`,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
