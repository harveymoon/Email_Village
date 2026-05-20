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
const { spawn } = require('node:child_process');

const IS_DEV = !!process.env.TOWN_INBOX_DEV;
const RENDERER_DEV_URL = 'http://localhost:5173/';
// Resolved to dist/index.html relative to little_town/ in both dev (npm run
// build then npm run electron:start) and packaged builds (electron-builder
// stages the dist folder under app.asar/dist).
const RENDERER_PROD_URL = `file://${path.join(__dirname, '..', 'dist', 'index.html')}`;

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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backendProc.stdout?.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
  backendProc.stderr?.on('data', (chunk) => process.stderr.write(`[backend ERR] ${chunk}`));
  backendProc.on('exit', (code, signal) => {
    console.warn(`[main] backend exited code=${code} signal=${signal}`);
    backendProc = null;
  });
}

function stopBackend() {
  if (!backendProc) return;
  console.log('[main] stopping backend');
  try { backendProc.kill('SIGTERM'); } catch { /* already gone */ }
  backendProc = null;
}

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0b0b',                // matches the renderer's dark theme so no white flash
    title: 'Town Inbox',
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

  const url = IS_DEV ? RENDERER_DEV_URL : RENDERER_PROD_URL;
  mainWindow.loadURL(url);
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
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
