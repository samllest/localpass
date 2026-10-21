import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  mkdtemp,
  cp,
  rename,
  rm
} from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { normalizeUpdateUrl } from './updates.js'

export const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png'
]
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024
const extensionName = 'LocalPass Auto Capturer'

export function compareExtensionVersions(a, b) {
  if (![a, b].every((value) => typeof value === 'string' && /^\d+(\.\d+){2,3}$/.test(value)))
    throw new Error('扩展版本号无效')
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    const delta = (left[i] || 0) - (right[i] || 0)
    if (delta) return Math.sign(delta)
  }
  return 0
}

export function validateExtensionPackage(bundle) {
  if (
    bundle?.schema !== 1 ||
    !bundle.files ||
    Object.keys(bundle.files).length !== EXTENSION_FILES.length
  )
    throw new Error('扩展更新包不完整')
  let size = 0
  const files = new Map()
  for (const name of EXTENSION_FILES) {
    const entry = bundle.files[name]
    if (!entry || typeof entry.content !== 'string' || entry.content.length > MAX_PACKAGE_BYTES)
      throw new Error('扩展更新包缺少文件')
    const bytes = Buffer.from(entry.content, 'base64')
    size += bytes.length
    if (
      size > MAX_PACKAGE_BYTES ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    )
      throw new Error('扩展更新包校验失败')
    files.set(name, bytes)
  }
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
  compareExtensionVersions(manifest.version, bundle.version)
  if (
    manifest.name !== extensionName ||
    manifest.manifest_version !== 3 ||
    manifest.version !== bundle.version
  )
    throw new Error('扩展更新包身份不匹配')
  return { version: manifest.version, files }
}

export async function packExtension(directory) {
  const files = {}
  for (const name of EXTENSION_FILES) {
    const bytes = await readFile(join(directory, name))
    files[name] = {
      content: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  }
  const manifest = JSON.parse(
    Buffer.from(files['manifest.json'].content, 'base64').toString('utf8')
  )
  const bundle = { schema: 1, version: manifest.version, files }
  validateExtensionPackage(bundle)
  return bundle
}

async function installedVersion(folder) {
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
  if (manifest.name !== extensionName || manifest.manifest_version !== 3)
    throw new Error('请选择浏览器当前加载的 LocalPass 扩展文件夹')
  compareExtensionVersions(manifest.version, manifest.version)
  return manifest.version
}

// Swap complete folders only after all files have been staged. Preserve unrelated
// files in an existing installation and restore the original on rename failure.
async function installPackage(folder, bundle) {
  const { files } = validateExtensionPackage(bundle)
  await mkdir(dirname(folder), { recursive: true })
  let exists = false
  try {
    const info = await lstat(folder)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('扩展目录不能是快捷方式或文件')
    await installedVersion(folder)
    exists = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const staging = await mkdtemp(join(dirname(folder), '.localpass-extension-'))
  const backup = staging + '-previous'
  let moved = false
  try {
    if (exists) {
      // Never follow directory links outside the selected extension folder.
      async function rejectLinks(directory) {
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (item.isSymbolicLink()) throw new Error('扩展目录中含链接，请改用新的扩展目录')
          if (item.isDirectory()) await rejectLinks(join(directory, item.name))
        }
      }
      await rejectLinks(folder)
      await cp(folder, staging, { recursive: true })
    }
    for (const [name, bytes] of files) {
      await mkdir(dirname(join(staging, name)), { recursive: true })
      await writeFile(join(staging, name), bytes)
    }
    if (exists) {
      await rename(folder, backup)
      moved = true
    }
    try {
      await rename(staging, folder)
    } catch (error) {
      if (moved) await rename(backup, folder)
      throw error
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  // Failure to remove an old backup must not hide a successful installation.
  if (moved) await rm(backup, { recursive: true, force: true }).catch(() => {})
}

export function createExtensionUpdateManager({
  sourceFolder,
  dataFolder,
  serverUrl,
  fetchPackage = fetch
}) {
  const cacheFolder = join(dataFolder, 'browser-extension')
  const settingsFile = join(dataFolder, 'extension-update-settings.json')
  let targetFolder = cacheFolder
  let busy = false
  let state = {
    version: '',
    browserVersion: '',
    folder: targetFolder,
    status: 'idle',
    error: '',
    checkedAt: null
  }
  let latest
  const snapshot = () => ({ ...state, busy })
  async function ensureLatest(folder) {
    let version = ''
    try {
      version = await installedVersion(folder)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!version || compareExtensionVersions(latest.version, version) > 0)
      await installPackage(folder, latest)
  }
  return {
    snapshot,
    async initialize() {
      latest = await packExtension(sourceFolder)
      try {
        const saved = JSON.parse(await readFile(settingsFile, 'utf8'))
        if (typeof saved.folder === 'string' && resolve(saved.folder) === saved.folder)
          targetFolder = saved.folder
      } catch {
        /* First launch uses a stable, app-managed extension folder. */
      }
      try {
        const cached = await packExtension(cacheFolder)
        if (compareExtensionVersions(cached.version, latest.version) > 0) latest = cached
      } catch {
        /* Rebuild an absent or incomplete managed cache from the bundled release. */
      }
      await ensureLatest(cacheFolder)
      try {
        if (targetFolder !== cacheFolder) await ensureLatest(targetFolder)
      } catch (error) {
        state.error = error.message
        state.status = 'error'
      }
      state = { ...state, folder: targetFolder, version: latest.version }
      return snapshot()
    },
    async bind(folder) {
      if (busy) throw new Error('请等待扩展更新完成')
      busy = true
      try {
        folder = resolve(folder)
        await installedVersion(folder)
        if (compareExtensionVersions(await installedVersion(folder), latest.version) > 0)
          throw new Error('所选扩展比下载站版本更新，已保留原文件')
        await installPackage(folder, latest)
        await writeFile(settingsFile + '.tmp', JSON.stringify({ folder }), 'utf8')
        await rename(settingsFile + '.tmp', settingsFile)
        targetFolder = folder
        state = { ...state, folder, status: 'updated', error: '', browserVersion: '' }
      } finally {
        busy = false
      }
      return snapshot()
    },
    async check() {
      if (busy) return snapshot()
      busy = true
      state = { ...state, status: 'checking', error: '' }
      try {
        const url = new URL('extension-update.json', normalizeUpdateUrl(serverUrl()))
        const response = await fetchPackage(url, {
          signal: AbortSignal.timeout(15000),
          cache: 'no-store',
          redirect: 'error'
        })
        if (!response.ok) throw new Error('下载站尚未发布扩展更新，请稍后重试')
        let text = ''
        for await (const chunk of response.body) {
          text += Buffer.from(chunk).toString('utf8')
          if (Buffer.byteLength(text) > MAX_PACKAGE_BYTES) throw new Error('扩展更新包过大')
        }
        const bundle = JSON.parse(text)
        validateExtensionPackage(bundle)
        const newer = compareExtensionVersions(bundle.version, latest.version) > 0
        if (newer) {
          await installPackage(cacheFolder, bundle)
          latest = bundle
        }
        await ensureLatest(targetFolder)
        state = {
          ...state,
          version: latest.version,
          status: newer ? 'updated' : 'current',
          checkedAt: Date.now()
        }
      } catch (error) {
        state = { ...state, version: latest?.version || '', status: 'error', error: error.message }
      } finally {
        busy = false
      }
      return snapshot()
    },
    reportBrowserVersion(version) {
      try {
        compareExtensionVersions(version, version)
        state.browserVersion = version
      } catch {
        /* Ignore malformed probes. */
      }
      return {
        ok: !!state.version && state.status !== 'error',
        version: state.version,
        updating: busy
      }
    }
  }
}
