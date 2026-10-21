import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { packExtension } from '../src/main/extension-updates.js'

const root = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] || resolve(root, 'dist/downloads/site'))
await mkdir(output, { recursive: true })
const bundle = await packExtension(resolve(root, 'chrome-extension'))
const bytes = Buffer.from(JSON.stringify(bundle))
await writeFile(resolve(output, 'extension-update.json'), bytes)
// Keep an existing complete distribution deployable after an extension-only release.
const checksums = resolve(output, 'SHA256SUMS.txt')
try {
  const lines = (await readFile(checksums, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter((line) => !/\s+extension-update\.json$/.test(line))
  lines.push(`${createHash('sha256').update(bytes).digest('hex')}  extension-update.json`)
  await writeFile(checksums, lines.join('\n') + '\n', 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
console.log(`Extension ${bundle.version} update feed: ${output}`)
