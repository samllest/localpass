import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { existsSync } from 'fs'

import { getDbDir } from './storage.js'
import { decryptSecret, deriveBackupKey, deriveVaultKey, encryptSecret } from './vault-crypto.js'
import { normalizeSiteMetadata } from '../shared/site-metadata.js'
import { isDevelopmentSite, projectKey } from '../shared/project-matching.js'

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
  ensureVaultOpen()

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
       WHERE a.identity = ?
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
  ensureVaultOpen()

  return db
    .prepare(
      `SELECT a.id, a.id AS app_id, a.identity, a.display_name, a.category, a.created_at, a.site_name, a.page_title, a.site_url, a.icon_data, a.project_name,
              c.id AS credential_id, c.username, c.password_blob, c.iv,
              c.version_tag, c.captured_at
       FROM apps a
       LEFT JOIN credentials c ON c.app_id = a.id AND c.is_latest = 1
       ORDER BY a.id DESC`
    )
    .all()
    .map(mapCredentialRow)
}

export function searchApps(query) {
  ensureVaultOpen()

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
       WHERE CAST(a.id AS TEXT) LIKE ? OR a.display_name LIKE ? OR a.identity LIKE ?
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
    insertCred.run(appResult.lastInsertRowid, storedUsername, blob, iv)
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
  if (!existingApp) {
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
    const metadataChanged =
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
  ensureVaultOpen()

  db.transaction(() => {
    db.prepare(`DELETE FROM credentials WHERE app_id = ?`).run(app_id)
    db.prepare(`DELETE FROM apps WHERE id = ?`).run(app_id)
  })()
}

export function getHistory(app_id) {
  ensureVaultOpen()

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
       WHERE a.identity = ?
       ORDER BY c.username COLLATE NOCASE`
    )
    .all(normalizedIdentity)
    .map(mapCredentialRow)
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
    password: record.password
  }))
  const payload = JSON.stringify({ format: 'localpass-export', version: 1, records })
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
  for (const record of payload.records) {
    const identity = normalizeText(record.identity).trim()
    const password = normalizeText(record.password)
    if (!identity || !password) continue

    const username = normalizeUsername(record.username)
    const existing = isDevelopmentSite(identity)
      ? listCredentialsByIdentity(identity).find(
          (candidate) =>
            !importedIds.has(candidate.app_id) &&
            projectKey(candidate) === projectKey(record) &&
            normalizeUsername(candidate.username) === username &&
            candidate.password === password
        )
      : findAppByIdentity(identity, username, record)
    if (existing) {
      const id = existing.id ?? existing.app_id
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
      importedIds.add(Number(id))
    }
    imported += 1
  }

  return imported
}
