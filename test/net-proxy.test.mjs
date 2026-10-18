/**
 * Proxy resolution: which server a Host request uses, and why.
 *
 * This is the decision that made a reachable page look unreachable. The failure
 * is invisible from the outside — the browser works, the plugin says "fetch
 * failed" — so every branch here is pinned: the precedence, the Windows
 * per-protocol form, PAC, the bypass list, and the repair of a value that cannot
 * work at all.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  chooseProxy,
  createProxyResolver,
  parseProxyOverride,
  parseProxyValue,
  parseRegQuery,
  pickProxyServer,
  shouldBypass,
  systemProxyFromRegistry,
} from '../lib/test/net/proxy.js'

/** The live machine's setting, as the registry reports it. */
const SYSTEM_ON = { enabled: true, server: '127.0.0.1:65532' }
const SYSTEM_OFF = { enabled: false }
const NO_ENV = {}

/**
 * The raw `reg query` table for the live machine's setting.
 *
 * The fake exec returns COMMAND OUTPUT rather than a parsed object on purpose: it
 * keeps the real parsing (`parseRegQuery`, `systemProxyFromRegistry`) inside the
 * end-to-end path, so a regression in either cannot hide behind the fixture.
 */
const REG_ON = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    127.0.0.1:65532',
  '',
].join('\r\n')

describe('parseProxyValue', () => {
  it('accepts a bare host:port the way Windows stores it', () => {
    assert.equal(parseProxyValue('127.0.0.1:65532').url, 'http://127.0.0.1:65532')
    assert.equal(parseProxyValue('http://proxy.local:8080').url, 'http://proxy.local:8080')
    assert.equal(parseProxyValue('https://proxy.local:8443').url, 'https://proxy.local:8443')
  })

  it('reads the keywords the setting documents', () => {
    for (const value of ['', 'auto', 'AUTO', 'system']) assert.equal(parseProxyValue(value).auto, true, value)
    for (const value of ['off', 'none', 'direct', 'no']) assert.equal(parseProxyValue(value).off, true, value)
  })

  it('refuses SOCKS instead of mistranslating it', () => {
    // Speaking HTTP CONNECT to a SOCKS port fails as an unexplained timeout, which
    // is exactly the class of bug this setting exists to end.
    assert.match(parseProxyValue('socks5://127.0.0.1:1080').invalid, /socks/)
  })

  it('refuses values that cannot be a proxy', () => {
    assert.notEqual(parseProxyValue('http://proxy.local').invalid, undefined, 'a missing port')
    assert.notEqual(parseProxyValue('::::').invalid, undefined)
  })
})

describe('pickProxyServer', () => {
  it('prefers the https entry of a per-protocol value', () => {
    assert.equal(pickProxyServer('http=10.0.0.1:8080;https=10.0.0.1:8443'), '10.0.0.1:8443')
    assert.equal(pickProxyServer('http=10.0.0.1:8080'), '10.0.0.1:8080')
  })

  it('passes a single value straight through', () => {
    assert.equal(pickProxyServer('127.0.0.1:65532'), '127.0.0.1:65532')
    assert.equal(pickProxyServer('  '), undefined)
    assert.equal(pickProxyServer(undefined), undefined)
  })
})

describe('chooseProxy precedence', () => {
  it('lets the configured value win over everything', () => {
    const setting = chooseProxy({
      configured: 'http://from-config:1',
      env: { HTTPS_PROXY: 'http://from-env:2' },
      system: SYSTEM_ON,
    })
    assert.equal(setting.url, 'http://from-config:1')
    assert.equal(setting.source, 'config')
  })

  it('falls back to the environment, then to the system', () => {
    assert.equal(chooseProxy({ configured: '', env: { HTTPS_PROXY: 'http://from-env:2' }, system: SYSTEM_ON }).source, 'env')
    assert.equal(chooseProxy({ configured: '', env: NO_ENV, system: SYSTEM_ON }).source, 'system')
    assert.equal(chooseProxy({ configured: '', env: NO_ENV, system: SYSTEM_ON }).url, 'http://127.0.0.1:65532')
  })

  it('honours an explicit off even when a proxy is available', () => {
    const setting = chooseProxy({ configured: 'off', env: { HTTPS_PROXY: 'http://from-env:2' }, system: SYSTEM_ON })
    assert.equal(setting.url, undefined)
    assert.equal(setting.found, false)
    assert.match(setting.reason, /关闭/)
  })

  it('says a system proxy that is off is off', () => {
    const setting = chooseProxy({ configured: '', env: NO_ENV, system: SYSTEM_OFF })
    assert.equal(setting.url, undefined)
    assert.equal(setting.found, false)
    assert.match(setting.reason, /未检测到/)
  })

  it('explains a PAC script instead of pretending there is no proxy', () => {
    // The user's browser may be reaching the site through a PAC rule; silence here
    // would send them looking for a network fault that is not there.
    const setting = chooseProxy({
      configured: '',
      env: NO_ENV,
      system: { enabled: true, autoConfigUrl: 'http://127.0.0.1:65532/proxy.pac' },
    })
    assert.equal(setting.url, undefined)
    assert.match(setting.reason, /PAC/)
  })

  it('reports an unusable configured value rather than silently going direct', () => {
    const setting = chooseProxy({ configured: 'socks5://127.0.0.1:1080', env: NO_ENV, system: SYSTEM_ON })
    assert.equal(setting.url, undefined)
    assert.match(setting.reason, /socks/)
    // Falling through to the system proxy here would hide the user's own mistake.
    assert.equal(setting.source, 'none')
  })
})

describe('bypass rules', () => {
  it('splits the Windows override value', () => {
    assert.deepEqual(parseProxyOverride('localhost;127.*;*.internal'), ['localhost', '127.*', '*.internal'])
    assert.deepEqual(parseProxyOverride(''), [])
    assert.deepEqual(parseProxyOverride(undefined), [])
  })

  it('matches exact hosts, their subdomains, wildcards, and <local>', () => {
    assert.equal(shouldBypass('example.com', ['example.com']), true)
    assert.equal(shouldBypass('www.example.com', ['example.com']), true)
    assert.equal(shouldBypass('notexample.com', ['example.com']), false)
    assert.equal(shouldBypass('api.internal', ['*.internal']), true)
    assert.equal(shouldBypass('127.0.0.1', ['127.*']), true)
    assert.equal(shouldBypass('intranet', ['<local>']), true)
    assert.equal(shouldBypass('example.com', ['<local>']), false)
  })

  it('does not treat a dotted host as local', () => {
    assert.equal(shouldBypass('example.com', ['<local>']), false)
    assert.equal(shouldBypass('localhost', []), false, 'an empty list bypasses nothing')
  })
})

describe('registry parsing', () => {
  it('reads the reg query table', () => {
    const values = parseRegQuery([
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:65532',
      '    ProxyOverride    REG_SZ    localhost;<local>',
      '',
    ].join('\r\n'))
    assert.equal(values.ProxyEnable, '0x1')
    assert.equal(values.ProxyServer, '127.0.0.1:65532')
    const system = systemProxyFromRegistry(values)
    assert.equal(system.enabled, true)
    assert.equal(system.server, '127.0.0.1:65532')
    assert.equal(system.override, 'localhost;<local>')
  })

  it('treats a missing or zero ProxyEnable as disabled', () => {
    assert.equal(systemProxyFromRegistry({}).enabled, false)
    assert.equal(systemProxyFromRegistry({ ProxyEnable: '0x0' }).enabled, false)
  })
})

describe('createProxyResolver', () => {
  it('re-reads the registry on a slow interval, not per request', async () => {
    let reads = 0
    let clock = 0
    const resolver = createProxyResolver(
      () => '',
      NO_ENV,
      async () => { reads += 1; return REG_ON },
      () => clock,
    )
    assert.equal((await resolver.current()).url, 'http://127.0.0.1:65532')
    assert.equal((await resolver.current()).url, 'http://127.0.0.1:65532')
    assert.equal(reads, 1, 'a probe issues several requests; the registry is not read for each')
    clock += 31_000
    await resolver.current()
    assert.equal(reads, 2)
  })

  it('never reads the registry when the setting is explicit', async () => {
    let reads = 0
    const resolver = createProxyResolver(
      () => 'http://explicit:1',
      NO_ENV,
      async () => { reads += 1; return SYSTEM_ON },
      () => 0,
    )
    assert.equal((await resolver.current()).url, 'http://explicit:1')
    assert.equal(reads, 0)
  })

  it('picks up a changed setting after invalidate', async () => {
    let configured = 'http://first:1'
    const resolver = createProxyResolver(() => configured, NO_ENV, async () => SYSTEM_ON, () => 0)
    assert.equal((await resolver.current()).url, 'http://first:1')
    configured = 'http://second:2'
    resolver.invalidate()
    assert.equal((await resolver.current()).url, 'http://second:2')
  })
})
