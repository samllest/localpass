import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const UNLOCK_DURATION_MS = 31 * 24 * 60 * 60 * 1000
export const IDLE_LOCK_MINUTES = 3 * 24 * 60

// Only the main process sees the key. The saved session is protected by the
// current Windows account; neither the master password nor a plaintext key is saved.
export function createUnlockSession({
  folder,
  safeStorage,
  now = Date.now,
  platform = process.platform,
  idleMinutes = () => IDLE_LOCK_MINUTES
}) {
  const file = join(folder, 'unlock-session.bin')
  let active = null
  const available = () => platform === 'win32' && safeStorage.isEncryptionAvailable()
  const remove = () => {
    rmSync(file, { force: true })
    rmSync(file + '.tmp', { force: true })
  }
  function clear() {
    active = null
    remove()
  }
  function valid(value) {
    const at = now()
    return (
      value?.schema === 1 &&
      Number.isFinite(value.createdAt) &&
      Number.isFinite(value.lastActivityAt) &&
      value.createdAt <= value.lastActivityAt &&
      value.lastActivityAt <= at + 5000 &&
      value.expiresAt === value.createdAt + UNLOCK_DURATION_MS &&
      at < value.expiresAt &&
      at - value.lastActivityAt < idleMinutes() * 60 * 1000
    )
  }
  function persist(value) {
    if (!available()) return false
    writeFileSync(file + '.tmp', safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 })
    renameSync(file + '.tmp', file)
    return true
  }
  function metadata(value) {
    const { schema, account, createdAt, lastActivityAt, expiresAt } = value
    return { schema, account, createdAt, lastActivityAt, expiresAt }
  }
  return {
    clear,
    hasSavedSession: () => existsSync(file),
    expired: () => !valid(active),
    status: () => active && metadata(active),
    remember(account, key) {
      clear()
      const at = now()
      active = {
        schema: 1,
        account,
        createdAt: at,
        lastActivityAt: at,
        expiresAt: at + UNLOCK_DURATION_MS
      }
      try {
        return persist({ ...active, key: key.toString('base64') })
      } catch {
        remove()
        return false
      } finally {
        key.fill(0)
      }
    },
    restore(validate, unlock) {
      let key
      try {
        if (!available()) throw new Error('Protected storage unavailable')
        const value = JSON.parse(safeStorage.decryptString(readFileSync(file)))
        if (!valid(value) || !validate(value.account)) throw new Error('Session expired or changed')
        key = Buffer.from(value.key, 'base64')
        if (key.length !== 32) throw new Error('Invalid session key')
        unlock(value.account, key)
        active = metadata(value)
        return value.account
      } catch {
        clear()
        return null
      } finally {
        key?.fill(0)
      }
    },
    touch() {
      // An input arriving after the deadline cannot revive an expired session.
      if (!valid(active)) return false
      active.lastActivityAt = now()
      try {
        if (available() && existsSync(file)) {
          const value = JSON.parse(safeStorage.decryptString(readFileSync(file)))
          if (value.expiresAt !== active.expiresAt) throw new Error('Session changed')
          persist({ ...value, lastActivityAt: active.lastActivityAt })
        }
      } catch {
        remove()
      }
      return true
    }
  }
}
