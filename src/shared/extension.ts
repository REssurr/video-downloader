/**
 * What the app knows about its browser extension.
 *
 * Shared between the Host (which owns the extension connection) and the renderer
 * (which renders the answer as a sentence). TYPES ONLY — erased at build time.
 */

/** One browser tab as the extension describes it. */
export interface ExtensionTab {
  /** Chrome's tab id — the handle every command is addressed to. */
  readonly id: number
  /** The address the tab is showing. */
  readonly url: string
  /** The tab's title, when the extension could read one. */
  readonly title?: string
  /** A cheap content fingerprint (title + the playing element's source). */
  readonly media?: string
}

/** The extension connection, as the panel renders it. */
export interface ExtensionState {
  /** Whether a browser extension is connected right now. */
  readonly connected: boolean
  /** The protocol revision the extension spoke, when connected. */
  readonly protocol?: number
  /** The extension's own version. */
  readonly version?: string
  /** Which browser it is (`Chrome`, `Edge`, …), when it can tell. */
  readonly browser?: string
  /** The tab the user is looking at, as of the last event or probe. */
  readonly tab?: ExtensionTab
  /** One sentence for the panel: connected, missing, or a version mismatch. */
  readonly note: string
  /** Epoch ms of the moment this state was last changed. */
  readonly since: number
}
