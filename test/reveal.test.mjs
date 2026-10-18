/**
 * 「打开本地目录」: which directory a job resolves to, and how each platform opens it.
 *
 * The launch itself is NOT exercised here — a test that opened a file manager window on
 * every run is a test nobody keeps, which is exactly why `revealPath` takes its exec as
 * a parameter. What IS checked is everything that decides what happens.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { revealCommand, revealPath, revealTargetFor } from '../lib/test/reveal.js'

test('a job opens the directory its file is in, and the configured one before that', () => {
  // The requirement, in the user's words: 打开本地目录 has to land directly on the
  // download path — not on a file selected inside it.
  assert.deepEqual(
    revealTargetFor({ outputPath: 'C:\\out\\408455-720p.mp4', downloadDir: 'C:\\out' }),
    { path: 'C:\\out' },
  )
  // The Host's fs adapter mixes separators on Windows, so both are read.
  assert.deepEqual(
    revealTargetFor({ outputPath: 'C:/Users/me/.dsh/video-downloader/downloads/a.mp4', downloadDir: 'C:\\out' }),
    { path: 'C:/Users/me/.dsh/video-downloader/downloads' },
  )
  // A template with a subdirectory in it lands deeper than the configured root, and the
  // subdirectory is what the user is looking for.
  assert.deepEqual(
    revealTargetFor({ outputPath: 'C:\\out\\videos\\a.mp4', downloadDir: 'C:\\out' }),
    { path: 'C:\\out\\videos' },
  )
  // Running, cancelled, failed, or a path with no directory part at all: the configured
  // directory is still the answer to "where is this going".
  assert.deepEqual(revealTargetFor({ outputPath: undefined, downloadDir: 'C:\\out' }), { path: 'C:\\out' })
  assert.deepEqual(revealTargetFor({ outputPath: '   ', downloadDir: 'C:\\out' }), { path: 'C:\\out' })
  assert.deepEqual(revealTargetFor({ outputPath: 'a.mp4', downloadDir: 'C:\\out' }), { path: 'C:\\out' })
})

test('each platform gets its own spelling, from the system directory on Windows', () => {
  const path = 'C:\\Users\\我 的\\视频'
  const windows = revealCommand('win32', path, { WINDIR: 'D:\\Windows' })
  assert.equal(windows.command, 'D:\\Windows\\explorer.exe')
  // No `/select,`, no shell: a directory with spaces in it travels as one argument.
  assert.deepEqual(windows.args, [path])
  // Without a WINDIR (a stripped environment) the conventional root is still used.
  assert.equal(revealCommand('win32', 'C:\\out', {}).command, 'C:\\Windows\\explorer.exe')
  assert.deepEqual(revealCommand('darwin', '/Users/me/Videos'), { command: 'open', args: ['/Users/me/Videos'] })
  assert.deepEqual(revealCommand('linux', '/home/me/videos'), { command: 'xdg-open', args: ['/home/me/videos'] })
})

test('revealPath launches exactly the command it computed', async () => {
  const launched = []
  const command = await revealPath({
    path: 'C:\\out',
    platform: 'win32',
    env: { WINDIR: 'C:\\Windows' },
    exec: async (file, args) => { launched.push([file, [...args]]) },
  })
  assert.deepEqual(launched, [['C:\\Windows\\explorer.exe', ['C:\\out']]])
  assert.deepEqual(command, { command: 'C:\\Windows\\explorer.exe', args: ['C:\\out'] })
})
