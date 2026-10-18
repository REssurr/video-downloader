/**
 * The panel's client-side dictionaries and translator.
 *
 * The shipped UI is Chinese (the requirement's own language). This app has no
 * platform i18n service to register with — it is one window, not a shell — so the
 * dictionaries are read directly, with the browser's own language choosing
 * between them. Everything the user reads first goes through `t()`; long
 * explanations stay Chinese and are composed at runtime.
 */

/** The keys this app translates. */
export const MESSAGES = {
  'key.label': { zh: '视频下载器（拖入网址）', en: 'Video downloader (drop a URL)' },
  'key.short': { zh: '下载', en: 'Download' },
  'panel.title': { zh: '视频下载器', en: 'Video downloader' },
  'panel.close': { zh: '关闭', en: 'Close' },
  'panel.downloadTo': { zh: '下载到', en: 'Download to' },
  'panel.change': { zh: '更换', en: 'Change' },
  'panel.live': { zh: '● 实时', en: '● live' },
  'panel.polling': { zh: '○ 轮询', en: '○ polling' },
  'panel.jobs': { zh: '任务', en: 'Jobs' },
  'panel.more': { zh: '更多', en: 'More' },
  'panel.less': { zh: '收起', en: 'Less' },
  'panel.cancel': { zh: '取消', en: 'Cancel' },
} as const

/** One translatable key. */
export type MessageKey = keyof typeof MESSAGES

/** A translator bound to one locale namespace. */
export type Translate = (key: MessageKey) => string

/**
 * Build the Chinese and English dictionaries.
 * @returns the two dictionaries, keyed by locale id.
 */
export function dictionaries(): { zh: Record<string, string>; en: Record<string, string> } {
  const zh: Record<string, string> = {}
  const en: Record<string, string> = {}
  for (const [key, value] of Object.entries(MESSAGES)) {
    zh[key] = value.zh
    en[key] = value.en
  }
  return { zh, en }
}

/**
 * Build a translator over one locale snapshot getter.
 *
 * Falls back to the English dictionary and then to the key itself, so a missing
 * translation shows a readable string instead of blank UI.
 * @param readActive - returns the active locale id.
 * @returns the translator.
 */
export function createTranslator(readActive: () => string): Translate {
  const dicts = dictionaries()
  return (key) => {
    const active = readActive()
    const dict = active.startsWith('zh') ? dicts.zh : dicts.en
    return dict[key] ?? MESSAGES[key]?.en ?? key
  }
}

/**
 * The active translator.
 *
 * Defaults to the browser's own language guess so a component rendered before
 * {@link installTranslator} runs still picks a sane dictionary.
 */
let active: Translate = createTranslator(() => (
  typeof navigator === 'undefined' ? 'zh' : (navigator.language ?? 'zh')
))

/**
 * Adopt the browser's language for this session.
 * @returns the translator that is now active.
 */
export function installTranslator(): Translate {
  active = createTranslator(() => (typeof navigator === 'undefined' ? 'zh' : (navigator.language ?? 'zh')))
  return active
}

/**
 * Translate one key through the active dictionary.
 * @param key - the message key.
 * @returns the translated string.
 */
export function t(key: MessageKey): string {
  return active(key)
}
