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

// ─── 2026-08-31 MCP 会诊鲁棒性 ──────────────────────────────────

describe("2026-08-31 MCP 会诊：transport 鲁棒性", () => {
  it("stdio close 立即 failAll（在途请求不挂 120s）+ isAlive 变化（P2）", async () => {
    const { stdioTransport } = await import("../src/mcp/stdio.mjs")
    const t = stdioTransport(process.execPath, ["-e", "setInterval(()=>{},1000)"])
    assert.ok(t.isAlive(), "spawn 后 isAlive")
    // 主动 close：不发任何请求也立即 "Connection closed"（原实现 close 只是 child.kill()
    // 不置位不 failAll，此前的 send 全挂满 CALL_TIMEOUT_MS）
    t.close()
    assert.equal(t.isAlive(), false, "close 后 isAlive=false")
    await assert.rejects(() => t.send("tools/list", {}), /connection closed/i, "close 后 send 立即拒绝")
  })

  it("buildMcpTools：sanitize 碰撞去重 / 空名跳过 / 畸形 schema 兜底（P6/P8）", async () => {
    const { buildMcpTools } = await import("../src/mcp/index.mjs")
    // 直接测 buildMcpTools 纯函数路径：构造 registry 形状的 server entry
    const server = {
      config: { name: "srv" },
      transport: { isAlive: () => true, send: async () => ({ id: "1", result: { content: [{}] } }), close: () => {} },
      tools: [
        { name: "foo bar", description: "ok" },                  // sanitize → foo_bar
        { name: "foo.bar", description: undefined },             // sanitize → foo_bar（碰撞）
        { name: "!!!", description: { nope: true } },            // 全特殊 → 空名跳过
        { name: "ok", inputSchema: "not-a-schema", description: 42 }, // 畸形 schema/description 兜底
      ],
    }
    const tools = buildMcpTools(server)
    const names = tools.map((t) => t.name)
    assert.equal(tools.length, 4, "全符号名 sanitize 成 srv___（合法唯一名），4 个全保留")
    assert.ok(names.includes("srv_foo_bar"), "首个 foo bar 用原 sanitize 名")
    assert.ok(names.includes("srv_foo_bar_2"), "碰撞去重追加 _2")
    assert.ok(names.includes("srv____"), "全符号名 sanitize 成下划线串（防御保留）")
    assert.equal(new Set(names).size, names.length, "无重名")
    const ok = tools.find((t) => t.name === "srv_ok")
    assert.deepEqual(ok.parameters, { type: "object", properties: {} }, "畸形 inputSchema 兜底")
    assert.equal(ok.description, "MCP tool: ok", "非字符串 description 兜底")
    // execute：isError 抛错 + content 非数组防御 + 截断
    // fake transport 返回 content:[{}]（元素无 type/text）——防御分支 JSON.stringify 输出，
    // 不抛 TypeError（原实现 c.type 访问 undefined OK 但 JSON.stringify(c) 也 OK——防御验证
    // 落在 filter 保留对象）
    const bad = await tools[0].execute({}, {})
    assert.equal(bad, "{}", "空对象元素输出其 JSON 表示，不抛 TypeError")
  })

  it("execute：result.isError 抛错而非当作成功输出（P6）", async () => {
    const { buildMcpTools } = await import("../src/mcp/index.mjs")
    const server = {
      config: { name: "srv" },
      transport: { send: async () => ({ id: "1", result: { isError: true, content: [{ type: "text", text: "boom" }] } }), close: () => {} },
      tools: [{ name: "f", description: "d" }],
    }
    const t = buildMcpTools(server)[0]
    await assert.rejects(() => t.execute({}, {}), /isError|boom/, "isError 必须 throw")
  })
})

})
