/**
 * Picker-model tests.
 *
 * The picker makes two decisions without a DOM: which option is preselected for an
 * entry, and which targets a batch is made of. Both used to be driven by the Host's
 * rule decisions; the rules are gone, so what is left is "the Host ranked the options
 * best-first, so take the first one" — which is exactly the kind of assumption that
 * breaks silently when the Host's sort changes, and therefore worth pinning.
 *
 * The fixtures are RECORDED from a live probe rather than invented: an entry carries
 * `options` as the Host serialized them, and a mirror that flattened them crashed the
 * whole overlay at the first probe.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  batchTargets,
  conflictQuestion,
  initialSelection,
  initialSelections,
} from '../lib/test/client/picker-model.js'

/** One option, as the host serializes it. */
const option = (id, height, ext = 'mp4') => ({
  id,
  title: 'v',
  ext,
  directUrl: `https://cdn.test/${id}.${ext}`,
  ...(height === undefined ? {} : { height }),
  kind: 'muxed',
  source: 'html',
})

/** The mp4 entry the live probe produced for a direct media URL. */
const directEntry = { id: 'html-direct', title: 'mov_bbb.mp4', url: 'https://cdn.test/mov_bbb.mp4', options: [option('html-direct', undefined)] }

/** The two-entry page the live probe produced for a page with two players. */
const pageEntries = [
  { id: 'html-0', title: 'HTML Video', url: 'https://cdn.test/a.mp4', options: [option('html-src', undefined)] },
  { id: 'html-1', title: 'HTML Video', url: 'https://cdn.test/b.ogg', options: [option('html-src', 'ogg')] },
]

test('initialSelection takes the option the Host ranked first', () => {
  // The Host sorts best-first when it builds a record, so "first" IS "best" and the
  // panel keeps no second opinion about quality.
  const entry = { id: 'e', title: 't', url: 'u', options: [option('1080', 1080), option('720', 720)] }
  assert.equal(initialSelection(entry), '1080')
})

test('initialSelection answers nothing for an entry with no options', () => {
  // A row the Host refused (a segmented stream, a page-only handle) carries an error
  // instead of options; preselecting anything there would offer a download that
  // cannot happen.
  assert.equal(initialSelection({ id: 'e', title: 't', url: 'u', options: [] }), undefined)
})

test('initialSelections preselects one option per entry, keyed by entry id', () => {
  assert.deepEqual(initialSelections([directEntry]), { 'html-direct': 'html-direct' })
  assert.deepEqual(initialSelections(pageEntries), { 'html-0': 'html-src', 'html-1': 'html-src' })
  assert.deepEqual(initialSelections([]), {})
})

// The four auto-start tests that lived here are GONE with `autoStartTarget`: a URL can
// no longer be dropped or probed at all — 抓当前页 only reads the page and lists what it
// found — so there is no "should it start on its own" question left to answer. What
// replaced them is the single-call-site guard in `client-bundle.test.mjs`: the picker's
// buttons are the only callers of `store.startDownload`.

test('batchTargets is one target per entry, in entry order', () => {
  assert.deepEqual(batchTargets([directEntry, ...pageEntries]), [
    { entryId: 'html-direct', formatId: 'html-direct' },
    { entryId: 'html-0', formatId: 'html-src' },
    { entryId: 'html-1', formatId: 'html-src' },
  ])
})

test('the batch honours the quality the user picked in the picker', () => {
  const entries = [{ id: 'e', title: 't', url: 'u', options: [option('1080', 1080), option('720', 720)] }]
  assert.deepEqual(batchTargets(entries, { e: '720' }), [{ entryId: 'e', formatId: '720' }])
})

test('a stale selection falls back to the best option on the page', () => {
  // The picker holds its selection in component state, and the record under it can be
  // replaced by a re-read of the page (the follower does exactly that when the player
  // swaps its video). A format id that is no longer on the page must never be fetched.
  const entries = [{ id: 'e', title: 't', url: 'u', options: [option('1080', 1080), option('720', 720)] }]
  assert.deepEqual(batchTargets(entries, { e: 'gone' }), [{ entryId: 'e', formatId: '1080' }])
  // No selection at all is the same case.
  assert.deepEqual(batchTargets(entries), [{ entryId: 'e', formatId: '1080' }])
})

test('the batch skips an entry with nothing to fetch', () => {
  const blocked = { id: 'html-0', title: 't', url: 'u', options: [] }
  assert.deepEqual(batchTargets([blocked, ...pageEntries.slice(1)]), [{ entryId: 'html-1', formatId: 'html-src' }])
  assert.deepEqual(batchTargets([]), [])
  // A selection for an entry that cannot be fetched cannot resurrect it either.
  assert.deepEqual(batchTargets([blocked], { 'html-0': 'html-src' }), [])
})

// The prompt for "this file already exists". It carries everything needed to
// choose between 覆盖 and 保留, because those are the only two answers — there is
// no rename escape hatch any more.
const pending = (overrides = {}) => ({
  entryId: 'e1',
  formatId: '720',
  title: '雨爱（司凤版）',
  conflict: {
    path: 'D:\\videos\\雨爱（司凤版）.mp4',
    existingBytes: 40894464,
    incomingHeight: 720,
    ...overrides,
  },
})

test('the conflict question names the file, its size, and both resolutions', () => {
  const question = conflictQuestion([pending({ existingModifiedAt: new Date(2026, 8, 30, 20, 46).getTime() })], 'https://example.com/v')
  assert.equal(question.heading, '1 个文件已存在，要覆盖吗？')
  assert.equal(question.lines.length, 1)
  const line = question.lines[0]
  assert.ok(line.includes('雨爱（司凤版）.mp4'), line)
  assert.ok(line.includes('39.0 MB'), `the size has to be on screen to decide: ${line}`)
  assert.ok(line.includes('09-30 20:46'), `the timestamp identifies which copy this is: ${line}`)
  assert.ok(line.includes('本次 720p'), line)
  assert.equal(question.warning, undefined)
})

test('a same-named file from another link is called out', () => {
  const question = conflictQuestion([pending({ existingUrl: 'https://other.example/thing' })], 'https://example.com/v')
  assert.ok(question.lines[0].includes('同名文件来自另一个链接'), question.lines[0])
  // The same URL is the ordinary case (a re-download) and says nothing extra.
  const same = conflictQuestion([pending({ existingUrl: 'https://example.com/v' })], 'https://example.com/v')
  assert.ok(!same.lines[0].includes('另一个链接'))
})

test('unknown resolutions are reported as unknown, never guessed', () => {
  // One side known: it is named, and the other side says it is unknown rather
  // than silently vanishing — "现有 1080p，本次 ?" is the useful shape.
  const oneSided = conflictQuestion([pending({ incomingHeight: undefined, existingHeight: 1080 })], 'https://example.com/v')
  assert.ok(oneSided.lines[0].includes('现有 1080p'), oneSided.lines[0])
  assert.ok(oneSided.lines[0].includes('本次清晰度未知'), oneSided.lines[0])

  // Neither side known: nothing is claimed at all, which beats inventing a
  // resolution for a file the Host never inspected.
  const neither = conflictQuestion([pending({ incomingHeight: undefined })], 'https://example.com/v')
  assert.ok(!neither.lines[0].includes('清晰度'), neither.lines[0])
})

test('one answer covers a batch, and a shared target file is called out', () => {
  const two = conflictQuestion([pending(), pending({ path: 'D:\\videos\\另一个.mp4' })], 'https://example.com/v')
  assert.equal(two.heading, '2 个文件已存在，要覆盖吗？')
  assert.equal(two.lines.length, 2)
  assert.equal(two.warning, undefined)

  // Two entries whose titles sanitize to the same file would fight over it: with
  // 覆盖 the second transfer destroys the first, which the user must know BEFORE
  // answering, not after.
  const clash = conflictQuestion([pending(), pending()], 'https://example.com/v')
  assert.equal(clash.warning, '注意：这批里有 2 个会写到同一个文件，覆盖后只会留下一份')
})
