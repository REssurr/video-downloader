/**
 * What the URL box was given.
 *
 * The panel has one text field, and it has to answer one question about whatever is in
 * it: is this a media FILE, or a PAGE that shows one? The two need different work —
 * a file URL becomes a row immediately (nothing has to be read, and nothing downloads
 * until the user presses the row), while a page address has to be opened in the
 * browser through the extension first, because the page is the only client that can
 * ask the site for its own media. Guessing wrong is not dangerous here (a wrong guess
 * fails with a sentence), but it is annoying, so the rule is stated once, in one pure
 * function, and tested.
 *
 * The old panel had no URL box at all — 抓当前页 was the only entry — and the user asked
 * for it back. It is deliberately NOT a host-side probe: the app cannot fetch a site's
 * media with the browser's session, and the old in-app version that tried could only
 * ever offer what an anonymous request sees.
 */

/** Extensions that name one file. */
const MEDIA_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'ts', 'm4s', 'avi', 'mp3', 'm4a', 'aac'])

/** Extensions that name a LIST of files, which this app cannot download. */
const MANIFEST_EXT = new Set(['m3u8', 'mpd'])

/** A URL that has been read and understood. */
export interface ParsedAddress {
  /** A media file URL, or a page to open. */
  readonly kind: 'media' | 'page'
  /** The absolute, normalized URL. */
  readonly url: string
  /** For a media file: the container the URL claims, without a dot. */
  readonly ext?: string
  /** For a media file: the resolution the URL names, when it names one. */
  readonly height?: number
  /** For a media file: the name its own path asks to be saved as. */
  readonly title?: string
}

/** What the URL box could not use. */
export interface AddressRefusal {
  readonly kind: 'invalid'
  /** One sentence for the panel, saying what to type instead. */
  readonly reason: string
}

/**
 * The file name a URL's own path asks for.
 *
 * Decoded, extension removed, bounded — and unlike `stemFromUrl` on the Host it is
 * NOT filtered for usefulness: this is the fallback name for a URL the user typed on
 * purpose, and dropping it would name the file after nothing at all.
 * @param url - the media URL.
 * @returns the stem, or undefined when the path names nothing.
 */
export function nameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').filter(part => part !== '').at(-1) ?? ''
    const stem = decodeURIComponent(last).replace(/\.[A-Za-z0-9]{1,5}$/, '').trim()
    return stem === '' ? undefined : stem.slice(0, 120)
  } catch {
    return undefined
  }
}

/** The extension a URL's own path ends with, without the dot. */
function extOf(url: string): string | undefined {
  try {
    return /\.([A-Za-z0-9]{1,5})$/.exec(new URL(url).pathname)?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The resolution a URL names in its path, when it names one.
 * @param url - the media URL.
 * @returns the height in pixels, or undefined.
 */
function heightOf(url: string): number | undefined {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return undefined
  }
  const match = /(?:^|[^0-9])(\d{3,4})[pP](?![0-9])/.exec(path)
  const height = match?.[1] === undefined ? undefined : Number(match[1])
  if (height === undefined || !Number.isFinite(height) || height < 100 || height > 4320) return undefined
  return height
}

/**
 * Turn what the user typed into an absolute URL.
 *
 * A bare `example.com/video` is what people type, and requiring the scheme would only
 * produce a "not a URL" message for a perfectly good address. Anything that already
 * carries a scheme is left alone and judged by its protocol afterwards.
 * @param raw - the field's contents.
 * @returns the absolute URL, or undefined when there is nothing to work with.
 */
export function absoluteAddress(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^["'<]+/, '').replace(/["'>]+$/, '').trim()
  if (trimmed === '') return undefined
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.hostname === '') return undefined
  return parsed.href
}

/**
 * Read the URL box.
 * @param raw - what the user typed or pasted.
 * @returns the address, or a refusal that says what to type instead.
 */
export function classifyAddress(raw: string): ParsedAddress | AddressRefusal {
  const url = absoluteAddress(raw)
  if (url === undefined) {
    return { kind: 'invalid', reason: '这不是一个地址：请粘贴视频页链接，或一个以 .mp4 这类后缀结尾的媒体直链' }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { kind: 'invalid', reason: '这不是一个地址' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid', reason: `只支持 http/https 地址，这个以 ${parsed.protocol} 开头` }
  }
  const ext = extOf(url)
  if (ext !== undefined && MANIFEST_EXT.has(ext)) {
    return {
      kind: 'invalid',
      reason: `这是一个播放清单（.${ext}）：它是一串文件的目录，需要合并才能播放，本程序不做合并`,
    }
  }
  if (ext !== undefined && MEDIA_EXT.has(ext)) {
    const height = heightOf(url)
    const title = nameFromUrl(url)
    return {
      kind: 'media',
      url,
      ext,
      ...(height === undefined ? {} : { height }),
      ...(title === undefined ? {} : { title }),
    }
  }
  return { kind: 'page', url }
}
