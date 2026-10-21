import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Only the main process handles this Windows-user-protected key. A capsule alone
// never unlocks a vault: a fresh, single-use installer handoff is also required.
export function createUpdateSession({
  folder,
  safeStorage,
  now = Date.now,
  platform = process.platform
}) {
  const capsule = join(folder, 'update-session.bin')
  const marker = join(folder, 'update-resume.marker')
  const remove = (file) => rmSync(file, { force: true })
  function pending() {
    try {
      const age = now() - statSync(marker).mtimeMs
      return existsSync(capsule) && age >= -5000 && age <= 15 * 60 * 1000
    } catch {
      return false
    }
  }
  function clear() {
    remove(capsule)
    remove(capsule + '.tmp')
    remove(marker)
  }
  function remember(account, key) {
    clear()
    try {
      if (platform !== 'win32' || !safeStorage.isEncryptionAvailable()) return false
      const encrypted = safeStorage.encryptString(
        JSON.stringify({ schema: 1, account, key: key.toString('base64') })
      )
      writeFileSync(capsule + '.tmp', encrypted, { mode: 0o600 })
      renameSync(capsule + '.tmp', capsule)
      return true
    } catch {
      clear()
      return false
    } finally {
      key.fill(0)
    }
  }
  return {
    clear,
    remember,
    pending,
    prepare() {
      if (!existsSync(capsule)) return false
      writeFileSync(marker, 'LocalPass update', { mode: 0o600 })
      return true
    },
    restore(validate, unlock) {
      let key
      try {
        const age = now() - statSync(marker).mtimeMs
        remove(marker) // Consume before decrypting, including on every failure.
        if (
          platform !== 'win32' ||
          age < -5000 ||
          age > 15 * 60 * 1000 ||
          !safeStorage.isEncryptionAvailable()
        ) {
          clear()
          return null
        }
        const bytes = readFileSync(capsule)
        clear()
        const value = JSON.parse(safeStorage.decryptString(bytes))
        if (value.schema !== 1 || !validate(value.account)) return null
        key = Buffer.from(value.key, 'base64')
        if (key.length !== 32) return null
        unlock(value.account, key)
        remember(value.account, key)
        return value.account
      } catch {
        clear()
        return null
      } finally {
        key?.fill(0)
      }
    }
  }
}
