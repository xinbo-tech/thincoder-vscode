# Responses API Transport — 设计

> 状态：**设计定稿，待实施**（2026-08-15，用户拍板："不完整收益不明显的就算了，有完整支持的实现一下"）
> 关联：`MODEL-PICKER-UNIFY.md`（provider format 体系）、各厂商官方文档（2026-08-15 核实）

---

## 1. 背景：支持矩阵核实（一手源）

Responses API（OpenAI 2025-03 推出的 agent 原生协议）已被国产模型大面积跟进，但**支持完整度差异极大**。按用户决策：只实现完整支持者，残缺支持者不接。

| 厂商/端点 | 输入输出格式 | 服务端状态 (`store`+`previous_response_id`) | reasoning 回传 | 内置工具 | 判定 |
|---|---|---|---|---|---|
| **OpenAI 官方** `api.openai.com/v1/responses` | ✅ | ✅（store:true + 30 天） | ✅ encrypted_content | ✅ 全家桶 | **完整 → 实现** |
| **阿里 Qwen（百炼）** `/compatible-mode/v1/responses` | ✅ | ✅ previous_response_id（**7 天有效**，官方多轮示例） | ✅ reasoning.effort | ✅ 全家桶（联网/网页抓取/code_interpreter/文搜图/图搜图/知识库） | **完整 → 实现** |
| **智谱 GLM Coding Plan** `open.bigmodel.cn/api/v1` | ✅（官方 Codex 接入姿势 wire_api="responses"） | 未文档化 | effort 支持（models.json 里 reasoning levels） | 未文档化 | **格式完整、状态未证实 → 按"有状态能力探测"接入**（见 §3.4） |
| DeepSeek 官方 | ✅ | ❌ **恒 store:false、previous_response_id 不支持**（无状态，官方兼容性表） | ❌ summary/encrypted_content 不支持 | 仅 web_search + apply_patch（Codex 专用） | **残缺 → 不接**（chat completions 等价，无收益） |
| Kimi/Moonshot | ❌ 平台 API 无 responses 端点（仅 Kimi Code CLI 内置 openai_responses provider 供 OpenAI 官方端点用） | — | — | — | **无 → 不接** |
| 火山方舟（豆包） | ✅（迁移文档存在） | 未核实完整 | 未核实 | 联网插件 | **待核实 → 一期不接**，矩阵留位 |

**结论**：一期实现 **OpenAI 官方 + 阿里 Qwen（百炼）**；GLM coding-plan 按"能力探测"策略接入（探测失败自动降级 chat completions）；DeepSeek/Kimi 不接。

## 2. thincoder 要什么（能力映射）

我们不需要 Responses 的全部能力——agent 循环、工具执行、历史管理都在本地。真正映射到我们的：

| Responses 能力 | thincoder 用法 | 价值 |
|---|---|---|
| **input/output item 格式** | messages → input items 的双向转换（transport 职责） | 协议接入的基础 |
| **reasoning items 回传** | 思考链跨工具轮保留（DeepSeek 思考模型的 reasoning_content 必须回传同款问题） | 多轮工具调用思考连贯；**我们全量历史回传，天然兼容** |
| **流式事件** | `response.output_text.delta` / `response.reasoning_text.delta` / `response.function_call_arguments.delta` → 现有 onToken/onReasoning | UI 流式不变 |
| **服务端状态** | **不用**——我们本地双行历史（压缩/落档/跨端共享）是核心资产，服务端状态 7 天过期且锁定厂商 | 明确放弃 |
| **内置工具** | 一期不用——我们的工具集（权限门/审计/活动流）是产品本体 | 二期再议（web_search 可选透传） |
| **instructions 字段** | system prompt → instructions（一次性的 system 消息，不进 input） | 与 chat completions 的 system 消息等价映射 |

## 3. 设计

### 3.1 transport 层：`src/provider/transponses/responses.mjs`（插件与 CLI 同名同构）

```js
export function normalizeTools(tools)      // OpenAI function schema → {type:"function", name, ...} 扁平形态
export function buildRequest(provider, messages, tools)
  // messages → input items：
  //   system 消息 → 不进 input，抽为顶层 instructions
  //   user/assistant text → {type:"message", role, content:[{type:"input_text"|"output_text", text}]}
  //   assistant tool_calls → {type:"function_call", call_id, name, arguments}
  //   tool 结果 → {type:"function_call_output", call_id, output}
  //   reasoning_content（历史回传）→ {type:"reasoning", content}（Qwen/GLM 支持；OpenAI 官方端点不回传明文）
  // 顶层：{ model, instructions, input, tools, stream:true, reasoning:{effort}, max_output_tokens, temperature }
export function normalizeUsageCache(u)     // usage.input_tokens_details.cached_tokens → 现有 cache 字段
export async function parseStream(response, { onToken, onReasoning, signal })
  // SSE 事件流 → 现有回调：
  //   response.output_text.delta → onToken(delta)
  //   response.reasoning_text.delta → onReasoning(delta)
  //   response.function_call_arguments.delta → 聚合（arguments 累积）
  //   response.completed → 组装最终 { content, toolCalls, usage }
  //   response.incomplete / response.failed → 错误/截断信号
```

**toolCalls 组装**：`output_item.added`（function_call item 开始）建立 call_id → {id, name, args} 槽位，`function_call_arguments.delta` 累积，`output_item.done` 定稿。最终形态与 openai transport 输出一致（`{ id, name, arguments }`），agent 循环零改动。

### 3.2 注册与格式选择

- `TRANSPORTS.responses = responsesTransport`（两仓库 provider.mjs / core.mjs 的 getTransport）
- provider 配置 `format: "responses"`（现有 format 字段的新值，面板 Add provider 表单的下拉加一项）
- **preset 不改**：Qwen/GLM 现有 preset 仍走 chat completions（默认稳态）；想用 responses 的用户显式配 format（高级用法，CLI parity）

### 3.3 续跑/压缩兼容

- agent 循环发给 transport 的是**统一的 messages 数组**，transport 负责 item 化——本地历史（压缩、落档、会话恢复）完全不知道 Responses 存在，零耦合
- ContinueError 续跑：transport 无状态（见 §2 明确放弃服务端状态），每次请求全量 input——与 chat completions 行为一致

### 3.4 GLM coding-plan 的能力探测

GLM 的 responses 端点（`open.bigmodel.cn/api/v1`）格式完整但 store/内置工具未文档化。策略：
- preset `zhipu-plan-responses` 不做；用户自定义 provider 配 `format: "responses"` + coding-plan baseURL 即可用
- transport 不探测不降级——**探测是隐藏决策**，违背显式配置原则；用户配了 responses 就按 responses 走，端点不支持会得到明确的服务端错误

### 3.5 受影响文件（两仓库对称）

| 文件 | 动作 |
|---|---|
| `src/provider/transports/responses.mjs`（插件）/ `src/provider/responses.mjs`（CLI，对齐现有文件布局） | 新增：transport 四函数 |
| `src/provider.mjs`（插件）/ `src/provider/core.mjs`（CLI） | TRANSPORTS 注册 |
| `webview/settings.js` + `locales/*` | Add provider 表单 format 下拉加 "responses" |
| `test/responses-transport.test.mjs` | 新增（见 §5） |

CLI 的 webview 无面板改动（CLI 配置走 config.json 手编，无表单）。

## 4. 关键决策记录

- **只接完整支持者**（用户拍板）：OpenAI 官方 + Qwen 百炼；DeepSeek（无状态残缺）/ Kimi（无端点）明确不接，理由记录在 §1 矩阵
- **放弃服务端状态**：本地双行历史是核心资产（压缩/落档/CLI↔插件共享/会话恢复），服务端状态 7 天过期且锁厂商——transport 保持无状态全量回传
- **不放弃 reasoning 回传**：明文 reasoning content 进 input（Qwen/GLM 支持），与 DeepSeek chat completions 的 reasoning_content 回传同款语义
- **preset 不动**：默认稳态 chat completions；responses 是显式 opt-in（format 字段）
- **不探测不降级**：显式配置显式失败，隐藏降级违背产品原则

## 5. 测试

| 用例 | 断言 |
|---|---|
| buildRequest 消息转换 | system→instructions；user/assistant→message items；tool_calls→function_call items；tool 结果→function_call_output；reasoning_content→reasoning item |
| buildRequest 工具转换 | OpenAI function schema → 扁平 tools |
| parseStream 文本流 | output_text.delta 序列 → onToken 聚合 |
| parseStream 思考流 | reasoning_text.delta → onReasoning |
| parseStream 工具调用 | added/delta/done 三段事件 → 完整 toolCalls（多工具并行） |
| parseStream 完成/失败 | completed 带 usage；failed 抛错；incomplete 标记截断 |
| 续跑往返 | 上一轮的 function_call item + output 回传后模型能继续（fixture 回放） |
| 注册 | format:"responses" 命中新 transport；未配 format 仍走 openai |
