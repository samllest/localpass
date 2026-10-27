import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBridgeSecret, authorizeBridgeRequest } from '../src/main/bridge-auth.js'

test('bridge secret persists and requests require a matching bearer secret and trusted origin', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'localpass-bridge-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const secret = await loadBridgeSecret(directory)
  assert.equal(secret, await loadBridgeSecret(directory))
  const req = (authorization, origin) => ({ headers: { authorization, origin } })
  assert.equal(
    authorizeBridgeRequest(req(`Bearer ${secret}`, `chrome-extension://${'a'.repeat(32)}`), secret),
    true
  )
  assert.equal(authorizeBridgeRequest(req(`Bearer ${secret}`), secret), true)
  for (const origin of ['https://evil.example', 'null', 'chrome-extension://invalid'])
    assert.equal(authorizeBridgeRequest(req(`Bearer ${secret}`, origin), secret), false)
  assert.equal(authorizeBridgeRequest(req('Bearer wrong'), secret), false)
  assert.equal(authorizeBridgeRequest(req()), false)
})
