/* global chrome */

;(() => {
  const version = chrome.runtime.getManifest?.().version || '1.4.2'
  const existing = globalThis.__localpassContent
  if (existing?.version === version && existing.alive()) return
  // A DOM event also reaches an invalidated isolated world after runtime.reload.
  document.dispatchEvent(new Event('localpass-content-dispose'))
  // Releases before 1.3.7 had no disposer; remove any picker they left behind.
  document.querySelectorAll('[data-localpass-picker]').forEach((element) => element.remove())
  const handlers = []
  let disposed = false
  let retryTimer = null
  const shadowObservers = []
  let shadowTimer
  function queryAll(selector, root = document) {
    const found = Array.from(root.querySelectorAll(selector))
    for (const element of root.querySelectorAll('*')) {
      if (!element.shadowRoot || element.closest('[data-localpass-picker]')) continue
      found.push(...queryAll(selector, element.shadowRoot))
    }
    return found
  }
  function listen(target, type, callback, options) {
    if (!target) return
    target.addEventListener(type, callback, options)
    handlers.push(() => target.removeEventListener(type, callback, options))
  }
  function retryLookup(input) {
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      if (!disposed && document.visibilityState !== 'hidden' && document.activeElement === input)
        requestAutofill(input, true)
    }, 2000)
  }

  function visible(element) {
    if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]'))
      return false
    const host = element.getRootNode()?.host
    if (host && !visible(host)) return false
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

  const knownPasswordInputs = new WeakSet()
  const registrationPattern =
    /regist(?:er|ration)|sign[\s_-]*up|create[\s_-]*(?:an?[\s_-]*)?account|注册|创建(?:新)?(?:账号|帐户|账户)/i
  const passwordChangePattern =
    /(?:reset|change|forgot|recover)[\s_/-]*password|password[\s_/-]*(?:reset|change|recovery)|重置密码|修改密码|更改密码|找回密码|忘记密码/i

  function passwordField(input) {
    if (input.type === 'password') knownPasswordInputs.add(input)
    return (
      input.type === 'password' ||
      (input.type === 'text' &&
        (['current-password', 'new-password'].includes(input.autocomplete) ||
          knownPasswordInputs.has(input)))
    )
  }

  function loginPasswordInput(input) {
    if (input.autocomplete === 'new-password') return false
    return passwordField(input)
  }

  function passwordChangeContext(input, action = '') {
    const form = input.form
    const context = `${location.pathname} ${location.hash} ${document.title} ${form?.getAttribute('action') || ''} ${form?.id || ''} ${action}`
    return (
      passwordChangePattern.test(context) ||
      Array.from(
        (form || document).querySelectorAll('button, input[type="submit"], [role="button"]')
      ).some(
        (button) =>
          visible(button) &&
          passwordChangePattern.test(`${button.textContent || ''} ${button.value || ''}`)
      )
    )
  }

  function registrationContext(input, action = '') {
    const form = input.form
    const inputs = queryAll('input').filter((field) => field.form === form && visible(field))
    const buttons = Array.from(
      (form || document).querySelectorAll('button, input[type="submit"], [role="button"]')
    )
    const context = `${location.pathname} ${location.hash} ${form?.getAttribute('action') || ''} ${form?.id || ''} ${form?.name || ''} ${action}`
    if (
      passwordChangeContext(input, action) ||
      inputs.some(
        (field) =>
          field.autocomplete === 'current-password' ||
          (passwordField(field) &&
            /old|current|原密码|旧密码/i.test(`${field.name} ${field.id} ${field.placeholder}`))
      )
    )
      return false
    return (
      registrationPattern.test(context) ||
      inputs.some((field) => field.autocomplete === 'new-password') ||
      buttons.some(
        (button) =>
          visible(button) &&
          registrationPattern.test(`${button.textContent || ''} ${button.value || ''}`)
      )
    )
  }

  function findUsernameInput(passwordInput, inputs, registration = false) {
    const candidates = (
      registration ? inputs : inputs.slice(0, inputs.indexOf(passwordInput)).reverse()
    ).filter(
      (input) =>
        input.form === passwordInput.form &&
        editable(input) &&
        !passwordField(input) &&
        ['text', 'email', 'tel'].includes(input.type) &&
        !/search|query|captcha|verification|verify|confirm|otp|code|验证码|确认|姓名|real.?name|full.?name/i.test(
          `${input.name} ${input.id} ${input.autocomplete} ${input.placeholder}`
        )
    )
    return (
      candidates.find((input) => input.autocomplete === 'username') ||
      candidates.find((input) =>
        /user|login|account|邮箱|账号|用户名/i.test(
          `${input.name} ${input.id} ${input.placeholder}`
        )
      ) ||
      candidates.find((input) => input.type === 'email' || input.autocomplete === 'email') ||
      candidates.find(
        (input) =>
          input.type === 'tel' ||
          /email|phone|mobile|手机|电话/i.test(`${input.name} ${input.id} ${input.placeholder}`)
      ) ||
      candidates[0] ||
      null
    )
  }

  function findRegistrationFields(form, action = '') {
    const inputs = queryAll('input')
    const passwords = inputs.filter(
      (input) => input.form === form && passwordField(input) && editable(input)
    )
    if (!passwords.length || !registrationContext(passwords[0], action)) return null
    const passwordInput =
      passwords.find(
        (input) =>
          !/confirm|repeat|again|确认|重复|再次/i.test(
            `${input.name} ${input.id} ${input.placeholder}`
          )
      ) || passwords[0]
    const usernameInput = findUsernameInput(passwordInput, inputs, true)
    if ((usernameInput && !usernameInput.value.trim()) || !passwordInput.value) return null
    // Never persist an incomplete or inconsistent registration form.
    if (passwords.some((input) => input.value !== passwordInput.value)) return null
    if (inputs.some((input) => input.form === form && input.matches(':invalid'))) return null
    return { passwordInput, usernameInput, passwordInputs: passwords }
  }

  function findLoginFields(focusedInput) {
    if (!(focusedInput instanceof HTMLInputElement) || !editable(focusedInput)) return null
    const inputs = queryAll('input')
    const passwordInputs = inputs.filter(
      (input) =>
        loginPasswordInput(input) &&
        editable(input) &&
        input.autocomplete !== 'new-password' &&
        !registrationContext(input) &&
        input.form === focusedInput.form
    )

    for (const passwordInput of passwordInputs) {
      const usernameInput = findUsernameInput(passwordInput, inputs)
      if (focusedInput === passwordInput || focusedInput === usernameInput) {
        return { passwordInput, usernameInput }
      }
    }
    return null
  }

  function findPasswordChangeFields(form, action) {
    const inputs = queryAll('input').filter((input) => input.form === form && editable(input))
    const passwords = inputs.filter(passwordField)
    if (!passwords.length || !passwordChangeContext(passwords[0], action)) return null
    const oldInput = passwords.find(
      (input) =>
        input.autocomplete === 'current-password' ||
        /old|current|旧密码|原密码/i.test(`${input.name} ${input.id} ${input.placeholder}`)
    )
    const newInputs = passwords.filter((input) => input !== oldInput)
    const passwordInput =
      newInputs.find(
        (input) =>
          !/confirm|repeat|确认|重复/i.test(`${input.name} ${input.id} ${input.placeholder}`)
      ) || newInputs[0]
    if (
      !passwordInput?.value ||
      newInputs.some((input) => input.value !== passwordInput.value) ||
      inputs.some((input) => input.matches(':invalid'))
    )
      return null
    return {
      passwordInput,
      usernameInput: findUsernameInput(passwordInput, inputs, true),
      passwordInputs: passwords,
      previousPassword: oldInput?.value || ''
    }
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
  let siteIconTimer = null
  let lastSiteMetadata = ''
  let autofillSelection = null
  const lookupDocumentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let dismissedDesktopContext = null
  let focusedLookupState = null
  const PICKER_METRICS = { edge: 8, gap: 8, width: 320, maxHeight: 320 }
  // Keep the extension's palette and type independent of the website's controls.
  const PICKER_STYLES = `
    [data-localpass-picker="1"], [data-localpass-picker="1"] *:where(:not(svg):not(path)) {
      all: initial; box-sizing: border-box; font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
      font-size: 12px; line-height: 1.5; letter-spacing: normal; text-transform: none;
      direction: ltr; -webkit-text-fill-color: currentColor;
    }
    [data-localpass-picker="1"] style { display: none; }
    [data-localpass-picker="1"] *::before, [data-localpass-picker="1"] *::after { content: none; }
    [data-localpass-picker="1"] {
      --lp-surface: #ffffff; --lp-text: #1b2433; --lp-muted: #5c6b7d;
      --lp-border: #e7eaf0; --lp-accent: #2f6bf6; --lp-tint: #eaf0ff;
      --lp-key: #f7f9fc; --lp-on-accent: #ffffff;
      position: fixed; z-index: 2147483647; display: block;
      width: ${PICKER_METRICS.width}px; max-width: calc(100vw - ${PICKER_METRICS.edge * 2}px);
      max-height: min(${PICKER_METRICS.maxHeight}px, calc(100vh - ${PICKER_METRICS.edge * 2}px));
      overflow: auto; overscroll-behavior: contain; scrollbar-width: thin;
      padding: 8px; border: 1px solid var(--lp-border); border-radius: 16px;
      background: var(--lp-surface); color: var(--lp-text); color-scheme: light;
      box-shadow: 0 4px 12px rgb(27 36 51 / 6%), 0 12px 32px rgb(27 36 51 / 12%);
      -webkit-font-smoothing: antialiased; text-align: left;
    }
    [data-localpass-picker="1"] .lp-header {
      display: flex; align-items: center; gap: 8px; padding: 4px 8px 12px;
    }
    [data-localpass-picker="1"] .lp-brand {
      display: flex; align-items: center; justify-content: center; flex: 0 0 24px;
      width: 24px; height: 24px; border-radius: 8px; background: var(--lp-accent); color: var(--lp-on-accent);
    }
    [data-localpass-picker="1"] .lp-icon {
      display: block; width: 16px; height: 16px; fill: none; stroke: currentColor;
      stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; color: inherit;
    }
    [data-localpass-picker="1"] .lp-icon path { fill: none; stroke: inherit; stroke-width: inherit; }
    [data-localpass-picker="1"] .lp-title {
      display: block; color: var(--lp-text); font-size: 12px; font-weight: 600;
    }
    [data-localpass-picker="1"] .lp-count {
      display: block; margin-left: auto; color: var(--lp-muted); font-size: 11px;
    }
    [data-localpass-picker="1"] .lp-account {
      display: flex; align-items: center; gap: 12px; width: 100%; min-height: 64px;
      margin: 0; padding: 12px; border: 0; border-radius: 8px;
      background: transparent; color: var(--lp-text); cursor: pointer; text-align: left;
    }
    [data-localpass-picker="1"] .lp-account + .lp-account { margin-top: 4px; }
    [data-localpass-picker="1"] .lp-account:hover,
    [data-localpass-picker="1"] .lp-account:focus-visible {
      background: var(--lp-tint);
    }
    [data-localpass-picker="1"] .lp-account:focus-visible {
      outline: 2px solid var(--lp-accent); outline-offset: -2px;
    }
    [data-localpass-picker="1"] .lp-account:active { opacity: 0.8; }
    [data-localpass-picker="1"] .lp-avatar {
      display: flex; align-items: center; justify-content: center; flex: 0 0 32px;
      width: 32px; height: 32px; border-radius: 8px; background: var(--lp-tint);
      color: var(--lp-accent); font-size: 14px; font-weight: 600;
    }
    [data-localpass-picker="1"] .lp-labels { display: block; flex: 1; min-width: 0; }
    [data-localpass-picker="1"] .lp-username {
      display: block; color: var(--lp-text); font-size: 14px; font-weight: 600;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis; unicode-bidi: plaintext;
    }
    [data-localpass-picker="1"] .lp-site {
      display: block; margin-top: 2px; color: var(--lp-muted); font-size: 12px;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis; unicode-bidi: plaintext;
    }
    [data-localpass-picker="1"] .lp-fill {
      display: flex; align-items: center; flex: 0 0 16px; color: var(--lp-muted);
    }
    [data-localpass-picker="1"] .lp-account:hover .lp-fill,
    [data-localpass-picker="1"] .lp-account:focus-visible .lp-fill { color: var(--lp-accent); }
    [data-localpass-picker="1"] .lp-footer {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      margin-top: 8px; padding: 12px 8px 4px; border-top: 1px solid var(--lp-border);
    }
    [data-localpass-picker="1"] .lp-hint { display: block; color: var(--lp-muted); font-size: 11px; }
    [data-localpass-picker="1"] .lp-shortcut {
      display: block; padding: 2px 6px; border: 1px solid var(--lp-border); border-radius: 4px;
      background: var(--lp-key); color: var(--lp-muted); font-size: 11px; white-space: nowrap;
    }
    @media (prefers-color-scheme: dark) {
      [data-localpass-picker="1"] {
        --lp-surface: #1e2230; --lp-text: #e6e9f0; --lp-muted: #9aa4b6;
        --lp-border: #303649; --lp-accent: #6b9dff; --lp-tint: #262f4f;
        --lp-key: #2a2f40; --lp-on-accent: #15181f; color-scheme: dark;
      }
    }
  `.replace(/;/g, ' !important;')

  function pickerIcon(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('lp-icon')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    shape.setAttribute('d', path)
    svg.appendChild(shape)
    return svg
  }

  function pickerText(className, text) {
    const element = document.createElement('span')
    element.className = className
    element.textContent = text
    return element
  }

  function reportPageState() {
    recoverFocusedLookup()
    const state = {
      type: 'LP_PAGE_STATE',
      hasLoginFields: queryAll('input').some(
        (input) => loginPasswordInput(input) && editable(input)
      ),
      hasLoginError: loginErrorVisible(),
      hasRegistrationFields: queryAll('input').some(
        (input) => passwordField(input) && visible(input) && registrationContext(input)
      ),
      registrationSucceeded: registrationSuccessVisible()
      , passwordChangeSucceeded: successMessages('password-change').length > 0
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
    if (attempt.networkConfirmed && !visible(attempt.passwordInput)) return true
    if (successMessages(attempt.kind).some((message) => !attempt.successMessages.includes(message)))
      return true
    if (attempt.registration) {
      if (location.origin !== attempt.origin) return false
      if (registrationSuccessVisible(attempt.successMessages)) return true
      // Registration commonly returns to a login form instead of signing in.
      // A loading/disabled registration form still counts as present.
      return (
        location.href !== attempt.url &&
        !visible(attempt.passwordInput) &&
        !queryAll('input').some(
          (input) => passwordField(input) && visible(input) && registrationContext(input)
        )
      )
    }
    return (
      location.origin === attempt.origin &&
      location.href !== attempt.url &&
      !visible(attempt.passwordInput) &&
      !queryAll('input').some((input) => loginPasswordInput(input) && editable(input))
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
    clearTimeout(retryTimer)
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
    if (
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth
    )
      return removePicker()
    const { edge, gap } = PICKER_METRICS
    const { width, height } = element.getBoundingClientRect()
    let left = rect.left
    let top = rect.top - height - gap
    // Browser password suggestions are native UI, above every page z-index.
    // Leave the area below the input clear whenever another position fits.
    if (top < edge) {
      top = rect.top
      if (rect.right + gap + width <= window.innerWidth - edge) left = rect.right + gap
      else if (rect.left - gap - width >= edge) left = rect.left - gap - width
      else top = rect.bottom + gap
    }
    element.style.setProperty('left', `${Math.max(edge, Math.min(window.innerWidth - width - edge, left))}px`, 'important')
    element.style.setProperty('top', `${Math.max(edge, Math.min(window.innerHeight - height - edge, top))}px`, 'important')
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
    const style = document.createElement('style')
    style.textContent = PICKER_STYLES
    picker.appendChild(style)
    const header = document.createElement('div')
    header.className = 'lp-header'
    header.setAttribute('aria-hidden', 'true')
    const brand = pickerText('lp-brand', '')
    brand.appendChild(pickerIcon('M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z M8 12l3 3 5-6'))
    header.append(brand, pickerText('lp-title', 'LocalPass'), pickerText('lp-count', `${accounts.length} 个账号`))
    picker.appendChild(header)

    accounts.forEach((account) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'lp-account'
      const username = account.username || '未命名账号'
      const site = account.projectName || account.displayName || location.host
      button.title = `${username} · ${site}`
      button.setAttribute('aria-label', `填入账号 ${username}，${site}`)
      const avatar = pickerText('lp-avatar', Array.from(username)[0].toLocaleUpperCase())
      avatar.setAttribute('aria-hidden', 'true')
      const labels = pickerText('lp-labels', '')
      labels.append(pickerText('lp-username', username), pickerText('lp-site', site))
      const fill = pickerText('lp-fill', '')
      fill.appendChild(pickerIcon('M4 12h16 M14 6l6 6-6 6'))
      button.append(avatar, labels, fill)
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (!validContext(context)) return removePicker()
        // Close before firing framework input events. Those events can rerender
        // the form or synchronously focus another field.
        fillAccount(context, account)
      })
      picker.appendChild(button)
    })
    const footer = document.createElement('div')
    footer.className = 'lp-footer'
    footer.append(pickerText('lp-hint', '选择账号即可填入'), pickerText('lp-shortcut', 'Alt + Shift + L'))
    picker.appendChild(footer)

    activePicker = { ...context, element: picker }
    document.body.appendChild(picker)
    positionPicker()
    if (context.focusPicker && activePicker?.element === picker)
      picker.querySelector('button')?.focus({ preventScroll: true })
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
    reportAccountUsed(account)
  }

  function reportAccountUsed(account) {
    if (!account.selectionToken) return
    try {
      chrome.runtime
        .sendMessage({ type: 'LP_ACCOUNT_USED', selectionToken: account.selectionToken })
        ?.catch(() => {})
    } catch {
      /* Filling remains usable if the desktop connection disappears. */
    }
  }

  function sameLoginFields(left, right) {
    return (
      left?.passwordInput === right?.passwordInput && left?.usernameInput === right?.usernameInput
    )
  }

  function lookupMetadataKey(metadata) {
    return JSON.stringify([metadata.site_name, metadata.page_title, metadata.project_name])
  }

  function recoverFocusedLookup() {
    const state = focusedLookupState
    if (
      !state ||
      disposed ||
      filling ||
      activePicker ||
      pendingLookup ||
      state.sequence !== lookupSequence ||
      state.url !== location.href ||
      document.activeElement !== state.input ||
      !document.hasFocus() ||
      document.visibilityState === 'hidden'
    )
      return false
    const fields = findLoginFields(state.input)
    if (!fields) return false
    if (
      sameLoginFields(state.fields, fields) &&
      state.metadataKey === lookupMetadataKey(collectSiteMetadata())
    )
      return false
    requestAutofill(state.input)
    return true
  }

  function requestAutofill(input, explicit = false, focusPicker = false) {
    if (disposed || filling || document.activeElement !== input) return
    clearTimeout(retryTimer)
    const fields = findLoginFields(input)
    const metadata = collectSiteMetadata()
    if (!fields) {
      focusedLookupState = {
        input,
        fields,
        url: location.href,
        sequence: lookupSequence,
        metadataKey: lookupMetadataKey(metadata)
      }
      return
    }
    // A native chooser can blur/refocus either login field. Keep its original
    // request rather than queuing another native window on focus restoration.
    if (pendingLookup?.url === location.href && sameLoginFields(pendingLookup.fields, fields)) {
      if (focusPicker) pendingLookup.focusPicker = true
      return
    }
    if (activePicker?.anchor === input) return
    if (
      !explicit &&
      dismissedDesktopContext?.url === location.href &&
      sameLoginFields(dismissedDesktopContext.fields, fields)
    )
      return
    removePicker()
    if (explicit) dismissedDesktopContext = null
    focusedLookupState = {
      input,
      fields,
      url: location.href,
      sequence: lookupSequence,
      metadataKey: lookupMetadataKey(metadata)
    }
    const context = {
      fields,
      anchor: input,
      url: window.location.href,
      sequence: lookupSequence,
      focusPicker,
      requestId: `${lookupDocumentId}:${lookupSequence}`
    }
    pendingLookup = context

    try {
      chrome.runtime.sendMessage(
        {
          type: 'LP_LOOKUP',
          requestId: context.requestId,
          identity: window.location.host,
          ...metadata
        },
        (response) => {
          const error = chrome.runtime.lastError
          if (context.sequence !== lookupSequence) return
          pendingLookup = null
          // A SPA can finish its title/site metadata while this lookup is in flight.
          if (!error && response?.ok && !response.accounts?.length && recoverFocusedLookup()) return
          if ((error || !response?.ok) && validContext(context)) retryLookup(input)
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
      /invalid|incorrect|wrong|failed|failure|error|unauthori[sz]ed|already\s+(?:exists|registered|taken)|does\s*not\s*match|登录失败|登录错误|注册失败|注册错误|注册未成功|密码错误|账号错误|不正确|错误|已(?:被)?(?:注册|存在|占用)|不一致/i

    return selectors.some((selector) =>
      queryAll(selector).some((element) => {
        if (!visible(element)) return false
        return errorPattern.test(element.textContent || '')
      })
    )
  }

  function registrationSuccessMessages() {
    return Array.from(
      document.querySelectorAll(
        '[role="alert"], [role="status"], [aria-live], .success, .alert-success, main, h1, h2, p'
      )
    )
      .filter(
        (element) =>
          visible(element) &&
          /注册成功|注册已完成|账号创建成功|账户创建成功|帐户创建成功|registration\s+(?:was\s+)?(?:successful|complete)|successfully\s+registered|(?:account\s+(?:was\s+)?(?:created|registered)\s+successfully)|(?:account\s+(?:has\s+been\s+)?created)/i.test(
            element.textContent || ''
          )
      )
      .map((element) => (element.textContent || '').trim())
  }

  function registrationSuccessVisible(previous = []) {
    return registrationSuccessMessages().some((message) => !previous.includes(message))
  }

  function successMessages(kind) {
    if (kind === 'registration') return registrationSuccessMessages()
    const pattern =
      kind === 'password-change'
        ? /密码(?:修改|更新|重置|更改)成功|(?:password\s+(?:changed|updated|reset)\s+successfully)|successfully\s+(?:changed|updated|reset)\s+(?:your\s+)?password/i
        : /登录成功|登入成功|successfully\s+(?:logged|signed)\s+in|login\s+successful/i
    return queryAll('[role="status"], [role="alert"], [aria-live], .success, .alert-success')
      .filter((element) => visible(element) && pattern.test(element.textContent || ''))
      .map((element) => element.textContent.trim())
  }

  listen(window, 'localpass-auth-result', (event) => {
    const attempt = loginAttempt
    if (!attempt) return
    try {
      const detail = JSON.parse(event.detail)
      const url = new URL(detail.url)
      const page = new URL(attempt.url)
      if (url.hostname !== page.hostname || url.protocol !== page.protocol) return
      if (
        !/login|signin|sign-in|authenticate|register|signup|password|\/token(?:[/?]|$)/i.test(
          url.pathname
        ) &&
        url.href !== attempt.formAction
      )
        return
      if (detail.result === false) {
        chrome.runtime.sendMessage({ type: 'LP_LOGIN_FAILED', attemptId: attempt.id })
        clearLoginAttempt()
      }
      if (detail.result === true) {
        attempt.networkConfirmed = true
        checkLoginOutcome()
      }
    } catch {
      /* Ignore unrelated page events. */
    }
  })

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
      const inlineIcon =
        url.href.length <= 256 * 1024 &&
        /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url.href)
      if (
        ((['http:', 'https:'].includes(url.protocol) && url.href.length <= 2048) || inlineIcon) &&
        !url.username &&
        !url.password
      )
        iconUrl = url.href
    } catch {
      /* A missing or malformed icon must not prevent saving a login. */
    }
    return {
      site_name: siteName.slice(0, 160),
      page_title: pageTitle.slice(0, 256),
      project_name: (siteName || pageTitle).slice(0, 256),
      site_url: window.location.origin,
      icon_url: iconUrl,
      icon_urls: Array.from(
        document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')
      )
        .map((link) => {
          try {
            const url = new URL(link.getAttribute('href'), document.baseURI)
            return ['http:', 'https:'].includes(url.protocol) &&
              !url.username &&
              !url.password &&
              url.href.length <= 2048
              ? url.href
              : ''
          } catch {
            return ''
          }
        })
        .filter(Boolean)
        .slice(0, 8),
      display_name: (siteName || pageTitle || window.location.host).slice(0, 256)
    }
  }

  function scheduleSiteIcon() {
    if (siteIconTimer || window !== window.top) return
    siteIconTimer = setTimeout(() => {
      siteIconTimer = null
      if (disposed || !['http:', 'https:'].includes(location.protocol)) return
      const metadata = { ...collectSiteMetadata(), page_url: location.href }
      const key = JSON.stringify([
        metadata.site_url,
        metadata.project_name,
        metadata.icon_url,
        metadata.icon_urls
      ])
      if (key === lastSiteMetadata) return
      lastSiteMetadata = key
      try {
        chrome.runtime.sendMessage({ type: 'LP_SITE_VISITED', payload: metadata })?.catch(() => {})
      } catch {
        /* Desktop or extension reconnect will retry automatically. */
      }
    }, 1500)
  }

  async function collectPageIcon() {
    const metadata = collectSiteMetadata()
    for (const url of [...new Set([metadata.icon_url, ...metadata.icon_urls])].filter(Boolean)) {
      const image = new Image()
      try {
        if (!url.startsWith(location.origin + '/') && !url.startsWith('data:'))
          image.crossOrigin = 'anonymous'
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            image.src = ''
            reject(new Error('Icon timeout'))
          }, 3000)
          image.onload = () => {
            clearTimeout(timer)
            resolve()
          }
          image.onerror = () => {
            clearTimeout(timer)
            reject(new Error('Icon unavailable'))
          }
          image.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 32
        canvas.getContext('2d').drawImage(image, 0, 0, 32, 32)
        const icon = canvas.toDataURL('image/png')
        if (icon.length <= 24576) return icon
      } catch {
        /* Cross-origin/invalid images fall through to the next link. */
      } finally {
        image.onload = image.onerror = null
        image.src = ''
      }
    }
    return ''
  }

  function tryCaptureLogin(event) {
    const target = event.composedPath?.()[0] || event.target
    if (target.closest?.('[data-localpass-picker]')) return
    const button =
      event.type === 'click'
        ? target.closest?.('button, input[type="button"], input[type="submit"], [role="button"]')
        : null
    const form = button?.form || target.form || target.closest?.('form') || null
    const action = button
      ? `${button.textContent || ''} ${button.value || ''} ${button.name || ''} ${button.id || ''}`
      : ''
    const changeFields = findPasswordChangeFields(form, action)
    const registrationFields = !changeFields && findRegistrationFields(form, action)
    const loginPassword = queryAll('input').find(
      (input) => loginPasswordInput(input) && editable(input) && input.value && input.form === form
    )
    const fields =
      changeFields || registrationFields || (loginPassword && findLoginFields(loginPassword))
    if (!fields) {
      if (
        (event.type === 'submit' || (button && /next|continue|下一步|继续/i.test(action))) &&
        !queryAll('input').some((input) => passwordField(input) && editable(input))
      ) {
        const usernameInput = queryAll('input').find(
          (input) =>
            editable(input) &&
            input.value &&
            (input.autocomplete === 'username' ||
              input.type === 'email' ||
              /username|account|email|phone|mobile/i.test(`${input.name} ${input.id}`))
        )
        if (usernameInput && usernameInput.form === form)
          chrome.runtime.sendMessage({
            type: 'LP_SPLIT_USERNAME',
            username: usernameInput.value,
            kind: registrationPattern.test(
              `${location.pathname} ${location.hash} ${form?.id || ''} ${action}`
            )
              ? 'registration'
              : 'login'
          })
      }
      return
    }
    const { passwordInput } = fields
    if (!changeFields && passwordChangeContext(passwordInput, action)) return

    if (event.type === 'click') {
      const buttonForm = button?.form || button?.closest('form') || null
      if (!button || buttonForm !== passwordInput.form) return
      const isSubmit = button.type === 'submit'
      const isAuthAction = changeFields
        ? passwordChangePattern.test(action) || /save|update|confirm|保存|确认/i.test(action)
        : registrationFields
          ? registrationPattern.test(action)
          : /log\s*in|sign\s*in|登录|登入/i.test(action)
      if (!isSubmit && !isAuthAction) return
    }
    if (
      event.type === 'keydown' &&
      target !== fields.usernameInput &&
      target !== passwordInput &&
      !(changeFields || registrationFields)?.passwordInputs.includes(target)
    )
      return

    removePicker()
    if (Date.now() - lastCaptureAt < 800) return
    clearLoginAttempt()
    const attempt = {
      id: `${Date.now()}-${++loginAttemptSequence}`,
      url: location.href,
      origin: location.origin,
      passwordInput,
      registration: Boolean(registrationFields),
      kind: changeFields ? 'password-change' : registrationFields ? 'registration' : 'login',
      formAction: passwordInput.form?.action || location.href,
      successMessages: successMessages(
        changeFields ? 'password-change' : registrationFields ? 'registration' : 'login'
      )
    }
    loginAttempt = attempt
    chrome.runtime.sendMessage({
      type: 'LP_LOGIN_SUBMITTED',
      attemptId: attempt.id,
      payload: {
        identity: window.location.host,
        page_url: window.location.href,
        form_action: passwordInput.form?.action || window.location.href,
        ...(changeFields
          ? { capture_kind: 'password-change', previous_password: changeFields.previousPassword }
          : registrationFields
            ? { capture_kind: 'registration' }
            : {}),
        ...collectSiteMetadata(),
        selection_token:
          !registrationFields &&
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

  // Observe the focused field even before a SPA finishes creating its password
  // field. Recovery only runs when that form or its lookup metadata changes;
  // dismissal invalidates its sequence so our own DOM updates cannot reopen it.
  listen(document, 'focusin', (event) => {
    const target = event.composedPath?.()[0] || event.target
    if (activePicker?.element.contains(target)) return
    if (!findLoginFields(target)) removePicker()
    requestAutofill(target)
  })
  listen(document, 'focusout', (event) => {
    const context = activePicker || pendingLookup
    if (!context || context.element?.contains(event.relatedTarget)) return
    // relatedTarget is null when focus moves into the desktop chooser. A real
    // click elsewhere, navigation, typing or hiding the form still cancels it.
    if (pendingLookup && !event.relatedTarget) return
    if (pendingLookup && sameLoginFields(findLoginFields(event.relatedTarget), context.fields))
      return
    if (event.target === context.anchor || context.element?.contains(event.target)) removePicker()
  })
  listen(document, 'input', (event) => {
    if (
      !filling &&
      pendingLookup &&
      sameLoginFields(findLoginFields(event.target), pendingLookup.fields)
    )
      removePicker()
  })
  listen(
    document,
    'pointerdown',
    (event) => {
      const context = activePicker || pendingLookup
      if (context && event.target !== context.anchor && !context.element?.contains(event.target))
        removePicker()
    },
    true
  )
  listen(
    document,
    'click',
    (event) => {
      if (event.target.closest?.('[data-localpass-picker]')) return
      requestAutofill(event.composedPath?.()[0] || event.target, true)
      tryCaptureLogin(event)
    },
    true
  )
  listen(
    document,
    'submit',
    (event) => {
      removePicker()
      tryCaptureLogin(event)
    },
    true
  )
  listen(
    document,
    'keydown',
    (event) => {
      const context = activePicker || pendingLookup
      if (
        event.altKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key.toLowerCase() === 'l' &&
        (context || findLoginFields(document.activeElement))
      ) {
        event.preventDefault()
        event.stopPropagation()
        if (activePicker)
          activePicker.element.querySelector('button')?.focus({ preventScroll: true })
        else if (pendingLookup) pendingLookup.focusPicker = true
        else requestAutofill(document.activeElement, true, true)
      } else if (event.key === 'Escape' && context) {
        event.preventDefault()
        removePicker()
        focusWithoutOpening(context.anchor)
      } else if (
        event.key === 'ArrowDown' &&
        activePicker &&
        event.target === activePicker.anchor
      ) {
        event.preventDefault()
        activePicker.element.querySelector('button')?.focus()
      } else if (event.key === 'Enter') tryCaptureLogin(event)
    },
    true
  )
  listen(window, 'blur', () => {
    // The desktop chooser takes focus. Retain only its pending request; ordinary
    // late replies still stay dismissed, and page/user changes invalidate it.
    if (pendingLookup) pendingLookup.blurred = true
    else removePicker()
  })
  listen(window, 'pagehide', removePicker)
  listen(window, 'popstate', () => {
    removePicker()
    checkLoginOutcome()
  })
  listen(window, 'hashchange', () => {
    removePicker()
    checkLoginOutcome()
  })
  listen(window.navigation, 'navigate', removePicker)
  listen(window, 'scroll', positionPicker, true)
  listen(window, 'resize', positionPicker)
  listen(window, 'focus', schedulePageState)
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') removePicker()
    else schedulePageState()
  })
  const observer = new MutationObserver((mutations) => {
    checkLoginOutcome()
    schedulePageState()
    if (mutations.some((mutation) => mutation.target.closest?.('head'))) scheduleSiteIcon()
    const context = activePicker || pendingLookup
    if (!context) return
    if (mutations.every((mutation) => context.element?.contains(mutation.target))) return
    if (!validContext(context) || (activePicker && !activePicker.element.isConnected))
      removePicker()
    else if (activePicker) positionPicker()
  })
  const observedRoots = new WeakSet()
  function observeShadowRoots(root = document) {
    for (const element of root.querySelectorAll('*')) {
      if (
        !element.shadowRoot ||
        observedRoots.has(element.shadowRoot) ||
        element.closest('[data-localpass-picker]')
      )
        continue
      observedRoots.add(element.shadowRoot)
      const nested = new MutationObserver(() => {
        checkLoginOutcome()
        schedulePageState()
        observeShadowRoots(element.shadowRoot)
      })
      nested.observe(element.shadowRoot, { childList: true, subtree: true, attributes: true })
      shadowObservers.push(nested)
      observeShadowRoots(element.shadowRoot)
    }
  }
  observeShadowRoots()
  shadowTimer = setInterval(observeShadowRoots, 2000)
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
      'autocomplete',
      'href',
      'rel',
      'content'
    ]
  })
  schedulePageState()
  scheduleSiteIcon()

  function onMessage(message, _sender, sendResponse) {
    if (message.type === 'LP_FILL_ACCOUNT') {
      const input = queryAll('input').find(
        (candidate) =>
          loginPasswordInput(candidate) &&
          editable(candidate) &&
          !registrationContext(candidate) &&
          !passwordChangeContext(candidate)
      )
      const fields = input && findLoginFields(input)
      if (!fields) {
        sendResponse({ ok: false })
        return false
      }
      setInputValue(fields.usernameInput, message.account.username)
      setInputValue(fields.passwordInput, message.account.password)
      autofillSelection = {
        url: location.href,
        username: message.account.username,
        token: message.account.selectionToken
      }
      removePicker()
      reportAccountUsed(message.account)
      sendResponse({ ok: true })
      return false
    }
    if (message.type === 'LP_BRIDGE_READY') {
      lastSiteMetadata = ''
      scheduleSiteIcon()
      if (document.hasFocus() && document.visibilityState !== 'hidden')
        requestAutofill(document.activeElement)
      return false
    }
    if (message.type === 'LP_SITE_METADATA') {
      sendResponse({ ...collectSiteMetadata(), page_url: location.href })
      return false
    }
    if (message.type === 'LP_COLLECT_SITE_ICON') {
      void collectPageIcon()
        .then((icon) => sendResponse({ icon }))
        .catch(() => sendResponse({ icon: '' }))
      return true
    }
    if (message.type !== 'LP_INSPECT_PAGE') return false
    sendResponse({
      ready: true,
      version,
      hasRegistrationFields: queryAll('input').some(
        (input) => passwordField(input) && visible(input) && registrationContext(input)
      ),
      hasLoginFields: queryAll('input').some(
        (input) => loginPasswordInput(input) && editable(input)
      )
    })
    return false
  }
  chrome.runtime.onMessage?.addListener(onMessage)
  function dispose() {
    if (disposed) return
    disposed = true
    observer.disconnect()
    shadowObservers.forEach((nested) => nested.disconnect())
    clearInterval(shadowTimer)
    clearTimeout(pageStateTimer)
    clearTimeout(siteIconTimer)
    clearTimeout(retryTimer)
    clearLoginAttempt()
    removePicker()
    handlers.forEach((remove) => remove())
    try {
      chrome.runtime.onMessage?.removeListener?.(onMessage)
    } catch {
      /* Invalidated runtime. */
    }
  }
  listen(document, 'localpass-content-dispose', dispose)
  globalThis.__localpassContent = {
    version,
    alive: () => !disposed && Boolean(chrome.runtime.id),
    dispose
  }
  // Reattaching scripts never reloads a page or changes values already typed.
  if (document.hasFocus() && document.visibilityState !== 'hidden')
    requestAutofill(document.activeElement)
})()
