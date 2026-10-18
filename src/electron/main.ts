/**
 * The desktop shell.
 *
 * Deliberately thin: it owns the window, the tray icon and the native file
 * pickers, and hands everything else to `startHostServer`. The renderer is loaded
 * from the Host's own loopback origin rather than `file://`, which is what lets the
 * panel keep using relative API paths.
 *
 * The window is NOT the app's whole life: the browser extension can only reach the
 * Host while this process runs, so closing the window hides it into the tray and
 * leaves the download engine and the extension channel alive. Quitting is a tray
 * menu action.
 */
import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { cp } from 'node:fs/promises'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHostServer, type Host } from '../host/server.js'

/** The window size: the panel is the only surface, so it is phone-shaped. */
const WINDOW = { width: 460, height: 740, minWidth: 420, minHeight: 560 } as const

/** Read the app version from the packaged manifest, falling back silently. */
function version(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Write one line to the file named by `VD_START_LOG`, when that variable is set.
 *
 * "双击没反应" is the hardest kind of report to answer without evidence, and a packaged
 * app has no console to look at; this gives the startup path a paper trail that costs
 * nothing when the variable is absent.
 */
function trace(message: string): void {
  const target = process.env['VD_START_LOG']
  if (target === undefined || target === '') return
  try {
    const line = `${new Date().toISOString()} pid=${process.pid} ${message}\n`
    appendFileSync(target, line, 'utf8')
  } catch {
    // A missing log file must never break the app.
  }
}

/** One window, one server, one tray; all live for the process. */
let host: Host | undefined
let window: BrowserWindow | undefined
let tray: Tray | undefined
/** Set when the user really asked to quit, so a window close may go through. */
let quitting = false

/** The extension the user is told to load, wherever this build keeps it. */
function extensionSourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'extension')
    : join(app.getAppPath(), 'extension')
}

/** One bundled image, from `resources/` when packaged and `build/` in development. */
function assetPath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'build', name)
}

/** Ask the OS for a directory. */
async function pickDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择下载目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/** Bring the panel back, creating it if it was destroyed. */
function showWindow(url: string): void {
  if (window === undefined) {
    createWindow(url)
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * Copy the bundled extension somewhere the user can point Chrome/Edge at.
 *
 * A packaged build keeps it inside `resources/`, where a file dialog cannot reach
 * it, so the tray copies it next to the app's own state and opens that folder.
 */
async function exportExtension(): Promise<void> {
  const source = extensionSourceDir()
  const target = join(app.getPath('userData'), 'extension')
  try {
    await cp(source, target, { recursive: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await dialog.showErrorBox('导出浏览器扩展失败', `没能把扩展复制到 ${target}：\n${message}`)
    return
  }
  await shell.openPath(app.getPath('userData'))
  await dialog.showMessageBox({
    type: 'info',
    title: '浏览器扩展已经导出',
    message: `扩展已经放在：\n${target}`,
    detail: [
      '安装步骤：',
      '1. 打开 Chrome 或 Edge 的扩展管理页（chrome://extensions / edge://extensions）',
      '2. 打开右上角的「开发者模式」',
      '3. 点「加载已解压的扩展程序」，选上面这个 extension 文件夹',
      '4. 装好后回到本程序，标题栏右侧会显示「扩展已连接」',
      '',
      '以后只需要保持本程序运行（关掉窗口会缩到右下角托盘），扩展就会自动连上。',
    ].join('\n'),
    buttons: ['好'],
  })
}

/** The tray icon: show the panel, export the extension, or really quit. */
function createTray(url: string): void {
  const image = nativeImage.createFromPath(assetPath('tray.png'))
  tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(assetPath('icon-256.png')) : image)
  tray.setToolTip('视频下载器')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { showWindow(url) } },
    { label: '导出浏览器扩展…', click: () => { void exportExtension() } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit() } },
  ]))
  tray.on('click', () => { showWindow(url) })
}

/** Create the visible window and point it at the Host. */
function createWindow(url: string): void {
  window = new BrowserWindow({
    ...WINDOW,
    title: '视频下载器',
    icon: assetPath('icon-256.png'),
    backgroundColor: '#08080b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  window.once('ready-to-show', () => { window?.show() })
  // Closing the window only hides it: the extension talks to a process, not a window.
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window?.hide()
  })
  // A smoke run prints the renderer's own console and a screenshot, so a broken
  // bundle is visible without a human at the screen.
  if (process.env['VD_SMOKE'] === '1') {
    // Electron 44 起 console-message 只传一个事件对象，老的 (event, level, message) 形式已弃用。
    window.webContents.on('console-message', (event) => {
      console.info(`[renderer] ${event.message}`)
    })
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void window?.webContents.capturePage().then((image) => {
          const target = join(app.getPath('temp'), 'vd-smoke.png')
          writeFileSync(target, image.toPNG())
          console.info(`[smoke] screenshot: ${target}`)
        }).finally(() => {
          app.quit()
        })
      }, 2_500)
    })
  }
  // A link inside the panel opens in the user's own browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  void window.loadURL(url)
  window.on('closed', () => { window = undefined })
}

/**
 * Boot: one instance, one window, one tray, one loopback Host.
 * @returns nothing; Electron owns the lifecycle from here.
 */
async function main(): Promise<void> {
  trace(`boot packaged=${app.isPackaged} argv=${JSON.stringify(process.argv.slice(1))} portableDir=${process.env['PORTABLE_EXECUTABLE_DIR'] ?? ''}`)
  // A throwaway state directory implies a throwaway IDENTITY as well: Electron keys its
  // single-instance lock to `userData`, so without this a second copy (a test harness, the
  // end-to-end script, a parallel dev instance) is refused the moment the user's own copy
  // is running — and silently attaches to the user's configuration instead.
  const stateOverride = process.env['VD_STATE_DIR']
  if (stateOverride !== undefined && stateOverride !== '') {
    app.setPath('userData', stateOverride)
    app.setPath('sessionData', stateOverride)
  }
  // A second instance would race for the port and confuse the extension, which
  // only ever remembers one.
  if (!app.requestSingleInstanceLock()) {
    trace('single-instance lock refused, quitting')
    app.quit()
    return
  }
  trace('single-instance lock acquired')
  app.on('second-instance', () => {
    if (host !== undefined) showWindow(host.url)
  })

  nativeTheme.themeSource = 'dark'
  Menu.setApplicationMenu(null)

  await app.whenReady()
  trace(`whenReady userData=${app.getPath('userData')}`)
  // `VD_STATE_DIR` lets the end-to-end script point the whole app at a throwaway
  // directory, so verification never touches the real configuration or downloads.
  const stateDir = app.getPath('userData')
  host = await startHostServer({
    stateDir,
    defaultDownloadDir: app.getPath('downloads'),
    staticDir: join(__dirname, 'renderer'),
    version: version(),
    basePort: 47_821,
    pickDirectory,
  })
  trace(`host listening on ${host.url}`)
  createWindow(host.url)
  createTray(host.url)
  trace('window and tray created')

  app.on('activate', () => {
    if (host !== undefined) showWindow(host.url)
  })
}

app.on('window-all-closed', () => {
  trace('window-all-closed')
  // The window normally hides instead of closing, so this is only reached on the
  // real quit path (and on macOS, where the tray keeps the app alive).
  if (quitting) app.quit()
})

app.on('before-quit', () => {
  trace('before-quit')
  quitting = true
  tray?.destroy()
  tray = undefined
  const live = host
  host = undefined
  void live?.close()
})

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  trace(`startup failed: ${message}`)
  void dialog.showErrorBox('视频下载器启动失败', message)
  app.quit()
})
