/**
 * The muxer: finding ffmpeg, and the one call that uses it.
 *
 * Two things are worth testing here and neither of them needs ffmpeg to exist:
 *
 *   - the SEARCH. "Is there a usable ffmpeg on this machine" decides whether a 1080P row is
 *     offered at all, and an answer that is wrong in either direction is bad in a different
 *     way: a false "no" hides a feature the user has, and a false "yes" offers a row that
 *     fails at the end of a two-file download. So the search is tested through its injected
 *     filesystem and process surface, including the nasty case of an `ffmpeg.exe` that
 *     exists and does not run.
 *   - the ARGV. It is an array, it states the container, and it maps exactly one video and
 *     one audio stream. The spawn itself is injected, so this file never starts a process.
 *
 * The measured reality behind the paths: this machine has ffmpeg at
 * `%APPDATA%\video-downloader\tools\bin\ffmpeg.exe` (9.0.2-essentials), which is why the
 * app's own data directory is searched first; Electron itself ships only Chromium's
 * `ffmpeg.dll` — not a command-line program.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MUXER_RESCAN_MS,
  createMuxerKeeper,
  createMuxRunner,
  muxArgs,
  muxerCandidates,
  muxFailureText,
  resolveMuxer,
} from '../lib/test/mux.js'

/** One merge request with obvious paths. */
function request(overrides = {}) {
  return {
    videoPath: 'C:/out/视频.mp4.part',
    audioPath: 'C:/out/视频.mp4.audio.part',
    outputPath: 'C:/out/视频.mp4.mux.part',
    ...overrides,
  }
}

test('the argv copies one video track and one audio track, and names the container', () => {
  const args = muxArgs(request())
  assert.equal(args[0], '-hide_banner')
  assert.ok(args.includes('-y'), 'an existing .mux.part must not stop a retry')
  // The order matters to ffmpeg: input 0 is the video, input 1 is the audio, and the -map
  // flags below refer to those numbers.
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', 'C:/out/视频.mp4.part'])
  assert.deepEqual(args.slice(args.lastIndexOf('-i'), args.lastIndexOf('-i') + 2), ['-i', 'C:/out/视频.mp4.audio.part'])
  assert.ok(args.indexOf('C:/out/视频.mp4.part') < args.indexOf('C:/out/视频.mp4.audio.part'))
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '1:a:0'])
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'copy'], 'a remux, not a re-encode')
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'mp4'], 'a .part extension says nothing to ffmpeg')
  assert.equal(args.at(-1), 'C:/out/视频.mp4.mux.part', 'the output is the last argument')
})

test('a path is one argument, however it is spelled', () => {
  // The whole reason this is an array: a title from a site can contain anything, and a
  // joined command line would turn `a" & del` into a different command.
  const args = muxArgs(request({ outputPath: 'C:/out/a" & del.b.mp4.mux.part' }))
  assert.equal(args.at(-1), 'C:/out/a" & del.b.mp4.mux.part')
  assert.equal(args.filter(arg => arg.includes('del.b')).length, 1)
})

test('ffmpeg’s failure is its own last line, not the exit status', () => {
  const stderr = [
    'ffmpeg version 9.0.2-essentials',
    '  built with gcc',
    '',
    '[mov,mp4,m4a,3gp,3g2,mj2 @ 000001] moov atom not found',
  ].join('\n')
  assert.equal(muxFailureText(stderr, 'Command failed: exit code 1'), '[mov,mp4,m4a,3gp,3g2,mj2 @ 000001] moov atom not found')
  // Nothing on stderr: the process error is all there is, and it beats an empty message.
  assert.equal(muxFailureText('', 'spawn ENOENT'), 'spawn ENOENT')
  assert.equal(muxFailureText('   \n\n ', 'spawn ENOENT'), 'spawn ENOENT')
  // Neither: say so, rather than showing nothing at all.
  assert.equal(muxFailureText('', ''), 'ffmpeg 没有说明原因')
  // Bounded: a program that prints a novel must not become the job's error line.
  assert.equal(muxFailureText('x'.repeat(5000), '').length, 300)
})

test('the search starts where DSH keeps its tools, then PATH, then the usual places', () => {
  const candidates = muxerCandidates({
    home: 'C:/Users/me/.dsh',
    pathValue: 'C:/Windows;C:/bin;;C:/Windows',
    platform: 'win32',
    localAppData: 'C:/Users/me/AppData/Local',
  })
  // Windows paths come back in Windows form: `path.win32.join` normalizes what it is given,
  // and every consumer here (stat, execFile) wants a real path, not a pretty one.
  assert.equal(candidates[0], 'C:\\Users\\me\\.dsh\\tools\\bin\\ffmpeg.exe', 'the measured location of this machine’s ffmpeg')
  assert.deepEqual(candidates.slice(1, 4), ['C:\\Windows\\ffmpeg.exe', 'C:\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe'])
  assert.ok(candidates.includes('C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe'))
  assert.ok(candidates.includes('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'))
  assert.equal(new Set(candidates).size, candidates.length, 'a repeated PATH entry is one candidate')
  assert.ok(!candidates.includes('ffmpeg.exe'), 'an empty PATH segment is not a directory')
})

test('off Windows the same search asks for a binary with no extension', () => {
  const candidates = muxerCandidates({ home: '/home/me/.dsh', pathValue: '/usr/bin:/usr/local/bin', platform: 'linux' })
  assert.deepEqual(candidates, ['/home/me/.dsh/tools/bin/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'])
})

test('a candidate is only the answer when it exists AND answers -version', async () => {
  const tried = []
  const status = await resolveMuxer({
    candidates: ['C:/missing/ffmpeg.exe', 'C:/broken/ffmpeg.exe', 'C:/good/ffmpeg.exe', 'C:/never/ffmpeg.exe'],
    exists: async path => path !== 'C:/missing/ffmpeg.exe',
    version: async (path) => {
      tried.push(path)
      return path === 'C:/good/ffmpeg.exe' ? 'ffmpeg version 9.0.2-essentials Copyright (c) 2000-2025' : undefined
    },
  })
  assert.equal(status.available, true)
  assert.equal(status.path, 'C:/good/ffmpeg.exe')
  assert.match(status.version, /^ffmpeg version 9\.0\.2/)
  assert.deepEqual(tried, ['C:/broken/ffmpeg.exe', 'C:/good/ffmpeg.exe'], 'nothing after the winner is asked')
})

test('a broken ffmpeg is reported as broken, not as an absent one', async () => {
  // The two answers are different facts and the panel says different things: "you have none"
  // names the fix, "yours does not run" is a different problem.
  const none = await resolveMuxer({ candidates: ['C:/a/ffmpeg.exe'], exists: async () => false, version: async () => 'x' })
  assert.equal(none.available, false)
  assert.equal(none.path, undefined)
  assert.match(none.reason, /没有找到 ffmpeg\.exe/)

  const broken = await resolveMuxer({ candidates: ['C:/a/ffmpeg.exe', 'C:/b/ffmpeg.exe'], exists: async () => true, version: async () => undefined })
  assert.equal(broken.available, false)
  assert.match(broken.reason, /2 个位置里有 ffmpeg\.exe/)
  assert.match(broken.reason, /-version 失败/)
})

test('a probe that throws is a candidate that is not there', async () => {
  const status = await resolveMuxer({
    candidates: ['C:/a/ffmpeg.exe'],
    exists: async () => { throw new Error('EPERM') },
    version: async () => 'ffmpeg version x',
  })
  assert.equal(status.available, false)
  assert.match(status.reason, /没有找到/)
})

test('there is no runner without a program', () => {
  assert.equal(createMuxRunner({ available: false, reason: '没有找到' }), undefined)
  assert.equal(createMuxRunner({ available: true }), undefined, 'available without a path is not usable')
})

test('the runner hands ffmpeg the argv, and turns its exit into a value', async () => {
  const calls = []
  const failing = createMuxRunner(
    { available: true, path: 'C:/tools/bin/ffmpeg.exe', version: 'ffmpeg version 9.0.2-essentials' },
    {
      timeoutMs: 1234,
      spawn: async (program, args, signal) => {
        calls.push({ program, args, signal })
        return { ok: false, stderr: 'Error opening input: No such file or directory\n', message: 'Command failed: exit code 1' }
      },
    },
  )
  assert.equal(failing.path, 'C:/tools/bin/ffmpeg.exe')
  const result = await failing.run(request())
  assert.equal(result.ok, false)
  assert.equal(result.message, 'Error opening input: No such file or directory')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].program, 'C:/tools/bin/ffmpeg.exe')
  assert.deepEqual(calls[0].args, muxArgs(request()))

  // Success is a value too, and it carries no message.
  const working = createMuxRunner(
    { available: true, path: 'C:/tools/bin/ffmpeg.exe' },
    { spawn: async () => ({ ok: true, stderr: '', message: '' }) },
  )
  assert.deepEqual(await working.run(request()), { ok: true })
})

/**
 * The keeper: the answer has to be able to STOP being true.
 *
 * The user checks this by renaming `ffmpeg.exe` while the app is open — "does it notice" is
 * the difference between a feature and a claim — so the cached answer is re-validated on
 * every read, and both directions are pinned here. A clock is injected, so the rescan window
 * is tested rather than waited for.
 */
test('the keeper re-validates a found program, and searches again when it disappears', async () => {
  let searches = 0
  let present = true
  let clock = 1000
  const changes = []
  const runner = { path: 'C:/tools/bin/ffmpeg.exe', run: async () => ({ ok: true }) }
  const keeper = createMuxerKeeper({
    probe: () => {
      searches += 1
      return {
        candidates: ['C:/tools/bin/ffmpeg.exe'],
        exists: async () => true,
        version: async () => (present ? 'ffmpeg version 9.0.2-essentials' : undefined),
      }
    },
    exists: () => present,
    now: () => clock,
    onChange: status => changes.push(status.available),
    runnerFor: () => runner,
  })

  assert.equal((await keeper.status()).available, true)
  assert.equal(keeper.runner(), runner)
  assert.equal(searches, 1)
  assert.deepEqual(changes, [true], 'the first answer is worth saying once')

  // Unchanged: the poll is cheap and does not search again.
  clock += 100
  await keeper.status()
  await keeper.status()
  assert.equal(searches, 1, 'a `stat` per read, not a process per read')

  // The user renames ffmpeg.exe.
  present = false
  clock += 100
  const gone = await keeper.status()
  assert.equal(gone.available, false)
  assert.equal(searches, 2, 'the search runs again the moment the program is gone')
  assert.equal(keeper.runner(), undefined, 'and no runner survives it')
  assert.deepEqual(changes, [true, false])

  // And putting it back is noticed too, so the panel's own sentence ("把 ffmpeg.exe 放到
  // 本程序目录 tools\bin 即可") is true without restarting the app.
  present = true
  clock += MUXER_RESCAN_MS
  assert.equal((await keeper.status()).available, true)
  assert.equal(searches, 3)
  assert.deepEqual(changes, [true, false, true])
})

test('a missing muxer is re-searched on a clock, not on every single read', async () => {
  let searches = 0
  let clock = 1000
  const keeper = createMuxerKeeper({
    probe: () => {
      searches += 1
      return { candidates: ['C:/nope/ffmpeg.exe'], exists: async () => false, version: async () => undefined }
    },
    exists: () => false,
    now: () => clock,
  })

  assert.equal((await keeper.status()).available, false)
  assert.equal(searches, 1)
  // The panel polls state every couple of seconds; searching PATH on every poll to find
  // nothing would be work for no answer.
  clock += MUXER_RESCAN_MS - 1
  await keeper.status()
  assert.equal(searches, 1)
  clock += 2
  await keeper.status()
  assert.equal(searches, 2, 'after the window, ask again')
})

test('a failed search is an answer, not a crash', async () => {
  const keeper = createMuxerKeeper({
    probe: () => ({
      candidates: ['C:/a/ffmpeg.exe'],
      exists: async () => { throw new Error('EPERM') },
      version: async () => { throw new Error('EPERM') },
    }),
    exists: () => false,
  })
  const status = await keeper.status()
  assert.equal(status.available, false)
  assert.match(status.reason, /没有找到/)
  assert.equal(keeper.runner(), undefined)
})
