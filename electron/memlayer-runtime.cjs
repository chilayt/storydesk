const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

let starting, owned;
function bundledRuntime(resources, developmentRoot, port) {
  const python = resources ? path.join(resources, 'python', 'python.exe') :
    path.join(developmentRoot, '.build-runtime', 'python', 'python.exe');
  const bridge = resources ? path.join(resources, 'memlayer', 'bridge.py') :
    path.join(developmentRoot, 'vendor', 'memlayer', 'bridge.py');
  return { python, bridge, port, bundled: true };
}

async function reachable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.ok === true && typeof health.version === 'string' && Number.isInteger(health.writerQueue);
  } catch { return false; }
}

// The launcher file is installed in the app's host profile, outside imported workspaces.
async function ensureMemlayer(settings, profile, bundled) {
  if (!settings?.enabled) return;
  let config;
  try { config = JSON.parse(await fs.readFile(path.join(profile, 'memlayer-runtime.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') return; }
  if (!config && settings.baseUrl === ("http://127.0.0.1:" + bundled?.port)) config = bundled;
  const { port, python, bridge, localEmbedding } = config || {};
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || settings.baseUrl !== `http://127.0.0.1:${port}` ||
    typeof python !== 'string' || !path.isAbsolute(python) || typeof bridge !== 'string' ||
    !path.isAbsolute(bridge) || path.basename(bridge).toLowerCase() !== 'bridge.py') return;
  if (starting) return starting;
  starting = (async () => {
    if (owned && await reachable(port)) return;
    if (owned) return;
    if (!config.bundled && await reachable(port)) return;
    const files = await Promise.all([fs.stat(python), fs.stat(bridge)]).catch(() => []);
    if (files.length !== 2 || files.some(file => !file.isFile())) return;
    const data = path.join(profile, 'memlayer');
    const embeddingArgs = typeof localEmbedding === 'string' && path.isAbsolute(localEmbedding)
      ? ['--local-embedding', localEmbedding] : [];
    const entry = config.bundled ? ['-B', '-c',
      "import os, runpy, sys; entry = sys.argv.pop(1); sys.path.insert(0, os.path.dirname(entry)); runpy.run_path(entry, run_name='__main__')",
      bridge] : ['-B', bridge];
    const child = spawn(python, [...entry, '--host', '127.0.0.1', '--port', String(port),
      '--root', path.join(data, 'store'), '--retraction-mirror', path.join(data, 'retraction-mirror'), ...embeddingArgs],
    { cwd: path.dirname(bridge), windowsHide: true, stdio: 'ignore', env: { ...process.env, MEMLAYER_SEMANTIC: '0' } });
    owned = child;
    const release = () => { if (owned === child) owned = null; };
    child.once('error', release);
    child.once('exit', release);
    for (let count = 0; owned === child && count < 20; count++) {
      if (await reachable(port)) return;
      await delay(150);
    }
  })().finally(() => { starting = null; });
  return starting;
}

function closeMemlayer() {
  owned?.kill();
}

module.exports = { ensureMemlayer, closeMemlayer, bundledRuntime };
