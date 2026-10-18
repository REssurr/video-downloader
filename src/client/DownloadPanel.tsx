/**
 * `DownloadPanel` — the dark floating box.
 *
 * One thing to press, and everything else behind a drawer:
 *
 *   1. **抓当前页** reads the extension's page and lists the whole files it is playing; the
 *      **网址** box does the same for an address the user types — a media URL becomes a
 *      row directly, a page address is opened in the browser through the extension and
 *      read there. The page is the only client that inherits the clearance it passed, so a
 *      page (or the site's own API, through a site adapter inside that page) is the only
 *      thing that can produce a downloadable file (see 「扩展下载」 in the README).
 *   2. The list is one row per file, highest quality first. Nothing downloads until the
 *      user presses a row's own button.
 *   3. Progress rows stream in from the Host over the event channel; the panel says
 *      whether it is live (`● 实时`) or polling, and the list stays three rows tall
 *      however many jobs there are.
 *   4. 设置 and 诊断 are two collapsed drawers at the bottom, so the surface stays short
 *      until something needs to be changed or explained.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { JobView, MuxerStatus } from './api-types.js'
import { EMPTY_GUEST, type ConnectivityReport, type GuestCapabilities } from './extension-bridge.js'
import { PANEL_WIDTH } from './layout.js'
import { hasUrlPayload, urlFromTransfer } from './dropped-url.js'
import { formatBytes, formatEta, formatSpeed, percentOf } from './format.js'
import type { HarvestReport } from './guest-harvester.js'
import { DARK_SURFACE } from './dark-surface.js'
import { t } from './locale.js'
import { type DownloaderStore, type StoreSnapshot } from './store.js'
import { VideoPicker } from './VideoPicker.js'
import { SettingsBlock } from './SettingsBlock.js'

/** The panel's dark surface, on the theme's own layer tokens. */
const SHELL: Record<string, string | number> = {
  // One override darkens the whole box: see DARK_SURFACE for why the tokens are
  // redefined here instead of every element being restyled.
  ...(DARK_SURFACE as unknown as Record<string, string | number>),
  position: 'relative',
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  minWidth: `${PANEL_WIDTH}px`,
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '12px',
  overflowY: 'auto',
  zIndex: 1,
  pointerEvents: 'auto',
  borderRadius: 0,
  border: 'none',
  background: 'var(--dsw-alias-bg-layer-3, #16161c)',
  boxShadow: 'none',
  color: 'var(--dsw-alias-label-primary, #e7e7ea)',
  font: '13px/1.5 var(--dsw-font-family, system-ui, sans-serif)',
}

/** A muted line of text. */
const MUTED = 'var(--dsw-alias-label-tertiary, #7d838f)'
const HAIRLINE = '1px solid var(--dsw-alias-border-l2, #3a3a44)'

/**
 * How many task rows the collapsed panel shows.
 *
 * Three is what fits without the panel becoming a log: the list is newest-first, so the
 * three that matter (what is running, what just finished) are the three on screen.
 * 「展开全部」 renders the REST without any nested scroller — the panel itself scrolls,
 * because a box that scrolls inside a box that scrolls is how a list ends up looking
 * like it lost its tail.
 */
const JOBS_VISIBLE_ROWS = 3

/**
 * A quiet button: everything that is not the one primary action.
 * @param disabled - dimmed and inert.
 * @param primary - the accent-filled button, used once per panel.
 * @returns the style object.
 */
function buttonStyle(disabled: boolean, primary = false): Record<string, string | number> {
  if (primary) {
    return {
      flex: 'none',
      padding: '6px 14px',
      borderRadius: '7px',
      border: '1px solid transparent',
      background: disabled ? 'var(--dsw-alias-border-l2, #3a3a44)' : 'var(--dsw-alias-label-primary, #e7e7ea)',
      color: disabled ? MUTED : 'var(--dsw-alias-bg-layer-3, #16161c)',
      cursor: disabled ? 'default' : 'pointer',
      font: 'inherit',
      fontWeight: 600,
    }
  }
  return {
    flex: 'none',
    padding: '4px 9px',
    borderRadius: '6px',
    border: `1px solid ${disabled ? 'var(--dsw-alias-border-l2, #3a3a44)' : 'var(--dsw-alias-border-l2, #3a3a44)'}`,
    background: 'transparent',
    color: disabled ? 'var(--dsw-alias-label-quaternary, #5b606b)' : 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    font: 'inherit',
    fontSize: '12px',
  }
}

/**
 * The URL field: the one place in this panel where the user types.
 *
 * Styled from the same tokens as the buttons so the box does not become a bright
 * rectangle on the dark surface (the browser's own default input would).
 */
const INPUT_STYLE: Record<string, string | number> = {
  flex: 1,
  minWidth: 0,
  padding: '4px 8px',
  borderRadius: '6px',
  border: HAIRLINE,
  background: 'var(--dsw-alias-bg-layer-1, #0c0c10)',
  color: 'inherit',
  font: 'inherit',
  fontSize: '12px',
}

/** A section heading, one line, small. */
function Heading({ children }: { children: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', paddingTop: '2px' }}>
      <span style={{ fontSize: '11px', letterSpacing: '0.04em', color: MUTED }}>{children}</span>
    </div>
  )
}

/** The status line for one job. */
export function jobDetail(job: JobView): string {
  if (job.status === 'queued') return '排队中'
  if (job.status === 'running') {
    const parts = [
      `${formatBytes(job.receivedBytes)}${job.totalBytes === undefined ? '' : ` / ${formatBytes(job.totalBytes)}`}`,
    ]
    const speed = formatSpeed(job.speedBytesPerSecond)
    if (speed !== '') parts.push(speed)
    const eta = formatEta(job.receivedBytes, job.totalBytes, job.speedBytesPerSecond)
    if (eta !== '') parts.push(`剩 ${eta}`)
    return parts.join(' · ')
  }
  if (job.status === 'done') return `完成 → ${job.outputPath ?? ''}`
  if (job.status === 'skipped') return `已保留旧文件，未下载 → ${job.outputPath ?? ''}`
  if (job.status === 'cancelled') return '已取消'
  return job.error ?? '失败'
}

/** The progress percentage, when a total is known. */
export function jobPercent(job: JobView): number | undefined {
  return percentOf(job.receivedBytes, job.totalBytes)
}

/** One job row: what it is, how far along, and the three things one can do to it. */
function JobRow({ job, store }: { job: JobView; store: DownloaderStore }): ReactNode {
  const percent = jobPercent(job)
  const tone = job.status === 'failed'
    ? 'var(--dsw-alias-state-error-primary, #f2a1a1)'
    : job.status === 'done'
      ? 'var(--dsw-alias-state-success-primary, #7dd3a0)'
      : 'var(--dsw-alias-label-secondary, #9aa0aa)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', padding: '6px 0' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' }} title={job.title}>
          {job.title}
        </span>
        <span style={{ flex: 'none', color: tone, fontSize: '11px' }}>{job.status === 'running' ? `${percent ?? 0}%` : (job.status === 'done' ? '完成' : '')}</span>
        <button
          type="button"
          onClick={() => { void store.reveal(job.id) }}
          title={job.outputPath === undefined ? '在文件管理器里打开下载目录' : `在文件管理器里打开：${job.outputPath}`}
          style={{ ...buttonStyle(false), border: 'none', color: MUTED, padding: '2px 4px' }}
        >
          打开本地目录
        </button>
        {(job.status === 'running' || job.status === 'queued') && (
          <button
            type="button"
            onClick={() => { store.cancel(job.id) }}
            style={{ ...buttonStyle(false), border: 'none', color: MUTED, padding: '2px 4px' }}
          >
            {t('panel.cancel')}
          </button>
        )}
      </div>
      {percent !== undefined && job.status === 'running' && (
        <div style={{ height: '3px', borderRadius: '2px', background: 'var(--dsw-alias-border-l2, #3a3a44)' }}>
          <div style={{ width: `${percent}%`, height: '100%', borderRadius: '2px', background: 'var(--dsw-alias-label-primary, #e7e7ea)' }} />
        </div>
      )}
      <div style={{ fontSize: '11px', color: tone, wordBreak: 'break-all' }}>{jobDetail(job)}</div>
    </div>
  )
}

/**
 * The one diagnostic surface: everything the app can check, in one drawer.
 *
 * It exists because "nothing happened" is the least actionable thing a panel can say,
 * and the three questions behind it — can this page run a script, can its requests reach
 * the Host, may a script read the media — have three different fixes. The harvest report
 * rides along, so a short list can be explained by the evidence that produced it.
 */
function DiagnosticsDrawer({ open, report, check, checking, onRun, notes, merge }: {
  readonly open: boolean
  readonly report?: HarvestReport | undefined
  readonly check?: ConnectivityReport | undefined
  readonly checking: boolean
  readonly onRun: () => void
  readonly notes: readonly string[]
  /** What this machine can merge separated tracks with, as the Host answered. */
  readonly merge?: MuxerStatus | undefined
}): ReactNode {
  if (!open) return undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 10px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2, #101015)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ flex: 1, fontSize: '11px', color: MUTED }}>诊断（不会下载任何东西）</span>
        <button type="button" disabled={checking} onClick={onRun} style={buttonStyle(checking)}>
          {checking ? '检查中…' : '重新检查'}
        </button>
      </div>
      {/*
        The machine fact, stated before the page facts: whether a 视频轨 + 音轨 pair can be
        produced HERE is not something about the site, and it is the one explanation for a
        missing 1080P row that no amount of reading the page can supply.
      */}
      {merge !== undefined && (
        <div style={{ fontSize: '11px', wordBreak: 'break-all', color: merge.available ? 'var(--dsw-alias-state-success-primary, #7dd3a0)' : 'var(--dsw-alias-state-warning-primary, #d8a657)' }}>
          {merge.available ? '✔' : '✘'} 合并分离音视频：{merge.available
            ? `本机 ffmpeg 可用（${merge.version ?? merge.path ?? ''}），比整份文件更高的档位会下载视频轨与音轨再合成 mp4`
            : `没有找到 ffmpeg.exe${merge.reason === undefined ? '' : `（${merge.reason}）`}，只有分离音视频的清晰度不会出现在列表里；把 ffmpeg.exe 放到 %APPDATA%\\video-downloader\\tools\\bin 即可`}
        </div>
      )}
      {check !== undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px' }}>
          {check.lines.map((line, index) => (
            <div
              key={index}
              style={{
                color: line.ok === true
                  ? 'var(--dsw-alias-state-success-primary, #7dd3a0)'
                  : line.ok === false
                    ? 'var(--dsw-alias-state-warning-primary, #d8a657)'
                    : MUTED,
                wordBreak: 'break-all',
              }}
            >
              {line.ok === true ? '✔' : line.ok === false ? '✘' : '·'} {line.label}：{line.detail}
            </div>
          ))}
          <div style={{ color: check.usable ? 'var(--dsw-alias-state-success-primary, #7dd3a0)' : 'var(--dsw-alias-state-warning-primary, #d8a657)' }}>
            {check.summary}
          </div>
        </div>
      )}
      {notes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: MUTED }}>
          {notes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      )}
      {report !== undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px', color: MUTED }}>
          <div>
            抓取：可用地址 {report.candidates} 个 · 证据：播放器 {report.evidence.videos} / og {report.evidence.og} / source {report.evidence.sources} / 请求 {report.evidence.perf} / 数据 {report.evidence.jsonLd} / 链接 {report.evidence.links}
            {report.mediaSourceVideos > 0 ? ` · 播放器用 MSE（${report.mediaSourceVideos} 个 blob）` : ''}
          </div>
          {report.site !== undefined && (
            <div style={{ wordBreak: 'break-all' }}>
              站点适配器（{report.site.name}）：
              {report.site.notes.length === 0 ? '本次没有拿到整份文件（原因见下）' : report.site.notes.join('；')}
            </div>
          )}
          {report.quality !== undefined && (
            <div style={{ wordBreak: 'break-all' }}>
              清晰度：{report.quality.rungs.length === 0 ? '网站没有在页面里公布档位' : report.quality.rungs.join(' / ')}
              {report.quality.got === undefined ? '' : ` · 可下载：${report.quality.got}`} —— {report.quality.why}
            </div>
          )}
          {report.refused.map((item, index) => (
            <div key={index} style={{ wordBreak: 'break-all' }}>未采用：{item.url} —— {item.why}</div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Render the dark floating panel.
 * @param props - the store, the current snapshot, and the key's anchor.
 * @returns the panel.
 */
export function DownloadPanel({ store, snapshot }: DownloadPanelProps): ReactNode {
  const state = snapshot.state
  const config = state?.config
  const probe = snapshot.probe
  const jobs = state?.jobs ?? []
  const harvesting = snapshot.harvesting === true
  /**
   * What the line next to 「抓当前页」 says when no page can be named.
   *
   * "Not connected" and "connected but no tab yet" are different problems with different
   * fixes, and the old sentence ("扩展还没有看到可读取的页面") read like a page problem even
   * when the extension had never been installed at all.
   */
  const guestHint = state?.extension.connected === true
    ? '扩展已连接，但还没看到标签页：切一下浏览器标签'
    : '浏览器扩展未连接：右键托盘图标 →「导出浏览器扩展…」，再在浏览器扩展页加载它'
  // The clamp below is read at render time, so shrinking the window has to re-render
  // this box: the key's anchor does not change when the window does, so nothing else
  // would wake it up and the panel would hang off the right edge.
  const [, setViewportRevision] = useState(0)
  useEffect(() => {
    const onResize = (): void => { setViewportRevision(revision => revision + 1) }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  /** What is in the URL box. Kept in the store: a drop can arrive while the panel is
   * closed (on the key), and it has to end up in the box that is about to open. */
  const address = snapshot.address ?? ''
  /** Whether an address is being dragged over the panel right now. */
  const [dropping, setDropping] = useState(false)

  // Under the key, never a fixed corner: the key moves with the caption menubar, and a
  // panel that stayed put would look detached from the button that opened it.
  const box: Record<string, string | number> = {
    ...SHELL,
    // Said out loud while a URL hovers over the panel: the drop is accepted, and it is
    // about to replace what the box holds.
    ...(dropping ? { outline: '1px dashed var(--dsw-alias-state-success-primary, #7dd3a0)', outlineOffset: '2px' } : {}),
  }

  const [check, setCheck] = useState<ConnectivityReport | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  /** Whether the task list is showing everything instead of its first three rows. */
  const [jobsExpanded, setJobsExpanded] = useState(false)
  /**
   * The browser extension's page, as the lifetime follower last reported it.
   *
   * Read from the snapshot rather than measured here: the follower runs whether or not
   * this panel is open (that is what makes the rows current the moment it opens), so a
   * second observer in the panel would only be a second opinion.
   */
  const guest: GuestCapabilities = snapshot.guest ?? EMPTY_GUEST

  const runCheck = (): void => {
    setChecking(true)
    const media = probe?.record.entries
      .flatMap(entry => entry.options)
      .find(option => option.directUrl !== undefined)?.directUrl
    void store.diagnostics(media).then(setCheck).catch(error => {
      setCheck({
        usable: false,
        summary: '检查本身失败了（见下）。',
        lines: [{ label: '检查失败', ok: false, detail: error instanceof Error ? error.message : String(error) }],
      })
    }).finally(() => { setChecking(false) })
  }

  const openDiagnostics = (): void => {
    const next = !diagnosticsOpen
    setDiagnosticsOpen(next)
    // Filled on first open rather than on every open: the check touches the page.
    if (next && check === undefined) runCheck()
  }

  return (
    <div
      style={box}
      data-dsh-video-downloader-panel=""
      // A URL dragged in from an external browser is the same act as typing one — with
      // the one difference that it REPLACES the box's contents instead of adding to
      // them. `preventDefault` on the drop is also what stops the browser from inserting
      // the dragged text into the input at the caret, so the box can never end up holding
      // the old address and the new one glued together.
      onDragOver={(event) => {
        if (!hasUrlPayload(event.dataTransfer)) return
        // Without this the browser refuses the drop and shows the "cannot drop" cursor.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(event) => {
        // `dragleave` fires for every child the pointer crosses; only one that lands
        // outside the panel means the drag has left.
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        setDropping(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDropping(false)
        const url = urlFromTransfer(event.dataTransfer)
        if (url === undefined) return
        void store.dropAddress(url)
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <strong style={{ flex: 1, fontSize: '13px' }}>{t('panel.title')}</strong>
        {/*
          A switch, not a badge: the follower now runs for the app's whole lifetime, so
          the user needs a way to stop it reading pages they are not working on.
        */}
        <button
          type="button"
          aria-pressed={snapshot.following === true}
          onClick={() => { store.setFollowing(snapshot.following !== true) }}
          title={snapshot.following === true
            ? '浏览器换页时会自动重新读取（点一下关闭）'
            : '打开后，浏览器换页、换集时自动读取'}
          style={{
            ...buttonStyle(false),
            border: 'none',
            padding: '2px 4px',
            color: snapshot.following === true ? 'var(--dsw-alias-state-success-primary, #7dd3a0)' : MUTED,
          }}
        >
          {snapshot.following === true ? '● 跟随页面' : '○ 跟随页面'}
        </button>
        <span style={{ fontSize: '11px', color: MUTED }}>{snapshot.live ? t('panel.live') : t('panel.polling')}</span>
        {/*
          Whether this machine can join a 视频轨 + 音轨 pair, at a glance.
          The user asked for 「把更高清的分离流合并为 mp4」, so whether that is possible HERE
          is the one fact they need before wondering why a 1080P row is missing — and it is a
          fact about the machine, which no amount of reading the page can supply.
        */}
        {state?.merge !== undefined && (
          <span
            style={{
              fontSize: '11px',
              color: state.merge.available ? 'var(--dsw-alias-state-success-primary, #7dd3a0)' : MUTED,
            }}
            title={state.merge.available
              ? `本机 ffmpeg：${state.merge.version ?? state.merge.path ?? ''} —— 比整份文件更高的档位会下载视频轨与音轨，再合成一个 mp4`
              : `${state.merge.reason ?? '没有找到 ffmpeg.exe'} —— 只有分离音视频的清晰度不会出现在列表里；把 ffmpeg.exe 放到 %APPDATA%\\video-downloader\\tools\\bin 即可`}
          >
            {state.merge.available ? 'ffmpeg 已就绪' : '无 ffmpeg'}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          type="button"
          disabled={guest.url === undefined || harvesting}
          onClick={() => {
            if (guest.url === undefined) return
            void store.harvestCurrentPage({
              url: guest.url,
              ...(guest.title === undefined || guest.title === '' ? {} : { title: guest.title }),
            })
          }}
          title="读取浏览器当前标签页里的视频地址（不会自动开始下载）"
          style={buttonStyle(guest.url === undefined || harvesting, true)}
        >
          {harvesting ? '读取中…' : '抓当前页'}
        </button>
        <span
          style={{ flex: 1, minWidth: 0, fontSize: '11px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={guest.url ?? guestHint}
        >
          {guest.url === undefined
            ? guestHint
            : (guest.title === undefined || guest.title === '' ? guest.url : guest.title)}
        </span>
      </div>

      {/*
        With following OFF the follower deliberately reads nothing, so a page that moved
        leaves the panel holding rows for a video that is no longer on screen. Saying so is
        the difference between "nothing happened" and "press the button".
      */}
      {snapshot.following !== true && guest.url !== undefined && probe !== undefined && guest.url !== probe.record.url && (
        <div style={{ fontSize: '11px', color: MUTED }}>页面已改变，点「抓当前页」重新读取（或打开「跟随页面」）。</div>
      )}

      {/*
        The address box. It is the same job as 抓当前页 with a different starting point: a
        page address is opened in the browser through the extension (that page is where
        the site's own session lives, and a site adapter inside it is what makes bilibili
        while a media file URL becomes a row directly — no page needed to name a file
        that is already a file.
      */}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (address.trim() === '' || harvesting) return
          void store.readAddress(address)
        }}
        style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
      >
        <input
          value={address}
          onChange={(event) => { store.setAddress(event.currentTarget.value) }}
          placeholder="粘贴视频页地址，或 .mp4 之类的媒体直链"
          spellCheck={false}
          aria-label="网址"
          style={INPUT_STYLE}
        />
        <button
          type="submit"
          disabled={address.trim() === '' || harvesting}
          title="视频页会在浏览器里打开并自动读取；看起来是媒体文件的直链会直接变成下面的一行"
          style={buttonStyle(address.trim() === '' || harvesting)}
        >
          读取
        </button>
      </form>

      {snapshot.opening !== undefined && (
        <div
          style={{ fontSize: '11px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={snapshot.opening}
        >
          已在浏览器中打开，等页面就绪后自动读取…
        </div>
      )}

      {dropping && (
        <div style={{ fontSize: '11px', color: 'var(--dsw-alias-state-success-primary, #7dd3a0)' }}>
          松手即读取这个地址（会覆盖网址框里的内容）
        </div>
      )}

      {snapshot.error !== undefined && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            padding: '6px 8px',
            borderRadius: '8px',
            background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #f2a1a1) 12%, transparent)',
            color: 'var(--dsw-alias-state-error-primary, #f2a1a1)',
            fontSize: '11px',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{snapshot.error.message}</span>
          <button type="button" onClick={() => { store.clearError() }} style={{ ...buttonStyle(false), border: 'none', color: 'inherit', padding: 0 }}>知道了</button>
        </div>
      )}

      {probe !== undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', borderTop: HAIRLINE, paddingTop: '6px' }}>
          <Heading>可下载（{probe.record.entries.length}）</Heading>
          <VideoPicker store={store} probe={probe} pageTitle={probe.record.pageTitle} />
        </div>
      )}

      {probe === undefined && !harvesting && snapshot.harvest !== undefined && (
        <div style={{ fontSize: '12px', color: MUTED }}>没有找到可整份下载的文件（若页面还在加载，会自动重读）。点下面的「诊断」看这个页面里有什么。</div>
      )}

      {/*
        The quality answer, on the surface rather than only in 诊断: "this page has three
        qualities and not one of them can be fetched whole" is the least guessable thing
        about an empty list, and "the site has 1080P+ but the whole-file channel stops at
        720P" is the least guessable thing about a short one.
      */}
      {snapshot.harvest?.quality !== undefined && (
        <div
          style={{ fontSize: '11px', color: MUTED, wordBreak: 'break-all' }}
          title={snapshot.harvest.quality.why}
        >
          {snapshot.harvest.quality.hint}
        </div>
      )}

      {jobs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', borderTop: HAIRLINE, paddingTop: '6px' }}>
          <Heading>{t('panel.jobs')}（{jobs.length}）</Heading>
          {/*
            Collapsed: the newest three. Expanded: EVERY job, with no inner max-height or
            scroller of its own — the panel is the one thing that scrolls, so the whole
            list is reachable with the wheel and nothing is clipped by a second viewport.
          */}
          <div data-dsh-video-downloader-jobs={jobsExpanded ? 'expanded' : 'collapsed'} style={{ display: 'flex', flexDirection: 'column' }}>
            {(jobsExpanded ? jobs : jobs.slice(0, JOBS_VISIBLE_ROWS)).map(job => <JobRow key={job.id} job={job} store={store} />)}
          </div>
          {jobs.length > JOBS_VISIBLE_ROWS && (
            <button
              type="button"
              aria-expanded={jobsExpanded}
              onClick={() => { setJobsExpanded(expanded => !expanded) }}
              style={{ ...buttonStyle(false), alignSelf: 'flex-start' }}
            >
              {jobsExpanded ? `收起（只显示最近 ${JOBS_VISIBLE_ROWS} 条）` : `展开全部（还有 ${jobs.length - JOBS_VISIBLE_ROWS} 条）`}
            </button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderTop: HAIRLINE, paddingTop: '6px' }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: '11px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={config?.downloadDir}>
          {t('panel.downloadTo')} {config?.downloadDir ?? '读取中…'}
        </span>
        <button type="button" onClick={() => { void store.pickDirectory() }} style={buttonStyle(false)}>
          {t('panel.change')}
        </button>
      </div>

      {config !== undefined && <SettingsBlock store={store} config={config} open={snapshot.settingsOpen} />}

      <DiagnosticsDrawer
        open={diagnosticsOpen}
        report={snapshot.harvest}
        check={check}
        checking={checking}
        onRun={runCheck}
        notes={probe?.record.notes ?? []}
        merge={state?.merge}
      />

      <div style={{ display: 'flex', gap: '6px' }}>
        <button type="button" onClick={openDiagnostics} style={buttonStyle(false)}>
          {diagnosticsOpen ? '▾ 诊断' : '▸ 诊断'}
        </button>
      </div>
    </div>
  )
}

/** Props for the panel. */
export interface DownloadPanelProps {
  readonly store: DownloaderStore
  readonly snapshot: StoreSnapshot
}
