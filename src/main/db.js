import Database from 'better-sqlite3'
import { randomBytes, pbkdf2Sync } from 'crypto'
import { join } from 'path'
import { existsSync } from 'fs'

import { getDbDir } from './storage.js'
import { decryptSecret, deriveBackupKey, deriveVaultKey, encryptSecret } from './vault-crypto.js'
import { normalizeSiteMetadata, safeIconData, websiteAddress } from '../shared/site-metadata.js'
import { isDevelopmentSite, projectKey } from '../shared/project-matching.js'
import { parseTotp, totpCode } from './totp.js'

let db = null
let masterKey = null
let currentDbPath = null
let vaultRevision = 0

export function getVaultRevision() {
  return vaultRevision
}

function ensureVaultOpen() {
  if (!db) {
    throw new Error('Vault not open')
  }
}

function normalizeText(value) {
  return value == null ? '' : String(value)
}

function normalizeUsername(value) {
  const username = normalizeText(value).trim()
  return username || null
}

function normalizeCategory(value) {
  return value === 'app' ? 'app' : 'web'
}

function normalizeAppFields({ identity, display_name, category }) {
  const storedDisplayName = normalizeText(display_name).trim()
  if (!storedDisplayName) {
    throw new Error('Display name is required')
  }

  const storedIdentity = normalizeText(identity || storedDisplayName).trim()
  if (!storedIdentity) {
    throw new Error('Identity is required')
  }

  return {
    identity: storedIdentity,
    display_name: storedDisplayName,
    category: normalizeCategory(category)
  }
}

export function setMasterPassword(password, salt) {
  masterKey = deriveVaultKey(password, salt)
}

// Main-process-only update handoff; never exposed through IPC or the bridge.
export function copyVaultKey() {
  ensureUnlocked()
  return Buffer.from(masterKey)
}

export function restoreVaultKey(key) {
  ensureVaultOpen()
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid vault key')
  const sample = db
    .prepare('SELECT password_blob, iv FROM credentials WHERE password_blob IS NOT NULL LIMIT 1')
    .get()
  if (sample) decryptSecret(sample.password_blob, sample.iv, key)
  masterKey = Buffer.from(key)
}

export function clearMasterKey() {
  masterKey?.fill(0)
  masterKey = null
  vaultRevision++
}

export function closeVault() {
  if (db) {
    db.close()
    db = null
  }
  currentDbPath = null
  clearMasterKey()
}

export function getVaultInfo() {
  ensureUnlocked()
  return { dbPath: currentDbPath }
}

export function isVaultUnlocked() {
  return Boolean(db && masterKey)
}

function ensureUnlocked() {
  ensureVaultOpen()
  if (!masterKey) {
    throw new Error('Vault locked')
  }
}

function encrypt(plaintext) {
  ensureUnlocked()

  return encryptSecret(normalizeText(plaintext), masterKey)
}

function decrypt(blob, ivB64) {
  ensureUnlocked()

  return decryptSecret(blob, ivB64, masterKey)
}

function safeDecrypt(blob, iv) {
  try {
    return decrypt(blob, iv)
  } catch {
    return '*** Decryption failed ***'
  }
}

function decryptOrThrow(blob, iv) {
  const value = safeDecrypt(blob, iv)
  if (value === '*** Decryption failed ***') {
    throw new Error('Failed to decrypt existing password')
  }
  return value
}

function mapCredentialRow(row) {
  return {
    ...row,
    password: row.password_blob ? safeDecrypt(row.password_blob, row.iv) : ''
  }
}

function getLatestCredential(appId) {
  return db
    .prepare(
      `SELECT id, username, password_blob, iv, version_tag
       FROM credentials
       WHERE app_id = ? AND is_latest = 1
       ORDER BY version_tag DESC
       LIMIT 1`
    )
    .get(appId)
}

function saveCredentialVersion(appId, username, password, latest = getLatestCredential(appId)) {
  const storedUsername = normalizeUsername(username)
  const nextPassword = normalizeText(password)

  if (latest) {
    const sameUsername = normalizeText(latest.username) === normalizeText(storedUsername)
    const samePassword = safeDecrypt(latest.password_blob, latest.iv) === nextPassword

    if (sameUsername && samePassword) {
      return { updated: false, version_tag: latest.version_tag }
    }
  }

  const { blob, iv } = encrypt(nextPassword)
  const nextVersion = latest ? latest.version_tag + 1 : 1

  db.prepare(`UPDATE credentials SET is_latest = 0 WHERE app_id = ? AND is_latest = 1`).run(appId)
  db.prepare(
    `INSERT INTO credentials (app_id, username, password_blob, iv, version_tag, is_latest)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(appId, storedUsername, blob, iv, nextVersion)

  return { updated: true, version_tag: nextVersion }
}

export function initDB(dbFilename, { createIfMissing = false } = {}) {
  if (typeof dbFilename !== 'string' || !/^[\w-]+\.db$/.test(dbFilename)) {
    throw new Error('密码库文件名无效')
  }

  closeVault()

  const dbPath = join(getDbDir(), dbFilename)
  if (!createIfMissing && !existsSync(dbPath)) {
    throw new Error(`找不到此账号的密码库，已停止解锁，未创建空库。请恢复原文件：${dbPath}`)
  }
  if (createIfMissing && existsSync(dbPath)) {
    throw new Error('密码库文件已存在，已停止创建以保护原数据')
  }

  try {
    db = new Database(dbPath, { fileMustExist: !createIfMissing })
    currentDbPath = dbPath
    if (!createIfMissing) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      if (!['apps', 'credentials'].every((name) => tables.some((table) => table.name === name))) {
        throw new Error('密码库结构不完整，已停止解锁。请保留原文件并从备份恢复')
      }
    }
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity TEXT NOT NULL,
      display_name TEXT NOT NULL,
      category TEXT CHECK(category IN ('web', 'app')) DEFAULT 'web',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL,
      username TEXT,
      password_blob TEXT,
      iv TEXT,
      version_tag INTEGER DEFAULT 1,
      is_latest INTEGER DEFAULT 1,
      captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_credentials_latest
    ON credentials(app_id, is_latest, version_tag DESC);

    CREATE INDEX IF NOT EXISTS idx_credentials_history
    ON credentials(app_id, version_tag DESC);
  `)

    migrateUniqueIdentityConstraint()
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(apps)')
        .all()
        .map((column) => column.name)
    )
    db.transaction(() => {
      for (const column of ['site_name', 'page_title', 'site_url', 'icon_data', 'project_name']) {
        if (!columns.has(column))
          db.exec(`ALTER TABLE apps ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`)
      }
      for (const column of ['notes', 'tags', 'deleted_at', 'totp_blob', 'totp_iv']) {
        if (!columns.has(column))
          db.exec(`ALTER TABLE apps ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`)
      }
      if (!columns.has('favorite'))
        db.exec('ALTER TABLE apps ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0')
    })()
    db.exec(`CREATE INDEX IF NOT EXISTS idx_apps_identity ON apps(identity);`)

    return currentDbPath
  } catch (error) {
    closeVault()
    throw error
  }
}

function migrateUniqueIdentityConstraint() {
  const schema = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'apps'`)
    .get()

  if (!schema?.sql?.match(/identity\s+TEXT\s+UNIQUE/i)) return

  db.pragma('foreign_keys = OFF')
  db.pragma('legacy_alter_table = ON')
  db.transaction(() => {
    db.exec(`
      ALTER TABLE apps RENAME TO apps_legacy;
      CREATE TABLE apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identity TEXT NOT NULL,
        display_name TEXT NOT NULL,
        category TEXT CHECK(category IN ('web', 'app')) DEFAULT 'web',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO apps (id, identity, display_name, category, created_at)
        SELECT id, identity, display_name, category, created_at FROM apps_legacy;
      DROP TABLE apps_legacy;
    `)
  })()
  db.pragma('legacy_alter_table = OFF')
  db.pragma('foreign_keys = ON')
}

export function findAppByIdentity(identity, username, project) {
  ensureUnlocked()

  const normalizedIdentity = normalizeText(identity).trim()
  if (!normalizedIdentity) {
    return null
  }

  const normalizedUsername = normalizeUsername(username)
  const row = db
    .prepare(
      `SELECT a.id, a.id AS app_id, a.identity, a.display_name, a.category, a.created_at, a.site_name, a.page_title, a.site_url, a.icon_data, a.project_name,
              c.id AS credential_id, c.username, c.password_blob, c.iv,
              c.version_tag, c.captured_at
       FROM apps a
       LEFT JOIN credentials c ON c.app_id = a.id AND c.is_latest = 1
       WHERE a.identity = ? AND a.deleted_at = ''
         AND ((c.username = ?) OR (c.username IS NULL AND ? IS NULL))
       ORDER BY a.id DESC`
    )
    .all(normalizedIdentity, normalizedUsername, normalizedUsername)

  const matches =
    project !== undefined && isDevelopmentSite(identity)
      ? row.filter((record) => projectKey(record) === projectKey(project))
      : row
  return matches.length === 1 ? mapCredentialRow(matches[0]) : null
}

export function listApps() {
  ensureUnlocked()

  return db
    .prepare(
      `SELECT a.id, a.identity, a.display_name, a.category, a.created_at, a.site_name, a.page_title, a.site_url, a.icon_data, a.project_name, a.notes, a.tags, a.favorite, (a.totp_blob != '') AS has_totp, a.id AS app_id,
              c.id AS credential_id, c.username, c.password_blob, c.iv,
              c.version_tag, c.captured_at
       FROM apps a
       LEFT JOIN credentials c ON c.app_id = a.id AND c.is_latest = 1
       WHERE a.deleted_at = ''
       ORDER BY a.id DESC`
    )
    .all()
    .map(mapCredentialRow)
}

export function searchApps(query) {
  ensureUnlocked()

  const normalizedQuery = normalizeText(query).trim()
  if (!normalizedQuery) {
    return listApps()
  }

  return db
    .prepare(
      `SELECT a.id, a.identity, a.display_name, a.category, a.created_at, a.site_name, a.page_title, a.site_url, a.icon_data, a.project_name,
              c.username, c.password_blob, c.iv, c.version_tag, c.captured_at
       FROM apps a
       LEFT JOIN credentials c ON c.app_id = a.id AND c.is_latest = 1
       WHERE a.deleted_at = '' AND (CAST(a.id AS TEXT) LIKE ? OR a.display_name LIKE ? OR a.identity LIKE ?)
       ORDER BY a.id DESC`
    )
    .all(`%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`)
    .map(mapCredentialRow)
}

export function createApp({
  identity,
  display_name,
  category = 'web',
  username,
  password,
  ...metadata
}) {
  ensureUnlocked()

  const appFields = normalizeAppFields({ identity, display_name, category })
  const site = normalizeSiteMetadata(metadata, appFields.identity)
  const nextPassword = normalizeText(password)
  if (!nextPassword) {
    throw new Error('Password is required')
  }

  const { blob, iv } = encrypt(nextPassword)
  const storedUsername = normalizeUsername(username)

  const insertApp = db.prepare(
    `INSERT INTO apps (identity, display_name, category, site_name, page_title, site_url, icon_data, project_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertCred = db.prepare(
    `INSERT INTO credentials (app_id, username, password_blob, iv, version_tag, is_latest)
     VALUES (?, ?, ?, ?, 1, 1)`
  )

  return db.transaction(() => {
    const appResult = insertApp.run(
      appFields.identity,
      appFields.display_name,
      appFields.category,
      site.site_name,
      site.page_title,
      site.site_url,
      site.icon_data,
      site.project_name
    )
    if (metadata.totp_secret) {
      const encryptedTotp = encrypt(JSON.stringify(parseTotp(metadata.totp_secret)))
      db.prepare('UPDATE apps SET totp_blob = ?, totp_iv = ? WHERE id = ?').run(
        encryptedTotp.blob,
        encryptedTotp.iv,
        appResult.lastInsertRowid
      )
    }
    insertCred.run(appResult.lastInsertRowid, storedUsername, blob, iv)
    db.prepare('UPDATE apps SET notes = ?, tags = ?, favorite = ? WHERE id = ?').run(
      normalizeText(metadata.notes).slice(0, 8000),
      normalizeText(metadata.tags).slice(0, 1000),
      metadata.favorite ? 1 : 0,
      appResult.lastInsertRowid
    )
    return appResult.lastInsertRowid
  })()
}

export function updateCredential({ app_id, username, password }) {
  ensureUnlocked()
  const appId = Number(app_id)
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error('Invalid app id')
  }

  const nextPassword = normalizeText(password)
  if (!nextPassword) {
    throw new Error('Password is required')
  }

  return db.transaction(() => saveCredentialVersion(appId, username, nextPassword))()
}

export function updateApp({
  app_id,
  display_name,
  identity,
  category,
  username,
  password,
  ...metadata
}) {
  ensureUnlocked()

  const appId = Number(app_id)
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error('Invalid app id')
  }

  const existingApp = db.prepare(`SELECT * FROM apps WHERE id = ?`).get(appId)
  if (!existingApp || existingApp.deleted_at) {
    throw new Error('App not found')
  }

  const nextAppFields = normalizeAppFields({
    identity: identity ?? existingApp.identity,
    display_name: display_name ?? existingApp.display_name,
    category: category ?? existingApp.category
  })
  const site = normalizeSiteMetadata(
    {
      ...(nextAppFields.identity === existingApp.identity &&
      nextAppFields.category === existingApp.category
        ? existingApp
        : {}),
      ...metadata
    },
    nextAppFields.identity
  )

  return db.transaction(() => {
    if (metadata.totp_secret !== undefined) {
      const encryptedTotp = metadata.totp_secret
        ? encrypt(JSON.stringify(parseTotp(metadata.totp_secret)))
        : { blob: '', iv: '' }
      db.prepare('UPDATE apps SET totp_blob = ?, totp_iv = ? WHERE id = ?').run(
        encryptedTotp.blob,
        encryptedTotp.iv,
        appId
      )
    }
    db.prepare('UPDATE apps SET notes = ?, tags = ?, favorite = ? WHERE id = ?').run(
      normalizeText(metadata.notes ?? existingApp.notes).slice(0, 8000),
      normalizeText(metadata.tags ?? existingApp.tags).slice(0, 1000),
      (metadata.favorite ?? existingApp.favorite) ? 1 : 0,
      appId
    )
    const metadataChanged =
      metadata.totp_secret !== undefined ||
      (metadata.notes !== undefined &&
        normalizeText(metadata.notes).slice(0, 8000) !== existingApp.notes) ||
      (metadata.tags !== undefined &&
        normalizeText(metadata.tags).slice(0, 1000) !== existingApp.tags) ||
      (metadata.favorite !== undefined &&
        Number(Boolean(metadata.favorite)) !== existingApp.favorite) ||
      existingApp.identity !== nextAppFields.identity ||
      existingApp.display_name !== nextAppFields.display_name ||
      existingApp.category !== nextAppFields.category ||
      ['site_name', 'page_title', 'site_url', 'icon_data', 'project_name'].some(
        (key) => existingApp[key] !== site[key]
      )

    if (metadataChanged) {
      db.prepare(
        `UPDATE apps SET identity = ?, display_name = ?, category = ?, site_name = ?, page_title = ?, site_url = ?, icon_data = ?, project_name = ? WHERE id = ?`
      ).run(
        nextAppFields.identity,
        nextAppFields.display_name,
        nextAppFields.category,
        site.site_name,
        site.page_title,
        site.site_url,
        site.icon_data,
        site.project_name,
        appId
      )
    }

    const latest = getLatestCredential(appId)
    const usernameToPersist = username === undefined ? latest?.username : username
    const normalizedUsername = normalizeUsername(usernameToPersist)
    const usernameChanged = normalizeText(latest?.username) !== normalizeText(normalizedUsername)
    const normalizedPassword = password === undefined ? undefined : normalizeText(password)
    const passwordChanged = normalizedPassword !== undefined
    const shouldUpdateCredential = passwordChanged || usernameChanged

    let credentialResult = { updated: false, version_tag: latest?.version_tag || 1 }

    if (shouldUpdateCredential) {
      const passwordToPersist =
        normalizedPassword !== undefined
          ? normalizedPassword
          : latest
            ? decryptOrThrow(latest.password_blob, latest.iv)
            : ''

      if (!passwordToPersist) {
        throw new Error('Password is required')
      }

      credentialResult = saveCredentialVersion(appId, normalizedUsername, passwordToPersist, latest)
    }

    return {
      updated: metadataChanged || credentialResult.updated,
      metadataChanged,
      credentialChanged: credentialResult.updated,
      version_tag: credentialResult.version_tag
    }
  })()
}

export function deleteApp(app_id) {
  ensureUnlocked()
  db.prepare("UPDATE apps SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at = ''").run(
    app_id
  )
}

export function listTrash() {
  ensureUnlocked()
  return db
    .prepare(
      "SELECT id, display_name, identity, deleted_at FROM apps WHERE deleted_at != '' ORDER BY deleted_at DESC"
    )
    .all()
}

export function restoreApp(id) {
  ensureUnlocked()
  return (
    db.prepare("UPDATE apps SET deleted_at = '' WHERE id = ? AND deleted_at != ''").run(id)
      .changes > 0
  )
}

export function purgeTrash() {
  ensureUnlocked()
  return db
    .prepare("DELETE FROM apps WHERE deleted_at != '' AND deleted_at < datetime('now', '-30 days')")
    .run().changes
}

export function importBrowserRecords(records) {
  ensureUnlocked()
  return db.transaction(() => {
    let imported = 0,
      duplicates = 0,
      conflicts = 0
    for (const record of records) {
      const matches = listCredentialsByIdentity(record.identity).filter(
        (row) => normalizeUsername(row.username) === normalizeUsername(record.username)
      )
      if (matches.some((row) => row.password === record.password)) {
        duplicates++
        continue
      }
      if (matches.length) conflicts++
      createApp(record)
      imported++
    }
    return { imported, duplicates, conflicts }
  })()
}

export function changeVaultMasterPassword({ username, dbFilename, salt }, nextPassword) {
  ensureUnlocked()
  if (typeof nextPassword !== 'string' || nextPassword.length < 12)
    throw new Error('新主密码至少需要 12 个字符')
  const nextSalt = randomBytes(16).toString('hex')
  const nextKey = deriveVaultKey(nextPassword, nextSalt)
  const nextHash = pbkdf2Sync(nextPassword, nextSalt, 100000, 64, 'sha512').toString('hex')
  const encrypted = db
    .prepare('SELECT id, password_blob, iv FROM credentials')
    .all()
    .map((row) => ({
      id: row.id,
      ...encryptSecret(decryptOrThrow(row.password_blob, row.iv), nextKey)
    }))
  const totpRows = db
    .prepare("SELECT id, totp_blob, totp_iv FROM apps WHERE totp_blob != ''")
    .all()
    .map((row) => ({
      id: row.id,
      ...encryptSecret(decryptOrThrow(row.totp_blob, row.totp_iv), nextKey)
    }))
  let catalogAttached = false
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    if (db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete')
      throw new Error('无法建立安全的密码修改事务')
    db.prepare('ATTACH DATABASE ? AS account_catalog').run(join(getDbDir(), 'system.db'))
    catalogAttached = true
    if (db.pragma('account_catalog.journal_mode = DELETE', { simple: true }) !== 'delete')
      throw new Error('账号目录正忙，请稍后重试')
    db.pragma('synchronous = FULL')
    db.pragma('account_catalog.synchronous = FULL')
    db.transaction(() => {
      const account = db
        .prepare('SELECT salt, db_filename FROM account_catalog.users WHERE username = ?')
        .get(username)
      if (
        !account ||
        account.salt !== salt ||
        account.db_filename !== dbFilename ||
        join(getDbDir(), dbFilename) !== currentDbPath
      )
        throw new Error('密码库会话已变化')
      for (const row of encrypted)
        db.prepare('UPDATE credentials SET password_blob = ?, iv = ? WHERE id = ?').run(
          row.blob,
          row.iv,
          row.id
        )
      for (const row of totpRows)
        db.prepare('UPDATE apps SET totp_blob = ?, totp_iv = ? WHERE id = ?').run(
          row.blob,
          row.iv,
          row.id
        )
      db.prepare(
        'UPDATE account_catalog.users SET salt = ?, master_password_hash = ? WHERE username = ?'
      ).run(nextSalt, nextHash, username)
    })()
    masterKey.fill(0)
    masterKey = nextKey
    vaultRevision++
  } catch (error) {
    nextKey.fill(0)
    throw error
  } finally {
    if (catalogAttached) {
      db.pragma('account_catalog.journal_mode = WAL')
      db.exec('DETACH DATABASE account_catalog')
    }
    db.pragma('journal_mode = WAL')
  }
}

export function getHistory(app_id) {
  ensureUnlocked()

  return db
    .prepare(
      `SELECT id, username, password_blob, iv, version_tag, is_latest, captured_at
       FROM credentials
       WHERE app_id = ?
       ORDER BY version_tag DESC`
    )
    .all(app_id)
    .map(mapCredentialRow)
}

export function getTotpCode(id) {
  ensureUnlocked()
  const row = db
    .prepare("SELECT totp_blob, totp_iv FROM apps WHERE id = ? AND deleted_at = ''")
    .get(id)
  if (!row?.totp_blob) return null
  return totpCode(JSON.parse(decryptOrThrow(row.totp_blob, row.totp_iv)))
}

export function listCredentialsByIdentity(identity) {
  ensureUnlocked()

  const normalizedIdentity = normalizeText(identity).trim()
  if (!normalizedIdentity) return []

  return db
    .prepare(
      `SELECT a.id AS app_id, a.identity, a.display_name, a.category, a.project_name, a.site_name, a.page_title, a.icon_data,
              c.id AS credential_id, c.username, c.password_blob, c.iv,
              c.version_tag, c.captured_at
       FROM apps a
       INNER JOIN credentials c ON c.app_id = a.id AND c.is_latest = 1
       WHERE a.identity = ? AND a.category = 'web' AND a.deleted_at = ''
       ORDER BY c.username COLLATE NOCASE`
    )
    .all(normalizedIdentity)
    .map(mapCredentialRow)
}

// Icon maintenance never reads credentials or adds a password history version.
export function listMissingSiteIcons() {
  ensureUnlocked()
  return db
    .prepare(
      `SELECT id, identity, display_name, category, site_name, page_title, project_name, site_url, icon_data
     FROM apps WHERE category = 'web' AND deleted_at = '' ORDER BY id`
    )
    .all()
    .filter((row) => !safeIconData(row.icon_data) && websiteAddress(row.site_url || row.identity))
    .map((row) => {
      const site = { ...row }
      delete site.icon_data
      return site
    })
}

export function fillMissingSiteIcon({ id, identity, project_name, icon_data }) {
  ensureUnlocked()
  const icon = safeIconData(icon_data)
  if (!icon) return false
  const existing = db.prepare('SELECT * FROM apps WHERE id = ? AND category = ?').get(id, 'web')
  if (
    !existing ||
    existing.deleted_at ||
    existing.identity !== identity ||
    safeIconData(existing.icon_data) ||
    projectKey(existing) !== projectKey({ project_name })
  )
    return false
  return (
    db
      .prepare('UPDATE apps SET icon_data = ? WHERE id = ? AND icon_data = ?')
      .run(icon, id, existing.icon_data).changes > 0
  )
}

export function exportVaultData(passphrase) {
  ensureUnlocked()
  if (typeof passphrase !== 'string' || passphrase.length < 12) {
    throw new Error('备份口令至少需要 12 个字符')
  }

  const records = listApps().map((record) => ({
    identity: record.identity,
    display_name: record.display_name,
    category: record.category,
    site_name: record.site_name,
    page_title: record.page_title,
    site_url: record.site_url,
    icon_data: record.icon_data,
    project_name: record.project_name,
    username: record.username,
    password: record.password,
    notes: record.notes,
    tags: record.tags,
    favorite: record.favorite,
    totp_secret: record.has_totp
      ? (() => {
          const row = db.prepare('SELECT totp_blob, totp_iv FROM apps WHERE id = ?').get(record.id)
          const config = JSON.parse(decryptOrThrow(row.totp_blob, row.totp_iv))
          return `otpauth://totp/LocalPass?${new URLSearchParams(config)}`
        })()
      : '',
    history: getHistory(record.id).map(({ username, password, version_tag, captured_at }) => ({
      username,
      password,
      version_tag,
      captured_at
    }))
  }))
  const payload = JSON.stringify({ format: 'localpass-export', version: 2, records })
  const salt = randomBytes(16).toString('base64')
  const { blob, iv } = encryptSecret(payload, deriveBackupKey(passphrase, salt))

  return JSON.stringify(
    { format: 'localpass-export', version: 2, encrypted: true, kdf: 'scrypt', salt, blob, iv },
    null,
    2
  )
}

export function importVaultData(serialized, passphrase) {
  ensureUnlocked()
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > 50 * 1024 * 1024) {
    throw new Error('备份文件过大或无效')
  }

  let envelope
  try {
    envelope = JSON.parse(normalizeText(serialized))
  } catch {
    throw new Error('导入文件格式无效')
  }

  if (envelope?.format !== 'localpass-export' || !envelope.encrypted) {
    throw new Error('不是有效的 LocalPass 加密备份')
  }

  let payload
  try {
    let key
    if (envelope.version === 2 && envelope.kdf === 'scrypt') {
      if (typeof passphrase !== 'string' || !passphrase) throw new Error('请输入备份口令')
      if (
        typeof envelope.salt !== 'string' ||
        Buffer.from(envelope.salt, 'base64').length !== 16 ||
        typeof envelope.blob !== 'string' ||
        envelope.blob.length > 70 * 1024 * 1024
      ) {
        throw new Error('Invalid encrypted backup')
      }
      key = deriveBackupKey(passphrase, envelope.salt)
    } else if (envelope.version === 1) {
      key = masterKey
    } else {
      throw new Error('Unsupported backup version')
    }
    payload = JSON.parse(decryptSecret(envelope.blob, envelope.iv, key))
  } catch {
    throw new Error('备份口令错误，或备份文件已损坏')
  }

  if (!Array.isArray(payload?.records)) {
    throw new Error('备份记录无效')
  }

  let imported = 0
  const importedIds = new Set()
  return db.transaction(() => {
    for (const record of payload.records) {
      const identity = normalizeText(record.identity).trim()
      const password = normalizeText(record.password)
      if (!identity || !password) continue

      const username = normalizeUsername(record.username)
      const existing = (
        record.category === 'app' ? listApps() : listCredentialsByIdentity(identity)
      ).find(
        (candidate) =>
          candidate.identity === identity && candidate.category === (record.category === 'app' ? 'app' : 'web') &&
          !importedIds.has(candidate.app_id) &&
          projectKey(candidate) === projectKey(record) &&
          normalizeUsername(candidate.username) === username &&
          candidate.password === password
      )
      let targetId
      if (existing) {
        const id = existing.id ?? existing.app_id
        targetId = Number(id)
        updateApp({ ...record, app_id: id, identity, username, password })
        importedIds.add(id)
      } else {
        const id = createApp({
          ...record,
          identity,
          display_name: normalizeText(record.display_name).trim() || identity,
          category: record.category,
          username,
          password
        })
        targetId = Number(id)
        importedIds.add(Number(id))
      }
      if (Array.isArray(record.history)) {
        if (record.history.length > 10000) throw new Error('密码历史过多，已取消导入')
        const ordered = [...record.history]
          .filter((item) => typeof item.password === 'string' && item.password)
          .sort((a, b) => a.version_tag - b.version_tag)
        if (ordered.length) {
          if (
            ordered.at(-1).password !== password ||
            normalizeUsername(ordered.at(-1).username) !== username
          )
            throw new Error('最新密码与历史不一致，已取消导入')
          if (existing) {
            const current = getHistory(targetId)
            const latest = current.find((row) => row.is_latest)
            const missing = ordered.filter((item) => !current.some((row) => row.password === item.password && normalizeUsername(row.username) === normalizeUsername(item.username) && row.captured_at === item.captured_at))
            if (!missing.length) { imported++; continue }
            const history = [...current.filter((row) => !row.is_latest), ...missing.filter((row) => !(row.password === latest.password && normalizeUsername(row.username) === normalizeUsername(latest.username)))].sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)))
            ordered.splice(0, ordered.length, ...history, latest)
          }
          db.prepare('DELETE FROM credentials WHERE app_id = ?').run(targetId)
        }
        for (const [index, item] of ordered.entries()) {
          const encrypted = encrypt(item.password)
          db.prepare(
            'INSERT INTO credentials (app_id, username, password_blob, iv, version_tag, is_latest, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(
            targetId,
            normalizeUsername(item.username),
            encrypted.blob,
            encrypted.iv,
            index + 1,
            index === ordered.length - 1 ? 1 : 0,
            item.captured_at || new Date().toISOString()
          )
        }
      }
      imported += 1
    }

    return imported
  })()
}
