// tsc only emits JS/d.ts; n8n loads each node's `file:icon.svg` from the
// compiled folder, so copy every node SVG into dist alongside its .node.js.
import { cp, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.name.endsWith('.svg')) out.push(full)
  }
  return out
}

const svgs = await walk(join(root, 'nodes'))
for (const src of svgs) {
  const dest = src.replace(join(root, 'nodes'), join(root, 'dist', 'nodes'))
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest)
  console.log(`icon → ${dest.replace(root + '/', '')}`)
}
