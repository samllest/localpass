import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_UPDATE_URL = 'http://192.168.3.145:18770/'

export function normalizeUpdateUrl(value) {
  const url = new URL(String(value).trim())
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('请填写 HTTP 或 HTTPS 下载站地址，不包含账号、查询参数或锚点。')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

// The updater only receives release metadata and installer files. Vaults stay local.
export function createUpdateManager({
  updater,
  version,
  supported,
  settingsFile,
  notify,
  install
}) {
  let serverUrl = DEFAULT_UPDATE_URL
  try {
    serverUrl = normalizeUpdateUrl(JSON.parse(readFileSync(settingsFile, 'utf8')).serverUrl)
  } catch {
    /* Use the internal distribution server on first launch. */
  }
  let state = {
    status: supported ? 'idle' : 'unsupported',
    currentVersion: version,
    serverUrl,
    version: null,
    percent: 0,
    transferred: 0,
    total: 0,
    error: '',
    checkedAt: null
  }
  let busy = false
  let installing = false
  const snapshot = () => ({ ...state })
  function change(patch) {
    state = { ...state, ...patch }
    notify(snapshot())
  }
  function fail(error) {
    const code = error?.code || ''
    const message =
      code === 'ERR_VAULT_BACKUP'
        ? error.message
        : /SHA|checksum/i.test(code + ' ' + error?.message)
          ? '安装包校验失败，请重新下载或联系管理员重新发布。'
          : '更新未完成，请确认已连接内网且更新服务可用，然后重试。'
    change({ status: 'error', error: message })
  }
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowDowngrade = false
  // Full installers avoid requiring an older blockmap after a server release switch.
  updater.disableDifferentialDownload = true
  if (supported) updater.setFeedURL({ provider: 'generic', url: serverUrl })
  updater.on('error', fail)
  updater.on('update-available', (info) =>
    change({
      status: 'available',
      version: info.version,
      percent: 0,
      error: ''
    })
  )
  updater.on('update-not-available', () => change({ status: 'current', version: null, error: '' }))
  updater.on('download-progress', (progress) =>
    change({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
      transferred: progress.transferred,
      total: progress.total
    })
  )
  updater.on('update-downloaded', (info) =>
    change({
      status: 'downloaded',
      version: info.version,
      percent: 100,
      error: ''
    })
  )
  return {
    snapshot,
    async check() {
      if (!supported || busy || state.status === 'downloaded') return snapshot()
      busy = true
      change({ status: 'checking', error: '', version: null })
      try {
        await updater.checkForUpdates()
        change({ checkedAt: new Date().toISOString() })
      } catch (error) {
        fail(error)
      } finally {
        busy = false
      }
      return snapshot()
    },
    async download() {
      if (!supported || busy || !state.version || !['available', 'error'].includes(state.status))
        return snapshot()
      busy = true
      change({ status: 'downloading', percent: 0, error: '' })
      try {
        await updater.downloadUpdate()
      } catch (error) {
        fail(error)
      } finally {
        busy = false
      }
      return snapshot()
    },
    setServer(value) {
      if (busy || state.status === 'downloaded') throw new Error('请等待当前更新完成后再修改地址。')
      const url = normalizeUpdateUrl(value)
      mkdirSync(dirname(settingsFile), { recursive: true })
      writeFileSync(settingsFile + '.tmp', JSON.stringify({ serverUrl: url }), 'utf8')
      renameSync(settingsFile + '.tmp', settingsFile)
      if (supported) updater.setFeedURL({ provider: 'generic', url })
      change({
        serverUrl: url,
        status: supported ? 'idle' : 'unsupported',
        version: null,
        error: '',
        checkedAt: null
      })
      return snapshot()
    },
    async install() {
      if (installing || state.status !== 'downloaded') return snapshot()
      installing = true
      try {
        await install()
      } catch (error) {
        fail(error)
      } finally {
        installing = false
      }
      return snapshot()
    }
  }
}
