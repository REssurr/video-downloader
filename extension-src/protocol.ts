/**
 * The wire spoken between this extension and the desktop app.
 *
 * The app is the server: it listens on the first free port in this range, and the
 * extension probes the same range until one answers. The protocol number is
 * checked on the app's side, so an extension left over from an older build fails
 * with a sentence instead of a mystery.
 */

/** Protocol revision. Must equal `EXT_PROTOCOL` in the app's `src/shared/wire.ts`. */
export const EXT_PROTOCOL = 1

/** First port the app tries; the extension probes this and the next few. */
export const PORT_BASE = 47_821

/** How many ports either side may walk before giving up. */
export const PORT_RANGE = 10

/** The app's URL prefix. */
export const API_PREFIX = '/video-downloader'

/** One tab, as the app sees it. */
export interface TabInfo {
  readonly id: number
  readonly url: string
  readonly title?: string
  readonly media?: string
}

/** A command from the app. */
export interface CommandFrame {
  readonly type: 'command'
  readonly id?: string
  readonly name: string
  readonly args?: Record<string, unknown>
}

/** The command names this extension understands. */
export type CommandName = 'ping' | 'harvest' | 'open' | 'probeMedia' | 'fetchMedia'

/** How big one upload chunk is. */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
