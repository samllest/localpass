// Rasterize the shared SVG with Electron so every product icon uses one source.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'localpass-icon-render-'))
  const env = { ...process.env, LOCALPASS_ICON_PROFILE: profile }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME'])
    delete env[key]
  const result = spawnSync(require('electron'), [__filename], {
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 60000
  })
  fs.rmSync(profile, { recursive: true, force: true })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', process.env.LOCALPASS_ICON_PROFILE)
  app.commandLine.appendSwitch('in-process-gpu')
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const window = new BrowserWindow({
      width: 1024,
      height: 1024,
      useContentSize: true,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false }
    })
    const svg = fs.readFileSync(path.join(root, 'build/icon.svg')).toString('base64')
    const html = `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}img{display:block;width:100%;height:100%}</style><img src="data:image/svg+xml;base64,${svg}">`
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await window.webContents.executeJavaScript('document.querySelector("img").decode()')
    const image = await window.webContents.capturePage(undefined, { stayHidden: true })
    const png = (size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG()
    fs.writeFileSync(path.join(root, 'build/icon.png'), png(1024))

    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    const header = Buffer.alloc(6 + 16 * sizes.length)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    const images = sizes.map((size, index) => {
      const data = png(size)
      const entry = 6 + 16 * index
      header[entry] = header[entry + 1] = size === 256 ? 0 : size
      header.writeUInt16LE(1, entry + 4)
      header.writeUInt16LE(32, entry + 6)
      header.writeUInt32LE(data.length, entry + 8)
      header.writeUInt32LE(offset, entry + 12)
      offset += data.length
      return data
    })
    fs.writeFileSync(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...images]))

    const chunks = [[128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(
      ([size, type]) => {
        const data = png(size)
        const chunk = Buffer.alloc(8)
        chunk.write(type)
        chunk.writeUInt32BE(data.length + 8, 4)
        return Buffer.concat([chunk, data])
      }
    )
    const icnsHeader = Buffer.alloc(8)
    icnsHeader.write('icns')
    icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
    fs.writeFileSync(path.join(root, 'build/icon.icns'), Buffer.concat([icnsHeader, ...chunks]))

    const extensionIcons = path.join(root, 'chrome-extension/icons')
    fs.mkdirSync(extensionIcons, { recursive: true })
    for (const size of [16, 32, 48, 128])
      fs.writeFileSync(path.join(extensionIcons, `icon-${size}.png`), png(size))
    console.log('Generated desktop PNG/ICO/ICNS and extension icons from build/icon.svg')
    window.destroy()
    app.quit()
  }).catch((error) => {
    console.error(error)
    app.exit(1)
  })
}
