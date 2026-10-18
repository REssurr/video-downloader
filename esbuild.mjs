/**
 * Build script: three targets, one command.
 *
 *   dist/main.cjs            Electron main + Host (CommonJS: Electron loads it)
 *   dist/renderer/app.js     the panel (browser IIFE, React bundled in)
 *   dist/renderer/index.html the page the window loads
 *   extension/build/*.js     the browser extension (IIFE: content scripts are
 *                            classic scripts, and a service worker needs no modules)
 *
 * The renderer is NOT externalised: there is no platform module table in a plain
 * Electron window, so React travels inside the bundle.
 */
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Shared options: bundling, source maps, and a loud build. */
const SHARED = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'node20',
}

/** The Electron main process: Node, but `electron` comes from the runtime. */
const mainOptions = {
  ...SHARED,
  entryPoints: [join(ROOT, 'src/electron/main.ts')],
  outfile: join(ROOT, 'dist/main.cjs'),
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
}

/** The panel: a browser bundle with React inside. */
const rendererOptions = {
  ...SHARED,
  entryPoints: [join(ROOT, 'src/client/entry.tsx')],
  outfile: join(ROOT, 'dist/renderer/app.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
}

/** The extension's background worker. */
const workerOptions = {
  ...SHARED,
  entryPoints: [join(ROOT, 'extension-src/background.ts')],
  outfile: join(ROOT, 'extension/build/background.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
}

/** The extension's content script. */
const contentOptions = {
  ...SHARED,
  entryPoints: [join(ROOT, 'extension-src/content.ts')],
  outfile: join(ROOT, 'extension/build/content.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
}

/** Build every target once. */
async function run() {
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
  rmSync(join(ROOT, 'extension/build'), { recursive: true, force: true })
  mkdirSync(join(ROOT, 'dist/renderer'), { recursive: true })
  mkdirSync(join(ROOT, 'extension/build'), { recursive: true })
  await Promise.all([build(mainOptions), build(rendererOptions), build(workerOptions), build(contentOptions)])
  copyFileSync(join(ROOT, 'web/index.html'), join(ROOT, 'dist/renderer/index.html'))
  console.log(`[video-downloader] built ${manifest.name} ${manifest.version}`)
}

await run()
