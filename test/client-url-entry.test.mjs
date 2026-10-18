/**
 * The URL box's judgement, tested without a browser.
 *
 * The panel has one text field, and what it does with the contents decides whether a
 * download happens at all: a media file URL becomes a row on the spot, a page address is
 * opened in the sidebar browser and read there, and a manifest is refused with a reason
 * instead of a job that cannot finish. The rule is pure, so it is pinned here — including
 * the cases where the honest answer is 「我不知道」 (a signed URL with no extension is a
 * page, and the page will say what it has).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { absoluteAddress, classifyAddress, nameFromUrl } from '../lib/test/client/url-entry.js'

test('an address does not need a scheme, and quotes are stripped', () => {
  assert.equal(absoluteAddress('example.com/watch'), 'https://example.com/watch')
  assert.equal(absoluteAddress('  https://example.com/watch  '), 'https://example.com/watch')
  assert.equal(absoluteAddress('"https://example.com/a.mp4"'), 'https://example.com/a.mp4')
  assert.equal(absoluteAddress('<https://example.com/a.mp4>'), 'https://example.com/a.mp4')
  // An existing scheme is never rewritten: `http` stays `http`, and a scheme this plugin
  // cannot use is caught by the classifier rather than silently turned into https.
  assert.equal(absoluteAddress('http://example.com/a.mp4'), 'http://example.com/a.mp4')
  assert.equal(absoluteAddress(''), undefined)
  assert.equal(absoluteAddress('   '), undefined)
  assert.equal(absoluteAddress('not a url'), undefined)
})

test('a media file URL becomes a row, with the name its path asks for', () => {
  const verdict = classifyAddress('https://cdn.example.com/videos/408455-720p.mp4')
  assert.equal(verdict.kind, 'media')
  assert.equal(verdict.url, 'https://cdn.example.com/videos/408455-720p.mp4')
  assert.equal(verdict.ext, 'mp4')
  assert.equal(verdict.height, 720)
  assert.equal(verdict.title, '408455-720p')
})

test('the quality is read from the path, never from a signed query', () => {
  // The same trap the harvester documents: `secure=…,1790823632` is full of digits and a
  // resolution read out of it would end up in a file name.
  const verdict = classifyAddress('https://cdn.example.com/v/abc.mp4?secure=abc==,1790823632&uipk=5')
  assert.equal(verdict.kind, 'media')
  assert.equal(verdict.height, undefined)
  assert.equal(verdict.title, 'abc')
})

test('a percent-encoded name is decoded, because it becomes a file name', () => {
  assert.equal(nameFromUrl('https://cdn.example.com/%E8%A7%86%E9%A2%91-1080p.mp4'), '视频-1080p')
  assert.equal(nameFromUrl('https://cdn.example.com/'), undefined)
  assert.equal(nameFromUrl('nonsense'), undefined)
})

test('a manifest is refused with a reason, not started', () => {
  const verdict = classifyAddress('https://cdn.example.com/hls/master.m3u8')
  assert.equal(verdict.kind, 'invalid')
  assert.match(verdict.reason, /清单/)
  assert.match(verdict.reason, /不做合并/)
})

test('what cannot be fetched is refused, and says which way', () => {
  for (const raw of ['blob:https://example.com/1', 'data:video/mp4;base64,AA', 'javascript:alert(1)', 'file:///C:/a.mp4']) {
    const verdict = classifyAddress(raw)
    assert.equal(verdict.kind, 'invalid', raw)
  }
  assert.match(classifyAddress('ftp://example.com/a.mp4').reason, /http/)
  assert.match(classifyAddress('').reason, /粘贴/)
  // An address with no media extension is a PAGE, not a refusal: the page is read, and
  // what it holds is its own answer.
  assert.equal(classifyAddress('example.com/video').kind, 'page')
})

test('a page address is a page, and the box says so by its kind', () => {
  const verdict = classifyAddress('https://www.bilibili.com/video/BV1LvYA6QEGP')
  assert.equal(verdict.kind, 'page')
  assert.equal(verdict.url, 'https://www.bilibili.com/video/BV1LvYA6QEGP')
  // A signed media URL with no extension cannot be told apart from a page, and the
  // honest answer is the page path: the page is where the site's session lives, and a
  // site adapter there is what actually finds the file.
  assert.equal(classifyAddress('https://cdn.example.com/stream/9f8a7b?token=abc').kind, 'page')
  // Other media containers are files too.
  for (const raw of ['https://e.com/a.webm', 'https://e.com/a.mkv', 'https://e.com/a.mp3', 'https://e.com/a.ts']) {
    assert.equal(classifyAddress(raw).kind, 'media', raw)
  }
})
