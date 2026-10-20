/* global chrome */

function visible(element) {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]'))
    return false
  const style = window.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    rect.width > 0 &&
    rect.height > 0
  )
}

function editable(input) {
  return visible(input) && !input.disabled && !input.readOnly
}

function findLoginFields(focusedInput) {
  if (!(focusedInput instanceof HTMLInputElement) || !editable(focusedInput)) return null
  const inputs = Array.from(document.querySelectorAll('input'))
  const passwordInputs = inputs.filter(
    (input) =>
      input.type === 'password' &&
      editable(input) &&
      input.autocomplete !== 'new-password' &&
      input.form === focusedInput.form
  )

  for (const passwordInput of passwordInputs) {
    const beforePassword = inputs.slice(0, inputs.indexOf(passwordInput)).reverse()
    const candidates = beforePassword.filter(
      (input) =>
        input.form === passwordInput.form &&
        editable(input) &&
        ['text', 'email', 'tel'].includes(input.type) &&
        !/search|query|captcha|验证码/i.test(`${input.name} ${input.id} ${input.placeholder}`)
    )
    const usernameInput =
      candidates.find((input) => input.autocomplete === 'username') ||
      candidates.find((input) =>
        /user|email|login|account|name|邮箱|账号|用户名/i.test(
          `${input.name} ${input.id} ${input.autocomplete} ${input.placeholder}`
        )
      ) ||
      candidates[0] ||
      null
    if (focusedInput === passwordInput || focusedInput === usernameInput) {
      return { passwordInput, usernameInput }
    }
  }
  return null
}

function setInputValue(input, value) {
  if (!input) return
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

let activePicker = null
let pendingLookup = null
let lookupSequence = 0
let filling = false
let lastCaptureAt = 0
let loginAttempt = null
let loginAttemptSequence = 0
let lastPageState = ''
let pageStateTimer = null
let autofillSelection = null
const lookupDocumentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
let dismissedDesktopContext = null

function reportPageState() {
  const state = {
    type: 'LP_PAGE_STATE',
    hasLoginFields: Array.from(document.querySelectorAll('input[type="password"]')).some(
      (input) => editable(input) && input.autocomplete !== 'new-password'
    ),
    hasLoginError: loginErrorVisible()
  }
  const key = JSON.stringify(state)
  if (key === lastPageState) return
  lastPageState = key
  try {
    chrome.runtime.sendMessage(state)
  } catch {
    // An extension reload invalidates scripts in already-open documents.
  }
}

function schedulePageState() {
  if (pageStateTimer) return
  pageStateTimer = setTimeout(() => {
    pageStateTimer = null
    reportPageState()
  }, 600)
}

function clearLoginAttempt() {
  if (!loginAttempt) return
  clearTimeout(loginAttempt.successTimer)
  clearTimeout(loginAttempt.checkTimer)
  clearTimeout(loginAttempt.expiryTimer)
  loginAttempt = null
}

function loginTransitionComplete(attempt) {
  return (
    location.origin === attempt.origin &&
    location.href !== attempt.url &&
    !visible(attempt.passwordInput) &&
    !Array.from(document.querySelectorAll('input[type="password"]')).some(
      (input) => editable(input) && input.autocomplete !== 'new-password'
    )
  )
}

function checkLoginOutcome() {
  const attempt = loginAttempt
  if (!attempt) return
  if (loginErrorVisible()) {
    chrome.runtime.sendMessage({ type: 'LP_LOGIN_FAILED', attemptId: attempt.id })
    clearLoginAttempt()
    return
  }
  if (attempt.confirmed) return
  if (!loginTransitionComplete(attempt)) {
    clearTimeout(attempt.successTimer)
    attempt.successTimer = null
    return
  }
  if (attempt.successTimer) return
  // Wait for the new route to settle: a route change alone is not a login.
  attempt.successTimer = setTimeout(() => {
    attempt.successTimer = null
    if (loginAttempt !== attempt) return
    if (loginErrorVisible()) return checkLoginOutcome()
    if (!loginTransitionComplete(attempt)) return
    attempt.confirmed = true
    chrome.runtime.sendMessage({ type: 'LP_LOGIN_SUCCEEDED', attemptId: attempt.id })
  }, 600)
}

function removePicker() {
  // Invalidate in-flight responses as well as removing the visible popup.
  lookupSequence++
  if (pendingLookup) {
    const context = pendingLookup
    dismissedDesktopContext = context
    try {
      const sent = chrome.runtime.sendMessage({
        type: 'LP_LOOKUP_CANCEL',
        requestId: context.requestId
      })
      sent?.catch(() => {})
    } catch {
      // The extension may have been reloaded while a choice was pending.
    }
  }
  pendingLookup = null
  const previous = activePicker
  activePicker = null
  previous?.element.remove()
}

function validContext(context) {
  if (window.location.href !== context.url || document.visibilityState === 'hidden') return false
  const fields = findLoginFields(context.anchor)
  return (
    fields?.passwordInput === context.fields.passwordInput &&
    fields?.usernameInput === context.fields.usernameInput
  )
}

function positionPicker() {
  if (!activePicker) return
  if (!validContext(activePicker)) return removePicker()
  const { anchor, element } = activePicker
  const rect = anchor.getBoundingClientRect()
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) return removePicker()
  const margin = 8
  const width = element.offsetWidth
  const height = element.offsetHeight
  element.style.left = `${Math.max(margin, Math.min(window.innerWidth - width - margin, rect.left))}px`
  const below = rect.bottom + 6
  const top = below + height <= window.innerHeight - margin ? below : rect.top - height - 6
  element.style.top = `${Math.max(margin, Math.min(window.innerHeight - height - margin, top))}px`
}

function focusWithoutOpening(input) {
  filling = true
  try {
    if (editable(input)) input.focus({ preventScroll: true })
  } finally {
    filling = false
  }
}

function showPicker(context, accounts) {
  const picker = document.createElement('div')
  picker.dataset.localpassPicker = '1'
  picker.setAttribute('role', 'group')
  picker.setAttribute('aria-label', 'LocalPass 已保存的账号')
  picker.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'background:#151923',
    'color:#f3f4f6',
    'border:1px solid #394156',
    'border-radius:8px',
    'padding:6px',
    'box-sizing:border-box',
    'width:240px',
    'max-width:calc(100vw - 16px)',
    'max-height:min(300px,calc(100vh - 16px))',
    'overflow:auto',
    'font:12px system-ui,sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,.35)'
  ].join(';')

  const title = document.createElement('div')
  title.textContent = 'LocalPass 已保存的账号'
  title.style.cssText = 'padding:4px 6px 6px;color:#aeb7cc;font-weight:600'
  picker.appendChild(title)

  accounts.forEach((account) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent =
      [account.projectName || account.displayName, account.username].filter(Boolean).join(' · ') ||
      '已保存的账号'
    button.style.cssText = [
      'display:block',
      'width:100%',
      'border:0',
      'border-radius:5px',
      'padding:10px 8px',
      'background:transparent',
      'color:#f3f4f6',
      'text-align:left',
      'overflow-wrap:anywhere',
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
      if (!validContext(context)) return removePicker()
      // Close before firing framework input events. Those events can rerender
      // the form or synchronously focus another field.
      fillAccount(context, account)
    })
    picker.appendChild(button)
  })

  activePicker = { ...context, element: picker }
  document.body.appendChild(picker)
  positionPicker()
}

function fillAccount(context, account) {
  if (!validContext(context)) return removePicker()
  const { usernameInput, passwordInput } = context.fields
  removePicker()
  autofillSelection = {
    token: account.selectionToken,
    username: account.username || '',
    url: location.href
  }
  filling = true
  try {
    setInputValue(usernameInput, account.username || '')
    setInputValue(passwordInput, account.password || '')
    if (editable(passwordInput)) passwordInput.focus({ preventScroll: true })
  } finally {
    filling = false
  }
}

function sameLoginFields(left, right) {
  return (
    left?.passwordInput === right?.passwordInput && left?.usernameInput === right?.usernameInput
  )
}

function requestAutofill(input, explicit = false) {
  if (filling || document.activeElement !== input) return
  const fields = findLoginFields(input)
  if (!fields) return
  // A native chooser can blur/refocus either login field. Keep its original
  // request rather than queuing another native window on focus restoration.
  if (pendingLookup?.url === location.href && sameLoginFields(pendingLookup.fields, fields)) return
  if (activePicker?.anchor === input) return
  if (
    !explicit &&
    dismissedDesktopContext?.url === location.href &&
    sameLoginFields(dismissedDesktopContext.fields, fields)
  )
    return
  removePicker()
  if (explicit) dismissedDesktopContext = null
  const context = {
    fields,
    anchor: input,
    url: window.location.href,
    sequence: lookupSequence,
    requestId: `${lookupDocumentId}:${lookupSequence}`
  }
  pendingLookup = context

  try {
    chrome.runtime.sendMessage(
      {
        type: 'LP_LOOKUP',
        requestId: context.requestId,
        identity: window.location.host,
        ...collectSiteMetadata()
      },
      (response) => {
        const error = chrome.runtime.lastError
        if (context.sequence !== lookupSequence) return
        pendingLookup = null
        if (context.blurred || response?.selected) dismissedDesktopContext = context
        if (
          error ||
          (context.blurred && !response?.selected) ||
          !response?.ok ||
          !response.accounts?.length ||
          !sameLoginFields(findLoginFields(document.activeElement), fields) ||
          !validContext(context)
        )
          return
        context.anchor = document.activeElement
        if (response.selected && response.accounts.length === 1)
          fillAccount(context, response.accounts[0])
        else showPicker(context, response.accounts)
      }
    )
  } catch {
    // A reloaded/disabled extension invalidates content scripts in open tabs.
    removePicker()
  }
}

function loginErrorVisible() {
  const selectors = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '.error',
    '.errors',
    '.alert',
    '.alert-danger',
    '[class*="error"]',
    '[class*="invalid"]'
  ]
  const errorPattern =
    /invalid|incorrect|wrong|failed|failure|error|unauthori[sz]ed|登录失败|登录错误|密码错误|账号错误|不正确|错误/i

  return selectors.some((selector) =>
    Array.from(document.querySelectorAll(selector)).some((element) => {
      if (!visible(element)) return false
      return errorPattern.test(element.textContent || '')
    })
  )
}

function collectSiteMetadata() {
  const siteName =
    document
      .querySelector('meta[property="og:site_name"], meta[name="application-name"]')
      ?.content?.trim() || ''
  const pageTitle = document.title.trim()
  const icon = document.querySelector('link[rel~="icon"], link[rel="apple-touch-icon"]')
  let iconUrl = ''
  try {
    const url = new URL(icon?.getAttribute('href') || '/favicon.ico', document.baseURI)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
      iconUrl = url.href
  } catch {
    /* A missing or malformed icon must not prevent saving a login. */
  }
  return {
    site_name: siteName.slice(0, 160),
    page_title: pageTitle.slice(0, 256),
    project_name: (siteName || pageTitle).slice(0, 256),
    site_url: window.location.origin,
    icon_url: iconUrl.slice(0, 2048),
    display_name: (siteName || pageTitle || window.location.host).slice(0, 256)
  }
}

function tryCaptureLogin(event) {
  if (event.target.closest?.('[data-localpass-picker]')) return
  const form = event.target.closest?.('form')
  const passwordInput = Array.from(document.querySelectorAll('input[type="password"]')).find(
    (input) =>
      editable(input) && input.value && input.form === form && input.autocomplete !== 'new-password'
  )
  if (!passwordInput) return
  const fields = findLoginFields(passwordInput)
  if (!fields) return

  if (event.type === 'click') {
    const button = event.target.closest?.(
      'button, input[type="button"], input[type="submit"], [role="button"]'
    )
    const buttonForm = button?.form || button?.closest('form') || null
    if (!button || buttonForm !== passwordInput.form) return
    const isSubmit = button.type === 'submit'
    const isLogin = /log\s*in|sign\s*in|登录|登入/i.test(
      `${button.textContent || ''} ${button.value || ''} ${button.name || ''} ${button.id || ''}`
    )
    if (!isSubmit && !isLogin) return
  }
  if (
    event.type === 'keydown' &&
    event.target !== fields.usernameInput &&
    event.target !== passwordInput
  )
    return

  removePicker()
  if (Date.now() - lastCaptureAt < 800) return
  clearLoginAttempt()
  const attempt = {
    id: `${Date.now()}-${++loginAttemptSequence}`,
    url: location.href,
    origin: location.origin,
    passwordInput
  }
  loginAttempt = attempt
  chrome.runtime.sendMessage({
    type: 'LP_LOGIN_SUBMITTED',
    attemptId: attempt.id,
    payload: {
      identity: window.location.host,
      page_url: window.location.href,
      form_action: passwordInput.form?.action || window.location.href,
      ...collectSiteMetadata(),
      selection_token:
        autofillSelection?.url === location.href &&
        autofillSelection.username === (fields.usernameInput?.value || '')
          ? autofillSelection.token
          : undefined,
      username: fields.usernameInput?.value || '',
      password: passwordInput.value
    }
  })
  lastCaptureAt = Date.now()

  attempt.checkTimer = setTimeout(checkLoginOutcome, 1200)
  attempt.expiryTimer = setTimeout(() => {
    if (loginAttempt === attempt) clearLoginAttempt()
  }, 15000)
}

// Only focus/click on a live login field opens the picker. DOM mutations must
// never initiate lookups: removing our own popup is itself a DOM mutation.
document.addEventListener('focusin', (event) => {
  if (activePicker?.element.contains(event.target)) return
  if (!findLoginFields(event.target)) removePicker()
  else requestAutofill(event.target)
})
document.addEventListener('focusout', (event) => {
  const context = activePicker || pendingLookup
  if (!context || context.element?.contains(event.relatedTarget)) return
  // relatedTarget is null when focus moves into the desktop chooser. A real
  // click elsewhere, navigation, typing or hiding the form still cancels it.
  if (pendingLookup && !event.relatedTarget) return
  if (pendingLookup && sameLoginFields(findLoginFields(event.relatedTarget), context.fields)) return
  if (event.target === context.anchor || context.element?.contains(event.target)) removePicker()
})
document.addEventListener('input', (event) => {
  if (
    !filling &&
    pendingLookup &&
    sameLoginFields(findLoginFields(event.target), pendingLookup.fields)
  )
    removePicker()
})
document.addEventListener(
  'pointerdown',
  (event) => {
    const context = activePicker || pendingLookup
    if (context && event.target !== context.anchor && !context.element?.contains(event.target))
      removePicker()
  },
  true
)
document.addEventListener(
  'click',
  (event) => {
    if (event.target.closest?.('[data-localpass-picker]')) return
    requestAutofill(event.target, true)
    tryCaptureLogin(event)
  },
  true
)
document.addEventListener(
  'submit',
  (event) => {
    removePicker()
    tryCaptureLogin(event)
  },
  true
)
document.addEventListener(
  'keydown',
  (event) => {
    const context = activePicker || pendingLookup
    if (event.key === 'Escape' && context) {
      event.preventDefault()
      removePicker()
      focusWithoutOpening(context.anchor)
    } else if (event.key === 'ArrowDown' && activePicker && event.target === activePicker.anchor) {
      event.preventDefault()
      activePicker.element.querySelector('button')?.focus()
    } else if (event.key === 'Enter') tryCaptureLogin(event)
  },
  true
)
window.addEventListener('blur', () => {
  // The desktop chooser takes focus. Retain only its pending request; ordinary
  // late replies still stay dismissed, and page/user changes invalidate it.
  if (pendingLookup) pendingLookup.blurred = true
  else removePicker()
})
window.addEventListener('pagehide', removePicker)
window.addEventListener('popstate', () => {
  removePicker()
  checkLoginOutcome()
})
window.addEventListener('hashchange', () => {
  removePicker()
  checkLoginOutcome()
})
window.navigation?.addEventListener('navigate', removePicker)
window.addEventListener('scroll', positionPicker, true)
window.addEventListener('resize', positionPicker)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') removePicker()
})
const observer = new MutationObserver((mutations) => {
  checkLoginOutcome()
  schedulePageState()
  const context = activePicker || pendingLookup
  if (!context) return
  if (mutations.every((mutation) => context.element?.contains(mutation.target))) return
  if (!validContext(context) || (activePicker && !activePicker.element.isConnected)) removePicker()
  else if (activePicker) positionPicker()
})
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: [
    'class',
    'style',
    'hidden',
    'inert',
    'aria-hidden',
    'disabled',
    'readonly',
    'type',
    'autocomplete'
  ]
})
schedulePageState()
