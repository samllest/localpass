// Acquire the profile lock before opening a database or starting the bridge.
export function acquireSingleInstance(app, getWindow) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', () => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  return true
}
