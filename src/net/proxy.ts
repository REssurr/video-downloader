/**
 * Where HTTP requests should go out, and why.
 *
 * The failure this module exists for: the desktop app's own browser reaches a site
 * because Electron uses the Windows system proxy, while the Host half's Node
 * `fetch` ignores that setting entirely and dials direct — so the panel reports a
 * bare "fetch failed" for a page the user can see. Node gives no way to opt in at
 * runtime (`NODE_USE_ENV_PROXY` is read at startup and undici is not importable
 * here), so the proxy has to be resolved and used explicitly.
 *
 * Resolution order, most specific first:
 *   1. `config.proxy` — the user's own value: a URL, or `off`/`auto`;
 *   2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` from the environment;
 *   3. the Windows system proxy, read from the registry (the same setting Electron
 *      and every browser use).
 *
 * The decision itself is pure (`chooseProxy`, `shouldBypass`, `parseProxyValue`)
 * so the precedence and the bypass rules are unit-tested without a registry, a
 * network, or a platform check. Only `readSystemProxy` runs `reg.exe`.
 */
import { execFile } from 'node:child_process'

/** Where the proxy decision came from. */
export type ProxySource = 'config' | 'env' | 'system' | 'none'

/**
 * The decision as the panel shows it.
 *
 * Deliberately flat and small: it is sent with every `state` read, and its whole
 * job is to answer "which proxy are these requests using, and why" without the
 * user having to guess.
 */
export interface NetworkStatus {
  /** Whether a proxy is in force. */
  readonly proxied: boolean
  /** The proxy URL, when one is in force. */
  readonly proxy?: string
  /** Which rule produced the decision. */
  readonly source: ProxySource
  /** Why this decision was made, or why no proxy is used. */
  readonly reason?: string
}

/** The resolved decision for one request. */
export interface ProxySetting {
  /** `host:port` URL of an HTTP proxy, or undefined for a direct connection. */
  readonly url?: string
  /** Which rule produced it. */
  readonly source: ProxySource
  /** Why there is no proxy, or a caveat about the one chosen. */
  readonly reason?: string
  /** Hosts that must bypass the proxy even when it is set. */
  readonly bypass: readonly string[]
  /** Whether a proxy was found at all (false means direct, deliberately or not). */
  readonly found: boolean
}

/** What the OS reports about its proxy configuration. */
export interface SystemProxy {  /** The `ProxyEnable` registry value. */
  readonly enabled: boolean
  /** The raw `ProxyServer` value, e.g. `127.0.0.1:65532` or `http=a;https=b`. */
  readonly server?: string
  /** The raw `ProxyOverride` value. */
  readonly override?: string
  /** A PAC script URL, which this app cannot execute. */
  readonly autoConfigUrl?: string
}

/** The empty system answer, used off Windows and when the registry cannot be read. */
export const NO_SYSTEM_PROXY: SystemProxy = { enabled: false }

/** One proxy entry parsed out of `ProxyServer`. */
export interface ParsedProxyValue {
  /** A usable `http://host:port` URL, when the value is one. */
  readonly url?: string
  /** True for the explicit "never use a proxy" values. */
  readonly off?: boolean
  /** True for the "decide automatically" values (the default). */
  readonly auto?: boolean
  /** Why the value cannot be used, when it cannot. */
  readonly invalid?: string
}

/**
 * Parse one proxy value the way a user or a registry would write it.
 *
 * A bare `host:port` is accepted and read as HTTP, because that is how Windows
 * stores it and how most people paste it. SOCKS is refused rather than silently
 * mistranslated: this client speaks HTTP CONNECT only, and pretending otherwise
 * would surface as an unexplained timeout later.
 * @param raw - the value from config or the registry.
 * @returns the parsed value.
 */
export function parseProxyValue(raw: string): ParsedProxyValue {
  const value = raw.trim()
  if (value === '') return { auto: true }
  if (/^(off|none|direct|no)$/i.test(value)) return { off: true }
  if (/^(auto|system)$/i.test(value)) return { auto: true }
  if (/^(socks|socks4|socks5):\/\//i.test(value)) {
    return { invalid: '只支持 http/https 代理（不支持 socks）' }
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { invalid: `无法解析的代理地址：${value}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { invalid: `只支持 http/https 代理（收到 ${parsed.protocol}）` }
  }
  if (parsed.hostname === '' || parsed.port === '') {
    return { invalid: `代理地址需要 host:port：${value}` }
  }
  return { url: parsed.origin }
}

/**
 * Split a `ProxyOverride` value into bypass patterns.
 * @param raw - the registry value, semicolon-separated.
 * @returns the patterns, lower-cased, blanks dropped.
 */
export function parseProxyOverride(raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  return raw
    .split(';')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry !== '')
}

/**
 * Whether a host must bypass the proxy.
 *
 * Windows' own syntax is honored: `<local>` (no dot in the hostname), a bare
 * suffix (`example.com` matches it and everything under it) and `*` wildcards.
 * @param host - the request's hostname.
 * @param bypass - patterns from `parseProxyOverride`.
 * @returns whether the request must go direct.
 */
export function shouldBypass(host: string, bypass: readonly string[]): boolean {
  const name = host.toLowerCase()
  for (const pattern of bypass) {
    if (pattern === '<local>') {
      if (!name.includes('.')) return true
      continue
    }
    // A wildcard pattern is matched as written; a bare domain also covers its
    // subdomains, which is what every browser does with the same setting.
    const expression = pattern.includes('*')
      ? new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      : undefined
    if (expression !== undefined) {
      if (expression.test(name)) return true
      continue
    }
    if (name === pattern || name.endsWith(`.${pattern}`)) return true
  }
  return false
}

/**
 * Pick the proxy server out of a Windows `ProxyServer` value.
 *
 * Windows stores either one server for everything (`127.0.0.1:65532`) or a
 * per-protocol list (`http=127.0.0.1:65532;https=127.0.0.1:65532`). The `https`
 * entry is preferred for HTTPS, then `http`, then a bare value.
 * @param server - the raw value.
 * @returns the value to hand to `parseProxyValue`, or undefined.
 */
export function pickProxyServer(server: string | undefined): string | undefined {
  if (server === undefined) return undefined
  const trimmed = server.trim()
  if (trimmed === '') return undefined
  if (!trimmed.includes('=')) return trimmed
  const entries = new Map<string, string>()
  for (const part of trimmed.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    entries.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim())
  }
  return entries.get('https') ?? entries.get('http') ?? entries.get('all') ?? entries.get('socks')
}

/** The inputs `chooseProxy` decides over. */
export interface ProxyInputs {
  /** `config.proxy`: empty means "decide automatically". */
  readonly configured: string
  /** The environment, injected so the precedence is testable. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** What the OS reported. */
  readonly system: SystemProxy
}

/**
 * Resolve the proxy to use.
 * @param inputs - config value, environment, and the OS setting.
 * @returns the decision, with the reason it was made.
 */
export function chooseProxy(inputs: ProxyInputs): ProxySetting {
  const configured = parseProxyValue(inputs.configured)
  if (configured.invalid !== undefined) {
    return { source: 'none', reason: configured.invalid, bypass: [], found: false }
  }
  if (configured.off === true) {
    return { source: 'none', reason: '已在设置里关闭代理（直连）', bypass: [], found: false }
  }
  if (configured.url !== undefined) {
    return { url: configured.url, source: 'config', bypass: parseProxyOverride(inputs.system.override), found: true }
  }

  const fromEnv = inputs.env.HTTPS_PROXY ?? inputs.env.https_proxy
    ?? inputs.env.HTTP_PROXY ?? inputs.env.http_proxy
    ?? inputs.env.ALL_PROXY ?? inputs.env.all_proxy
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const parsed = parseProxyValue(fromEnv)
    if (parsed.url !== undefined) {
      return { url: parsed.url, source: 'env', bypass: parseProxyOverride(inputs.env.NO_PROXY ?? inputs.env.no_proxy), found: true }
    }
  }

  const bypass = parseProxyOverride(inputs.system.override)
  const server = pickProxyServer(inputs.system.server)
  if (inputs.system.enabled && server !== undefined) {
    const parsed = parseProxyValue(server)
    if (parsed.url !== undefined) {
      return { url: parsed.url, source: 'system', bypass, found: true }
    }
    if (parsed.invalid !== undefined) {
      return { source: 'none', reason: `系统代理无法使用：${parsed.invalid}`, bypass, found: false }
    }
  }
  if (inputs.system.autoConfigUrl !== undefined && inputs.system.autoConfigUrl !== '') {
    return {
      source: 'none',
      reason: `系统使用 PAC 脚本（${inputs.system.autoConfigUrl}），本程序无法执行；请在设置里直接填写代理地址`,
      bypass,
      found: false,
    }
  }
  return {
    source: 'none',
    reason: inputs.system.enabled ? '系统代理已启用但未填写服务器' : '未检测到系统代理',
    bypass,
    found: false,
  }
}

/** How `readSystemProxy` runs a command; injected so tests never spawn anything. */
export type ProxyExec = (file: string, args: readonly string[]) => Promise<string>

/** The registry key every Windows proxy setting lives under. */
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/**
 * Parse `reg query` output for one key.
 *
 * Output is a table: `    ProxyEnable    REG_DWORD    0x1`, one value per line.
 * @param output - the command's stdout.
 * @returns the raw values, keyed by name.
 */
export function parseRegQuery(output: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s{2,}([A-Za-z0-9_]+)\s+REG_[A-Z_]+\s+(.*?)\s*$/.exec(line)
    if (match === null) continue
    const name = match[1]
    const value = match[2]
    if (name === undefined || value === undefined) continue
    values[name] = value
  }
  return values
}

/**
 * Turn `reg query` values into a {@link SystemProxy}.
 * @param values - parsed registry values.
 * @returns the OS setting.
 */
export function systemProxyFromRegistry(values: Readonly<Record<string, string>>): SystemProxy {
  const enabled = (values.ProxyEnable ?? '0x0').toLowerCase()
  return {
    enabled: enabled === '0x1' || enabled === '1',
    ...(values.ProxyServer === undefined ? {} : { server: values.ProxyServer }),
    ...(values.ProxyOverride === undefined ? {} : { override: values.ProxyOverride }),
    ...(values.AutoConfigURL === undefined ? {} : { autoConfigUrl: values.AutoConfigURL }),
  }
}

/**
 * The default exec: one `reg query` per key, no shell.
 * @param file - the executable.
 * @param args - its arguments.
 * @returns stdout, or an empty string when the command fails.
 */
const defaultExec: ProxyExec = async (file, args) => await new Promise<string>((resolve) => {
  execFile(file, [...args], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
    // A missing key is a normal answer ("no proxy configured"), not a failure.
    resolve(error === null ? stdout : '')
  })
})

/**
 * Read the Windows system proxy.
 *
 * One `reg query` for the whole key rather than four lookups. Off Windows this
 * resolves to "no system proxy" instead of failing, so the same code path runs
 * everywhere.
 * @param exec - the command runner.
 * @returns the OS setting.
 */
export async function readSystemProxy(exec: ProxyExec = defaultExec): Promise<SystemProxy> {
  if (process.platform !== 'win32') return NO_SYSTEM_PROXY
  const output = await exec('reg', ['query', INTERNET_SETTINGS])
  const values = parseRegQuery(output)
  if (Object.keys(values).length === 0) return NO_SYSTEM_PROXY
  const proxy = systemProxyFromRegistry(values)
  // A ProxyServer value that is present but blank is Windows' own "enabled, no
  // server"; keep it so the reason can say exactly that.
  return proxy
}

/** A resolver that re-reads the OS setting at most once per interval. */
export interface ProxyResolver {
  /** The decision to use right now. */
  current(): Promise<ProxySetting>
  /** Forget the cached OS read, e.g. after the user changes the setting. */
  invalidate(): void
}

/** How long a system-proxy read is trusted, ms. */
const SYSTEM_PROXY_TTL_MS = 30_000

/**
 * Build a resolver over a live config getter.
 *
 * The registry is re-read on a slow interval rather than per request: a probe
 * issues a handful of requests and a download streams for minutes, and reading a
 * subprocess for each would be silly. `invalidate` exists for the moment the user
 * changes the setting and expects it to apply.
 * @param readConfigProxy - current `config.proxy`.
 * @param env - environment to read.
 * @param exec - command runner for the registry read.
 * @param now - clock, injected for tests.
 * @returns the resolver.
 */
export function createProxyResolver(
  readConfigProxy: () => string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  exec: ProxyExec = defaultExec,
  now: () => number = () => Date.now(),
): ProxyResolver {
  let cached: { at: number; system: SystemProxy } | undefined
  return {
    invalidate() { cached = undefined },
    async current() {
      const configured = readConfigProxy()
      const parsed = parseProxyValue(configured)
      // An explicit configured URL or `off` never needs the registry at all.
      const needsSystem = parsed.auto === true || parsed.invalid !== undefined
      let system = NO_SYSTEM_PROXY
      if (needsSystem) {
        if (cached !== undefined && now() - cached.at < SYSTEM_PROXY_TTL_MS) {
          system = cached.system
        } else {
          system = await readSystemProxy(exec)
          cached = { at: now(), system }
        }
      }
      return chooseProxy({ configured, env, system })
    },
  }
}
