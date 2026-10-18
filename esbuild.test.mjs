/**
 * Test-artifact build.
 *
 * Node's ESM resolver does not remap a `.js` specifier onto a `.ts` file, and the
 * sources use `.js` specifiers (as ESM-resolved TypeScript requires). Rather than
 * weaken the source style or add a transpiler dependency, this builds a small ESM
 * bundle the tests import.
 *
 * Two groups, two output prefixes:
 *   lib/test/**          the app's own modules (host + renderer)
 *   lib/test/ext/**      the browser extension's page-side adapters (importable in
 *                        node; the content script and the background worker are not,
 *                        and are exercised where they run)
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const OUT = join(ROOT, 'lib/test')
mkdirSync(OUT, { recursive: true })

/** The app's modules a test reaches directly. */
const appEntries = [
  'src/routes.ts',
  'src/config.ts',
  'src/probe/policy.ts',
  'src/download.ts',
  'src/events.ts',
  'src/guest-harvest.ts',
  'src/guest-upload.ts',
  'src/mux.ts',
  'src/reveal.ts',
  'src/net/proxy.ts',
  'src/net/http-fetch.ts',
  'src/net/diagnose.ts',
  'src/host/server.ts',
  'src/host/extension-hub.ts',
  'src/host/ws-frame.ts',
  'src/host/legacy-migration.ts',
  'src/client/picker-model.ts',
  'src/client/format.ts',
  'src/client/carrier.ts',
  'src/client/locale.ts',
  'src/client/url-entry.ts',
  'src/client/dropped-url.ts',
  'src/client/guest-follower.ts',
  'src/client/guest-harvester.ts',
  'src/client/extension-bridge.ts',
  'src/client/page-call.ts',
].map(relative => join(ROOT, relative))

await build({
  entryPoints: appEntries,
  outdir: OUT,
  outbase: join(ROOT, 'src'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
  packages: 'external',
})

/** The extension modules that are pure enough to import in node. */
await build({
  entryPoints: [
    join(ROOT, 'extension-src/adapter/dom.ts'),
    join(ROOT, 'extension-src/adapter/bilibili.ts'),
  ],
  outdir: join(OUT, 'ext'),
  outbase: join(ROOT, 'extension-src'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
  packages: 'external',
})

console.log('[video-downloader] built lib/test/** from src/ and extension-src/')
