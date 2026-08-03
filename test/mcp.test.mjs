/**
 * mcp.test.mjs — MCP tool expansion (CLI parity, MCP.md)
 * Tools are expanded into NATIVE agent tools ({server}_{tool} prefix, full schema,
 * direct tools/call routing); the gateway mcp tool is gone.
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_SERVER = join(__dirname, "fixtures", "fake-mcp-server.mjs")

describe("MCP tool expansion (MCP.md D1-D3)", () => {
  let mcp
  before(async () => { mcp = await import("../src/mcp/index.mjs") })
  after(() => { mcp.closeAllMcp() })

  it("buildMcpTools: native tools with {server}_{tool} prefix and full schema", async () => {
    const { buildMcpTools } = mcp
    const server = {
      serverName: "fs",
      config: { name: "fs" },
      transport: { send: async () => ({ result: { content: [{ type: "text", text: "ok" }] } }) },
      tools: [
        { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
        { name: "write_file", description: "Write a file" }, // no inputSchema → default
      ],
    }
    const tools = buildMcpTools(server)
    assert.equal(tools.length, 2)
    assert.equal(tools[0].name, "fs_read_file", "server prefix + tool name")
    assert.equal(tools[1].name, "fs_write_file")
    assert.deepEqual(tools[0].parameters, { type: "object", properties: { path: { type: "string" } } }, "full input schema passes through")
    assert.deepEqual(tools[1].parameters, { type: "object", properties: {} }, "missing schema gets default")
    assert.equal(tools[0].readonly, false)
    assert.ok(tools[0]._mcpTransport, "transport attached for lifecycle close")
    // execute routes to tools/call
    let called
    const s2 = {
      serverName: "s",
      config: { name: "s" },
      transport: { send: async (method, params) => { called = { method, params }; return { result: { content: [{ type: "text", text: "hi" }] } } } },
      tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }],
    }
    const [t] = buildMcpTools(s2)
    assert.equal(await t.execute({ x: 1 }), "hi")
    assert.equal(called.method, "tools/call")
    assert.equal(called.params.name, "echo")
    assert.deepEqual(called.params.arguments, { x: 1 })
  })

  it("buildMcpTools: tool error surfaces as thrown Error (dispatch shows it to the model)", async () => {
    const { buildMcpTools } = mcp
    const server = {
      serverName: "s",
      config: { name: "s" },
      transport: { send: async () => ({ error: { message: "intentional failure" } }) },
      tools: [{ name: "fail", inputSchema: { type: "object", properties: {} } }],
    }
    const [t] = buildMcpTools(server)
    await assert.rejects(() => t.execute({}), /intentional failure/)
  })

  it("connectMcpServersExpanded: end-to-end via a real stdio server (spawn, handshake, expand, call)", async () => {
    const { connectMcpServersExpanded } = mcp
    const r = await connectMcpServersExpanded([
      { name: "fake", command: process.execPath, args: [FAKE_SERVER] },
    ])
    assert.equal(r.warnings.length, 0, "no warnings: " + r.warnings.join("; "))
    assert.equal(r.tools.length, 2)
    const names = r.tools.map((t) => t.name).sort()
    assert.deepEqual(names, ["fake_echo", "fake_fail"])
    // Full schema available for direct calls
    assert.equal(r.tools.find((t) => t.name === "fake_echo").parameters.required?.[0], "text")
    // Direct call works
    assert.equal(await r.tools.find((t) => t.name === "fake_echo").execute({ text: "hello" }), "echo:hello")
    // Failing tool surfaces error
    await assert.rejects(() => r.tools.find((t) => t.name === "fake_fail").execute({}), /intentional failure/)
  })

  it("connectMcpServersExpanded is idempotent per server name (no transport leak)", async () => {
    const { connectMcpServersExpanded, mcpConnectedToolCounts } = mcp
    await connectMcpServersExpanded([{ name: "fake", command: process.execPath, args: [FAKE_SERVER] }])
    await connectMcpServersExpanded([{ name: "fake", command: process.execPath, args: [FAKE_SERVER] }])
    const counts = mcpConnectedToolCounts()
    assert.equal(counts.fake, 2, "one connection reused, not duplicated")
  })

  it("connectMcpServersExpanded: failures become warnings, never throw", async () => {
    const { connectMcpServersExpanded } = mcp
    const r = await connectMcpServersExpanded([
      { name: "ghost", command: "definitely-not-a-real-command-xyz", args: [] },
    ])
    assert.equal(r.tools.length, 0)
    assert.equal(r.warnings.length, 1)
    assert.ok(r.warnings[0].includes("ghost"), r.warnings[0])
    assert.ok(r.warnings[0].includes("failed to connect"), r.warnings[0])
  })

  it("gateway mcp tool is removed from the builtin registry", async () => {
    const { builtinTools } = await import("../src/tools/index.mjs")
    assert.ok(!builtinTools.some((t) => t.name === "mcp"), "mcp gateway tool must be gone")
  })
})
