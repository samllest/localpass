/* global qa, chrome */
// Run with `npm run test:extension`. Uses the project's Electron in a hidden,
// isolated window; no installed extension, real website or vault is accessed.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

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
    await test('page load and unrelated mutations never open the picker', async () => {
      await evaluate(() => {
        document.querySelector('#dashboard').innerHTML = '<p>Loaded dashboard</p>'
        document.querySelector('#search').focus()
      })
      await pause(350)
      assert.equal(await evaluate(() => qa.messages.length), 0)
      assert.equal(await evaluate(() => !!qa.picker()), false)
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
