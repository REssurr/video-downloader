/**
 * Local acceptance fixture: a page with a video on it, and the video itself.
 *
 * Serves `test/fixtures/` on 127.0.0.1:5399 so the whole download path can be
 * checked without touching the public internet: paste
 * `http://127.0.0.1:5399/sample.mp4` into the app, or open
 * `http://127.0.0.1:5399/page.html` in the browser the extension watches.
 */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'test/fixtures')
const PORT = Number(process.env['FIXTURE_PORT'] ?? '5399')

/** Content types for the two kinds of file this serves. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const name = url.pathname === '/' ? 'page.html' : url.pathname.slice(1)
  // Refuse anything that would climb out of the fixture directory.
  const target = normalize(join(FIXTURES, name))
  if (!target.startsWith(FIXTURES)) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }
  let size
  try {
    size = statSync(target).size
  } catch {
    res.statusCode = 404
    res.end('not found')
    return
  }
  const type = TYPES[extname(target)] ?? 'application/octet-stream'
  const body = readFileSync(target)
  // Range support on purpose: a real media fetch uses it, and so does the
  // extension's byte transfer.
  const range = req.headers.range
  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match !== null) {
      const start = match[1] === '' ? 0 : Number(match[1])
      const end = match[2] === '' ? body.length - 1 : Math.min(Number(match[2]), body.length - 1)
      res.statusCode = 206
      res.setHeader('content-type', type)
      res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
      res.setHeader('accept-ranges', 'bytes')
      res.end(body.subarray(start, end + 1))
      return
    }
  }
  res.statusCode = 200
  res.setHeader('content-type', type)
  res.setHeader('content-length', String(size))
  res.setHeader('accept-ranges', 'bytes')
  res.end(body)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fixture ready: http://127.0.0.1:${PORT}/`)
  console.log(`  page:  http://127.0.0.1:${PORT}/page.html`)
  console.log(`  media: http://127.0.0.1:${PORT}/sample.mp4`)
})
