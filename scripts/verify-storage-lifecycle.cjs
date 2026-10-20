const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'localpass-lifecycle-'))
  const env = { ...process.env, LOCALPASS_LIFECYCLE_PROFILE: profile }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME'])
    delete env[key]
  const { spawnSync } = require('node:child_process')
  for (const restart of ['0', '1']) {
    const result = spawnSync(require('electron'), [__filename], {
      env: { ...env, LOCALPASS_LIFECYCLE_RESTART: restart },
      windowsHide: true,
      stdio: 'inherit',
      timeout: 30000
    })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
  fs.rmSync(profile, { recursive: true, force: true })
} else {
  const { app } = require('electron')
  const { pathToFileURL } = require('node:url')
  const profile = process.env.LOCALPASS_LIFECYCLE_PROFILE
  app.setPath('userData', profile)
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('in-process-gpu')
  app
    .whenReady()
    .then(async () => {
      const load = (name) =>
        import(pathToFileURL(path.join(__dirname, '../src/main/' + name + '.js')))
      const storage = await load('storage')
      const auth = await load('auth')
      const db = await load('db')
      const Database = require('better-sqlite3')
      const directory = await storage.initializeStorage({ developmentRoot: profile })
      auth.initSystemDb()
      const password = 'Synthetic!Lifecycle123'
      const initialize = (account) => {
        db.initDB(account.dbFilename, { createIfMissing: true })
        db.setMasterPassword(password, account.salt)
      }
      if (process.env.LOCALPASS_LIFECYCLE_RESTART === '1') {
        const login = auth.loginUser('fixture', password)
        assert.equal(login.success, true)
        db.initDB(login.dbFilename)
        db.setMasterPassword(password, login.salt)
        assert.equal(db.listApps()[0].password, 'Synthetic!SavedAfterRegistration')
        db.closeVault()
        auth.closeSystemDb()
        console.log(
          'PASS a fresh process reopens the registered account and decrypts its original vault'
        )
        app.exit(0)
        return
      }
      const failed = auth.registerUser('fixture', password, () => {
        throw new Error('Synthetic disk failure')
      })
      assert.equal(failed.success, false)
      assert.equal(auth.loginUser('fixture', password).success, false)
      const account = auth.registerUser('fixture', password, initialize)
      assert.equal(account.success, true, 'failed initialization must not reserve the username')
      const duplicate = auth.registerUser('fixture', password, () =>
        assert.fail('must not replace an existing vault')
      )
      assert.equal(duplicate.success, false)
      db.createApp({
        identity: 'fixture.example',
        display_name: 'Fixture',
        username: 'sample',
        password: 'Synthetic!SavedAfterRegistration'
      })
      console.log(
        'PASS account registration rolls back on vault failure and duplicate registration preserves the original'
      )
      const { createStorageSnapshot } = await load('storage-backup')
      const destination = path.join(profile, 'snapshot')
      await createStorageSnapshot({ source: directory, destination })
      assert.equal(fs.existsSync(path.join(destination, 'snapshot.json')), true)
      const catalog = new Database(path.join(destination, 'system.db'), { readonly: true })
      assert.equal(catalog.prepare('SELECT count(*) AS count FROM users').get().count, 1)
      catalog.close()
      const vault = new Database(path.join(destination, account.dbFilename), { readonly: true })
      const credential = vault
        .prepare('SELECT password_blob, iv FROM credentials WHERE is_latest = 1')
        .get()
      vault.close()
      const crypto = await load('vault-crypto')
      assert.equal(
        crypto.decryptSecret(
          credential.password_blob,
          credential.iv,
          crypto.deriveVaultKey(password, account.salt)
        ),
        'Synthetic!SavedAfterRegistration'
      )
      console.log(
        'PASS update snapshot preserves both the account catalog and committed encrypted WAL data'
      )
      const broken = path.join(profile, 'broken')
      fs.mkdirSync(broken)
      fs.copyFileSync(path.join(destination, 'system.db'), path.join(broken, 'system.db'))
      const incomplete = path.join(profile, 'incomplete')
      await assert.rejects(createStorageSnapshot({ source: broken, destination: incomplete }), {
        code: 'ERR_VAULT_BACKUP'
      })
      assert.equal(fs.existsSync(path.join(incomplete, 'snapshot.json')), false)
      assert.equal(fs.existsSync(path.join(broken, account.dbFilename)), false)
      db.closeVault()
      auth.closeSystemDb()
      console.log('PASS missing vaults block update backup without inventing empty databases')
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
