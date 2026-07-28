/**
 * mcp.mjs — MCP (Model Context Protocol) client for VS Code
 *
 * Ported from thincoder CLI. Supports stdio and HTTP transports.
 * Zero npm dependencies — uses node:child_process spawn for stdio,
 * native fetch for HTTP + SSE streaming.
 *
 * Server config format:
 *   { type: "stdio", command: "npx", args?: ["-y", "some-server"], name?: "my-server" }
 *   { type: "http",  url: "http://localhost:3000/mcp", headers?: {...}, name?: "my-server" }
 *
 * Exports:
 *   mcpConnect(serverConfig)  → client { id, send, notify, close, serverName }
 *   mcpListTools(client)      → [{ name, description, inputSchema }]
 *   mcpCallTool(client, toolName, args) → result string
 *   mcpTool                   — agent tool definition for MCP interaction
 *   closeAllMcp()             — close all connections
 */

import { spawn } from "node:child_process"

// ─── constants ──────────────────────────────────────────────────

const INIT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 120_000
const ENDPOINT_WAIT_MS = 5_000

let _nextRpcId = 0
function rpcId() { return String(++_nextRpcId) }

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout])
}

function quoteArg(s) {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function sanitizeToolName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

// ─── stdio transport ───────────────────────────────────────────

function stdioTransport(command, args) {
  const spawnOpts = { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env } }
  const child =
    process.platform === "win32" && !/\.exe$/i.test(command)
      ? spawn("cmd.exe", ["/d", "/s", "/c", [command, ...(args ?? [])].map(quoteArg).join(" ")], {
          ...spawnOpts,
          windowsVerbatimArguments: true,
        })
      : spawn(command, args ?? [], spawnOpts)

  const pending = new Map()
  const decoder = new TextDecoder()
  let buffer = ""
  let stderrTail = ""
  let spawnError = null
  let closed = false

  const failAll = (message) => {
    for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message } })
    pending.clear()
  }

  child.stdout.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        const resolver = pending.get(msg.id)
        if (resolver) {
          pending.delete(msg.id)
          resolver(msg)
        }
      } catch { /* non-JSON line, ignore */ }
    }
  })

  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.stdin.on("error", () => {})
  child.on("error", (error) => {
    spawnError = error
    closed = true
    failAll(`spawn failed: ${error.message}`)
  })
  child.on("close", () => {
    closed = true
    const lastLine = stderrTail.trim().split("\n").pop()
    failAll(`Connection closed${lastLine ? ` | stderr: ${lastLine}` : ""}`)
  })

  const send = (method, params) => {
    if (spawnError) return Promise.resolve({ id: null, error: { code: -32000, message: `spawn failed: ${spawnError.message}` } })
    if (closed) return Promise.reject(new Error("MCP connection closed"))
    const id = rpcId()
    const promise = new Promise((resolve) => pending.set(id, resolve))
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    } catch (error) {
      pending.delete(id)
      return Promise.resolve({ id: null, error: { code: -32000, message: `stdin write failed: ${error.message}` } })
    }
    return withTimeout(promise, CALL_TIMEOUT_MS).finally(() => pending.delete(id))
  }

  const notify = (method, params) => {
    if (closed) return
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
    } catch { /* ignore */ }
  }

  return { send, notify, close: () => { if (!closed) child.kill() } }
}

// ─── HTTP transport (Streamable HTTP + SSE) ─────────────────────

function httpTransport(baseURL, extraHeaders = {}) {
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

// ─── MCP lifecycle ──────────────────────────────────────────────

/** Initialize the MCP handshake and return the server's tool list */
async function doInitialize(transport, name) {
  const initResp = await withTimeout(
    transport.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "thincoder-vscode", version: "1.0.0" },
    }),
    INIT_TIMEOUT_MS,
  )
  if (initResp.error) throw new Error(`initialize error: ${initResp.error.message}`)
  transport.notify?.("notifications/initialized", {})

  const toolsResp = await transport.send("tools/list", {})
  if (toolsResp.error) throw new Error(`tools/list failed: ${toolsResp.error.message}`)
  return toolsResp.result?.tools ?? []
}

// ─── Server registry ────────────────────────────────────────────

/** Map of serverId → { transport, tools, config, serverName } */
const _servers = new Map()
let _serverSeq = 0

/**
 * Connect to an MCP server. Supports stdio and HTTP transports.
 * @param {{ type: "stdio"|"http", command?: string, args?: string[], url?: string, name?: string, headers?: Record<string,string> }} config
 * @returns {Promise<{ id: string, serverName: string, tools: Array<{name:string, description:string, inputSchema:object}> }>}
 */
export async function mcpConnect(config) {
  if (!config || (!config.command && !config.url))
    throw new Error("MCP server config needs either 'command' (stdio) or 'url' (http)")

  let transport
  const serverName = config.name || (config.command ? config.command : config.url)

  if (config.url) {
    transport = httpTransport(config.url, config.headers ?? {})
    try {
      await transport.openSSE()
    } catch {
      // Server doesn't support GET SSE — degrade to pure Streamable HTTP POST mode
    }
  } else {
    transport = stdioTransport(config.command, config.args ?? [])
  }

  try {
    const mcpTools = await doInitialize(transport, serverName)
    const id = `mcp-${++_serverSeq}`
    _servers.set(id, { transport, tools: mcpTools, config, serverName })
    return {
      id,
      serverName,
      tools: mcpTools.map((t) => ({
        name: t.name,
        description: t.description ?? `MCP tool: ${t.name}`,
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      })),
    }
  } catch (error) {
    transport.close()
    throw error
  }
}

/**
 * List tools from a connected MCP server.
 * @param {{ id: string }} client — the client object returned by mcpConnect
 * @returns {Array<{name:string, description:string, inputSchema:object}>}
 */
export function mcpListTools(client) {
  const server = _servers.get(client.id)
  if (!server) throw new Error(`MCP server "${client.id}" not connected`)
  return server.tools.map((t) => ({
    name: t.name,
    description: t.description ?? `MCP tool: ${t.name}`,
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  }))
}

/**
 * Call a tool on a connected MCP server.
 * @param {{ id: string }} client
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<string>} — the tool result as a string
 */
export async function mcpCallTool(client, toolName, args) {
  const server = _servers.get(client.id)
  if (!server) throw new Error(`MCP server "${client.id}" not connected`)
  const tool = server.tools.find((t) => t.name === toolName)
  if (!tool) throw new Error(`Tool "${toolName}" not found on server "${server.serverName}"`)

  const resp = await server.transport.send("tools/call", { name: toolName, arguments: args ?? {} })
  if (resp.error) throw new Error(`MCP tool "${toolName}": ${resp.error.message}`)
  const content = resp.result?.content ?? []
  return (
    content
      .map((c) =>
        c.type === "text"
          ? c.text
          : c.type === "resource"
            ? `[resource: ${c.resource?.uri}]`
            : JSON.stringify(c),
      )
      .join("\n") || "(no output)"
  )
}

/**
 * Disconnect from an MCP server.
 * @param {{ id: string }} client
 */
export function mcpDisconnect(client) {
  const server = _servers.get(client.id)
  if (server) {
    server.transport.close()
    _servers.delete(client.id)
  }
}

/** Close all MCP connections */
export function closeAllMcp() {
  for (const [id, server] of _servers) {
    try { server.transport.close() } catch { /* */ }
    _servers.delete(id)
  }
}

// ─── agent tool ─────────────────────────────────────────────────

/**
 * MCP agent tool — lets the model discover, connect to, and call MCP tools.
 *
 * Sub-commands:
 *   connect  — connect to an MCP server (stdio or http)
 *   list     — list tools on a connected server
 *   call     — call a tool on a connected server
 *   disconnect — close a server connection
 */
export const mcpTool = {
  name: "mcp",
  readonly: false,
  description:
    "Connect to MCP (Model Context Protocol) servers and call their tools. " +
    "MCP servers provide external tools (database queries, API clients, file system tools, etc.) " +
    "that the agent can use. Use 'connect' first to establish a connection, then 'list' to see " +
    "available tools, then 'call' to invoke them.\n\n" +
    "Parameters:\n" +
    "- action (required): \"connect\" | \"list\" | \"call\" | \"disconnect\"\n" +
    "- config: (for connect) { type: \"stdio\"|\"http\", command?, args?, url?, name?, headers? }\n" +
    "  - stdio example: { type: \"stdio\", command: \"npx\", args: [\"-y\", \"@modelcontextprotocol/server-filesystem\", \"/path\"], name: \"fs\" }\n" +
    "  - http example:  { type: \"http\",  url: \"http://localhost:3000/mcp\", name: \"my-server\" }\n" +
    "- serverId: (for list, call, disconnect) the id returned by connect\n" +
    "- tool: (for call) the tool name to invoke\n" +
    "- arguments: (for call) the tool arguments object",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["connect", "list", "call", "disconnect"],
        description: "The MCP action to perform",
      },
      config: {
        type: "object",
        description: "Server config for connect: { type: \"stdio\"|\"http\", command?, args?, url?, name?, headers? }",
      },
      serverId: {
        type: "string",
        description: "Server ID returned by a previous connect action",
      },
      tool: {
        type: "string",
        description: "Tool name to call (for action=call)",
      },
      arguments: {
        type: "object",
        description: "Arguments to pass to the tool (for action=call)",
      },
    },
    required: ["action"],
  },
  async execute({ action, config, serverId, tool, arguments: args }) {
    switch (action) {
      case "connect": {
        if (!config) return "Error: 'config' is required for connect"
        const result = await mcpConnect({
          type: config.type || (config.command ? "stdio" : config.url ? "http" : undefined),
          command: config.command,
          args: config.args,
          url: config.url,
          name: config.name,
          headers: config.headers,
        })
        return (
          `Connected to MCP server "${result.serverName}" (id: ${result.id}).\n` +
          `Available tools (${result.tools.length}):\n` +
          result.tools.map((t) => `  - ${t.name}: ${t.description}`).join("\n")
        )
      }

      case "list": {
        if (!serverId) return "Error: 'serverId' is required for list"
        const tools = mcpListTools({ id: serverId })
        if (tools.length === 0) return "No tools available on this server."
        return `Tools on server ${serverId} (${tools.length}):\n` +
          tools.map((t) => `  - ${t.name}: ${t.description}`).join("\n")
      }

      case "call": {
        if (!serverId) return "Error: 'serverId' is required for call"
        if (!tool) return "Error: 'tool' is required for call"
        return await mcpCallTool({ id: serverId }, tool, args ?? {})
      }

      case "disconnect": {
        if (!serverId) return "Error: 'serverId' is required for disconnect"
        mcpDisconnect({ id: serverId })
        return `Disconnected from server ${serverId}.`
      }

      default:
        return `Error: unknown action "${action}". Use connect, list, call, or disconnect.`
    }
  },
}
