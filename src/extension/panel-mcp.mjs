/**
 * panel-mcp.mjs — ChatPanel MCP status push + reconnect (split out of chat-panel.mjs).
 * Every function takes the ChatPanel instance as `panel`.
 */
import { mcpConnectedToolCounts, mcpConnect, mcpDisconnectByName } from "../mcp.mjs"
import { getMcpServers, connectedMcpServers } from "./settings.mjs"

export function pushMcpStatus(panel) {
    const servers = getMcpServers() // array of { name, command?, args?, env?, url?, wsUrl?, headers? }
    const connected = connectedMcpServers()
    const toolCounts = mcpConnectedToolCounts()
    const status = servers.map((s) => ({
      name: s.name,
      desc: s.wsUrl ? s.wsUrl : s.url ? s.url : `${s.command} ${(s.args ?? []).join(" ")}`,
      connected: connected.includes(s.name),
      toolCount: toolCounts[s.name] ?? 0,
    }))
    panel._panel?.webview.postMessage({ type: "mcpStatus", servers: status })
  }

  /** Reconnect an MCP server: disconnect + reconnect (settings panel [Reconnect]). */
export async function reconnectMcp(panel, name) {
    const servers = getMcpServers()
    const srv = servers.find((s) => s.name === name)
    if (!srv) { panel._panel?.webview.postMessage({ type: "providerError", text: `No MCP server named "${name}"` }); return }
    try {
      mcpDisconnectByName(name)
      const client = await mcpConnect({
        name: srv.name,
        command: srv.command, args: srv.args, env: srv.env,
        url: srv.url, wsUrl: srv.wsUrl, headers: srv.headers,
      })
      panel._panel?.webview.postMessage({ type: "mcpReconnected", name, tools: client.tools.length })
    } catch (e) {
      panel._panel?.webview.postMessage({ type: "providerError", text: `MCP reconnect ${name} failed: ${e.message}` })
    }
    pushMcpStatus(panel)
  }
