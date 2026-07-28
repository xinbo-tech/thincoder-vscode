/**
 * mcp/http.mjs — Streamable HTTP + SSE transport for MCP
 *
 * Implements the MCP Streamable HTTP transport: opens a GET SSE stream
 * for server→client messages, sends POST requests for client→server
 * JSON-RPC calls, and falls back to pure POST mode when GET SSE is
 * unavailable.
 */

import { rpcId, withTimeout, CALL_TIMEOUT_MS, ENDPOINT_WAIT_MS } from "./utils.mjs"

export function httpTransport(baseURL, extraHeaders = {}) {
  const url = baseURL.replace(/\/+$/, "")
  let sessionId = null
  let closed = false
  let postUrl = url
  let legacySSE = false
  let abortController = null

  const headers = () => {
    const h = { "Content-Type": "application/json", Accept: "text/event-stream, application/json", ...extraHeaders }
    if (sessionId) h["Mcp-Session-Id"] = sessionId
    return h
  }

  const pending = new Map()

  async function* parseSSE(response) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let current = { data: "", event: "message" }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const raw of lines) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
          if (line === "") {
            if (current.data) {
              yield { event: current.event, data: current.data.trimEnd() }
              current = { data: "", event: "message" }
            }
          } else if (line.startsWith("data:")) {
            current.data += (current.data ? "\n" : "") + line.slice(5).replace(/^ /, "")
          } else if (line.startsWith("event:")) {
            current.event = line.slice(6).trim()
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async function openSSE() {
    if (closed) return
    abortController?.abort()
    abortController = new AbortController()
    const resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/event-stream", ...extraHeaders },
      signal: abortController.signal,
    })
    if (!resp.ok) throw new Error(`SSE connect failed: HTTP ${resp.status}`)
    const eventSource = parseSSE(resp)
    let endpointReady
    const gotEndpoint = new Promise((resolve) => { endpointReady = resolve })

    ;(async () => {
      try {
        for await (const { event, data } of eventSource) {
          if (closed) break
          if (event === "endpoint") {
            postUrl = new URL(data.trim(), url).href
            legacySSE = true
            endpointReady()
            continue
          }
          try {
            const msg = JSON.parse(data)
            const resolver = pending.get(msg.id)
            if (resolver) {
              pending.delete(msg.id)
              resolver(msg)
            }
          } catch { /* not JSON, ignore */ }
        }
      } catch (error) {
        if (!closed) {
          for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message: `SSE error: ${error.message}` } })
          pending.clear()
        }
      }
    })()

    const wait = new Promise((resolve) => {
      const t = setTimeout(resolve, ENDPOINT_WAIT_MS)
      t.unref?.()
    })
    await Promise.race([gotEndpoint, wait])
  }

  async function postRequest(method, params) {
    const id = rpcId()
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params })

    if (legacySSE) {
      return new Promise((resolve) => {
        pending.set(id, resolve)
        fetch(postUrl, { method: "POST", headers: headers(), body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
          .then((resp) => {
            if (!resp.ok) {
              pending.delete(id)
              resolve({ id, error: { code: -32000, message: `POST failed: HTTP ${resp.status}` } })
            }
          })
          .catch((e) => {
            pending.delete(id)
            resolve({ id, error: { code: -32000, message: `POST failed: ${e.message}` } })
          })
      }).finally(() => pending.delete(id))
    }

    const resp = await fetch(postUrl, {
      method: "POST",
      headers: headers(),
      body,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

    const ct = resp.headers.get("content-type") ?? ""
    const newSessionId = resp.headers.get("Mcp-Session-Id")
    if (newSessionId) sessionId = newSessionId

    if (ct.includes("text/event-stream")) {
      const sse = parseSSE(resp)
      for await (const { data } of sse) {
        try {
          const msg = JSON.parse(data)
          if (msg.id === id) return msg
        } catch { /* skip */ }
      }
      return { id, error: { code: -32000, message: "No JSON-RPC response in SSE stream" } }
    }

    return resp.json()
  }

  const send = async (method, params) => withTimeout(postRequest(method, params), CALL_TIMEOUT_MS)

  const notify = (method, params) => {
    fetch(postUrl, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
  }

  const close = () => {
    closed = true
    abortController?.abort()
    if (sessionId) {
      fetch(postUrl, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId, ...extraHeaders },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {})
      sessionId = null
    }
    for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message: "Connection closed" } })
    pending.clear()
  }

  return { send, notify, close, openSSE, url, headers: extraHeaders }
}
