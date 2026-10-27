import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBrowserPasswords } from '../src/shared/password-import.js'
test('browser CSV handles quoted passwords/newlines, ports, duplicates and rejects malformed imports', () => {
  const result = parseBrowserPasswords(
    'name,url,username,password,note\r\nDemo,http://localhost:8080,user,"a,""b",hello\r\nDemo,http://localhost:8080,user,"a,""b",hello\r\nOther,https://example.com,u,"multi\nline",note\r\nBad,chrome://settings,u,p,x'
  )
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].identity, 'localhost:8080')
  assert.equal(result.records[0].password, 'a,"b')
  assert.equal(result.records[1].password, 'multi\nline')
  assert.equal(result.skipped, 2)
  assert.throws(() => parseBrowserPasswords('foo,bar\nx,y'), /CSV/)
  assert.throws(() => parseBrowserPasswords('url,username,password\nhttps://a.com,u,"open'), /闭合/)
})
