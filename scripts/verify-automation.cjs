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
  process.exitCode = result.status ?? 1
} else {
  const { app } = require('electron')
  const { pathToFileURL } = require('node:url')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'localpass-automation-'))
  app.setPath('userData', profile)
  app.disableHardwareAcceleration()
  app
    .whenReady()
    .then(async () => {
      const load = (name) =>
        import(pathToFileURL(path.join(__dirname, '../src/main/' + name + '.js')))
      const auth = await load('auth'),
        db = await load('db'),
        storage = await load('storage-backup')
      const secret = 'Synthetic!Master123'
      auth.initSystemDb()
      const account = auth.registerUser('test-user', secret, (account) => {
        db.initDB(account.dbFilename, { createIfMissing: true })
        db.setMasterPassword(secret, account.salt)
      })
      assert.equal(account.success, true)
      const id = Number(
        db.createApp({
          identity: 'automation.example',
          display_name: 'Automation',
          username: 'user',
          password: 'Original!123',
          notes: 'note',
          tags: 'work',
          favorite: true
        , totp_secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
        })
      )
      db.updateApp({ app_id: id, password: 'Latest!456' })
      assert.equal(db.getHistory(id).length, 2)
      db.deleteApp(id)
      assert.equal(db.listApps().length, 0)
      assert.equal(db.listCredentialsByIdentity('automation.example').length, 0)
      assert.equal(db.listTrash().length, 1)
      assert.equal(db.restoreApp(id), true)
      assert.equal(db.getHistory(id).length, 2)
      assert.equal(db.listApps()[0].favorite, 1)
    assert.equal(db.listApps()[0].has_totp, 1)
    assert.equal(db.listApps()[0].totp_blob, undefined)
    assert.match(db.getTotpCode(id).code, /^\d{6}$/)
      const backup = db.exportVaultData('Synthetic portable backup passphrase')
      db.deleteApp(id)
      db.importVaultData(backup, 'Synthetic portable backup passphrase')
      const imported = db.listApps()[0]
    assert.match(db.getTotpCode(imported.id).code, /^\d{6}$/)
      assert.deepEqual(
        db.getHistory(imported.id).map((row) => row.password),
        ['Latest!456', 'Original!123']
      )
      assert.equal(db.getHistory(imported.id).filter((row) => row.is_latest).length, 1)
      assert.equal(db.importVaultData(backup, 'Synthetic portable backup passphrase'), 1)
      assert.equal(db.getHistory(imported.id).length, 2)
      const browser = db.importBrowserRecords([
        {
          identity: 'automation.example',
          display_name: 'Automation',
          username: 'user',
          password: 'Latest!456'
        },
        {
          identity: 'automation.example',
          display_name: 'Automation',
          username: 'user',
          password: 'Different!789'
        }
      ])
      assert.deepEqual(browser, { imported: 1, duplicates: 1, conflicts: 1 })
      const snapshot = await storage.createStorageSnapshot({
        destination: path.join(profile, 'full-snapshot')
      })
      const Database = require('better-sqlite3')
      const copy = new Database(path.join(snapshot, account.dbFilename), { readonly: true })
      assert.equal(copy.prepare('SELECT count(*) AS n FROM credentials').get().n, 5)
      copy.close()
      db.deleteApp(imported.id)
      const passwords = db.getHistory(imported.id).map((row) => row.password)
      auth.closeSystemDb()
      assert.throws(
        () => db.changeVaultMasterPassword({ ...account, salt: 'wrong' }, 'NewSynthetic!Master123'),
        /会话/
      )
      assert.deepEqual(
        db.getHistory(imported.id).map((row) => row.password),
        passwords
      )
      db.changeVaultMasterPassword(account, 'NewSynthetic!Master123')
      assert.deepEqual(
        db.getHistory(imported.id).map((row) => row.password),
        passwords
      )
      db.closeVault()
      auth.initSystemDb()
      assert.equal(auth.loginUser('test-user', secret).success, false)
      const changed = auth.loginUser('test-user', 'NewSynthetic!Master123')
      assert.equal(changed.success, true)
      db.initDB(changed.dbFilename)
      db.setMasterPassword('NewSynthetic!Master123', changed.salt)
      assert.deepEqual(
        db.getHistory(imported.id).map((row) => row.password),
        passwords
      )
      assert.equal(db.restoreApp(imported.id), true)
    assert.match(db.getTotpCode(imported.id).code, /^\d{6}$/)
      assert.equal(db.listApps().length, 2)
      db.closeVault()
      auth.closeSystemDb()
      fs.rmSync(profile, { recursive: true, force: true })
      console.log(
        'PASS recycle/restore, complete portable history, import conflict protection, encrypted snapshots and master-password re-encryption/reopen'
      )
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
