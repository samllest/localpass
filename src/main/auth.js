import Database from 'better-sqlite3'
import { pbkdf2Sync, randomBytes, randomUUID } from 'crypto'
import { join } from 'path'

import { getDbDir } from './storage'

let systemDb = null

function normalizeUsername(value) {
  return value == null ? '' : String(value).trim()
}

export function initSystemDb() {
  if (systemDb) return

  const dbPath = join(getDbDir(), 'system.db')
  systemDb = new Database(dbPath)
  systemDb.pragma('journal_mode = WAL')
  systemDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      master_password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      db_filename TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

function hashPassword(password, salt) {
  return pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
}

export function registerUser(username, password) {
  if (!systemDb) initSystemDb()

  const normalizedUsername = normalizeUsername(username)
  const normalizedPassword = password == null ? '' : String(password)
  if (!normalizedUsername) {
    return { success: false, error: 'Username is required' }
  }
  if (!normalizedPassword) {
    return { success: false, error: 'Password is required' }
  }

  const checkUser = systemDb
    .prepare('SELECT username FROM users WHERE username = ?')
    .get(normalizedUsername)
  if (checkUser) {
    return { success: false, error: 'User already exists' }
  }

  const salt = randomBytes(16).toString('hex')
  const hash = hashPassword(normalizedPassword, salt)
  const userId = randomUUID()
  const dbFilename = `user_${userId}.db`

  try {
    systemDb.prepare(`
      INSERT INTO users (id, username, master_password_hash, salt, db_filename)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, normalizedUsername, hash, salt, dbFilename)

    return { success: true, userId, username: normalizedUsername, dbFilename, salt }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

export function loginUser(username, password) {
  if (!systemDb) initSystemDb()

  const normalizedUsername = normalizeUsername(username)
  const normalizedPassword = password == null ? '' : String(password)
  if (!normalizedUsername) {
    return { success: false, error: 'Username is required' }
  }
  if (!normalizedPassword) {
    return { success: false, error: 'Password is required' }
  }

  const user = systemDb.prepare('SELECT * FROM users WHERE username = ?').get(normalizedUsername)
  if (!user) {
    return { success: false, error: 'User not found' }
  }

  const hash = hashPassword(normalizedPassword, user.salt)
  if (hash !== user.master_password_hash) {
    return { success: false, error: 'Invalid password' }
  }

  return {
    success: true,
    userId: user.id,
    username: normalizedUsername,
    dbFilename: user.db_filename,
    salt: user.salt
  }
}
