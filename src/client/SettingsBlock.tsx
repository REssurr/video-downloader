/**
 * `SettingsBlock` — the collapsible preference editor inside the panel.
 *
 * One field per stored setting, each saved on its own: filename template, proxy,
 * media policy and which client fetches the bytes. Nothing here is a guess about a
 * site — those preferences are the user's, and what is on screen is what is stored.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { DownloaderConfig, DownloaderStore } from './store.js'

/** A muted label. */
const MUTED = 'var(--dsw-alias-label-tertiary, #7d838f)'

/** A compact input style. */
const INPUT: Record<string, string | number> = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 6px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l2, #3a3a44)',
  background: 'var(--dsw-alias-bg-layer-1, #0c0c10)',
  color: 'inherit',
  font: 'inherit',
}

/** A compact button style. */
function buttonStyle(disabled = false): Record<string, string | number> {
  return {
    padding: '4px 10px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2, #3a3a44)',
    background: 'var(--dsw-alias-bg-layer-1, #0c0c10)',
    color: disabled ? 'var(--dsw-alias-label-quaternary, #5b606b)' : 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    font: 'inherit',
    opacity: disabled ? 0.6 : 1,
  }
}

/** Props for the settings block. */
export interface SettingsBlockProps {
  readonly store: DownloaderStore
  readonly config: DownloaderConfig
  readonly open: boolean
}

/**
 * Render the settings block.
 * @param props - the store, the live config, and whether the block is expanded.
 * @returns the block.
 */
export function SettingsBlock({ store, config, open }: SettingsBlockProps): ReactNode {
  const [template, setTemplate] = useState(config.filenameTemplate)
  const [proxy, setProxy] = useState(config.proxy)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <button
        type="button"
        onClick={() => { store.setSettingsOpen(!open) }}
        style={{ alignSelf: 'flex-start', border: 'none', background: 'transparent', color: MUTED, cursor: 'pointer', font: 'inherit', fontSize: '11px', padding: 0 }}
      >
        {open ? '▾ 收起设置' : '▸ 设置'}
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '11px', color: MUTED }}>文件名模板（可用 %(title)s 与 %(ext)s）</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input value={template} onChange={(event) => { setTemplate(event.currentTarget.value) }} style={INPUT} spellCheck={false} />
              <button
                type="button"
                disabled={template.trim() === '' || template === config.filenameTemplate}
                onClick={() => { void store.setConfig({ filenameTemplate: template.trim() }) }}
                style={buttonStyle(template.trim() === '' || template === config.filenameTemplate)}
              >
                保存
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '11px', color: MUTED }}>
              代理（本程序自己的请求用；留空 = 自动读系统代理，off = 强制直连）
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                value={proxy}
                onChange={(event) => { setProxy(event.currentTarget.value) }}
                placeholder="http://127.0.0.1:65532"
                style={INPUT}
                spellCheck={false}
              />
              <button
                type="button"
                disabled={proxy.trim() === config.proxy}
                onClick={() => { void store.setConfig({ proxy: proxy.trim() }) }}
                style={buttonStyle(proxy.trim() === config.proxy)}
              >
                保存
              </button>
            </div>
            <div style={{ fontSize: '11px', color: MUTED }}>
              浏览器能打开、这里打不开时，多半就是这一项：Node 默认不使用 Windows 系统代理。
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px', color: MUTED }}>
              <input
                type="checkbox"
                checked={config.mp4Only}
                onChange={(event) => { void store.setConfig({ mp4Only: event.currentTarget.checked }) }}
              />
              只提供 mp4（可直接播放的 MP4，同一清晰度只留一个）
            </label>
            <div style={{ fontSize: '11px', color: MUTED }}>
              开启后 webm 一类不再列出，同一清晰度的多个码率合并成一个、保留码率最高的。关掉可恢复网站的全部格式。
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '11px', color: MUTED }}>谁来下载（扩展下载 = 借用你浏览器已通过校验的身份）</div>
            <select
              value={config.downloadPath}
              onChange={(event) => {
                const value = event.currentTarget.value
                if (value === 'auto' || value === 'page' || value === 'host') {
                  void store.setConfig({ downloadPath: value })
                }
              }}
              style={INPUT}
            >
              <option value="auto">自动：先本程序直连，被站点拒绝时自动改用扩展下载</option>
              <option value="page">优先扩展：先交给浏览器扩展（用浏览器的身份）</option>
              <option value="host">只用本程序：从不使用扩展</option>
            </select>
            <div style={{ fontSize: '11px', color: MUTED }}>
              本程序与浏览器是不同的 HTTP 客户端：站点把校验绑在客户端上时（Cloudflare 那类），只有浏览器扩展能把字节取回来。
              默认顺序是「本程序先试、被拒再交给扩展」——本程序直连更快、可断点续传，而扩展只在真正需要浏览器身份时才用得上。
              只有扩展才有救援作用的场景（比如媒体也被校验绑住），把这项设成「优先扩展」。
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
