# LazyDev — Local-First Open-Weight AI Developer Assistant

> **Slow and Steady Open-Source AI**: Keep your source code, project analysis, and workflows completely local, private, and under explicit developer permission control.

---

## 1. Overview

**LazyDev** is a local-first AI coding assistant designed for safe developer-workflow automation. It is architected specifically around open-weight models executed locally via Ollama, ensuring:

- **100% Local-First Privacy**: Source code, project analysis, and logs never leave your machine or get sent to remote AI cloud APIs.
- **Permission-Controlled Safety**: Two-phase action execution where file mutations and terminal commands require visual diff inspection and explicit developer approval.
- **Reliable Offline Operation**: Works without an internet connection once the runtime and local open-weight models are installed.

---

## 2. Current Status — Milestone 2: Safe Codebase Indexer & Read-Only Tools

This repository implements **Milestone 2**. LazyDev can safely index, summarize, and search developer repositories in a **strictly read-only mode** with deep anti-traversal protection and secret-exclusion guarantees.

### Implemented Features (Milestone 1 + Milestone 2)
- **Strict Loopback Server**: An HTTP server built entirely on Node.js standard libraries, binding exclusively to `127.0.0.1` (never `0.0.0.0`).
- **Validated Environment Configuration**: Support for `PORT` (default: `4173`), `HOST` (default: `127.0.0.1`), `OLLAMA_HOST` (default: `http://127.0.0.1:11434`), and `OLLAMA_TIMEOUT_MS` (default: `2000`).
- **Defensive Host Header Validation**: Rejects unexpected or spoofed host headers with `400 Bad Request`.
- **Security Headers**: Content Security Policy (`default-src 'self'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **Resilient Ollama Health Probe**: Probes `GET /api/tags` with configurable timeout; handles offline/timeout gracefully without crashing.
- **Safe Codebase Indexer**:
  - Explicit user-selected project root with full canonicalization (`fs.realpath`).
  - Strict boundary defense: rejects drive roots (`C:\`, `/`), user home directories (`C:\Users\Username`), and system paths.
  - Defense against directory traversal (`..`), absolute paths, null bytes (`\0`), and Windows Alternate Data Streams (`:`).
  - Physical symlink escape prevention: symlinks pointing outside the project root are safely rejected.
  - Automatic exclusion of `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.cache`, `.turbo`, `vendor`, `.venv`.
  - Automatic exclusion of secrets: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `credentials.json`, `token.json`, `secrets.*`.
  - Automatic exclusion of binary files via extension matching and first-512-byte null-character heuristic.
  - Bounded scan limits: `maxFiles` (2,000), `maxDepth` (15 levels), `maxFileSizeBytes` (512 KB).
  - Lightweight, dependency-free `.gitignore` parser supporting comments (`#`), trailing directory slashes (`dir/`), wildcards (`*`, `**`), and negation (`!`).
- **Read-Only Developer Tools**:
  - `GET /api/project/files`: List indexed text files and skipped files.
  - `GET /api/project/summary`: File count, total size, file types breakdown, top directories.
  - `GET /api/project/file?path=...`: Read permitted text file with secret and size guards.
  - `POST /api/project/search`: Bounded text search across permitted files with line numbers and line snippets.
- **Desktop Developer Interface**:
  - High-contrast graphite/emerald aesthetic.
  - Live local-AI connectivity status pill.
  - Project indexing input, file browser, search bar, and read-only file viewer modal.
  - Zero external CDN scripts, remote fonts, or analytics.

### Current Limitations
- **Read-Only by Design**: Milestone 2 does not write, rename, delete, or modify any files on disk.
- **Model Inference Not Yet Implemented**: Milestone 4 will integrate open-weight LLMs (e.g. Qwen 2.5 Coder, Llama 3.2) for task decomposition and error explanations.
- **Diff Preview & Action Gate Pending**: Milestone 3 will introduce permission-controlled file edit proposals and unified diff previews.

---

## 3. Privacy Boundary & Security Model

LazyDev adheres strictly to zero-leakage principles:

1. **No External Network Calls**: The server only listens on loopback (`127.0.0.1`) and only talks to the local Ollama daemon (`http://127.0.0.1:11434`).
2. **Untrusted Data Policy**: Repository files, comments, and README instructions are treated as untrusted text data. The system never executes code or prompts discovered in scanned projects.
3. **Secret Protection**: Excluded secret files (`.env`, private keys, tokens) are never read or returned over API endpoints. Attempting to access an excluded secret path yields `403 Forbidden`.
4. **No Third-Party Telemetry**: There are zero tracking pixels, analytics scripts, remote fonts, or cloud SDKs.

---

## 4. Setup & Development Guide (Windows PowerShell)

### Prerequisites
- **Node.js**: `v20.0.0` or higher (tested on `v24.13.0` x64)
- **npm**: `v10.0.0` or higher (tested on `11.6.2`)
- **Git**: Installed and available in PATH
- **Ollama (Optional)**: [https://ollama.com/download/windows](https://ollama.com/download/windows)

### Installation

```powershell
# Navigate to project directory
cd "d:\Project main\LazyDev"

# Install dependencies (only typescript, @types/node, tsx)
npm install
```

### Running the Development Server

```powershell
npm run dev
```

Output:
```
[LazyDev] Local server listening at http://127.0.0.1:4173
[LazyDev] Security check: Bound exclusively to loopback (127.0.0.1)
[LazyDev] Ollama target: http://127.0.0.1:11434
```

Open your browser to: **`http://127.0.0.1:4173`**

### Running the Automated Tests

Run the built-in test suite:

```powershell
npm test
```

All 62 tests run completely offline without requiring Ollama or internet access.

### Type Checking & Production Build

```powershell
# Static type checking
npm run typecheck

# Compile TypeScript to ./dist
npm run build

# Run production build
npm start
```

---

## 5. API Reference (Read-Only Codebase Endpoints)

### `POST /api/project/root`
Configures and scans a local project root.
```json
// Request
{
  "path": "D:\\Project main\\LazyDev"
}

// Response
{
  "message": "Project root set and scanned successfully.",
  "root": "D:\\Project main\\LazyDev",
  "scan": {
    "totalFilesScanned": 24,
    "limitReached": false,
    "warnings": []
  }
}
```

### `GET /api/project/summary`
Returns high-level structure metadata.
```json
{
  "rootPath": "D:\\Project main\\LazyDev",
  "totalFiles": 24,
  "totalSizeBytes": 84210,
  "fileTypes": {
    ".ts": 14,
    ".json": 4,
    ".css": 1,
    ".html": 1,
    ".md": 1
  },
  "topDirectories": ["src", "tests"],
  "skippedCount": 3,
  "warnings": []
}
```

### `GET /api/project/file?path=src/server/index.ts`
Retrieves permitted text file content.
```json
{
  "relativePath": "src/server/index.ts",
  "content": "...",
  "sizeBytes": 2889,
  "modifiedTime": "2026-10-20T12:00:00.000Z"
}
```

### `POST /api/project/search`
Searches for text across permitted project files.
```json
// Request
{
  "query": "LazyDev",
  "caseSensitive": false,
  "maxResults": 50
}

// Response
{
  "query": "LazyDev",
  "totalMatches": 12,
  "limitReached": false,
  "matches": [
    {
      "relativePath": "src/server/index.ts",
      "lineNumber": 57,
      "lineContent": "console.log(`[LazyDev] Local server listening at http://${config.host}:${config.port}`);"
    }
  ]
}
```

---

## 6. Architecture Roadmap

| Milestone | Focus | Status |
| :---: | :--- | :---: |
| **0** | Repository Inspection & Architecture Plan | Complete |
| **1** | Professional Foundation & Local Scaffolding | Complete |
| **2** | Safe Codebase Indexing & Read-Only Tools | **Complete (Current)** |
| **3** | Permission-Controlled Tool System & Diff Engine | Planned |
| **4** | Open-Weight Model Orchestration & Prompts | Planned |
| **5** | Desktop UI & User Approval Workflows | Planned |
| **6** | End-to-End Testing & Packaging | Planned |

---

## 7. License

MIT License. See [LICENSE](LICENSE) for details.
