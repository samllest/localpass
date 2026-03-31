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

function mapCredentialRow(row) {
  return {
    ...row,
    password: row.password_blob ? safeDecrypt(row.password_blob, row.iv) : ''
  }
}

export function initDB(dbFilename) {
  if (!dbFilename) {
    throw new Error('dbFilename is required')
  }

  closeVault()

  currentDbPath = join(getDbDir(), dbFilename)
  db = new Database(currentDbPath)
  db.pragma('journal_mode = WAL')
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
  `)

  return currentDbPath
}

export function findAppByIdentity(identity) {
  ensureVaultOpen()

  const row = db
    .prepare(
      `SELECT a.id, a.identity, a.display_name, a.category, a.created_at,
              c.username, c.password_blob, c.iv, c.version_tag, c.captured_at
       FROM apps a
       LEFT JOIN credentials c ON c.app_id = a.id AND c.is_latest = 1
       WHERE a.identity = ?`
    )
    .get(identity)

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

  return db
    .prepare(
      `SELECT a.id, a.identity, a.display_name, a.category, a.created_at,
              c.username, c.password_blob, c.iv, c.version_tag, c.captured_at
       FROM apps a
       LEFT JOIN credentials c ON c.app_id = a.id AND c.is_latest = 1
       WHERE CAST(a.id AS TEXT) LIKE ? OR a.display_name LIKE ? OR a.identity LIKE ?
       ORDER BY a.id DESC`
    )
    .all(`%${query}%`, `%${query}%`, `%${query}%`)
    .map(mapCredentialRow)
}

export function createApp({ identity, display_name, category = 'web', username, password }) {
  ensureUnlocked()

  const { blob, iv } = encrypt(password)
  const storedIdentity = normalizeText(identity || display_name).trim()
  const storedDisplayName = normalizeText(display_name).trim()
  const storedUsername = normalizeUsername(username)

  const insertApp = db.prepare(
    `INSERT INTO apps (identity, display_name, category) VALUES (?, ?, ?)`
  )
  const insertCred = db.prepare(
    `INSERT INTO credentials (app_id, username, password_blob, iv, version_tag, is_latest)
     VALUES (?, ?, ?, ?, 1, 1)`
  )

  return db.transaction(() => {
    const appResult = insertApp.run(storedIdentity, storedDisplayName, category)
    insertCred.run(appResult.lastInsertRowid, storedUsername, blob, iv)
    return appResult.lastInsertRowid
  })()
}

export function updateCredential({ app_id, username, password }) {
  ensureUnlocked()

  const storedUsername = normalizeUsername(username)
  const nextPassword = normalizeText(password)
  const latest = db
    .prepare(
      `SELECT id, username, password_blob, iv, version_tag
       FROM credentials
       WHERE app_id = ? AND is_latest = 1
       ORDER BY version_tag DESC
       LIMIT 1`
    )
    .get(app_id)

  if (latest) {
    const sameUsername = normalizeText(latest.username) === normalizeText(storedUsername)
    const samePassword = safeDecrypt(latest.password_blob, latest.iv) === nextPassword

    if (sameUsername && samePassword) {
      return { updated: false, version_tag: latest.version_tag }
    }
  }

  const { blob, iv } = encrypt(nextPassword)
  const maxVersion = db
    .prepare(`SELECT MAX(version_tag) AS mv FROM credentials WHERE app_id = ?`)
    .get(app_id)
  const nextVersion = (maxVersion?.mv || 0) + 1

  db.transaction(() => {
    db.prepare(`UPDATE credentials SET is_latest = 0 WHERE app_id = ? AND is_latest = 1`).run(app_id)
    db.prepare(
      `INSERT INTO credentials (app_id, username, password_blob, iv, version_tag, is_latest)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(app_id, storedUsername, blob, iv, nextVersion)
  })()

  return { updated: true, version_tag: nextVersion }
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
