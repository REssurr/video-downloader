/**
 * The content script: answers the background worker's questions about the page.
 *
 * It lives in the page (ISOLATED world) on purpose: the DOM is shared with the
 * page, so every question the plugin used to answer with `executeJavaScript` can
 * be answered here as ordinary code, without `eval` and without touching the
 * page's own scripts.
 */
import { fingerprint, harvestDom } from './adapter/dom.js'

/** One request from the background worker. */
interface ContentRequest {
  readonly type?: unknown
}

chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse: (response: unknown) => void) => {
  if (message === null || typeof message !== 'object') return false
  try {
    if (message.type === 'harvest') {
      sendResponse({ ok: true, value: harvestDom() })
      return false
    }
    if (message.type === 'fingerprint') {
      sendResponse({ ok: true, value: fingerprint() })
      return false
    }
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    return false
  }
  return false
})
