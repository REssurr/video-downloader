/**
 * Drag-and-drop reading.
 *
 * The download key has always SAID 「拖入网址」, and until now nothing listened: the label
 * was a promise the code did not keep. This is the module that keeps it, and every case
 * here is a shape a real drag actually has:
 *
 *   - a link dragged out of Chrome/Safari/Firefox (all three flavours at once);
 *   - the address bar (uri-list only);
 *   - a selection of prose that happens to contain a URL;
 *   - `&amp;` in a query string, which every hand-written `text/html` fragment carries.
 *
 * The value is passed through VERBATIM — `classifyAddress` owns the one opinion about what
 * an address is — so these tests assert exactly that, not a normalised form.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dropPayloadOf,
  hasUrlPayload,
  urlFromDrop,
  urlFromTransfer,
} from '../lib/test/client/dropped-url.js'

/** A `DataTransfer` double over a plain map of flavours. */
function transfer(data) {
  return {
    types: Object.keys(data),
    getData: (format) => data[format] ?? '',
  }
}

test('hovering is judged from the declared types, and only the text ones count', () => {
  // `dragover` cannot read the data (that would let a page see the drag before the drop),
  // so the decision to accept the drag is made from `types` alone.
  assert.equal(hasUrlPayload(transfer({ 'text/uri-list': 'https://a.test/1' })), true)
  assert.equal(hasUrlPayload(transfer({ 'text/plain': 'https://a.test/1' })), true)
  assert.equal(hasUrlPayload(transfer({ 'text/uri-list': '', 'text/plain': '' })), true, 'empty values still declare the type')
  // An image, a file, or an editor's rich selection is not an address: accepting it would
  // open the panel and read nothing.
  assert.equal(hasUrlPayload(transfer({ 'text/html': '<a href="https://a.test/1">x</a>' })), false)
  assert.equal(hasUrlPayload(transfer({ Files: '' })), false)
  assert.equal(hasUrlPayload({ types: [] }), false)
  assert.equal(hasUrlPayload(undefined), false)
  assert.equal(hasUrlPayload(null), false)
})

test('a dropped link wins with its uri-list, whatever else the drag also carried', () => {
  // This is what a link dragged out of a browser actually looks like: all three flavours,
  // and the HTML one is noisy enough to contain the wrong href first.
  const payload = transfer({
    'text/uri-list': 'https://www.bilibili.com/video/BV1LvYA6QEGP\r\n',
    'text/plain': 'https://www.bilibili.com/video/BV1LvYA6QEGP',
    'text/html': '<a href="https://www.bilibili.com/tracking?utm=x">【视频】…</a><a href="https://www.bilibili.com/video/BV1LvYA6QEGP">真链接</a>',
  })
  assert.equal(urlFromTransfer(payload), 'https://www.bilibili.com/video/BV1LvYA6QEGP')
})

test('a uri-list is read line by line, skipping blank lines and # comments', () => {
  // The format is a list, and Chromium writes comments into it; a naive `split('\n')[0]`
  // would hand the caller a comment or an empty string.
  const payload = { uriList: '# dragged from the address bar\r\n\r\nhttps://cdn.example.com/a.mp4\r\nhttps://cdn.example.com/b.mp4' }
  assert.equal(urlFromDrop(payload), 'https://cdn.example.com/a.mp4')
})

test('a hostile drag is answered with nothing, never with a throw', () => {
  // Synthetic events (and some site scripts) can make `getData` throw. A throw inside the
  // drop handler would abort the plugin's own render.
  const throwing = {
    types: ['text/uri-list'],
    getData() { throw new Error('SecurityError: the drag has no data') },
  }
  assert.deepEqual(dropPayloadOf(throwing), {})
  assert.equal(urlFromTransfer(throwing), undefined)
  // A value that is not a string is the same case as an absent one.
  assert.deepEqual(dropPayloadOf({ types: ['text/plain'], getData: () => undefined }), {})
  assert.deepEqual(dropPayloadOf({ types: ['text/plain'], getData: () => '   ' }), {})
  assert.deepEqual(dropPayloadOf(undefined), {})
})

test('plain text contributes its FIRST line, not the whole selection', () => {
  // Dropping a paragraph that happens to contain a link must send the link, or fail
  // cleanly — never the prose plus the link glued together.
  assert.equal(urlFromDrop({ text: '看这个\nhttps://cdn.example.com/a.mp4\n谢谢' }), '看这个')
  assert.equal(urlFromDrop({ text: '\n\n  https://cdn.example.com/a.mp4  \n' }), 'https://cdn.example.com/a.mp4')
  // Nothing usable in any flavour.
  assert.equal(urlFromDrop({ text: '\n\n', html: '' }), undefined)
  assert.equal(urlFromDrop({}), undefined)
})

test('HTML is the last resort, and its href has &amp; decoded', () => {
  // A hand-written `text/html` fragment is the only flavour some editors export, and the
  // query separator arrives escaped — leaving `&amp;` in the address reads as a parameter
  // named `amp;secure`.
  const html = '<a href="https://cdn.example.com/a.mp4?secure=abc&amp;t=17">播放</a>'
  assert.equal(urlFromDrop({ html }), 'https://cdn.example.com/a.mp4?secure=abc&t=17')
  // Single quotes, and attribute order that puts href second.
  assert.equal(urlFromDrop({ html: "<a class='x' href='https://a.test/2?b=1&amp;c=2'>x</a>" }), 'https://a.test/2?b=1&c=2')
  // An href that decodes to nothing is not an address; a junk one is left for
  // `classifyAddress` to refuse, which is the only place that decides what an address is.
  assert.equal(urlFromDrop({ html: '<a href="">x</a>' }), undefined)
  assert.equal(urlFromDrop({ html: '<a href="   ">x</a>' }), undefined)
  assert.equal(urlFromDrop({ html: '<p>no link here</p>' }), undefined)
})

test('the address is passed through verbatim, for classifyAddress to judge', () => {
  // A SECOND opinion here (adding a scheme, rejecting a manifest, trimming a trailing
  // slash) is how the drop path and the typing path would start behaving differently.
  const raw = '  www.bilibili.com/video/BV1LvYA6QEGP//  '
  assert.equal(urlFromTransfer(transfer({ 'text/plain': raw })), raw.trim(), 'trimmed at the edges, nothing more')
  const manifest = 'https://cdn.example.com/hls/master.m3u8'
  assert.equal(urlFromTransfer(transfer({ 'text/uri-list': manifest })), manifest)
})
