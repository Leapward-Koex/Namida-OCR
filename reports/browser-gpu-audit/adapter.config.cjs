const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({testDir:__dirname,testMatch:'adapter-probe.spec.ts',outputDir:'../../test-results/.gpu-adapter-artifacts',workers:5,fullyParallel:true,timeout:45000,reporter:'list'});
