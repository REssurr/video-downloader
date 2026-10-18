/**
 * Failure diagnosis: the difference between "fetch failed" and something the user
 * can act on.
 *
 * Every case here is a shape that was observed on a real machine, including the
 * one that started this work: a TCP connect timeout whose actionable facts
 * (attempted addresses, the missing proxy) were all being thrown away.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { causeChain, describeFetchError, describeHttpFailure, isChallengeResponse } from '../lib/test/net/diagnose.js'

/** An error with a cause chain, the way undici builds one. */
function chained(message, links) {
  const error = new TypeError(message)
  let current = error
  for (const link of links) {
    const next = new Error(link.message)
    if (link.code !== undefined) next.code = link.code
    current.cause = next
    current = next
  }
  return error
}

/** The exact connect timeout the live probe produced. */
function connectTimeout() {
  const aggregate = new AggregateError([
    Object.assign(new Error('connect ETIMEDOUT 210.56.51.193:443'), { code: 'ETIMEDOUT', address: '210.56.51.193', port: 443 }),
    Object.assign(new Error('connect ETIMEDOUT [2001::737e:64a0]:443'), { code: 'ETIMEDOUT', address: '2001::737e:64a0', port: 443 }),
  ], '')
  const timeout = Object.assign(new Error('Connect Timeout Error (attempted addresses: 210.56.51.193:443, timeout: 10000ms)'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
  })
  timeout.cause = aggregate
  const error = new TypeError('fetch failed')
  error.cause = timeout
  return error
}

describe('causeChain', () => {
  it('walks causes and collects the addresses an aggregate named', () => {
    const links = causeChain(connectTimeout())
    const codes = links.map((link) => link.code).filter(Boolean)
    assert.deepEqual(codes, ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ETIMEDOUT'])
    const addresses = links.flatMap((link) => link.addresses)
    assert.deepEqual(addresses, ['210.56.51.193:443', '2001::737e:64a0:443'])
  })

  it('survives a cycle and nonsense input', () => {
    const a = new Error('a')
    a.cause = a
    assert.equal(causeChain(a).length, 1)
    assert.deepEqual(causeChain('nope'), [])
    assert.deepEqual(causeChain(undefined), [])
  })
})

describe('describeFetchError', () => {
  const noProxy = { source: 'none', bypass: [], found: false }

  it('names the missing proxy when the Host dialled direct and timed out', () => {
    const diagnosis = describeFetchError(connectTimeout(), { proxy: noProxy, systemProxyHint: '127.0.0.1:65532' })
    assert.equal(diagnosis.code, 'timeout')
    // The whole point: say what to do, and name the setting that already exists.
    assert.match(diagnosis.message, /连接超时/)
    assert.match(diagnosis.message, /127\.0\.0\.1:65532/)
    assert.match(diagnosis.message, /设置/)
    assert.match(diagnosis.detail, /UND_ERR_CONNECT_TIMEOUT/)
    assert.match(diagnosis.detail, /210\.56\.51\.193:443/)
  })

  it('says the Host is not using a system proxy that IS enabled', () => {
    const diagnosis = describeFetchError(connectTimeout(), { proxy: noProxy, systemProxyHint: '127.0.0.1:65532' })
    assert.match(diagnosis.message, /没有使用系统代理/)
  })

  it('blames the network when there is no system proxy to point at', () => {
    const diagnosis = describeFetchError(connectTimeout(), { proxy: noProxy })
    assert.match(diagnosis.message, /直连被阻断/)
  })

  it('says when the failure happened THROUGH the proxy', () => {
    const diagnosis = describeFetchError(connectTimeout(), {
      proxy: { url: 'http://127.0.0.1:65532', source: 'system', bypass: [], found: true },
    })
    assert.match(diagnosis.message, /经代理 http:\/\/127\.0\.0\.1:65532/)
    assert.match(diagnosis.message, /代理未运行/)
  })

  it('classifies DNS, refused, reset and certificate failures apart', () => {
    const dns = describeFetchError(chained('fetch failed', [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nope.invalid' }]), {})
    assert.match(dns.message, /DNS 解析失败/)

    const refused = describeFetchError(chained('fetch failed', [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }]), {})
    assert.match(refused.message, /连接被拒绝/)

    const reset = describeFetchError(chained('fetch failed', [{ code: 'ECONNRESET', message: 'socket hang up' }]), {})
    assert.match(reset.message, /连接被重置/)

    const cert = describeFetchError(chained('fetch failed', [{ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify' }]), {
      proxy: { url: 'http://127.0.0.1:65532', source: 'system', bypass: [], found: true },
    })
    assert.match(cert.message, /证书/)
    assert.match(cert.message, /中间人/)
  })

  it('treats an abort as a timeout and keeps an unknown error verbatim', () => {
    const aborted = describeFetchError(chained('fetch failed', [{ code: 'ABORT_ERR', message: 'This operation was aborted' }]), {})
    assert.equal(aborted.code, 'timeout')
    const unknown = describeFetchError(new Error('socket exploded'), {})
    assert.equal(unknown.code, 'http-error')
    assert.match(unknown.message, /socket exploded/)
  })
})

describe('isChallengeResponse', () => {
  it('trusts Cloudflare\u2019s own marker', () => {
    // This is the header the live site answered with.
    assert.equal(isChallengeResponse(403, new Headers({ 'cf-mitigated': 'challenge', server: 'cloudflare' }), ''), true)
  })

  it('falls back to the interstitial body for a plain 403 from Cloudflare', () => {
    assert.equal(isChallengeResponse(403, new Headers({ server: 'cloudflare' }), '<title>Just a moment...</title>'), true)
    assert.equal(isChallengeResponse(403, new Headers({ server: 'cloudflare' }), '<html>forbidden</html>'), false)
  })

  it('does not call an ordinary 403 a challenge', () => {
    assert.equal(isChallengeResponse(403, new Headers({ server: 'nginx' }), 'Just a moment...'), false)
    assert.equal(isChallengeResponse(200, new Headers({ server: 'cloudflare' }), 'Just a moment...'), false)
  })
})

describe('describeHttpFailure', () => {
  it('explains a browser challenge as something HTTP cannot pass', () => {
    const diagnosis = describeHttpFailure({
      status: 403,
      headers: new Headers({ 'cf-mitigated': 'challenge', server: 'cloudflare' }),
      bodySample: '<title>Just a moment...</title>',
      proxy: { url: 'http://127.0.0.1:65532', source: 'system', bypass: [], found: true },
    })
    assert.equal(diagnosis.code, 'challenge')
    assert.match(diagnosis.message, /浏览器校验/)
    assert.match(diagnosis.message, /抓当前页/)
    assert.match(diagnosis.detail, /cf-mitigated=challenge/)
  })

  it('separates the ordinary refusals', () => {
    const plain403 = describeHttpFailure({ status: 403, headers: new Headers({ server: 'nginx' }), bodySample: '' })
    assert.equal(plain403.code, 'http-error')
    assert.match(plain403.message, /拒绝访问/)

    assert.match(describeHttpFailure({ status: 401, headers: new Headers(), bodySample: '' }).message, /登录/)
    assert.match(describeHttpFailure({ status: 404, headers: new Headers(), bodySample: '' }).message, /404/)
    assert.match(describeHttpFailure({ status: 429, headers: new Headers(), bodySample: '' }).message, /限流/)
    assert.match(describeHttpFailure({ status: 503, headers: new Headers(), bodySample: '' }).message, /服务器错误/)
  })

  it('names the proxy the request went through', () => {
    const diagnosis = describeHttpFailure({
      status: 403,
      headers: new Headers({ server: 'nginx' }),
      bodySample: '',
      proxy: { url: 'http://127.0.0.1:65532', source: 'system', bypass: [], found: true },
    })
    assert.match(diagnosis.message, /经代理 http:\/\/127\.0\.0\.1:65532/)
  })
})
