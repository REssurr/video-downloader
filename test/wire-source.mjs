/**
 * Reads the shared wire constants out of `src/shared/wire.ts` as TEXT.
 *
 * The tests must not import `src/**` (Node cannot remap the `.js` specifiers
 * onto `.ts` sources), and the two constants are the contract between the
 * halves — so they are extracted from the literal source text and then checked
 * against what each half actually ships. That way the test fails if EITHER the
 * source or the mirror drifts.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Parse the exported wire constants from the shared source.
 * @returns the two constants.
 * @throws when the source no longer declares them in the expected literal form.
 */
export function readWireConstants() {
  const source = readFileSync(join(ROOT, 'src/shared/wire.ts'), 'utf8')

  const prefix = /export const API_PREFIX = '([^']+)'/.exec(source)
  if (prefix === null) {
    throw new Error('src/shared/wire.ts must declare `export const API_PREFIX = \'…\'` as a literal')
  }

  const events = /export const EVENTS_PATH = `([^`]+)`/.exec(source)
  if (events === null) {
    throw new Error('src/shared/wire.ts must derive EVENTS_PATH from a template literal')
  }

  const apiPrefix = prefix[1]
  const eventsPath = events[1].replace('${API_PREFIX}', apiPrefix)
  return { apiPrefix, eventsPath }
}
