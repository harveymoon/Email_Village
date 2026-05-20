// Town Inbox — preload script (CJS).
//
// Runs in an isolated Node context BEFORE the renderer's JS executes,
// with limited access to Node APIs and a sandbox-friendly bridge to the
// main process. We expose ONE typed namespace on `window.townInbox` so
// the renderer never sees `require` or raw `ipcRenderer` directly —
// every call is a named channel the main process explicitly handles.
//
// Phase A: just enough to confirm the bridge works (app:version). Phase F
// will fill in the real data-layer methods (threads.byLabel, people.aggregate,
// threads.modify, etc.) and event subscriptions (db:changed, sync:progress).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('townInbox', {
  /**
   * Returns Electron / Chrome / Node / app-version strings — handy as a
   * sanity probe that the preload bridge is wired correctly.
   */
  version: () => ipcRenderer.invoke('app:version'),

  /**
   * Generic invoke escape hatch. Renderer should normally call typed
   * helpers added in later phases — this is here so we can test new
   * channels without re-shipping a preload build.
   */
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  /**
   * Subscribe to a one-way push event from the main process (sync
   * progress, db change notifications, etc.). Returns an unsubscribe
   * function so renderers can clean up on component unmount.
   */
  on: (channel, handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  // Constant: true only when we're running inside Electron. Lets the
  // renderer's existing HTTP-based `api` keep working in a plain
  // browser dev environment (npm run dev without Electron).
  isElectron: true,
});
