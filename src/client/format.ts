/**
 * Pure formatting helpers for the panel.
 *
 * No React, no DOM: every one of these is a function of its arguments, so the
 * panel's numeric rendering is testable without mounting a component.
 */

/**
 * Format a byte count for a progress row.
 * @param value - the byte count, or `undefined` when unknown.
 * @returns a short human string, or an em dash when unknown.
 */
export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let scaled = value / 1024
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[unit]}`
}

/**
 * Format a transfer rate.
 * @param value - bytes per second.
 * @returns the rate, or `''` when unknown.
 */
export function formatSpeed(value: number | undefined): string {
  return value === undefined ? '' : `${formatBytes(value)}/s`
}

/**
 * Format a remaining-time estimate.
 * @param received - bytes written so far.
 * @param total - total bytes, when known.
 * @param speed - bytes per second, when known.
 * @returns a short duration, or `''` when it cannot be estimated.
 */
export function formatEta(received: number, total: number | undefined, speed: number | undefined): string {
  if (total === undefined || speed === undefined || speed <= 0 || received >= total) return ''
  const seconds = Math.round((total - received) / speed)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`
  return `${(seconds / 3600).toFixed(1)}h`
}

/**
 * Progress percentage, when a total is known.
 * @param received - bytes written so far.
 * @param total - total bytes, when known.
 * @returns 0-100, or `undefined`.
 */
export function percentOf(received: number, total: number | undefined): number | undefined {
  if (total === undefined || total <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)))
}

/**
 * Format a duration in seconds as `m:ss`.
 * @param seconds - the duration.
 * @returns the formatted duration.
 */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}
