/* global qa, chrome */
// Run with `npm run test:extension`. Uses the project's Electron in a hidden,
// isolated window; no installed extension, real website or vault is accessed.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../chrome-extension/manifest.json'), 'utf8')
)
assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
for (const [size, icon] of Object.entries(manifest.icons)) {
  const image = fs.readFileSync(path.join(__dirname, '../chrome-extension', icon))
  assert.equal(image.toString('ascii', 1, 4), 'PNG')
  assert.equal(image.readUInt32BE(16), Number(size))
  assert.equal(image.readUInt32BE(20), Number(size))
}
console.log('PASS extension manifest uses the generated LocalPass PNG icons at every declared size')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME'])
    delete env[key]
  const result = spawnSync(require('electron'), [__filename], {
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 60000
  })
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 1
} else {
  const { app, BrowserWindow } = require('electron')
  const http = require('node:http')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'localpass-autofill-test-'))
  app.setPath('userData', profile)
  app.commandLine.appendSwitch('in-process-gpu')
  app.disableHardwareAcceleration()
  const source = fs.readFileSync(path.join(__dirname, '../chrome-extension/content.js'), 'utf8')
  const fixture = `<!doctype html><html><head><title>Agent Router · 登录</title><meta property="og:site_name" content="Agent Router"><link rel="icon" href="./brand.png"></head><body>
    <form id="login"><input id="username" name="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button id="submit" type="submit">登录</button><button id="reveal" type="button">显示密码</button></form>
    <input id="search" name="search"><button id="outside" type="button">Dashboard action</button><main id="dashboard"></main>
    <form id="other"><input id="other-user" name="username"><input id="other-password" type="password"></form>
    <form id="register"><input id="new-password" type="password" autocomplete="new-password"></form>
  </body></html>`
  let window, server, fixturePng
  let passed = 0
  const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
  async function evaluate(fn, ...args) {
    const result = await window.webContents.executeJavaScript(
      `(() => { try { return (${fn.toString()})(...${JSON.stringify(args)}) } catch (error) { return { testError: error.stack } } })()`
    )
    if (result?.testError) throw new Error(result.testError)
    return result
  }
  async function reset() {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/login`)
    await evaluate(() => {
      window.qa = {
        messages: [],
        pageStates: [],
        callbacks: [],
        listeners: [],
        reply(index = 0) {
          this.callbacks[index]({
            ok: true,
            accounts: [{ username: 'demo-user', password: 'synthetic-secret' }]
          })
        },
        picker() {
          return document.querySelector('[data-localpass-picker]')
        },
        click(element) {
          element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
          element.focus()
          element.click()
        }
      }
      window.chrome = {
        runtime: {
          lastError: null,
          id: 'fixture',
          getManifest: () => ({ version: '1.3.7' }),
          onMessage: {
            addListener: (fn) => qa.listeners.push(fn),
            removeListener: (fn) => {
              qa.listeners = qa.listeners.filter((entry) => entry !== fn)
            }
          },
          sendMessage(message, callback) {
            if (message.type === 'LP_PAGE_STATE') {
              qa.pageStates.push(message)
              return
            }
            qa.messages.push(message)
            if (callback) qa.callbacks.push(callback)
          }
        }
      }
      document
        .querySelectorAll('form')
        .forEach((form) => form.addEventListener('submit', (event) => event.preventDefault()))
    })
    await window.webContents.executeJavaScript(source)
  }
  async function open() {
    window.webContents.focus()
    await evaluate(() => {
      document.querySelector('#password').focus()
      qa.reply(qa.callbacks.length - 1)
    })
    await pause()
    assert.equal(await evaluate(() => !!qa.picker()), true)
  }
  async function test(name, run) {
    await reset()
    await run()
    passed++
    console.log(`PASS ${name}`)
  }
  async function run() {
    server = http.createServer((_req, res) => {
      if (_req.url === '/j_spring_security_check' && _req.method === 'POST') {
        _req.resume()
        res.writeHead(302, { Location: '/native-home' })
        res.end()
        return
      }
      if (_req.url === '/native-home') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<!doctype html><title>Dashboard - Jenkins fixture</title><main>Signed in</main>')
        return
      }
      if (_req.url === '/brand.png') {
        res.setHeader('Content-Type', 'image/png')
        res.end(fixturePng || Buffer.alloc(0))
        return
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(fixture)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    window = new BrowserWindow({
      show: false,
      width: 1100,
      height: 760,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true }
    })
    await test('reattaching an open page keeps input values and exactly one working listener', async () => {
      await open()
      await evaluate(() => {
        document.querySelector('#username').value = 'already-typed'
        chrome.runtime.id = undefined
      })
      await window.webContents.executeJavaScript(source)
      await evaluate(() => {
        chrome.runtime.id = 'fixture'
        qa.reply(qa.callbacks.length - 1)
      })
      assert.equal(await evaluate(() => document.querySelector('#username').value), 'already-typed')
      assert.equal(await evaluate(() => qa.listeners.length), 1)
      assert.equal(
        await evaluate(() => document.querySelectorAll('[data-localpass-picker]').length),
        1
      )
      await window.webContents.executeJavaScript(source)
      assert.equal(await evaluate(() => qa.listeners.length), 1)
      await evaluate(() => qa.click(qa.picker().querySelector('button')))
      assert.equal(
        await evaluate(() => document.querySelector('#password').value),
        'synthetic-secret'
      )
    })
    await test('desktop reconnect retries a still focused field without refreshing the page', async () => {
      window.webContents.focus()
      await evaluate(() => {
        document.querySelector('#password').focus()
        qa.callbacks[0]({ ok: false, accounts: [] })
      })
      await pause(2150)
      assert.equal(await evaluate(() => qa.callbacks.length), 2)
      await evaluate(() => qa.reply(1))
      assert.equal(await evaluate(() => !!qa.picker()), true)
    })
    await test('a reconnect retry stops when the user leaves the login field', async () => {
      await evaluate(() => {
        document.querySelector('#password').focus()
        qa.callbacks[0]({ ok: false, accounts: [] })
        document.querySelector('#search').focus()
      })
      await pause(2150)
      assert.equal(await evaluate(() => qa.callbacks.length), 1)
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('page load and unrelated mutations never open the picker', async () => {
      await evaluate(() => {
        document.querySelector('#dashboard').innerHTML = '<p>Loaded dashboard</p>'
        document.querySelector('#search').focus()
      })
      await pause(350)
      assert.equal(await evaluate(() => qa.messages.length), 0)
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('hovering over a login field does not look up accounts or open a picker', async () => {
      await evaluate(() => {
        const password = document.querySelector('#password')
        password.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        password.dispatchEvent(new MouseEvent('mouseenter'))
      })
      await pause()
      assert.equal(await evaluate(() => qa.callbacks.length), 0)
      assert.equal(await evaluate(() => !!qa.picker()), false)
      await open()
      assert.equal(await evaluate(() => qa.callbacks.length), 1)
    })
    await test('capture and lookup preserve the port, website name, tab title and relative icon URL', async () => {
      await open()
      await evaluate(() => qa.click(qa.picker().querySelector('button')))
      await evaluate(() => qa.click(document.querySelector('#submit')))
      const actual = await evaluate(() => ({
        host: location.host,
        origin: location.origin,
        lookup: qa.messages.find((message) => message.type === 'LP_LOOKUP'),
        capture: qa.messages.find((message) => message.type === 'LP_LOGIN_SUBMITTED').payload
      }))
      assert.equal(actual.lookup.identity, actual.host)
      assert.equal(actual.capture.identity, actual.host)
      assert.match(actual.capture.identity, /:\d+$/)
      assert.equal(actual.capture.site_url, actual.origin)
      assert.equal(actual.capture.site_name, 'Agent Router')
      assert.equal(actual.capture.page_title, 'Agent Router · 登录')
      assert.equal(actual.capture.display_name, 'Agent Router')
      assert.equal(actual.capture.icon_url, `${actual.origin}/brand.png`)
    })
    await test('selecting an account closes once and does not submit or reopen', async () => {
      await open()
      await evaluate(() => qa.click(qa.picker().querySelector('button')))
      await evaluate(() => {
        document.querySelector('#dashboard').textContent = 'rerender after fill'
      })
      await pause(350)
      assert.deepEqual(
        await evaluate(() => ({
          username: document.querySelector('#username').value,
          password: document.querySelector('#password').value,
          count: qa.messages.length,
          picker: !!qa.picker()
        })),
        { username: 'demo-user', password: 'synthetic-secret', count: 1, picker: false }
      )
      await evaluate(() => qa.click(document.querySelector('#password')))
      assert.equal(await evaluate(() => qa.callbacks.length), 2)
      await evaluate(() => qa.reply(1))
      assert.equal(await evaluate(() => !!qa.picker()), true)
    })
    await test('outside click and Escape stay dismissed through DOM updates', async () => {
      await open()
      await evaluate(() => qa.click(document.querySelector('#outside')))
      await pause(350)
      assert.equal(await evaluate(() => !!qa.picker()), false)
      await open()
      await evaluate(() =>
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
      )
      await pause(350)
      assert.equal(await evaluate(() => !!qa.picker()), false)
      assert.equal(await evaluate(() => qa.callbacks.length), 2)
    })
    await test('late replies cannot recreate a dismissed picker', async () => {
      await evaluate(() => document.querySelector('#password').focus())
      await evaluate(() => qa.click(document.querySelector('#outside')))
      await evaluate(() => qa.reply())
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('late replies cannot attach to removed or hidden forms', async () => {
      await evaluate(() => {
        document.querySelector('#password').focus()
        document.querySelector('#login').remove()
        qa.reply()
      })
      await pause()
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('SPA navigation removes the picker and invalidates late replies', async () => {
      await open()
      await evaluate(() => {
        history.pushState({}, '', '/dashboard')
        document.querySelector('#dashboard').textContent = 'Signed in'
      })
      await pause()
      assert.equal(await evaluate(() => !!qa.picker()), false)
      await evaluate(() => qa.reply())
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('hidden, detached and disabled fields close an existing picker', async () => {
      await open()
      await evaluate(() => {
        document.querySelector('#login').hidden = true
      })
      await pause()
      assert.equal(await evaluate(() => !!qa.picker()), false)
      await evaluate(() => {
        document.querySelector('#login').hidden = false
        document.querySelector('#outside').focus()
      })
      await open()
      await evaluate(() => {
        document.querySelector('#password').disabled = true
      })
      await pause()
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('only explicit login submits capture; reveal and picker clicks do not', async () => {
      await open()
      await evaluate(() => qa.click(qa.picker().querySelector('button')))
      await evaluate(() => qa.click(document.querySelector('#reveal')))
      assert.equal(
        await evaluate(() => qa.messages.filter((m) => m.type === 'LP_LOGIN_SUBMITTED').length),
        0
      )
      await evaluate(() => qa.click(document.querySelector('#submit')))
      assert.equal(
        await evaluate(() => qa.messages.filter((m) => m.type === 'LP_LOGIN_SUBMITTED').length),
        1
      )
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('usernames scope to their form; new-password fields never trigger', async () => {
      await evaluate(() => document.querySelector('#new-password').focus())
      assert.equal(await evaluate(() => qa.callbacks.length), 0)
      await evaluate(() => {
        document.querySelector('#other-user').focus()
        qa.reply()
      })
      await evaluate(() => qa.click(qa.picker().querySelector('button')))
      assert.deepEqual(
        await evaluate(() =>
          ['#username', '#password', '#other-user', '#other-password'].map(
            (s) => document.querySelector(s).value
          )
        ),
        ['', '', 'demo-user', 'synthetic-secret']
      )
    })
    await test('a revealed current password still captures in an email login form', async () => {
      await evaluate(() => {
        document.body.innerHTML =
          '<form><input id="email" type="email" autocomplete="email"><input id="password" type="text" autocomplete="current-password"><button type="submit">Sign in</button></form>'
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault()
          document.querySelectorAll('input').forEach((input) => {
            input.disabled = true
          })
        })
        document.querySelector('#email').value = 'demo@example.invalid'
        document.querySelector('#password').value = 'synthetic-revealed-secret'
        qa.click(document.querySelector('button'))
      })
      const captured = await evaluate(() =>
        qa.messages.filter((m) => m.type === 'LP_LOGIN_SUBMITTED')
      )
      assert.equal(captured.length, 1)
      assert.equal(captured[0].payload.username, 'demo@example.invalid')
      assert.equal(captured[0].payload.password, 'synthetic-revealed-secret')
    })
    await test('revealing a recognized password without autocomplete still preserves its field identity', async () => {
      await evaluate(() => {
        const password = document.querySelector('#password')
        password.removeAttribute('autocomplete')
        password.focus()
        password.type = 'text'
        document.querySelector('#username').value = 'demo'
        password.value = 'synthetic-revealed-secret'
        qa.click(document.querySelector('#submit'))
      })
      assert.equal(
        await evaluate(() => qa.messages.some((m) => m.type === 'LP_LOGIN_SUBMITTED')),
        true
      )
    })
    await test('ordinary text and revealed registration fields never capture as passwords', async () => {
      await evaluate(() => {
        document.body.innerHTML =
          '<form><input id="username" value="demo"><input id="password" type="text" autocomplete="new-password" value="synthetic-only"><button type="submit">Sign in</button></form>'
        document.querySelector('form').addEventListener('submit', (event) => event.preventDefault())
        qa.click(document.querySelector('button'))
        document.querySelector('#password').removeAttribute('autocomplete')
        qa.click(document.querySelector('button'))
      })
      assert.equal(
        await evaluate(() => qa.messages.some((m) => m.type === 'LP_LOGIN_SUBMITTED')),
        false
      )
    })
    await test('SPA login controls without a form still fill and capture on login', async () => {
      await evaluate(() => {
        document.body.innerHTML =
          '<input id="username" name="username"><input id="password" type="password"><div id="login-button" role="button" tabindex="0">登录</div>'
      })
      await open()
      await evaluate(() => qa.click(qa.picker().querySelector('button')))
      await evaluate(() => qa.click(document.querySelector('#login-button')))
      assert.equal(
        await evaluate(() => qa.messages.filter((m) => m.type === 'LP_LOGIN_SUBMITTED').length),
        1
      )
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('out-of-order responses only show the most recent focused field', async () => {
      await evaluate(() => {
        document.querySelector('#username').focus()
        document.querySelector('#other-user').focus()
        qa.reply(1)
        qa.reply(0)
      })
      assert.equal(
        await evaluate(() => document.querySelectorAll('[data-localpass-picker]').length),
        1
      )
      await evaluate(() => qa.click(qa.picker().querySelector('button')))
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('desktop focus transfer and restored focus reuse one lookup; cancellation waits for an explicit click', async () => {
      await evaluate(() => {
        const input = document.querySelector('#password')
        input.focus()
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
        window.dispatchEvent(new Event('blur'))
        document.querySelector('#username').focus()
        input.focus()
      })
      assert.equal(await evaluate(() => qa.callbacks.length), 1)
      assert.equal(
        await evaluate(() => qa.messages.some((m) => m.type === 'LP_LOOKUP_CANCEL')),
        false
      )
      await evaluate(() => {
        qa.callbacks[0]({ ok: true, selected: false, accounts: [] })
        const input = document.querySelector('#password')
        input.blur()
        input.focus()
      })
      assert.equal(await evaluate(() => qa.callbacks.length), 1)
      await evaluate(() => qa.click(document.querySelector('#password')))
      assert.equal(await evaluate(() => qa.callbacks.length), 2)
    })
    await test('selected desktop accounts fill once and never prompt again on restored focus', async () => {
      await evaluate(() => {
        const input = document.querySelector('#password')
        input.focus()
        window.dispatchEvent(new Event('blur'))
        document.querySelector('#username').focus()
        qa.callbacks[0]({
          ok: true,
          selected: true,
          accounts: [{ username: 'chosen', password: 'synthetic-only' }]
        })
        document.querySelector('#username').focus()
        input.focus()
      })
      assert.equal(await evaluate(() => qa.callbacks.length), 1)
      assert.equal(
        await evaluate(() => document.querySelector('#password').value),
        'synthetic-only'
      )
    })
    await test('navigation and typing cancel native lookups and ignore late selected responses', async () => {
      for (const action of ['typing', 'navigation']) {
        await reset()
        await evaluate((action) => {
          const input = document.querySelector('#password')
          input.focus()
          window.dispatchEvent(new Event('blur'))
          if (action === 'typing') {
            input.value = 'user-typed'
            input.dispatchEvent(new Event('input', { bubbles: true }))
          } else {
            history.pushState({}, '', '/dashboard')
            document.querySelector('#login').remove()
          }
        }, action)
        await pause()
        assert.equal(
          await evaluate(() =>
            qa.messages.some(
              (m) => m.type === 'LP_LOOKUP_CANCEL' && m.requestId === qa.messages[0].requestId
            )
          ),
          true
        )
        await evaluate(() =>
          qa.callbacks[0]({
            ok: true,
            selected: true,
            accounts: [{ username: 'stale', password: 'stale' }]
          })
        )
        assert.notEqual(await evaluate(() => document.querySelector('#username')?.value), 'stale')
      }
    })
    await test('cross-port SPA login confirms only after route transition and login form disappearance', async () => {
      await evaluate(() => {
        document.body.innerHTML =
          '<input id="username" placeholder="请输入员工工号"><input id="password" type="password"><button id="spa-login" type="button"><span>登录</span></button>'
        document.querySelector('#username').value = 'synthetic-employee'
        document.querySelector('#password').value = 'synthetic-only'
        qa.click(document.querySelector('#spa-login span'))
        location.hash = '#/home'
      })
      await pause(750)
      assert.equal(
        await evaluate(() => qa.messages.filter((m) => m.type === 'LP_LOGIN_SUCCEEDED').length),
        0
      )
      await evaluate(() => (document.body.innerHTML = '<main>Signed in</main>'))
      await pause(750)
      const result = await evaluate(() => ({
        submitted: qa.messages.find((m) => m.type === 'LP_LOGIN_SUBMITTED'),
        confirmed: qa.messages.filter((m) => m.type === 'LP_LOGIN_SUCCEEDED')
      }))
      assert.equal(result.submitted.payload.username, 'synthetic-employee')
      assert.equal(result.confirmed.length, 1)
      assert.equal(result.confirmed[0].attemptId, result.submitted.attemptId)
    })
    await test('a failed login or form removal without navigation never confirms success', async () => {
      await evaluate(() => {
        document.querySelector('#username').value = 'synthetic-only'
        document.querySelector('#password').value = 'synthetic-only'
        qa.click(document.querySelector('#submit'))
        document.querySelector('#login').remove()
      })
      await pause(750)
      assert.equal(
        await evaluate(() => qa.messages.some((m) => m.type === 'LP_LOGIN_SUCCEEDED')),
        false
      )
      await evaluate(() => {
        location.hash = '#/home'
        document.querySelector('#dashboard').innerHTML = '<div role="alert">账号或密码错误</div>'
      })
      await pause(750)
      assert.equal(
        await evaluate(() => qa.messages.some((m) => m.type === 'LP_LOGIN_FAILED')),
        true
      )
      assert.equal(
        await evaluate(() => qa.messages.some((m) => m.type === 'LP_LOGIN_SUCCEEDED')),
        false
      )
    })
    await test('keyboard account choice remains inside the picker until selected', async () => {
      await open()
      await evaluate(() =>
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
        )
      )
      assert.equal(await evaluate(() => qa.picker()?.contains(document.activeElement)), true)
      await evaluate(() => document.activeElement.click())
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('the picker prefers the space above a login field without stealing focus', async () => {
      await evaluate(() => {
        document.querySelector('#password').style.cssText =
          'position:fixed;left:360px;top:260px;width:240px'
      })
      await open()
      const placement = await evaluate(() => ({
        bottom: qa.picker().getBoundingClientRect().bottom,
        inputTop: document.querySelector('#password').getBoundingClientRect().top,
        focused: document.activeElement.id
      }))
      assert.ok(placement.bottom <= placement.inputTop - 8 + 0.01, JSON.stringify(placement))
      assert.equal(placement.focused, 'password')
      const screenshotPath = path.join(profile, 'picker-above-input.png')
      fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG())
      console.log(`Picker screenshot: ${screenshotPath}`)
    })
    await test('a field near the top places the picker to the right or left when space permits', async () => {
      for (const left of [40, 800]) {
        await evaluate((left) => {
          document.querySelector('#password').style.cssText =
            `position:fixed;left:${left}px;top:20px;width:180px`
        }, left)
        await open()
        const placement = await evaluate(() => {
          const input = document.querySelector('#password').getBoundingClientRect()
          const picker = qa.picker().getBoundingClientRect()
          return {
            inputLeft: input.left,
            inputRight: input.right,
            left: picker.left,
            right: picker.right
          }
        })
        if (left === 40) assert.ok(placement.left >= placement.inputRight + 8)
        else assert.ok(placement.right <= placement.inputLeft - 8)
        await evaluate(() => qa.click(document.querySelector('#outside')))
      }
    })
    await test('the fallback stays inside a narrow viewport and scrolls long account lists', async () => {
      window.setContentSize(320, 300)
      try {
        await evaluate(() => {
          document.querySelector('#password').style.cssText =
            'position:fixed;left:30px;top:20px;width:260px'
          document.querySelector('#password').focus()
          qa.callbacks[qa.callbacks.length - 1]({
            ok: true,
            accounts: Array.from({ length: 20 }, (_, i) => ({ username: `demo-${i}` }))
          })
        })
        const placement = await evaluate(() => {
          const element = qa.picker()
          const rect = element.getBoundingClientRect()
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: innerWidth,
            height: innerHeight,
            scrolls: element.scrollHeight > element.clientHeight
          }
        })
        assert.ok(placement.left >= 8 && placement.right <= placement.width - 8)
        assert.ok(placement.top >= 8 && placement.bottom <= placement.height - 8)
        assert.equal(placement.scrolls, true)
      } finally {
        window.setContentSize(1100, 760)
      }
    })
    await test('Alt+Shift+L focuses an account and selection fills without submitting the login form', async () => {
      await open()
      await evaluate(() => {
        window.qa.submits = 0
        document.querySelector('#login').addEventListener('submit', () => qa.submits++)
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'L',
            altKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true
          })
        )
      })
      assert.equal(await evaluate(() => qa.picker()?.contains(document.activeElement)), true)
      await evaluate(() => {
        // Synthetic keyboard events do not invoke Chromium's default button click.
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true
          })
        )
        document.activeElement.click()
      })
      await pause()
      assert.deepEqual(
        await evaluate(() => ({
          username: document.querySelector('#username').value,
          password: document.querySelector('#password').value,
          submits: qa.submits,
          captured: qa.messages.some((m) => m.type === 'LP_LOGIN_SUBMITTED'),
          picker: !!qa.picker()
        })),
        {
          username: 'demo-user',
          password: 'synthetic-secret',
          submits: 0,
          captured: false,
          picker: false
        }
      )
    })
    await test('the shortcut reuses a pending lookup and Escape restores focus without reopening', async () => {
      await evaluate(() => {
        document.querySelector('#password').focus()
        for (let i = 0; i < 2; i++)
          document.activeElement.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'l',
              altKey: true,
              shiftKey: true,
              bubbles: true,
              cancelable: true
            })
          )
        qa.reply()
      })
      assert.equal(await evaluate(() => qa.callbacks.length), 1)
      assert.equal(await evaluate(() => qa.picker()?.contains(document.activeElement)), true)
      await evaluate(() =>
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true
          })
        )
      )
      await pause()
      assert.equal(await evaluate(() => document.activeElement.id), 'password')
      assert.equal(await evaluate(() => !!qa.picker()), false)
      assert.equal(await evaluate(() => qa.callbacks.length), 1)
      await evaluate(() => {
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'l',
            altKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true
          })
        )
        qa.reply(1)
      })
      assert.equal(await evaluate(() => qa.picker()?.contains(document.activeElement)), true)
    })
    await test('the shortcut leaves unrelated fields and their keyboard events alone', async () => {
      const result = await evaluate(() => {
        document.querySelector('#search').focus()
        const event = new KeyboardEvent('keydown', {
          key: 'L',
          altKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
        document.activeElement.dispatchEvent(event)
        return {
          prevented: event.defaultPrevented,
          lookups: qa.callbacks.length,
          picker: !!qa.picker()
        }
      })
      assert.deepEqual(result, { prevented: false, lookups: 0, picker: false })
    })
    await test('focus leaves or window loses focus: picker and lookup are cancelled', async () => {
      await open()
      await evaluate(() => document.querySelector('#password').blur())
      assert.equal(await evaluate(() => !!qa.picker()), false)
      await open()
      await evaluate(() => window.dispatchEvent(new Event('blur')))
      await evaluate(() => qa.reply(qa.callbacks.length - 1))
      assert.equal(await evaluate(() => !!qa.picker()), false)
    })
    await test('a desktop choice survives browser blur, fills once, and carries its selection into capture', async () => {
      await evaluate(() => {
        qa.click(document.querySelector('#password'))
        window.dispatchEvent(new Event('blur'))
        qa.callbacks[qa.callbacks.length - 1]({
          ok: true,
          selected: true,
          accounts: [
            {
              id: 12,
              username: 'project-admin',
              password: 'synthetic-project',
              selectionToken: 'synthetic-selection'
            }
          ]
        })
      })
      assert.equal(
        await evaluate(() => document.querySelector('#password').value),
        'synthetic-project'
      )
      assert.equal(await evaluate(() => !!qa.picker()), false)
      await evaluate(() => qa.click(document.querySelector('#submit')))
      const captured = await evaluate(
        () => qa.messages.find((message) => message.type === 'LP_LOGIN_SUBMITTED').payload
      )
      assert.equal(captured.selection_token, 'synthetic-selection')
      assert.equal(captured.project_name, 'Agent Router')
    })
    await test('a desktop choice cannot fill after the user changes the form or navigates', async () => {
      await evaluate(() => {
        qa.click(document.querySelector('#password'))
        const callback = qa.callbacks[qa.callbacks.length - 1]
        window.dispatchEvent(new Event('blur'))
        document.querySelector('#password').remove()
        callback({
          ok: true,
          selected: true,
          accounts: [{ username: 'stale', password: 'synthetic-stale' }]
        })
      })
      assert.notEqual(await evaluate(() => document.querySelector('#username').value), 'stale')
    })
    await test('Jenkins markup captures native form data; real POST/302 navigation reports the new page state', async () => {
      await evaluate(() => {
        document.body.innerHTML =
          '<form method="post" name="login" action="/j_spring_security_check"><input name="j_username" id="j_username" type="text" autocomplete="off"><input name="j_password" id="j_password" type="password"><input name="from" type="hidden" value="/"><button type="submit">Sign in</button></form>'
        document.forms.login.addEventListener('submit', (event) => event.preventDefault())
        document.querySelector('#j_username').value = 'synthetic-jenkins'
        document.querySelector('#j_password').value = 'synthetic-only'
        qa.click(document.querySelector('button'))
      })
      const submitted = await evaluate(
        () => qa.messages.find((m) => m.type === 'LP_LOGIN_SUBMITTED').payload
      )
      assert.equal(submitted.username, 'synthetic-jenkins')
      assert.equal(submitted.password, 'synthetic-only')
      assert.match(submitted.form_action, /\/j_spring_security_check$/)
      const navigation = new Promise((resolve) =>
        window.webContents.once('did-finish-load', resolve)
      )
      await evaluate(() => document.forms.login.submit())
      await navigation
      assert.match(window.webContents.getURL(), /\/native-home$/)
      await evaluate(() => {
        window.qa = { pageStates: [] }
        window.chrome = { runtime: { sendMessage: (message) => qa.pageStates.push(message) } }
      })
      await window.webContents.executeJavaScript(source)
      await pause(750)
      const state = await evaluate(() => qa.pageStates.find((m) => m.type === 'LP_PAGE_STATE'))
      assert.equal(state.hasLoginFields, false)
      assert.equal(state.hasLoginError, false)
      await evaluate(() => {
        document.body.innerHTML =
          '<form><input type="password"></form><div class="error">Invalid username or password</div>'
      })
      await pause(750)
      const failed = await evaluate(() => qa.pageStates.at(-1))
      assert.equal(failed.hasLoginFields, true)
      assert.equal(failed.hasLoginError, true)
    })
    await test('large inline favicons survive capture and normalize to a bounded 32px PNG', async () => {
      const inline = process.env.LOCALPASS_INLINE_ICON_FIXTURE
        ? fs.readFileSync(process.env.LOCALPASS_INLINE_ICON_FIXTURE, 'utf8')
        : await evaluate(() => {
            const canvas = document.createElement('canvas')
            canvas.width = 256
            canvas.height = 192
            const context = canvas.getContext('2d')
            const pixels = context.createImageData(canvas.width, canvas.height)
            let seed = 12345
            for (let index = 0; index < pixels.data.length; index++) {
              seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
              pixels.data[index] = index % 4 === 3 ? 255 : seed >>> 24
            }
            context.putImageData(pixels, 0, 0)
            return canvas.toDataURL('image/png')
          })
      assert.ok(inline.length > 128 * 1024 && inline.length <= 256 * 1024)
      await evaluate((icon) => {
        document.querySelector('link[rel="icon"]').href = icon
        document.querySelector('#username').value = 'demo'
        document.querySelector('#password').value = 'synthetic-only'
        qa.click(document.querySelector('#submit'))
      }, inline)
      const capturedIcon = await evaluate(
        () => qa.messages.find((message) => message.type === 'LP_LOGIN_SUBMITTED').payload.icon_url
      )
      assert.equal(capturedIcon, inline)
      await evaluate(() => {
        chrome.runtime.onMessage = { addListener() {} }
        chrome.runtime.getURL = () => {
          throw new Error('No favicon endpoint')
        }
        chrome.webRequest = {
          onCompleted: { addListener() {} },
          onBeforeRedirect: { addListener() {} }
        }
        chrome.tabs = { get: async () => ({ url: location.href, title: document.title }) }
      })
      const background = fs.readFileSync(
        path.join(__dirname, '../chrome-extension/background.js'),
        'utf8'
      )
      const metadata = await window.webContents.executeJavaScript(
        `(async () => { ${background}\n return await enrichSite(7, { page_url: location.href, icon_url: ${JSON.stringify(inline)} }) })()`
      )
      assert.match(metadata.icon_data, /^data:image\/png;base64,iVBORw0KGgo/)
      assert.ok(metadata.icon_data.length <= 24576)
      assert.equal(metadata.icon_url, undefined)
      assert.ok(JSON.stringify(metadata).length < 64 * 1024)
      const dimensions = await evaluate(async (icon) => {
        const image = new Image()
        image.src = icon
        await image.decode()
        return [image.naturalWidth, image.naturalHeight]
      }, metadata.icon_data)
      assert.deepEqual(dimensions, [32, 32])
    })
    await test('site icon downloads rasterize into a bounded local PNG', async () => {
      fixturePng = Buffer.from(
        await evaluate(() => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 16
          const context = canvas.getContext('2d')
          context.fillStyle = '#6b4ee6'
          context.fillRect(0, 0, 16, 16)
          return canvas.toDataURL('image/png').split(',')[1]
        }),
        'base64'
      )
      await evaluate(() => {
        chrome.runtime.onMessage = { addListener() {} }
        chrome.webRequest = {
          onCompleted: { addListener() {} },
          onBeforeRedirect: { addListener() {} }
        }
      })
      const background = fs.readFileSync(
        path.join(__dirname, '../chrome-extension/background.js'),
        'utf8'
      )
      const result = await window.webContents.executeJavaScript(
        `(async () => { ${background}\n return await loadSiteIcon(location.origin + '/brand.png') })()`
      )
      assert.match(result, /^data:image\/png;base64,iVBORw0KGgo/)
      assert.ok(result.length < 24576)
      const rendered = await evaluate(async (icon) => {
        const image = new Image()
        image.src = icon
        await image.decode()
        return [image.naturalWidth, image.naturalHeight]
      }, result)
      assert.deepEqual(rendered, [32, 32])
    })
    await test('status popup checks connectivity without requesting credentials and explains silent save failures', async () => {
      const popupHtml = fs.readFileSync(
        path.join(__dirname, '../chrome-extension/popup.html'),
        'utf8'
      )
      const popupCss = fs.readFileSync(
        path.join(__dirname, '../chrome-extension/popup.css'),
        'utf8'
      )
      const popupScript = fs.readFileSync(
        path.join(__dirname, '../chrome-extension/popup.js'),
        'utf8'
      )
      const html = popupHtml
        .replace(/<link[^>]+href="popup.css"[^>]*>/, `<style>${popupCss}</style>`)
        .replace('<script src="popup.js"></script>', '')
        .replace(
          'src="icons/icon-32.png"',
          `src="data:image/png;base64,${fs.readFileSync(path.join(__dirname, '../chrome-extension/icons/icon-32.png')).toString('base64')}"`
        )
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      await evaluate(() => {
        window.qaPopup = { connected: true, injected: true, state: 'disconnected', requests: [] }
        window.fetch = async (url) => {
          window.qaPopup.requests.push(String(url))
          if (String(url).includes('/extension-status'))
            return new Response(JSON.stringify({ ok: true, version: '1.3.7' }))
          return new Response(
            JSON.stringify({
              error: window.qaPopup.connected ? 'Identity is required' : 'Vault locked'
            }),
            { status: window.qaPopup.connected ? 400 : 423 }
          )
        }
        window.chrome = {
          runtime: { getManifest: () => ({ version: '1.3.7' }) },
          tabs: {
            query: async () => [{ id: 7, url: 'https://example.invalid/dashboard' }],
            sendMessage: async () => {
              if (!window.qaPopup.injected) throw new Error('No receiver')
              return { ready: true, hasLoginFields: false }
            }
          },
          storage: {
            session: {
              get: async (key) => ({
                [key]: {
                  state: window.qaPopup.state,
                  origin: 'https://example.invalid',
                  at: Date.now()
                }
              })
            }
          }
        }
      })
      await window.webContents.executeJavaScript(popupScript)
      await pause()
      const text = await evaluate(() => ({
        connection: document.querySelector('#connection').textContent,
        page: document.querySelector('#page').textContent,
        capture: document.querySelector('#capture').textContent,
        extension: document.querySelector('#extension-update').textContent,
        requests: window.qaPopup.requests
      }))
      assert.match(text.connection, /已连接，密码库已解锁/)
      assert.match(text.page, /检测脚本已运行/)
      assert.match(text.capture, /无法连接桌面端/)
      assert.match(text.extension, /当前 1.3.7，已与桌面端同步/)
      assert.deepEqual(text.requests, [
        'http://127.0.0.1:35320/lookup',
        'http://127.0.0.1:35320/extension-status?version=1.3.7'
      ])
      await evaluate(() => {
        window.qaPopup.connected = false
        window.qaPopup.injected = false
        window.qaPopup.state = 'submitted'
        document.querySelector('#refresh').click()
      })
      await pause()
      assert.match(
        await evaluate(() => document.querySelector('#connection').textContent),
        /尚未解锁/
      )
      assert.match(
        await evaluate(() => document.querySelector('#page').textContent),
        /检测脚本未响应/
      )
      await evaluate(() => {
        window.qaPopup.connected = true
        window.qaPopup.injected = true
        window.qaPopup.state = 'saved'
        document.querySelector('#refresh').click()
      })
      await pause()
      assert.equal(
        await evaluate(() => document.querySelector('#capture').textContent),
        '账号密码已保存。'
      )
      window.setContentSize(340, 540)
      await pause()
      const screenshotPath = path.join(profile, 'popup-status.png')
      fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG())
      console.log(`Popup screenshot: ${screenshotPath}`)
    })
    console.log(`Extension regression: ${passed} passed`)
  }
  app
    .whenReady()
    .then(run)
    .then(() => app.exit(0))
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
    .finally(() => {
      window?.destroy()
      server?.close()
    })
}
