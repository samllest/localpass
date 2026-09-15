/* global chrome */

function visible(element) {
  if (!element) return false
  const style = window.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return (
    style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  )
}

function findLoginFields() {
  const passwordInput = Array.from(document.querySelectorAll('input[type="password"]')).find(
    visible
  )
  if (!passwordInput) return null

  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'))
  const candidates = inputs.filter(
    (input) =>
      visible(input) && ['text', 'email', 'tel', ''].includes(input.type) && input !== passwordInput
  )
  const usernameInput =
    candidates.find((input) => {
      const hint =
        `${input.name} ${input.id} ${input.autocomplete} ${input.placeholder}`.toLowerCase()
      return /user|email|login|account|name/.test(hint)
    }) ||
    candidates[0] ||
    null

  return { passwordInput, usernameInput }
}

function setInputValue(input, value) {
  if (!input) return
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function removePicker(picker) {
  picker?.remove()
  if (picker?.outsideClick) document.removeEventListener('click', picker.outsideClick, true)
}

function showPicker(fields, accounts) {
  const { passwordInput, usernameInput } = fields
  if (passwordInput.dataset.localpassReady === '1') return
  passwordInput.dataset.localpassReady = '1'

  const picker = document.createElement('div')
  picker.dataset.localpassPicker = '1'
  picker.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'background:#151923',
    'color:#f3f4f6',
    'border:1px solid #394156',
    'border-radius:8px',
    'padding:6px',
    'min-width:190px',
    'font:12px system-ui,sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,.35)'
  ].join(';')

  const rect = passwordInput.getBoundingClientRect()
  picker.style.left = `${Math.max(8, Math.min(window.innerWidth - 210, rect.right - 200))}px`
  picker.style.top = `${Math.min(window.innerHeight - 44, rect.bottom + 6)}px`

  const title = document.createElement('div')
  title.textContent = 'LocalPass accounts'
  title.style.cssText = 'padding:4px 6px 6px;color:#aeb7cc;font-weight:600'
  picker.appendChild(title)

  accounts.forEach((account) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = account.username || account.displayName || 'Saved account'
    button.style.cssText = [
      'display:block',
      'width:100%',
      'border:0',
      'border-radius:5px',
      'padding:7px 8px',
      'background:transparent',
      'color:#f3f4f6',
      'text-align:left',
      'cursor:pointer'
    ].join(';')
    button.addEventListener('mouseenter', () => {
      button.style.background = '#273047'
    })
    button.addEventListener('mouseleave', () => {
      button.style.background = 'transparent'
    })
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      setInputValue(usernameInput, account.username || '')
      setInputValue(passwordInput, account.password || '')
      removePicker(picker)
    })
    picker.appendChild(button)
  })

  picker.outsideClick = (event) => {
    if (!picker.contains(event.target)) removePicker(picker)
  }
  document.body.appendChild(picker)
  setTimeout(() => document.addEventListener('click', picker.outsideClick, true), 0)
}

let lookupTimer = null

function requestAutofill() {
  const fields = findLoginFields()
  if (!fields) return

  chrome.runtime.sendMessage(
    {
      type: 'LP_LOOKUP',
      identity: window.location.hostname
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok || !response.accounts?.length) return
      showPicker(fields, response.accounts)
    }
  )
}

function tryCaptureLogin() {
  const passwordInputs = document.querySelectorAll('input[type="password"]')
  let targetPasswordInput = null

  for (let i = 0; i < passwordInputs.length; i++) {
    if (passwordInputs[i].value) {
      targetPasswordInput = passwordInputs[i]
      break
    }
  }

  if (targetPasswordInput && targetPasswordInput.value) {
    const password = targetPasswordInput.value
    const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'))
    const pwdIndex = allInputs.indexOf(targetPasswordInput)
    let username = ''

    for (let i = pwdIndex - 1; i >= 0; i--) {
      if (['text', 'email', 'tel', ''].includes(allInputs[i].type)) {
        username = allInputs[i].value
        if (username) break
      }
    }

    if (!username) {
      const textInputs = document.querySelectorAll('input[type="text"], input[type="email"]')
      if (textInputs.length > 0) username = textInputs[0].value
    }

    chrome.runtime.sendMessage({
      type: 'LP_LOGIN_SUBMITTED',
      payload: {
        identity: window.location.hostname,
        display_name: document.title || window.location.hostname,
        username,
        password
      }
    })
  }
}

document.addEventListener('submit', tryCaptureLogin, true)
document.addEventListener(
  'click',
  (event) => {
    const element = event.target
    const isButton = element.closest?.(
      'button, input[type="button"], input[type="submit"], [class*="login"], [class*="submit"], [class*="btn"]'
    )
    if (isButton) tryCaptureLogin()
  },
  true
)
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Enter') tryCaptureLogin()
  },
  true
)

requestAutofill()
const observer = new MutationObserver(() => {
  if (lookupTimer) clearTimeout(lookupTimer)
  lookupTimer = setTimeout(requestAutofill, 250)
})
observer.observe(document.documentElement, { childList: true, subtree: true })
