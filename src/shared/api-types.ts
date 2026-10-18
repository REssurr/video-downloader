/**
 * Wire envelope types for the Host JSON routes.
 *
 * TYPES ONLY — erased at build time, so the Client half may `import type` this
 * without creating a relative runtime import (a client bundle is one
 * self-contained module node and cannot require a sibling).
 */

/** Every route answers with exactly one of these two shapes. */
export type ApiEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError }

/** One wire failure: a stable code plus a human message. */
export interface ApiError {
  /** Stable machine code, e.g. `engine-missing`, `path-denied`. */
  readonly code: string
  /** Human-readable reason, already localized where it matters. */
  readonly message: string
}

/** `ping` response: proves the Host route prefix is live. */
export interface PingValue {
  /** Always `pong`; lets the client distinguish our route from a 404 page. */
  readonly pong: true
  /** Host package version from `package.json`. */
  readonly version: string
  /** The live JSON route prefix. */
  readonly apiPrefix: string
}
