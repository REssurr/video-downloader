/**
 * Config persistence tests.
 *
 * Every case here is a way a settings file can go wrong in the wild: a corrupt
 * document, a hand-edited field of the wrong type, a value from a version that
 * had more fields than this one. The filesystem is faked, so these run without a
 * disk and without a clock.
 *
 * The rules engine is gone, and `rules` is not merely unread: a document that
 * still carries it must load with NO issue line, because a user's old file is not
 * an error once the feature it configured has been removed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_SCHEMA,
  DEFAULT_FILENAME_TEMPLATE,
  defaultConfig,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from '../lib/test/config.js'

const NOW = 1_700_000_000_000
const FALLBACK_DIR = 'C:/downloads'

/** A fake filesystem that records writes. */
function fakeIo(initial = {}) {
  const files = new Map(Object.entries(initial))
  const writes = []
  return {
    files,
    writes,
    readFile(path) { return files.get(path) },
    writeFileAtomic(path, contents) {
      writes.push({ path, contents })
      files.set(path, contents)
    },
    ensureDir() { /* recorded nothing: callers only need it not to throw */ },
    join(...segments) { return segments.join('/') },
  }
}

test('defaultConfig is a complete, valid document', () => {
  const config = defaultConfig(FALLBACK_DIR)
  assert.equal(config.schema, CONFIG_SCHEMA)
  assert.equal(config.downloadDir, FALLBACK_DIR)
  assert.equal(config.filenameTemplate, DEFAULT_FILENAME_TEMPLATE)
  assert.equal(config.maxConcurrent, 1)
  assert.equal(config.downloadPath, 'auto')
})

test('a missing file yields defaults without issues', () => {
  const io = fakeIo()
  const loaded = loadConfig(io, 'C:/cfg', FALLBACK_DIR, NOW)
  assert.equal(loaded.existed, false)
  assert.deepEqual(loaded.issues, [])
  assert.equal(loaded.config.downloadDir, FALLBACK_DIR)
})

test('corrupt JSON falls back and reports, never throws', () => {
  const io = fakeIo({ 'C:/cfg/config.json': '{ not json' })
  const loaded = loadConfig(io, 'C:/cfg', FALLBACK_DIR, NOW)
  assert.equal(loaded.existed, true)
  assert.equal(loaded.config.downloadDir, FALLBACK_DIR)
  assert.equal(loaded.issues.length, 1)
  assert.ok(loaded.issues[0].includes('JSON'))
})

test('a non-object root falls back and reports', () => {
  const io = fakeIo({ 'C:/cfg/config.json': '[1,2,3]' })
  const loaded = loadConfig(io, 'C:/cfg', FALLBACK_DIR, NOW)
  assert.equal(loaded.config.downloadDir, FALLBACK_DIR)
  assert.ok(loaded.issues.some(issue => issue.includes('根节点')))
})

test('normalizeConfig repairs out-of-range scalars and says so', () => {
  const { config, issues } = normalizeConfig(
    { schema: 0, downloadDir: 'D:/videos', maxConcurrent: 99 },
    FALLBACK_DIR,
    NOW,
  )
  assert.equal(config.schema, CONFIG_SCHEMA)
  assert.equal(config.downloadDir, 'D:/videos')
  assert.equal(config.maxConcurrent, 4, 'clamped to the maximum')
  assert.ok(issues.some(issue => issue.includes('maxConcurrent')))
  assert.ok(issues.some(issue => issue.includes('schema')))
})

test('blank strings fall back to defaults', () => {
  const { config } = normalizeConfig({ downloadDir: '   ', filenameTemplate: '' }, FALLBACK_DIR, NOW)
  assert.equal(config.downloadDir, FALLBACK_DIR)
  assert.equal(config.filenameTemplate, DEFAULT_FILENAME_TEMPLATE)
})

test('downloadPath accepts its three words and repairs anything else', () => {
  for (const value of ['auto', 'page', 'host']) {
    const { config, issues } = normalizeConfig({ downloadPath: value }, FALLBACK_DIR, NOW)
    assert.equal(config.downloadPath, value)
    assert.equal(issues.some(issue => issue.includes('downloadPath')), false, `${value} is a known word`)
  }
  // An unknown word is repaired LOUDLY: "下载到哪" has to have one answer, and
  // silently reading it as auto is how the user's real choice gets ignored.
  const { config, issues } = normalizeConfig({ downloadPath: 'sidebar' }, FALLBACK_DIR, NOW)
  assert.equal(config.downloadPath, 'auto')
  assert.equal(issues.some(issue => issue.includes('downloadPath')), true)
  // A missing field is not a repair either: it is the default.
  assert.equal(normalizeConfig({}, FALLBACK_DIR, NOW).config.downloadPath, 'auto')
})

test('a document from the rules era loads silently, with the field dropped', () => {
  // The feature is gone, so the field is neither validated nor reported: an issue
  // line here would tell the user to fix something that no longer exists.
  const { config, issues } = normalizeConfig(
    { schema: CONFIG_SCHEMA, rules: [{ id: 'r1', host: '*', when: { minHeight: 1080 } }] },
    FALLBACK_DIR,
    NOW,
  )
  assert.deepEqual(issues, [])
  assert.equal('rules' in config, false)
})

test('saveConfig writes atomically and round-trips', () => {
  const io = fakeIo()
  const config = { ...defaultConfig(FALLBACK_DIR), maxConcurrent: 3 }
  saveConfig(io, 'C:/cfg', config)
  assert.equal(io.writes.length, 1)
  assert.equal(io.writes[0].path, 'C:/cfg/config.json')

  const loaded = loadConfig(io, 'C:/cfg', FALLBACK_DIR, NOW)
  assert.deepEqual(loaded.issues, [])
  assert.deepEqual(loaded.config, config)
  assert.equal(loaded.existed, true)
})

test('the proxy field is normalized, and an unusable value is repaired loudly', () => {
  // The default is "decide automatically": the setting the app's browser uses.
  assert.equal(defaultConfig('C:/out').proxy, '')

  const bare = normalizeConfig({ proxy: '127.0.0.1:65532' }, FALLBACK_DIR, NOW)
  assert.equal(bare.config.proxy, 'http://127.0.0.1:65532', 'a bare host:port is read as HTTP')

  const off = normalizeConfig({ proxy: 'OFF' }, FALLBACK_DIR, NOW)
  assert.equal(off.config.proxy, 'off')

  // A silent repair is how a wrong proxy becomes "the plugin is broken".
  const bad = normalizeConfig({ proxy: 'socks5://127.0.0.1:1080' }, FALLBACK_DIR, NOW)
  assert.equal(bad.config.proxy, '')
  assert.equal(bad.issues.some(issue => issue.includes('proxy')), true)

  const wrongType = normalizeConfig({ proxy: 42 }, FALLBACK_DIR, NOW)
  assert.equal(wrongType.config.proxy, '')
  assert.equal(wrongType.issues.some(issue => issue.includes('proxy')), true)
})

test('the mp4-only policy defaults to on, and a non-boolean cannot turn it off', () => {
  assert.equal(defaultConfig('C:/out').mp4Only, true, 'only offering playable mp4s is the default')
  // A missing file (or an older document) gets the default rather than `undefined`,
  // which would read as "off" everywhere the flag is tested.
  assert.equal(normalizeConfig({}, FALLBACK_DIR, NOW).config.mp4Only, true)
  assert.equal(normalizeConfig({ mp4Only: false }, FALLBACK_DIR, NOW).config.mp4Only, false)
  assert.equal(normalizeConfig({ mp4Only: true }, FALLBACK_DIR, NOW).config.mp4Only, true)

  // The trap this guards: `"false"` is truthy in JavaScript, so a hand-edited file
  // must not be able to switch the filter ON while saying false — nor OFF by a
  // string the code would read as truthy.
  for (const value of ['false', 'true', 0, 1, null, {}]) {
    const repaired = normalizeConfig({ mp4Only: value }, FALLBACK_DIR, NOW)
    assert.equal(repaired.config.mp4Only, true, `${JSON.stringify(value)} must not be trusted`)
    assert.equal(repaired.issues.some(issue => issue.includes('mp4Only')), true, `${JSON.stringify(value)} must be reported`)
  }
})

test('the media policy survives a save/load round trip', () => {
  const io = fakeIo()
  const config = { ...defaultConfig(FALLBACK_DIR), mp4Only: false }
  saveConfig(io, 'C:/cfg', config)
  const loaded = loadConfig(io, 'C:/cfg', FALLBACK_DIR, NOW)
  assert.equal(loaded.config.mp4Only, false)
  assert.deepEqual(loaded.issues, [])
})
