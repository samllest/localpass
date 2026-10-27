import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { getDbDir } from './storage.js'

// SQLite backup includes committed WAL pages, unlike copying only the .db file.
export async function createStorageSnapshot({
  source = getDbDir(),
  destination = join(
    app.getPath('userData'),
    'recovery',
    'updates',
    `${Date.now()}-${randomUUID()}`
  )
} = {}) {
  try {
    mkdirSync(destination, { recursive: true })
    const catalog = new Database(join(source, 'system.db'), { readonly: true, fileMustExist: true })
    try {
      await catalog.backup(join(destination, 'system.db'))
    } finally {
      catalog.close()
    }
    const copiedCatalog = new Database(join(destination, 'system.db'), {
      readonly: true,
      fileMustExist: true
    })
    let filenames
    try {
      filenames = copiedCatalog
        .prepare('SELECT db_filename FROM users')
        .all()
        .map((row) => row.db_filename)
    } finally {
      copiedCatalog.close()
    }
    for (const filename of new Set(filenames)) {
      if (
        typeof filename !== 'string' ||
        !/^[\w-]+\.db$/.test(filename) ||
        !existsSync(join(source, filename))
      )
        throw new Error('A catalogued vault is missing or invalid')
      const vault = new Database(join(source, filename), { readonly: true, fileMustExist: true })
      try {
        await vault.backup(join(destination, filename))
      } finally {
        vault.close()
      }
    }
    writeFileSync(
      join(destination, 'snapshot.json'),
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        vaults: [...new Set(filenames)]
      }),
      'utf8'
    )
    return destination
  } catch (cause) {
    throw Object.assign(
      new Error('本地密码库备份失败。请检查文件是否完整，以及磁盘空间和文件权限。', {
        cause
      }),
      { code: 'ERR_VAULT_BACKUP' }
    )
  }
}
