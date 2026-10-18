/**
 * Wire constants shared by every part of the standalone app.
 *
 * The Host serves the renderer from the same loopback origin it serves the JSON
 * API on, so the renderer can keep using RELATIVE paths (that is what makes
 * `fetch('/video-downloader/api/state')` work unchanged). The browser extension
 * is a different origin entirely (`chrome-extension://…`), so it addresses the
 * Host by ABSOLUTE URL built from {@link EXT_PROTOCOL_PORT}.
 */

/** URL prefix of every JSON route the Host registers. */
export const API_PREFIX = '/video-downloader'

/** URL path of the renderer's live event WebSocket. */
export const EVENTS_PATH = `${API_PREFIX}/ws/events`

/** URL path of the browser extension's control WebSocket. */
export const EXT_WS_PATH = `${API_PREFIX}/ext/ws`

/** URL path the page/extension pushes raw media bytes to. */
export const UPLOAD_PATH = `${API_PREFIX}/upload`

/**
 * The first port the Host tries.
 *
 * Fixed rather than random because the extension cannot read a file to discover
 * it: the extension probes this port, then the next few, and remembers the one
 * that answered. `config.port` overrides the base.
 */
export const DEFAULT_PORT = 47_821

/** How many ports the Host may try before giving up (and the extension probes). */
export const PORT_RANGE = 10

/** Protocol revision spoken between the app and its extension. */
export const EXT_PROTOCOL = 1
