import Database from 'better-sqlite3'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { join } from 'path'

import { getDbDir } from './storage'

let db = null
let masterKey = null
let currentDbPath = null

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
  masterKey = scryptSync(password, `localpass-vault:${salt}`, 32)
}

export function clearMasterKey() {
  masterKey = null
}

export function closeVault() {
  if (db) {
    db.close()
    db = null
    currentDbPath = null
  }
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

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const encrypted = Buffer.concat([cipher.update(normalizeText(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    blob: Buffer.concat([encrypted, tag]).toString('base64'),
    iv: iv.toString('base64')
  }
}

function decrypt(blob, ivB64) {
  ensureUnlocked()

  const iv = Buffer.from(ivB64, 'base64')
  const data = Buffer.from(blob, 'base64')
  const tag = data.slice(data.length - 16)
  const encrypted = data.slice(0, data.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
  decipher.setAuthTag(tag)

  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8')
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

export function initDB(dbFilename) {
  if (!dbFilename) {
    throw new Error('dbFilename is required')
  }

  closeVault()

  currentDbPath = join(getDbDir(), dbFilename)
  db = new Database(currentDbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity TEXT UNIQUE,
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
      FOREIGN KEY (app_id) REFERENCES apps(id)
    );

    CREATE INDEX IF NOT EXISTS idx_credentials_latest
    ON credentials(app_id, is_latest, version_tag DESC);

    CREATE INDEX IF NOT EXISTS idx_credentials_history
    ON credentials(app_id, version_tag DESC);
  `)

  return currentDbPath
}

export function findAppByIdentity(identity) {
  ensureVaultOpen()

  const normalizedIdentity = normalizeText(identity).trim()
  if (!normalizedIdentity) {
    return null
  }

  const row = db
    .prepare(
      `SELECT a.id, a.identity, a.display_name, a.category, a.created_at,
              c.username, c.password_blob, c.iv, c.version_tag, c.captured_at
       FROM apps a
       LEFT JOIN credentials c ON c.app_id = a.id AND c.is_latest = 1
       WHERE a.identity = ?`
    )
    .get(normalizedIdentity)

  return row ? mapCredentialRow(row) : null
}

export function listApps() {
  ensureVaultOpen()

  return db
    .prepare(
      `SELECT a.id, a.identity, a.display_name, a.category, a.created_at,
              c.username, c.password_blob, c.iv, c.version_tag, c.captured_at
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
      `SELECT a.id, a.identity, a.display_name, a.category, a.created_at,
              c.username, c.password_blob, c.iv, c.version_tag, c.captured_at
       FROM apps a
       LEFT JOIN credentials c ON c.app_id = a.id AND c.is_latest = 1
       WHERE CAST(a.id AS TEXT) LIKE ? OR a.display_name LIKE ? OR a.identity LIKE ?
       ORDER BY a.id DESC`
    )
    .all(`%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`)
    .map(mapCredentialRow)
}

export function createApp({ identity, display_name, category = 'web', username, password }) {
  ensureUnlocked()

  const appFields = normalizeAppFields({ identity, display_name, category })
  const nextPassword = normalizeText(password)
  if (!nextPassword) {
    throw new Error('Password is required')
  }

  const { blob, iv } = encrypt(nextPassword)
  const storedUsername = normalizeUsername(username)

  const insertApp = db.prepare(
    `INSERT INTO apps (identity, display_name, category) VALUES (?, ?, ?)`
  )
  const insertCred = db.prepare(
    `INSERT INTO credentials (app_id, username, password_blob, iv, version_tag, is_latest)
     VALUES (?, ?, ?, ?, 1, 1)`
  )

  return db.transaction(() => {
    const appResult = insertApp.run(appFields.identity, appFields.display_name, appFields.category)
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

export function updateApp({ app_id, display_name, identity, category, username, password }) {
  ensureUnlocked()

  const appId = Number(app_id)
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error('Invalid app id')
  }

  const existingApp = db
    .prepare(`SELECT id, identity, display_name, category FROM apps WHERE id = ?`)
    .get(appId)
  if (!existingApp) {
    throw new Error('App not found')
  }

  const nextAppFields = normalizeAppFields({
    identity: identity ?? existingApp.identity,
    display_name: display_name ?? existingApp.display_name,
    category: category ?? existingApp.category
  })

  return db.transaction(() => {
    const metadataChanged =
      existingApp.identity !== nextAppFields.identity ||
      existingApp.display_name !== nextAppFields.display_name ||
      existingApp.category !== nextAppFields.category

    if (metadataChanged) {
      db.prepare(`UPDATE apps SET identity = ?, display_name = ?, category = ? WHERE id = ?`).run(
        nextAppFields.identity,
        nextAppFields.display_name,
        nextAppFields.category,
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
