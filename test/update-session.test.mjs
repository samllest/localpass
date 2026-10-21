import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createUpdateSession } from '../src/main/update-session.js'

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'localpass-update-session-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
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
  return {
    folder,
    safeStorage,
    session: createUpdateSession({ folder, safeStorage, platform: 'win32' })
  }
}
const account = { username: 'fixture', dbFilename: 'user_fixture.db', fingerprint: 'unchanged' }

test('update resumes once, preserves future handoffs and wipes key copies', (t) => {
  const { session, folder } = fixture(t)
  const key = randomBytes(32)
  const expected = Buffer.from(key)
  assert.equal(session.remember(account, key), true)
  assert.ok(key.every((byte) => byte === 0))
  assert.equal(session.prepare(), true)
  let restored = false
  assert.deepEqual(
    session.restore(
      (a) => a.fingerprint === account.fingerprint,
      (a, k) => {
        assert.deepEqual(a, account)
        assert.deepEqual(k, expected)
        assert.equal(existsSync(join(folder, 'update-resume.marker')), false)
        restored = true
      }
    ),
    account
  )
  assert.ok(restored)
  assert.ok(existsSync(join(folder, 'update-session.bin')))
  assert.equal(
    session.restore(
      () => true,
      () => assert.fail('marker reused')
    ),
    null
  )
  assert.equal(existsSync(join(folder, 'update-session.bin')), false)
})

test('ordinary starts, manual lock and ordinary exit cannot restore a capsule', (t) => {
  const { session, folder } = fixture(t)
  session.remember(account, randomBytes(32))
  assert.equal(
    session.restore(
      () => true,
      () => assert.fail('ordinary start unlocked')
    ),
    null
  )
  session.remember(account, randomBytes(32))
  session.prepare()
  session.clear()
  assert.equal(existsSync(join(folder, 'update-resume.marker')), false)
  assert.equal(
    session.restore(
      () => true,
      () => assert.fail('locked vault unlocked')
    ),
    null
  )
})

for (const condition of ['expired', 'future', 'changed account', 'corrupt', 'unavailable']) {
  test(`rejects ${condition} handoffs and consumes their files`, (t) => {
    const { session, folder, safeStorage } = fixture(t)
    session.remember(account, randomBytes(32))
    session.prepare()
    if (condition === 'expired' || condition === 'future') {
      const time = new Date(Date.now() + (condition === 'future' ? 60000 : -16 * 60000))
      utimesSync(join(folder, 'update-resume.marker'), time, time)
    }
    if (condition === 'corrupt') writeFileSync(join(folder, 'update-session.bin'), 'corrupt')
    if (condition === 'unavailable') safeStorage.isEncryptionAvailable = () => false
    assert.equal(
      session.restore(
        () => condition !== 'changed account',
        () => assert.fail('invalid handoff unlocked')
      ),
      null
    )
    assert.equal(existsSync(join(folder, 'update-resume.marker')), false)
    assert.equal(existsSync(join(folder, 'update-session.bin')), false)
  })
}
