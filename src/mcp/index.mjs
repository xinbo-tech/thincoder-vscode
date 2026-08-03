/**
 * mcp/index.mjs — MCP client lifecycle (connect, list, call, disconnect)
 *
 * Connects to MCP servers via stdio or HTTP transports, manages server
 * registry, and provides an agent tool (mcpTool) for AI-driven MCP use.
 *
 * Exports:
 *   mcpConnect(serverConfig)  → client { id, send, notify, close, serverName }
 *   mcpListTools(client)      → [{ name, description, inputSchema }]
 *   mcpCallTool(client, toolName, args) → result string
 *   mcpDisconnect(client)     — close one connection
 *   closeAllMcp()             — close all connections
 *   mcpTool                   — agent tool definition for MCP interaction
 */

import { withTimeout, INIT_TIMEOUT_MS } from "./utils.mjs"
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
 * Connect to an MCP server. Supports stdio and HTTP transports.
 * @param {{ type: "stdio"|"http", command?: string, args?: string[], url?: string, name?: string, headers?: Record<string,string> }} config
 * @returns {Promise<{ id: string, serverName: string, tools: Array<{name:string, description:string, inputSchema:object}> }>}
 */
export async function mcpConnect(config) {
  if (!config || (!config.command && !config.url && !config.wsUrl))
    throw new Error("MCP server config needs 'command' (stdio), 'url' (http), or 'wsUrl' (ws)")

  let transport
  const serverName = config.name || (config.command ? config.command : (config.wsUrl || config.url))

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
    "- config: (for connect) { type: \"stdio\"|\"http\"|\"ws\", command?, args?, url?, wsUrl?, name?, headers? }\n" +
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
          type: config.type || (config.command ? "stdio" : config.wsUrl ? "ws" : config.url ? "http" : undefined),
          command: config.command,
          args: config.args,
          url: config.url,
          wsUrl: config.wsUrl,
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
