import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAutomaticBackup } from '../src/main/automatic-backup.js'

test('automatic backups persist schedule, keep completed versions and never prune failed snapshots', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'localpass-backups-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let at = Date.now(),
    count = 0,
    failure = false,
    notices = 0
  const options = {
    directory,
    now: () => at,
    retention: 2,
    notify: () => notices++,
    snapshot: async ({ destination }) => {
      count++
      if (failure) throw new Error('disk full')
      await mkdir(destination)
      await writeFile(
        join(destination, 'snapshot.json'),
        JSON.stringify({
          version: 1,
          vaults: ['synthetic.db'],
          createdAt: new Date(at).toISOString()
        })
      )
    }
  }
  const manager = createAutomaticBackup(options)
  await manager.initialize()
  await Promise.all([manager.run(), manager.run()])
  assert.equal(count, 1)
  await manager.run()
  assert.equal(count, 1)
  for (let i = 0; i < 3; i++) {
    at += 3600001
    await manager.run()
  }
  assert.equal((await readdir(directory)).length, 2)
  const restarted = createAutomaticBackup(options)
  await restarted.initialize()
  await restarted.run()
  assert.equal(count, 4)
  at += 3600001
  failure = true
  await restarted.run()
  await restarted.run()
  assert.equal(notices, 1)
  assert.equal((await readdir(directory)).length, 2)
  assert.match(restarted.status().error, /disk full/)
})
