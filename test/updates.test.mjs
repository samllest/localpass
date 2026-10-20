import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateManager, normalizeUpdateUrl, DEFAULT_UPDATE_URL } from '../src/main/updates.js'

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'localpass-updates-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const settingsFile = join(directory, 'update-settings.json')
  const updater = new EventEmitter()
  const calls = []
  updater.setFeedURL = (feed) => calls.push(['feed', feed.url])
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '1.5.0' })
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 51, transferred: 51, total: 100 })
    updater.emit('update-downloaded', { version: '1.5.0' })
  }
  const states = []
  const args = {
    updater,
    version: '1.4.0',
    supported: true,
    settingsFile,
    notify: (state) => states.push(state),
    install: () => calls.push(['install']),
    ...options
  }
  return { manager: createUpdateManager(args), updater, calls, states, args }
}

test('normalizes internal feeds and rejects non-web URLs or embedded credentials', () => {
  assert.equal(
    normalizeUpdateUrl(' http://10.0.0.5:18770/updates '),
    'http://10.0.0.5:18770/updates/'
  )
  assert.equal(normalizeUpdateUrl('https://updates.example'), 'https://updates.example/')
  for (const url of [
    'file:///C:/release',
    'javascript:alert(1)',
    'http://user:pass@host/',
    'http://host/?token=x',
    'http://host/#x',
    'garbage'
  ])
    assert.throws(() => normalizeUpdateUrl(url))
})

test('checking never downloads or installs; install is gated on verified download', async (t) => {
  const { manager, updater, calls, states } = fixture(t)
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.allowDowngrade, false)
  assert.equal(updater.disableDifferentialDownload, true)
  await manager.install()
  assert.equal((await manager.check()).status, 'available')
  assert.equal(
    calls.some(([kind]) => kind === 'install'),
    false
  )
  assert.equal((await manager.download()).status, 'downloaded')
  assert.equal(
    states.some((state) => state.status === 'downloading' && state.percent === 51),
    true
  )
  const count = states.length
  await manager.check()
  assert.equal(states.length, count, 'a background check must not discard a pending installer')
  await manager.install()
  assert.equal(calls.filter(([kind]) => kind === 'install').length, 1)
})

test('overlapping checks, server changes and installs cannot race with a download', async (t) => {
  const { manager, updater } = fixture(t)
  await manager.check()
  let finish
  updater.downloadUpdate = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const downloading = manager.download()
  assert.equal((await manager.check()).status, 'downloading')
  assert.equal((await manager.install()).status, 'downloading')
  assert.throws(() => manager.setServer('http://10.0.0.2/'), /等待/)
  updater.emit('update-downloaded', { version: '1.5.0' })
  finish()
  await downloading
  assert.throws(() => manager.setServer('http://10.0.0.2/'), /等待/)
})

test('network and corrupt installer errors can be retried and never enable installation', async (t) => {
  const { manager, updater, calls } = fixture(t)
  updater.checkForUpdates = async () => {
    throw new Error('ECONNREFUSED private network detail')
  }
  assert.equal((await manager.check()).status, 'error')
  assert.doesNotMatch(manager.snapshot().error, /private network/)
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '1.5.0' })
  await manager.check()
  updater.downloadUpdate = async () => {
    throw Object.assign(new Error('checksum mismatch'), { code: 'ERR_SHA512_CHECKSUM_MISMATCH' })
  }
  const failed = await manager.download()
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /校验失败/)
  await manager.install()
  assert.equal(
    calls.some(([kind]) => kind === 'install'),
    false
  )
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '1.5.0' })
  assert.equal((await manager.download()).status, 'downloaded')
})

test('server changes persist per profile and clear obsolete update information', async (t) => {
  const { manager, args } = fixture(t)
  assert.equal(manager.snapshot().serverUrl, DEFAULT_UPDATE_URL)
  await manager.check()
  const changed = manager.setServer('http://10.0.0.8:9000/releases')
  assert.equal(changed.version, null)
  assert.equal(changed.status, 'idle')
  assert.equal(createUpdateManager(args).snapshot().serverUrl, 'http://10.0.0.8:9000/releases/')
})

test('development builds cannot check, download or install updates', async (t) => {
  const { manager, calls } = fixture(t, { supported: false })
  assert.equal((await manager.check()).status, 'unsupported')
  assert.equal((await manager.download()).status, 'unsupported')
  await manager.install()
  assert.deepEqual(calls, [])
})
