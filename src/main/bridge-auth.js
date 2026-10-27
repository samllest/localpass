import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function loadBridgeSecret(directory) {
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'bridge-secret')
  try {
    const secret = (await readFile(file, 'utf8')).trim()
    if (/^[a-f0-9]{64}$/.test(secret)) return secret
    throw new Error('浏览器连接密钥文件损坏')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const secret = randomBytes(32).toString('hex')
  try {
    await writeFile(file, secret, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return loadBridgeSecret(directory)
  }
  return secret
}

export function authorizeBridgeRequest(req, secret) {
  const origin = req.headers.origin
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false
  const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '')
  const left = Buffer.from(supplied)
  const right = Buffer.from(secret || '')
  return right.length >= 32 && left.length === right.length && timingSafeEqual(left, right)
}
