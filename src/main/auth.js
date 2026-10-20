import Database from 'better-sqlite3'
import { pbkdf2Sync, randomBytes, randomUUID } from 'crypto'
import { join } from 'path'

import { getDbDir } from './storage.js'

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

export function registerUser(username, password, initializeVault) {
  if (!systemDb) initSystemDb()

  const normalizedUsername = normalizeUsername(username)
  const normalizedPassword = password == null ? '' : String(password)
  if (!normalizedUsername) {
    return { success: false, error: '请输入用户名' }
  }
  if (!normalizedPassword) {
    return { success: false, error: '主密码不能为空' }
  }

  const checkUser = systemDb
    .prepare('SELECT username FROM users WHERE username = ?')
    .get(normalizedUsername)
  if (checkUser) {
    return { success: false, error: '此账号已存在，请切换到登录；如提示密码库缺失，请恢复原文件。' }
  }

  const salt = randomBytes(16).toString('hex')
  const hash = hashPassword(normalizedPassword, salt)
  const userId = randomUUID()
  const dbFilename = `user_${userId}.db`
  const result = { success: true, userId, username: normalizedUsername, dbFilename, salt }

  try {
    if (typeof initializeVault !== 'function') throw new Error('无法初始化密码库，账号尚未创建')
    return systemDb.transaction(() => {
      systemDb
        .prepare(
          `
        INSERT INTO users (id, username, master_password_hash, salt, db_filename)
        VALUES (?, ?, ?, ?, ?)
      `
        )
        .run(userId, normalizedUsername, hash, salt, dbFilename)
      // Never commit an account until its vault has been successfully initialized.
      const initialized = initializeVault(result)
      if (initialized?.then) throw new Error('密码库初始化必须同步完成')
      return result
    })()
  } catch (error) {
    return { success: false, error: error.message }
  }
}

export function loginUser(username, password) {
  if (!systemDb) initSystemDb()

  const normalizedUsername = normalizeUsername(username)
  const normalizedPassword = password == null ? '' : String(password)
  if (!normalizedUsername) {
    return { success: false, error: '请输入用户名' }
  }
  if (!normalizedPassword) {
    return { success: false, error: '主密码不能为空' }
  }

  const user = systemDb.prepare('SELECT * FROM users WHERE username = ?').get(normalizedUsername)
  if (!user) {
    return { success: false, error: '找不到此账号，请确认用户名或选择原来的密码库目录' }
  }

  const hash = hashPassword(normalizedPassword, user.salt)
  if (hash !== user.master_password_hash) {
    return { success: false, error: '主密码不正确，请使用创建此密码库时设置的主密码' }
  }

  return {
    success: true,
    userId: user.id,
    username: normalizedUsername,
    dbFilename: user.db_filename,
    salt: user.salt
  }
}

export function closeSystemDb() {
  systemDb?.close()
  systemDb = null
}
