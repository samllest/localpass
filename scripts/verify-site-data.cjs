const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
if (!process.versions.electron) {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME'])
    delete env[key]
  env.LOCALPASS_STORAGE_TEST_PROFILE = fs.mkdtempSync(
    path.join(os.tmpdir(), 'localpass-metadata-test-')
  )
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 30000
  })
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 1
  if (process.exitCode === 0) {
    const reopened = require('node:child_process').spawnSync(require('electron'), [__filename], {
      env: { ...env, LOCALPASS_STORAGE_TEST_RESTART: '1' },
      stdio: 'inherit',
      windowsHide: true,
      timeout: 30000
    })
    if (reopened.error) console.error(reopened.error.message)
    process.exitCode = reopened.status ?? 1
  }
} else {
  const { app } = require('electron')
  const { pathToFileURL } = require('node:url')
  const profile =
    process.env.LOCALPASS_STORAGE_TEST_PROFILE ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'localpass-metadata-test-'))
  app.setPath('userData', profile)
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('in-process-gpu')
  app
    .whenReady()
    .then(async () => {
      const Database = require('better-sqlite3')
      const storage = await import(
        pathToFileURL(path.join(__dirname, '../src/main/storage.js')).href
      )
      if (process.env.LOCALPASS_STORAGE_TEST_RESTART === '1') {
        const target = await storage.initializeStorage({ developmentRoot: profile })
        assert.equal(target, path.join(profile, '.localpass-data', 'databases'))
        const reopened = await import(pathToFileURL(path.join(__dirname, '../src/main/db.js')).href)
        reopened.initDB('fixture.db')
        reopened.setMasterPassword('synthetic-master', 'fixture-salt')
        const legacy = reopened.findAppByIdentity('10.0.15.33', 'legacy-demo')
        assert.equal(legacy.password, 'SyntheticLegacy!456')
        assert.equal(reopened.getHistory(legacy.id).length, 2)
        assert.equal(
          reopened.findAppByIdentity('different.example:5000', 'demo').password,
          'Synthetic!Secret123'
        )
        assert.throws(() => reopened.initDB('missing.db'), /找不到此账号的密码库/)
        console.log(
          'PASS a separate Electron process reopens migrated credentials/history; missing vault stays missing'
        )
        app.exit(0)
        return
      }
      const directory = path.join(profile, 'databases')
      fs.mkdirSync(directory, { recursive: true })
      const legacy = new Database(path.join(directory, 'fixture.db'))
      legacy.exec(
        `CREATE TABLE apps (id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT UNIQUE, display_name TEXT NOT NULL, category TEXT DEFAULT 'web', created_at DATETIME DEFAULT CURRENT_TIMESTAMP); CREATE TABLE credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id INTEGER NOT NULL REFERENCES apps(id), username TEXT, password_blob TEXT, iv TEXT, version_tag INTEGER DEFAULT 1, is_latest INTEGER DEFAULT 1, captured_at DATETIME DEFAULT CURRENT_TIMESTAMP); INSERT INTO apps(identity,display_name) VALUES('10.0.15.33','Existing legacy entry');`
      )
      const crypto = await import(
        pathToFileURL(path.join(__dirname, '../src/main/vault-crypto.js')).href
      )
      const secret = crypto.encryptSecret(
        'SyntheticLegacy!123',
        crypto.deriveVaultKey('synthetic-master', 'fixture-salt')
      )
      legacy
        .prepare('INSERT INTO credentials(app_id, username, password_blob, iv) VALUES(1, ?, ?, ?)')
        .run('legacy-demo', secret.blob, secret.iv)
      legacy.close()
      const db = await import(pathToFileURL(path.join(__dirname, '../src/main/db.js')).href)
      assert.throws(() => db.initDB('missing.db'), /找不到此账号的密码库/)
      assert.equal(fs.existsSync(path.join(directory, 'missing.db')), false)
      assert.equal(db.isVaultUnlocked(), false)
      assert.throws(() => db.getVaultInfo(), /Vault not open/)
      assert.throws(() => db.initDB('../outside.db', { createIfMissing: true }), /文件名无效/)
      db.initDB('new-registration.db', { createIfMissing: true })
      db.setMasterPassword('synthetic-master', 'fixture-salt')
      assert.equal(db.listApps().length, 0)
      assert.equal(db.getVaultInfo().dbPath, path.join(directory, 'new-registration.db'))
      db.closeVault()
      assert.throws(() => db.initDB('new-registration.db', { createIfMissing: true }), /文件已存在/)
      fs.writeFileSync(path.join(directory, 'empty.db'), '')
      assert.throws(() => db.initDB('empty.db'), /结构不完整/)
      assert.equal(fs.statSync(path.join(directory, 'empty.db')).size, 0)
      assert.equal(db.isVaultUnlocked(), false)
      console.log('PASS missing/invalid vaults fail closed; only registration creates a new vault')
      db.initDB('fixture.db')
      db.setMasterPassword('synthetic-master', 'fixture-salt')
      const old = db.listApps()[0]
      assert.equal(old.display_name, 'Existing legacy entry')
      assert.equal(old.identity, '10.0.15.33')
      assert.equal(old.site_name, '')
      assert.equal(old.password, 'SyntheticLegacy!123')
      assert.equal(db.getHistory(old.id).length, 1)
      db.updateCredential({
        app_id: old.id,
        username: 'legacy-demo',
        password: 'SyntheticLegacy!456'
      })
      assert.equal(db.getHistory(old.id).length, 2)
      console.log('PASS old schema upgrades without inventing a port or changing legacy records')
      const legacyRecord = {
        identity: 'legacy-backup.example',
        display_name: 'Legacy Backup',
        category: 'web',
        username: 'legacy-user',
        password: 'SyntheticLegacyBackup!123'
      }
      const legacyPayload = JSON.stringify({
        format: 'localpass-export',
        version: 1,
        records: [legacyRecord]
      })
      const legacyEncrypted = crypto.encryptSecret(
        legacyPayload,
        crypto.deriveVaultKey('synthetic-master', 'fixture-salt')
      )
      const legacyBackup = JSON.stringify({
        format: 'localpass-export',
        version: 1,
        encrypted: true,
        ...legacyEncrypted
      })
      assert.equal(db.importVaultData(legacyBackup), 1)
      assert.equal(
        db.findAppByIdentity(legacyRecord.identity, legacyRecord.username).password,
        legacyRecord.password
      )
      console.log('PASS legacy v1 backups remain importable on the original vault')
      const icon =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
      const record = {
        identity: '10.0.15.33:3000',
        display_name: 'Agent Router',
        site_name: 'Agent Router',
        page_title: 'Agent Router · 登录',
        site_url: 'http://10.0.15.33:3000',
        icon_data: icon,
        category: 'web',
        username: 'demo',
        password: 'Synthetic!Secret123'
      }
      const id = db.createApp(record)
      const other = db.createApp({
        ...record,
        identity: '10.0.15.33:8080',
        site_url: 'http://10.0.15.33:8080',
        password: 'Different!Secret123'
      })
      assert.equal(db.listCredentialsByIdentity('10.0.15.33:3000')[0].app_id, id)
      assert.equal(db.listCredentialsByIdentity('10.0.15.33:8080')[0].app_id, other)
      assert.equal(db.listCredentialsByIdentity('10.0.15.33:9000').length, 0)
      assert.equal(db.getHistory(id).length, 1)
      console.log('PASS capture identities and lookup separate services by port')
      const update = db.updateApp({ ...record, app_id: id, page_title: 'Agent Router · 控制台' })
      assert.equal(update.metadataChanged, true)
      assert.equal(update.credentialChanged, false)
      assert.equal(db.getHistory(id).length, 1)
      const current = db.findAppByIdentity(record.identity, record.username)
      assert.equal(current.page_title, 'Agent Router · 控制台')
      assert.equal(current.icon_data, icon)
      console.log('PASS metadata refreshes without creating a password version')
      db.updateApp({ app_id: id, display_name: 'My custom label' })
      assert.equal(db.findAppByIdentity(record.identity, record.username).icon_data, icon)
      const backup = db.exportVaultData('Synthetic backup passphrase 2026')
      assert.throws(() => db.importVaultData(backup, 'incorrect backup passphrase'), /备份口令错误/)
      db.deleteApp(id)
      db.importVaultData(backup, 'Synthetic backup passphrase 2026')
      const restored = db.findAppByIdentity(record.identity, record.username)
      assert.equal(restored.icon_data, icon)
      assert.equal(restored.page_title, 'Agent Router · 控制台')
      assert.equal(restored.site_url, record.site_url)
      assert.equal(restored.password, record.password)
      console.log('PASS manual edits and encrypted backup round-trip preserve site metadata')
      db.updateApp({
        app_id: restored.id,
        identity: 'different.example:5000',
        site_url: 'http://different.example:5000'
      })
      const moved = db.findAppByIdentity('different.example:5000', record.username)
      assert.equal(moved.icon_data, '')
      assert.equal(moved.page_title, '')
      assert.equal(moved.site_url, 'http://different.example:5000')
      const transferableBackup = db.exportVaultData('Synthetic backup passphrase 2026')
      db.closeVault()
      db.initDB('destination.db', { createIfMissing: true })
      db.setMasterPassword('different-device-master', 'different-device-salt')
      assert.equal(db.importVaultData(transferableBackup, 'Synthetic backup passphrase 2026'), 4)
      assert.equal(
        db.findAppByIdentity('different.example:5000', record.username).password,
        record.password
      )
      assert.equal(
        db.findAppByIdentity('different.example:5000', record.username).site_url,
        'http://different.example:5000'
      )
      console.log('PASS encrypted JSON imports into a vault with a different master password')
      db.closeVault()
      db.initDB('fixture.db')
      db.setMasterPassword('synthetic-master', 'fixture-salt')
      assert.equal(
        db.findAppByIdentity('10.0.15.33', 'legacy-demo').password,
        'SyntheticLegacy!456'
      )
      assert.equal(db.getHistory(old.id).length, 2)
      assert.equal(
        db.findAppByIdentity('different.example:5000', record.username).password,
        record.password
      )
      assert.equal(
        db.findAppByIdentity('10.0.15.33:8080', record.username).password,
        'Different!Secret123'
      )
      assert.equal(
        db.findAppByIdentity('different.example:5000', record.username).site_url,
        'http://different.example:5000'
      )
      db.closeVault()
      assert.equal(db.isVaultUnlocked(), false)
      const catalog = new Database(path.join(directory, 'system.db'))
      catalog.pragma('journal_mode = WAL')
      catalog.exec(
        "CREATE TABLE users (db_filename TEXT); INSERT INTO users VALUES ('fixture.db'), ('missing.db');"
      )
      // Keep both source databases open in WAL mode to exercise consistent snapshots.
      const sourceVault = new Database(path.join(directory, 'fixture.db'))
      sourceVault.exec(
        "UPDATE apps SET page_title = 'Synthetic WAL migration' WHERE identity = '10.0.15.33'"
      )
      const migrated = await storage.initializeStorage({ developmentRoot: profile })
      assert.equal(migrated, path.join(profile, '.localpass-data', 'databases'))
      assert.equal(fs.existsSync(path.join(migrated, 'missing.db')), false)
      const migratedVault = new Database(path.join(migrated, 'fixture.db'), { readonly: true })
      assert.equal(
        migratedVault.prepare("SELECT page_title FROM apps WHERE identity = '10.0.15.33'").get()
          .page_title,
        'Synthetic WAL migration'
      )
      migratedVault.close()
      sourceVault.close()
      catalog.close()
      assert.equal(fs.existsSync(path.join(directory, 'fixture.db')), true)
      db.initDB('fixture.db')
      db.setMasterPassword('synthetic-master', 'fixture-salt')
      assert.equal(
        db.findAppByIdentity('10.0.15.33', 'legacy-demo').password,
        'SyntheticLegacy!456'
      )
      db.closeVault()
      console.log(
        'PASS development migration includes WAL data, preserves originals and never invents missing vaults'
      )
      console.log(
        'PASS changing websites drops stale metadata; migration and persistence are repeatable'
      )
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
