/* global chrome */

const pendingCaptures = {}
const pendingLookups = new Map()
const captureStatusOwners = new Map()
const CAPTURE_CONFIRM_DELAY_MS = 1800
const MAX_INLINE_ICON_URL_LENGTH = 256 * 1024

let desktopInstance = null
let desktopUnlocked = false

async function repairPage(tabId) {
  if (!chrome.scripting?.executeScript) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js']
    })
  } catch {
    /* Browser settings, closed tabs and restricted pages are skipped. */
  }
}
async function repairOpenPages() {
  if (!chrome.tabs.query || !chrome.scripting?.executeScript) return
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  await Promise.allSettled(tabs.map((tab) => repairPage(tab.id)))
}
if (chrome.scripting) {
  void repairOpenPages().catch(() => {})
  chrome.tabs.onActivated?.addListener(({ tabId }) => void repairPage(tabId))
  chrome.runtime.onInstalled?.addListener(() => void repairOpenPages().catch(() => {}))
}

async function checkExtensionUpdate() {
  // Never interrupt a login capture or an account choice to reload the worker.
  if (Object.keys(pendingCaptures).length || pendingLookups.size) return
  try {
    const current = chrome.runtime.getManifest().version
    const response = await fetch(
      `http://127.0.0.1:35320/extension-status?version=${encodeURIComponent(current)}`,
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000)
      }
    )
    if (!response.ok) return
    const result = await response.json()
    // A service worker can wake from idle without any desktop restart. Its first
    // status check must not reopen an account list the user already dismissed.
    const recovered =
      desktopInstance !== null &&
      result.unlocked &&
      (!desktopUnlocked || desktopInstance !== result.instanceId)
    desktopUnlocked = Boolean(result.unlocked)
    desktopInstance = result.instanceId
    if (recovered) {
      await repairOpenPages()
      const tabs = (await chrome.tabs.query?.({ active: true })) || []
      await Promise.allSettled(
        tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'LP_BRIDGE_READY' }))
      )
    }
    if (!result.ok || result.updating || !/^\d+(\.\d+){2,3}$/.test(result.version || '')) return
    const wanted = result.version.split('.').map(Number),
      installed = current.split('.').map(Number)
    const firstDifference = wanted.findIndex((value, index) => value !== (installed[index] || 0))
    if (firstDifference < 0 || wanted[firstDifference] <= (installed[firstDifference] || 0)) return
    // A user may still load a separately extracted folder. Try once per version,
    // then show the binding instructions instead of entering a reload loop.
    const key = 'extension-reload-attempt'
    if ((await chrome.storage.local.get(key))[key] === result.version) return
    if (Object.keys(pendingCaptures).length || pendingLookups.size) return
    await chrome.storage.local.set({ [key]: result.version })
    chrome.runtime.reload()
  } catch {
    desktopUnlocked = false
    /* Offline desktops and older bridges leave the working extension intact. */
  }
}

if (chrome.alarms) {
  chrome.alarms.create('localpass-extension-update', { periodInMinutes: 1 })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'localpass-extension-update') void checkExtensionUpdate()
  })
  void checkExtensionUpdate()
}

function captureStatus(tabId, capture, state) {
  if (captureStatusOwners.get(tabId) !== capture.statusId) return
  // Diagnostics contain no usernames, passwords, tokens, paths or query strings.
  const status = { state, origin: new URL(capture.payload.page_url).origin, at: Date.now() }
  void chrome.storage?.session?.set({ [`capture-status:${tabId}`]: status }).catch(() => {})
}

function clearPendingCapture(tabId, capture) {
  if (pendingCaptures[tabId] === capture) {
    delete pendingCaptures[tabId]
  }
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

function sameRequestUrl(left, right) {
  try {
    const a = new URL(left)
    const b = new URL(right)
    a.hash = ''
    b.hash = ''
    return a.href === b.href
  } catch {
    return false
  }
}

async function loadSiteIcon(value) {
  let bitmap
  try {
    const url = new URL(value)
    const nativeIcon =
      url.protocol === 'chrome-extension:' &&
      url.host === chrome.runtime.id &&
      url.pathname === '/_favicon/'
    const inlineIcon =
      url.href.length <= MAX_INLINE_ICON_URL_LENGTH &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url.href)
    if (
      (!['http:', 'https:'].includes(url.protocol) && !nativeIcon && !inlineIcon) ||
      url.username ||
      url.password
    )
      return ''
    const response = await fetch(url.href, {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(2000)
    })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return ''
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > (inlineIcon ? 192 : 128) * 1024) {
        await reader.cancel()
        return ''
      }
      chunks.push(value)
    }
    const blob = new Blob(chunks, { type: response.headers.get('content-type') })
    bitmap = await createImageBitmap(blob, { resizeWidth: 32, resizeHeight: 32 })
    const canvas = new OffscreenCanvas(32, 32)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, 32, 32)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    if (png.size > 16 * 1024) return ''
    return `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(await png.arrayBuffer())))}`
  } catch {
    return ''
  } finally {
    bitmap?.close()
  }
}

async function enrichSite(tabId, payload) {
  const pageUrl = new URL(payload.page_url)
  const metadata = { ...payload, identity: pageUrl.host, site_url: pageUrl.origin }
  let tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    /* Tab may have closed after login. */
  }
  if (tab && sameOrigin(tab.url, payload.page_url)) {
    metadata.page_title = (tab.title || payload.page_title || '').trim().slice(0, 256)
  }
  metadata.display_name =
    metadata.site_name || metadata.page_title || payload.display_name || pageUrl.host
  let browserIcon = ''
  try {
    const icon = new URL(chrome.runtime.getURL('/_favicon/'))
    icon.searchParams.set('pageUrl', pageUrl.href)
    icon.searchParams.set('size', '32')
    browserIcon = icon.href
  } catch {
    /* Fallback for browsers without the favicon endpoint. */
  }
  const candidates = [
    ...new Set(
      [
        payload.icon_url?.startsWith('data:') ? payload.icon_url : '',
        browserIcon,
        payload.icon_url,
        tab && sameOrigin(tab.url, payload.page_url) ? tab.favIconUrl : '',
        `${pageUrl.origin}/favicon.ico`
      ].filter(Boolean)
    )
  ]
  metadata.icon_data = ''
  for (const url of candidates) {
    metadata.icon_data = await loadSiteIcon(url)
    if (metadata.icon_data) break
  }
  delete metadata.icon_url
  return metadata
}

async function sendCapture(tabId, capture) {
  if (pendingCaptures[tabId] !== capture || capture.cancelled || capture.sent || capture.sending)
    return
  capture.sending = true
  captureStatus(tabId, capture, 'saving')
  try {
    const payload = await enrichSite(tabId, capture.payload)
    // Login failure or a later attempt may arrive while the icon is loading.
    if (pendingCaptures[tabId] !== capture || capture.cancelled) return
    capture.sent = true
    clearPendingCapture(tabId, capture)

    const response = await fetch('http://127.0.0.1:35320/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const result = await response.json()
    const state =
      response.status === 423
        ? 'locked'
        : !response.ok || !result.ok
          ? 'save-failed'
          : result.cancelled
            ? 'cancelled'
            : result.changed === false
              ? 'unchanged'
              : 'saved'
    captureStatus(tabId, capture, state)
    if (!response.ok || !result.ok) console.error('LocalPass save failed:', response.status)
  } catch (error) {
    clearPendingCapture(tabId, capture)
    captureStatus(tabId, capture, 'disconnected')
    console.error('LocalPass capture error (is the desktop app running?):', error)
  }
}

async function lookupAccounts(identity, metadata = {}, signal) {
  const url = new URL('http://127.0.0.1:35320/lookup')
  url.searchParams.set('identity', identity)
  for (const key of ['site_name', 'page_title', 'project_name']) {
    if (metadata[key]) url.searchParams.set(key, String(metadata[key]).slice(0, 256))
  }

  const response = await fetch(url, { signal })
  const data = await response.json()
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'LocalPass lookup failed')
  }
  return { accounts: data.accounts || [], selected: Boolean(data.selected) }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const lookupKey = JSON.stringify([
    sender.tab?.id,
    sender.frameId,
    sender.documentId || sender.url,
    message.requestId
  ])
  if (message.type === 'LP_LOOKUP_CANCEL') {
    pendingLookups.get(lookupKey)?.abort()
    sendResponse({ ok: true })
    return false
  }
  if (message.type === 'LP_LOOKUP') {
    // The sender URL preserves the port even for older content scripts.
    let identity = message.identity
    try {
      if (sender.url) identity = new URL(sender.url).host
    } catch {
      /* Use the supplied identity. */
    }
    const controller = new AbortController()
    if (message.requestId) pendingLookups.set(lookupKey, controller)
    lookupAccounts(identity, message, controller.signal)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message, accounts: [] }))
      .finally(() => {
        if (pendingLookups.get(lookupKey) === controller) pendingLookups.delete(lookupKey)
      })
    return true
  }

  if (message.type === 'LP_LOGIN_SUBMITTED' && sender.tab) {
    const capture = {
      payload: message.payload,
      attemptId: message.attemptId,
      frameId: sender.frameId ?? 0,
      documentId: sender.documentId,
      cancelled: false,
      sent: false,
      submittedAt: Date.now(),
      requestSeen: false,
      statusId: Symbol()
    }
    pendingCaptures[sender.tab.id] = capture
    captureStatusOwners.set(sender.tab.id, capture.statusId)
    captureStatus(sender.tab.id, capture, 'submitted')

    // Clear the pending capture after 15 seconds to prevent stale credentials.
    setTimeout(() => {
      if (pendingCaptures[sender.tab.id] === capture)
        captureStatus(sender.tab.id, capture, 'expired')
      clearPendingCapture(sender.tab.id, capture)
    }, 15000)
  }

  if (message.type === 'LP_LOGIN_SUCCEEDED' && sender.tab) {
    const capture = pendingCaptures[sender.tab.id]
    if (
      capture &&
      message.attemptId &&
      message.attemptId === capture.attemptId &&
      (sender.frameId ?? 0) === capture.frameId &&
      (!capture.documentId || sender.documentId === capture.documentId) &&
      sameOrigin(sender.url, capture.payload.page_url)
    ) {
      // A SPA can authenticate against another API port. Confirm using the
      // originating login page's transition, without accepting unrelated POSTs.
      setTimeout(() => sendCapture(sender.tab.id, capture), CAPTURE_CONFIRM_DELAY_MS)
    }
  }

  if (message.type === 'LP_PAGE_STATE' && sender.tab) {
    const capture = pendingCaptures[sender.tab.id]
    if (
      capture?.navigationPending &&
      typeof message.hasLoginFields === 'boolean' &&
      typeof message.hasLoginError === 'boolean' &&
      (sender.frameId ?? 0) === capture.frameId &&
      (!capture.documentId || (sender.documentId && sender.documentId !== capture.documentId)) &&
      sameOrigin(sender.url, capture.payload.page_url)
    ) {
      if (message.hasLoginFields || message.hasLoginError) {
        captureStatus(sender.tab.id, capture, 'login-failed')
        capture.cancelled = true
        clearPendingCapture(sender.tab.id, capture)
      } else if (!capture.navigationConfirmed) {
        capture.navigationConfirmed = true
        setTimeout(() => sendCapture(sender.tab.id, capture), CAPTURE_CONFIRM_DELAY_MS)
      }
    }
  }

  if (message.type === 'LP_LOGIN_FAILED' && sender.tab) {
    const capture = pendingCaptures[sender.tab.id]
    if (
      capture &&
      (sender.frameId ?? 0) === capture.frameId &&
      (!message.attemptId || message.attemptId === capture.attemptId)
    ) {
      captureStatus(sender.tab.id, capture, 'login-failed')
      capture.cancelled = true
      clearPendingCapture(sender.tab.id, capture)
    }
  }

  return false
})

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    const capture = pendingCaptures[details.tabId]
    if (
      !capture ||
      capture.cancelled ||
      capture.sent ||
      details.method !== 'POST' ||
      !['main_frame', 'sub_frame'].includes(details.type) ||
      (details.frameId ?? 0) !== capture.frameId ||
      details.statusCode < 300 ||
      details.statusCode >= 400 ||
      !sameRequestUrl(details.url, capture.payload.form_action) ||
      !sameOrigin(details.url, capture.payload.page_url) ||
      !sameOrigin(details.redirectUrl, capture.payload.page_url)
    )
      return
    // Redirected POSTs do not generate the POST onCompleted event we used to
    // rely on. Wait for the destination document to inspect its login state.
    capture.navigationPending = true
  },
  { urls: ['<all_urls>'] }
)

chrome.webRequest.onCompleted.addListener(
  (details) => {
    // Only consider a POST from the same site and reject HTTP failures. The
    // content script separately cancels HTTP-200 responses that render a
    // visible login error.
    if (details.method !== 'POST') return

    const tabId = details.tabId
    const capture = pendingCaptures[tabId]
    if (!capture || capture.cancelled || capture.sent) return
    if ((details.frameId ?? 0) !== capture.frameId) return
    if (Date.now() - capture.submittedAt > 10000) return
    if (!sameOrigin(details.url, capture.payload.page_url)) return
    if (details.statusCode >= 400) {
      captureStatus(tabId, capture, 'request-failed')
      capture.cancelled = true
      clearPendingCapture(tabId, capture)
      return
    }

    if (
      ['main_frame', 'sub_frame'].includes(details.type) &&
      (details.frameId ?? 0) === capture.frameId &&
      sameRequestUrl(details.url, capture.payload.form_action)
    ) {
      capture.navigationPending = true
      return
    }

    capture.requestSeen = true
    setTimeout(() => sendCapture(tabId, capture), CAPTURE_CONFIRM_DELAY_MS)
  },
  { urls: ['<all_urls>'] }
)
