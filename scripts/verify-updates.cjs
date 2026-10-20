// Real NSIS updater HTTP/download verification with disposable cache and no installation.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'localpass-update-test-'))
  const env = { ...process.env, LOCALPASS_UPDATE_TEST_PROFILE: profile }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME'])
    delete env[key]
  const result = spawnSync(require('electron'), [__filename], {
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 120000
  })
  fs.rmSync(profile, { recursive: true, force: true })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
} else {
  const { app } = require('electron')
  const profile = process.env.LOCALPASS_UPDATE_TEST_PROFILE
  app.setPath('userData', profile)
  app.commandLine.appendSwitch('in-process-gpu')
  app.disableHardwareAcceleration()
  let server
  app
    .whenReady()
    .then(async () => {
      const { pathToFileURL } = require('node:url')
      const { NsisUpdater } = require('electron-updater')
      const { createUpdateManager } = await import(
        pathToFileURL(path.join(__dirname, '../src/main/updates.js'))
      )
      const version = require('../package.json').version
      const installerName = `localpass-${version}-setup.exe`
      const installerPath = path.join(__dirname, '../dist/release', installerName)
      const metadata = fs.readFileSync(path.join(__dirname, '../dist/release/latest.yml'), 'utf8')
      const corrupt = Buffer.from('deliberately invalid fixture installer')
      const badMetadata = `version: ${version}\nfiles:\n  - url: corrupt.exe\n    sha512: ${Buffer.alloc(64).toString('base64')}\n    size: ${corrupt.length}\npath: corrupt.exe\nsha512: ${Buffer.alloc(64).toString('base64')}\n`
      server = require('node:http').createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname
        if (pathname.endsWith('/latest.yml')) {
          response.end(pathname.startsWith('/bad/') ? badMetadata : metadata)
        } else if (pathname === '/' + installerName) {
          response.setHeader('Content-Length', fs.statSync(installerPath).size)
          fs.createReadStream(installerPath).pipe(response)
        } else if (pathname.endsWith('/corrupt.exe')) {
          response.setHeader('Content-Length', corrupt.length)
          response.end(corrupt)
        } else {
          response.writeHead(404).end()
        }
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const feed = `http://127.0.0.1:${server.address().port}/`
      const config = path.join(profile, 'app-update.yml')
      fs.writeFileSync(
        config,
        'provider: generic\nurl: ' + feed + '\nupdaterCacheDirName: localpass-verification\n'
      )
      function fixture(currentVersion) {
        app.getVersion = () => currentVersion
        const updater = new NsisUpdater()
        updater.logger = null
        updater.forceDevUpdateConfig = true
        updater.updateConfigPath = config
        Object.defineProperty(updater.app, 'baseCachePath', { get: () => profile })
        const states = []
        const manager = createUpdateManager({
          updater,
          version: currentVersion,
          supported: true,
          settingsFile: path.join(profile, 'settings-' + currentVersion + '.json'),
          notify: (state) => states.push(state),
          install: () => {
            throw new Error('Test must never run an installer')
          }
        })
        return { updater, manager, states }
      }
      const latest = fixture(version)
      latest.manager.setServer(feed)
      assert.equal((await latest.manager.check()).status, 'current')
      console.log('PASS actual updater reports same version as current')

      const upgrade = fixture('1.3.0')
      upgrade.manager.setServer(process.env.LOCALPASS_UPDATE_TEST_URL || feed)
      assert.equal((await upgrade.manager.check()).status, 'available')
      assert.equal(upgrade.updater.installerPath, null, 'checking must not download')
      assert.equal((await upgrade.manager.download()).status, 'downloaded')
      assert.ok(upgrade.states.some((state) => state.status === 'downloading'))
      const digest = (file) => createHash('sha512').update(fs.readFileSync(file)).digest('base64')
      assert.equal(digest(upgrade.updater.installerPath), digest(installerPath))
      assert.equal(upgrade.updater.autoInstallOnAppQuit, false)
      console.log(
        'PASS actual updater downloads the full release installer, verifies SHA512 and waits for manual install'
      )

      // Remove the valid cache so the corrupt response is fetched and checked.
      fs.rmSync(path.join(profile, 'localpass-verification'), { recursive: true, force: true })
      const invalid = fixture('1.2.0')
      invalid.manager.setServer(feed + 'bad/')
      assert.equal((await invalid.manager.check()).status, 'available')
      assert.equal((await invalid.manager.download()).status, 'error')
      assert.match(invalid.manager.snapshot().error, /校验失败/)
      assert.equal(invalid.updater.installerPath, null)
      console.log('PASS actual updater rejects a corrupt installer and cannot install it')
      server.close()
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      server?.close()
      app.exit(1)
    })
}
