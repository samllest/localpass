import assert from 'node:assert/strict'
import test from 'node:test'

import { decryptSecret, deriveVaultKey, encryptSecret } from '../src/main/vault-crypto.js'

test('encrypted secrets round-trip without storing plaintext', () => {
  const key = deriveVaultKey('correct horse battery staple', 'test-salt')
  const encrypted = encryptSecret('sensitive-password', key)

  assert.notEqual(encrypted.blob, 'sensitive-password')
  assert.equal(decryptSecret(encrypted.blob, encrypted.iv, key), 'sensitive-password')
})

test('the same secret uses a fresh initialization vector', () => {
  const key = deriveVaultKey('master-password', 'test-salt')
  const first = encryptSecret('same-secret', key)
  const second = encryptSecret('same-secret', key)

  assert.notEqual(first.iv, second.iv)
  assert.notEqual(first.blob, second.blob)
})

test('a different vault key cannot decrypt a secret', () => {
  const encrypted = encryptSecret('secret', deriveVaultKey('first-password', 'test-salt'))

  assert.throws(() => {
    decryptSecret(encrypted.blob, encrypted.iv, deriveVaultKey('second-password', 'test-salt'))
  })
})
