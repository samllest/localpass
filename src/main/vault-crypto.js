import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

const AUTH_TAG_BYTES = 16

export function deriveVaultKey(password, salt) {
  if (!password || !salt) throw new Error('Password and salt are required')
  return scryptSync(String(password), `localpass-vault:${salt}`, 32)
}

export function deriveBackupKey(passphrase, salt) {
  if (!passphrase || !salt) throw new Error('Backup passphrase and salt are required')
  return scryptSync(String(passphrase), `localpass-backup:v2:${salt}`, 32)
}

export function encryptSecret(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte vault key is required')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(plaintext ?? ''), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { blob: Buffer.concat([encrypted, tag]).toString('base64'), iv: iv.toString('base64') }
}

export function decryptSecret(blob, ivBase64, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte vault key is required')
  const iv = Buffer.from(ivBase64, 'base64')
  const data = Buffer.from(blob, 'base64')
  if (data.length < AUTH_TAG_BYTES) throw new Error('Encrypted payload is invalid')
  const tag = data.subarray(data.length - AUTH_TAG_BYTES)
  const encrypted = data.subarray(0, data.length - AUTH_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8')
}
