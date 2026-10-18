/**
 * Turning a network failure into something a user can act on.
 *
 * `fetch failed` is undici's message for everything: DNS, a blocked TCP connect, a
 * TLS error, a timeout. The actionable facts live in `error.cause` (and, for a
 * connect timeout, in the `AggregateError` under it, which names every address it
 * tried), and a `403` means something entirely different when it is Cloudflare's
 * browser challenge rather than a missing login.
 *
 * This module exists because that difference decided a real debugging session:
 * the user could open the page in the app's own browser while the app reported
 * "fetch failed", and nothing in the panel said "your system proxy is on and this
 * request did not use it".
 *
 * Everything here is pure: errors, headers and a body sample in, one message out.
 */
import type { ProxySetting } from './proxy.js'

/** Codes this module can classify; a probe failure code when it reaches the wire. */
export type DiagnosedCode = 'http-error' | 'challenge' | 'timeout'

/** One classified failure, ready to show. */
export interface Diagnosis {
  /** Machine-readable class. */
  readonly code: DiagnosedCode
  /** What the user reads in the panel. */
  readonly message: string
  /** The raw chain, kept for the diagnostics view. */
  readonly detail?: string
}

/** One link of an error's cause chain. */
interface CauseLink {
  readonly name: string
  readonly code?: string
  readonly message: string
  readonly addresses: readonly string[]
}

/** Error codes that mean "the certificate could not be verified". */
const TLS_CODES = [
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]

/**
 * Flatten an error into its cause chain.
 *
 * `AggregateError.errors` is walked too: undici reports a connect timeout as one
 * aggregate whose members carry the address each attempt failed on, which is
 * exactly what tells "no route to that host" apart from "the proxy is down".
 * @param error - any thrown value.
 * @returns the chain, outermost first.
 */
export function causeChain(error: unknown): readonly CauseLink[] {
  const links: CauseLink[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 5 || seen.has(value)) return
    seen.add(value)
    if (typeof value !== 'object') return
    const record = value as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; errors?: unknown; address?: unknown; port?: unknown }
    const addresses: string[] = []
    if (typeof record.address === 'string') {
      addresses.push(typeof record.port === 'number' ? `${record.address}:${record.port}` : record.address)
    }
    // An `AggregateError`'s members are VISITED below and report their own
    // addresses, so they are deliberately not read twice here — a duplicated
    // address list reads like two attempts were made against each address.
    links.push({
      name: typeof record.name === 'string' ? record.name : 'Error',
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
      message: typeof record.message === 'string' ? record.message : String(value),
      addresses,
    })
    if (Array.isArray(record.errors)) {
      for (const member of record.errors) visit(member, depth + 1)
    }
    visit(record.cause, depth + 1)
  }
  visit(error, 0)
  return links
}

/** Render a chain as one line for the diagnostics view. */
function renderChain(links: readonly CauseLink[]): string {
  return links
    .map(link => `${link.name}${link.code === undefined ? '' : `/${link.code}`}: ${link.message}${link.addresses.length === 0 ? '' : ` [${[...new Set(link.addresses)].join(', ')}]`}`)
    .join('  <-  ')
}

/** Every distinct address the failed attempts named. */
function addressesOf(links: readonly CauseLink[]): readonly string[] {
  return [...new Set(links.flatMap(link => link.addresses))]
}

/**
 * Describe why a page fetch failed.
 * @param error - the thrown value from `fetch` or the tunnel client.
 * @param context - the proxy decision that was in force, for an honest hint.
 * @returns the classification and the message to show.
 */
export function describeFetchError(error: unknown, context: { readonly proxy?: ProxySetting; readonly systemProxyHint?: string }): Diagnosis {
  const links = causeChain(error)
  const codes = new Set(links.map(link => link.code).filter((code): code is string => code !== undefined))
  const detail = renderChain(links)
  const addresses = addressesOf(links)
  const addressNote = addresses.length === 0 ? '' : `（尝试过 ${addresses.slice(0, 4).join('、')}）`
  const via = context.proxy?.url === undefined ? '' : `经代理 ${context.proxy.url} `

  if (TLS_CODES.some(code => codes.has(code))) {
    return {
      code: 'http-error',
      message: `TLS 证书校验失败${context.proxy?.url === undefined ? '' : `（代理 ${context.proxy.url} 可能在做中间人解密，需要改用 https 代理或导入其证书）`}`,
      detail,
    }
  }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    return { code: 'http-error', message: `DNS 解析失败：找不到该域名${context.proxy?.url === undefined ? '' : `（经代理 ${context.proxy.url} 解析）`}`, detail }
  }
  if (codes.has('ECONNREFUSED')) {
    return { code: 'http-error', message: `${via}连接被拒绝${addressNote}`, detail }
  }
  if (codes.has('UND_ERR_CONNECT_TIMEOUT') || codes.has('ETIMEDOUT') || codes.has('UND_ERR_HEADERS_TIMEOUT')) {
    const hint = context.proxy?.url !== undefined
      ? `经代理 ${context.proxy.url} 仍无法在超时时间内建立连接：代理未运行、规则没命中该站，或该站被代理本身拒绝`
      : context.systemProxyHint === undefined
        ? '本机直连被阻断（浏览器能打开而这里失败，通常就是需要代理；请在「设置」里填写代理地址）'
        : `本程序没有使用系统代理（检测到 ${context.systemProxyHint}），请在「设置」里填写同一地址`
    return { code: 'timeout', message: `连接超时：${hint}${addressNote}`, detail }
  }
  if (codes.has('ECONNRESET') || codes.has('UND_ERR_SOCKET') || codes.has('EPIPE')) {
    return { code: 'http-error', message: `${via}连接被重置${addressNote}`, detail }
  }
  if (codes.has('ABORT_ERR') || links.some(link => link.name === 'TimeoutError')) {
    return { code: 'timeout', message: '请求超时', detail }
  }
  return { code: 'http-error', message: `无法抓取页面：${links[0]?.message ?? String(error)}${addressNote}`, detail }
}

/**
 * Whether a response is a bot challenge rather than a real refusal.
 *
 * Cloudflare marks its interstitials explicitly (`cf-mitigated: challenge`), which
 * is the reliable signal; the body test is a fallback for the same page served
 * without that header. Both matter because the fix is different from "log in":
 * no HTTP client can pass it, the request has to come from a real browser.
 * @param status - the HTTP status.
 * @param headers - the response headers.
 * @param bodySample - the first few KB of the body, when available.
 * @returns whether this is a browser challenge.
 */
export function isChallengeResponse(status: number, headers: Headers, bodySample: string): boolean {
  const mitigated = (headers.get('cf-mitigated') ?? '').toLowerCase()
  if (mitigated.includes('challenge')) return true
  if (status !== 403 && status !== 503) return false
  const server = (headers.get('server') ?? '').toLowerCase()
  if (!server.includes('cloudflare')) return false
  return /just a moment|cf-chl|_cf_chl_|challenge-platform|enable javascript and cookies/i.test(bodySample)
}

/** How a page's non-2xx answer is described. */
export interface HttpFailureInput {  readonly status: number
  readonly headers: Headers
  readonly bodySample: string
  readonly proxy?: ProxySetting
}

/**
 * Describe a non-2xx answer from a page.
 * @param input - status, headers, a body sample, and the proxy in force.
 * @returns the classification and the message to show.
 */
export function describeHttpFailure(input: HttpFailureInput): Diagnosis {
  const { status, headers, bodySample } = input
  const via = input.proxy?.url === undefined ? '' : `（经代理 ${input.proxy.url}）`
  if (isChallengeResponse(status, headers, bodySample)) {
    return {
      code: 'challenge',
      message: '站点弹出了浏览器校验（Cloudflare「Just a moment…」）：纯 HTTP 客户端过不去。'
        + '请在浏览器里打开该页并通过校验，然后用「抓当前页」把媒体地址交给页面自己下载。',
      detail: `HTTP ${status}，server=${headers.get('server') ?? '?'}，cf-mitigated=${headers.get('cf-mitigated') ?? '-'}`,
    }
  }
  if (status === 401) return { code: 'http-error', message: `站点要求登录${via}`, detail: `HTTP ${status}` }
  if (status === 403) return { code: 'http-error', message: `站点拒绝访问（可能需要登录或防盗链）${via}`, detail: `HTTP ${status}` }
  if (status === 404) return { code: 'http-error', message: `页面不存在（HTTP 404）${via}`, detail: `HTTP ${status}` }
  if (status === 429) return { code: 'http-error', message: `请求过于频繁，被站点限流（HTTP 429）${via}`, detail: `HTTP ${status}` }
  if (status >= 500) return { code: 'http-error', message: `站点服务器错误（HTTP ${status}）${via}`, detail: `HTTP ${status}` }
  return { code: 'http-error', message: `页面返回 HTTP ${status}${via}`, detail: `HTTP ${status}` }
}

/**
 * Describe a MEDIA request that was refused.
 *
 * A page and a media file fail for different reasons, and the old message
 * ("服务器返回 HTTP 403") named neither. The distinction that matters here is
 * that the Host is a different client than the browser: a media URL the browser
 * plays happily can still refuse this process, and the two usual causes are
 * hotlink protection (no `Referer`) and a signed URL that has expired.
 * @param status - the HTTP status the media host answered with.
 * @returns the sentence to show on the job row.
 */
export function describeMediaFailure(status: number): string {
  if (status === 401 || status === 403) {
    return `媒体地址被拒绝（HTTP ${status}）：多半是防盗链或站点校验。可重开页面复制一条新的直链，`
      + '或改用「扩展下载」——由你已通过校验的那个浏览器页面去取字节'
  }
  if (status === 404 || status === 410) return `直链已失效（HTTP ${status}）：签名多半过期了，回页面重新复制一条`
  if (status === 429) return '被站点限流（HTTP 429）：过一会儿再试'
  if (status >= 500) return `媒体服务器错误（HTTP ${status}）`
  return `服务器返回 HTTP ${status}`
}
