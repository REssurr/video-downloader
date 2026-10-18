/**
 * 真端到端验收：真 Chrome + 真浏览器扩展 + 真程序 + 真落盘。
 *
 * 前面的测试用的是"假扩展"（脚本扮演扩展走同一套协议），这一支补上唯一缺的证据：
 * 把仓库里的 MV3 扩展真的装进本机 Chrome，让它读一个真实页面、真的把字节取回来，
 * 最后比对落到磁盘上的文件和夹具 mp4 是否逐字节相同。
 *
 * 用法：
 *   node esbuild.test.mjs        # 需要 lib/test/client/guest-harvester.js（复用生产解析逻辑）
 *   node scripts/e2e-extension.mjs            # 默认 headless
 *   node scripts/e2e-extension.mjs --headed   # 看得到浏览器窗口，便于排障
 *
 * 依赖：本机装有 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`，
 * 可用 --chrome 指到别处）。整个过程用临时目录，不碰真实配置与下载目录。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHarvest, pickMediaCandidates } from '../lib/test/client/guest-harvester.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = argumentValue('--chrome') ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HEADED = process.argv.includes('--headed')
const SAMPLE = join(ROOT, 'test', 'fixtures', 'sample.mp4')
const REPORT = []

/** One assertion line: record it, print it, and remember whether anything failed. */
function check(name, ok, detail = '') {
  REPORT.push({ name, ok, detail })
  console.info(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  —— ${detail}`}`)
  return ok
}

/** Read `--flag value` from the command line. */
function argumentValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** POST one JSON API call to the running app. */
async function api(base, method, payload = {}) {
  const response = await fetch(`${base}/video-downloader/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${method} 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
}

/** Poll `probe` until it returns a truthy value or the deadline passes. */
async function until(probe, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** An unused loopback port. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolvePort(port) })
    })
  })
}

/** Kill a process tree on Windows (Chrome and Electron both fork). */
function killTree(pid) {
  if (pid === undefined) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch { /* already gone */ }
}

/** The fixture site: one page with one mp4, served with Range support. */
async function startFixture() {
  const bytes = readFileSync(SAMPLE)
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/page.html') {
      const html = `<!doctype html><meta charset="utf-8"><title>端到端验收页</title>
        <h1>e2e fixture</h1>
        <video id="v" src="/sample.mp4" width="640" height="360" controls></video>`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (url.pathname === '/sample.mp4') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers['range'] ?? '')
      if (range !== null) {
        const start = Number(range[1])
        const end = range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1)
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
          'accept-ranges': 'bytes',
        })
        res.end(bytes.subarray(start, end + 1))
        return
      }
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(bytes.length),
        'accept-ranges': 'bytes',
      })
      createReadStream(SAMPLE).pipe(res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, base: `http://127.0.0.1:${port}` }
}

/** A minimal CDP client over the browser's own WebSocket. */
async function connectCdp(debugPort) {
  const info = await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      return response.ok ? await response.json() : undefined
    } catch { return undefined }
  }, 40_000)
  if (info === undefined) throw new Error('Chrome 的调试端口没有起来')
  const socket = new WebSocket(info.webSocketDebuggerUrl)
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.id !== undefined && pending.has(frame.id)) {
      pending.get(frame.id)(frame)
      pending.delete(frame.id)
    }
  })
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', () => { reject(new Error('CDP 连接失败')) }, { once: true })
  })
  let counter = 0
  return {
    browser: info['Browser'],
    call(method, params = {}) {
      counter += 1
      const id = counter
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolveCall) => pending.set(id, resolveCall))
    },
    close() { socket.close() },
  }
}

/** The whole run. */
async function main() {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`)
  if (!existsSync(SAMPLE)) throw new Error(`找不到夹具视频：${SAMPLE}`)
  if (!existsSync(join(ROOT, 'lib', 'test', 'client', 'guest-harvester.js'))) {
    throw new Error('缺少 lib/test 构建产物：先运行 node esbuild.test.mjs')
  }
  const wanted = createHash('sha256').update(readFileSync(SAMPLE)).digest('hex')
  const sampleBytes = (await stat(SAMPLE)).size

  const stateDir = mkdtempSync(join(tmpdir(), 'vd-e2e-state-'))
  const profile = mkdtempSync(join(tmpdir(), 'vd-e2e-chrome-'))
  const fixture = await startFixture()
  const debugPort = await freePort()
  console.info(`[e2e] fixture=${fixture.base} state=${stateDir}`)

  const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!existsSync(electronExe)) throw new Error('缺少 electron：先运行 pnpm install')
  // ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成 node，把这个变量摘掉。
  const appEnv = { ...process.env, VD_STATE_DIR: stateDir }
  delete appEnv['ELECTRON_RUN_AS_NODE']
  const app = spawn(electronExe, ['.'], { cwd: ROOT, env: appEnv, stdio: 'ignore' })

  let chrome
  let cdp
  try {
    // Identify OUR instance by its config path, not by the first port that answers: the
    // user's own copy may already be running on 47821, and attaching to that would move
    // their download directory instead of this run's throwaway one.
    const sameState = (path) => typeof path === 'string'
      && path.replace(/\\/g, '/').toLowerCase().startsWith(stateDir.replace(/\\/g, '/').toLowerCase())
    // A foreign instance on 47821 would win the extension's port probe and the run would
    // test the USER's program instead of this one; say that plainly instead of failing
    // somewhere confusing later.
    const foreign = await until(async () => {
      for (let port = 47_821; port <= 47_830; port += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/video-downloader/api/state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          if (!response.ok) continue
          const body = await response.json()
          if (body?.ok === true && !sameState(body?.value?.configPath)) return `http://127.0.0.1:${port}`
        } catch { /* nothing there */ }
      }
      return undefined
    }, 1_000, 1_000)
    if (foreign !== undefined) {
      throw new Error(`本机已有另一个实例在运行（${foreign}）；扩展会先连到它。先从托盘退出该实例再跑 e2e。`)
    }
    const base = await until(async () => {
      for (let port = 47_821; port <= 47_830; port += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/video-downloader/api/state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          if (!response.ok) continue
          const body = await response.json()
          if (sameState(body?.value?.configPath)) return `http://127.0.0.1:${port}`
        } catch { /* not this port */ }
      }
      return undefined
    }, 60_000)
    if (base === undefined) throw new Error('程序没有起来（10 个端口都没应答）')
    check('程序启动并应答 API', true, base)

    const chromeArgs = [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      'about:blank',
    ]
    if (!HEADED) chromeArgs.unshift('--headless=new')
    chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' })
    cdp = await connectCdp(debugPort)
    check('Chrome 启动（CDP 可用）', true, cdp.browser)

    const loaded = await cdp.call('Extensions.loadUnpacked', { path: join(ROOT, 'extension') })
    const id = loaded?.result?.id
    check('扩展被真实加载（Extensions.loadUnpacked）', typeof id === 'string' && id !== '', `id=${id}`)

    const pageUrl = `${fixture.base}/page.html`
    await cdp.call('Target.createTarget', { url: pageUrl })

    const connected = await until(async () => {
      const status = await api(base, 'ext.status')
      const state = status?.value
      return state?.connected === true ? state : undefined
    }, 45_000)
    check('扩展连上本程序（WS 握手 + welcome）', connected !== undefined,
      connected === undefined ? '' : `browser=${connected.browser ?? ''}`)

    const tab = await until(async () => {
      const status = await api(base, 'ext.status')
      const reported = status?.value?.tab
      return reported?.url === pageUrl ? reported : undefined
    }, 20_000)
    check('扩展报告了当前标签页', tab !== undefined, tab?.url ?? '')

    const downloads = join(stateDir, 'downloads')
    const configured = await api(base, 'config.set', { downloadDir: downloads })
    check('把下载目录改到临时目录', configured?.ok === true, downloads)

    const harvested = await api(base, 'ext.harvest', { canMerge: true })
    check('ext.harvest 有应答', harvested?.ok === true,
      harvested?.ok === true ? `facts=${JSON.stringify(Object.keys(harvested.value ?? {}).slice(0, 8))}` : JSON.stringify(harvested).slice(0, 300))
    const facts = parseHarvest(harvested?.value)
    const candidates = pickMediaCandidates(facts)
    const mp4 = candidates.find(candidate => /\.mp4([?#]|$)/i.test(candidate.url))
    check('页面里的 mp4 被扩展开采到', mp4 !== undefined, mp4?.url ?? candidates.map(c => c.url).join(' | '))
    if (mp4 === undefined) throw new Error('没抓到 mp4，后续步骤没有意义')

    const registered = await api(base, 'probe.registerGuest', {
      url: pageUrl,
      title: facts.title ?? 'e2e',
      candidates: candidates.map(candidate => ({
        url: candidate.url,
        label: candidate.label,
        ...(candidate.height === undefined ? {} : { height: candidate.height }),
        ...(candidate.mime === undefined ? {} : { mime: candidate.mime }),
      })),
    })
    const record = registered?.value?.record
    check('候选被接受并生成本次探测记录', record !== undefined,
      record === undefined ? JSON.stringify(registered).slice(0, 300) : `${record.entries.length} 个条目`)
    const entry = record?.entries?.[0]
    const option = entry?.options?.[0]
    check('有可下载的条目/清晰度', entry !== undefined && option !== undefined, option?.id ?? '')

    const started = await api(base, 'download.start', {
      url: pageUrl,
      formatId: option?.id,
      entryId: entry?.id,
      carrier: 'guest',
    })
    const jobId = started?.value?.jobId
    check('扩展下载任务已创建', typeof jobId === 'string', jobId ?? JSON.stringify(started).slice(0, 300))

    const finished = await until(async () => {
      const listed = await api(base, 'jobs.list')
      const job = listed?.value?.jobs?.find(candidate => candidate.id === jobId)
      return job !== undefined && ['done', 'failed', 'cancelled', 'skipped'].includes(job.status) ? job : undefined
    }, 90_000, 400)
    check('任务到达终态', finished !== undefined, finished === undefined ? '超时' : `${finished.status} ${finished.error ?? ''}`)
    check('任务状态是 done', finished?.status === 'done', finished?.status ?? '')
    if (finished?.status === 'done' && typeof finished.outputPath === 'string') {
      const info = await stat(finished.outputPath)
      check('落盘文件大小与夹具一致', info.size === sampleBytes, `${info.size} vs ${sampleBytes}`)
      const actual = createHash('sha256').update(readFileSync(finished.outputPath)).digest('hex')
      check('落盘文件逐字节相同', actual === wanted, actual.slice(0, 16))
    }
  } finally {
    try { cdp?.close() } catch { /* ignore */ }
    killTree(chrome?.pid)
    killTree(app.pid)
    fixture.server.close()
    await new Promise((resolve) => setTimeout(resolve, 600))
    // 只有全部通过才删临时目录，失败时留着便于看现场。
    if (REPORT.every(item => item.ok)) {
      try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* ignore */ }
    } else {
      console.info(`[e2e] 失败现场保留：${stateDir}`)
    }
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  const failed = REPORT.filter(item => !item.ok)
  console.info(`\n[e2e] ${REPORT.length - failed.length}/${REPORT.length} 通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error(`[e2e] 中止：${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
})
