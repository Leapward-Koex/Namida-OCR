const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
 testDir: __dirname, testMatch: 'gpu-audit.spec.ts',
 outputDir: '../../test-results/.gpu-audit-artifacts',
 workers: 5, fullyParallel: true, timeout: 120000,
 use: { headless: true }, reporter: 'list',
});
