// Read the OS setting instead of keeping a second preference that can drift.
export function createLaunchAtLogin({
  app,
  platform = process.platform,
  execPath = process.execPath,
  entryName = 'LocalPass'
}) {
  const supported = platform === 'win32' && app.isPackaged
  // Electron parses the lookup path as a Windows command line. Quote it so
  // installation directories containing spaces still match the executable.
  const options = { path: execPath, args: [] }
  const lookupOptions = { ...options, path: `"${execPath}"` }
  function getState() {
    if (!supported)
      return {
        supported: false,
        enabled: false,
        reason:
          platform === 'win32'
            ? '安装正式版后可设置开机自启。'
            : '开机自启目前支持 Windows 安装版。'
      }
    const settings = app.getLoginItemSettings(lookupOptions)
    return {
      supported: true,
      // openAtLogin checks the AppUserModelID entry even when setLoginItemSettings
      // used a custom name. launchItems exposes the actual named startup entry.
      enabled: settings.launchItems.some(
        (item) =>
          item.name === entryName &&
          item.scope === 'user' &&
          item.args.length === 0 &&
          item.enabled
      )
    }
  }
  return {
    getState,
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('开机自启设置无效')
      if (!supported) throw new Error(getState().reason)
      app.setLoginItemSettings({
        ...options,
        name: entryName,
        openAtLogin: enabled,
        enabled
      })
      const state = getState()
      if (state.enabled !== enabled) throw new Error('系统未能更新开机自启设置，请重试。')
      return state
    }
  }
}
