import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLOSE_CHOICE_DURATION_MS,
  readClosePreference,
  writeClosePreference,
  clearClosePreference,
  createCloseController
} from '../src/main/close-behavior.js'

function fixture(options = {}) {
  const file = options.file || join(mkdtempSync(join(tmpdir(), 'localpass-close-')), 'choice.json')
  const actions = []
  const notices = []
  let clock = 1000000000
  let answer = { response: 0, checkboxChecked: false }
  const window = new EventEmitter()
  window.isDestroyed = () => false
  window.hide = () => actions.push('hide')
  const controller = createCloseController({
    preferenceFile: file,
    now: () => clock,
    app: { quit: () => actions.push('quit') },
    isUnlocked: () => options.unlocked ?? true,
    enterBackground: () => {
      actions.push('tray')
      if (options.trayFailure) throw new Error('Unavailable tray')
    },
    dialog: {
      showMessageBox: async (_window, notice) => {
        notices.push(notice)
        return typeof answer === 'function' ? answer() : answer
      }
    }
  })
  return {
    controller,
    window,
    file,
    actions,
    notices,
    setAnswer: (value) => {
      answer = value
    },
    setClock: (value) => {
      clock = value
    }
  }
}

test('cancel, including Escape with the checkbox checked, never hides or remembers', async () => {
  const f = fixture({ unlocked: false })
  f.setAnswer({ response: 0, checkboxChecked: true })
  await f.controller.requestClose(f.window)
  assert.deepEqual(f.actions, [])
  assert.equal(existsSync(f.file), false)
  assert.deepEqual(f.notices[0].buttons, ['取消', '确认关闭', '后台运行'])
  assert.equal(f.notices[0].cancelId, 0)
  assert.match(f.notices[0].detail, /尚未解锁/)
})

test('background creates the tray before hiding; unchecked choices prompt every time', async () => {
  const f = fixture()
  f.setAnswer({ response: 2, checkboxChecked: false })
  await f.controller.requestClose(f.window)
  await f.controller.requestClose(f.window)
  assert.deepEqual(f.actions, ['tray', 'hide', 'tray', 'hide'])
  assert.equal(f.notices.length, 2)
  assert.equal(existsSync(f.file), false)
})

test('remembered background survives restart, expires at exactly 72 hours and never extends on reuse', async () => {
  const f = fixture()
  f.setAnswer({ response: 2, checkboxChecked: true })
  await f.controller.requestClose(f.window)
  const expiresAt = 1000000000 + CLOSE_CHOICE_DURATION_MS
  const restarted = fixture({ file: f.file })
  restarted.setClock(expiresAt - 1)
  await restarted.controller.requestClose(restarted.window)
  assert.deepEqual(restarted.actions, ['tray', 'hide'])
  assert.equal(restarted.notices.length, 0)
  assert.equal(readClosePreference(f.file, expiresAt - 1).expiresAt, expiresAt)
  restarted.setClock(expiresAt)
  await restarted.controller.requestClose(restarted.window)
  assert.equal(restarted.notices.length, 1)
  assert.equal(readClosePreference(f.file, expiresAt), null)
})

test('remembered confirmation quits on later launches without a prompt; reset restores prompting', async () => {
  const f = fixture()
  f.setAnswer({ response: 1, checkboxChecked: true })
  await f.controller.requestClose(f.window)
  assert.deepEqual(f.actions, ['quit'])
  const restarted = fixture({ file: f.file })
  await restarted.controller.requestClose(restarted.window)
  assert.deepEqual(restarted.actions, ['quit'])
  assert.equal(restarted.notices.length, 0)
  clearClosePreference(f.file)
  clearClosePreference(f.file)
  const reset = fixture({ file: f.file })
  await reset.controller.requestClose(reset.window)
  assert.equal(reset.notices.length, 1)
})

test('multiple close requests share one prompt; OS/tray quit bypasses it', async () => {
  const f = fixture()
  let finish
  f.setAnswer(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  f.controller.attach(f.window)
  let prevented = 0
  f.window.emit('close', { preventDefault: () => prevented++ })
  const pending = f.controller.requestClose(f.window)
  assert.equal(f.controller.requestClose(f.window), pending)
  assert.equal(f.notices.length, 1)
  f.controller.quit()
  finish({ response: 2, checkboxChecked: true })
  await pending
  assert.deepEqual(f.actions, ['quit'])
  assert.equal(existsSync(f.file), false)
  f.window.emit('close', { preventDefault: () => prevented++ })
  assert.equal(prevented, 1)
})

test('a failed tray keeps the window visible and clears a remembered background action', async () => {
  const f = fixture({ trayFailure: true })
  writeClosePreference(f.file, 'background', 1000000000)
  await f.controller.requestClose(f.window)
  assert.deepEqual(f.actions, ['tray'])
  assert.equal(existsSync(f.file), false)
  assert.equal(f.notices[0].type, 'warning')
})

test('corrupt, cancelled and overly distant preferences fail back to prompting', async () => {
  const f = fixture()
  for (const content of [
    'invalid',
    'null',
    JSON.stringify({ action: 'cancel', expiresAt: 1000000001 }),
    JSON.stringify({ action: 'quit', expiresAt: Number.MAX_SAFE_INTEGER })
  ]) {
    writeFileSync(f.file, content)
    assert.equal(readClosePreference(f.file, 1000000000), null)
  }
  await f.controller.requestClose(f.window)
  assert.equal(f.notices.length, 1)
})
