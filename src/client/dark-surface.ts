/**
 * The downloader's own dark surface.
 *
 * The requirement is a BLACK floating box, not "a box that matches the theme":
 * in the harness's light theme the `--dsw-alias-*` tokens the panel is styled
 * with resolve to near-white, which turned the panel into a white card with dark
 * text and lost the whole point of the design.
 *
 * Rather than restyling every element — and risking a half-migrated surface that
 * mixes token colours with fixed ones — the tokens themselves are redefined on
 * the panel's own root element. `var(--dsw-alias-*)` resolves against the nearest
 * ancestor that defines the property, so one override on the root darkens the
 * panel, its rows, its inputs, the picker and the chat box together, and the
 * theme keeps owning everything outside this plugin.
 *
 * The values are the fallbacks the components already carried, so nothing inside
 * the box has to change.
 */
import type { CSSProperties } from 'react'

/**
 * Token overrides for the plugin's dark surfaces.
 *
 * Apply to the ROOT element of a floating surface (the key's host and the
 * panel). Custom properties inherit, so descendants need no change; do NOT apply
 * it to a wrapper that also contains harness UI.
 */
export const DARK_SURFACE = {
  // Layers, darkest first: inputs sit on the near-black box, rows one step up.
  '--dsw-alias-bg-layer-1': '#08080b',
  '--dsw-alias-bg-layer-2': '#101015',
  '--dsw-alias-bg-layer-3': '#16161c',
  '--dsw-alias-border-l2': '#33333d',
  '--dsw-alias-interactive-bg-hover': 'rgba(255, 255, 255, 0.08)',
  '--dsw-alias-label-primary': '#ececf1',
  '--dsw-alias-label-secondary': '#9aa0aa',
  '--dsw-alias-label-tertiary': '#7d838f',
  '--dsw-alias-label-quaternary': '#5b606b',
  '--dsw-alias-state-error-primary': '#f2a1a1',
  '--dsw-alias-state-success-primary': '#7dd3a0',
  '--dsw-alias-state-warning-primary': '#d8a657',
} as unknown as CSSProperties
