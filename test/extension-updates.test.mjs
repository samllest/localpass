import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  createExtensionUpdateManager,
  packExtension,
  validateExtensionPackage,
  compareExtensionVersions
} from '../src/main/extension-updates.js'

const sourceFolder = resolve('chrome-extension')
function versioned(bundle, version) {
  const copy = structuredClone(bundle)
  copy.version = version
  const manifest = JSON.parse(Buffer.from(copy.files['manifest.json'].content, 'base64'))
  manifest.version = version
  const bytes = Buffer.from(JSON.stringify(manifest))
  copy.files['manifest.json'] = {
    content: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  return copy
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'localpass-extension-updates-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataFolder = join(root, 'app-data')
  await mkdir(dataFolder)
  const bundle = await packExtension(sourceFolder)
  let response = versioned(bundle, '1.3.8')
  const makeManager = (extra = {}) =>
    createExtensionUpdateManager({
      sourceFolder,
      dataFolder,
      serverUrl: () => 'http://127.0.0.1:18770/',
      fetchPackage: async () => new Response(JSON.stringify(response)),
      ...options,
      ...extra
    })
  const manager = makeManager()
  await manager.initialize()
  return {
    root,
    dataFolder,
    bundle,
    manager,
    makeManager,
    setResponse: (value) => {
      response = value
    }
  }
}
async function version(folder) {
  return JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')).version
}

test('version ordering is numeric and invalid versions are rejected', () => {
  assert.equal(compareExtensionVersions('1.3.10', '1.3.9'), 1)
  assert.equal(compareExtensionVersions('1.3.7', '1.3.7.0'), 0)
  assert.equal(compareExtensionVersions('1.3.5', '1.3.7'), -1)
  assert.throws(() => compareExtensionVersions('latest', '1.0.0'))
})
test('only complete LocalPass packages with matching hashes and versions are accepted', async () => {
  const valid = await packExtension(sourceFolder)
  assert.equal(validateExtensionPackage(valid).version, '1.3.7')
  for (const mutate of [
    (b) => {
      b.files['../vaults/system.db'] = b.files['content.js']
    },
    (b) => {
      delete b.files['background.js']
    },
    (b) => {
      b.files['content.js'].sha256 = 'invalid'
    },
    (b) => {
      b.version = '9.9.9'
    }
  ]) {
    const bundle = structuredClone(valid)
    mutate(bundle)
    assert.throws(() => validateExtensionPackage(bundle))
  }
})
test('download installs files in a stable directory and startup never downgrades a newer cached release', async (t) => {
  const { manager, makeManager } = await fixture(t)
  const folder = manager.snapshot().folder
  assert.equal(await version(folder), '1.3.7')
  assert.equal((await manager.check()).status, 'updated')
  assert.equal(await version(folder), '1.3.8')
  const restarted = makeManager()
  await restarted.initialize()
  assert.equal(await version(restarted.snapshot().folder), '1.3.8')
  assert.equal(restarted.snapshot().folder, folder)
})
test('binding an existing ZIP installation preserves unrelated files and updates it on later releases', async (t) => {
  const { root, manager, makeManager, bundle, setResponse } = await fixture(t)
  const folder = join(root, 'downloaded-extension')
  await cp(sourceFolder, folder, { recursive: true })
  await writeFile(join(folder, 'notes.txt'), 'keep this')
  await manager.bind(folder)
  await manager.check()
  assert.equal(await version(folder), '1.3.8')
  assert.equal(await readFile(join(folder, 'notes.txt'), 'utf8'), 'keep this')
  setResponse(versioned(bundle, '1.3.9'))
  const restarted = makeManager()
  await restarted.initialize()
  assert.equal(restarted.snapshot().folder, folder)
  await restarted.check()
  assert.equal(await version(folder), '1.3.9')
  assert.equal(restarted.reportBrowserVersion('1.3.8').version, '1.3.9')
})
test('bad downloads and offline servers leave installed files intact and never advertise reload readiness', async (t) => {
  const { manager, bundle, setResponse, makeManager } = await fixture(t)
  const original = await readFile(join(manager.snapshot().folder, 'background.js'))
  const corrupted = versioned(bundle, '1.3.9')
  corrupted.files['background.js'].content = Buffer.from('corrupt').toString('base64')
  setResponse(corrupted)
  assert.equal((await manager.check()).status, 'error')
  assert.equal(manager.reportBrowserVersion('1.3.7').ok, false)
  assert.deepEqual(await readFile(join(manager.snapshot().folder, 'background.js')), original)
  assert.equal(await version(manager.snapshot().folder), '1.3.7')
  const offline = makeManager({
    fetchPackage: async () => {
      throw new Error('offline')
    }
  })
  await offline.initialize()
  assert.equal((await offline.check()).status, 'error')
  assert.equal(await version(offline.snapshot().folder), '1.3.7')
})
test('wrong folders, linked folders and downgrades are rejected without replacing files', async (t) => {
  const { manager, root } = await fixture(t)
  const wrong = join(root, 'wrong')
  await mkdir(wrong)
  await writeFile(
    join(wrong, 'manifest.json'),
    JSON.stringify({ name: 'Other extension', version: '1.0.0' })
  )
  await assert.rejects(manager.bind(wrong))
  const linked = join(root, 'linked')
  await symlink(
    manager.snapshot().folder,
    linked,
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await assert.rejects(manager.bind(linked))
  await manager.check()
  const newer = join(root, 'newer')
  await cp(sourceFolder, newer, { recursive: true })
  const file = join(newer, 'manifest.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.version = '9.0.0'
  await writeFile(file, JSON.stringify(manifest))
  await assert.rejects(manager.bind(newer), /版本更新/)
  assert.equal(await version(newer), '9.0.0')
})
test('a local HTTP distribution serves a standalone extension release without a desktop upgrade', async (t) => {
  const { manager, bundle, makeManager } = await fixture(t)
  const payload = JSON.stringify(versioned(bundle, '1.3.12'))
  const urls = []
  const server = createServer((req, res) => {
    urls.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    res.end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
  )
  const client = makeManager({
    serverUrl: () => `http://127.0.0.1:${server.address().port}/`,
    fetchPackage: fetch
  })
  await client.initialize()
  await client.check()
  assert.deepEqual(urls, ['/extension-update.json'])
  assert.equal(await version(manager.snapshot().folder), '1.3.12')
  assert.equal(client.reportBrowserVersion('1.3.7').version, '1.3.12')
})
