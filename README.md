# LazyDev — Local-First Open-Weight AI Developer Assistant

> **Slow and Steady Open-Source AI**: Keep your source code, project analysis, and workflows completely local, private, and under explicit developer permission control.

---

## 1. Overview

**LazyDev** is a local-first AI coding assistant designed for safe developer-workflow automation. It is architected specifically around open-weight models executed locally via Ollama, ensuring:

- **100% Local-First Privacy**: Source code, project analysis, and logs never leave your machine or get sent to remote AI cloud APIs.
- **Permission-Controlled Safety**: Two-phase action execution where file mutations require visual diff inspection and explicit developer approval before any project file is modified.
- **Reliable Offline Operation**: Works without an internet connection once the runtime and local open-weight models are installed.

---

## 2. Current Status — Milestone 3: Permission-Gated File Editing and Diff Engine

This repository implements **Milestone 3**. LazyDev introduces a controlled file-editing system that lets developers review proposed changes and explicitly approve them before any project file is touched on disk.

### Implemented Features (Milestone 1 + Milestone 2 + Milestone 3)
- **Strict Loopback Server**: An HTTP server built entirely on Node.js standard libraries, binding exclusively to `127.0.0.1` (never `0.0.0.0`).
- **Validated Environment Configuration**: Support for `PORT` (default: `4173`), `HOST` (default: `127.0.0.1`), `OLLAMA_HOST` (default: `http://127.0.0.1:11434`), and `OLLAMA_TIMEOUT_MS` (default: `2000`).
- **Defensive Security Guardrails**: Host header validation, Origin & Sec-Fetch-Site cross-origin blockers, Content Security Policy (`default-src 'self'`), clickjacking prevention, and request payload size limits (64KB).
- **Safe Codebase Indexer**: Canonical project root validation (`fs.realpath`), symlink escape protection, `.gitignore` parsing, secret file exclusion (`.env`, private keys), and binary detection.
- **Unified Diff Engine (Zero Dependencies)**:
  - Custom Longest Common Subsequence (LCS) matrix diff generator with line additions, deletions, context preservation, and standard unified diff formatting.
  - Normalizes CRLF and LF line endings to prevent false Windows diffs.
- **Permission-Gated State Machine**:
  - Distinct lifecycle states: `draft → awaiting_approval → approved → applied`, with terminal states `rejected`, `expired`, and `conflict`.
  - Creating a proposal writes **zero bytes to disk**.
  - Approval is bound to an exact proposal ID, project root, target path, and SHA-256 hash.
  - Approval requires a separate explicit user action via a 32-byte cryptographic single-use token.
  - Stale file detection: if the file on disk changes after the preview was generated, the proposal transitions to `conflict` and cannot be applied.
  - Configurable TTL: expired proposals are blocked from approval or execution.
- **Atomic Application & Rollback**:
  - Re-validates root boundary, secret rules, binary extensions, and file hash immediately before applying.
  - Generates a local backup (`.lazydev-backup-${id}.bak`) before file content replacement.
  - Writes new content to an isolated temporary file (`.lazydev-tmp-${id}.tmp`) in the target directory, flushes to physical storage (`handle.sync()`), closes handles, and executes an atomic replacement via `fs.rename`.
  - Automatically rolls back from backup if any step fails.
- **Desktop Developer Interface**:
  - Live local-AI connectivity status pill.
  - Proposal creation form with relative path validation.
  - Interactive proposal review modal with side-by-side addition/deletion metrics and color-coded unified diff viewer.
  - Separate Approve, Reject, and Apply action buttons.

### Safety Limitations & Windows Considerations
- **Windows File Handle Locking**: On Windows, open file handles prevent file renaming and deletion (`EBUSY / EPERM`). LazyDev explicitly flushes and closes all file handles prior to executing atomic rename operations.
- **Filesystem Volatility & TOCTOU**: While LazyDev checks file hashes immediately before rename, non-POSIX filesystems lack atomic compare-and-swap primitives for disk files. LazyDev mitigates this by maintaining a recoverable backup file in the local directory.
- **AI Inference Not Included in Milestone 3**: Autonomous agents and model-generated proposals are part of Milestone 4. Milestone 3 implements the foundational permission-gated verification and diff engine.

---

## 3. Privacy Boundary & Security Model

LazyDev adheres strictly to zero-leakage principles:

1. **No External Network Calls**: The server only listens on loopback (`127.0.0.1`) and only talks to the local Ollama daemon (`http://127.0.0.1:11434`).
2. **Untrusted Data Policy**: Repository files, comments, and README instructions are treated as untrusted text data. The system never executes arbitrary shell commands or unsanitized code.
3. **Secret Protection**: Excluded secret files (`.env`, private keys, tokens) are never read, edited, or overwritten. Attempting to create a proposal for a secret file returns `400 Bad Request`.
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

All 103 tests across 15 suites run completely offline without requiring Ollama or internet access.

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

## 5. API Reference (Proposals & File Editing Endpoints)

### `POST /api/project/proposals`
Creates a proposed file change preview without modifying any file on disk.
```json
// Request
{
  "relativePath": "src/utils.ts",
  "newContent": "export function add(a: number, b: number) { return a + b; }\n",
  "ttlMs": 900000
}

// Response (201 Created)
{
  "message": "Proposal created successfully. Explicit user approval is required before applying.",
  "proposal": {
    "id": "c1f7b0a8-...",
    "relativePath": "src/utils.ts",
    "status": "awaiting_approval",
    "approvalToken": "8f3e...",
    "createdAt": "2026-10-20T12:00:00.000Z",
    "expiresAt": "2026-10-20T12:15:00.000Z",
    "diff": {
      "unified": "--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ -1,1 +1,1 @@\n+export function add(a: number, b: number) { return a + b; }\n",
      "additions": 1,
      "deletions": 0,
      "isIdentical": false
    }
  }
}
```

### `GET /api/project/proposals`
Lists active proposals for the currently loaded project root.

### `GET /api/project/proposals/:id`
Retrieves proposal status, diff preview, and conflict diagnostics.

### `POST /api/project/proposals/:id/approve`
Explicitly approves a proposed change using its cryptographic single-use approval token.
```json
// Request
{
  "approvalToken": "8f3e..."
}
```

### `POST /api/project/proposals/:id/reject`
Rejects a proposal and transitions it to a terminal `rejected` state.
```json
// Request
{
  "reason": "Developer chose alternative approach."
}
```

### `POST /api/project/proposals/:id/apply`
Applies an approved proposal to disk using atomic rename and backup generation.
```json
// Request
{
  "approvalToken": "8f3e..."
}

// Response (200 OK)
{
  "message": "File changes applied to disk successfully.",
  "result": {
    "success": true,
    "status": "applied",
    "proposalId": "c1f7b0a8-...",
    "relativePath": "src/utils.ts",
    "bytesWritten": 61,
    "backupPath": "D:\\Project main\\LazyDev\\src\\.lazydev-backup-c1f7b0a8.bak",
    "appliedAt": "2026-10-20T12:01:00.000Z"
  }
}
```

---

## 6. Architecture Roadmap

| Milestone | Focus | Status |
| :---: | :--- | :---: |
| **0** | Repository Inspection & Architecture Plan | Complete |
| **1** | Professional Foundation & Local Scaffolding | Complete |
| **2** | Safe Codebase Indexing & Read-Only Tools | Complete |
| **2.1** | Security Audit & Multi-Layer Hardening | Complete |
| **3** | Permission-Gated File Editing & Diff Engine | **Complete (Current)** |
| **4** | Open-Weight Model Orchestration & Prompts | Planned |
| **5** | Desktop UI & User Approval Workflows | Planned |
| **6** | End-to-End Testing & Packaging | Planned |

---

## 7. License

MIT License. See [LICENSE](LICENSE) for details.
