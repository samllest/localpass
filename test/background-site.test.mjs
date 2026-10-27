import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { DEFAULT_BROWSER_ICON } from '../src/shared/site-metadata.js'

const source = readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
)

test('worker recovery reattaches every open web tab and tolerates restricted frames', async () => {
  const { context } = background()
  const injected = []
  context.chrome.tabs.query = async (query) => {
    assert.deepEqual(Array.from(query.url), ['http://*/*', 'https://*/*'])
    return [{ id: 11 }, { id: 12 }]
  }
  context.chrome.scripting = {
    executeScript: async (options) => {
      injected.push(options)
      if (options.target.tabId === 12) throw new Error('Restricted frame')
    }
  }
  await vm.runInContext('repairOpenPages()', context)
  assert.deepEqual(
    injected.filter((entry) => !entry.world).map((entry) => entry.target.tabId),
    [11, 12]
  )
  for (const entry of injected) {
    assert.equal(entry.target.allFrames, true)
    assert.deepEqual(Array.from(entry.files), [entry.world ? 'network-observer.js' : 'content.js'])
  }
})

test('desktop restart and unlocking notify focused pages without reloading websites', async () => {
  const { context } = background()
  const notified = []
  let instanceId = 'first',
    unlocked = false
  context.chrome.runtime.getManifest = () => ({ version: '1.3.7' })
  context.chrome.tabs.query = async () => [{ id: 11 }]
  context.chrome.tabs.sendMessage = async (id, message) => notified.push([id, message.type])
  context.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        version: '1.3.7',
        instanceId,
        unlocked
      })
    )
  await vm.runInContext('checkExtensionUpdate()', context)
  assert.equal(notified.length, 0)
  unlocked = true
  await vm.runInContext('checkExtensionUpdate()', context)
  await vm.runInContext('checkExtensionUpdate()', context)
  assert.equal(notified.length, 1)
  instanceId = 'replacement'
  await vm.runInContext('checkExtensionUpdate()', context)
  assert.deepEqual(notified, [
    [11, 'LP_BRIDGE_READY'],
    [11, 'LP_BRIDGE_READY']
  ])
})

test('extension reloads once for a newer prepared version and never during an active login', async () => {
  const { context } = background()
  let reloads = 0
  let checks = 0
  let version = '1.3.8'
  let updating = false
  const storage = {}
  context.chrome.runtime.getManifest = () => ({ version: '1.3.7' })
  context.chrome.runtime.reload = () => {
    reloads++
  }
  context.chrome.storage.local = {
    get: async (key) => ({ [key]: storage[key] }),
    set: async (values) => Object.assign(storage, values)
  }
  context.fetch = async () => {
    checks++
    return new Response(JSON.stringify({ ok: true, version, updating }))
  }
  vm.runInContext('pendingLookups.set("login", {})', context)
  await vm.runInContext('checkExtensionUpdate()', context)
  assert.equal(checks, 0)
  vm.runInContext('pendingLookups.clear()', context)
  updating = true
  await vm.runInContext('checkExtensionUpdate()', context)
  assert.equal(reloads, 0)
  updating = false
  version = '1.3.5'
  await vm.runInContext('checkExtensionUpdate()', context)
  assert.equal(reloads, 0)
  version = '1.3.8'
  await vm.runInContext('checkExtensionUpdate()', context)
  assert.equal(reloads, 1)
  await vm.runInContext('checkExtensionUpdate()', context)
  assert.equal(reloads, 1, 'separately extracted folders must not enter a reload loop')
  context.chrome.runtime.getManifest = () => ({ version: '1.3.8' })
  await vm.runInContext('checkExtensionUpdate()', context)
  assert.equal(reloads, 1)
})

function background(options = {}) {
  const messages = []
  const timers = []
  const statuses = {}
  let onMessage, onCompleted, onRedirect
  const context = vm.createContext({
    URL,
    Blob,
    Uint8Array,
    TextDecoder,
    AbortSignal,
    AbortController,
    btoa,
    console,
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay })
    },
    chrome: {
      storage: {
        session: {
          set: async (values) => Object.assign(statuses, values)
        }
      },
      runtime: {
        id: 'fixture',
        getURL: (value) => `chrome-extension://fixture${value}`,
        onMessage: {
          addListener: (fn) => {
            onMessage = fn
          }
        }
      },
      tabs: {
        get: async () => ({
          url: 'http://10.0.15.33:3000/dashboard',
          title: 'Agent Router · 控制台',
          favIconUrl: 'http://10.0.15.33:3000/logo.png'
        })
      },
      webRequest: {
        onBeforeRedirect: {
          addListener: (fn) => {
            onRedirect = fn
          }
        },
        onCompleted: {
          addListener: (fn) => {
            onCompleted = fn
          }
        }
      }
    },
    createImageBitmap: async () => ({ close() {} }),
    OffscreenCanvas: class {
      getContext() {
        return { drawImage() {} }
      }
      async convertToBlob() {
        return new Blob([options.rasterizedPng || png], { type: 'image/png' })
      }
    },
    fetch: async (url, config) => {
      const address = String(url)
      messages.push({ url: address, config })
      if (address.includes('127.0.0.1:35320') && options.lookupFetch && address.includes('/lookup'))
        return options.lookupFetch(address, config)
      if (address.includes('127.0.0.1:35320/site-icons') && options.siteIconsFetch)
        return options.siteIconsFetch(address, config)
      if (address.endsWith('/capture') && options.captureFetch)
        return options.captureFetch(address, config)
      if (address.includes('127.0.0.1:35320'))
        return new Response(JSON.stringify({ ok: true, accounts: [] }))
      if (options.iconFetch) return options.iconFetch(address)
      return new Response(png, { headers: { 'content-type': 'image/png' } })
    }
  })
  vm.runInContext(source, context)
  const payload = {
    identity: '10.0.15.33',
    page_url: 'http://10.0.15.33:3000/login',
    site_name: 'Agent Router',
    page_title: '登录',
    username: 'demo',
    password: 'synthetic-only',
    form_action: 'http://10.0.15.33:3000/j_spring_security_check'
  }
  return {
    context,
    messages,
    timers,
    status: () => statuses['capture-status:7'],
    message: (message, sender = {}) => onMessage(message, { tab: { id: 7 }, frameId: 0, url: payload.page_url, ...sender }, () => {}),
    submit: (attemptId, overrides = {}) =>
      onMessage(
        { type: 'LP_LOGIN_SUBMITTED', payload: { ...payload, ...overrides }, attemptId },
        { tab: { id: 7 }, frameId: 0, documentId: 'login-page', url: payload.page_url },
        () => {}
      ),
    confirm: (attemptId, overrides = {}) =>
      onMessage(
        { type: 'LP_LOGIN_SUCCEEDED', attemptId },
        {
          tab: { id: 7 },
          frameId: 0,
          documentId: 'login-page',
          url: 'http://10.0.15.33:3000/#/home',
          ...overrides
        },
        () => {}
      ),
    fail: () => onMessage({ type: 'LP_LOGIN_FAILED' }, { tab: { id: 7 } }, () => {}),
    redirect: (overrides = {}) =>
      onRedirect({
        tabId: 7,
        frameId: 0,
        type: 'main_frame',
        method: 'POST',
        statusCode: 302,
        url: payload.form_action,
        redirectUrl: 'http://10.0.15.33:3000/',
        ...overrides
      }),
    pageState: (state = {}, sender = {}) =>
      onMessage(
        { type: 'LP_PAGE_STATE', hasLoginFields: false, hasLoginError: false, ...state },
        {
          tab: { id: 7 },
          frameId: 0,
          documentId: 'destination-page',
          url: 'http://10.0.15.33:3000/',
          ...sender
        },
        () => {}
      ),
    completed: (port, statusCode = 200) =>
      onCompleted({
        tabId: 7,
        method: 'POST',
        url: `http://10.0.15.33:${port}/api/login`,
        statusCode
      }),
    nativeCompleted: () =>
      onCompleted({
        tabId: 7,
        frameId: 0,
        type: 'main_frame',
        method: 'POST',
        statusCode: 200,
        url: payload.form_action
      }),
    lookup: (message = {}, sender = {}) =>
      new Promise((resolve) =>
        onMessage(
          {
            type: 'LP_LOOKUP',
            identity: '10.0.15.33',
            site_name: payload.site_name,
            project_name: 'Agent Router',
            ...message
          },
          {
            url: payload.page_url,
            tab: { id: 7 },
            frameId: 0,
            documentId: 'login-page',
            ...sender
          },
          resolve
        )
      ),
    cancelLookup: (requestId, sender = {}) =>
      onMessage(
        { type: 'LP_LOOKUP_CANCEL', requestId },
        { url: payload.page_url, tab: { id: 7 }, frameId: 0, documentId: 'login-page', ...sender },
        () => {}
      ),
    send: () => context.sendCapture(7, vm.runInContext('pendingCaptures[7]', context))
  }
}

test('background uses the sender URL port even with an old content script', async () => {
  const fixture = background()
  await fixture.lookup()
  assert.equal(new URL(fixture.messages[0].url).searchParams.get('identity'), '10.0.15.33:3000')
  assert.equal(new URL(fixture.messages[0].url).searchParams.get('project_name'), 'Agent Router')
})

test('split login only combines a username in the same origin, frame and unlocked vault revision', async () => {
  for (const mismatch of ['none', 'revision', 'origin', 'kind', 'expired']) {
    const fixture = background()
    const stored = {}
    fixture.context.chrome.storage.session = { set: async values => Object.assign(stored, values), get: async key => ({ [key]: stored[key] }), remove: async key => delete stored[key] }
    let revision = 'desktop:1'
    fixture.context.fetch = async (url, config) => {
      fixture.messages.push({ url: String(url), config })
      if (String(url).includes('/extension-status')) return new Response(JSON.stringify({ ok: true, unlocked: true, revision }))
      if (String(url).endsWith('/capture')) return new Response(JSON.stringify({ ok: true, changed: true }))
      return new Response(png, { headers: { 'content-type': 'image/png' } })
    }
    fixture.message({ type: 'LP_SPLIT_USERNAME', username: 'split-user', kind: 'login' })
    await new Promise(resolve => setImmediate(resolve))
    const split = stored['split-login:7:0']
    if (mismatch === 'revision') revision = 'desktop:2'
    if (mismatch === 'origin') split.origin = 'https://other.example'
    if (mismatch === 'kind') split.kind = 'registration'
    if (mismatch === 'expired') split.at = Date.now() - 120001
    fixture.submit('split', { username: '' })
    await fixture.send()
    const capture = fixture.messages.find(entry => entry.url.endsWith('/capture'))
    assert.equal(JSON.parse(capture.config.body).username, mismatch === 'none' ? 'split-user' : '')
    assert.equal(stored['split-login:7:0'], undefined)
  }
})

test('cancelling a document lookup aborts its HTTP request without affecting another document', async () => {
  const fixture = background({
    lookupFetch: (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')))
      )
  })
  const first = fixture.lookup({ requestId: 'choice-1' })
  const second = fixture.lookup({ requestId: 'choice-1' }, { documentId: 'other-page' })
  fixture.cancelLookup('choice-1')
  assert.equal(fixture.messages[0].config.signal.aborted, true)
  assert.equal(fixture.messages[1].config.signal.aborted, false)
  assert.equal((await first).ok, false)
  fixture.cancelLookup('choice-1', { documentId: 'other-page' })
  assert.equal((await second).ok, false)
})

test('Jenkins-style POST redirect saves only after the destination document confirms no login form or error', async () => {
  const fixture = background()
  fixture.submit('native-login')
  fixture.redirect()
  assert.equal(fixture.timers.filter((t) => t.delay === 1800).length, 0)
  fixture.pageState()
  fixture.pageState()
  assert.equal(fixture.timers.filter((t) => t.delay === 1800).length, 1)
  await fixture.timers.find((t) => t.delay === 1800).callback()
  const saved = JSON.parse(fixture.messages.find((m) => m.url.endsWith('/capture')).config.body)
  assert.equal(saved.identity, '10.0.15.33:3000')
  assert.equal(saved.username, 'demo')
})

test('a native login returning HTTP 200 also waits for the destination login state', () => {
  const fixture = background()
  fixture.submit('native-login')
  fixture.nativeCompleted()
  assert.equal(fixture.timers.filter((t) => t.delay === 1800).length, 0)
  fixture.pageState({ hasLoginFields: true })
  assert.equal(fixture.timers.filter((t) => t.delay === 1800).length, 0)
})

test('registration POST success waits for explicit page confirmation before persistence', async () => {
  const fixture = background()
  fixture.submit('registration', { capture_kind: 'registration' })
  fixture.completed(3000)
  assert.equal(fixture.timers.filter((t) => t.delay === 1800).length, 0)
  fixture.confirm('registration')
  await fixture.timers.find((t) => t.delay === 1800).callback()
  const saved = JSON.parse(fixture.messages.find((m) => m.url.endsWith('/capture')).config.body)
  assert.equal(saved.capture_kind, 'registration')
  assert.equal(saved.username, 'demo')
})

test('registration redirected to a login page saves instead of treating login fields as failure', async () => {
  const fixture = background()
  fixture.submit('registration', { capture_kind: 'registration' })
  fixture.redirect()
  fixture.pageState(
    { hasLoginFields: true, hasRegistrationFields: false },
    {
      url: 'http://10.0.15.33:3000/signin'
    }
  )
  await fixture.timers.find((t) => t.delay === 1800).callback()
  assert.equal(fixture.status().state, 'saved')
})

test('registration returning to the same page only saves with an explicit success notice', async () => {
  const fixture = background()
  fixture.submit('registration', { capture_kind: 'registration' })
  fixture.nativeCompleted()
  fixture.pageState(
    { hasRegistrationFields: true, registrationSucceeded: true },
    {
      url: 'http://10.0.15.33:3000/login'
    }
  )
  await fixture.timers.find((t) => t.delay === 1800).callback()
  assert.equal(fixture.status().state, 'saved')
})

test('failed registration responses, unchanged pages and old page scripts never persist', async () => {
  for (const [state, url] of [
    [{ hasRegistrationFields: true }, 'http://10.0.15.33:3000/signup'],
    [
      { hasRegistrationFields: false, hasLoginError: true, registrationSucceeded: true },
      'http://10.0.15.33:3000/signin'
    ],
    [{ hasRegistrationFields: false }, 'http://10.0.15.33:3000/login'],
    [{ hasLoginFields: true }, 'http://10.0.15.33:3000/signin']
  ]) {
    const fixture = background()
    fixture.submit('registration', { capture_kind: 'registration' })
    fixture.nativeCompleted()
    fixture.pageState(state, { url })
    assert.equal(fixture.timers.filter((t) => t.delay === 1800).length, 0)
    assert.equal(fixture.status().state, 'login-failed')
  }
  const fixture = background()
  fixture.submit('registration', { capture_kind: 'registration' })
  fixture.completed(3000, 400)
  fixture.confirm('registration')
  assert.equal(fixture.timers.filter((t) => t.delay === 1800).length, 0)
  assert.equal(fixture.status().state, 'request-failed')
})

test('failed redirect destinations cancel saving, including errors appearing after a success candidate', async () => {
  for (const state of [{ hasLoginFields: true }, { hasLoginError: true }]) {
    const fixture = background()
    fixture.submit('native-login')
    fixture.redirect()
    fixture.pageState()
    fixture.pageState(state)
    await fixture.timers.find((t) => t.delay === 1800).callback()
    assert.equal(
      fixture.messages.some((m) => m.url.endsWith('/capture')),
      false
    )
  }
})

test('unrelated redirects and stale, other-frame or other-origin documents cannot confirm a native login', () => {
  const fixture = background()
  fixture.submit('native-login')
  fixture.redirect({ url: 'http://10.0.15.33:3000/unrelated' })
  fixture.pageState()
  fixture.redirect({ frameId: 1 })
  fixture.pageState()
  fixture.redirect({ redirectUrl: 'http://10.0.15.33:8080/' })
  fixture.pageState()
  assert.equal(fixture.timers.filter((t) => t.delay === 1800).length, 0)
  fixture.redirect()
  fixture.pageState({}, { documentId: 'login-page' })
  fixture.pageState({}, { frameId: 1 })
  fixture.pageState({}, { url: 'http://10.0.15.33:8080/' })
  assert.equal(fixture.timers.filter((t) => t.delay === 1800).length, 0)
})

test('a confirmed SPA transition saves the website port even when login uses another API port', async () => {
  const fixture = background()
  fixture.submit('attempt-1')
  fixture.completed(30080)
  assert.equal(fixture.timers.filter((timer) => timer.delay === 1800).length, 0)
  fixture.confirm('attempt-1')
  await fixture.timers.find((timer) => timer.delay === 1800).callback()
  const saved = JSON.parse(
    fixture.messages.find((message) => message.url.endsWith('/capture')).config.body
  )
  assert.equal(saved.identity, '10.0.15.33:3000')
  assert.equal(saved.password, 'synthetic-only')
})

test('stale, cross-origin, other-frame and other-document confirmations cannot save a capture', () => {
  const fixture = background()
  fixture.submit('old')
  fixture.submit('current')
  fixture.confirm('old')
  fixture.confirm('current', { frameId: 1 })
  fixture.confirm('current', { documentId: 'different-document' })
  fixture.confirm('current', { url: 'http://10.0.15.33:8080/#/home' })
  assert.equal(fixture.timers.filter((timer) => timer.delay === 1800).length, 0)
})

test('HTTP success alone never saves; an explicit page confirmation preserves the website port', async () => {
  const fixture = background()
  fixture.submit('http-result')
  fixture.completed(8080, 500)
  assert.equal(fixture.timers.filter((timer) => timer.delay === 1800).length, 0)
  fixture.completed(3000)
  assert.equal(fixture.timers.filter((timer) => timer.delay === 1800).length, 0)
  fixture.confirm('http-result')
  assert.equal(fixture.timers.filter((timer) => timer.delay === 1800).length, 1)
  await fixture.timers.find((timer) => timer.delay === 1800).callback()
  const saved = JSON.parse(
    fixture.messages.find((message) => message.url.endsWith('/capture')).config.body
  )
  assert.equal(saved.identity, '10.0.15.33:3000')
  assert.equal(saved.site_url, 'http://10.0.15.33:3000')
  assert.equal(saved.display_name, 'Agent Router')
  assert.equal(saved.page_title, 'Agent Router · 控制台')
  assert.match(saved.icon_data, /^data:image\/png;base64,/)
  assert.equal(saved.icon_url, undefined)
})

test('an unavailable favicon does not prevent saving the password and name', async () => {
  const fixture = background({ iconFetch: async () => new Response('', { status: 404 }) })
  fixture.submit()
  await fixture.send()
  const saved = JSON.parse(
    fixture.messages.find((message) => message.url.endsWith('/capture')).config.body
  )
  assert.equal(saved.icon_data, '')
  assert.equal(saved.site_name, 'Agent Router')
})

test('icons served with a generic MIME type are decoded; HTML favicon fallbacks are rejected', async () => {
  const fixture = background({
    iconFetch: async () =>
      new Response(png, { headers: { 'content-type': 'application/octet-stream' } })
  })
  assert.match(
    await fixture.context.loadSiteIcon('https://example.com/favicon.png'),
    /^data:image\/png;base64,/
  )
  fixture.context.fetch = async () =>
    new Response('<!DOCTYPE html><html>SPA shell</html>', {
      headers: { 'content-type': 'image/png' }
    })
  assert.equal(await fixture.context.loadSiteIcon('https://example.com/favicon.ico'), '')
})

test('icon fetch accepts redirects and uses credentials only for the current website origin', async () => {
  const fixture = background()
  await fixture.context.loadSiteIcon('https://example.com/icon.png', 'https://example.com/login')
  await fixture.context.loadSiteIcon(
    'https://cdn.example.com/icon.png',
    'https://example.com/login'
  )
  assert.equal(fixture.messages[0].config.redirect, 'follow')
  assert.equal(fixture.messages[0].config.credentials, 'include')
  assert.equal(fixture.messages[1].config.credentials, 'omit')
})

test('background discovers actual favicon links when favicon.ico returns a page and browser cache is empty', async () => {
  const fixture = background({
    iconFetch: async (url) => {
      if (url === 'http://10.0.15.33:3000')
        return new Response(
          '<html><head><link href="/assets/favicon.png" rel="shortcut icon"></head></html>',
          { headers: { 'content-type': 'text/html' } }
        )
      if (url.endsWith('/assets/favicon.png'))
        return new Response(png, { headers: { 'content-type': 'image/png' } })
      return new Response('<!DOCTYPE html><html>SPA fallback</html>', {
        headers: { 'content-type': 'text/html' }
      })
    }
  })
  const result = await fixture.context.enrichSite(undefined, {
    page_url: 'http://10.0.15.33:3000/login'
  })
  assert.match(result.icon_data, /^data:image\/png;base64,/)
  assert.ok(fixture.messages.some((message) => message.url.endsWith('/assets/favicon.png')))
})

test('live page rasterization supplies icons when direct requests are blocked', async () => {
  const fixture = background({ iconFetch: async () => new Response('', { status: 403 }) })
  fixture.context.chrome.tabs.sendMessage = async (_id, message) => {
    assert.equal(message.type, 'LP_COLLECT_SITE_ICON')
    return { icon: `data:image/png;base64,${png.toString('base64')}` }
  }
  const result = await fixture.context.enrichSite(7, { page_url: 'http://10.0.15.33:3000/login' })
  assert.match(result.icon_data, /^data:image\/png;base64,/)
})

test('browser placeholder responses fall through to actual site links', async () => {
  const placeholder = Buffer.from(DEFAULT_BROWSER_ICON.split(',')[1], 'base64')
  const fixture = background({
    iconFetch: async (url) => {
      if (url.startsWith('chrome-extension:'))
        return new Response(placeholder, { headers: { 'content-type': 'image/png' } })
      if (url === 'https://example.com') return new Response('<link rel="icon" href="/real.png">')
      if (url.endsWith('/real.png'))
        return new Response(png, { headers: { 'content-type': 'image/png' } })
      return new Response('', { status: 404 })
    }
  })
  assert.equal(vm.runInContext('DEFAULT_BROWSER_ICON', fixture.context), DEFAULT_BROWSER_ICON)
  const result = await fixture.context.enrichSite(undefined, {
    page_url: 'https://example.com/login'
  })
  assert.match(result.icon_data, /^data:image\/png;base64,/)
  assert.ok(fixture.messages.some(({ url }) => url.endsWith('/real.png')))
})

test('filling reports activity using the sender site without sending credentials', async () => {
  const fixture = background()
  fixture.message({
    type: 'LP_ACCOUNT_USED',
    selectionToken: 'selected',
    identity: 'wrong.example'
  })
  await new Promise((resolve) => setImmediate(resolve))
  const request = fixture.messages.find(({ url }) => url.endsWith('/activity'))
  assert.deepEqual(JSON.parse(request.config.body), {
    identity: '10.0.15.33:3000',
    selection_token: 'selected'
  })
  fixture.message(
    { type: 'LP_ACCOUNT_USED', selectionToken: 'selected' },
    { url: 'file:///private' }
  )
  assert.equal(fixture.messages.filter(({ url }) => url.endsWith('/activity')).length, 1)
})

test('normalized and live-page placeholders never count as successful icons', async () => {
  const fixture = background({
    rasterizedPng: Buffer.from(DEFAULT_BROWSER_ICON.split(',')[1], 'base64')
  })
  assert.equal(await fixture.context.loadSiteIcon('https://example.com/icon.png'), '')
  fixture.context.chrome.tabs.sendMessage = async () => ({ icon: DEFAULT_BROWSER_ICON })
  const result = await fixture.context.enrichSite(7, { page_url: 'http://10.0.15.33:3000/login' })
  assert.equal(result.icon_data, '')
})

test('automatic icon scan writes metadata only, retries failures with backoff and retries after a vault session changes', async () => {
  let revision = 'session-a',
    unavailable = false
  const fixture = background({
    siteIconsFetch: async (_url, config) =>
      config.method === 'POST'
        ? new Response(JSON.stringify({ ok: true }))
        : new Response(
            JSON.stringify({
              ok: true,
              revision,
              sites: [
                {
                  id: 42,
                  identity: '10.0.15.33:3000',
                  site_url: 'http://10.0.15.33:3000',
                  project_name: 'Agent Router'
                }
              ]
            })
          ),
    iconFetch: async () =>
      unavailable
        ? new Response('', { status: 404 })
        : new Response(png, { headers: { 'content-type': 'image/png' } })
  })
  await fixture.context.refreshMissingIcons()
  const writes = () =>
    fixture.messages.filter(
      (message) => message.url.endsWith('/site-icons') && message.config.method === 'POST'
    )
  assert.equal(writes().length, 1)
  const saved = JSON.parse(writes()[0].config.body)
  assert.equal(saved.revision, revision)
  assert.equal(saved.username, undefined)
  assert.equal(saved.password, undefined)
  await fixture.context.refreshMissingIcons()
  assert.equal(writes().length, 1)
  revision = 'session-b'
  await fixture.context.refreshMissingIcons()
  assert.equal(writes().length, 2)
  revision = 'session-c'
  unavailable = true
  await fixture.context.refreshMissingIcons()
  const attempts = fixture.messages.length
  await fixture.context.refreshMissingIcons()
  assert.equal(fixture.messages.length, attempts + 1, 'backoff only checks the missing list')
})

test('inline raster icons are normalized while oversized and active data URLs are rejected', async () => {
  const fixture = background()
  const inline = `data:image/png;base64,${png.toString('base64')}`
  assert.match(await fixture.context.loadSiteIcon(inline), /^data:image\/png;base64,/)
  const fetched = fixture.messages.length
  for (const value of [
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:text/html;base64,PHNjcmlwdC8+',
    'data:image/png;base64,' + 'A'.repeat(256 * 1024),
    'data:image/png;base64,not-valid!'
  ]) {
    assert.equal(await fixture.context.loadSiteIcon(value), '')
  }
  assert.equal(fixture.messages.length, fetched)
})

test('background never takes a different named project icon from an open tab on the same port', async () => {
  const fixture = background({
    siteIconsFetch: async (_url, config) =>
      config.method === 'POST'
        ? new Response(JSON.stringify({ ok: true }))
        : new Response(
            JSON.stringify({
              ok: true,
              revision: 'projects',
              sites: [
                {
                  id: 12,
                  identity: '10.0.15.33:3000',
                  site_url: 'http://10.0.15.33:3000',
                  project_name: 'Project A'
                }
              ]
            })
          ),
    iconFetch: async () => new Response('', { status: 404 })
  })
  fixture.context.chrome.tabs.query = async () => [
    { id: 7, url: 'http://10.0.15.33:3000/dashboard' }
  ]
  const requested = []
  fixture.context.chrome.tabs.sendMessage = async (_id, message) => {
    requested.push(message.type)
    if (message.type === 'LP_SITE_METADATA')
      return {
        page_url: 'http://10.0.15.33:3000/dashboard',
        project_name: 'Project B',
        icon_url: 'http://10.0.15.33:3000/b.png'
      }
    throw new Error('Must not ask the other project for its image')
  }
  await fixture.context.refreshMissingIcons()
  assert.deepEqual(requested, ['LP_SITE_METADATA'])
  assert.equal(
    fixture.messages.some((message) => message.url.endsWith('/b.png')),
    false
  )
})

test('a login failure while loading the icon cancels the pending capture', async () => {
  let release
  const fixture = background({
    iconFetch: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })
  fixture.submit()
  const sending = fixture.send()
  await new Promise((resolve) => setImmediate(resolve))
  fixture.fail()
  release(new Response(png, { headers: { 'content-type': 'image/png' } }))
  await sending
  assert.equal(
    fixture.messages.some((message) => message.url.endsWith('/capture')),
    false
  )
})

test('diagnostics record submission, expiry and successful persistence without storing secrets', async () => {
  const fixture = background()
  fixture.submit('diagnostic-attempt')
  assert.equal(fixture.status().state, 'submitted')
  assert.deepEqual(Object.keys(fixture.status()).sort(), ['at', 'origin', 'state'])
  assert.equal(fixture.status().origin, 'http://10.0.15.33:3000')
  assert.equal(JSON.stringify(fixture.status()).includes('synthetic-only'), false)
  await fixture.send()
  assert.equal(fixture.status().state, 'saved')
  fixture.timers.find((timer) => timer.delay === 15000).callback()
  assert.equal(fixture.status().state, 'saved')

  const expired = background()
  expired.submit('expired')
  expired.timers.find((timer) => timer.delay === 15000).callback()
  assert.equal(expired.status().state, 'expired')
})

test('HTTP and application save failures are reported instead of being treated as success', async () => {
  for (const [status, body, expected] of [
    [423, { ok: false, error: 'Vault locked' }, 'locked'],
    [500, { ok: false }, 'save-failed'],
    [200, { ok: false }, 'save-failed'],
    [200, { ok: true, changed: false }, 'unchanged'],
    [200, { ok: true, changed: false, cancelled: true }, 'cancelled']
  ]) {
    const fixture = background({
      captureFetch: async () => new Response(JSON.stringify(body), { status })
    })
    fixture.submit('save-result')
    await fixture.send()
    assert.equal(fixture.status().state, expected)
  }
})

test('a connection failure reports disconnected without retaining the pending credential', async () => {
  const fixture = background({
    captureFetch: async () => {
      throw new TypeError('Failed to fetch')
    }
  })
  fixture.submit('offline')
  await fixture.send()
  assert.equal(fixture.status().state, 'disconnected')
  assert.equal(vm.runInContext('pendingCaptures[7]', fixture.context), undefined)
})

test('a late save response cannot replace the status of a newer login', async () => {
  let release
  const fixture = background({
    captureFetch: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })
  fixture.submit('old-attempt')
  const saving = fixture.send()
  await new Promise((resolve) => setImmediate(resolve))
  fixture.submit('new-attempt')
  release(new Response(JSON.stringify({ ok: true, changed: true })))
  await saving
  assert.equal(fixture.status().state, 'submitted')
})
