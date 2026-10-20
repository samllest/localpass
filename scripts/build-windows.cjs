// Build from a clean, flat production dependency tree, independent of the
// developer's npm/pnpm layout. Never copy user data into the release directory.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const pkg = require('../package.json')
const stage = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'localpass-release-'))
const npmCli =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
function run(command, args, cwd) {
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  // Never borrow another project's machine-wide signing credentials.
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'])
    delete env[key]
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    env
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status}`)
}
function installedPackage(name) {
  let directory = path.dirname(require.resolve(name))
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, 'package.json')
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (manifest.name === name) return { directory, manifest }
    }
    directory = path.dirname(directory)
  }
  throw new Error('Cannot locate installed package: ' + name)
}
run(process.execPath, [npmCli, 'run', 'build:icons'], root)
run(process.execPath, [npmCli, 'run', 'build'], root)
const dependencies = Object.fromEntries(
  Object.keys(pkg.dependencies).map((name) => [name, installedPackage(name).manifest.version])
)
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      main: pkg.main,
      author: pkg.author,
      homepage: pkg.homepage,
      dependencies
    },
    null,
    2
  )
)
for (const directory of ['main', 'preload', 'renderer']) {
  fs.cpSync(path.join(root, 'out', directory), path.join(stage, 'out', directory), {
    recursive: true
  })
}
for (const directory of ['chrome-extension', 'build']) {
  fs.cpSync(path.join(root, directory), path.join(stage, directory), { recursive: true })
}
// The standalone account chooser embeds these fonts outside the renderer bundle.
const fontDirectory = 'src/renderer/src/assets/fonts'
fs.cpSync(path.join(root, fontDirectory), path.join(stage, fontDirectory), { recursive: true })
run(
  process.execPath,
  [
    npmCli,
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--legacy-peer-deps',
    '--no-audit',
    '--no-fund'
  ],
  stage
)
const nativeBinary = path.join(
  path.dirname(require.resolve('better-sqlite3/package.json')),
  'build',
  'Release',
  'better_sqlite3.node'
)
const target = path.join(stage, 'node_modules/better-sqlite3/build/Release')
fs.mkdirSync(target, { recursive: true })
fs.copyFileSync(nativeBinary, path.join(target, 'better_sqlite3.node'))
const cli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js')
const electronVersion = require('electron/package.json').version
run(
  process.execPath,
  [
    cli,
    '--projectDir',
    stage,
    '--config',
    path.join(root, 'electron-builder.yml'),
    '--config.directories.output=' + path.join(root, 'dist/release'),
    '--config.electronVersion=' + electronVersion,
    '--win',
    '--publish',
    'never'
  ],
  root
)
console.log('Release built in dist/release; isolated build directory: ' + stage)
