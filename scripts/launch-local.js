const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3847);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = path.join(projectRoot, 'local-data');
const launcherDir = path.join(projectRoot, '.launcher');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(launcherDir, { recursive: true });

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

function log(message) {
  process.stdout.write(`[launcher] ${message}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: projectRoot }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runCommand(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function killExistingServer() {
  if (isWindows) {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp']);
      const lines = stdout.split(/\r?\n/).filter((line) => line.includes(`:${port}`) && line.includes('LISTENING'));
      const pids = [...new Set(lines.map((line) => line.trim().split(/\s+/).pop()).filter(Boolean))];
      for (const pid of pids) {
        if (String(process.pid) === pid) continue;
        log(`Stopping existing server process on port ${port} (PID ${pid})...`);
        try {
          await execFileAsync('taskkill', ['/PID', pid, '/F']);
        } catch (_) {}
      }
      return;
    } catch (_) {
      return;
    }
  }

  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`]);
    const pids = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const pid of pids) {
      if (String(process.pid) === pid) continue;
      log(`Stopping existing server process on port ${port} (PID ${pid})...`);
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch (_) {}
    }
    if (pids.length) await delay(750);
  } catch (_) {}
}

function httpReady(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    if (await httpReady(url)) return true;
    await delay(500);
  }
  return false;
}

async function ensureDependencies() {
  const nodeModulesDir = path.join(projectRoot, 'node_modules');
  const playwrightPkg = path.join(nodeModulesDir, 'playwright');
  if (fs.existsSync(nodeModulesDir) && fs.existsSync(playwrightPkg)) return;
  log('Installing npm dependencies...');
  await runCommand(npmCmd, ['install']);
}

async function ensureChromium() {
  const { chromium } = require(path.join(projectRoot, 'node_modules', 'playwright'));
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return;
  } catch (err) {
    log(`Playwright browser check failed: ${err.message}`);
  }

  log('Installing Playwright Chromium and headless shell...');
  await runCommand(npxCmd, ['playwright', 'install', 'chromium', 'chromium-headless-shell']);

  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  } catch (err) {
    throw new Error(`Playwright browsers still unavailable after install: ${err.message}`);
  }
}

function openBrowser(url) {
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (isWindows) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      REMOTE_BROWSER_ENABLED: '0',
      BROWSER_WS_URL: '',
    },
  });
  child.on('exit', (code) => {
    log(`Server stopped with code ${code ?? 0}`);
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    log(`Failed to start server: ${err.message}`);
    process.exit(1);
  });
  return child;
}

async function main() {
  log('Preparing Follett Launch QA...');
  await ensureDependencies();
  await ensureChromium();
  await killExistingServer();

  log('Starting local server...');
  const server = startServer();
  const ready = await waitForServer(baseUrl);
  if (!ready) {
    log('Server did not become ready in time.');
    server.kill();
    process.exit(1);
  }

  log(`Opening dashboard at ${baseUrl}`);
  openBrowser(baseUrl);
  log('Launcher is running. Close this window to stop the local server.');
}

main().catch((err) => {
  log(err.message);
  process.exit(1);
});
