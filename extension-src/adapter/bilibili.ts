/**
 * The bilibili adapter, ported from the plugin's in-page script.
 *
 * The plugin built this as a STRING evaluated inside the page because it had no
 * other way in; here it is ordinary code in the background worker. That is a
 * simplification rather than a rewrite: bilibili's own pages never publish a whole
 * file for a video, so the site's player API is the only source, and the API
 * answers a request that carries the browser's session — which this worker does
 * with `credentials: 'include'` and the extension's host permissions.
 *
 * What the plugin got from `window.__INITIAL_STATE__` is derived instead: the
 * bvid is in the URL and the cid comes from the view API when the page did not
 * report one. Everything else — the whole-file answer, the DASH ladder, the
 * session facts — is asked for exactly as before.
 */

/** One candidate row, in the app's `HarvestedPage.site` shape. */
export interface SiteCandidate {
  readonly url?: string
  readonly ext?: string
  readonly height?: number
  readonly bytes?: number
  readonly audioUrl?: string
  readonly approxBytes?: number
  readonly label?: string
  readonly title?: string
}

/** What an adapter reports about one page. */
export interface SiteFact {
  readonly name?: string
  readonly title?: string
  readonly session?: { readonly login?: boolean; readonly vip?: boolean; readonly label?: string }
  readonly quality?: { readonly granted?: number; readonly grantedText?: string; readonly listed?: readonly { readonly quality?: number; readonly text?: string }[] }
  readonly notes?: readonly string[]
  readonly refused?: readonly string[]
  readonly candidates?: readonly SiteCandidate[]
}

/** One API call's answer: the site's JSON, or our own error sentence. */
interface CallResult {
  readonly error?: string
  readonly code?: number
  readonly message?: unknown
  readonly data?: Record<string, unknown>
}

/** A DASH track, as this module reads it. */
interface Track {
  readonly id?: number
  readonly height?: number
  readonly bandwidth?: number
  readonly codecs?: string
  readonly baseUrl?: string
  readonly base_url?: string
  readonly backupUrl?: readonly string[]
  readonly backup_url?: readonly string[]
}

/** Quality id → the vertical resolution a person recognises (FALLBACK only). */
const QUALITY_HEIGHT: Readonly<Record<number, number>> = {
  6: 240, 16: 360, 32: 480, 64: 720, 74: 720, 80: 1080, 112: 1080, 116: 1080, 120: 2160,
}

/** Call one bilibili API with the browser's cookies and a hard timeout. */
async function call(url: string, timeoutMs: number): Promise<CallResult> {
  const control = new AbortController()
  const timer = setTimeout(() => { control.abort() }, timeoutMs)
  try {
    const response = await fetch(url, { credentials: 'include', signal: control.signal })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { error: `HTTP ${response.status}（应答不是 JSON）` }
    }
    if (parsed === null || typeof parsed !== 'object') return { error: `HTTP ${response.status}（应答不是对象）` }
    return parsed as CallResult
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error) }
  } finally {
    clearTimeout(timer)
  }
}

/** The video's own title, from a browser-tab string. */
function cleanTitle(text: string): string {
  return String(text || '')
    .replace(/\s*[_\-.|]\s*哔哩哔哩.*$/s, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** The site's own quality ladder for one video, in its own words, best first. */
function listedOf(data: Record<string, unknown> | null): { quality: number; text: string }[] {
  const listed: { quality: number; text: string }[] = []
  const formats = Array.isArray(data?.['support_formats']) ? data['support_formats'] as Record<string, unknown>[] : []
  for (const entry of formats) {
    if (listed.length >= 8) break
    const value = Number(entry['quality']) || 0
    const label = String(entry['new_description'] ?? entry['display_desc'] ?? '').trim().slice(0, 24)
    if (value > 0 && label !== '') listed.push({ quality: value, text: label })
  }
  const ids = Array.isArray(data?.['accept_quality']) ? data['accept_quality'] as unknown[] : []
  const names = Array.isArray(data?.['accept_description']) ? data['accept_description'] as unknown[] : []
  for (let index = 0; index < ids.length && listed.length < 8; index += 1) {
    const value = Number(ids[index]) || 0
    const label = String(names[index] ?? '').trim().slice(0, 24)
    if (value > 0 && label !== '') listed.push({ quality: value, text: label })
  }
  return listed
}

/** One DASH track's own address (the site sends both spellings). */
function trackUrl(track: Track): string {
  for (const candidate of [track.baseUrl, track.base_url]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  const backups = Array.isArray(track.backupUrl) ? track.backupUrl : (Array.isArray(track.backup_url) ? track.backup_url : [])
  for (const backup of backups) {
    if (typeof backup === 'string' && backup !== '') return backup
  }
  return ''
}

/** The player URL for one quality channel. */
function playurl(bvid: string, cid: string, fnval: number): string {
  return `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}`
    + `&cid=${encodeURIComponent(cid)}&qn=120&fnval=${fnval}&fnver=0&fourk=1&platform=pc&high_quality=1`
}

/**
 * Ask bilibili what it will hand over for this page.
 * @param input - the page, its title, and whether this machine can merge tracks.
 * @returns the site's answer, or undefined when this is not a video page.
 */
export async function bilibiliSite(input: {
  readonly pageUrl: string
  readonly pageTitle: string
  readonly canMerge: boolean
}): Promise<SiteFact | undefined> {
  const url = new URL(input.pageUrl)
  if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) return undefined
  const name = 'bilibili'
  const pageNo = Math.max(1, Number(url.searchParams.get('p') ?? '1') || 1)
  const match = /\/video\/(BV[0-9A-Za-z]+)/.exec(url.pathname)
  const bvid = match?.[1] ?? ''
  let title = cleanTitle(input.pageTitle)
  if (bvid === '') {
    return { name, refused: ['这个 B 站页面里没有投稿号（BV 号）：番剧 / 直播 / 课程页用的是另一套接口'] }
  }

  // The cid is per-part, and the view API is the only source available from a
  // background worker (the page's own `__INITIAL_STATE__` is not readable here).
  let cid = ''
  const view = await call(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, 5_000)
  if (view.error !== undefined) return { name, refused: [`读投稿信息失败：${view.error}`] }
  if (view.code !== 0) return { name, refused: [`B 站投稿接口 code=${String(view.code)}：${String(view.message ?? '')}`] }
  const pages = Array.isArray(view.data?.['pages']) ? view.data?.['pages'] as Record<string, unknown>[] : []
  const part = pages[pageNo - 1]
  if (part !== undefined) cid = String(part['cid'] ?? '')
  if (!title && view.data?.['title'] !== undefined) title = cleanTitle(String(view.data['title']))
  if (cid === '' || cid === '0') return { name, refused: ['找不到这一 P 的 cid，因此取不到下载地址'] }

  // Asked in PARALLEL with the whole-file question: the session is independent of
  // the video, and the answer decides whether "you only got 720P" is about the
  // account or about the channel.
  const sessionPromise = call('https://api.bilibili.com/x/web-interface/nav', 4_000)

  const play = await call(playurl(bvid, cid, 1), 7_000)
  if (play.error !== undefined) return { name, refused: [`取清晰度列表失败：${play.error}`] }
  if (play.code !== 0) {
    return { name, refused: [`B 站播放接口 code=${String(play.code)}：${String(play.message ?? '')}（这一档清晰度可能需要登录）`] }
  }
  const data = play.data ?? {}
  const quality = Number(data['quality']) || 0
  const qualities = Array.isArray(data['accept_quality']) ? data['accept_quality'] as unknown[] : []
  const described = qualities.indexOf(quality)
  const descriptions = Array.isArray(data['accept_description']) ? data['accept_description'] as unknown[] : []
  const text = described >= 0 && descriptions[described] !== undefined
    ? String(descriptions[described])
    : `清晰度 ${quality}`
  const height = qualityHeight(quality, text)
  const parts = Array.isArray(data['durl']) ? data['durl'] as Record<string, unknown>[] : []

  const whole: SiteCandidate[] = []
  for (const [index, entry] of parts.entries()) {
    const primary = typeof entry['url'] === 'string' ? entry['url'] : ''
    const backups = Array.isArray(entry['backup_url']) ? entry['backup_url'] as unknown[] : []
    const backup = typeof backups[0] === 'string' ? backups[0] : ''
    const trackAddress = primary !== '' ? primary : backup
    if (trackAddress === '') continue
    const order = Number(entry['order']) || index + 1
    whole.push({
      url: trackAddress,
      ext: 'mp4',
      ...(height === undefined ? {} : { height }),
      ...(typeof entry['size'] === 'number' ? { bytes: entry['size'] } : {}),
      label: `bilibili 整份 mp4 · ${text}`,
      title: parts.length > 1 ? `${title || 'B 站视频'}（第${order}段）` : title,
    })
  }

  // Only asked when the whole-file channel stopped below 1080P (or gave nothing),
  // or when this machine can merge — because then the DASH answer is where a
  // higher ROW comes from, not merely an explanation.
  const needCeiling = input.canMerge || whole.length === 0 || !(quality >= 80)
  const dash = needCeiling ? await call(playurl(bvid, cid, 16), 7_000) : null
  const dashData = dash !== null && dash.code === 0 && dash.data !== undefined ? dash.data : null
  const dashBlock = dashData !== null && typeof dashData['dash'] === 'object' ? dashData['dash'] as Record<string, unknown> : null
  const videoTracks = dashBlock !== null && Array.isArray(dashBlock['video']) ? dashBlock['video'] as Track[] : []
  const listed = listedOf(dashData ?? data)
  const qualityFact = {
    ...(quality > 0 ? { granted: quality } : {}),
    ...(quality > 0 ? { grantedText: text } : {}),
    listed,
  }

  // Separated tracks become rows of their own, and only when this machine can
  // actually join them: a row nobody can download is worse than the sentence that
  // says why the quality is missing.
  const merged: SiteCandidate[] = []
  const mergeRefused: string[] = []
  if (input.canMerge && dashBlock !== null) {
    const audios = Array.isArray(dashBlock['audio']) ? dashBlock['audio'] as Track[] : []
    let audio: { bandwidth: number; url: string } | null = null
    for (const track of audios) {
      const bandwidth = Number(track.bandwidth) || 0
      const address = trackUrl(track)
      if (address === '') continue
      if (audio === null || bandwidth > audio.bandwidth) audio = { bandwidth, url: address }
    }
    const duration = Number(dashBlock['duration']) || 0
    const bestWhole = whole.reduce((highest, entry) => Math.max(highest, Number(entry.height) || 0), 0)
    const byHeight = new Map<number, { id: number; url: string; height: number; rank: number; bandwidth: number }>()
    for (const track of videoTracks) {
      const address = trackUrl(track)
      if (address === '') continue
      const id = Number(track.id) || 0
      const trackHeight = Number(track.height) || qualityHeight(id, '') || 0
      // A pair at or below what the single whole file already gives is not worth
      // an ffmpeg run and a second download.
      if (trackHeight <= bestWhole) continue
      const codec = String(track.codecs ?? '')
      const rank = /^avc1/i.test(codec) ? 0 : (/^(hvc1|hev1)/i.test(codec) ? 1 : (/^av01/i.test(codec) ? 2 : 3))
      const bandwidth = Number(track.bandwidth) || 0
      const current = byHeight.get(trackHeight)
      if (current === undefined || rank < current.rank || (rank === current.rank && bandwidth > current.bandwidth)) {
        byHeight.set(trackHeight, { id, url: address, height: trackHeight, rank, bandwidth })
      }
    }
    if (audio !== null && audio.url !== '') {
      const heights = [...byHeight.keys()].sort((left, right) => right - left)
      for (const rungHeight of heights) {
        const pick = byHeight.get(rungHeight)
        if (pick === undefined) continue
        const describedRung = listed.find(entry => entry.quality === pick.id)
        const rungText = describedRung !== undefined && describedRung.text !== '' ? describedRung.text : `${pick.height}P`
        merged.push({
          url: pick.url,
          audioUrl: audio.url,
          ext: 'mp4',
          height: pick.height,
          // The pair does not exist yet, so its size can only be estimated — and
          // an estimate is reported as one, never as a byte count.
          ...(duration > 0 ? { approxBytes: Math.round((pick.bandwidth + audio.bandwidth) / 8 * duration) } : {}),
          label: `bilibili 合并 · ${rungText}`,
          // The rung goes INTO the name: the 720P whole file and the 1080P pair
          // would otherwise both be named after the video and collide.
          title: `${title || 'B 站视频'} · ${rungText}`,
        })
      }
    } else if (videoTracks.length > 0) {
      mergeRefused.push('B 站给了分离的视频轨，但这次应答里没有可用的音轨地址，所以没有可合并的档位')
    }
  }

  const session = await sessionPromise
  // -101 is the site's own "账号未登录", which IS an answer; any other non-zero
  // code is not, and is reported as unknown rather than dressed up as signed-out.
  const sessionData = session.code === 0 && session.data !== undefined && typeof session.data === 'object'
    ? session.data
    : null
  const sessionFact = sessionData !== null
    ? {
        login: sessionData['isLogin'] === true,
        vip: sessionData['vipStatus'] === 1,
        label: String((sessionData['vip_label'] as { text?: unknown } | undefined)?.text ?? '').trim().slice(0, 24),
      }
    : (session.code === -101 ? { login: false, vip: false, label: '' } : undefined)

  const candidates = [...whole, ...merged]
  if (candidates.length === 0) {
    const ladder = listed.length === 0 ? '' : `；站点为该视频列出的档位：${listed.map(entry => entry.text).join(' / ')}`
    const nothing = 'B 站没有给出可下载的整份文件（可能需要登录，或该内容受版权限制）'
    const tracks = videoTracks.length
    const separation = input.canMerge
      ? `B 站对这个视频只给 DASH 分离音视频（${tracks} 条视频轨 + 独立音轨）：这次没有组成可合并的档位`
      : `B 站对这个视频只给 DASH 分离音视频（${tracks} 条视频轨 + 独立音轨）：没有整份文件，本程序不做合并`
    return {
      name,
      title,
      ...(sessionFact === undefined ? {} : { session: sessionFact }),
      quality: qualityFact,
      refused: [`${tracks > 0 ? separation : nothing}${ladder}`].concat(mergeRefused),
    }
  }
  const notes: string[] = []
  if (whole.length > 0) {
    notes.push(`B 站：用这个浏览器的会话问了「投稿播放」接口，拿到 ${whole.length} 个整份 mp4（${text}）`)
  }
  if (merged.length > 0) {
    notes.push(`B 站：另有 ${merged.length} 档更高的清晰度只有分离的视频轨与音轨，已作为合并下载提供（用本机 ffmpeg.exe 合成一个 mp4）`)
  }
  return {
    name,
    title,
    ...(sessionFact === undefined ? {} : { session: sessionFact }),
    quality: qualityFact,
    notes,
    refused: mergeRefused,
    candidates,
  }
}

/** The vertical resolution for a quality id, preferring the site's own words. */
function qualityHeight(quality: number, description: string): number | undefined {
  const parsed = /(\d{3,4})\s*[pP]/.exec(String(description || ''))
  if (parsed !== null) return Number(parsed[1])
  return QUALITY_HEIGHT[quality]
}
