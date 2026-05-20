// Town Inbox — Electron main process.
//
// Phase A scope: get a desktop window opening that loads the existing
// Phaser renderer. Backend stays as a separate Node process (same Express
// app at /api + /auth). In dev we assume the user has `cd backend &&
// npm run dev` already running; in production we spawn the bundled
// backend ourselves so the .exe / .dmg / .AppImage is self-contained.
//
// Single-instance lock so launching the app twice focuses the existing
// window instead of opening a second one. Native application menu with
// standard cut/copy/paste/quit/reload entries.
//
// IPC + SQLite + sync engine land in later phases. The preload script
// is wired with an empty `window.townInbox` namespace ready to be
// populated.
//
// CJS on purpose — Electron preloads are CJS-only and keeping main + preload
// in the same module system simplifies build packaging. The renderer's ESM
// world is unchanged.

const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const IS_DEV = !!process.env.TOWN_INBOX_DEV;
const RENDERER_DEV_URL = 'http://localhost:5173/';

// In packaged builds the renderer is served by our own Express
// process at http://localhost:<BACKEND_PORT>/ (see backend/server.js).
// Same-origin with the API means no CORS / cookie quirks vs file://.

// Backend default port matches backend/server.js. Env override supported
// so two simultaneous installs (e.g. dev + packaged) can coexist on one
// machine without colliding.
const BACKEND_PORT = parseInt(process.env.PORT || '3091', 10);

// Resolve the backend entry point. In dev we trust the user to run
// `npm run dev` in backend/ themselves (faster --watch loop, easier
// log inspection). In production we spawn node backend/server.js from
// the packaged resources directory.
function resolveBackendEntry() {
  // Packaged: electron-builder copies the backend folder under
  // process.resourcesPath/backend (configured in electron-builder.yml).
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'server.js');
  }
  // Dev fallback: backend lives one level up from little_town/.
  return path.join(__dirname, '..', '..', 'backend', 'server.js');
}

/** @type {import('child_process').ChildProcess | null} */
let backendProc = null;

function startBackend() {
  // In dev, assume the user is running their own `npm run dev` so they
  // get hot-reload + clean log output. Spawning a duplicate would just
  // crash on EADDRINUSE.
  if (IS_DEV) {
    console.log('[main] dev mode — skipping backend spawn (expecting your own `cd backend && npm run dev`)');
    return;
  }
  const entry = resolveBackendEntry();
  console.log('[main] spawning backend:', entry);
  // Use the Electron-bundled Node runtime via process.execPath with the
  // ELECTRON_RUN_AS_NODE flag — saves us from needing a separate Node
  // install on the user's machine.
  // Resolve the renderer dist dir for the backend's static-file
  // server. In packaged builds we put dist/ in extraResources so
  // Express can read it directly. In dev (electron:start without Vite),
  // it sits next to electron/ at little_town/dist.
  const rendererDir = app.isPackaged
    ? path.join(process.resourcesPath, 'dist')
    : path.join(__dirname, '..', 'dist');

  // Set up a per-launch log file in userData so the next crash leaves
  // a paper trail (the packaged app's stdout goes nowhere when
  // launched by double-click). Rotates to a fresh file each launch;
  // previous launches stay around as backend-prev.log.
  const logDir = app.getPath('userData');
  fs.mkdirSync(logDir, { recursive: true });
  const currentLog = path.join(logDir, 'backend.log');
  const prevLog = path.join(logDir, 'backend-prev.log');
  try { if (fs.existsSync(currentLog)) fs.renameSync(currentLog, prevLog); } catch { /* fine */ }
  const logStream = fs.createWriteStream(currentLog, { flags: 'a' });
  logStream.write(`\n=== backend spawn ${new Date().toISOString()} (pid pending) ===\n`);

  backendProc = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(BACKEND_PORT),
      // Backend's SQLite DB lives under Electron's per-user data dir
      // so packaged installs don't pollute the repo / cwd. The default
      // (~/.town-inbox) is the dev fallback used when running the
      // backend standalone (npm run dev).
      TOWN_INBOX_DATA_DIR: app.getPath('userData'),
      // Tell the backend to serve the built renderer at the same
      // origin as /api, so the window can load http://localhost:PORT/
      // without CORS / cookie hassles.
      TOWN_INBOX_RENDERER_DIR: rendererDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  logStream.write(`(pid=${backendProc.pid})\n`);
  backendProc.stdout?.on('data', (chunk) => { process.stdout.write(`[backend] ${chunk}`); logStream.write(chunk); });
  backendProc.stderr?.on('data', (chunk) => { process.stderr.write(`[backend ERR] ${chunk}`); logStream.write(`[ERR] ${chunk}`); });
  backendProc.on('exit', (code, signal) => {
    const msg = `[main] backend exited code=${code} signal=${signal} at ${new Date().toISOString()}`;
    console.warn(msg);
    logStream.write(`\n${msg}\n`);
    logStream.end();
    backendProc = null;
    // If the renderer's already running, show the user a banner so
    // they don't sit there wondering why nothing responds.
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(`(() => {
        const old = document.getElementById('__backend-died-banner'); if (old) old.remove();
        const div = document.createElement('div');
        div.id = '__backend-died-banner';
        div.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#5a1a1a;color:#fff;padding:10px 16px;font:13px system-ui;text-align:center;';
        div.textContent = 'Backend process exited (code=${code}). Check ${currentLog.replace(/\\\\/g, '\\\\\\\\')} for the crash log, then re-launch.';
        document.body.appendChild(div);
      })();`).catch(() => { /* renderer might be gone too */ });
    }
  });
}

function stopBackend() {
  if (!backendProc) return;
  console.log('[main] stopping backend');
  try { backendProc.kill('SIGTERM'); } catch { /* already gone */ }
  backendProc = null;
}

// Poll /health until the backend answers, OR `timeoutMs` elapses.
// Used in production to make sure the renderer URL is loadable before
// we hand it to BrowserWindow.loadURL — otherwise the window briefly
// flashes a "ERR_CONNECTION_REFUSED" page before the server catches up.
function waitForBackend(timeoutMs = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port: BACKEND_PORT, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        setTimeout(probe, 200);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('backend never came up'));
        setTimeout(probe, 200);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('backend never came up'));
        setTimeout(probe, 200);
      });
    };
    probe();
  });
}

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createMainWindow() {
  // Icon path: in packaged builds electron-packager bakes the icon
  // into the .exe metadata via --icon, but we also pass it to
  // BrowserWindow so the window decoration + Alt-Tab thumbnail
  // match in dev too.
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0b0b',                // matches the renderer's dark theme so no white flash
    title: 'Town Inbox',
    icon: iconPath,
    show: false,                               // wait for ready-to-show to avoid flicker
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,                          // preload needs require('electron') for ipcRenderer
      // Disable spellcheck — renderer-side textareas already feel native enough
      // and the wavy underlines just add visual noise on the dark UI.
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Route external http(s) navigation to the OS browser instead of
  // letting it replace our renderer. Unsubscribe links, OAuth pages,
  // etc. should open in Chrome/Safari/Firefox.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const current = new URL(mainWindow?.webContents.getURL() || RENDERER_PROD_URL);
    // Allow same-origin nav (Vite HMR, in-app hash routes); block + open
    // everything else externally.
    if (target.origin !== current.origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Dev: Vite serves the renderer on :5173 — load it directly.
  // Prod: our backend serves the built renderer on :BACKEND_PORT — wait
  // for /health, then load. Until then the window stays hidden so the
  // user sees nothing rather than a connection-refused flash.
  if (IS_DEV) {
    mainWindow.loadURL(RENDERER_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const url = `http://127.0.0.1:${BACKEND_PORT}/`;
    waitForBackend()
      .then(() => mainWindow?.loadURL(url))
      .catch(err => {
        console.error('[main] backend never came up:', err.message);
        mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="background:#0b0b0b;color:#eee;font:14px ui-sans-serif,system-ui;padding:40px"><h2>Town Inbox couldn't start its backend.</h2><p style="color:#fc8">${err.message}</p><p>Check the application logs and re-launch.</p></body>`)}`);
      });
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single-instance: second launch focuses the existing window instead of
// spawning a duplicate process (and a duplicate backend on the same port).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    startBackend();
    buildMenu();
    createMainWindow();
    app.on('activate', () => {
      // macOS dock-click behaviour: re-open the window if all closed.
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', stopBackend);
}

// IPC scaffolding — populated in Phase F. For now we just expose an
// `app:version` channel so the preload can confirm the bridge works
// end-to-end.
ipcMain.handle('app:version', () => ({
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  app: app.getVersion(),
}));
