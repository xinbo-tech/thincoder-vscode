/**
 * proxy.mjs — Shared proxy tunnel for websearch, fetch, and provider calls.
 * Zero dependencies: Node built-ins only (net, tls, http, url).
 */
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { PassThrough } from "node:stream";
import { URL } from "node:url";

const FETCH_TIMEOUT = 15_000

/**
 * Resolve proxy URI.
 * New format: { proxy: { uri: "http://host:port", web: true, model: false } }
 * Old format: { proxy: "http://host:port" } — backwards compatible, web=true model=false
 * Env vars: HTTPS_PROXY, HTTP_PROXY, ALL_PROXY
 *
 * @returns {{ uri: string|null, web: boolean, model: boolean }}
 */
export function resolveProxyConfig(ctx) {
  const cfgProxy = ctx?.agent?.config?.proxy
  if (!cfgProxy) {
    const uri = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || null
    return { uri, web: !!uri, model: false }
  }
  if (typeof cfgProxy === "string") {
    // Backward compat: bare string → web only
    return { uri: cfgProxy, web: true, model: false }
  }
  return {
    uri: cfgProxy.uri || cfgProxy.url || null,
    web: cfgProxy.web !== false,
    model: cfgProxy.model === true,
  }
}

/** Convenience: resolve proxy URI for web tools (websearch/fetch) */
export function resolveWebProxy(ctx) {
  const cfg = resolveProxyConfig(ctx)
  return (cfg.uri && cfg.web) ? cfg.uri : null
}

/**
 * Inject the resolved proxy URI into each provider as provider.proxyUri
 * (consumed by chat() in provider/core.mjs).
 * Model 请求走代理需要双重开启：per-provider `proxy: true` 且全局 `config.proxy.model === true`（默认关）。
 */
export function injectProxy(providers, config) {
  const { uri, model } = resolveProxyConfig({ agent: { config } })
  for (const p of providers ?? []) {
    p.proxyUri = p.proxy && model ? (uri ?? undefined) : undefined
  }
}

function abortError(signal) {
  const e = new DOMException("The operation was aborted", "AbortError")
  e.reason = signal?.reason
  return e
}

/**
 * 在已建立的 socket 上发 HTTP 请求，响应头到齐即 resolve（流式）。
 * 返回 Response-like: { ok, status, headers: Headers, body: PassThrough(异步迭代), text(): Promise<string> }
 * body 边收边吐（SSE 流式消费方可逐 chunk 读取）；text() 消费流到底（非流式调用方用）。
 * opts.signal 全程有效：abort 即 destroy socket 并 reject/终止流。
 * absoluteForm: 请求行发绝对 URI（http:// 目标的经典代理转发用），默认发 origin-form。
 * 导出供测试（裸 socket，无需 TLS/CONNECT）；生产路径走 tunnelHttps / proxyFetch。
 */
export function streamHttpResponse(sock, urlStr, opts = {}, timeout = FETCH_TIMEOUT, absoluteForm = false) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr)
    const method = opts.method ?? "GET"
    const headers = opts.headers ?? {}
    const signal = opts.signal

    if (signal?.aborted) { sock.destroy(); return reject(abortError(signal)) }

    const body = new PassThrough()
    let settled = false
    let headerBuf = ""

    const timer = setTimeout(() => fail(new Error("Response timeout")), timeout)
    const onAbort = () => { sock.destroy(); fail(abortError(signal)) }
    signal?.addEventListener("abort", onAbort, { once: true })

    function cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    /** 头部阶段失败 reject；resolve 后失败则终止 body 流（for-await 抛出，不挂起） */
    function fail(err) {
      cleanup()
      if (!settled) { settled = true; reject(err) }
      else body.destroy(err)
    }

    sock.on("data", (d) => {
      if (settled) return // 理论上不会发生（settle 后摘掉本监听器），防御
      headerBuf += d.toString("utf8")
      const idx = headerBuf.indexOf("\r\n\r\n")
      if (idx < 0) return

      const headerText = headerBuf.slice(0, idx)
      const statusMatch = headerText.match(/^HTTP\/\d\.\d (\d+)/)
      const status = statusMatch ? Number(statusMatch[1]) : 502
      const respHeaders = {}
      for (const line of headerText.split("\r\n").slice(1)) {
        const ci = line.indexOf(":")
        if (ci > 0) respHeaders[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim()
      }

      // 头到齐：摘掉头阶段监听，剩余字节推入 body，后续数据直接 pipe
      sock.removeAllListeners("data")
      settled = true
      cleanup()
      const remaining = headerBuf.slice(idx + 4)
      if (remaining) body.write(Buffer.from(remaining, "utf8"))
      sock.pipe(body)
      // body 结束后才移除 abort 监听（流式中途 abort 要能终止流）
      body.on("close", () => signal?.removeEventListener("abort", onAbort))
      signal?.addEventListener("abort", onAbort, { once: true })

      resolve({
        ok: status >= 200 && status < 400,
        status,
        headers: new Headers(respHeaders),
        body,
        text: async () => {
          const chunks = []
          for await (const c of body) chunks.push(c)
          return Buffer.concat(chunks).toString("utf8")
        },
      })
    })
    sock.on("close", () => {
      if (!settled) fail(new Error("Connection closed before response"))
      else body.end()
    })
    // 头部阶段的传输错误统一包装为稳定契约（对端 RST 会抛原生 ECONNRESET，调用方难判别）；
    // resolve 后的 body 阶段保留原始错误终止流
    sock.on("error", (e) => {
      if (!settled) fail(new Error(`Connection closed before response (${e.code ?? e.message})`))
      else fail(e)
    })

    // 写请求（absoluteForm：代理转发时请求行为绝对 URI）
    const requestTarget = absoluteForm ? urlStr : `${target.pathname}${target.search}`
    const lines = [`${method} ${requestTarget} HTTP/1.1`]
    for (const [k, v] of Object.entries({ ...headers, Host: target.hostname })) lines.push(`${k}: ${v}`)
    lines.push("Connection: close", "", "")
    sock.write(lines.join("\r\n"))
    if (opts.body) sock.write(opts.body)
  })
}

/**
 * HTTPS request through HTTP CONNECT proxy tunnel.
 * CONNECT + TLS 建立后交给 streamHttpResponse — 响应头到齐即 resolve，body 为流式。
 */
export function tunnelHttps(urlStr, opts, proxyUri, timeout = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr)
    const proxy = new URL(proxyUri)
    const signal = opts?.signal

    if (signal?.aborted) return reject(abortError(signal))

    const sock = connect({ host: proxy.hostname, port: Number(proxy.port) || 3128 })
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("Proxy CONNECT timeout")) }, timeout)
    const onAbort = () => { sock.destroy(); reject(abortError(signal)) }
    signal?.addEventListener("abort", onAbort, { once: true })
    sock.on("connect", () => sock.write(`CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}\r\n\r\n`))

    let buf = ""
    sock.on("data", d => {
      buf += d.toString()
      const end = buf.indexOf("\r\n\r\n")
      if (end < 0) return
      const statusLine = buf.slice(0, end).split("\r\n")[0]
      buf = buf.slice(end + 4)
      if (!statusLine.includes("200")) { sock.destroy(); clearTimeout(timer); return reject(new Error(`Proxy CONNECT: ${statusLine}`)) }
      sock.removeAllListeners("data"); clearTimeout(timer)

      const tlsSock = tlsConnect({ socket: sock, servername: target.hostname, rejectUnauthorized: false, timeout })
      if (buf) tlsSock.unshift(Buffer.from(buf))
      tlsSock.on("secureConnect", () => {
        // TLS 之后的请求/响应阶段：abort 交由 streamHttpResponse 接管
        signal?.removeEventListener("abort", onAbort)
        streamHttpResponse(tlsSock, urlStr, opts, timeout).then(resolve, reject)
      })
      tlsSock.on("error", e => { sock.destroy(); reject(e) })
    })
    sock.on("error", e => { clearTimeout(timer); reject(new Error(`Proxy CONNECT failed (${e.code ?? e.message})`)) })
    // 代理干净 FIN 关闭（无 error）时也要 reject，不能卡满超时
    sock.on("close", () => { clearTimeout(timer); reject(new Error("Proxy connection closed before tunnel established")) })
  })
}

/** TCP 直连代理（http:// 目标的经典转发用）：超时/abort/对端关闭都有稳定 reject */
function tcpConnectProxy(proxyUri, signal, timeout) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUri)
    const sock = connect({ host: proxy.hostname, port: Number(proxy.port) || 3128 })
    if (signal?.aborted) { sock.destroy(); return reject(abortError(signal)) }
    const onAbort = () => sock.destroy()
    signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("Proxy CONNECT timeout")) }, timeout)
    const onError = (e) => { clearTimeout(timer); reject(new Error(`Proxy CONNECT failed (${e.code ?? e.message})`)) }
    const onClose = () => {
      clearTimeout(timer)
      reject(signal?.aborted ? abortError(signal) : new Error("Proxy connection closed before tunnel established"))
    }
    sock.once("connect", () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      sock.removeListener("error", onError)
      sock.removeListener("close", onClose)
      resolve(sock)
    })
    sock.once("error", onError)
    sock.once("close", onClose)
  })
}

/**
 * Generic fetch with proxy support.
 * No proxy → native fetch. Proxy + HTTPS → CONNECT tunnel. Proxy + HTTP → 经典代理转发（绝对 URI 请求行）。
 */
export async function proxyFetch(urlStr, opts, proxyUri) {
  if (!proxyUri) return globalThis.fetch(urlStr, opts)
  const target = new URL(urlStr)
  if (target.protocol === "https:") return tunnelHttps(urlStr, opts, proxyUri)
  // http:// 目标：TCP 直连代理，请求行发绝对 URI（GET http://host/path HTTP/1.1）
  const sock = await tcpConnectProxy(proxyUri, opts?.signal, FETCH_TIMEOUT)
  return streamHttpResponse(sock, urlStr, opts, FETCH_TIMEOUT, true)
}
