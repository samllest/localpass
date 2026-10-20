import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

let fontCss
function choiceFonts() {
  if (fontCss !== undefined) return fontCss
  const directory = app.isPackaged
    ? join(process.resourcesPath, 'fonts')
    : fileURLToPath(new URL('../../src/renderer/src/assets/fonts/', import.meta.url))
  fontCss = [400, 500, 700]
    .map((weight) => {
      const data = readFileSync(join(directory, `ardot-${weight}.woff2`)).toString('base64')
      return `@font-face{font-family:'LocalPass Ardot';font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2')}`
    })
    .join('')
  return fontCss
}

export function choiceHtml({ identity, project, accounts, saving }, token) {
  const link = (id) => `https://localpass.invalid/${token}/${id}`
  const nonce = randomUUID()
  const rows = accounts
    .map(
      (
        account,
        index
      ) => `<label class="account" data-search="${escape(`${projectName(account)} ${account.username || ''}`)}">
    <input type="radio" name="account" value="${index}"><span class="copy"><strong>${escape(projectName(account) || '未命名项目')}</strong>
    <small>${escape(account.username || '未填写用户名')} · 记录 #${Number(account.app_id)}</small></span><span class="radio" aria-hidden="true"></span></label>`
    )
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'nonce-${nonce}'">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>LocalPass · 选择项目账号</title><style>
    ${choiceFonts()}
    :root{color-scheme:light;font-family:'LocalPass Ardot','Noto Sans SC','Microsoft YaHei UI',sans-serif;color:#1b2433;background:#a3a6ad;font-size:13px}
    *{box-sizing:border-box}body{margin:0;padding:32px 18px}main{height:490px;max-height:calc(100vh - 64px);padding:24px 24px 16px;background:white;border-radius:16px;display:flex;flex-direction:column}
    header{position:relative;flex-shrink:0}h1{font-size:20px;line-height:29px;margin:0 28px 6px 0;font-weight:700}.close{position:absolute;right:0;top:3px;color:#64748b;text-decoration:none;width:20px;height:20px;text-align:center;font-size:20px;line-height:18px}
    p{line-height:19px;color:#93a0b4;margin:0;overflow-wrap:anywhere}.context{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #search{width:100%;height:36px;background:#f7f9fc;border:0;border-radius:8px;padding:0 12px;margin:12px 0 16px;font:inherit;color:inherit;flex-shrink:0}
    nav{display:flex;flex-direction:column;gap:8px;min-height:0;overflow-y:auto;padding:0 0 4px;flex:1}.account{display:flex;gap:12px;align-items:center;padding:7px 16px;color:inherit;background:white;border:1px solid transparent;border-radius:8px;min-height:52px;cursor:pointer}
    .account:has(input:checked){background:#eaf0ff;border-color:transparent}.account:hover{background:#f7f9fc}.account[hidden]{display:none}.account input{position:absolute;opacity:0}.account:focus-within{outline:2px solid #2f6bf6;outline-offset:-2px}
    .copy{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.copy strong{font-size:14px;font-weight:500;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.copy small{color:#93a0b4;font-size:12px;line-height:17px}.radio{width:20px;height:20px;border:1px solid #d8dfea;border-radius:50%;flex-shrink:0}input:checked~.radio{border:0;background:#2f6bf6}
    footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px;padding:0;flex-shrink:0;height:36px}footer a,footer button{height:36px;display:inline-flex;align-items:center;justify-content:center;padding:0 18px;text-decoration:none;color:#5c6b7d;border-radius:8px;font:inherit;border:0;background:transparent;cursor:pointer}footer .cancel{margin-right:auto;padding:0;color:#2f6bf6}footer button{background:#2f6bf6;color:white;width:80px;padding:0}footer button:disabled{opacity:.45;cursor:not-allowed}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid #2f6bf6;outline-offset:2px}.empty{display:none;padding:20px;text-align:center;color:#93a0b4}
    </style></head><body><main><header><h1>${saving ? '保存对象' : '填充账号'}</h1><a class="close" href="${link('cancel')}" aria-label="关闭">×</a>
    <p class="context" title="${escape(identity)}">${escape(project || identity)} · ${saving ? '请选择要更新的账号，或另存为新记录' : accounts.length > 1 ? '匹配到多个账号，请选择后继续填充' : '请确认此记录属于当前项目后继续填充'}</p></header>
    <input id="search" type="search" aria-label="搜索项目或账号" placeholder="搜索账号">
    <nav aria-label="项目账号">${rows}<p class="empty">未找到匹配的账号</p></nav><footer><a class="cancel" href="${link('cancel')}">取消</a>${saving ? `<a href="${link('new')}">另存为新记录</a>` : ''}<button id="confirm" disabled>确认</button></footer>
    </main><script nonce="${nonce}">
    const radios=[...document.querySelectorAll('input[name="account"]')],confirm=document.getElementById('confirm');
    for(const radio of radios)radio.addEventListener('change',()=>{confirm.disabled=!radios.some(r=>r.checked)});
    document.getElementById('search').addEventListener('input',e=>{const q=e.target.value.trim().toLocaleLowerCase();for(const row of document.querySelectorAll('.account')){row.hidden=!row.dataset.search.toLocaleLowerCase().includes(q);if(row.hidden)row.querySelector('input').checked=false}confirm.disabled=!radios.some(r=>r.checked);document.querySelector('.empty').style.display=radios.every(r=>r.closest('.account').hidden)?'block':'none'});
    confirm.addEventListener('click',()=>{const selected=radios.find(r=>r.checked);if(selected)location.href=${JSON.stringify(link(''))}+selected.value});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')location.href=${JSON.stringify(link('cancel'))}});
    </script></body></html>`
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
        width: 498,
        height: 554,
        useContentSize: true,
        frame: false,
        minWidth: 420,
        minHeight: 400,
        title: 'LocalPass · 选择项目账号',
        show: true,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        backgroundColor: '#a3a6ad',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      windows.add(window)
      window.focus()
      let result = null
      const timer = setTimeout(() => window.close(), 120000)
      const validityTimer = setInterval(() => {
        if (!isValid() && !window.isDestroyed()) window.close()
      }, 150)
      window.on('closed', () => {
        clearTimeout(timer)
        clearInterval(validityTimer)
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
