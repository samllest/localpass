import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { acquireSingleInstance } from '../src/main/single-instance.js'

test('a duplicate process quits before startup and never registers another owner', () => {
  const app = new EventEmitter()
  let quits = 0
  app.requestSingleInstanceLock = () => false
  app.quit = () => quits++
  assert.equal(
    acquireSingleInstance(app, () => assert.fail('must not access a window')),
    false
  )
  assert.equal(quits, 1)
  assert.equal(app.listenerCount('second-instance'), 0)
})

test('opening again restores, shows and focuses the existing window', () => {
  const app = new EventEmitter()
  app.requestSingleInstanceLock = () => true
  app.quit = () => assert.fail('owner must stay running')
  const actions = []
  let window
  assert.equal(
    acquireSingleInstance(app, () => window),
    true
  )
  app.emit('second-instance') // A second launch can arrive before the window is ready.
  window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => actions.push('restore'),
    show: () => actions.push('show'),
    focus: () => actions.push('focus')
  }
  app.emit('second-instance')
  assert.deepEqual(actions, ['restore', 'show', 'focus'])
  actions.length = 0
  window.isDestroyed = () => true
  app.emit('second-instance')
  assert.deepEqual(actions, [])
})
