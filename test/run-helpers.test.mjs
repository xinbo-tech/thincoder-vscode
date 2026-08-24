/**
 * run-helpers.test.mjs — offloadToolResult 落盘与写时自清理（CLI parity，2026-08-21）。
 * 用例：① >3 天旧文件删除、新文件与子目录保留；② 3 天内边界文件保留；
 *       ③ 目录不存在时清理静默且 offload 照常；④ 落盘行为回归（全量+64K 预览+小结果不落盘）；
 *       ⑤ 64K 边界（65536 不落盘 / 65537 落盘）；⑥ 落盘失败回退截断 = 65536。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { offloadToolResult, TMP_RETENTION_MS } from "../src/agent/run-helpers.mjs"

test("offloadToolResult: >3 天旧文件删除，新文件与子目录保留", () => {
  const cwd = mkdtempSync(join(tmpdir(), "thincoder-vscode-tmp-"))
  try {
    const tmpDir = join(cwd, ".thincoder", "tmp")
    mkdirSync(tmpDir, { recursive: true })
    const oldFile = join(tmpDir, "tool-old.txt")
    writeFileSync(oldFile, "stale")
    const old = new Date(Date.now() - TMP_RETENTION_MS - 24 * 3600 * 1000) // 4 天前
    utimesSync(oldFile, old, old)
    const freshFile = join(tmpDir, "paste-fresh.png") // 同目录粘贴图片（paste-*）一并按保留期回收
    writeFileSync(freshFile, "png-bytes")
    const subdir = join(tmpDir, "keep-dir")
    mkdirSync(subdir)
    writeFileSync(join(subdir, "nested.txt"), "nested")

    const out = offloadToolResult(cwd, "x".repeat(70_000))
    assert.ok(!existsSync(oldFile), ">3 天旧文件应被删除")
    assert.ok(existsSync(freshFile), "刚写入的新文件应保留")
    assert.ok(existsSync(join(subdir, "nested.txt")), "子目录不动")
    // 回归：offload 本身行为不变（磁盘全量 + 64K 预览 + 路径指引）
    const m = out.match(/\[Large output saved\. Read the full result with the read tool: (.+)\]/)
    assert.ok(m, "应包含落盘路径")
    assert.equal(readFileSync(m[1], "utf8").length, 70_000)
    assert.ok(out.length > 20_000, "preview 放大到 64K（原 2K 限制已破）")
    assert.ok(out.length <= 64 * 1024 + 500, "preview 上限 64K + 路径开销")
    // 回归：小结果不落盘、不触发清理
    assert.equal(offloadToolResult(cwd, "short"), "short")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("offloadToolResult: 3 天内的边界文件保留", () => {
  const cwd = mkdtempSync(join(tmpdir(), "thincoder-vscode-tmp-"))
  try {
    const tmpDir = join(cwd, ".thincoder", "tmp")
    mkdirSync(tmpDir, { recursive: true })
    const boundary = join(tmpDir, "boundary.txt")
    writeFileSync(boundary, "keep me")
    const t = new Date(Date.now() - (TMP_RETENTION_MS - 3600 * 1000)) // 2 天 23 小时前，3 天内
    utimesSync(boundary, t, t)
    offloadToolResult(cwd, "y".repeat(70_000))
    assert.ok(existsSync(boundary), "mtime 在 3 天内的文件应保留")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("offloadToolResult: 目录不存在时清理静默，offload 正常落盘", () => {
  const cwd = mkdtempSync(join(tmpdir(), "thincoder-vscode-tmp-"))
  try {
    const out = offloadToolResult(cwd, "z".repeat(70_000)) // cwd 下无 .thincoder/tmp
    assert.match(out, /\[Large output saved\./, "目录不存在不抛异常，offload 正常返回落盘结果")
    const m = out.match(/\[Large output saved\. Read the full result with the read tool: (.+)\]/)
    assert.equal(readFileSync(m[1], "utf8").length, 70_000)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("offloadToolResult: 64K 边界 — 65536 不落盘原样返回，65537 落盘（AC1/AC2）", () => {
  const cwd = mkdtempSync(join(tmpdir(), "thincoder-vscode-tmp-"))
  try {
    // 恰好 64K：不落盘，返回原文（=== 输入）
    const at = "x".repeat(64 * 1024)
    assert.equal(offloadToolResult(cwd, at), at, "65536 字符应原样返回（不落盘）")
    // 64K + 1：落盘 + 64K preview + 路径指引，磁盘全量
    const over = "x".repeat(64 * 1024 + 1)
    const out = offloadToolResult(cwd, over)
    const m = out.match(/\[Large output saved\. Read the full result with the read tool: (.+)\]/)
    assert.ok(m, "65537 字符应落盘并返回路径指引")
    assert.equal(readFileSync(m[1], "utf8").length, 64 * 1024 + 1, "磁盘全量 65537")
    assert.ok(out.length > 20_000 && out.length <= 64 * 1024 + 500, "preview 放大到 64K（原 2K 限制已破）")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("offloadToolResult: 落盘失败回退截断 = 65536（评审 #6 / AC10）", () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-vscode-tmp-"))
  try {
    // cwd 指向一个普通文件 → mkdir .thincoder/tmp 必然失败 → 走回退截断路径
    const fileAsCwd = join(dir, "not-a-dir")
    writeFileSync(fileAsCwd, "occupied")
    const suffix = "\n... (truncated 1 chars)"
    const out = offloadToolResult(fileAsCwd, "x".repeat(64 * 1024 + 1))
    assert.equal(out.length, 64 * 1024 + suffix.length, "回退截断 = 65536 + 截断标注")
    assert.ok(out.startsWith("x".repeat(64 * 1024)), "回退截断保头 65536")
    assert.ok(out.endsWith(suffix), "截断标注存在")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
