/* global chrome */

const captureMessages = {
  submitted: '已检测到登录提交，正在等待登录结果。',
  saving: '已检测到登录，正在保存到桌面端。',
  saved: '账号密码已保存。',
  unchanged: '账号密码已存在，无需重复保存。',
  cancelled: '已取消保存。',
  locked: '保存时密码库未解锁。解锁后请重新登录网站。',
  'save-failed': '桌面端未能保存，请保持 LocalPass 已解锁后重试。',
  disconnected: '保存时无法连接桌面端，请检查 LocalPass 是否正在运行。',
  'login-failed': '检测到登录错误或登录表单，未保存本次密码。',
  'request-failed': '登录期间的请求失败，未保存本次密码。',
  expired: '等待登录结果已超时，未保存本次密码。'
}

async function connectionStatus() {
  const element = document.querySelector('#connection')
  try {
    // No identity is supplied: the bridge checks its lock before rejecting
    // this request, so this probe cannot retrieve any saved credentials.
    const response = await fetch('http://127.0.0.1:35320/lookup', {
      signal: AbortSignal.timeout(3000)
    })
    const result = await response.json()
    element.textContent =
      response.status === 423 && result.error === 'Vault locked'
        ? '已连接，密码库尚未解锁。'
        : response.status === 400 && result.error === 'Identity is required'
          ? '已连接，密码库已解锁。'
          : '本机连接响应异常，请重新启动 LocalPass。'
  } catch {
    element.textContent = '无法连接桌面端，请启动 LocalPass；若已启动，请检查浏览器的本机连接权限。'
  }
}

async function extensionUpdateStatus() {
  const element = document.querySelector('#extension-update')
  const current = chrome.runtime.getManifest().version
  try {
    const response = await fetch(
      `http://127.0.0.1:35320/extension-status?version=${encodeURIComponent(current)}`,
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000)
      }
    )
    const result = await response.json()
    element.textContent =
      response.ok && result.ok && result.version
        ? result.version === current
          ? `当前 ${current}，已与桌面端同步。更新后请刷新已打开的登录页。`
          : `当前 ${current}，桌面端已准备 ${result.version}。请到桌面端设置绑定当前扩展目录；首次绑定后在扩展管理页重新加载一次。`
        : `当前 ${current}。请升级桌面端以启用扩展自动更新。`
  } catch {
    element.textContent = `当前 ${current}。启动桌面端后可检查扩展更新。`
  }
}

async function pageStatus() {
  const page = document.querySelector('#page')
  const capture = document.querySelector('#capture')
  const time = document.querySelector('#capture-time')
  time.textContent = ''
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = new URL(tab?.url || '')
    if (!['http:', 'https:'].includes(url.protocol)) {
      page.textContent = '请在需要登录的网站中打开此面板。'
      capture.textContent = '当前页面不支持登录捕获。'
      return
    }
    try {
      const status = await chrome.tabs.sendMessage(tab.id, { type: 'LP_INSPECT_PAGE' })
      page.textContent = status?.ready
        ? status.hasLoginFields
          ? '检测脚本已运行，已找到密码输入框。'
          : '检测脚本已运行，当前页面没有可填写的密码输入框。'
        : '检测脚本版本较旧，请刷新登录页。'
    } catch {
      page.textContent = '检测脚本未响应，请刷新登录页，并检查扩展是否获准访问此网站。'
    }
    const key = `capture-status:${tab.id}`
    const saved = (await chrome.storage.session.get(key))[key]
    if (saved?.origin === url.origin && captureMessages[saved.state]) {
      capture.textContent = captureMessages[saved.state]
      time.textContent = `记录时间：${new Date(saved.at).toLocaleTimeString()}`
    } else {
      capture.textContent = '尚未记录到此网站的登录提交。请刷新登录页后重新登录。'
    }
  } catch {
    page.textContent = '无法检查当前网页，请关闭面板后重试。'
    capture.textContent = '暂时无法读取登录状态。'
  }
}

async function refresh() {
  const button = document.querySelector('#refresh')
  button.disabled = true
  try {
    await Promise.allSettled([connectionStatus(), pageStatus(), extensionUpdateStatus()])
  } finally {
    button.disabled = false
  }
}

document.querySelector('#refresh').addEventListener('click', refresh)
void refresh()
