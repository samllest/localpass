// Exercise the real NSIS include using a unique disposable product and a tiny GUI stub.
// This never installs over LocalPass, touches its vault, or targets its processes.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const id = randomBytes(5).toString('hex')
const name = 'localpass-upgrade-fixture-' + id
const directory = path.join(root, 'out', name)
const installed = path.join(directory, 'installed')
const payload = path.join(directory, 'payload')
const marker = path.join(directory, 'starts.log')
let uninstaller

async function run(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'inherit' })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Installer process timed out'))
    }, 90000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      code === 0 ? resolve() : reject(new Error('Installer exit: ' + code))
    })
  })
}
const starts = () =>
  fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []
async function waitFor(predicate) {
  const until = Date.now() + 20000
  while (Date.now() < until) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Relaunch marker did not arrive')
}

;(async () => {
  if (process.platform !== 'win32') throw new Error('This verification requires Windows')
  fs.mkdirSync(payload, { recursive: true })
  fs.mkdirSync(path.join(payload, 'resources'), { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      description: 'Disposable installer test',
      author: 'LocalPass',
      main: 'index.js'
    })
  )
  const source = path.join(directory, 'fixture.cs')
  fs.writeFileSync(
    source,
    `using System; using System.IO; using System.Threading; class Fixture { [STAThread] static void Main() { File.AppendAllText(@"${marker.replace(/"/g, '""')}", System.Diagnostics.Process.GetCurrentProcess().Id + Environment.NewLine); Thread.Sleep(Timeout.Infinite); } }`
  )
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  const compiled = spawnSync(
    compiler,
    ['/nologo', '/target:winexe', '/out:' + path.join(payload, name + '.exe'), source],
    { windowsHide: true, stdio: 'inherit' }
  )
  assert.equal(compiled.status, 0)
  // Do not borrow signing credentials from another project.
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'])
    delete process.env[key]
  const { build, Platform, Arch } = require('electron-builder')
  const buildOptions = {
    projectDir: directory,
    prepackaged: payload,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    publish: 'never',
    config: {
      appId: 'com.localpass.fixture.' + id,
      productName: name,
      electronVersion: require('electron/package.json').version,
      directories: {
        output: path.join(directory, 'release'),
        buildResources: path.join(root, 'build')
      },
      win: { executableName: name, signAndEditExecutable: false },
      nsis: {
        include: path.join(root, 'build/installer.nsh'),
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        runAfterFinish: true,
        deleteAppDataOnUninstall: false,
        artifactName: 'fixture-setup.exe'
      }
    }
  }
  let artifacts
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      artifacts = await build(buildOptions)
      break
    } catch (error) {
      if (attempt === 2 || !['UNKNOWN', 'EBUSY', 'EACCES'].includes(error.code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  const installer = artifacts.find((file) => file.endsWith('.exe'))
  assert.ok(installer)
  await run(installer, ['/S', '/D=' + installed])
  uninstaller = path.join(installed, 'Uninstall ' + name + '.exe')
  assert.equal(
    starts().length,
    0,
    'silent fresh installation must not unexpectedly start a previously stopped app'
  )
  const initial = spawn(path.join(installed, name + '.exe'), [], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  })
  initial.unref()
  await waitFor(() => starts().length === 1)
  console.log('PASS isolated fixture is running before reinstall')
  await run(installer, ['/S'])
  await waitFor(() => starts().length === 2)
  assert.notEqual(starts()[0], starts()[1])
  console.log(
    'PASS silent reinstall stops the old process and automatically launches exactly one replacement'
  )
  await run(uninstaller, ['/S'])
  uninstaller = null
  console.log('PASS disposable product uninstalled; real LocalPass was not modified')
})().catch(async (error) => {
  console.error(error)
  if (uninstaller && fs.existsSync(uninstaller)) {
    try {
      await run(uninstaller, ['/S'])
    } catch {
      /* Preserve test artifacts for diagnosis. */
    }
  }
  process.exit(1)
})
