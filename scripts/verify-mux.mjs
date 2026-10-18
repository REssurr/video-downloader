/**
 * 真 ffmpeg 合并验证：把一个夹具视频拆成"纯视频轨"和"纯音频轨"，再用生产代码
 * （`resolveMuxer` + `createMuxRunner`，也就是下载引擎实际调用的那一套）合并回一个 mp4，
 * 最后检查结果里同时有视频流和音频流。
 *
 * 为什么单独一个脚本：合并是唯一"要跑外部程序"的环节，单元测试里注入的是假 muxer；
 * 这个脚本补的正是"本机 ffmpeg 真的能被找到、参数真的能被它接受"这一段证据。
 *
 * 用法：node scripts/verify-mux.mjs   （先 node esbuild.test.mjs；没有 ffmpeg 时打印 SKIP 并退出 0）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveMuxer, createMuxRunner, nodeMuxerProbe } from '../lib/test/mux.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE = join(ROOT, 'test', 'fixtures', 'sample.mp4')
const HOME = process.env['APPDATA'] === undefined ? undefined : join(process.env['APPDATA'], 'video-downloader')

if (!existsSync(SAMPLE)) {
  console.error(`找不到夹具视频：${SAMPLE}`)
  process.exit(2)
}
if (!existsSync(join(ROOT, 'lib', 'test', 'mux.js'))) {
  console.error('缺少 lib/test 构建产物：先运行 node esbuild.test.mjs')
  process.exit(2)
}

const status = await resolveMuxer(nodeMuxerProbe(HOME === undefined ? {} : { home: HOME }))
if (!status.available || status.path === undefined) {
  console.info(`SKIP 没有找到 ffmpeg（${status.reason ?? '原因未知'}）`)
  process.exit(0)
}
console.info(`[mux] ffmpeg: ${status.path}`)
const ffmpeg = status.path
const work = mkdtempSync(join(tmpdir(), 'vd-mux-'))

/** Run ffmpeg synchronously; throws with its stderr attached. */
function run(args) {
  try {
    execFileSync(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    const stderr = String(error?.stderr ?? '')
    throw new Error(`ffmpeg 失败：${stderr.slice(0, 400)}`)
  }
}

try {
  copyFileSync(SAMPLE, join(work, 'in.mp4'))
  run(['-y', '-i', join(work, 'in.mp4'), '-an', '-c:v', 'copy', join(work, 'video.mp4')])
  run(['-y', '-i', join(work, 'in.mp4'), '-vn', '-c:a', 'aac', '-b:a', '96k', join(work, 'audio.m4a')])
  console.info('[mux] 已拆出纯视频轨与纯音频轨')

  const runner = createMuxRunner(status)
  if (runner === undefined) throw new Error('本机 ffmpeg 状态可用，却拿不到 runner')
  const output = join(work, 'merged.part')
  const result = await runner.run({
    videoPath: join(work, 'video.mp4'),
    audioPath: join(work, 'audio.m4a'),
    outputPath: output,
  })
  if (!result.ok) throw new Error(`合并失败：${result.message ?? 'ffmpeg 没有说明原因'}`)
  renameSync(output, join(work, 'merged.mp4'))

  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', join(work, 'merged.mp4')], { windowsHide: true, encoding: 'utf8' })
  const text = String(probe.stderr ?? '')
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.includes('Stream #') || line.includes('Duration:'))
  for (const line of lines) console.info(`[mux] ${line}`)
  const hasVideo = lines.some(line => line.includes('Video:'))
  const hasAudio = lines.some(line => line.includes('Audio:'))
  console.info(`[mux] ${hasVideo && hasAudio ? 'PASS' : 'FAIL'} 合并结果 video=${hasVideo} audio=${hasAudio}`)
  process.exit(hasVideo && hasAudio ? 0 : 1)
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
}
