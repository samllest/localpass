// Isolated Electron + SQLite + HTTP + native-window integration checks.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.versions.electron) {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME'])
    delete env[key]
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 60000
  })
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 1
} else {
  const { app, BrowserWindow } = require('electron')
  const { pathToFileURL } = require('node:url')
  const http = require('node:http')
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'localpass-project-test-')))
  app.commandLine.appendSwitch('in-process-gpu')
  app.disableHardwareAcceleration()
  app
    .whenReady()
    .then(async () => {
      const load = (file) => import(pathToFileURL(path.join(__dirname, '../src/', file)).href)
      const db = await load('main/db.js')
      const bridge = await load('main/bridge.js')
      const chooser = await load('main/project-choice.js')
      const reserve = http.createServer()
      await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
      const port = reserve.address().port
      await new Promise((resolve) => reserve.close(resolve))
      db.initDB('projects.db', { createIfMissing: true })
      db.setMasterPassword('Synthetic!Master123', 'synthetic-project-salt')
      const desktop = new BrowserWindow({ show: false })
      let prompts = 0
      await bridge.initBridgeServer(desktop.webContents, {
        port,
        chooseAccount: (...args) => {
          prompts++
          return chooser.chooseProjectAccount(...args)
        }
      })
      const base = `http://127.0.0.1:${port}`
      const payload = (project, password) => ({
        page_url: 'http://localhost:3000/login',
        site_name: project,
        project_name: project,
        username: 'admin',
        password
      })
      const capture = (body) =>
        fetch(base + '/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then((response) => response.json())
      const lookup = (project, options) =>
        fetch(
          base +
            '/lookup?' +
            new URLSearchParams({ identity: 'localhost:3000', project_name: project }),
          options
        ).then((response) => response.json())
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      async function promptWindow() {
        for (let index = 0; index < 300; index++) {
          const window = BrowserWindow.getAllWindows().find(
            (candidate) =>
              candidate !== desktop && candidate.isVisible() && !candidate.webContents.isLoading()
          )
          if (window) return window
          await wait(30)
        }
        throw new Error(
          'Expected a visible standalone selection window: ' +
            JSON.stringify(
              BrowserWindow.getAllWindows().map((window) => ({
                id: window.id,
                visible: window.isVisible(),
                loading: window.webContents.isLoading(),
                url: window.webContents.getURL().slice(0, 60)
              }))
            )
        )
      }
      async function clickChoice(window, selector) {
        await window.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(selector)}).click()`
        )
      }
      await capture(payload('项目 A', 'Synthetic!A123'))
      await capture(payload('项目 B', 'Synthetic!B123'))
      assert.equal(db.listApps().length, 2)
      assert.equal((await lookup('项目 A')).accounts[0].password, 'Synthetic!A123')
      assert.equal((await lookup('项目 B')).accounts[0].password, 'Synthetic!B123')
      assert.equal((await lookup('项目 C')).accounts.length, 0)
      assert.equal(prompts, 0)
      const a = db.findAppByIdentity('localhost:3000', 'admin', { project_name: '项目 A' })
      assert.equal(a.project_name, '项目 A')
      assert.equal(db.findAppByIdentity('localhost:3000', 'admin'), null)
      console.log('PASS same-address, same-username projects save and look up independently')

      const changed = capture(payload('项目 A', 'Synthetic!Changed123'))
      let window = await promptWindow()
      assert.equal(desktop.isVisible(), false)
      assert.equal(window.isAlwaysOnTop(), true)
      assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined')
      assert.equal(
        (await window.webContents.executeJavaScript('document.body.innerText')).includes(
          'Synthetic!'
        ),
        false
      )
      fs.mkdirSync(path.join(__dirname, '../out'), { recursive: true })
      fs.writeFileSync(
        path.join(__dirname, '../out/project-choice-save.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      await clickChoice(window, 'a[href$="/new"]')
      assert.equal((await changed).changed, true)
      assert.equal(db.getHistory(a.id).length, 1)
      assert.equal(db.listApps().length, 3)
      console.log(
        'PASS background capture prompts, separate save preserves the original password/history'
      )

      const ambiguous = lookup('项目 A')
      window = await promptWindow()
      fs.writeFileSync(
        path.join(__dirname, '../out/project-choice-fill.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      assert.equal(
        await window.webContents.executeJavaScript("document.querySelector('#confirm').disabled"),
        true
      )
      await window.webContents.executeJavaScript("document.querySelector('.account input').click()")
      assert.equal(window.isDestroyed(), false)
      await clickChoice(window, '#confirm')
      const chosen = await ambiguous
      assert.equal(chosen.selected, true)
      assert.equal(chosen.accounts.length, 1)
      const account = chosen.accounts[0]
      const promptCount = prompts
      await capture({
        ...payload('项目 A', 'Synthetic!SelectedUpdate123'),
        selection_token: account.selectionToken
      })
      assert.equal(prompts, promptCount)
      assert.equal(
        db.listApps().find((row) => row.id === account.id).password,
        'Synthetic!SelectedUpdate123'
      )
      assert.equal((await lookup('项目 B')).accounts[0].password, 'Synthetic!B123')
      console.log(
        'PASS same-name chooser selects exactly one record; selection token routes capture to it'
      )

      const abandonedController = new AbortController()
      const abandoned = lookup('项目 A', { signal: abandonedController.signal }).catch(
        (error) => error.name
      )
      window = await promptWindow()
      abandonedController.abort()
      assert.equal(await abandoned, 'AbortError')
      await wait(400)
      assert.equal(window.isDestroyed(), true)
      console.log('PASS leaving a login form aborts its lookup and closes the desktop chooser')

      const sharedController = new AbortController()
      const shared = lookup('项目 A', { signal: sharedController.signal }).catch(
        (error) => error.name
      )
      window = await promptWindow()
      const sharedCount = prompts
      const survivor = lookup('项目 A')
      await wait(80)
      sharedController.abort()
      assert.equal(await shared, 'AbortError')
      await wait(250)
      assert.equal(prompts, sharedCount)
      assert.equal(window.isDestroyed(), false)
      await clickChoice(window, '.account input')
      await clickChoice(window, '#confirm')
      assert.equal((await survivor).accounts.length, 1)
      console.log(
        'PASS concurrent lookups share one chooser; cancelling one does not cancel another'
      )

      const firstController = new AbortController()
      const queuedController = new AbortController()
      const first = lookup('项目 A', { signal: firstController.signal }).catch(
        (error) => error.name
      )
      window = await promptWindow()
      const queued = lookup('', { signal: queuedController.signal }).catch((error) => error.name)
      await wait(80)
      queuedController.abort()
      await queued
      firstController.abort()
      await first
      await wait(450)
      assert.equal(
        BrowserWindow.getAllWindows().filter((candidate) => candidate !== desktop).length,
        0
      )
      const singleHtml = chooser.choiceHtml(
        { identity: 'localhost:3000', accounts: [a], saving: false },
        'fixture'
      )
      assert.equal(singleHtml.includes('匹配到多个账号'), false)
      console.log(
        'PASS abandoned queued lookups never reopen a stale prompt; single records use accurate copy'
      )

      const cancelled = lookup('项目 A')
      window = await promptWindow()
      window.close()
      assert.deepEqual((await cancelled).accounts, [])
      const locked = lookup('项目 A')
      window = await promptWindow()
      db.clearMasterKey()
      chooser.cancelProjectChoices()
      assert.equal((await locked).ok, false)
      db.setMasterPassword('Synthetic!Master123', 'synthetic-project-salt')
      console.log('PASS close/cancel and vault locking never return a selected password')

      const backup = db.exportVaultData()
      const before = db
        .listApps()
        .map((row) => [row.project_name, row.username, row.password])
        .sort()
      for (const row of db.listApps()) db.deleteApp(row.id)
      db.importVaultData(backup)
      assert.deepEqual(
        db
          .listApps()
          .map((row) => [row.project_name, row.username, row.password])
          .sort(),
        before
      )
      db.closeVault()
      db.initDB('projects.db')
      db.setMasterPassword('Synthetic!Master123', 'synthetic-project-salt')
      assert.equal(db.listApps().length, 3)
      assert.equal((await lookup('项目 B')).accounts[0].password, 'Synthetic!B123')
      console.log('PASS project names survive encrypted backup and vault reopen')
      await bridge.closeBridgeServer()
      db.closeVault()
      desktop.destroy()
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
