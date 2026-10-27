import assert from 'node:assert/strict'
import test from 'node:test'
import { isDevelopmentSite, matchProject, projectName } from '../src/shared/project-matching.js'
import { resolveProjectLookup, resolveProjectCapture } from '../src/main/project-resolution.js'
import { groupAccounts } from '../src/renderer/src/utils/vault.js'

const site = { identity: 'localhost:3000', project_name: '项目 A' }
const record = {
  ...site,
  app_id: 1,
  category: 'web',
  display_name: '项目 A',
  username: 'admin',
  password: 'synthetic-A'
}
const other = { ...record, app_id: 2, project_name: '项目 B', password: 'synthetic-B' }
const noChoice = () => {
  throw new Error('Unexpected selection prompt')
}

test('development hosts include loopback, private networks and local domains', () => {
  for (const value of [
    'localhost:3000',
    '127.0.0.1:8080',
    '[::1]:3000',
    'demo.localhost:5173',
    '192.168.3.1:80',
    '10.0.15.50:8768',
    '172.31.1.2:8080'
  ])
    assert.equal(isDevelopmentSite(value), true, value)
  for (const value of [
    'example.com:3000',
    'localhost.evil.com',
    '192.168.example.com',
    '172.32.1.1'
  ])
    assert.equal(isDevelopmentSite(value), false, value)
})

test('project names use explicit name, site name, then title and normalize whitespace and case', () => {
  assert.equal(projectName({ site_name: '项目 A', page_title: '登录' }), '项目 A')
  assert.equal(matchProject([record, other], { ...site, project_name: ' 项目  A ' })[0], record)
  assert.deepEqual(matchProject([record], { identity: site.identity }), [])
  assert.deepEqual(matchProject([record], { ...site, project_name: '未知项目' }), [])
})

test('same host and port isolates projects for lookup, capture and vault grouping', async () => {
  const result = await resolveProjectLookup([record, other], site, noChoice)
  assert.deepEqual(result.accounts, [record])
  assert.equal(
    await resolveProjectCapture(
      [other],
      site,
      { username: 'admin', password: 'synthetic-A' },
      noChoice
    ),
    null
  )
  assert.equal(
    await resolveProjectCapture(
      [record, other],
      site,
      { username: 'admin', password: 'synthetic-A' },
      noChoice
    ),
    record
  )
  assert.equal(groupAccounts([record, other]).length, 2)
})

test('multiple accounts in the same project return to the browser picker without a desktop prompt', async () => {
  const duplicate = { ...record, app_id: 3, username: 'other' }
  const result = await resolveProjectLookup([record, other, duplicate], site, noChoice)
  assert.deepEqual(result, { accounts: [record, duplicate], selected: false })
})

test('changed passwords are saved separately without prompts; selected records update only the selected account', async () => {
  const payload = { username: 'admin', password: 'changed-secret' }
  assert.equal(await resolveProjectCapture([record], site, payload, async () => 'new'), null)
  assert.equal(await resolveProjectCapture([record], site, payload, noChoice), null)
  assert.equal(await resolveProjectCapture([record], site, payload, noChoice, 1), record)
  assert.equal(await resolveProjectCapture([record], site, payload, noChoice, 99), false)
})

test('password changes associate a unique old password while ambiguous/public matches stay separate', async () => {
  const publicSite = { identity: 'example.com' }
  assert.equal(
    await resolveProjectCapture(
      [record],
      publicSite,
      { username: 'admin', password: 'new' },
      noChoice
    ),
    null
  )
  assert.equal(
    await resolveProjectCapture(
      [record],
      site,
      { capture_kind: 'password-change', previous_password: record.password, password: 'new' },
      noChoice
    ),
    record
  )
  assert.equal(
    await resolveProjectCapture(
      [record, { ...record, app_id: 99 }],
      site,
      { capture_kind: 'password-change', previous_password: record.password, password: 'new' },
      noChoice
    ),
    null
  )
})

test('missing names and legacy records also use the browser picker; public website lookup is unchanged', async () => {
  const result = await resolveProjectLookup([record, other], { identity: site.identity }, noChoice)
  assert.deepEqual(result.accounts, [record, other])
  const legacy = {
    app_id: 4,
    identity: site.identity,
    display_name: site.identity,
    username: 'admin'
  }
  assert.deepEqual((await resolveProjectLookup([legacy], site, noChoice)).accounts, [legacy])
  assert.deepEqual(
    (await resolveProjectLookup([record, other], { identity: 'example.com' }, noChoice)).accounts,
    [record, other]
  )
})
