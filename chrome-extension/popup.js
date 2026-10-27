/* global chrome */

async function bridgeFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${globalThis.LP_BRIDGE_TOKEN || ''}` },
    redirect: 'error',
    cache: 'no-store'
  })
}

const captureMessages = {
  submitted: '已检测到登录或注册提交，正在等待结果。',
  saving: '正在保存账号密码到桌面端。',
  saved: '账号密码已保存。',
  unchanged: '账号密码已存在，无需重复保存。',
  cancelled: '已取消保存。',
  locked: '保存时密码库未解锁。解锁后请重新登录网站，或手动添加账号。',
  'save-failed': '桌面端未能保存，请保持 LocalPass 已解锁后重试。',
  disconnected: '保存时无法连接桌面端，请检查 LocalPass 是否正在运行。',
  'login-failed': '未确认登录或注册成功，未保存本次密码。',
  'request-failed': '登录或注册期间的请求失败，未保存本次密码。',
  expired: '等待登录或注册结果已超时，未保存本次密码。'
}

async function connectionStatus() {
  const element = document.querySelector('#connection')
  try {
    // No identity is supplied: the bridge checks its lock before rejecting
    // this request, so this probe cannot retrieve any saved credentials.
    const response = await bridgeFetch('http://127.0.0.1:35320/lookup', {
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
    const response = await bridgeFetch(
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
      capture.textContent = '当前页面不支持账号捕获。'
      return
    }
    try {
      const status = await chrome.tabs.sendMessage(tab.id, { type: 'LP_INSPECT_PAGE' })
      page.textContent = status?.ready
        ? status.hasRegistrationFields
          ? '检测脚本已运行，已找到注册密码输入框。'
          : status.hasLoginFields
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
      capture.textContent = '尚未记录到此网站的登录或注册提交。请刷新页面后重试。'
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
    await Promise.allSettled([
      connectionStatus(),
      pageStatus(),
      extensionUpdateStatus(),
      currentAccounts()
    ])
  } finally {
    button.disabled = false
  }
}

document.querySelector('#refresh').addEventListener('click', refresh)
void refresh()

async function currentAccounts() {
  const list = document.querySelector('#accounts')
  list.replaceChildren()
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = new URL(tab.url)
    if (!['http:', 'https:'].includes(url.protocol)) {
      list.textContent = '请在网站中打开扩展。'
      return
    }
    document.querySelector('#site-name').textContent = url.host
    let metadata = {}
    try {
      metadata = (await chrome.tabs.sendMessage(tab.id, { type: 'LP_SITE_METADATA' })) || {}
    } catch {
      /* Site metadata is optional. */
    }
    const request = new URL('http://127.0.0.1:35320/lookup')
    request.searchParams.set('identity', url.host)
    for (const key of ['site_name', 'page_title', 'project_name'])
      if (metadata[key]) request.searchParams.set(key, metadata[key])
    const response = await bridgeFetch(request, { signal: AbortSignal.timeout(3000) })
    if (response.status === 401) {
      list.textContent = '连接尚未授权，请使用桌面端管理的扩展目录。'
      return
    }
    if (response.status === 423) {
      list.textContent = '请先解锁桌面密码库。'
      return
    }
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error('lookup')
    if (!result.accounts.length) {
      list.textContent = '尚无已保存账号。登录或注册成功后会自动记录。'
      return
    }
    for (const account of result.accounts) {
      const row = document.createElement('div')
      row.className = 'popup-account'
      const label = document.createElement('strong')
      label.textContent = account.username || '未填写用户名'
      const fill = document.createElement('button')
      fill.textContent = '填入网页'
      fill.onclick = async () => {
        fill.disabled = true
        try {
          const current = await chrome.tabs.get(tab.id)
          if (current.url !== tab.url) throw new Error('Page changed')
          const filled = await chrome.tabs.sendMessage(tab.id, { type: 'LP_FILL_ACCOUNT', account })
          fill.textContent = filled?.ok ? '已填入' : '未找到登录表单'
        } catch {
          fill.textContent = '页面已变化，请重新打开面板'
        } finally {
          fill.disabled = false
        }
      }
      row.append(label, fill)
      list.append(row)
    }
  } catch {
    list.textContent = '暂时无法读取，请检查桌面端连接。'
  }
}
