import { existsSync, mkdirSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'

export function getDbDir() {
  const dbDir = join(app.getPath('userData'), 'databases')
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }
  return dbDir
}
