// Real Electron safeStorage, main entry, auth IPC and renderer in a disposable profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
if (process.versions.electron) {
  const { app, dialog } = require('electron')
  const profile = process.env.LOCALPASS_SESSION_PROFILE
  const mode = process.env.LOCALPASS_SESSION_MODE
  app.setPath('userData', profile)
  app.getAppPath = () => profile
  dialog.showMessageBox = async () => ({ response: 0 })
  dialog.showErrorBox = (title, message) => {
    console.error(title, message)
    app.exit(1)
  }
  app.on('browser-window-created', (_, window) => {
    window.show = () => {}
    window.webContents.once('did-finish-load', async () => {
      try {
        const run = (code) => window.webContents.executeJavaScript(code)
        // Allow the renderer's initial auth status request and Vue render to finish.
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (mode === 'seed') {
          assert.equal(
            (await run("window.localpass.register('handoff-fixture','Synthetic!Handoff123')"))
              .success,
            true
          )
          await run(
            "window.localpass.createApp({identity:'fixture.example',display_name:'Fixture',username:'fixture',password:'Synthetic!Stored456'})"
          )
          assert.ok(fs.existsSync(path.join(profile, 'update-session.bin')))
          assert.equal(
            fs
              .readFileSync(path.join(profile, 'update-session.bin'))
              .includes(Buffer.from('Synthetic!Handoff123')),
            false
          )
          app.exit(0) // Simulate installer termination, which bypasses ordinary quit.
        } else if (mode === 'restore' || mode === 'graceful') {
          assert.equal((await run('window.localpass.getAuthSession()')).unlocked, true)
          assert.ok(await run("Boolean(document.querySelector('.manager-nav'))"))
          const apps = await run('window.localpass.listApps()')
          assert.equal(apps[0].password, 'Synthetic!Stored456')
          assert.equal(fs.existsSync(path.join(profile, 'update-resume.marker')), false)
          if (mode === 'graceful')
            fs.writeFileSync(
              path.join(profile, 'update-resume.marker'),
              'installer before stopping'
            )
          app.quit() // Normal quit must remove the newly refreshed capsule.
        } else {
          assert.equal((await run('window.localpass.getAuthSession()')).unlocked, false)
          assert.ok(await run("Boolean(document.querySelector('.unlock-form'))"))
          assert.equal(
            (await run("window.localpass.login('handoff-fixture','Synthetic!Handoff123')")).success,
            true
          )
          await run('window.localpass.clearMasterKey()')
          assert.equal(fs.existsSync(path.join(profile, 'update-session.bin')), false)
          assert.equal((await run('window.localpass.getAuthSession()')).unlocked, false)
          app.quit()
        }
      } catch (error) {
        console.error(error)
        app.exit(1)
      }
    })
  })
  require('../out/main/index.js')
} else {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'localpass-session-test-'))
  const env = { ...process.env, LOCALPASS_SESSION_PROFILE: profile }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'ELECTRON_RENDERER_URL',
    'CHROME_CRASHPAD_PIPE_NAME'
  ])
    delete env[key]
  fs.cpSync(path.join(__dirname, '../chrome-extension'), path.join(profile, 'chrome-extension'), {
    recursive: true
  })
  try {
    for (const mode of ['seed', 'graceful', 'restore', 'ordinary']) {
      if (mode === 'graceful')
        fs.writeFileSync(path.join(profile, 'update-resume.marker'), 'installer')
      const result = spawnSync(require('electron'), [__filename], {
        env: { ...env, LOCALPASS_SESSION_MODE: mode },
        windowsHide: true,
        stdio: 'inherit',
        timeout: 30000
      })
      assert.equal(result.status, 0, `${mode} process failed: ${result.error?.message || ''}`)
      if (mode === 'restore')
        assert.equal(fs.existsSync(path.join(profile, 'update-session.bin')), false)
      if (mode === 'graceful') {
        assert.ok(fs.existsSync(path.join(profile, 'update-session.bin')))
        assert.ok(fs.existsSync(path.join(profile, 'update-resume.marker')))
      }
      console.log(`PASS real update unlock lifecycle: ${mode}`)
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
}
