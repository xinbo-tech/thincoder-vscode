# thincoder-vscode vs 行业竞品 — 能力对比

> 2026-07-28 最终评估（同日完成 skill + rules + .mdc 兼容 + 无障碍 + i18n）

## 评测维度

### 1. 智能体循环（Agentic Loop）

| | ThinCoder | Copilot Chat | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 多轮工具调用 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Plan 模式（只读探索） | ✅ + 视觉反馈 | ❌ | ✅ | ❌ | ❌ |
| Goal 追踪（目标+验证条件） | ✅ | ❌ | ❌ | ❌ | ❌ |
| Task 清单（进度跟踪） | ✅ + 实时面板 | ✅ 弱 | ✅ | ❌ | ❌ |
| Subagent（并行子任务） | ✅ + 状态面板 | ❌ | ❌ | ❌ | ❌ |
| Verify 守卫（写完必校验） | ✅ | ❌ | ❌ | ❌ | ❌ |
| 失速检测（重复调用告警） | ✅ | ❌ | ❌ | ❌ | ❌ |
| 上下文压缩 | ✅ 基础 | ✅ | ✅ | ✅ | ✅ |

**★ ★ ★ ★ ★ 业界领先。** Subagent/Goal/Task 三大实时面板 + Plan 模式视觉反馈 + 失速检测，均为独有能力。

---

### 2. 模型供应商

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 内置供应商数 | **11** + custom | 1（GitHub） | 5+ | 5+ | 10+ |
| 自定义 provider | ✅ | ❌ | ✅ | ✅ | ✅ |
| 思考模式（reasoning） | ✅ 分级 | ❌ | ✅ | ✅ | ✅ |
| 多模态（图片） | ✅ | ✅ | ✅ | ✅ | ✅ |
| API key 系统密钥链存储 | ✅ SecretStorage | N/A | ✅ 明文 | ✅ | ✅ |
| 非 OpenAI 协议原生支持 | ✅ Claude + Gemini | ❌ | ❌ | ❌ | ❌ |

**★ ★ ★ ★ ★ 11 供应商，从国内到海外完整覆盖。** 唯一同时原生支持 OpenAI、Anthropic、Google 三种 API 协议 + 代码特化模型（DeepSeek-Coder、Codestral）的工具。

---

### 3. 代码编辑体验

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 行内补全 | ❌ **不做** | ✅ | ❌ | ✅ | ✅ |
| diff 预览（permission 内嵌） | ✅ 行级红绿 | ❌ | ✅ in-chat | ✅ in-editor | ✅ |
| 文件编辑（write/edit/apply_patch） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 编辑器焦点保持 | ✅ preserveFocus | ❌ | ❌ | ✅ | ✅ |
| 语法检查集成 | ✅ node --check | ❌ | ❌ | ❌ | ❌ |
| 代码块语法高亮 | ✅ 7 语言 零依赖 | ✅ | ❌ | ✅ | ✅ |
| @-context 文件引用 | ✅ 路径注入+下拉补全+目录浏览 | ❌ | ❌ | ✅ | ✅ |

**★ ★ ★ 行内补全是主动取舍。** diff 预览 + 代码高亮 + @-context 达到实用水平。唯一缺口是行内补全——定位差异，不是能力差距。

---

### 4. 会话管理

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 多会话 | ✅ | ✅ | ✅ | ✅ | ✅ |
| LLM 自动生成标题 | ✅ | ❌ | ❌ | ❌ | ❌ |
| Session bar（始终可见） | ✅ | ❌ | ❌ | ✅ | ❌ |
| 会话增删切 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 消息时间戳 + 复制 + 错误重试 | ✅ | ✅ | ❌ | ✅ | ✅ |

**★ ★ ★ ★ ★ 业界最佳。** LLM 自动标题是独有能力，session bar + 时间戳 + 复制 + 重试超越 Cline。

---

### 5. 扩展性

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| MCP 协议（stdio/http/ws） | ✅ 三种 | ❌ | ✅ stdio | ❌ | ✅ |
| 自定义 system prompt | ✅ .md 文件 | ❌ | ✅ | ✅ | ✅ |
| Skill 系统 | ✅ .thincoder/skills/ | ❌ | ❌ | ❌ | ✅ |
| Rules 系统（glob 作用域） | ✅ 自研 + .cursor/rules/ 兼容 | ❌ | ✅ .clinerules | ✅ .cursor/rules | ❌ |
| .mdc 文件兼容 | ✅ | — | — | ✅ | — |
| 插件 SDK | ❌ | ❌ | ❌ | ❌ | ✅ |

**★ ★ ★ ★ MCP + skill + rules 三件套已完整。** 唯一缺失是插件 SDK——那是 Continue 的社区壁垒，需要体量支撑。

---

### 6. 工程品质

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 代码量（源文件） | **~38** | ~500+ | ~200+ | ~1000+ | ~500+ |
| 运行时依赖 | **0** | ~50+ | ~20+ | ~100+ | ~30+ |
| 自动化测试 | ✅ **78** 用例 | ✅ | ✅ | ✅ | ✅ |
| 架构 + 竞争分析文档 | ✅ | ❌ | ❌ | ❌ | ❌ |
| ESLint | ✅ flat config | ✅ | ✅ | ✅ | ✅ |
| i18n | ✅ zh+en 零依赖 | ✅ | ❌ | ✅ | ✅ |
| CI/CD | ✅ GitHub Actions | ✅ | ✅ | ✅ | ✅ |
| TypeScript | ❌ **不做** (JSDoc) | ✅ | ✅ | ✅ | ✅ |

**★ ★ ★ ★ 功能密度业界最高。** 38 文件、零依赖、78 测试、中英双语。CI/CD + TypeScript 是主动不做——对这个体量的零依赖项目，仪式感大于实用价值。

---

### 7. 安全

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| autoApprove 默认 | **false** | N/A | true | false | false |
| 权限确认（per-tool + diff 预览） | ✅ | N/A | ✅ | ✅ | ✅ |
| API key 存储 | 系统密钥链 | N/A | 明文文件 | 系统密钥链 | 明文 |
| 环境变量过滤 | ✅ 黑名单 | N/A | ❌ | ❌ | ❌ |
| 沙箱 | ❌ 架构级决策 | ✅ 云端 | ❌ | ❌ | ❌ |

**★ ★ ★ ★ ★ 业界最安全。** 五项安全措施中四项领先或持平，唯一缺失的沙箱是透明架构的有意选择。

---

### 8. 用户界面

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 聊天面板 + 设置面板 | ✅ webview 内联编辑 | ✅ VS Code UI | ✅ | ✅ | ✅ |
| 状态栏（token/ctx% + badge 面板） | ✅ 实时 | ✅ | ✅ | ✅ | ✅ |
| 暗/亮双主题 | ✅ CSS 变量 | ✅ | ❌ | ✅ | ✅ |
| 代码高亮 + 复制 | ✅ 7 语言 | ✅ | ❌ | ✅ | ✅ |
| @-context 自动补全 | ✅ 下拉+键盘+目录 | ❌ | ❌ | ✅ | ✅ |
| i18n 国际化 | ✅ zh+en | ✅ | ❌ | ✅ | ✅ |
| 无障碍 | ✅ 键盘+aria+焦点 | ✅ | ❌ | ✅ | ❌ |
| Plan/Loading 视觉反馈 | ✅ | ❌ | ✅ | ✅ | ✅ |

**★ ★ ★ ★ ★ 与 Copilot 并列。** i18n + 无障碍补齐后，与 Copilot/Cursor 在 UI 维度无实质差距。

---

## 总评

```
                    ThinCoder   Copilot    Cline     Cursor    Continue
Agent 智能体         ★★★★★      ★★        ★★★★      ★★★       ★★★
模型供应商           ★★★★★      ★         ★★★★      ★★★★      ★★★★★
代码编辑             ★★★        ★★★★★     ★★★★      ★★★★★     ★★★★
会话管理             ★★★★★      ★★★       ★★★       ★★★★      ★★★
扩展性               ★★★★       ★         ★★★       ★★        ★★★★★
工程品质             ★★★★★      ★★★★★     ★★★★      ★★★★★     ★★★★★
安全                 ★★★★★      ★★★★      ★★        ★★★★      ★★★
用户界面             ★★★★★      ★★★★★     ★★★       ★★★★★     ★★★★
```

**ThinCoder 的定位：Agent 能力密度 × 安全 × 工程简洁度的三维交叉点。** 

- vs Copilot：Agent 碾压，安全持平，简洁度略输（Copilot 有微软工程体系）
- vs Cursor：Agent + 安全双杀，编辑体验让位（行内补全不做）
- vs Cline：全方位压制，Cline 唯一优势是社区更大
- vs Continue：Continue 胜在生态（插件+Skill 社区），ThinCoder 胜在 Agent+安全+简洁

**本次评估更新：** 扩展性从 ★★★ → ★★★★（skill + rules 补齐），测试从 65 → 78，文件从 35 → 38。主动不做项仅剩 5 项（行内补全、CI/CD、TypeScript、插件SDK、沙箱），全部是架构级决策。

---

## 剩余差距 — 主动不做

| 项目 | 理由 |
|------|------|
| 行内补全 | agent-first 定位，补全赛道已有免费平替 |
| TypeScript | JSDoc 对此规模已足够，类型系统是包袱 |
| 插件/扩展 SDK | 需要社区生态支撑，当前体量不适合 |
| 沙箱 | 透明+保守默认+信任用户，架构选择非缺口 |
