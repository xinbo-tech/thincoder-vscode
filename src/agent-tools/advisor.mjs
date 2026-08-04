/**
 * agent-tools/advisor.mjs — advisor tool wrapper (VS Code port, kept in sync with CLI).
 * The agent calls this explicitly to get an independent review.
 * type="design" for design doc review, type="code" for code review (default).
 */
import { randomUUID, createHmac } from "node:crypto"
import { runAdvisorReview } from "../advisor/run.mjs"

const TOKEN_EXPIRY_MS = 3600000 // 1 hour
const TOKEN_SECRET = process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret"

/** Generate a signed design token with expiration */
function generateDesignToken() {
  const uuid = randomUUID()
  const expiresAt = Date.now() + TOKEN_EXPIRY_MS
  const payload = `${uuid}:${expiresAt}`
  const signature = createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex").slice(0, 16)
  return `${payload}:${signature}`
}

/** Validate design token: check format, expiration, and signature.
 *  Tokens not matching the signed format are accepted as-is (backward compat, CLI parity). */
export function validateDesignToken(token) {
  if (!token || typeof token !== "string") return false

  const parts = token.split(":")
  if (parts.length !== 3) return true

  const [uuid, expiresAt, signature] = parts
  const expTime = parseInt(expiresAt, 10)

  if (isNaN(expTime)) return true

  if (Date.now() > expTime) return false

  const payload = `${uuid}:${expiresAt}`
  const expectedSig = createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex").slice(0, 16)
  return signature === expectedSig
}

/** Extract UUID from signed token for regex matching */
export function extractTokenUUID(token) {
  const parts = token.split(":")
  return parts.length >= 1 ? parts[0] : token
}

/** Build a [DESIGN-TOKEN:...] regex (CLI parity — flexible surrounding context). */
const makeDesignTokenRegex = (token, flags = "") => {
  const uuid = extractTokenUUID(token)
  const escaped = uuid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `(?:^|\\s|\`|\\*)\\[DESIGN-TOKEN:\\s*${escaped}\\s*\\](?:\\s|$|\`|\\*)`,
    flags + "ms"
  )
}

export const advisorTool = {
  name: "advisor",
  description:
    "Run an independent review on your work. " +
    "Use type='design' to review design documents before implementation — pass documents=[...] with the explicit list of doc paths to review; use documents in code review too (the task's Docs involved list). " +
    "Use type='code' (default) to review code changes after implementation — pass paths=[...] to specify which files or directories to review, or documents=[...] for acceptance criteria context. " +
    "The advisor is an independent read-only sub-agent that explores the codebase, runs git diff, " +
    "reads files, and traces callers via grep. " +
    "For code review: round 1 does a full review, round 2 verifies the prior table, " +
    "round 3+ strictly checks only the prior table — convergence, not divergence. " +
    "For design review: single-pass review against methodology and requirements. " +
    "Review criteria come from .thincoder/advisor.md (if present) or sensible defaults. " +
    "After the review, you MUST produce a response table (see discipline rules for format). " +
    "If advisor says all clear, call verify.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["code", "design"], description: "Review type: 'design' for design doc review, 'code' for code review (default)" },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Code files or directories to review (for code review). Required unless documents is provided. The advisor reviews git diff filtered to these paths.",
      },
      documents: {
        type: "array",
        items: { type: "string" },
        description: "Explicit list of doc paths to review (design docs, requirements docs, referenced docs). The advisor reviews ONLY these — it does NOT scan git diff. Use for both design review and code review to pass the task's Docs involved list.",
      },
    },
  },
  readonly: true,
  sideEffectExempt: true,
  outputPanel: true,
  async execute(args, ctx) {
    const agent = ctx.agent
    const reviewType = args.type || "code"
    const documents = args.documents || null
    const paths = args.paths || null

    // Code review must have a scope — no implicit fallback.
    if (reviewType !== "design" && !paths && !documents) {
      return "Advisor: no review scope specified. Provide paths (files/directories to review) or documents (acceptance criteria — code diff is still used)."
    }

    // Design review: validate that documents are in docs/ or are recognized doc files
    if (reviewType === "design" && documents) {
      const { isDocFile } = await import("../advisor/repos.mjs")
      const invalidDocs = documents.filter((doc) => {
        if (doc.startsWith("docs/") || doc.startsWith("docs\\")) return false
        return !isDocFile(doc)
      })
      if (invalidDocs.length > 0) {
        return `Advisor: design review documents must be in docs/ directory or be recognized doc files. Invalid: ${invalidDocs.join(", ")}`
      }
    }

    // Design review: always starts from round 1 (no convergence)
    if (reviewType === "design") {
      agent._advisorRound = 0
      agent._advisorSession = null
    }

    // Generate the design token BEFORE the review and inject it into the advisor's prompt.
    const designToken = reviewType === "design" ? generateDesignToken() : null
    // Progress lines stream into the webview tool panel (advisor.outputPanel semantics).
    const result = await runAdvisorReview(agent, reviewType, {
      onOutput: (text) => ctx.callbacks?.onToolPanel?.("advisor", text),
      signal: ctx.signal,
    }, designToken, documents, paths)

    if (reviewType === "design") {
      const tokenPattern = makeDesignTokenRegex(designToken)
      if (designToken && result && tokenPattern.test(result)) {
        // Advisor echoed the token → review passed. Issue it to the parent for eng-coder.
        agent._engDesignToken = designToken
        if (agent._role === "eng-coder") agent._engDesignReviewed = true
        const cleanResult = result.replace(makeDesignTokenRegex(designToken, "g"), "").trim()
        return `${cleanResult}\n\nApproved. Pass this exact token to eng-coder (designToken parameter): ${designToken}`
      }
      // Review failed (or advisor chose not to pass) → invalidate any previously-issued token.
      // Guard: result === null means the review was skipped — must not revoke an issued token.
      if (result !== null) agent._engDesignToken = null
      if (result) {
        const stripped = result.replace(makeDesignTokenRegex(designToken, "g"), "").trim()
        return stripped || "Advisor: design review did not pass."
      }
    }
    return result
  },
}
