'use strict';
const { defineConfig } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

module.exports = defineConfig({
  testDir: './ui-test',
  outputDir: path.join(os.tmpdir(), 'ordinex-ui-test-results'),
  workers: 1,                    // one GPU, fixed ports
  retries: 0,
  reporter: [['list']],
  use: { browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 10000 },
  projects: [
    // Fast: real backend + real browser, MOCK Ollama (ui-test/helpers/env.js). No model needed.
    { name: 'fast', testMatch: /.*\.(fast|api)\.spec\.js/, timeout: 60000 },
    // Emulator: the REAL signed-in app against the Firebase Auth + Firestore emulators (project demo-ordinex).
    // Run with `npm run ai:ui:test:emulator` (starts the emulators). Never touches a real Firebase project.
    { name: 'emu', testMatch: /.*\.emu\.spec\.js/, timeout: 120000 },
    // Real: real backend + real Ollama + qwen3:4b. Slow; run with `npm run ai:ui:test:e2e`.
    { name: 'e2e', testMatch: /.*e2e\.spec\.js/, timeout: 360000 },
  ],
});
