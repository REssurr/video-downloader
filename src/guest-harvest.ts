/**
 * The Host's half of the in-page harvest: turn what a page found into entries.
 *
 * The client does the DOM work (it is the only half that can see the browser
 * extension's tab) and sends plain candidate URLs. Everything here is the Host's own
 * judgement about them: which URLs it is willing to accept at all, what the file
 * should be called, and what to say about a URL that is not a whole video.
 *
 * Pure and injectable-free, so the wire contract is testable without a browser —
 * which matters, because the whole point of this path is that it runs on a page
 * the Host cannot inspect.
 */
import type { GuestCandidate, VideoEntry } from './shared/types.js'

/** How many candidates one harvest may contribute, however many the page found. */
export const GUEST_CANDIDATE_LIMIT = 24

/** Extensions the Host will name a file with; anything else is a guess, so it is dropped. */
const KNOWN_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'avi', 'ts', 'm4s', 'mp3', 'm4a', 'aac'])

/** The container hinted at by a MIME type, when the client sent one through `ext`. */
const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/mp2t': 'ts',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
}

/** Normalize one extension-ish string (`MP4`, `.mp4`, `video/mp4`) to a bare extension. */
function normalizeExt(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return undefined
  const fromMime = MIME_EXT[trimmed]
  if (fromMime !== undefined) return fromMime
  const bare = trimmed.replace(/^\./, '')
  if (bare === 'm3u8') return 'm3u8'
  return KNOWN_EXT.has(bare) ? bare : undefined
}

/**
 * The extension a URL's own path claims, when it claims one.
 * @param url - the candidate URL.
 * @returns the extension without a dot, or undefined.
 */
export function extHintFromUrl(url: string): string | undefined {
  try {
    const match = /\.([A-Za-z0-9]{1,5})$/.exec(new URL(url).pathname)
    return normalizeExt(match?.[1])
  } catch {
    return undefined
  }
}

/**
 * The extension to name a file with.
 *
 * The URL's own path is the strongest evidence, then the client's hint; a URL
 * with neither is named `mp4`, because that is what the overwhelming majority of
 * them are — and if the bytes turn out to be a playlist the page says so and the
 * job fails with that sentence rather than writing a mis-named file.
 * @param url - the candidate URL.
 * @param hint - the client's own guess.
 * @returns the extension, without a dot.
 */
export function extFor(url: string, hint?: string): string {
  return extHintFromUrl(url) ?? normalizeExt(hint) ?? 'mp4'
}

/**
 * Path segments that name no particular video.
 *
 * A file called `video.mp4` or `master.mp4` is worse than the page's own title: it
 * says nothing and collides with every other video on the site.
 */
const GENERIC_STEMS = new Set([
  'video', 'videos', 'index', 'master', 'media', 'play', 'playlist', 'stream', 'streams',
  'download', 'downloads', 'file', 'source', 'output', 'out', 'hls', 'dash', 'movie', 'default',
])

/**
 * The file name a URL itself asks for, when it asks for one.
 *
 * A direct download URL is normally named after the file it serves. The site this was
 * built for serves `…/408455-720p.mp4`, and that is the name its own page source shows
 * and the name `curl` (or yt-dlp's generic extractor, for that matter) puts on disk —
 * so it is the name the user goes looking for, and the two halves of this program agree
 * with every other tool. A URL that names nothing useful — no path segment, a generic
 * `video.mp4`, or an opaque hash — falls back to the page's title plus the quality.
 * @param url - the media URL.
 * @returns the stem to name the file with, or undefined.
 */
export function stemFromUrl(url: string): string | undefined {
  let name: string
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').filter(part => part !== '').at(-1) ?? '')
  } catch {
    return undefined
  }
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim()
  if (stem.length < 3 || stem.length > 80) return undefined
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(stem)) return undefined
  if (GENERIC_STEMS.has(stem.toLowerCase())) return undefined
  // A pure hash names nothing a person can search for.
  if (/^[0-9a-f]{16,}$/i.test(stem)) return undefined
  return stem
}

/**
 * The resolution a URL names, when it names one.
 *
 * Mirrored from the client's harvester rather than trusted from it: the height is
 * what the file is named after and what a `minHeight` rule is matched against, so
 * the Host reads it out of the URL itself. Only the PATH is inspected — a signed
 * URL's query is full of digits.
 * @param url - the candidate URL.
 * @returns the height in pixels, or undefined.
 */
export function heightFromUrl(url: string): number | undefined {
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
 * Accept the candidates a client sent, dropping anything the Host will not fetch.
 *
 * Only `http(s)` without credentials is accepted: the page fetched these URLs
 * itself, but this record is what `download.start` resolves against, so a
 * `javascript:` or `blob:` value must never reach a carrier. Duplicates are
 * dropped because a page reports the same media from several places (`<video>`,
 * `<source>`, a performance entry) and three identical rows is noise.
 * @param raw - the untrusted payload value.
 * @returns the accepted candidates and how many were dropped.
 */
export function readGuestCandidates(raw: unknown): { candidates: GuestCandidate[]; dropped: number } {
  if (!Array.isArray(raw)) return { candidates: [], dropped: 0 }
  const candidates: GuestCandidate[] = []
  const seen = new Set<string>()
  let dropped = 0

  /**
   * An `http(s)` URL this Host may fetch, normalized; anything else is not one.
   *
   * The fragment is not part of the resource, so it is stripped for the same reason as
   * below: the same file reached twice with two fragments must not become two rows.
   */
  const acceptUrl = (value: string): string | undefined => {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return undefined
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username !== ''
      || parsed.password !== ''
      || value.length > 16_384) {
      return undefined
    }
    parsed.hash = ''
    return parsed.href
  }

  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped += 1
      continue
    }
    const record = entry as Record<string, unknown>
    const value = typeof record['url'] === 'string' ? record['url'].trim() : ''
    const key = acceptUrl(value)
    if (key === undefined) {
      dropped += 1
      continue
    }
    // The candidate that arrived first wins: duplicates are dropped because a page
    // reports the same media from several places (`<video>`, `<source>`, a performance
    // entry) and three identical rows is noise.
    if (seen.has(key)) {
      dropped += 1
      continue
    }
    seen.add(key)
    if (candidates.length >= GUEST_CANDIDATE_LIMIT) {
      dropped += 1
      continue
    }
    const height = typeof record['height'] === 'number' && Number.isFinite(record['height']) && record['height'] > 0
      ? Math.round(record['height'])
      // The client is not the only source of truth: a `<source>` element cannot
      // report a height, so a row whose quality is only in the file name would
      // otherwise reach the picker (and the file name, and any `minHeight` rule)
      // without one.
      : heightFromUrl(key)
    const bytes = typeof record['bytes'] === 'number' && Number.isFinite(record['bytes']) && record['bytes'] > 0
      ? Math.round(record['bytes'])
      : undefined
    const approxBytes = typeof record['approxBytes'] === 'number' && Number.isFinite(record['approxBytes']) && record['approxBytes'] > 0
      ? Math.round(record['approxBytes'])
      : undefined
    const label = typeof record['label'] === 'string' ? record['label'].trim().slice(0, 120) : ''
    const title = typeof record['title'] === 'string' ? record['title'].trim().slice(0, 120) : ''
    const hint = normalizeExt(record['ext'])
    // The audio half of a separated pair. It is accepted on exactly the same terms as the
    // video half, and a URL that fails them simply makes this an ordinary single-file
    // candidate — never a pair with a missing track.
    const audio = typeof record['audioUrl'] === 'string' ? acceptUrl(record['audioUrl'].trim()) : undefined
    candidates.push({
      url: key,
      ...(hint === undefined ? {} : { ext: hint }),
      ...(height === undefined ? {} : { height }),
      ...(bytes === undefined ? {} : { bytes }),
      ...(approxBytes === undefined ? {} : { approxBytes }),
      ...(audio === undefined ? {} : { audioUrl: audio }),
      ...(title === '' ? {} : { title }),
      ...(label === '' ? {} : { label }),
    })
  }
  return { candidates, dropped }
}

/**
 * The id prefix every page-harvested row carries.
 *
 * Exported because the Host has to be able to recognise its OWN earlier guest rows:
 * a second harvest of the same page replaces them rather than stacking a duplicate
 * row (with a duplicate id) underneath them.
 */
export const GUEST_ID_PREFIX = 'guest-'

/** One entry per candidate, so the picker's row is the file the user will get. */
function entryFor(candidate: GuestCandidate, index: number, pageTitle: string | undefined): VideoEntry {
  // A separated pair is not a file YET: its two halves are served as `.m4s` tracks and the
  // download ends up as whatever the muxer writes, which is an mp4. Reading the container
  // out of the URL would name the merged file `…m4s` and label it a fragment — the exact
  // file the user cannot play.
  const paired = candidate.audioUrl !== undefined
  const ext = paired ? 'mp4' : extFor(candidate.url, candidate.ext)
  const id = `${GUEST_ID_PREFIX}${index + 1}`
  // The row's title IS the file name: `download.start` passes it as the title and the
  // engine stems it. The URL's own name wins, because that is the name the site's page
  // source shows and the name every other tool (curl, yt-dlp) puts on disk — the
  // user looks for that exact file. When the URL names nothing useful, the page's own
  // title plus the quality is still far better than the client's diagnostic label,
  // which named a real 1080p download `_source_ · video_mp4.mp4` until this changed.
  const quality = candidate.height === undefined ? ext : `${candidate.height}p`
  const base = pageTitle === undefined || pageTitle.trim() === '' ? '页面媒体' : pageTitle.trim()
  // A name a site adapter read from the site's own API wins: bilibili serves
  // `…/42352905122-1-192.mp4`, whose stem is a content id `stemFromUrl` refuses anyway,
  // and a multi-part video would otherwise write both parts to one name. For a pair the
  // adapter puts the QUALITY in that name too, so the merged 1080P row and the 720P whole
  // file cannot collide on one file name.
  const title = candidate.title ?? stemFromUrl(candidate.url) ?? `${base} · ${quality}`
  return {
    id,
    title,
    url: candidate.url,
    options: [
      {
        id: `${id}-media`,
        title: candidate.label ?? title,
        ext,
        kind: 'muxed',
        source: 'guest',
        directUrl: candidate.url,
        ...(candidate.audioUrl === undefined ? {} : { audioUrl: candidate.audioUrl }),
        ...(candidate.height === undefined ? {} : { height: candidate.height }),
        ...(candidate.bytes === undefined ? {} : { bytes: candidate.bytes }),
        // A pair does not exist yet, so its size is an estimate and is reported as one —
        // this is what the row shows instead of a byte count nobody has seen.
        ...(candidate.approxBytes === undefined ? {} : { approxBytes: candidate.approxBytes }),
      },
    ],
    ...(ext === 'ts' || ext === 'm4s'
      ? { error: '这是流媒体分段文件：它只是整段视频的一小片，单独存下来不能播放' }
      : {}),
  }
}

/**
 * Build the entries one harvest contributes.
 * @param input - the page URL, its title, and the accepted candidates.
 * @returns the entries, plus the sentences the record should carry.
 */
export function guestEntries(input: {
  readonly pageUrl: string
  readonly pageTitle?: string
  readonly candidates: readonly GuestCandidate[]
}): { entries: VideoEntry[]; notes: string[] } {
  const entries = input.candidates.map((candidate, index) => entryFor(candidate, index, input.pageTitle))
  const guessed = input.candidates.filter(candidate => (candidate.ext ?? extHintFromUrl(candidate.url)) === undefined).length
  const notes = [
    `已从扩展页面抓到 ${entries.length} 个媒体地址：这些字节由那个页面自己取回（它已经通过了站点的校验）`,
  ]
  if (guessed > 0) {
    notes.push(`其中 ${guessed} 个地址看不出容器格式，暂按 mp4 命名；若实际是清单/分段文件，任务会说明原因而不是写出错文件`)
  }
  return { entries, notes }
}
