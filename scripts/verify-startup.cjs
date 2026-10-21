// Exercise the real Electron entry point with a disposable profile and no visible windows.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

if (process.versions.electron) {
  const { app, dialog, Menu, BrowserWindow } = require('electron')
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
        const startup = bridge.initBridgeServer(null, {
          port,
          extensionStatus: (version) => ({ ok: true, version: '1.3.7', reported: version })
        })
        assert.equal(bridge.initBridgeServer(null, { port }), startup)
        await startup
        const extensionState = await fetch(
          `http://127.0.0.1:${port}/extension-status?version=1.3.5`
        )
        const metadata = await extensionState.json()
        assert.equal(typeof metadata.instanceId, 'string')
        assert.equal(metadata.unlocked, false)
        delete metadata.instanceId
        delete metadata.unlocked
        assert.deepEqual(metadata, {
          ok: true,
          version: '1.3.7',
          reported: '1.3.5'
        })
        assert.equal(extensionState.headers.get('cache-control'), 'no-store')
        console.log(
          'PASS extension version checks work while locked without retrieving credentials'
        )
        const response = await fetch(`http://127.0.0.1:${port}/lookup?identity=fixture.example`)
        assert.equal(response.status, 423)
        assert.deepEqual((await response.json()).accounts, [])
        const db = await import(pathToFileURL(path.join(__dirname, '../src/main/db.js')))
        db.initDB('background-fixture.db', { createIfMissing: true })
        db.setMasterPassword('Synthetic!Startup123', 'fixture-salt')
        const hidden = new BrowserWindow({ show: false })
        hidden.hide()
        const captured = await fetch(`http://127.0.0.1:${port}/capture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            page_url: 'https://fixture.example/login',
            username: 'fixture',
            password: 'Synthetic!Capture123'
          })
        })
        assert.equal(captured.status, 200)
        const lookup = await fetch(`http://127.0.0.1:${port}/lookup?identity=fixture.example`)
        assert.equal((await lookup.json()).accounts[0].password, 'Synthetic!Capture123')
        db.closeVault()
        assert.equal(
          (await fetch(`http://127.0.0.1:${port}/lookup?identity=fixture.example`)).status,
          423
        )
        hidden.destroy()
        console.log('PASS a hidden desktop can save and fill; locking the vault disables lookup')
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
    let closeAnswer = { response: 0, checkboxChecked: false }
    let testWindow, trayItems
    let closePrompts = 0,
      hideCalls = 0,
      showCalls = 0
    const buildMenu = Menu.buildFromTemplate.bind(Menu)
    Menu.buildFromTemplate = (items) => {
      if (items.some((item) => item.label === '退出 LocalPass')) trayItems = items
      return buildMenu(items)
    }
    // Keep all synthetic databases outside the project and the user's installed vault.
    app.getAppPath = () => process.env.LOCALPASS_STARTUP_PROFILE
    dialog.showErrorBox = (title) => {
      process.send?.({ type: 'fatal', title })
      app.exit(1)
    }
    dialog.showMessageBox = async (_window, options) => {
      process.send?.({ type: 'notice', title: options.title, detail: options.detail })
      if (options.title === '关闭 LocalPass') {
        closePrompts++
        return closeAnswer
      }
      return { response: 0 }
    }
    app.on('second-instance', () => process.send?.({ type: 'second-instance' }))
    app.on('browser-window-created', (_event, window) => {
      testWindow = window
      window.show = () => {
        showCalls++
      }
      const hide = window.hide.bind(window)
      window.hide = () => {
        hideCalls++
        hide()
      }
      window.webContents.once('did-finish-load', async () => {
        try {
          const registered = await window.webContents.executeJavaScript(
            "window.localpass.register('startup-fixture', 'Synthetic!Startup123')"
          )
          assert.equal(registered.success, true)
          const listed = await window.webContents.executeJavaScript('window.localpass.listApps()')
          assert.deepEqual(listed, [])
          await window.webContents.executeJavaScript(`(async () => {
            for (const [selector, value] of [['#username', 'startup-fixture'], ['#master-pwd', 'Synthetic!Startup123']]) {
              const input = document.querySelector(selector)
              input.value = value
              input.dispatchEvent(new Event('input', { bubbles: true }))
            }
            document.querySelector('.unlock-form').requestSubmit()
            for (let retry = 0; retry < 100; retry++) {
              if (document.querySelector('.manager-nav')) return
              await new Promise(resolve => setTimeout(resolve, 30))
            }
            throw new Error('Synthetic UI login did not finish')
          })()`)
          process.send?.({ type: 'ready' })
        } catch (error) {
          console.error(error)
          app.exit(1)
        }
      })
    })
    process.on('message', (message) => {
      if (message === 'quit') app.quit()
      if (message === 'exercise-close') {
        ;(async () => {
          const pause = () => new Promise((resolve) => setTimeout(resolve, 120))
          testWindow.close()
          await pause()
          assert.equal(testWindow.isDestroyed(), false)
          assert.equal(hideCalls, 0)
          closeAnswer = { response: 2, checkboxChecked: true }
          testWindow.close()
          await pause()
          assert.equal(hideCalls, 1)
          assert.ok(trayItems)
          const preference = await testWindow.webContents.executeJavaScript(
            'window.localpass.getClosePreference()'
          )
          assert.equal(preference.action, 'background')
          const promptsBeforeReuse = closePrompts
          testWindow.close()
          await pause()
          assert.equal(hideCalls, 2)
          assert.equal(closePrompts, promptsBeforeReuse)
          const showsBeforeTray = showCalls
          trayItems[0].click()
          assert.ok(showCalls > showsBeforeTray)
          await testWindow.webContents.executeJavaScript('window.localpass.resetClosePreference()')
          assert.equal(
            await testWindow.webContents.executeJavaScript('window.localpass.getClosePreference()'),
            null
          )
          // Verify the settings action is connected through the real preload and renderer.
          await testWindow.webContents.executeJavaScript(
            `document.querySelectorAll('.manager-nav')[2].click()`
          )
          await pause()
          const ui = await testWindow.webContents.executeJavaScript(
            `({ text: document.body.innerText, overflow: document.documentElement.scrollWidth > innerWidth })`
          )
          assert.ok(ui.text.includes('恢复关闭提示'))
          assert.equal(ui.overflow, false)
          const extensionState = await testWindow.webContents.executeJavaScript(
            'window.localpass.getExtensionUpdateState()'
          )
          assert.equal(extensionState.version, '1.3.7')
          assert.ok(ui.text.includes('绑定已有扩展目录'))
          assert.ok(ui.text.includes('每 15 分钟自动下载新版'))
          assert.ok(fs.existsSync(path.join(extensionState.folder, 'manifest.json')))
          testWindow.webContents.setBackgroundThrottling(false)
          BrowserWindow.prototype.showInactive.call(testWindow)
          await testWindow.webContents.executeJavaScript(
            `document.querySelector('[aria-label="浏览器扩展与自动更新"]').scrollIntoView({block:'center'})`
          )
          await pause()
          const extensionScreenshot = path.join(
            process.env.LOCALPASS_STARTUP_PROFILE,
            'extension-update-settings.png'
          )
          fs.writeFileSync(
            extensionScreenshot,
            (await testWindow.webContents.capturePage()).toPNG()
          )
          BrowserWindow.prototype.hide.call(testWindow)
          console.log(`Extension settings screenshot: ${extensionScreenshot}`)
          console.log(
            'PASS extension update settings use a stable directory through the real preload and renderer'
          )
          const updateState = await testWindow.webContents.executeJavaScript(
            'window.localpass.getUpdateState()'
          )
          assert.ok(ui.text.includes('版本与更新'))
          assert.equal(updateState.status, 'unsupported')
          assert.equal(
            (await testWindow.webContents.executeJavaScript('window.localpass.checkForUpdates()'))
              .status,
            'unsupported'
          )
          // Use synthetic release events to verify the real preload subscription and UI.
          for (const [status, percent, label] of [
            ['available', 0, '下载更新'],
            ['downloading', 42, '42%'],
            ['downloaded', 100, '重启并安装']
          ]) {
            testWindow.webContents.send('updates:changed', {
              ...updateState,
              status,
              percent,
              version: '9.9.9-fixture'
            })
            await pause()
            assert.ok(
              await testWindow.webContents.executeJavaScript(
                `document.querySelector('[aria-label="应用更新"]').innerText.includes(${JSON.stringify(label)})`
              )
            )
          }
          if (process.env.LOCALPASS_UPDATE_SCREENSHOT) {
            testWindow.webContents.setBackgroundThrottling(false)
            BrowserWindow.prototype.show.call(testWindow)
            await testWindow.webContents.executeJavaScript(
              `document.querySelectorAll('[aria-label="应用更新"]')[1].scrollIntoView({block:'end'})`
            )
            await pause()
            fs.writeFileSync(
              process.env.LOCALPASS_UPDATE_SCREENSHOT,
              (await testWindow.capturePage()).toPNG()
            )
            BrowserWindow.prototype.hide.call(testWindow)
          }
          console.log(
            'PASS update settings IPC, development guard, progress and restart/install UI'
          )
          closeAnswer = { response: 0, checkboxChecked: false }
          testWindow.close()
          await pause()
          assert.equal(closePrompts, promptsBeforeReuse + 1)
          assert.equal(hideCalls, 2)
          process.send?.({ type: 'close-tested' })
        })().catch((error) => {
          console.error(error)
          app.exit(1)
        })
      }
      if (message === 'confirm-close') {
        closeAnswer = { response: 1, checkboxChecked: false }
        testWindow.close()
      }
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
  fs.cpSync(path.join(__dirname, '../chrome-extension'), path.join(profile, 'chrome-extension'), {
    recursive: true
  })
  env.LOCALPASS_STARTUP_PROFILE = profile
  const bridgeCheck = spawnSync(electron, [__filename], {
    env: { ...env, LOCALPASS_STARTUP_MODE: 'bridge' },
    stdio: 'inherit',
    windowsHide: true,
    timeout: 60000
  })
  if (bridgeCheck.status !== 0) {
    console.error(
      'Bridge integration process failed:',
      bridgeCheck.status,
      bridgeCheck.signal,
      bridgeCheck.error?.message
    )
    process.exit(1)
  }
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
    first.send('exercise-close')
    await waitFor(() => events.some((event) => event.type === 'close-tested'))
    console.log(
      'PASS real close events cancel/hide, create a tray, remember choices and reset through settings IPC'
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
    first.send('confirm-close')
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
