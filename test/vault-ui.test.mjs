import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkPasswords,
  filterGroups,
  generatePassword,
  groupAccounts,
  passwordStrength,
  timestamp,
  websiteUrl
} from '../src/renderer/src/utils/vault.js'

const records = [
  {
    id: 1,
    category: 'web',
    identity: 'example.com',
    display_name: 'Example',
    username: 'personal@example.com',
    password: 'same-short',
    captured_at: '2026-10-10 10:00:00'
  },
  {
    id: 2,
    category: 'web',
    identity: 'example.com',
    display_name: 'Example',
    username: 'work@example.com',
    password: 'same-short',
    captured_at: '2026-10-19 10:00:00'
  },
  {
    id: 3,
    category: 'app',
    identity: 'editor',
    display_name: 'Editor',
    username: 'writer',
    password: 'L9!xR7@jP2#nC4$t',
    captured_at: '2026-10-15 10:00:00'
  }
]

test('username search keeps all accounts within the matched website and does not change the security inventory', () => {
  const groups = groupAccounts(records)
  const result = filterGroups(groups, ' WORK@EXAMPLE.COM ')
  assert.equal(result.length, 1)
  assert.equal(result[0].accounts.length, 2)
  assert.equal(checkPasswords(records).total, 3)
  assert.equal(filterGroups(groups, 'same-short').length, 0, 'passwords must not be searchable')
})

test('app and website identities remain separate, and filters do not modify the source', () => {
  const groups = groupAccounts([...records, { ...records[0], id: 4, category: 'app' }])
  assert.equal(groups.length, 3)
  assert.equal(filterGroups(groups, '', 'web').length, 1)
  assert.equal(groups.length, 3)
})

test('recent sort uses the newest account in each group and parses SQLite timestamps as UTC', () => {
  assert.equal(timestamp('2026-10-19 10:00:00'), Date.parse('2026-10-19T10:00:00Z'))
  assert.equal(timestamp(null), 0)
  const groups = groupAccounts(records)
  assert.equal(filterGroups(groups, '', 'all', 'recent')[0].identity, 'example.com')
  assert.equal(groups[0].display_name, 'Editor')
})

test('security findings deduplicate affected accounts across weak and reused passwords', () => {
  const report = checkPasswords(records)
  assert.deepEqual(
    report.weak.map((item) => item.id),
    [1, 2]
  )
  assert.deepEqual(
    report.reused.map((item) => item.id),
    [1, 2]
  )
  assert.equal(report.affected, 2)
  assert.equal(checkPasswords([]).total, 0)
  assert.equal(checkPasswords([]).affected, 0)
  assert.notEqual(passwordStrength('Password123456!').level, 'strong')
  assert.notEqual(passwordStrength('aaaaaaaaaaaaaaaaaaaaaa').level, 'strong')
  assert.equal(passwordStrength('river canyon lantern maple').level, 'strong')
})

test('generated passwords use Web Crypto, include every character class, and never use Math.random', () => {
  const original = Math.random
  Math.random = () => {
    throw new Error('Insecure randomness used')
  }
  try {
    const passwords = Array.from({ length: 64 }, () => generatePassword())
    for (const password of passwords) {
      assert.equal(password.length, 20)
      for (const pattern of [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/])
        assert.match(password, pattern)
      assert.equal(passwordStrength(password).level, 'strong')
    }
    assert.equal(new Set(passwords).size, passwords.length)
    assert.throws(() => generatePassword(3))
    assert.throws(() => generatePassword(129))
  } finally {
    Math.random = original
  }
})

test('external links allow only HTTP(S), including local services with ports', () => {
  assert.equal(websiteUrl('example.com'), 'https://example.com/')
  assert.equal(websiteUrl('localhost:51000'), 'http://localhost:51000/')
  assert.equal(websiteUrl('192.168.1.2:8080'), 'http://192.168.1.2:8080/')
  assert.equal(websiteUrl('https://example.com/path'), 'https://example.com/path')
  for (const unsafe of [
    'javascript:alert(1)',
    'file:///C:/Windows',
    'data:text/html,hello',
    'mailto:a@example.com',
    'https://user:password@example.com',
    'bad host',
    ''
  ]) {
    assert.equal(websiteUrl(unsafe), null, unsafe)
  }
})
