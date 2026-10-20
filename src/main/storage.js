import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'

let configuredDbDir = null

// Chromium owns sessionData/databases (WebSQL) and removes unregistered files.
// Keep its session tree separate, including while migrating older vaults.
export function isolateBrowserSession() {
  const directory = join(app.getPath('userData'), 'browser-session')
  mkdirSync(directory, { recursive: true })
  app.setPath('sessionData', directory)
}

// Development builds share a project-owned directory outside Vite's output and
// the launcher's redirected AppData. Packaged vaults avoid Chromium's database tree.
export async function initializeStorage({ developmentRoot = app.getAppPath() } = {}) {
  const legacyDir = join(app.getPath('userData'), 'databases')
  const targetDir = app.isPackaged
    ? join(app.getPath('userData'), 'vaults')
    : join(developmentRoot, '.localpass-data', 'databases')

  if (targetDir !== legacyDir && !existsSync(join(targetDir, 'system.db'))) {
    if (existsSync(targetDir) && readdirSync(targetDir).length) {
      throw new Error(`数据目录不完整，已停止初始化以保护现有文件：${targetDir}`)
    }
    if (existsSync(join(legacyDir, 'system.db'))) {
      const parent = app.isPackaged
        ? app.getPath('userData')
        : join(developmentRoot, '.localpass-data')
      mkdirSync(parent, { recursive: true })
      const staging = mkdtempSync(join(parent, 'migration-'))
      // SQLite's backup API includes committed WAL pages. Never copy an open
      // database's main file alone or modify the original account catalog.
      const catalog = new Database(join(legacyDir, 'system.db'), {
        readonly: true,
        fileMustExist: true
      })
      let filenames
      try {
        await catalog.backup(join(staging, 'system.db'))
      } finally {
        catalog.close()
      }
      const snapshot = new Database(join(staging, 'system.db'), {
        readonly: true,
        fileMustExist: true
      })
      try {
        filenames = snapshot
          .prepare('SELECT db_filename FROM users')
          .all()
          .map((row) => row.db_filename)
      } finally {
        snapshot.close()
      }
      for (const filename of new Set(filenames)) {
        if (typeof filename !== 'string' || !/^[\w-]+\.db$/.test(filename)) {
          throw new Error('账号目录中存在无效的密码库文件名，已停止迁移')
        }
        const source = join(legacyDir, filename)
        // A missing vault must remain missing; login will explain how to restore it.
        if (!existsSync(source)) continue
        const vault = new Database(source, { readonly: true, fileMustExist: true })
        try {
          await vault.backup(join(staging, filename))
        } finally {
          vault.close()
        }
      }
      if (existsSync(targetDir)) rmdirSync(targetDir) // Only an empty directory is accepted above.
      renameSync(staging, targetDir)
    }
  }
  mkdirSync(targetDir, { recursive: true })
  configuredDbDir = targetDir
  return targetDir
}

export function getDbDir() {
  const dbDir =
    configuredDbDir || join(app.getPath('userData'), app.isPackaged ? 'vaults' : 'databases')
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }
  return dbDir
}
