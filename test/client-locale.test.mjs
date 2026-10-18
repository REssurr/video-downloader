/**
 * The client dictionaries.
 *
 * The value of these tests is that they FAIL when a translation is half-added:
 * a key present in one language and missing from the other is the failure mode
 * a Chinese-first UI actually ships with, and it is invisible until an English
 * user sees a Chinese word in the middle of a sentence.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createTranslator,
  dictionaries,
  MESSAGES,
} from '../lib/test/client/locale.js'

test('every message carries both languages', () => {
  const dicts = dictionaries()
  const keys = Object.keys(MESSAGES)
  assert.ok(keys.length > 10)
  assert.deepEqual(Object.keys(dicts.zh).sort(), keys.sort())
  assert.deepEqual(Object.keys(dicts.en).sort(), keys.sort())
  for (const key of keys) {
    assert.notEqual(dicts.zh[key].trim(), '', `${key} is empty in zh`)
    assert.notEqual(dicts.en[key].trim(), '', `${key} is empty in en`)
    // A placeholder-looking English value is a sign the key was never filled in.
    assert.doesNotMatch(dicts.en[key], /^TODO/, `${key} is still a placeholder`)
  }
})

test('the translator picks the dictionary from the active locale', () => {
  const zh = createTranslator(() => 'zh')
  const en = createTranslator(() => 'en-US')
  const other = createTranslator(() => 'de')
  assert.equal(zh('panel.title'), MESSAGES['panel.title'].zh)
  assert.equal(en('panel.title'), MESSAGES['panel.title'].en)
  // Anything that is not Chinese reads the English dictionary rather than
  // falling into the Chinese one.
  assert.equal(other('panel.title'), MESSAGES['panel.title'].en)
})

test('the translator follows a locale change without being rebuilt', () => {
  let active = 'zh'
  const t = createTranslator(() => active)
  assert.equal(t('panel.more'), MESSAGES['panel.more'].zh)
  active = 'en'
  assert.equal(t('panel.more'), MESSAGES['panel.more'].en)
})

test('the assistant’s keys went with the assistant', () => {
  // Removing the chat panel but leaving its strings would ship a dictionary that
  // describes a UI nobody can reach — and the count check above would happily
  // keep them alive.
  assert.equal(Object.keys(MESSAGES).some(key => key.startsWith('chat.')), false)
})

