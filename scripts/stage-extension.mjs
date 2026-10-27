import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packExtension, validateExtensionPackage } from '../src/main/extension-updates.js'

// Materialize the public allowlist, including an empty connection configuration.
// Never copy machine-bound configuration or unrelated files from a working tree.
export async function stageExtension(source, destination) {
  const bundle = validateExtensionPackage(await packExtension(source))
  await mkdir(destination, { recursive: false })
  for (const [name, bytes] of bundle.files) {
    const file = resolve(destination, name)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }
  return bundle.version
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: stage-extension.mjs <new-destination-directory>')
  const source = resolve(import.meta.dirname, '../chrome-extension')
  const destination = resolve(process.argv[2])
  const version = await stageExtension(source, destination)
  console.log(`Public extension ${version} staged: ${destination}`)
}
