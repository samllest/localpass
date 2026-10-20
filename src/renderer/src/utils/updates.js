import { computed, reactive } from 'vue'

export const updateState = reactive({
  status: 'idle',
  currentVersion: '',
  serverUrl: '',
  version: null,
  percent: 0,
  error: ''
})
export const updateBusy = computed(() => ['checking', 'downloading'].includes(updateState.status))
export const updateMessage = computed(() => {
  switch (updateState.status) {
    case 'checking':
      return '正在检查内网更新…'
    case 'available':
      return `发现新版本 ${updateState.version}，可以下载更新。`
    case 'current':
      return '当前已是最新版本。'
    case 'downloading':
      return `正在下载 ${updateState.version} · ${updateState.percent}%`
    case 'downloaded':
      return `${updateState.version} 已下载并校验，可以重启安装。`
    case 'error':
      return updateState.error
    case 'unsupported':
      return '开发窗口不安装更新，请使用 Windows 安装版。'
    default:
      return '启动后自动检查内网新版本，由你确认下载和安装。'
  }
})
export async function runUpdateAction(action, value) {
  try {
    return await window.localpass[action](value)
  } catch (error) {
    throw new Error(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
  }
}
export async function initializeUpdates() {
  let received = false
  const stop = window.localpass.onUpdateState((state) => {
    received = true
    Object.assign(updateState, state)
  })
  try {
    const state = await window.localpass.getUpdateState()
    if (!received) Object.assign(updateState, state)
  } catch {
    /* Keep the rest of the password manager usable. */
  }
  return stop
}
