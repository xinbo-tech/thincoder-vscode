/**
 * mcp/index.mjs — MCP client lifecycle (connect, list, call, disconnect)
 *
 * Connects to MCP servers via stdio, HTTP or WS transports, manages a server
 * registry, and expands each server's tools into native agent tools
 * (CLI parity — see thincoder docs/design/MCP.md).
 *
 * Exports:
 *   mcpConnect(serverConfig)        → client { id, serverName, tools } (idempotent per server name)
 *   connectMcpServersExpanded(cfgs) → { tools, warnings } — batch idempotent connect + expansion
 *   buildMcpTools(serverEntry)      → expanded native tools (CLI buildTools parity)
 *   mcpListTools(client) / mcpCallTool(client, name, args) / mcpDisconnect(client)
 *   closeAllMcp() / mcpConnectedNames() / mcpConnectedToolCounts() / mcpDisconnectByName(name)
 */

/** Race a pending MCP request against an abort signal — a hung MCP server must not
 *  hold the turn hostage. signal absent → passthrough (panel paths have no signal). */
async function sendWithSignal(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const e = new DOMException("The operation was aborted", "AbortError")
      e.reason = signal.reason
      reject(e)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v) },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e) },
    )
  })
}


import { withTimeout, INIT_TIMEOUT_MS, sanitizeToolName } from "./utils.mjs"
import { stdioTransport } from "./stdio.mjs"
import { httpTransport } from "./http.mjs"
import { wsTransport } from "./ws.mjs"

// ─── MCP handshake ───────────────────────────────────────────────

/** Initialize the MCP handshake and return the server's tool list */
async function doInitialize(transport, _name) {
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
 * Connect to an MCP server. Supports stdio, HTTP and WS transports.
 * IDEMPOTENT per server name: an already-connected server with the same name
 * is reused (runAgent re-assembles the tool table every turn — repeated calls
 * must not leak transports).
 * @param {{ command?: string, args?: string[], url?: string, wsUrl?: string, name?: string, headers?: Record<string,string> }} config
 * @returns {Promise<{ id: string, serverName: string, tools: Array<{name:string, description:string, inputSchema:object}> }>}
 */
export async function mcpConnect(config) {
  if (!config || (!config.command && !config.url && !config.wsUrl))
    throw new Error("MCP server config needs 'command' (stdio), 'url' (http), or 'wsUrl' (ws)")

  const serverName = config.name || (config.command ? config.command : (config.wsUrl || config.url))

  // Idempotent: reuse an existing connection with the same server name.
  for (const [id, s] of _servers) {
    if (s.serverName === serverName) {
      return {
        id,
        serverName,
        tools: s.tools.map((t) => ({
          name: t.name,
          description: t.description ?? `MCP tool: ${t.name}`,
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        })),
      }
    }
  }

  let transport
  if (config.wsUrl) {
    transport = wsTransport(config.wsUrl, config.headers ?? {})
    await transport.connect()
  } else if (config.url) {
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
 * Expand a registry server entry into NATIVE agent tools (CLI buildTools parity).
 * Each MCP tool becomes an independent tool with `{server}_{tool}` prefix and its
 * full input schema — the model calls it directly, no gateway routing (MCP.md D1).
 */
export function buildMcpTools(server) {
  const prefix = server.config?.name ? `${server.config.name}_` : "mcp_"
  return server.tools.map((t) => ({
    name: sanitizeToolName(prefix + t.name),
    description: t.description ?? `MCP tool: ${t.name}`,
    parameters: t.inputSchema ?? { type: "object", properties: {} },
    readonly: false,
    async execute(args, ctx) {
      // 2026-08-31 会诊 #11：MCP tools/call 必须响应上层 signal——MCP server（ws/http/stdio）
      // 挂死时用户 Stop 要能中断 turn；原实现 send 无 abort 也无超时，整个 turn 卡死。
      const send = server.transport.send("tools/call", { name: t.name, arguments: args })
      const resp = await sendWithSignal(send, ctx?.signal)
      if (resp.error) throw new Error(`MCP tool "${t.name}": ${resp.error.message}`)
      const content = resp.result?.content ?? []
      return content
        .map((c) => (c.type === "text" ? c.text : c.type === "resource" ? `[resource: ${c.resource?.uri}]` : JSON.stringify(c)))
        .join("\n") || "(no output)"
    },
    _mcpTransport: server.transport,
    _mcpName: server.config?.name,
  }))
}

/**
 * Batch idempotent connect + expansion for the agent tool table (MCP.md D2).
 * Failures never block: each failing server produces a warning entry instead.
 * @returns {Promise<{ tools: object[], warnings: string[] }>}
 */
export async function connectMcpServersExpanded(configs) {
  const tools = []
  const warnings = []
  for (const cfg of configs) {
    try {
      const client = await mcpConnect(cfg)
      const server = _servers.get(client.id)
      if (server) tools.push(...buildMcpTools(server))
    } catch (e) {
      const label = cfg.name || cfg.command || cfg.url || cfg.wsUrl || "(unnamed)"
      warnings.push(`MCP server "${label}" failed to connect: ${e.message}`)
    }
  }
  return { tools, warnings }
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

/** Connected server names (for the settings panel ●/○ status). */
export function mcpConnectedNames() {
  return [..._servers.values()].map((s) => s.serverName)
}

/** Connected server name → tool count (settings panel status). */
export function mcpConnectedToolCounts() {
  const out = {}
  for (const s of _servers.values()) out[s.serverName] = s.tools?.length ?? 0
  return out
}

/** Disconnect all connections to a named server (settings panel reconnect). */
export function mcpDisconnectByName(name) {
  for (const [id, server] of _servers) {
    if (server.serverName === name) {
      try { server.transport.close() } catch { /* */ }
      _servers.delete(id)
    }
  }
}

