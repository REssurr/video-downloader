/**
 * The renderer entry: one window, one panel.
 *
 * There is no floating key and no overlay slot any more — the window IS the
 * panel — so this file only mounts it, starts the store's three lifecycles
 * (state read, event channel, follower) and gets out of the way.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { DownloadPanel } from './DownloadPanel.js'
import { installTranslator } from './locale.js'
import { createStore, type StoreSnapshot } from './store.js'
import type { ReactNode } from 'react'

/** The window's only component. */
function App(): ReactNode {
  const store = useMemo(() => createStore(), [])
  const snapshot: StoreSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)

  useEffect(() => {
    installTranslator()
    // Load once, then attach the live channel and the page follower. All three
    // belong to the app, not to a view: the rows must be current before the user
    // looks, and the follower has to keep running while the window is hidden.
    void store.refresh()
    const disconnect = store.connect()
    const stopFollower = store.watchGuestPage()
    return () => {
      disconnect()
      stopFollower()
    }
  }, [store])

  return <DownloadPanel store={store} snapshot={snapshot} />
}

const host = document.getElementById('root')
if (host !== null) {
  createRoot(host).render(<App />)
}
