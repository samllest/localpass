import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  createUnlockSession,
  UNLOCK_DURATION_MS,
  IDLE_LOCK_MINUTES
} from '../src/main/unlock-session.js'

const DAY = 24 * 60 * 60 * 1000
const account = { username: 'fixture', dbFilename: 'user_fixture.db', fingerprint: 'unchanged' }
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'localpass-unlock-test-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  let at = Date.now()
  const encryptionKey = randomBytes(32)
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()])
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(-16))
      return cipher.update(value.subarray(12, -16), undefined, 'utf8') + cipher.final('utf8')
    }
  }
  const options = { folder, safeStorage, platform: 'win32', now: () => at }
  const key = randomBytes(32)
  const expected = Buffer.from(key)
  const session = createUnlockSession(options)
  session.remember(account, key)
  assert.ok(key.every((byte) => byte === 0))
  return {
    session,
    options,
    expected,
    advance: (ms) => {
      at += ms
    },
    file: join(folder, 'unlock-session.bin')
  }
}

test('protected sessions survive restart without extending either deadline', (t) => {
  const f = fixture(t)
  assert.equal(UNLOCK_DURATION_MS, 31 * DAY)
  assert.equal(IDLE_LOCK_MINUTES * 60000, 3 * DAY)
  assert.equal(readFileSync(f.file).includes(f.expected), false)
  const original = f.session.status()
  f.advance(2 * DAY)
  const restarted = createUnlockSession(f.options)
  let restoredKey
  assert.deepEqual(
    restarted.restore(
      () => true,
      (a, key) => {
        assert.deepEqual(a, account)
        assert.deepEqual(key, f.expected)
        restoredKey = key
      }
    ),
    account
  )
  assert.ok(restoredKey.every((byte) => byte === 0))
  assert.deepEqual(restarted.status(), original)
  f.advance(DAY)
  assert.equal(restarted.expired(), true)
  assert.equal(restarted.touch(), false)
  const again = createUnlockSession(f.options)
  assert.equal(
    again.restore(
      () => true,
      () => assert.fail('idle session restored')
    ),
    null
  )
  assert.equal(existsSync(f.file), false)
})

test('activity persists the idle deadline but never extends the 31 day authentication limit', (t) => {
  const f = fixture(t)
  const originalExpiry = f.session.status().expiresAt
  for (let day = 1; day <= 30; day++) {
    f.advance(DAY)
    assert.equal(f.session.touch(), true)
    assert.equal(f.session.status().expiresAt, originalExpiry)
  }
  const restarted = createUnlockSession(f.options)
  assert.deepEqual(
    restarted.restore(
      () => true,
      () => {}
    ),
    account
  )
  f.advance(DAY)
  assert.equal(restarted.expired(), true)
  assert.equal(restarted.touch(), false)
})

for (const condition of ['manual lock', 'changed account', 'corrupt', 'unavailable', 'future']) {
  test(`cannot resume after ${condition}`, (t) => {
    const f = fixture(t)
    if (condition === 'manual lock') f.session.clear()
    if (condition === 'corrupt') writeFileSync(f.file, 'corrupt')
    if (condition === 'unavailable') f.options.safeStorage.isEncryptionAvailable = () => false
    if (condition === 'future') f.advance(-60000)
    const restarted = createUnlockSession(f.options)
    assert.equal(
      restarted.restore(
        () => condition !== 'changed account',
        () => assert.fail('invalid session restored')
      ),
      null
    )
    assert.equal(existsSync(f.file), false)
  })
}

test('shorter configured inactivity limits use app activity rather than system idle time', (t) => {
  const f = fixture(t)
  const session = createUnlockSession({ ...f.options, idleMinutes: () => 5 })
  assert.deepEqual(
    session.restore(
      () => true,
      () => {}
    ),
    account
  )
  f.advance(4 * 60000)
  assert.equal(session.touch(), true)
  f.advance(5 * 60000)
  assert.equal(session.expired(), true)
})
