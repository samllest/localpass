// Exercise the real Electron entry point with a disposable profile and no visible windows.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

if (process.versions.electron) {
  const { app, dialog } = require('electron')
  const { pathToFileURL } = require('node:url')
  app.setPath('userData', process.env.LOCALPASS_STARTUP_PROFILE)
  app.commandLine.appendSwitch('in-process-gpu')
  app.disableHardwareAcceleration()
  if (process.env.LOCALPASS_STARTUP_MODE === 'bridge') {
    app
      .whenReady()
      .then(async () => {
        const http = require('node:http')
        const bridge = await import(pathToFileURL(path.join(__dirname, '../src/main/bridge.js')))
        const occupied = http.createServer()
        await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve))
        const port = occupied.address().port
        await assert.rejects(bridge.initBridgeServer(null, { port }), { code: 'EADDRINUSE' })
        console.log('PASS an occupied port rejects safely without an uncaught exception')
        await new Promise((resolve) => occupied.close(resolve))
        const startup = bridge.initBridgeServer(null, { port })
        assert.equal(bridge.initBridgeServer(null, { port }), startup)
        await startup
        const response = await fetch(`http://127.0.0.1:${port}/lookup?identity=fixture.example`)
        assert.equal(response.status, 423)
        assert.deepEqual((await response.json()).accounts, [])
        await bridge.closeBridgeServer()
        await new Promise((resolve) => occupied.listen(port, '127.0.0.1', resolve))
        await new Promise((resolve) => occupied.close(resolve))
        console.log('PASS the bridge retries after a conflict, starts once and releases its port')
        app.exit(0)
      })
      .catch((error) => {
        console.error(error)
        app.exit(1)
      })
  } else {
    // Keep all synthetic databases outside the project and the user's installed vault.
    app.getAppPath = () => process.env.LOCALPASS_STARTUP_PROFILE
    dialog.showErrorBox = (title) => {
      process.send?.({ type: 'fatal', title })
      app.exit(1)
    }
    dialog.showMessageBox = async (_window, options) => {
      process.send?.({ type: 'notice', title: options.title, detail: options.detail })
      return { response: 0 }
    }
    app.on('second-instance', () => process.send?.({ type: 'second-instance' }))
    app.on('browser-window-created', (_event, window) => {
      window.show = () => {}
      window.webContents.once('did-finish-load', async () => {
        try {
          const registered = await window.webContents.executeJavaScript(
            "window.localpass.register('startup-fixture', 'Synthetic!Startup123')"
          )
          assert.equal(registered.success, true)
          const listed = await window.webContents.executeJavaScript('window.localpass.listApps()')
          assert.deepEqual(listed, [])
          process.send?.({ type: 'ready' })
        } catch (error) {
          console.error(error)
          app.exit(1)
        }
      })
    })
    process.on('message', (message) => {
      if (message === 'quit') app.quit()
    })
    require(process.env.LOCALPASS_STARTUP_ENTRY || path.join(__dirname, '../out/main/index.js'))
  }
} else {
  const electron = require('electron')
  const env = { ...process.env }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'CHROME_CRASHPAD_PIPE_NAME',
    'ELECTRON_RENDERER_URL'
  ])
    delete env[key]
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'localpass-startup-test-'))
  env.LOCALPASS_STARTUP_PROFILE = profile
  const bridgeCheck = spawnSync(electron, [__filename], {
    env: { ...env, LOCALPASS_STARTUP_MODE: 'bridge' },
    stdio: 'inherit',
    windowsHide: true,
    timeout: 30000
  })
  if (bridgeCheck.status !== 0) process.exit(bridgeCheck.status || 1)
  const http = require('node:http')
  let first, duplicate, occupied
  const events = []
  const timeout = setTimeout(() => {
    console.error('Startup check timed out')
    first?.kill()
    duplicate?.kill()
    process.exit(1)
  }, 30000)
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (predicate()) {
          clearInterval(check)
          resolve()
        } else if (first.exitCode !== null) {
          clearInterval(check)
          reject(new Error('Primary app exited early'))
        }
      }, 30)
    })
  }
  ;(async () => {
    occupied = http.createServer()
    await new Promise((resolve, reject) => {
      occupied.once('error', (error) => (error.code === 'EADDRINUSE' ? resolve() : reject(error)))
      occupied.listen(35320, '127.0.0.1', resolve)
    })
    const options = {
      env: { ...env, LOCALPASS_STARTUP_MODE: 'desktop' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    }
    first = spawn(electron, [__filename], options)
    first.stdout.on('data', (data) => process.stdout.write(data))
    first.stderr.on('data', (data) => process.stderr.write(data))
    first.on('message', (event) => events.push(event))
    await waitFor(
      () =>
        events.some((event) => event.type === 'ready') &&
        events.some((event) => event.type === 'notice')
    )
    assert.ok(events.find((event) => event.type === 'notice').detail.includes('35320'))
    assert.ok(!events.some((event) => event.type === 'fatal'))
    console.log(
      'PASS actual desktop entry loads and creates a synthetic vault while its bridge port is occupied'
    )
    duplicate = spawn(electron, [__filename], options)
    duplicate.stdout.resume()
    duplicate.stderr.resume()
    const exitCode = await new Promise((resolve) => duplicate.once('exit', resolve))
    assert.equal(exitCode, 0)
    await waitFor(() => events.some((event) => event.type === 'second-instance'))
    assert.equal(first.exitCode, null)
    console.log(
      'PASS launching the actual entry again exits cleanly and activates the original process'
    )
    first.send('quit')
    assert.equal(await new Promise((resolve) => first.once('exit', resolve)), 0)
  })()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => {
      clearTimeout(timeout)
      first?.kill()
      duplicate?.kill()
      if (occupied.listening) occupied.close()
    })
}
