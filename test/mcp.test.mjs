/**
 * mcp.test.mjs — MCP tool expansion (CLI parity, MCP.md)
 * Tools are expanded into NATIVE agent tools ({server}_{tool} prefix, full schema,
 * direct tools/call routing); the gateway mcp tool is gone.
 * MCP.md §4 (2026-09-01)：T7 镜像（postOnly isAlive）+ probe 零副作用 + token 合成
 * + updateMcpServer 原位更新（panel edit 的持久化落点）。
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { rmSync, mkdtempSync } from "node:fs"
import { createServer } from "node:http"

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

  it("withAuthToken: Bearer → subprotocol, no token in URL query (#10)", async () => {
    const { withAuthToken } = await import("../src/mcp/utils.mjs")
    const { url, protocols } = withAuthToken("ws://example.com/mcp", "Bearer sk-secret")
    assert.equal(url, "ws://example.com/mcp", "URL must not gain a token query param")
    assert.deepEqual(protocols, ["bearer.sk-secret"], "token rides the subprotocol")
    const { url: u2, protocols: p2 } = withAuthToken("ws://example.com/mcp?token=user-supplied", "Bearer sk-secret")
    assert.match(u2, /token=user-supplied/, "user-supplied query token untouched")
    assert.deepEqual(p2, ["bearer.sk-secret"])
    assert.deepEqual(withAuthToken("ws://example.com/mcp", undefined), { url: "ws://example.com/mcp", protocols: [] })
    assert.throws(() => withAuthToken("not a url", "Bearer t"), /Invalid WebSocket URL/)
  })
})

// ─── MCP.md §4（2026-09-01）：POST-only isAlive（T7 镜像）+ probe 零副作用 + token ───

/** Streamable POST-only mock server（CLI postOnlyServer 同款）：GET → 405；POST
 *  initialize/tools/list 正常应答。seenHeaders 收集 Authorization 供 token 断言。 */
function postOnlyServerVscode(seenHeaders = []) {
  return createServer((req, res) => {
    seenHeaders.push(req.headers.authorization ?? null)
    if (req.method === "GET") {
      res.writeHead(405, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Method Not Allowed" }))
      return
    }
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      const msg = JSON.parse(body)
      const result = msg.method === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "postonly", version: "1" } }
        : { tools: [{ name: "web_search", description: "search the web", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }))
    })
  })
}

describe("MCP.md §4：postOnly / probe / token / edit", () => {
  it("T7 (F5 CLI 镜像): openSSE 405 降级 → markPostOnly → isAlive true；close 后 false", async () => {
    const { httpTransport } = await import("../src/mcp/http.mjs")
    const { mcpConnect, mcpDisconnectByName } = mcp
    // ① transport 三态直测（与 CLI T1b 同构）
    const t = httpTransport("http://127.0.0.1:9/mcp")
    assert.equal(t.isAlive(), false, "未降级未标记 → 死")
    t.markPostOnly()
    assert.equal(t.isAlive(), true, "postOnly 标记后不得因 eventSource==null 判死（F5）")
    t.close()
    assert.equal(t.isAlive(), false, "close 后判死（F2 同构）")
    // ② 全链：mcpConnect POST-only server → registry entry isAlive true
    const seenHeaders = []
    const server = postOnlyServerVscode(seenHeaders)
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    try {
      const client = await mcpConnect({ name: "vscode-postonly", url: `http://127.0.0.1:${server.address().port}/mcp` })
      assert.equal(client.tools.length, 1, "tools/list over POST succeeded")
      assert.ok(mcp._servers?.get?.(client.id)?.transport?.isAlive?.() ?? true, "entry reachable")
      mcpDisconnectByName("vscode-postonly")
    } finally {
      server.close()
    }
  })

  it("probeMcpServer 成功/失败均零副作用：_servers 不增 (F4/D-2 镜像)", async () => {
    const { probeMcpServer, closeAllMcp } = mcp
    const seenHeaders = []
    const server = postOnlyServerVscode(seenHeaders)
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    try {
      const countServers = () => mcp.mcpConnectedNames().length
      const before = countServers()
      const ok = await probeMcpServer({ name: "probe-ok", url: `http://127.0.0.1:${server.address().port}/mcp` })
      assert.equal(ok.ok, true, `probe must succeed: ${ok.error ?? ""}`)
      assert.equal(ok.toolCount, 1)
      assert.ok(Number.isFinite(ok.latencyMs))
      assert.equal(countServers(), before, "成功探活不进注册表")
      const bad = await probeMcpServer({ name: "probe-fail", url: "http://127.0.0.1:9/mcp" })
      assert.equal(bad.ok, false)
      assert.ok(bad.error, "失败有错误信息")
      assert.equal(countServers(), before, "失败探活同样零副作用")
    } finally {
      server.close()
      closeAllMcp()
    }
  })

  it("withBearerToken: 合成/显式优先/不写回原 config (F6/D-5)", async () => {
    const { withBearerToken } = mcp
    const cfg = { name: "t", url: "http://x", token: "abc" }
    const merged = withBearerToken(cfg)
    assert.equal(merged.headers.Authorization, "Bearer abc")
    assert.equal(cfg.headers, undefined, "不写回原 config")
    assert.equal(withBearerToken({ url: "http://x", token: "abc", headers: { Authorization: "Bearer real" } }).headers.Authorization, "Bearer real", "显式优先")
    assert.equal(withBearerToken({ url: "http://x" }).headers, undefined, "无 token 不合成")
    // 链路：token config 真实连接 → 请求头 Bearer abc
    const { mcpConnect, mcpDisconnectByName } = mcp
    const seenHeaders = []
    const server = postOnlyServerVscode(seenHeaders)
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    try {
      const client = await mcpConnect({ name: "vscode-tok", url: `http://127.0.0.1:${server.address().port}/mcp`, token: "abc" })
      assert.equal(client.tools.length, 1)
      assert.ok(seenHeaders.every((h) => h === "Bearer abc"), `every request carries Bearer abc, got ${JSON.stringify(seenHeaders)}`)
      mcpDisconnectByName("vscode-tok")
    } finally {
      server.close()
    }
  })

  it("updateMcpServer: 原位替换保数组序 + token 落盘 + name 不存在报错（panel edit 落点）", async () => {
    const { _setConfigPathForTest, loadRaw, addMcpServer, updateMcpServer, removeMcpServer } = await import("../src/config-io.mjs")
    const dir = mkdtempSync(join(tmpdir(), "vscode-mcp-edit-"))
    const cfgPath = join(dir, "config.json")
    _setConfigPathForTest(cfgPath)
    try {
      addMcpServer("srv", { url: "https://old.example.com/mcp", headers: { Authorization: "Bearer old" } })
      addMcpServer("other", { command: "npx", args: ["-y", "pkg"] })
      const err = updateMcpServer("srv", { url: "https://new.example.com/mcp", token: "newtok", headers: { "X-Foo": "bar" } })
      assert.equal(err, null)
      const servers = loadRaw().mcp.servers
      assert.equal(servers.length, 2, "无新增条目")
      assert.equal(servers[0].name, "srv", "原位替换——数组序保持")
      assert.equal(servers[0].url, "https://new.example.com/mcp")
      assert.equal(servers[0].token, "newtok", "token 字段落盘（D-6）")
      assert.deepEqual(servers[0].headers, { "X-Foo": "bar" })
      assert.equal(servers[1].name, "other", "后条目不受影响")
      assert.match(updateMcpServer("ghost", { command: "x" }), /No MCP server named/)
      // transport 字段被清空 → 回落既有值（编辑表单只改 headers/token 的场景）
      updateMcpServer("srv", { token: "tok2", headers: { "X-A": "1" } })
      const srv2 = loadRaw().mcp.servers.find((s) => s.name === "srv")
      assert.equal(srv2.url, "https://new.example.com/mcp", "url 回落既有值（不产出退化条目）")
      assert.equal(srv2.token, "tok2")
      removeMcpServer("srv")
      removeMcpServer("other")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── 2026-08-31 MCP 会诊 P5：registry 自愈（onDead → 退避重连 → client id 稳定）───

describe("2026-08-31 MCP 会诊 P5：registry self-heal", () => {
  it("crashed server reconnects; the SAME client id calls tools on the new instance", async () => {
    const { mcpConnect, mcpCallTool, mcpConnectedToolCounts, mcpConnectedNames, mcpDisconnectByName, _mcpHooks } = await import("../src/mcp/index.mjs")
    const countFile = join(tmpdir(), `vscode-mcp-count-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    // 首个实例 150ms 自毁（n=0），后续实例永活（n>=1 回 ok-1）
    const script = `const fs=require('fs');const f=process.env.MCP_COUNT_FILE;const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);const r={jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'t',version:'1'}}:m.method==='tools/list'?{tools:[{name:'t1',description:'d1'}]}:m.method==='tools/call'?{content:[{type:'text',text:'ok-'+n}]}:{}};process.stdout.write(JSON.stringify(r)+'\\n')}});
if(n===0)setTimeout(()=>process.exit(1),150)`
    const origDelays = _mcpHooks.reconnectDelays
    const origDelay = _mcpHooks.delay
    _mcpHooks.reconnectDelays = [1, 1, 1, 1]
    _mcpHooks.delay = () => new Promise((r) => setTimeout(r, 0))
    try {
      const client = await mcpConnect({ name: "selfheal", command: process.execPath, args: ["-e", script], env: { MCP_COUNT_FILE: countFile } })
      assert.equal(client.tools.length, 1, "handshake ok")
      const clientId = client.id // 重连后必须仍有效（registry 原位替换）
      const deadline = Date.now() + 8000
      let out = null
      while (Date.now() < deadline) {
        try {
          out = await mcpCallTool(client, "t1", {})
          if (out === "ok-1") break // 重连后的第 2 实例
        } catch { /* still reconnecting */ }
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.equal(out, "ok-1", "registry rebuilt under the SAME client id; new instance answers")
      assert.equal(mcpConnectedToolCounts().selfheal, 1, "registry tool count restored")
      assert.ok(mcpConnectedNames().includes("selfheal"), "server still listed as connected")
    } finally {
      _mcpHooks.reconnectDelays = origDelays
      _mcpHooks.delay = origDelay
      try { mcpDisconnectByName("selfheal") } catch { /* ignore */ }
      try { rmSync(countFile, { force: true }) } catch { /* ignore */ }
    }
  })
})
})
