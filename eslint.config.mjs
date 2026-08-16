import js from "@eslint/js"

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        // Browser / Webview
        document: "readonly", window: "readonly", navigator: "readonly",
        acquireVsCodeApi: "readonly", FileReader: "readonly",
        fetch: "readonly", AbortSignal: "readonly", AbortController: "readonly",
        DOMException: "readonly", FormData: "readonly", URLSearchParams: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly",
        clearInterval: "readonly", // webview/chat.js timer cleanup (browser runtime)
        requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly", // webview/chat.js stream render throttle<｜end▁of▁thinking｜>
        // Node.js
        process: "readonly", console: "readonly", Buffer: "readonly",
        TextDecoder: "readonly", TextEncoder: "readonly", URL: "readonly",
        WebSocket: "readonly", Headers: "readonly", Response: "readonly", Request: "readonly",
        ReadableStream: "readonly", // Node 18+ global (used by provider.test.mjs SSE mocks)
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-constant-condition": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-cond-assign": "warn",
      "no-redeclare": "warn",
      "no-fallthrough": "warn",
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
    },
  },
  {
    ignores: ["node_modules/**", "*.vsix", "**/thincoder-vscode-*.vsix"],
  },
]
