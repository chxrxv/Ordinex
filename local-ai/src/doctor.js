'use strict';
// `npm run ai:doctor` — read-only environment check and model recommendation.
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const config = require('./config');
const ollama = require('./ollama');

function sh(cmd, args) { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }

(async () => {
  const gb = (b) => (b / 1073741824).toFixed(1);
  console.log(`OS: ${os.type()} ${os.release()}   Node: ${process.version}   RAM: ${gb(os.totalmem())} GB (free ${gb(os.freemem())} GB)`);
  const nv = sh('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader']);
  let vramMiB = 0;
  if (nv) { console.log(`NVIDIA GPU: ${nv}`); vramMiB = Number(/,\s*(\d+) MiB,/.exec(nv)?.[1] || 0); } else console.log('NVIDIA GPU: not detected (nvidia-smi missing) — CPU inference will be used.');
  try { const s = fs.statfsSync(process.cwd()); console.log(`Free disk: ${gb(s.bavail * s.bsize)} GB`); } catch { /* optional */ }

  // Conservative guide (Q4_K_M weights + KV cache at 8k context). Unmeasured estimates except where noted in README.
  const rec = vramMiB >= 12000 ? 'qwen3:14b (~9 GB)' : vramMiB >= 5500 ? 'qwen3:4b (~2.5 GB weights, ~3.9 GB resident at 8k ctx — measured on RTX 4050 6 GB)' : vramMiB >= 3000 ? 'qwen3:1.7b (~1.4 GB) or llama3.2:3b' : 'qwen3:1.7b on CPU (slow) — or llama3.2:1b as a last resort';
  console.log(`Suggested model for this hardware: ${rec}`);

  const h = await ollama.health();
  console.log(`Ollama: ${h.reachable ? 'running v' + h.ollamaVersion : 'NOT reachable at ' + config.ollamaUrl}`);
  console.log(`Configured model "${config.model}": ${h.modelInstalled ? 'installed' : 'NOT installed -> ollama pull ' + config.model}`);
  if (h.installedModels.length) console.log(`Installed models: ${h.installedModels.join(', ')}`);
  if (h.reachable && h.modelInstalled) {
    const t = Date.now();
    try {
      const r = await ollama.chat({ user: 'Reply with the single word: ready', maxTokens: 10 });
      const h2 = await ollama.health();
      console.log(`Inference test: "${r.content.slice(0, 40)}" in ${Date.now() - t} ms; running on ${h2.loaded?.processor || 'unknown'}`);
    } catch (e) { console.log(`Inference test FAILED: ${e.message}`); process.exitCode = 1; }
  }
})();
