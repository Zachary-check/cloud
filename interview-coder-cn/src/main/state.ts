import { BrowserWindow, ipcMain } from 'electron'

ipcMain.handle('updateAppState', (event, _state) => {
  const previousIgnoreMouse = state.ignoreMouse
  Object.assign(state, _state)

  // Leaving the coder page drops click-through with it. The settings and help
  // pages have no mouse-toggle control, so a window left click-through there
  // cannot be clicked at all — it looks frozen with no way out.
  if (_state?.inCoderPage === false && state.ignoreMouse) {
    state.ignoreMouse = false
  }

  // Single reconcile path: whatever changed the flag, the native window and the
  // renderer's copy of the state must both end up matching it. Otherwise the
  // window either swallows every click the user makes, or shows a click-through
  // indicator while still accepting them.
  if (previousIgnoreMouse === state.ignoreMouse) return

  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return

  window.setIgnoreMouseEvents(state.ignoreMouse)
  window.webContents.send('sync-app-state', state)
})

/** Authoritative state, so a reloading renderer cannot drift out of sync */
ipcMain.handle('getAppState', () => state)

export const state = {
  inCoderPage: false,
  ignoreMouse: false
}

export type AppState = typeof state
