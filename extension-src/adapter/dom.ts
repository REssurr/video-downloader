/**
 * Reading the page's DOM, from inside the page.
 *
 * This is the MIGRATED half of the plugin's `harvestSource`: the plugin evaluated
 * that script inside its own `<webview>`; here a content script runs in the page
 * already, so the same reads are ordinary function calls. The output shape is
 * deliberately identical, because the app's `parseHarvest` / `pickMediaCandidates`
 * were written against it and are still the place that decides what is
 * downloadable.
 *
 * Every step is wrapped: one hostile or exotic page must not make the whole
 * harvest fail. Nothing here writes, fetches or listens.
 */

/** One page's raw harvest, as the app's parser expects it. */
export interface HarvestedPage {
  readonly url?: string
  readonly title?: string
  readonly videos?: readonly { readonly src?: string; readonly duration?: number; readonly width?: number; readonly height?: number }[]
  readonly sources?: readonly { readonly src?: string; readonly type?: string; readonly height?: number }[]
  readonly links?: readonly { readonly href?: string; readonly text?: string }[]
  readonly og?: readonly { readonly url?: string; readonly type?: string }[]
  readonly perf?: readonly { readonly name?: string; readonly initiatorType?: string }[]
  readonly jsonLd?: readonly string[]
  readonly site?: unknown
}

/** What a media URL looks like in the DOM. */
const MEDIA = /\.(mp4|m4v|webm|mkv|mov|m3u8|mpd|ts|m4s)([?#]|$)/i

/**
 * Read what the page is playing.
 * @returns the raw facts; the app decides what they mean.
 */
export function harvestDom(): HarvestedPage {
  const out: {
    url: string
    title: string
    videos: { src?: string; duration?: number; width?: number; height?: number }[]
    sources: { src?: string; type?: string; height?: number }[]
    links: { href?: string; text?: string }[]
    og: { url?: string; type?: string }[]
    perf: { name?: string; initiatorType?: string }[]
    jsonLd: string[]
    site: unknown
  } = {
    url: location.href,
    title: document.title,
    videos: [],
    sources: [],
    links: [],
    og: [],
    perf: [],
    jsonLd: [],
    site: null,
  }

  try {
    for (const video of document.querySelectorAll('video')) {
      const src = video.currentSrc || video.src || ''
      if (src !== '') {
        out.videos.push({
          src,
          ...(Number.isFinite(video.duration) ? { duration: video.duration } : {}),
          ...(video.videoWidth > 0 ? { width: video.videoWidth } : {}),
          ...(video.videoHeight > 0 ? { height: video.videoHeight } : {}),
        })
        if (out.videos.length >= 50) break
      }
      for (const source of video.querySelectorAll('source')) {
        if (source.src !== '') {
          out.sources.push({
            src: source.src,
            ...(source.type === '' ? {} : { type: source.type }),
            ...(video.videoHeight > 0 ? { height: video.videoHeight } : {}),
          })
          if (out.sources.length >= 100) break
        }
      }
    }
  } catch {
    // A page that refuses to be read is simply not harvested.
  }

  try {
    const metas = document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]')
    for (const meta of metas) {
      const content = meta.getAttribute('content') ?? ''
      if (content !== '' && out.og.length < 10) out.og.push({ url: content })
    }
    for (const meta of document.querySelectorAll('meta[property="og:video:type"]')) {
      const content = meta.getAttribute('content') ?? ''
      if (content !== '' && out.og.length > 0) (out.og[out.og.length - 1] as { type?: string }).type = content
    }
  } catch {
    // No OpenGraph block, no rows from it.
  }

  try {
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = (anchor as HTMLAnchorElement).href || ''
      if (MEDIA.test(href) && out.links.length < 100) {
        out.links.push({ href, text: (anchor.textContent ?? '').trim().slice(0, 60) })
      }
    }
  } catch {
    // Links are the weakest evidence anyway.
  }

  try {
    for (const entry of performance.getEntriesByType('resource')) {
      const name = entry.name
      if (name === '' || !MEDIA.test(name)) continue
      const initiator = (entry as PerformanceResourceTiming).initiatorType
      out.perf.push({ name, ...(initiator === '' ? {} : { initiatorType: initiator }) })
      if (out.perf.length >= 300) break
    }
  } catch {
    // Resource timing may be unavailable or cleared.
  }

  try {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const text = script.textContent ?? ''
      const matches = text.match(/https?:\\?\/\\?\/[^"'\s]+?\.(?:mp4|m4v|webm|mkv|mov|m3u8)/gi) ?? []
      for (const match of matches) {
        if (out.jsonLd.length >= 50) break
        out.jsonLd.push(match.replace(/\\\//g, '/'))
      }
    }
  } catch {
    // Malformed structured data is common and harmless.
  }

  return out
}

/**
 * A cheap fingerprint of what the page is playing.
 *
 * The address alone cannot see a player swap its video in place, so the app asks
 * for this instead: the title plus the playing element's source. Read-only.
 * @returns the fingerprint the app compares between beats.
 */
export function fingerprint(): string {
  try {
    const video = document.querySelector('video')
    const inner = video === null ? null : (video.querySelector('source[src]') as HTMLSourceElement | null)
    const media = (video !== null && (video.currentSrc || video.src)) || (inner !== null ? inner.src : '') || ''
    return `${String(document.title || '').slice(0, 120)}\u0001${String(media).slice(0, 300)}`
  } catch {
    return ''
  }
}
