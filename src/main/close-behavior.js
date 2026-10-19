import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export const CLOSE_CHOICE_DURATION_MS = 3 * 24 * 60 * 60 * 1000
const actions = new Set(['quit', 'background'])

export function readClosePreference(file, now = Date.now()) {
  try {
    const preference = JSON.parse(readFileSync(file, 'utf8'))
    if (
      !actions.has(preference.action) ||
      !Number.isFinite(preference.expiresAt) ||
      preference.expiresAt <= now ||
      preference.expiresAt > now + CLOSE_CHOICE_DURATION_MS
    )
      return null
    return { action: preference.action, expiresAt: preference.expiresAt }
  } catch {
    return null
  }
}

export function writeClosePreference(file, action, now = Date.now()) {
  if (!actions.has(action)) throw new Error('Invalid close action')
  mkdirSync(dirname(file), { recursive: true })
  const preference = { action, expiresAt: now + CLOSE_CHOICE_DURATION_MS }
  writeFileSync(file + '.tmp', JSON.stringify(preference), 'utf8')
  renameSync(file + '.tmp', file)
  return preference
}

export function clearClosePreference(file) {
  try {
    unlinkSync(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export function createCloseController({
  app,
  dialog,
  enterBackground,
  isUnlocked,
  preferenceFile,
  now = Date.now
}) {
  let quitting = false
  let pending = null
  function quit() {
    quitting = true
    app.quit()
  }
  async function choose(window) {
    const remembered = readClosePreference(preferenceFile, now())
    let action = remembered?.action
    let remember = false
    if (!action) {
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        title: '关闭 LocalPass',
        message: '关闭窗口后，如何运行 LocalPass？',
        detail: isUnlocked()
          ? '后台运行可继续保存和填充登录密码，并可从系统托盘重新打开窗口。确认关闭后，浏览器扩展将暂停工作。'
          : '密码库尚未解锁。后台运行会保留系统托盘图标，解锁后才能保存和填充登录密码。确认关闭将退出应用。',
        buttons: ['取消', '确认关闭', '后台运行'],
        defaultId: 2,
        cancelId: 0,
        noLink: true,
        checkboxLabel: '不再提示（3 天内记住本次选择）',
        checkboxChecked: false
      })
      if (quitting || window.isDestroyed()) return
      action = result.response === 1 ? 'quit' : result.response === 2 ? 'background' : null
      remember = result.checkboxChecked
    }
    if (!action || quitting || window.isDestroyed()) return
    // Create a working tray before hiding, so the user can always reopen the app.
    if (action === 'background') await enterBackground()
    if (quitting || window.isDestroyed()) return
    if (remember) {
      try {
        writeClosePreference(preferenceFile, action, now())
      } catch (error) {
        console.error('[Close] Unable to remember choice:', error.code)
      }
    }
    if (action === 'background') window.hide()
    else quit()
  }
  function requestClose(window) {
    if (quitting || window.isDestroyed()) return Promise.resolve()
    if (pending) return pending
    pending = choose(window)
      .catch(async (error) => {
        console.error('[Close] Unable to close window:', error.code || error.message)
        try {
          clearClosePreference(preferenceFile)
        } catch {
          /* Keep the visible window usable. */
        }
        if (!quitting && !window.isDestroyed()) {
          await dialog
            .showMessageBox(window, {
              type: 'warning',
              title: '暂时无法后台运行',
              message: '窗口已保留，请稍后重试。',
              detail: '如需退出，可再次点击关闭并选择「确认关闭」。',
              buttons: ['知道了']
            })
            .catch(() => {})
        }
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
  return {
    requestClose,
    quit,
    allowQuit: () => {
      quitting = true
    },
    attach(window) {
      window.on('close', (event) => {
        if (quitting) return
        event.preventDefault()
        void requestClose(window)
      })
      window.on('query-session-end', () => {
        quitting = true
      })
    }
  }
}
