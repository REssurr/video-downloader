/**
 * Deciding what the page's media URLs mean.
 *
 * Collecting the facts has MOVED out of this app: the browser extension's content
 * script reads the page (`extension-src/adapter/dom.ts`) and its background worker
 * asks the site adapter for a whole file (`extension-src/adapter/bilibili.ts`).
 * Nothing is injected from here any more, so there is no script string to keep in
 * step — this module is the half that runs in the app, over what came back:
 *
 *   - {@link parseHarvest} treats the answer as untrusted: it crossed a process
 *     boundary, so a page may have defined `Object.prototype.src` or returned
 *     something that is not the object we asked for.
 *   - {@link pickMediaCandidates} is a pure function over what came back. It ranks
 *     the evidence, drops what cannot be fetched (a `blob:` MSE handle is not a
 *     file), and says where each URL came from — so the row the user clicks is a
 *     row that can actually be downloaded.
 *
 * A page's own player is still the best source of truth: if the video in the page
 * is playing, the URL the element reports is one the site is willing to serve to
 * this browser — which is exactly the property the Host's own client lacks.
 */

/** What the extension reports for one page (see `extension-src/adapter/dom.ts`). */
export interface HarvestedPage {
  readonly url?: string
  readonly title?: string
  readonly videos?: readonly { readonly src?: string; readonly duration?: number; readonly width?: number; readonly height?: number }[]
  readonly sources?: readonly { readonly src?: string; readonly type?: string; readonly height?: number }[]
  readonly links?: readonly { readonly href?: string; readonly text?: string }[]
  readonly og?: readonly { readonly url?: string; readonly type?: string }[]
  readonly perf?: readonly { readonly name?: string; readonly initiatorType?: string }[]
  readonly jsonLd?: readonly string[]
  /**
   * What a site-specific adapter answered for this page.
   *
   * Some players publish no whole file at all: they play through Media Source
   * Extensions and fetch separate DASH tracks, so the DOM and the resource-timing
   * buffer describe a video that cannot be saved as one file (this is bilibili, and
   * the user reported exactly it). Those sites do offer a whole file — through their
   * own player API, which only the page itself may call, because the answer depends on
   * the session the page carries. So the adapter asks, INSIDE the page, and reports
   * what came back.
   */
  readonly site?: {
    /** Which adapter answered (`bilibili`). */
    readonly name?: string
    /** The video's own title, when the adapter read one. */
    readonly title?: string
    /** What the adapter did, in the page's own words. */
    readonly notes?: readonly string[]
    /** What the adapter could not offer, and why — shown in 诊断. */
    readonly refused?: readonly string[]
    /** Whole files the adapter found — and pairs of separated tracks it can hand over. */
    readonly candidates?: readonly {
      readonly url?: string
      readonly ext?: string
      readonly height?: number
      readonly bytes?: number
      /**
       * The audio track that belongs with `url`, when this is a separated pair.
       *
       * Present only from an adapter, and only when the Host said it has a muxer: the two
       * files are downloaded and merged into one mp4. Absent means a single whole file.
       */
      readonly audioUrl?: string
      /** Byte size when the pair has never existed yet and can only be estimated. */
      readonly approxBytes?: number
      readonly label?: string
      /** The name this row should be saved as, when the URL names nothing. */
      readonly title?: string
    }[]
    /**
     * What the page's own session is, when a site adapter could ask.
     *
     * `login: false` is a FACT (the site answered "nobody is signed in here"); an
     * ABSENT session means the question could not be asked at all. The panel must not
     * treat those as the same thing, which is why this is optional field by field.
     */
    readonly session?: {
      readonly login?: boolean
      readonly vip?: boolean
      /** The site's own words for the membership, e.g. 年度大会员. */
      readonly label?: string
    }
    /**
     * The qualities the site itself listed, and the one it actually served.
     *
     * This is what lets the panel answer "why only 720P" with the site's own numbers
     * rather than a story: `listed` is the ladder the site published for this video
     * (best first, its own words), `granted` is the rung the whole-file channel handed
     * over. Only a site adapter can fill these in.
     */
    readonly quality?: {
      readonly granted?: number
      readonly grantedText?: string
      readonly listed?: readonly { readonly quality?: number; readonly text?: string }[]
    }
  }
}

/** One URL worth offering, with the evidence that produced it. */
export interface MediaCandidate {
  /** The absolute media URL. */
  readonly url: string
  /** Container extension guess, without a dot. */
  readonly ext?: string
  /** Vertical resolution, when the element that carried the URL knew it. */
  readonly height?: number
  /** Byte size, when the page could read it (a site API usually reports it). */
  readonly bytes?: number
  /**
   * The audio track that belongs with {@link url}, when the two are served apart.
   *
   * A row carrying this is a pair, not a file: the Host fetches both URLs and merges them.
   * It is also what tells the carriers to keep the job on the Host — a page carrier would
   * save the video track alone, which is a silent film.
   */
  readonly audioUrl?: string
  /** Byte size when the pair did not exist yet and the page could only estimate it. */
  readonly approxBytes?: number
  /**
   * The name this file should be saved as.
   *
   * Only a site adapter sets one, and only when the URL itself names nothing useful:
   * bilibili serves `…/42352905122-1-192.mp4`, whose stem is a content id, and a
   * multi-part video would otherwise give every part the same file name.
   */
  readonly title?: string
  /** Where it was found; becomes the row's title. */
  readonly label: string
}

/** How many candidates one harvest reports, strongest evidence first. */
export const CANDIDATE_LIMIT = 12

/** Initiation types that mean "the page's own player requested this". */
const STREAM_INITIATOR = /^(xmlhttprequest|fetch|video|audio|other)$/i

/**
 * What one harvest saw, in numbers — including what it refused.
 *
 * This exists because "no rows appeared" is the least actionable thing a panel can
 * say. An MSE player reports a `blob:` handle as its source and streams the real
 * media over `fetch`, an HLS player requests hundreds of `.ts` fragments that are
 * not files, and a page can simply have no media at all — three situations that
 * look identical on screen and need three different answers. Reporting the evidence
 * turns the next message into a fact instead of a guess.
 */
export interface HarvestReport {
  /** How many candidates became rows. */
  readonly candidates: number
  /** What each evidence source contributed, before filtering. */
  readonly evidence: {
    readonly videos: number
    readonly sources: number
    readonly og: number
    readonly links: number
    readonly perf: number
    readonly jsonLd: number
  }
  /** Players using Media Source Extensions: their real stream is elsewhere. */
  readonly mediaSourceVideos: number
  /** Media URLs that were NOT offered, and why. */
  readonly refused: readonly { readonly url: string; readonly why: string }[]
  /** What a site adapter did on this page, when one ran. */
  readonly site?: { readonly name: string; readonly notes: readonly string[] }
  /**
   * The quality ladder this page showed, when it is worth saying out loud.
   *
   * This fires in the two situations a person cannot otherwise explain from the panel:
   *
   *   - the page offers SEVERAL qualities and not one of them can be fetched as a whole
   *     file (the report is the answer to "why is the list empty", and it says so above
   *     the 诊断 drawer rather than only inside it);
   *   - the page offers a row while the site's own quality list goes higher (the answer
   *     to "why only 720P").
   *
   * Absent when there is nothing to add: a quality nobody reported is never guessed at,
   * and a page with one quality and a downloadable row is not worth a sentence.
   */
  readonly quality?: {
    /** The qualities that were seen, best first — the site's own words where it has any. */
    readonly rungs: readonly string[]
    /** What the rows on offer actually are, in the same vocabulary. */
    readonly got?: string
    /** Why that is all there is, for 诊断. */
    readonly why: string
    /** One line for the panel, so the answer is visible without opening 诊断. */
    readonly hint: string
  }
}

/** A URL shortened for display, keeping the host and the tail. */
function shorten(url: string): string {
  if (url.length <= 96) return url
  return `${url.slice(0, 60)}…${url.slice(-32)}`
}

/** The human tail of a row label: `bilibili 合并 · 1080P 高清` → `1080P 高清`. */
function labelTail(label: string): string {
  const at = label.lastIndexOf(' · ')
  return at < 0 ? label : label.slice(at + 3)
}

/**
 * What the panel knows about merging when it explains a ladder.
 *
 * A sentence about separated streams can only be true or false if it knows whether this
 * machine can put them back together, and that answer lives in the Host — so it is passed
 * in rather than guessed at.
 */
export interface QualityLadderOptions {
  /** Whether the Host found a muxer, so a 视频轨 + 音轨 pair is downloadable. */
  readonly canMerge?: boolean
}

/**
 * What the page said about its own qualities, when that is worth a sentence.
 *
 * Every input here was already collected for other reasons — the element heights, the
 * resource-timing URLs, the site adapter's own quality list — so detecting a ladder
 * costs no request and cannot slow a harvest down. That is the whole design constraint:
 * "this site has 720p and 1080p" must be answerable from evidence already in hand.
 * @param page - the raw harvest.
 * @param candidates - the rows that survived {@link pickMediaCandidates}.
 * @param options - what the Host can do about separated streams.
 * @returns the ladder report, or undefined when there is nothing to say.
 */
function qualityLadder(
  page: HarvestedPage,
  candidates: readonly MediaCandidate[],
  options: QualityLadderOptions = {},
): HarvestReport['quality'] {
  const rungs: string[] = []
  const seen = new Set<string>()
  const add = (text: string | undefined): void => {
    const value = (text ?? '').trim()
    if (value === '' || seen.has(value) || rungs.length >= 6) return
    seen.add(value)
    rungs.push(value)
  }
  const addUrl = (url: string | undefined): void => {
    if (url === undefined) return
    const height = heightFromUrl(url)
    if (height !== undefined) add(`${height}p`)
  }

  // The site's own list FIRST: it is the site's vocabulary, and on a site with an
  // adapter it is the only place a quality nobody published in a URL can come from.
  const listed = page.site?.quality?.listed ?? []
  for (const entry of listed) add(entry.text)
  for (const video of page.videos ?? []) {
    if (video.height !== undefined) add(`${video.height}p`)
    addUrl(video.src)
  }
  for (const source of page.sources ?? []) addUrl(source.src)

  // A manifest and a fragment are not qualities, but they ARE the shape of a stream
  // that has several of them — which is the case that needs explaining most.
  let manifest = false
  let fragments = 0
  const shapeOf = (url: string | undefined): void => {
    const ext = url === undefined ? undefined : extOf(url)
    if (ext === 'm3u8' || ext === 'mpd') manifest = true
    if (ext === 'm4s' || ext === 'ts') fragments += 1
    addUrl(url)
  }
  for (const entry of page.perf ?? []) shapeOf(entry.name)
  for (const link of page.links ?? []) shapeOf(link.href)
  for (const candidate of candidates) {
    if (candidate.height !== undefined) add(`${candidate.height}p`)
    else addUrl(candidate.url)
  }

  const best = candidates[0]
  const got = page.site?.quality?.grantedText
    ?? (best === undefined ? undefined : (best.height === undefined ? '整份文件' : `${best.height}p`))
  const granted = page.site?.quality?.granted ?? 0
  const topListed = listed.reduce((highest, entry) => Math.max(highest, entry.quality ?? 0), 0)
  const tallerExists = listed.length > 0 && granted > 0 && topListed > granted
  const list = rungs.join(' / ')
  const tail = '可以在上面的网址框粘贴 .mp4 直链，或用站点自己的下载入口。'

  if (candidates.length > 0) {
    // A pair on offer is a row the user can download, so "本程序不合并" stops being true the
    // moment one exists. Whether the site's TOP rung is among those pairs is the other half
    // of the answer: promising the merge for 2160P while the row is 1080P would be exactly
    // the kind of invented claim this sentence exists to prevent.
    const paired = candidates.filter(candidate => candidate.audioUrl !== undefined)
    const top = listed.find(entry => (entry.quality ?? 0) === topListed)
    const topText = (top?.text ?? '').trim() === '' ? `${topListed}p` : (top?.text ?? '')
    const pairedBest = paired.length === 0 || paired[0] === undefined ? '' : labelTail(paired[0].label)
    const merged = paired.some(candidate => candidate.label.includes(topText))

    if (!tallerExists) {
      // No whole file at all, but a pair below the site's ceiling: the low row still needs
      // its explanation, and only an adapter can supply both halves of it. A site that
      // published no ladder at all gets a sentence that does not invent one ("站点列出 0p"
      // would be the exact kind of made-up rung this function exists to avoid).
      if (granted <= 0 && paired.length > 0) {
        const published = topListed > 0
        return {
          rungs,
          why: published
            ? `站点列出的最高档是 ${topText}，整份文件这一路什么都没给；分离流这里最高合并到 ${pairedBest}。`
            : `站点没有公布档位，整份文件这一路什么都没给；分离流这里最高合并到 ${pairedBest}。`,
          hint: published
            ? `站点列出 ${topText}，这里能合并下载到的最高档是 ${pairedBest}（更高的档要给站点账号/VIP 才会给）。`
            : `这里能合并下载到的最高档是 ${pairedBest}（这个页面没有可整份下载的文件）。`,
        }
      }
      return undefined
    }
    const why = `站点列出的最高档是 ${topText}，整份文件这一路只到 ${got ?? '未知'}。`
    if (merged) {
      return {
        rungs,
        ...(got === undefined ? {} : { got }),
        why: `${why}这一档已作为「视频轨 + 音轨」的合并档提供。`,
        hint: `站点另有 ${topText}：已提供合并下载（视频轨 + 音轨），选中后会用本机 ffmpeg 合成一个 mp4。`,
      }
    }
    if (paired.length > 0) {
      return {
        rungs,
        ...(got === undefined ? {} : { got }),
        why: `${why}分离流这一次只合并到 ${pairedBest}。`,
        hint: `站点另有 ${topText}，这里能合并到的最高档是 ${pairedBest}（更高那一档这次没有给分离流）。`,
      }
    }
    // Nothing to merge, and the two reasons are different facts: a missing muxer is
    // fixable by the user, a missing audio track is not.
    const cannot = options.canMerge === true
      ? '（本机 ffmpeg 已就绪，但这次没有拿到可配对的分离音轨。）'
      : '（这台机器上没找到 ffmpeg.exe，分离流无法合并；把 ffmpeg.exe 放到 %APPDATA%\\video-downloader\\tools\\bin 即可。）'
    return {
      rungs,
      ...(got === undefined ? {} : { got }),
      why,
      hint: `站点另有 ${topText}，整份 mp4 只到 ${got ?? '当前这一档'}（更高的档只有清单/分离流，本程序不合并）。${cannot}`,
    }
  }

  if (rungs.length >= 2) {
    return {
      rungs,
      why: `站点列出的档位：${list}；本次没有任何一条能整份下载的地址。`,
      hint: `这个页面有 ${rungs.length} 个清晰度（${list}），但一个都抓不到整份文件。${tail}`,
    }
  }
  if (!manifest && fragments === 0) return undefined
  const shape = manifest ? `清单${fragments > 0 ? ` 与 ${fragments} 个分段` : ''}` : `${fragments} 个分段`
  return {
    rungs,
    why: `页面请求里只有${shape}（HLS 或 DASH），没有任何整份文件。`,
    hint: `这个页面的视频是分段/清单流（HLS 或 DASH），站点没有公开整份文件，所以任何清晰度都抓不到。${tail}`,
  }
}

/**
 * What the site's own session facts mean, in sentences — and only what they mean.
 *
 * The rule this function exists to obey: "nobody is signed in" and "we could not ask"
 * are different facts and must never be rendered as the same sentence. A site's negative
 * answer is worth a fix ("log in over there and read again"); a failure to ask is worth
 * saying out loud so the user knows the panel does not know.
 *
 * It lives in TypeScript rather than in the injected adapter so the wording is unit
 * tested and the page-side code only ever reports what it saw.
 * @param site - the harvested site block.
 * @returns the session sentences, at most a couple.
 */
export function siteQualityNotes(site: HarvestedPage['site']): readonly string[] {
  if (site === undefined) return []
  const session = site.session
  const notes: string[] = []
  if (session !== undefined) {
    if (session.login === true) {
      const label = (session.label ?? '').trim()
      notes.push(`浏览器会话已登录 B 站（${session.vip === true ? (label === '' ? '大会员' : label) : '普通账号'}）`)
    } else if (session.login === false) {
      notes.push('当前浏览器会话未登录 B 站：站点按游客档回答，在这个浏览器里登录后再读一次')
    }
    return notes
  }
  // Says nothing at all unless the adapter showed it reports a session — the sentence is
  // about THIS adapter's question, not about every site in the world.
  if (site.quality !== undefined) notes.push('没能读到会话状态：B 站的登录接口没有回答，所以下面这一档是按游客还是按账号给的，这里不猜')
  return notes
}

/**
 * Explain one harvest: what it saw, and why some of it is not a row.
 * @param page - the raw harvest.
 * @param candidates - what {@link pickMediaCandidates} offered from it.
 * @param options - what the Host can do about separated streams.
 * @returns the numbers and the refusals, ready to show.
 */
export function describeHarvest(
  page: HarvestedPage,
  candidates: readonly MediaCandidate[],
  options: QualityLadderOptions = {},
): HarvestReport {
  const refused: { url: string; why: string }[] = []
  let mediaSourceVideos = 0
  const offered = new Set(candidates.map(candidate => candidate.url))

  for (const video of page.videos ?? []) {
    const src = (video.src ?? '').trim()
    if (src.startsWith('blob:')) {
      mediaSourceVideos += 1
      if (refused.length < 8) refused.push({ url: 'blob:…', why: '播放器用 MSE 播放，这个句柄不是文件（真实地址另行请求）' })
      continue
    }
    if (src.startsWith('data:')) {
      if (refused.length < 8) refused.push({ url: 'data:…', why: '内联数据，不是可下载的地址' })
      continue
    }
    if (src !== '' && !offered.has(src)) {
      if (refused.length < 8) refused.push({ url: shorten(src), why: '播放器报的地址，但页面没把它列为候选' })
    }
  }
  for (const entry of page.perf ?? []) {
    const url = (entry.name ?? '').trim()
    if (url === '' || offered.has(url)) continue
    const ext = extOf(url)
    if (ext === 'ts' || ext === 'm4s') {
      if (refused.length < 8) refused.push({ url: shorten(url), why: '流媒体分段，不是完整文件' })
      continue
    }
    if (ext === undefined) {
      if (refused.length < 8) {
        refused.push({
          url: shorten(url),
          why: STREAM_INITIATOR.test(String(entry.initiatorType ?? ''))
            ? '页面自己请求的地址，但没有扩展名（可能是签名过的媒体，也可能是接口）'
            : '没有扩展名，也没有迹象表明它是媒体',
        })
      }
      continue
    }
    if (!MEDIA_EXT.has(ext)) {
      if (refused.length < 8) {
        refused.push({
          url: shorten(url),
          why: ext === 'm3u8' || ext === 'mpd'
            ? `流清单（.${ext}）：它描述的是一组流，不是一个文件`
            : `不是可单独下载的媒体文件（.${ext}）`,
        })
      }
    }
  }
  // The adapter's own refusals go FIRST: when a site adapter ran and found nothing, its
  // sentence ("只提供 DASH 分离音视频") is the answer to "why is the list empty", and it
  // must not be pushed off the list by a page's twenty poster images.
  const siteRefused = (page.site?.refused ?? []).map(why => ({ url: page.site?.name ?? '站点适配器', why }))
  const siteNotes = [
    ...(page.site?.notes ?? []).filter(note => note !== ''),
    ...siteQualityNotes(page.site),
  ]
  const ladder = qualityLadder(page, candidates, options)

  return {
    candidates: candidates.length,
    evidence: {
      videos: (page.videos ?? []).length,
      sources: (page.sources ?? []).length,
      og: (page.og ?? []).length,
      links: (page.links ?? []).length,
      perf: (page.perf ?? []).length,
      jsonLd: (page.jsonLd ?? []).length,
    },
    mediaSourceVideos,
    refused: [...siteRefused, ...refused].slice(0, 6),
    ...(page.site?.name === undefined ? {} : { site: { name: page.site.name, notes: siteNotes } }),
    ...(ladder === undefined ? {} : { quality: ladder }),
  }
}

/** Whether a URL is something a page can fetch as a file. */
function fetchable(url: string): boolean {
  if (url === '') return false
  if (url.startsWith('blob:')) return false
  if (url.startsWith('data:')) return false
  return /^https?:\/\//i.test(url)
}

/** The extension a URL claims, without a dot. */
function extOf(url: string): string | undefined {
  try {
    const match = /\.([A-Za-z0-9]{1,5})$/.exec(new URL(url).pathname)
    return match?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

/** The extension implied by a MIME type. */
function extOfMime(mime: string | undefined): string | undefined {
  if (mime === undefined) return undefined
  const lower = mime.toLowerCase()
  if (lower.includes('mp4')) return 'mp4'
  if (lower.includes('webm')) return 'webm'
  if (lower.includes('matroska')) return 'mkv'
  if (lower.includes('quicktime')) return 'mov'
  if (lower.includes('mp2t')) return 'ts'
  if (lower.includes('mpegurl')) return 'm3u8'
  return undefined
}

/** A short human label for the row, naming where the URL came from. */
function evidenceLabel(where: string, mime: string | undefined, height: number | undefined): string {
  const bits = [where]
  if (height !== undefined) bits.push(`${height}p`)
  if (mime !== undefined) bits.push(mime)
  return bits.join(' · ')
}

/**
 * The resolution a URL names, when it names one.
 *
 * A `<source>` element has no `height` attribute and no `width`/`height` of its own —
 * the quality is usually only in the file name (`…-1080p.mp4`). Without reading it, a
 * page's two `<source>` rows are indistinguishable: the user reported "why only
 * 720p" while the 1080p row sat directly below the one row that happened to carry a
 * height.
 *
 * Only the PATH is inspected: a signed URL's query is full of digits (`secure=…,
 * 1790823632`), and a resolution read out of a token would be a lie.
 * @param url - the media URL.
 * @returns the height in pixels, or undefined when the URL does not claim one.
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
 * The extensions this picker offers: whole files, one per row.
 *
 * A manifest (`.m3u8`) is a LIST of files and a fragment (`.ts`, `.m4s`) is a piece of
 * one, so neither is a download this tool can perform — offering them meant a row whose
 * download had to leave the plugin entirely. They are still REPORTED, as 「未采用」
 * lines in 诊断, because "why is the list empty" deserves an answer.
 */
const MEDIA_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov'])

/**
 * Rank and de-duplicate what the page reported.
 *
 * Order is by how well the evidence answers "is this the whole video": the element's own
 * current source first, then OpenGraph (which sites publish for exactly this purpose),
 * then declared `<source>` children, then structured data, then links, and last the
 * resource-timing buffer — which proves the page DID fetch something.
 * @param page - what the harvest returned.
 * @param limit - how many rows at most.
 * @returns the candidates, best first.
 */
export function pickMediaCandidates(page: HarvestedPage, limit: number = CANDIDATE_LIMIT): MediaCandidate[] {
  const picked: MediaCandidate[] = []
  const seen = new Set<string>()

  const offer = (raw: string | undefined, label: string, options: {
    ext?: string | undefined
    height?: number | undefined
    bytes?: number | undefined
    approxBytes?: number | undefined
    audioUrl?: string | undefined
    title?: string | undefined
  } = {}): void => {
    if (raw === undefined) return
    const url = raw.trim()
    if (!fetchable(url) || seen.has(url)) return
    seen.add(url)
    // Only a whole file becomes a row. A page advertises plenty that is not one — a
    // manifest, a fragment, an API endpoint, the player's own poster image — and a row
    // per URL the page ever requested is not a picker, it is a network log.
    const ext = options.ext ?? extOf(url)
    if (ext === undefined || !MEDIA_EXT.has(ext)) return
    if (picked.length >= limit) return
    // The quality is usually only in the file name: a `<source>` element carries a MIME
    // type and nothing else, so it is read from the URL when the element cannot supply
    // one — which is what makes two otherwise identical rows tell the user which is
    // which.
    const height = options.height ?? heightFromUrl(url)
    const title = height === undefined || label.includes(`${height}p`) ? label : `${height}p · ${label}`
    const name = options.title === undefined ? undefined : options.title.trim().slice(0, 120)
    // A pair only counts as one when BOTH halves are fetchable: half a pair is a silent
    // film, and the page carrier would happily save exactly that.
    const audio = options.audioUrl === undefined ? undefined : options.audioUrl.trim()
    const paired = audio !== undefined && fetchable(audio) ? audio : undefined
    picked.push({
      url,
      ext,
      ...(height === undefined ? {} : { height }),
      ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
      ...(options.approxBytes === undefined ? {} : { approxBytes: options.approxBytes }),
      ...(paired === undefined ? {} : { audioUrl: paired }),
      ...(name === undefined || name === '' ? {} : { title: name }),
      label: title,
    })
  }

  // A site adapter answers first, and for a reason: when one runs, the page holds no
  // whole file at all (that is what the adapter is for), so anything the DOM offered
  // would be a fragment or a MSE handle dressed up as a row.
  for (const candidate of page.site?.candidates ?? []) {
    offer(candidate.url, candidate.label ?? '站点接口', {
      ...(candidate.ext === undefined ? {} : { ext: candidate.ext }),
      ...(candidate.height === undefined ? {} : { height: candidate.height }),
      ...(candidate.bytes === undefined ? {} : { bytes: candidate.bytes }),
      ...(candidate.approxBytes === undefined ? {} : { approxBytes: candidate.approxBytes }),
      ...(candidate.audioUrl === undefined ? {} : { audioUrl: candidate.audioUrl }),
      ...(candidate.title === undefined ? {} : { title: candidate.title }),
    })
  }
  for (const video of page.videos ?? []) {
    offer(video.src, evidenceLabel('页面播放器', undefined, video.height), { height: video.height })
  }
  for (const meta of page.og ?? []) {
    offer(meta.url, evidenceLabel('og:video', meta.type, undefined), { ext: extOfMime(meta.type) })
  }
  for (const source of page.sources ?? []) {
    offer(source.src, evidenceLabel('<source>', source.type, undefined), { ext: extOfMime(source.type) })
  }
  for (const raw of page.jsonLd ?? []) {
    offer(raw, evidenceLabel('页面数据', undefined, undefined), {})
  }
  for (const link of page.links ?? []) {
    offer(link.href, evidenceLabel(link.text === undefined || link.text === '' ? '页面链接' : `链接：${link.text}`, undefined, undefined), {})
  }
  for (const entry of page.perf ?? []) {
    offer(entry.name, evidenceLabel('页面请求', undefined, undefined), {})
  }

  // Highest quality first: the picker preselects the first row, and "the best version of
  // this video" is what a download means far more often than "whatever the player
  // happened to have selected when I pressed the button". Equal heights keep the
  // evidence order above (a stable sort).
  return [...picked].sort((left, right) => (right.height ?? 0) - (left.height ?? 0))
}

/**
 * Read the harvest result defensively.
 *
 * The value came from another realm through `executeJavaScript`, so every field
 * is treated as untrusted: a page can define `Object.prototype.src` or return
 * something that is not the object we asked for.
 * @param raw - whatever the injection evaluated to.
 * @returns the fields that are the shape we expect.
 */
export function parseHarvest(raw: unknown): HarvestedPage {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const list = (value: unknown): readonly Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry)) : []
  const strings = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
  const site = siteOf(record['site'])
  return {
    ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
    ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
    videos: list(record['videos']).map((entry) => {
      const src = typeof entry['src'] === 'string' ? entry['src'] : undefined
      const width = number(entry['width'])
      const height = number(entry['height'])
      return {
        ...(src === undefined ? {} : { src }),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      }
    }),
    sources: list(record['sources']).map(entry => ({
      ...(typeof entry['src'] === 'string' ? { src: entry['src'] } : {}),
      ...(typeof entry['type'] === 'string' ? { type: entry['type'] } : {}),
    })),
    links: list(record['links']).map(entry => ({
      ...(typeof entry['href'] === 'string' ? { href: entry['href'] } : {}),
      ...(typeof entry['text'] === 'string' ? { text: entry['text'] } : {}),
    })),
    og: list(record['og']).map(entry => ({
      ...(typeof entry['url'] === 'string' ? { url: entry['url'] } : {}),
      ...(typeof entry['type'] === 'string' ? { type: entry['type'] } : {}),
    })),
    perf: list(record['perf']).map(entry => ({
      ...(typeof entry['name'] === 'string' ? { name: entry['name'] } : {}),
      ...(typeof entry['initiatorType'] === 'string' ? { initiatorType: entry['initiatorType'] } : {}),
    })),
    jsonLd: strings(record['jsonLd']),
    ...(site === undefined ? {} : { site }),
  }
}

/**
 * Read the site adapter's answer defensively.
 *
 * Same realm-crossing problem as everything else here, plus one of its own: the
 * candidates carry the name a row should be saved as, which lands in a file name, so
 * it is bounded and trimmed here rather than trusted.
 * @param raw - the `site` field of a harvest.
 * @returns the parsed block, or undefined when there is nothing usable in it.
 */
function siteOf(raw: unknown): HarvestedPage['site'] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const strings = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '').slice(0, 12) : []
  const seconds = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
  const name = typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : undefined
  const candidates = (Array.isArray(record['candidates']) ? record['candidates'] : [])
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const height = seconds(entry['height'])
      const bytes = seconds(entry['bytes'])
      const approxBytes = seconds(entry['approxBytes'])
      const label = typeof entry['label'] === 'string' ? entry['label'].slice(0, 120) : undefined
      const rowTitle = typeof entry['title'] === 'string' ? entry['title'].trim().slice(0, 120) : undefined
      // The audio half of a pair crosses the realm boundary like every other URL, so it is
      // bounded, trimmed and kept only when it is a real absolute address — `fetchable` is
      // applied later, in `offer`, where the decision about offering the row is made.
      const audioRaw = typeof entry['audioUrl'] === 'string' ? entry['audioUrl'].trim() : ''
      const audioUrl = audioRaw === '' ? undefined : audioRaw.slice(0, 2048)
      return {
        ...(typeof entry['url'] === 'string' ? { url: entry['url'] } : {}),
        ...(typeof entry['ext'] === 'string' ? { ext: entry['ext'] } : {}),
        ...(height === undefined ? {} : { height }),
        ...(bytes === undefined ? {} : { bytes }),
        ...(approxBytes === undefined ? {} : { approxBytes }),
        ...(audioUrl === undefined ? {} : { audioUrl }),
        ...(label === undefined ? {} : { label }),
        ...(rowTitle === undefined || rowTitle === '' ? {} : { title: rowTitle }),
      }
    })
  const title = typeof record['title'] === 'string' ? record['title'].trim().slice(0, 120) : undefined
  const notes = strings(record['notes'])
  const refused = strings(record['refused'])
  // The session and the quality ladder cross the same realm boundary as everything else,
  // so both are rebuilt field by field: a boolean that is not a boolean is dropped rather
  // than truthy-coerced, and every string is bounded because the site wrote it.
  const boolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
  const text = (value: unknown, cap: number): string | undefined => {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return trimmed === '' ? undefined : trimmed.slice(0, cap)
  }
  const rung = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000 ? Math.round(value) : undefined
  const nested = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

  const sessionRecord = nested(record['session'])
  const sessionLogin = boolean(sessionRecord?.['login'])
  const sessionVip = boolean(sessionRecord?.['vip'])
  const sessionLabel = text(sessionRecord?.['label'], 24)
  const session = sessionRecord === undefined
    ? undefined
    : {
        ...(sessionLogin === undefined ? {} : { login: sessionLogin }),
        ...(sessionVip === undefined ? {} : { vip: sessionVip }),
        ...(sessionLabel === undefined ? {} : { label: sessionLabel }),
      }

  const qualityRecord = nested(record['quality'])
  const granted = rung(qualityRecord?.['granted'])
  const grantedText = text(qualityRecord?.['grantedText'], 24)
  const listedRaw = Array.isArray(qualityRecord?.['listed']) ? qualityRecord['listed'] : []
  const listed = listedRaw
    .map(entry => nested(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .slice(0, 8)
    .map((entry) => {
      const value = rung(entry['quality'])
      const label = text(entry['text'], 24)
      return {
        ...(value === undefined ? {} : { quality: value }),
        ...(label === undefined ? {} : { text: label }),
      }
    })
    .filter(entry => entry.quality !== undefined || entry.text !== undefined)
  // A quality block with nothing in it is not a quality block: an adapter that answered
  // "quality 0, no ladder" has told us nothing, and `siteQualityNotes` must not read that
  // silence as a fact about the session.
  const quality = (qualityRecord === undefined || (granted === undefined && grantedText === undefined && listed.length === 0))
    ? undefined
    : {
        ...(granted === undefined ? {} : { granted }),
        ...(grantedText === undefined ? {} : { grantedText }),
        ...(listed.length === 0 ? {} : { listed }),
      }

  if (name === undefined && candidates.length === 0 && notes.length === 0 && refused.length === 0
    && session === undefined && quality === undefined) return undefined
  return {
    ...(name === undefined ? {} : { name }),
    ...(title === undefined || title === '' ? {} : { title }),
    notes,
    refused,
    candidates,
    ...(session === undefined ? {} : { session }),
    ...(quality === undefined ? {} : { quality }),
  }
}
