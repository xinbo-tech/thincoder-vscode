/**
 * run-helpers.test.mjs — offloadToolResult 落盘与写时自清理（CLI parity，2026-08-21）。
 * 用例：① >3 天旧文件删除、新文件与子目录保留；② 3 天内边界文件保留；
 *       ③ 目录不存在时清理静默且 offload 照常；④ 落盘行为回归（全量+预览+小结果不落盘）。
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

    const out = offloadToolResult(cwd, "x".repeat(20_000))
    assert.ok(!existsSync(oldFile), ">3 天旧文件应被删除")
    assert.ok(existsSync(freshFile), "刚写入的新文件应保留")
    assert.ok(existsSync(join(subdir, "nested.txt")), "子目录不动")
    // 回归：offload 本身行为不变（磁盘全量 + 2k 预览 + 路径指引）
    const m = out.match(/\[Large output saved\. Read the full result with the read tool: (.+)\]/)
    assert.ok(m, "应包含落盘路径")
    assert.equal(readFileSync(m[1], "utf8").length, 20_000)
    assert.ok(out.length < 5000)
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
    offloadToolResult(cwd, "y".repeat(20_000))
    assert.ok(existsSync(boundary), "mtime 在 3 天内的文件应保留")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("offloadToolResult: 目录不存在时清理静默，offload 正常落盘", () => {
  const cwd = mkdtempSync(join(tmpdir(), "thincoder-vscode-tmp-"))
  try {
    const out = offloadToolResult(cwd, "z".repeat(20_000)) // cwd 下无 .thincoder/tmp
    assert.match(out, /\[Large output saved\./, "目录不存在不抛异常，offload 正常返回落盘结果")
    const m = out.match(/\[Large output saved\. Read the full result with the read tool: (.+)\]/)
    assert.equal(readFileSync(m[1], "utf8").length, 20_000)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
