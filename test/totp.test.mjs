import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTotp, totpCode } from '../src/main/totp.js'
test('TOTP matches RFC 6238 SHA-1 vectors and respects digit/period configuration', () => {
  const config = parseTotp('otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8')
  for (const [time, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']]) assert.equal(totpCode(config, time * 1000).code, code)
  assert.equal(totpCode(config, 59000).remaining, 1)
  assert.throws(() => parseTotp('not-a-valid-secret'), /无效/)
  assert.throws(() => parseTotp('otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQ'), /TOTP/)
})
