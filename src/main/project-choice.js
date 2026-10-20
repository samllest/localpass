import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { projectName } from '../shared/project-matching.js'

const windows = new Set()
let queue = Promise.resolve()

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]
  )

export function choiceHtml({ identity, project, accounts, saving }, token) {
  const link = (id) => `https://localpass.invalid/${token}/${id}`
  const rows = accounts
    .map(
      (account, index) => `<a class="account" href="${link(index)}">
    <span class="mark" aria-hidden="true">${escape((projectName(account) || '?').slice(0, 1))}</span>
    <span class="copy"><strong>${escape(projectName(account) || '未命名项目')}</strong>
    <span>${escape(account.username || '未填写用户名')}</span>
    <small>${escape(account.display_name)} · 记录 #${Number(account.app_id)}${account.captured_at ? ` · ${escape(account.captured_at)} UTC` : ''}</small></span>
    <span aria-hidden="true">›</span></a>`
    )
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>LocalPass · 选择项目账号</title><style>
    :root{color-scheme:light;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#253047;background:#f7f9fc;font-size:14px}
    *{box-sizing:border-box}body{margin:0;padding:28px}header small{color:#5169b0;font-weight:600}h1{font-size:22px;line-height:1.4;margin:10px 0}
    p{line-height:1.7;color:#66728a;margin:0 0 16px;overflow-wrap:anywhere}.address{background:#edf1f8;padding:12px 14px;border-radius:10px;margin-bottom:20px;overflow-wrap:anywhere}.address strong{display:block;margin-bottom:5px}
    nav{display:grid;gap:10px}.account{display:flex;gap:12px;align-items:center;padding:14px;color:inherit;text-decoration:none;background:white;border:1px solid #dce3ef;border-radius:12px;min-height:80px}
    .account:hover{background:#eef3ff;border-color:#b1c1e8}a:focus-visible{outline:3px solid #5173ce;outline-offset:3px}.mark{background:#e7edfc;color:#4866b0;border-radius:10px;width:38px;height:38px;display:grid;place-items:center;flex-shrink:0;font-weight:600}
    .copy{display:grid;gap:5px;flex:1;min-width:0;overflow-wrap:anywhere}.copy strong{font-size:15px}.copy small{color:#79849a;font-size:12px}footer{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:24px;flex-wrap:wrap}footer a{color:#4866b0;padding:10px;text-decoration:none;border-radius:6px}footer a:hover{background:#e9eef9}.hint{font-size:12px;margin:18px 0 0}
    </style></head><body><header><small>LOCALPASS · 开发环境</small><h1>${saving ? '这次登录要保存到哪里？' : '选择要使用的项目账号'}</h1>
    <p>${saving ? '同一地址已有记录，请确认更新对象，也可以单独保存为新记录。' : '这个地址有无法唯一识别的项目或账号，请选择后再填充。'}</p></header>
    <div class="address"><strong>${escape(project || '网页未提供项目名称')}</strong>${escape(identity)}</div>
    <nav aria-label="项目账号">${rows}</nav><footer><a href="${link('cancel')}">取消</a>${saving ? `<a href="${link('new')}">另存为新记录</a>` : ''}</footer>
    <p class="hint">关闭此窗口将取消本次${saving ? '保存' : '填充'}。不会自动选择账号。</p></body></html>`
}

export function cancelProjectChoices() {
  for (const window of windows) window.close()
}

export function chooseProjectAccount(options, isValid = () => true) {
  const run = () =>
    new Promise((resolve) => {
      if (!isValid()) return resolve(null)
      const token = randomUUID()
      const window = new BrowserWindow({
        width: 520,
        height: 610,
        minWidth: 420,
        minHeight: 400,
        title: 'LocalPass · 选择项目账号',
        show: true,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        backgroundColor: '#f7f9fc',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      windows.add(window)
      window.focus()
      let result = null
      const timer = setTimeout(() => window.close(), 120000)
      window.on('closed', () => {
        clearTimeout(timer)
        windows.delete(window)
        resolve(isValid() ? result : null)
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event, url) => {
        event.preventDefault()
        const prefix = `https://localpass.invalid/${token}/`
        if (!url.startsWith(prefix)) return
        const choice = url.slice(prefix.length)
        if (choice === 'new' && options.saving) result = 'new'
        else if (/^\d+$/.test(choice)) result = options.accounts[Number(choice)]?.app_id ?? null
        window.close()
      })
      window
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(choiceHtml(options, token))}`)
        .then(() => {
          if (window.isDestroyed()) return
          if (!isValid()) return window.close()
          window.show()
          window.focus()
        })
        .catch(() => {
          if (!window.isDestroyed()) window.close()
        })
    })
  const pending = queue.then(run, run)
  queue = pending.catch(() => null)
  return pending
}
