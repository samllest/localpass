/* global chrome, importScripts */

try {
  importScripts('bridge-config.js')
} catch {
  /* An unconfigured installation cannot access the vault. */
}

async function bridgeFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${globalThis.LP_BRIDGE_TOKEN || ''}` },
    redirect: 'error',
    cache: 'no-store'
  })
}

const pendingCaptures = {}
const pendingLookups = new Map()
const captureStatusOwners = new Map()
const CAPTURE_CONFIRM_DELAY_MS = 1800
const MAX_INLINE_ICON_URL_LENGTH = 256 * 1024
// Same known Chromium placeholder as src/shared/site-metadata.js. A successful
// favicon response can still contain this image; never persist it as site data.
const DEFAULT_BROWSER_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABRElEQVR4AeyX4REBMRCFUQEdKIEO6EAJdKADOjAqMDqgAjqgAzqgA967Sdzlstxm5P6t2U1Osnn5rLncXq8jf4YYPsEf8JfSd4jjOnR6kwAocoHEBN6Ha22OQEJzPS51JgFssJQb79EP4N0Gx3Rhd7TcPAlCAphBiLZG84RrbYrAZAgJADqFUay4UDaMT4b4BaDcNwhLhsgNQJokiDYAkiDaAlBD5ADwdwpvQW5c9frfwcOqOt/JAbB1ijf00qnJcQ83QkxgOQB4XhDCZyLYoPaFB1wwlAOAgks0TacmQmLLBRArK0cMwDJgGbAMWAYsA5YBKQO+sIiKB+UTVgrzFVE0JwFcXRRf0b4udDGajj9k5QKPrv90EsACs8wCXzZZz0l1XsoY37CpRU1WTpAvTQJgJTtGyAH+t0GAG5/RU5PauCztDQAA///3JTG8AAAABklEQVQDAGm4Uc19dK5XAAAAAElFTkSuQmCC'
const iconAttempts = new Map()
let iconScanRunning = false
let iconDocumentPromise = null

function bytesBase64(bytes) {
  let text = ''
  for (let start = 0; start < bytes.length; start += 8192)
    text += String.fromCharCode(...bytes.subarray(start, start + 8192))
  return btoa(text)
}

let desktopInstance = null
let desktopUnlocked = false

async function repairPage(tabId) {
  if (!chrome.scripting?.executeScript) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js']
    })
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['network-observer.js'],
      world: 'MAIN'
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
    const response = await bridgeFetch(
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
    if (desktopUnlocked) void refreshMissingIcons().catch(() => {})
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

async function rasterizeIcon(blob) {
  let bitmap
  try {
    bitmap = await createImageBitmap(blob, { resizeWidth: 32, resizeHeight: 32 })
    const canvas = new OffscreenCanvas(32, 32)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, 32, 32)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    if (png.size > 16 * 1024) return ''
    return `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(await png.arrayBuffer())))}`
  } catch {
    const data = `data:${blob.type};base64,${bytesBase64(new Uint8Array(await blob.arrayBuffer()))}`
    // Integration fixtures also exercise the actual image decoder in Chromium.
    if (typeof document !== 'undefined') {
      const image = new Image()
      try {
        image.src = data
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 32
        canvas.getContext('2d').drawImage(image, 0, 0, 32, 32)
        const icon = canvas.toDataURL('image/png')
        return icon.length <= 24576 ? icon : ''
      } catch {
        return ''
      }
    }
    if (!chrome.offscreen) return ''
    try {
      if (!iconDocumentPromise)
        iconDocumentPromise = (async () => {
          if (!(await chrome.offscreen.hasDocument()))
            await chrome.offscreen.createDocument({
              url: 'icon-offscreen.html',
              reasons: ['BLOBS'],
              justification: 'Convert website SVG and ICO icons to local PNG images.'
            })
        })().finally(() => {
          iconDocumentPromise = null
        })
      await iconDocumentPromise
      return (await chrome.runtime.sendMessage({ type: 'LP_RASTERIZE_ICON', data }))?.icon || ''
    } catch {
      return ''
    }
  } finally {
    bitmap?.close()
  }
}

async function readBoundedResponse(response, maxBytes) {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return new Blob(chunks)
}

async function loadSiteIcon(value, pageUrl = '', timeout = 4000) {
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
      credentials: sameOrigin(url.href, pageUrl) ? 'include' : 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout)
    })
    if (!response.ok) return ''
    const raw = await readBoundedResponse(response, inlineIcon ? 192 * 1024 : 512 * 1024)
    if (!raw) return ''
    const prefix = new Uint8Array(await raw.slice(0, 512).arrayBuffer())
    const text = new TextDecoder().decode(prefix).trim()
    // Some servers label icons as application/octet-stream. Sniff only known
    // image signatures; an SPA's HTML fallback must never be treated as an icon.
    let type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase()
    if (/^<!doctype\s+html|^<html/i.test(text)) return ''
    if (prefix[0] === 137 && prefix[1] === 80) type = 'image/png'
    else if (prefix[0] === 0 && prefix[1] === 0 && prefix[2] === 1 && prefix[3] === 0)
      type = 'image/x-icon'
    else if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) type = 'image/svg+xml'
    if (!type.startsWith('image/')) return ''
    if (
      `data:${type};base64,${bytesBase64(new Uint8Array(await raw.arrayBuffer()))}` ===
      DEFAULT_BROWSER_ICON
    )
      return ''
    const icon = await rasterizeIcon(new Blob([raw], { type }))
    return icon === DEFAULT_BROWSER_ICON ? '' : icon
  } catch {
    return ''
  }
}

function iconUrls(html, baseUrl) {
  const urls = []
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attrs = {}
    for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4]).replace(/&amp;/g, '&')
    if (!/(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(attrs.rel || '')) continue
    try {
      const url = new URL(attrs.href, baseUrl)
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
        urls.push(url.href)
    } catch {
      /* Malformed links are ignored. */
    }
  }
  return [...new Set(urls)].slice(0, 8)
}

async function discoverIconUrls(pageUrl) {
  try {
    const response = await fetch(pageUrl, {
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(4000)
    })
    if (!response.ok || !sameOrigin(response.url || pageUrl, pageUrl)) return []
    const body = await readBoundedResponse(response, 512 * 1024)
    return body ? iconUrls(await body.text(), response.url || pageUrl) : []
  } catch {
    return []
  }
}

async function enrichSite(tabId, payload, { quick = false } = {}) {
  const pageUrl = new URL(payload.page_url)
  const metadata = { ...payload, identity: pageUrl.host, site_url: pageUrl.origin }
  let tab
  try {
    if (Number.isInteger(tabId)) tab = await chrome.tabs.get(tabId)
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
        ...(payload.icon_urls || []).slice(0, 8),
        payload.icon_url,
        tab && sameOrigin(tab.url, payload.page_url) ? tab.favIconUrl : '',
        browserIcon
      ].filter(Boolean)
    )
  ]
  metadata.icon_data = ''
  for (const url of quick ? candidates.slice(0, 3) : candidates) {
    metadata.icon_data = await loadSiteIcon(url, pageUrl.href, quick ? 1000 : 4000)
    if (metadata.icon_data) break
  }
  if (
    !quick &&
    !metadata.icon_data &&
    tab &&
    sameOrigin(tab.url, payload.page_url) &&
    chrome.tabs.sendMessage
  ) {
    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        { type: 'LP_COLLECT_SITE_ICON' },
        { frameId: 0 }
      )
      if (
        /^data:image\/png;base64,iVBORw0KGgo/.test(result?.icon || '') &&
        result.icon !== DEFAULT_BROWSER_ICON &&
        result.icon.length <= 24576
      )
        metadata.icon_data = result.icon
    } catch {
      /* Closed or restricted pages use the remaining sources. */
    }
  }
  if (!quick && !metadata.icon_data) {
    const discovered = await discoverIconUrls(pageUrl.origin)
    for (const url of [
      ...discovered,
      `${pageUrl.origin}/favicon.png`,
      `${pageUrl.origin}/favicon.ico`
    ]) {
      if (candidates.includes(url)) continue
      metadata.icon_data = await loadSiteIcon(url, pageUrl.href)
      if (metadata.icon_data) break
    }
  }
  delete metadata.icon_url
  delete metadata.icon_urls
  return metadata
}

async function refreshMissingIcons(visited, tabId) {
  if (iconScanRunning) return
  iconScanRunning = true
  try {
    const response = await bridgeFetch('http://127.0.0.1:35320/site-icons', {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store'
    })
    if (!response.ok) return
    const { ok, revision, sites } = await response.json()
    if (!ok || !revision || !Array.isArray(sites)) return
    const tabs = (await chrome.tabs.query?.({ url: ['http://*/*', 'https://*/*'] })) || []
    let processed = 0
    for (const site of sites) {
      const key = `${revision}:${site.id}`
      const attemptKey = `site-icon-attempt:${key}`
      const previous =
        iconAttempts.get(key) || (await chrome.storage.session?.get?.(attemptKey))?.[attemptKey]
      const matchingVisit =
        visited &&
        new URL(visited.page_url).host === site.identity &&
        (!site.project_name ||
          site.project_name.toLowerCase() === (visited.project_name || '').toLowerCase())
      if (visited && !matchingVisit) continue
      if (previous?.next > Date.now() && (!matchingVisit || Date.now() - previous.at < 60000))
        continue
      if (++processed > 3) break
      let tab = tabs.find((entry) => sameOrigin(entry.url, site.site_url))
      let metadata = matchingVisit ? visited : { page_url: site.site_url }
      // Read the live page's links before falling back to a root-page request.
      if (!matchingVisit && tab && chrome.tabs.sendMessage) {
        try {
          const live = await chrome.tabs.sendMessage(
            tab.id,
            { type: 'LP_SITE_METADATA' },
            { frameId: 0 }
          )
          if (live && sameOrigin(live.page_url, site.site_url)) {
            if (
              !site.project_name ||
              site.project_name.toLowerCase() === (live.project_name || '').toLowerCase()
            )
              metadata = live
            else tab = null
          }
        } catch {
          /* Use browser cache and server discovery. */
        }
      }
      const result = await enrichSite(matchingVisit ? tabId : tab?.id, metadata)
      if (result.icon_data) {
        const saved = await bridgeFetch('http://127.0.0.1:35320/site-icons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...site, revision, icon_data: result.icon_data }),
          signal: AbortSignal.timeout(3000)
        })
        if (!saved.ok) break
      }
      const failures = result.icon_data ? 0 : (previous?.failures || 0) + 1
      const delay = [60000, 300000, 900000, 3600000][Math.min(failures, 3)]
      const attempt = { failures, at: Date.now(), next: Date.now() + delay }
      iconAttempts.set(key, attempt)
      await chrome.storage.session?.set?.({ [attemptKey]: attempt }).catch(() => {})
      if (iconAttempts.size > 1000) iconAttempts.delete(iconAttempts.keys().next().value)
    }
  } finally {
    iconScanRunning = false
  }
}

async function sendCapture(tabId, capture) {
  if (pendingCaptures[tabId] !== capture || capture.cancelled || capture.sent || capture.sending)
    return
  capture.sending = true
  captureStatus(tabId, capture, 'saving')
  try {
    await capture.usernameReady
    await capture.sessionReady
    if (capture.sessionRejected) {
      captureStatus(tabId, capture, 'locked')
      clearPendingCapture(tabId, capture)
      return
    }
    const payload = await enrichSite(tabId, capture.payload, { quick: true })
    // Login failure or a later attempt may arrive while the icon is loading.
    if (pendingCaptures[tabId] !== capture || capture.cancelled) return
    capture.sent = true
    clearPendingCapture(tabId, capture)

    const response = await bridgeFetch('http://127.0.0.1:35320/capture', {
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

  const response = await bridgeFetch(url, { signal })
  const data = await response.json()
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'LocalPass lookup failed')
  }
  return { accounts: data.accounts || [], selected: Boolean(data.selected) }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LP_RASTERIZE_ICON') return false
  if (message.type === 'LP_ACCOUNT_USED' && sender.tab && message.selectionToken) {
    try {
      const url = new URL(sender.url)
      if (!['http:', 'https:'].includes(url.protocol)) return false
      void bridgeFetch('http://127.0.0.1:35320/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: url.host, selection_token: message.selectionToken }),
        signal: AbortSignal.timeout(3000)
      }).catch(() => {})
    } catch {
      /* Closed or restricted pages cannot extend the session. */
    }
    return false
  }
  if (message.type === 'LP_SPLIT_USERNAME' && sender.tab) {
    const url = new URL(sender.url)
    const key = `split-login:${sender.tab.id}:${sender.frameId || 0}`
    void (async () => {
      const response = await bridgeFetch('http://127.0.0.1:35320/extension-status', {
        signal: AbortSignal.timeout(3000)
      })
      const status = await response.json()
      if (!response.ok || !status.unlocked || !status.revision) return
      await chrome.storage.session.set({
        [key]: {
          username: String(message.username || '').slice(0, 512),
          kind: message.kind || 'login',
          origin: url.origin,
          revision: status.revision,
          at: Date.now()
        }
      })
    })().catch(() => {})
    return false
  }
  if (message.type === 'LP_SITE_VISITED' && sender.tab && (sender.frameId ?? 0) === 0) {
    const pageUrl = sender.url || message.payload?.page_url
    try {
      if (!['http:', 'https:'].includes(new URL(pageUrl).protocol)) return false
      void refreshMissingIcons({ ...message.payload, page_url: pageUrl }, sender.tab.id).catch(
        () => {}
      )
    } catch {
      /* Ignore invalid sender URLs. */
    }
    return false
  }
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
    let senderUrl
    try {
      senderUrl = new URL(sender.url)
      if (!['http:', 'https:'].includes(senderUrl.protocol)) return false
    } catch {
      return false
    }
    const capture = {
      payload: { ...message.payload, page_url: sender.url, identity: senderUrl.host },
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
    capture.sessionReady = (async () => {
      const response = await bridgeFetch('http://127.0.0.1:35320/extension-status', {
        signal: AbortSignal.timeout(3000)
      })
      const status = await response.json()
      if (!response.ok || status.unlocked === false) capture.sessionRejected = true
      capture.payload.vault_revision = status.revision
    })().catch(() => {
      capture.sessionRejected = true
    })
    if (!capture.payload.username) {
      const key = `split-login:${sender.tab.id}:${sender.frameId || 0}`
      capture.usernameReady = (async () => {
        await capture.sessionReady
        const split = (await chrome.storage.session.get?.(key))?.[key]
        if (
          split &&
          split.origin === senderUrl.origin &&
          split.revision === capture.payload.vault_revision &&
          split.kind ===
            (capture.payload.capture_kind === 'registration' ? 'registration' : 'login') &&
          Date.now() - split.at < 120000
        )
          capture.payload.username = split.username
        if (capture.payload.capture_kind === 'registration' && !capture.payload.username)
          capture.sessionRejected = true
        await chrome.storage.session.remove?.(key)
      })()
    }
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
      const registration = capture.payload.capture_kind === 'registration'
      const passwordChange = capture.payload.capture_kind === 'password-change'
      const registrationReturned =
        registration &&
        (message.registrationSucceeded ||
          (message.hasRegistrationFields === false &&
            !sameRequestUrl(sender.url, capture.payload.page_url)))
      if (
        message.hasLoginError ||
        (registration ? !registrationReturned : passwordChange ? !message.passwordChangeSucceeded : message.hasLoginFields)
      ) {
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
    // A successful HTTP response can still contain a registration validation
    // error. Require a success message or a completed page transition.
    // HTTP 200 alone never proves that the supplied credentials were accepted.
  },
  { urls: ['<all_urls>'] }
)
