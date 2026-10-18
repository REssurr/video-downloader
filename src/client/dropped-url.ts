/**
 * Reading an address out of a drag-and-drop.
 *
 * Why this exists: the download key has always SAID 「拖入网址」 (see
 * `key.label`), but nothing in the plugin ever listened for a drop — the label
 * was a promise the code did not keep. Dragging a link (or the address bar)
 * from an external browser is the fastest way in: no copying, no pasting, and
 * the address lands in the same box that typing does, so it goes through the
 * same dispatcher (`store.readAddress`) and cannot behave differently.
 *
 * A Chromium drag carries one of three flavours, and they are not equivalent:
 *
 *   - `text/uri-list` — the real thing: the href of the dragged link, or the
 *     address bar's URL. One URI per line, `#` lines are comments.
 *   - `text/plain` — the fallback (an editor's selection, or a browser that
 *     exports only text).
 *   - `text/html` — an `<a href="…">…</a>` fragment. Used LAST, because it is
 *     the noisiest of the three.
 *
 * The value is passed through VERBATIM: it is not normalised here, because
 * `classifyAddress` already has the one true opinion about what an address is
 * (adds a scheme, rejects a manifest, names a file) and a second opinion in
 * this file would drift from it.
 */

/** The slice of `DataTransfer` a drop needs — small enough to fake in a test. */
export interface TransferLike {
  readonly types?: readonly string[] | undefined
  getData?: ((format: string) => string) | undefined
}

/** What a drop carried, already lifted out of the transfer. */
export interface DroppedPayload {
  readonly uriList?: string | undefined
  readonly text?: string | undefined
  readonly html?: string | undefined
}

/** Whether a drag that is merely HOVERING looks like it carries an address. */
export function hasUrlPayload(transfer: TransferLike | null | undefined): boolean {
  const types = transfer?.types
  if (types === undefined) return false
  return [...types].some(type => /^text\/(uri-list|plain)$/i.test(type))
}

/** One value read from the transfer, with a hostile implementation made harmless. */
function read(transfer: TransferLike | null | undefined, format: string): string | undefined {
  try {
    const value = transfer?.getData?.(format)
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Lift the three text flavours out of a drop.
 *
 * During `dragover` the data is unreadable by design (a page must not see what
 * is being dragged before it is dropped), so this is only meaningful inside
 * `drop`.
 * @param transfer - the event's `dataTransfer`.
 * @returns whatever could be read; every field may be absent.
 */
export function dropPayloadOf(transfer: TransferLike | null | undefined): DroppedPayload {
  const uriList = read(transfer, 'text/uri-list')
  const text = read(transfer, 'text/plain')
  const html = read(transfer, 'text/html')
  return {
    ...(uriList === undefined ? {} : { uriList }),
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
  }
}

/** The first line of a payload that is neither empty nor a `#` comment. */
function firstLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) return trimmed
  }
  return undefined
}

/**
 * The first `href` in an HTML fragment, with the entities a URL can carry decoded.
 *
 * Attribute order is not guaranteed and quotes may be single or double, so both
 * are accepted; `&amp;` is the one entity a real URL hits constantly (query
 * separators), which is why it is decoded rather than left to look like part of
 * the address.
 * @param html - the fragment.
 * @returns the href, or undefined when there is none.
 */
function hrefInHtml(html: string | undefined): string | undefined {
  if (html === undefined) return undefined
  const match = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(html)
  const value = match?.[2] ?? match?.[3]
  if (value === undefined) return undefined
  const decoded = value.replace(/&amp;/gi, '&').trim()
  return decoded === '' ? undefined : decoded
}

/**
 * The address a drop is asking for.
 *
 * Preference order is uri-list → plain text → HTML, and within plain text only
 * the FIRST non-empty line is taken: dropping a paragraph that happens to
 * contain a link should send the link (or fail cleanly), never the prose.
 * @param payload - what {@link dropPayloadOf} read.
 * @returns the address verbatim, or undefined when the drop carried none.
 */
export function urlFromDrop(payload: DroppedPayload): string | undefined {
  return firstLine(payload.uriList) ?? firstLine(payload.text) ?? hrefInHtml(payload.html)
}

/**
 * The address one `drop` event is asking for.
 * @param transfer - the event's `dataTransfer`.
 * @returns the address verbatim, or undefined when the drop carried none.
 */
export function urlFromTransfer(transfer: TransferLike | null | undefined): string | undefined {
  return urlFromDrop(dropPayloadOf(transfer))
}
