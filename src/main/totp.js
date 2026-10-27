import { createHmac } from 'node:crypto'

export function parseTotp(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('验证码密钥无效')
  let secret = value.replace(/[\s-]/g, '').toUpperCase(),
    digits = 6,
    period = 30,
    algorithm = 'SHA1'
  if (value.startsWith('otpauth://')) {
    const url = new URL(value)
    if (url.hostname !== 'totp') throw new Error('仅支持 TOTP 动态验证码')
    secret = String(url.searchParams.get('secret') || '')
      .replace(/\s/g, '')
      .toUpperCase()
    digits = Number(url.searchParams.get('digits') || 6)
    period = Number(url.searchParams.get('period') || 30)
    algorithm = String(url.searchParams.get('algorithm') || 'SHA1').toUpperCase()
  }
  if (
    !/^[A-Z2-7]{16,256}={0,6}$/.test(secret) ||
    ![6, 8].includes(digits) ||
    ![15, 30, 60].includes(period) ||
    !['SHA1', 'SHA256', 'SHA512'].includes(algorithm)
  )
    throw new Error('验证码密钥或参数无效')
  return { secret: secret.replace(/=+$/, ''), digits, period, algorithm }
}

export function totpCode(config, now = Date.now()) {
  const { secret, digits, period, algorithm } =
    typeof config === 'string' ? parseTotp(config) : config
  let bits = 0,
    count = 0
  const bytes = []
  for (const character of secret) {
    bits = (bits << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character)
    count += 5
    if (count >= 8) {
      count -= 8
      bytes.push((bits >>> count) & 255)
    }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)))
  const key = Buffer.from(bytes)
  const hash = createHmac(algorithm.toLowerCase(), key).update(counter).digest()
  key.fill(0)
  const offset = hash.at(-1) & 15
  const value = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return {
    code: String(value).padStart(digits, '0'),
    remaining: period - (Math.floor(now / 1000) % period),
    period
  }
}
