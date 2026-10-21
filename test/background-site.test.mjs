import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

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
    injected.map((entry) => entry.target.tabId),
    [11, 12]
  )
  for (const entry of injected) {
    assert.equal(entry.target.allFrames, true)
    assert.deepEqual(Array.from(entry.files), ['content.js'])
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
        return new Blob([png], { type: 'image/png' })
      }
    },
    fetch: async (url, config) => {
      const address = String(url)
      messages.push({ url: address, config })
      if (address.includes('127.0.0.1:35320') && options.lookupFetch && address.includes('/lookup'))
        return options.lookupFetch(address, config)
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
    submit: (attemptId) =>
      onMessage(
        { type: 'LP_LOGIN_SUBMITTED', payload, attemptId },
        { tab: { id: 7 }, frameId: 0, documentId: 'login-page' },
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

test('a login request on a different port neither saves nor cancels this login', async () => {
  const fixture = background()
  fixture.submit()
  fixture.completed(8080, 500)
  assert.equal(fixture.timers.filter((timer) => timer.delay === 1800).length, 0)
  fixture.completed(3000)
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
