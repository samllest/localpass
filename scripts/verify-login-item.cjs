// Exercise Electron's real Windows startup APIs with a unique, nonexistent
// executable. Never change LocalPass's installed startup entry or launch a vault.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME'])
    delete env[key]
  const result = spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 30000
  })
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 1
} else {
  const { app } = require('electron')
  app.commandLine.appendSwitch('in-process-gpu')
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    if (process.platform !== 'win32') {
      console.log('SKIP Windows login item verification')
      return app.exit(0)
    }
    const { pathToFileURL } = require('node:url')
    const { createLaunchAtLogin } = await import(pathToFileURL(join(__dirname, '../src/main/launch-at-login.js')))
    const entryName = `LocalPass-Test-${randomUUID()}`
    const execPath = join(tmpdir(), entryName, 'Directory With Spaces', 'nonexistent.exe')
    app.setAppUserModelId(`${entryName}.default`)
    const nativeApp = {
      isPackaged: true,
      getLoginItemSettings: app.getLoginItemSettings.bind(app),
      setLoginItemSettings: app.setLoginItemSettings.bind(app)
    }
    const manager = createLaunchAtLogin({ app: nativeApp, execPath, entryName })
    try {
      assert.equal(manager.getState().enabled, false)
      assert.equal(manager.setEnabled(true).enabled, true)
      const settings = app.getLoginItemSettings({ path: `"${execPath}"`, args: [] })
      assert.equal(settings.openAtLogin, false, 'custom name differs from AppUserModelID')
      assert.equal(settings.executableWillLaunchAtLogin, true)
      assert.equal(settings.launchItems.find(item => item.name === entryName)?.enabled, true)
      app.setLoginItemSettings({ name: entryName, path: execPath, args: [], openAtLogin: true, enabled: false })
      assert.equal(manager.getState().enabled, false, 'reflect disabling in Windows')
      assert.equal(manager.setEnabled(true).enabled, true)
      assert.equal(manager.setEnabled(false).enabled, false)
      console.log('PASS native Windows startup: custom entry name, spaces in executable path, enable/disable/re-enable and cleanup')
    } finally {
      app.setLoginItemSettings({ name: entryName, path: execPath, args: [], openAtLogin: false })
    }
    app.exit(0)
  }).catch(error => { console.error(error); app.exit(1) })
}
