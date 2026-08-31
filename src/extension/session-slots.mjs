/**
 * session-slots.mjs — manifest / slot claiming / slot-number management (VS Code side).
 * Split out of session-io.mjs (2026-09-01: 606 lines > 500 hard limit, CLI did the same
 * split — session.mjs → session-slots.mjs). session-io.mjs keeps the session-file
 * business logic and re-exports everything from here, so callers' import paths are
 * unchanged.
 *
 * Storage contract parity with the CLI (docs/design/SESSION.md): same files
 * (~/.thincoder/sessions/<sha1(cwd)>.json.{N,manifest}), same claiming rules, same
 * manifest merge semantics.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"

let currentSessionId = null
let sessionsDirOverride = null

/** Test seam (2026-09-01 advisor 🔵): migration tests must not touch the real
 *  ~/.thincoder/sessions — call _setSessionsDirForTest(tmp) before use, and
 *  _resetSessionsDirForTest() in afterEach to restore the real dir (process-level
 *  global; node:test isolates per file, but reset keeps future in-process runners safe). */
export function _setSessionsDirForTest(dir) {
  sessionsDirOverride = dir
}

export function _resetSessionsDirForTest() {
  sessionsDirOverride = null
}

/** Unique session ID for this extension-host process (same format as CLI: pid-ts-rand). */
export function getSessionId() {
  if (!currentSessionId) {
    currentSessionId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
  return currentSessionId
}

export function sessionsDir() {
  return sessionsDirOverride ?? join(homedir(), ".thincoder", "sessions")
}

/** Normalize cwd for hashing: uppercase Windows drive letter so the extension's
 *  uri.fsPath (lowercased) matches the CLI's process.cwd() hash. */
export function normalizeCwd(cwd) {
  return cwd.replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ":")
}

/** Full sha1 hex (40 chars), not truncated. Shared contract with the CLI. */
function cwdHash(cwd) {
  return createHash("sha1").update(normalizeCwd(cwd)).digest("hex")
}

/** One-time migration: rename legacy short-hash session files to the full 40-char hash.
 *  Idempotent; runs on first access per cwd (2026-09-01 advisor round2 🔵：已迁移/确认无
 *  legacy 的 hash 记录在 Set 中短路——否则每次 slotPath/manifestPath 都重跑 5 候选 × 3
 *  existsSync 的系统调用）。
 *  Historical hash algorithms (all sha1, none normalized the drive letter):
 *    - CLI:      sha1(cwd).slice(0, 12)      — cwd comes from process.cwd() (uppercase drive on Windows)
 *    - VS Code:  sha1(cwd).slice(0, 16)      — cwd comes from uri.fsPath (LOWERCASE drive on Windows)
 *  Plus the previous migration attempt's assumption (normalized 12 = first 12 of the full hash).
 *  Every combination is tried — a migration that only checks one candidate misses real
 *  legacy files (drive-letter case differs between CLI and VS Code historical paths). */
const migratedHashes = new Set() // full 40-char hash → migration already attempted (found none or done)
function migrateHashLength(cwd, fullHash) {
  if (migratedHashes.has(fullHash)) return false
  const dir = sessionsDir()
  const lower = cwd.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ":")
  const candidates = [
    createHash("sha1").update(cwd).digest("hex").slice(0, 12),
    createHash("sha1").update(cwd).digest("hex").slice(0, 16),
    createHash("sha1").update(lower).digest("hex").slice(0, 12),
    createHash("sha1").update(lower).digest("hex").slice(0, 16),
    fullHash.slice(0, 12),
  ]
  const newBase = join(dir, `${fullHash}.json`)
  let migrated = false
  for (const short of new Set(candidates)) {
    const legacyBase = join(dir, `${short}.json`)
    if (!existsSync(legacyBase) && !existsSync(`${legacyBase}.manifest`) && !existsSync(`${legacyBase}.1`)) continue
    migrated = true
    try {
      for (const suffix of ["", ".manifest", ...Array.from({ length: 64 }, (_, i) => `.${i + 1}`)]) {
        const from = legacyBase + suffix
        if (existsSync(from) && !existsSync(newBase + suffix)) renameSync(from, newBase + suffix)
      }
    } catch { /* best-effort */ }
  }
  migratedHashes.add(fullHash)
  return migrated
}

function basePath(cwd) {
  const hash = cwdHash(cwd)
  migrateHashLength(cwd, hash)
  return join(sessionsDir(), `${hash}.json`)
}

export function slotPath(cwd, n) { return `${basePath(cwd)}.${n}` }
export function manifestPath(cwd) { return `${basePath(cwd)}.manifest` }

/** Atomic write: write to temp file then rename (same as CLI writeSessionFile). */
export function writeFile(p, data) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(data), "utf8")
  try {
    renameSync(tmp, p)
  } catch {
    try { unlinkSync(p) } catch {}
    try { renameSync(tmp, p) } catch { writeFileSync(p, readFileSync(tmp, "utf8"), "utf8") }
  }
}

// ─── Manifest ───────────────────────────────────────────────

export function loadManifest(cwd) {
  try {
    const p = manifestPath(cwd)
    if (!existsSync(p)) return { slots: {}, active: null, sessionId: null }
    const m = JSON.parse(readFileSync(p, "utf8"))
    if (!m.slots) m.slots = {}
    if (!m.sessionId) m.sessionId = null
    return m
  } catch { return { slots: {}, active: null, sessionId: null } }
}

export function saveManifest(cwd, m, deletions = null, opts = {}) {
  // 2026-09-01 CLI 同步（会诊 kimi/deepseek 🟡）：写前重读按"条目级"合并——原实现把
  // 读时快照整对象写回，CLI/扩展双进程并发时窗口内对方的 slots/slotSessions/active
  // 变更被覆盖抹除（被抹认领的槽变"文件在、无属主"→ 第三方可认领 → 双属主）。
  // 删除意图经 deletions 显式表达（deleteSlotAndUpdate）；active 是单值——只有显式
  // 翻指针的调用点（ensureActive 分支、newSlot、switchToSlot、删除 active 时）传
  // setActive，其余默认保留磁盘 fresh.active。
  try {
    const p = manifestPath(cwd)
    if (existsSync(p)) {
      const fresh = JSON.parse(readFileSync(p, "utf8"))
      if (fresh && typeof fresh === "object" && fresh.slots && typeof fresh.slots === "object") {
        const merged = { ...fresh }
        if (opts.setActive) merged.active = m.active
        merged.slots = { ...fresh.slots, ...(m.slots ?? {}) }
        merged.slotSessions = { ...(fresh.slotSessions ?? {}), ...(m.slotSessions ?? {}) }
        if (m.sessionId) merged.sessionId = m.sessionId
        if (deletions) {
          for (const [section, keys] of Object.entries(deletions)) {
            for (const k of keys) delete merged[section]?.[k]
          }
        }
        m = merged
      }
    }
  } catch {
    // 首次创建或 manifest 不可读：用传入对象。解析失败先改名保留现场（与 CLI 对齐——
    // 否则覆盖后全部槽位元数据丢失）；文件不存在时 rename 抛错被吞，无害。
    try { renameSync(manifestPath(cwd), `${manifestPath(cwd)}.corrupted`) } catch {}
  }
  m.sessionId = getSessionId()
  writeFile(manifestPath(cwd), m)
}

// ─── Process liveness & slot claiming ───────────────────────

/** Check if a process with given PID is still alive (same as CLI session.mjs).
 *  Returns false if process doesn't exist or we can't determine. */
export function isProcessAlive(pid) {
  if (!pid || isNaN(pid)) return false
  try {
    if (process.platform === "win32") {
      // 2026-09-01 CLI 同步：/FI 已按 PID 过滤；用 CSV 格式解析 PID 列（第 2 列），
      // 避免旧 includes() 对镜像名含"数字+空格"（如 "app 123.exe"）的贪婪误判。
      const output = execSync(`tasklist /FO CSV /FI "PID eq ${pid}" /NH`, { encoding: "utf8", stdio: "pipe" })
      return output.split(/\r?\n/).some((line) => {
        const m = line.match(/^"([^"]*)","(\d+)"/)
        return m && m[2] === String(pid)
      })
    }
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Claim a slot for this process and set it as active. Idempotent. Mirrors CLI ensureActive.
 * Preference order:
 *  1. The current active slot, if it is unowned / ours / its owner is dead — reuse it.
 *  2. A slot whose FILE does not exist (2026-09-01 CLI 同步 会诊 F4 🔴——原实现认领
 *     "首个空闲 slot"，死主的旧槽文件仍在时会 resume 进陌生会话且保存覆盖它).
 *  3. A brand-new slot when all are owned by live processes (skip live-claimed /
 *     file-existing numbers; max from allSlots[last] — no Math.max spread).
 * The owner is recorded in m.slotSessions so other processes (CLI ↔ VS Code) can
 * see which slots are taken and avoid them.
 */
function ensureActive(cwd, m) {
  const mySessionId = getSessionId()
  if (!m.slotSessions) m.slotSessions = {}

  // 2026-09-01 CLI 同步（会诊 F4）：顺手清理死主条目——否则 slotSessions 只增不减，
  // 每次认领对全部死条目重跑 tasklist。活进程在"认领→首次保存"窗口文件暂缺——
  // 不能以"文件缺失"短路删除活主条目。slotSessions 的删除经 deadParam 显式落盘
  // （条目级合并会把磁盘死条目从 fresh 复活回写，仅传 m 等于没删）。
  let cleaned = false
  const deadSlots = []
  for (const [s, owner] of Object.entries(m.slotSessions)) {
    if (owner && owner !== mySessionId) {
      const pid = parseInt(owner.split("-")[0])
      if (!pid || !isProcessAlive(pid)) {
        delete m.slotSessions[s]
        deadSlots.push(s)
        cleaned = true
      }
    }
  }
  const deadParam = () => (cleaned ? { slotSessions: deadSlots.filter((s) => m.slotSessions[s] !== mySessionId) } : null)

  if (m.active && m.slotSessions[m.active] === mySessionId) {
    if (cleaned) saveManifest(cwd, m, deadParam())
    return
  }

  const isFree = (slot) => {
    const owner = m.slotSessions[slot]
    if (!owner || owner === mySessionId) return true
    return !isProcessAlive(parseInt(owner.split("-")[0]))
  }

  // 1. Prefer the current active slot if we can take it (preserves "resume where you left off").
  if (m.active && m.slots[m.active] && isFree(m.active)) {
    m.slotSessions[m.active] = mySessionId
    saveManifest(cwd, m, deadParam(), { setActive: true })
    return
  }

  // 2. Reclaim a slot whose FILE does not exist (never held a session).
  const allSlots = Object.keys(m.slots).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b)
  for (const slot of allSlots) {
    if (isFree(slot) && !existsSync(slotPath(cwd, slot))) {
      m.active = slot
      m.slotSessions[slot] = mySessionId
      saveManifest(cwd, m, deadParam(), { setActive: true })
      return
    }
  }

  // 3. All slots owned by live processes — allocate a new one (no limit).
  // 2026-09-01 CLI 同步（会诊 kimi 🟡）：新号从 max+1 起跳过"活进程已认领但尚未落盘"
  // 的号与现存文件号；max 取 allSlots[last]（数万槽位时 Math.max spread 有 RangeError 风险）。
  const liveClaimed = (n) => {
    const owner = m.slotSessions?.[n]
    return !!(owner && owner !== mySessionId && isProcessAlive(parseInt(owner.split("-")[0])))
  }
  let newSlot = allSlots.length > 0 ? allSlots[allSlots.length - 1] + 1 : 1
  while (liveClaimed(newSlot) || existsSync(slotPath(cwd, newSlot))) newSlot++
  m.active = newSlot
  m.slotSessions[newSlot] = mySessionId
  saveManifest(cwd, m, deadParam(), { setActive: true })
}

/** Get this process's active slot number, claiming one if needed (same as CLI activeSlot). */
export function activeSlot(cwd) {
  const m = loadManifest(cwd)
  ensureActive(cwd, m)
  return m.active
}

/** Is the target slot owned by ANOTHER LIVE process? (CLI parity slotOccupancy —
 *  same-process owner excluded; used by the panel before binding a switched slot.) */
export function slotOccupancy(cwd, slot) {
  const m = loadManifest(cwd)
  const owner = m.slotSessions?.[slot]
  if (!owner) return { occupied: false }
  if (owner === getSessionId()) return { occupied: false }
  const pid = parseInt(owner.split("-")[0])
  if (!pid || !isProcessAlive(pid)) return { occupied: false }
  return { occupied: true, owner }
}
