import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// Only completed snapshots made in this manager's directory are pruned.
export function createAutomaticBackup({
  directory,
  snapshot,
  notify = () => {},
  now = Date.now,
  retention = 14
}) {
  directory = resolve(directory)
  let running = null
  let lastAt = 0
  let state = { lastAt: null, error: '', directory }
  const status = () => ({ ...state, busy: Boolean(running) })
  async function completed() {
    await mkdir(directory, { recursive: true })
    const entries = await readdir(directory, { withFileTypes: true })
    const valid = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d+-[a-f0-9-]{36}$/.test(entry.name))
        continue
      const path = resolve(directory, entry.name)
      if (dirname(path) !== directory) continue
      try {
        const manifest = JSON.parse(await readFile(join(path, 'snapshot.json'), 'utf8'))
        if (manifest.version === 1 && Array.isArray(manifest.vaults))
          valid.push({ path, at: Date.parse(manifest.createdAt) })
      } catch {
        /* Incomplete backups never displace a good backup. */
      }
    }
    return valid.sort((a, b) => b.at - a.at)
  }
  return {
    status,
    async initialize() {
      const entries = await completed()
      lastAt = entries[0]?.at || 0
      state.lastAt = lastAt || null
      return status()
    },
    run({ force = false } = {}) {
      if (running) return running
      if (!force && now() - lastAt < 60 * 60 * 1000) return Promise.resolve(status())
      running = (async () => {
        try {
          const destination = join(directory, `${now()}-${randomUUID()}`)
          await snapshot({ destination })
          lastAt = now()
          state = { ...state, lastAt, error: '' }
          const entries = await completed()
          for (const entry of entries.slice(retention))
            await rm(entry.path, { recursive: true, force: true })
        } catch (error) {
          const message = error.message || '自动备份失败'
          if (state.error !== message) notify(message)
          state.error = message
        } finally {
          running = null
        }
        return status()
      })()
      return running
    }
  }
}
