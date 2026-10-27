import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { checkPasswordBreaches } from '../src/main/breach-check.js'
test('breach checks send only padded five-character hashes, deduplicate ranges and compare locally', async () => {
  const password = 'Synthetic password used only in tests'
  const hash = createHash('sha1').update(password).digest('hex').toUpperCase()
  let requests = 0
  const leaked = await checkPasswordBreaches([{ id: 1, password }, { id: 2, password }], async (url, options) => {
    requests++
    assert.equal(url, `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`)
    assert.equal(options.headers['Add-Padding'], 'true')
    assert.equal(JSON.stringify(options).includes(password), false)
    return new Response(`${hash.slice(5)}:3\r\n${'A'.repeat(35)}:0`)
  })
  assert.deepEqual(leaked, [1, 2])
  assert.equal(requests, 1)
  await assert.rejects(checkPasswordBreaches([{ id: 1, password }], async () => new Response('', { status: 503 })), /暂不可用/)
})
