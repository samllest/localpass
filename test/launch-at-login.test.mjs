import assert from 'node:assert/strict'
import test from 'node:test'
import { createLaunchAtLogin } from '../src/main/launch-at-login.js'

test('startup stays opt-in, targets the installed executable and reflects Windows changes', () => {
  const calls = []
  let settings = { openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] }
  const options = { path: 'C:\\Program Files\\LocalPass\\localpass.exe', args: [] }
  const app = {
    isPackaged: true,
    getLoginItemSettings(actual) {
      assert.deepEqual(actual, { ...options, path: `"${options.path}"` })
      return settings
    },
    setLoginItemSettings(value) {
      calls.push(value)
      settings = {
        openAtLogin: false,
        executableWillLaunchAtLogin: value.enabled,
        launchItems: value.openAtLogin
          ? [{ name: value.name, scope: 'user', args: [], enabled: value.enabled }]
          : []
      }
    }
  }
  const startup = createLaunchAtLogin({ app, platform: 'win32', execPath: options.path })
  assert.equal(startup.getState().enabled, false)
  assert.equal(calls.length, 0)
  assert.equal(startup.setEnabled(true).enabled, true)
  assert.deepEqual(calls[0], { ...options, name: 'LocalPass', openAtLogin: true, enabled: true })
  settings.executableWillLaunchAtLogin = false
  settings.launchItems[0].enabled = false
  assert.equal(startup.getState().enabled, false)
  assert.equal(calls.length, 1, 'reading does not override Task Manager disabling startup')
  assert.equal(startup.setEnabled(true).enabled, true)
  assert.equal(startup.setEnabled(false).enabled, false)
  assert.equal(calls.at(-1).openAtLogin, false)
})

test('development and unsupported platforms never access OS startup entries', () => {
  for (const [platform, isPackaged] of [
    ['win32', false],
    ['linux', true],
    ['darwin', true]
  ]) {
    const app = {
      isPackaged,
      getLoginItemSettings() {
        assert.fail('must not read OS settings')
      },
      setLoginItemSettings() {
        assert.fail('must not write OS settings')
      }
    }
    const startup = createLaunchAtLogin({ app, platform })
    assert.equal(startup.getState().supported, false)
    assert.equal(startup.getState().enabled, false)
    assert.throws(() => startup.setEnabled(true))
  }
})

test('invalid values, failed writes and rejected OS changes cannot report success', () => {
  let writes = 0
  const app = {
    isPackaged: true,
    getLoginItemSettings: () => ({
      openAtLogin: false,
      executableWillLaunchAtLogin: false,
      launchItems: []
    }),
    setLoginItemSettings() {
      writes++
    }
  }
  const startup = createLaunchAtLogin({ app, platform: 'win32' })
  for (const value of ['true', 1, null, {}]) assert.throws(() => startup.setEnabled(value))
  assert.equal(writes, 0)
  assert.throws(() => startup.setEnabled(true), /系统未能更新/)
  app.setLoginItemSettings = () => {
    throw new Error('access denied')
  }
  assert.throws(() => startup.setEnabled(true), /access denied/)
})

test('unrelated, machine and different-argument entries do not mask the user setting', () => {
  const app = {
    isPackaged: true,
    getLoginItemSettings: () => ({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [
        { name: 'OtherApp', scope: 'user', args: [], enabled: true },
        { name: 'LocalPass', scope: 'machine', args: [], enabled: true },
        { name: 'LocalPass', scope: 'user', args: ['--other-mode'], enabled: true }
      ]
    })
  }
  assert.equal(createLaunchAtLogin({ app, platform: 'win32' }).getState().enabled, false)
})
