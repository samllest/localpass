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

      const reserve = http.createServer()
      await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
      const port = reserve.address().port
      await new Promise((resolve) => reserve.close(resolve))
      db.initDB('projects.db', { createIfMissing: true })
      db.setMasterPassword('Synthetic!Master123', 'synthetic-project-salt')
      const desktop = new BrowserWindow({ show: false })
      const prompts = 0
      const secret = 'a'.repeat(64)
      let activities = 0
      await bridge.initBridgeServer(desktop.webContents, {
        port,
        secret,
        onActivity: () => activities++
      })
      const base = `http://127.0.0.1:${port}`
      const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
      const trustedFetch = (url, options = {}) =>
        fetch(url, { ...options, headers: { ...headers, ...options.headers } })
      assert.equal((await fetch(base + '/lookup?identity=localhost:3000')).status, 401)
      assert.equal(
        (await trustedFetch(base + '/lookup', { headers: { Origin: 'https://evil.example' } }))
          .status,
        401
      )
      let revision = (
        await trustedFetch(base + '/extension-status').then((response) => response.json())
      ).revision
      const payload = (project, password) => ({
        page_url: 'http://localhost:3000/login',
        site_name: project,
        project_name: project,
        username: 'admin',
        password
      })
      const capture = (body) =>
        trustedFetch(base + '/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, vault_revision: revision })
        }).then((response) => response.json())
      const lookup = (project, options) =>
        trustedFetch(
          base +
            '/lookup?' +
            new URLSearchParams({ identity: 'localhost:3000', project_name: project }),
          options
        ).then((response) => response.json())
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      await capture(payload('项目 A', 'Synthetic!A123'))
      await capture(payload('项目 B', 'Synthetic!B123'))
      assert.equal(db.listApps().length, 2)
      assert.equal((await lookup('项目 A')).accounts[0].password, 'Synthetic!A123')
      assert.equal((await lookup('项目 B')).accounts[0].password, 'Synthetic!B123')
      assert.equal((await lookup('项目 C')).accounts.length, 0)
      const beforeMaintenance = activities
      const selected = (await lookup('项目 A')).accounts[0]
      await trustedFetch(base + '/extension-status')
      await trustedFetch(base + '/site-icons')
      assert.equal(activities, beforeMaintenance, 'lookups and maintenance do not renew inactivity')
      const activity = (identity, selection_token) =>
        trustedFetch(base + '/activity', {
          method: 'POST',
          body: JSON.stringify({ identity, selection_token })
        })
      assert.equal((await activity('other.example', selected.selectionToken)).status, 409)
      assert.equal(activities, beforeMaintenance)
      assert.equal((await activity('localhost:3000', selected.selectionToken)).status, 200)
      assert.equal(activities, beforeMaintenance + 1)
      assert.equal(prompts, 0)
      const iconList = await trustedFetch(base + '/site-icons').then((response) => response.json())
      assert.equal(iconList.sites.length, 2)
      assert.equal('password' in iconList.sites[0], false)
      const icon =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
      const iconWrite = (body) =>
        trustedFetch(base + '/site-icons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, vault_revision: revision })
        })
      assert.equal(
        (await iconWrite({ ...iconList.sites[0], revision: 'stale-session', icon_data: icon }))
          .status,
        409
      )
      const iconSaved = await iconWrite({
        ...iconList.sites[0],
        revision: iconList.revision,
        icon_data: icon
      })
      assert.equal((await iconSaved.json()).changed, true)
      assert.equal(
        (await trustedFetch(base + '/site-icons').then((response) => response.json())).sites.length,
        1
      )
      console.log(
        'PASS automatic icon backfill uses site-only metadata and rejects stale vault sessions'
      )
      const a = db.findAppByIdentity('localhost:3000', 'admin', { project_name: '项目 A' })
      assert.equal(a.project_name, '项目 A')
      assert.equal(db.findAppByIdentity('localhost:3000', 'admin'), null)
      console.log('PASS same-address, same-username projects save and look up independently')

      const changed = capture(payload('项目 A', 'Synthetic!Changed123'))
      assert.equal(desktop.isVisible(), false)
      assert.equal((await changed).changed, true)
      assert.equal(db.getHistory(a.id).length, 1)
      assert.equal(db.listApps().length, 3)
      console.log('PASS automatic separate save preserves the original password/history')

      const beforeLookupPrompts = prompts
      const chosen = await lookup('项目 A')
      assert.equal(chosen.selected, false)
      assert.equal(chosen.accounts.length, 2)
      assert.equal(prompts, beforeLookupPrompts)
      assert.equal(
        BrowserWindow.getAllWindows().filter((candidate) => candidate !== desktop).length,
        0
      )

      // Exercise the actual content script using accounts/tokens returned by
      // the real HTTP bridge, without opening any desktop selection window.
      const login = new BrowserWindow({
        show: false,
        webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true }
      })
      await login.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<form><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button type="submit">登录</button></form>'
          )
      )
      await login.webContents.executeJavaScript(`
        window.fixtureAccounts = ${JSON.stringify(chosen.accounts)};
        window.fixtureMessages = [];
        window.chrome = { runtime: { sendMessage(message, callback) {
          fixtureMessages.push(message);
          if (message.type === 'LP_LOOKUP') callback({ok:true, accounts:fixtureAccounts, selected:false});
        } } };
        document.querySelector('form').addEventListener('submit', event => event.preventDefault());
      `)
      await login.webContents.executeJavaScript(
        fs.readFileSync(path.join(__dirname, '../chrome-extension/content.js'), 'utf8')
      )
      login.webContents.focus()
      await login.webContents.executeJavaScript(`document.querySelector('#password').focus()`)
      await wait(30)
      assert.equal(
        await login.webContents.executeJavaScript(
          `document.querySelectorAll('[data-localpass-picker] button').length`
        ),
        2,
        await login.webContents.executeJavaScript(
          `JSON.stringify({visibility:document.visibilityState,active:document.activeElement.id,messages:fixtureMessages.map(m=>m.type)})`
        )
      )
      const account = chosen.accounts[1]
      await login.webContents.executeJavaScript(
        `document.querySelectorAll('[data-localpass-picker] button')[1].click()`
      )
      assert.deepEqual(
        await login.webContents.executeJavaScript(
          `({ username: document.querySelector('#username').value, password: document.querySelector('#password').value, picker: !!document.querySelector('[data-localpass-picker]') })`
        ),
        {
          username: account.username,
          password: account.password,
          picker: false
        }
      )
      await login.webContents.executeJavaScript(
        `document.querySelector('button[type="submit"]').click()`
      )
      const selectedToken = await login.webContents.executeJavaScript(
        `fixtureMessages.find(message => message.type === 'LP_LOGIN_SUBMITTED').payload.selection_token`
      )
      assert.equal(selectedToken, account.selectionToken)
      login.destroy()
      const promptCount = prompts
      await capture({
        ...payload('项目 A', 'Synthetic!SelectedUpdate123'),
        selection_token: selectedToken
      })
      assert.equal(prompts, promptCount)
      assert.equal(
        db.listApps().find((row) => row.id === account.id).password,
        'Synthetic!SelectedUpdate123'
      )
      assert.equal((await lookup('项目 B')).accounts[0].password, 'Synthetic!B123')
      console.log(
        'PASS multiple accounts fill through the webpage picker; its token updates exactly the chosen record'
      )

      const concurrent = await Promise.all([lookup('项目 A'), lookup('项目 A'), lookup('')])
      assert.deepEqual(
        concurrent.map((result) => result.accounts.length),
        [2, 2, 3]
      )
      assert.equal(prompts, promptCount)
      assert.equal(
        BrowserWindow.getAllWindows().filter((candidate) => candidate !== desktop).length,
        0
      )
      console.log(
        'PASS concurrent and unnamed-project lookups return immediately without desktop windows'
      )

      db.clearMasterKey()
      assert.equal((await capture(payload('项目 A', 'Synthetic!Locked123'))).ok, false)
      assert.deepEqual((await lookup('项目 A')).accounts, [])
      db.setMasterPassword('Synthetic!Master123', 'synthetic-project-salt')
      assert.equal((await capture(payload('项目 A', 'Synthetic!Stale123'))).ok, false)
      revision = (
        await trustedFetch(base + '/extension-status').then((response) => response.json())
      ).revision
      console.log('PASS locked and stale vault sessions release no passwords and cannot capture')
      const backup = db.exportVaultData('Synthetic backup passphrase 2026')
      const before = db
        .listApps()
        .map((row) => [row.project_name, row.username, row.password])
        .sort()
      for (const row of db.listApps()) db.deleteApp(row.id)
      db.importVaultData(backup, 'Synthetic backup passphrase 2026')
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
