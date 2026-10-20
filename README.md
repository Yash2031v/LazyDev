# LazyDev — Local-First Open-Weight AI Developer Assistant

> **Slow and Steady Open-Source AI**: Keep your source code, project analysis, and workflows completely local, private, and under explicit developer permission control.

---

## 1. Overview

**LazyDev** is a local-first AI coding assistant designed for safe developer-workflow automation. It is architected specifically around open-weight models executed locally via Ollama, ensuring:

- **100% Local-First Privacy**: Source code, project analysis, and logs never leave your machine or get sent to remote AI cloud APIs.
- **Permission-Controlled Safety**: Two-phase action execution where file mutations require visual diff inspection and explicit developer approval before any project file is modified.
- **Reliable Offline Operation**: Works without an internet connection once the runtime and local open-weight models are installed.

---

## 2. Current Status — Milestone 4: Local AI Assistant & Permission-Gated Edit Automation

This repository implements **Milestone 4**. LazyDev introduces a complete end-to-end local AI pair-programming assistant that leverages open-weight models executed locally through Ollama, connecting local model inference directly into the permission-gated proposal and diff engine.

### Implemented Features (Milestones 1 – 4)
- **Local Ollama Integration**:
  - Non-streaming typed `OllamaClient.chat()` endpoint connecting to local Ollama (`http://127.0.0.1:11434/api/chat`).
  - Strict loopback-only host validation rejecting remote DNS, public IPs, private LAN IPs, and URLs with credentials or query parameters.
  - HTTP redirect rejection (`redirect: 'error'`) preventing prompt exfiltration.
  - Bounded incremental stream reading with early reader cancellation to protect against memory exhaustion.
- **AI Task Assistant & Prompt Orchestration**:
  - `PromptBuilder`: Assembles bounded system instructions and target file context with hard context limits.
  - `ResponseParser`: Robustly extracts structured JSON proposals from candidate model outputs, handling markdown fences, conversational preambles, and trailing commas.
  - `AiService`: Coordinates model selection, context building, model querying, structured parsing, and proposal staging.
  - `RequestCancellationManager`: Isolated per-task `AbortController` tracking ensuring cancellation of one task never affects concurrent requests.
- **End-to-End Safe Workflow**:
  - `User Task Prompt` → `Local Ollama Inference` → `Structured Parser` → `Staged Proposal in EditorService` → `Visual Unified Diff Inspection` → `Explicit Approval Token Verification` → `Atomic Disk Write with Automatic Backup`.
  - Zero model outputs are written directly to disk without passing through the permission gate.
- **Desktop Developer Interface**:
  - Live local Ollama connectivity status pill and dynamic model selector.
  - AI Task Assistant with target file pre-population on file click.
  - Live progress feedback with real-time cancel button.
  - Interactive unified diff modal with side-by-side addition/deletion metrics and color-coded viewer.
  - 2-phase Approve and Apply buttons with single-use cryptographic tokens.
- **Defensive Security & Zero Cloud Dependency**:
  - 100% loopback-only binding (`127.0.0.1`). Zero external cloud AI APIs, zero telemetry, zero analytics.
  - Path traversal blockers (`resolveSafeRelativePath`), secret exclusions (`.env`, `.npmrc`, `.ssh`), and binary filters.
  - Atomic rename writes with file-handle sync and local rollback backups.

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
[LazyDev] Mode: OLLAMA (http://127.0.0.1:11434)
```

Open your browser to: **`http://127.0.0.1:4173`**

### Running in Ollama-Free Demo Mode

If Ollama is not installed or running, start LazyDev in deterministic local Demo Mode:

```powershell
# Windows PowerShell
$env:LAZYDEV_AI_MODE="demo"
npm run dev

# Or inline on bash / POSIX:
LAZYDEV_AI_MODE=demo npm run dev
```

Output:
```
[LazyDev] Local server listening at http://127.0.0.1:4173
[LazyDev] Security check: Bound exclusively to loopback (127.0.0.1)
[LazyDev] Mode: DEMO MODE (LAZYDEV_AI_MODE=demo) — Ollama will not be contacted.
```

In Demo Mode:
- Zero connections to Ollama or any remote service.
- The UI displays **“Demo Mode — no AI model connected.”**
- Generates clearly labeled deterministic sample proposals (`[DEMO MODE SAMPLE]`).
- Full unified diff inspection, rejection, explicit approval token, atomic file apply, and backup protections remain 100% active.


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

### `GET /api/ai/models`
Returns list of local models installed in Ollama.
```json
{
  "models": ["qwen2.5-coder:7b", "llama3.2:3b"]
}
```

### `POST /api/ai/task`
Assembles context, queries local Ollama model, and stages a permission-gated proposal.
```json
// Request
{
  "model": "qwen2.5-coder:7b",
  "targetFilePath": "src/utils.ts",
  "taskPrompt": "Add error boundary to calculation",
  "taskId": "optional-custom-task-id"
}

// Response (201 Created)
{
  "message": "AI edit proposal staged successfully.",
  "result": {
    "taskId": "task-1729420000-abc1",
    "explanation": "Added try/catch error boundary",
    "model": "qwen2.5-coder:7b",
    "proposal": {
      "id": "c1f7b0a8-...",
      "status": "awaiting_approval",
      "relativePath": "src/utils.ts",
      "diff": { "additions": 5, "deletions": 1, "unified": "..." }
    }
  }
}
```

### `POST /api/ai/cancel`
Cancels an active AI generation task by task ID using isolated AbortControllers.
```json
// Request
{ "taskId": "task-1729420000-abc1" }

// Response (200 OK)
{ "message": "Task cancelled successfully.", "cancelled": true }
```

---

## 6. Public Demo Mode vs. Local Development Mode

LazyDev supports two distinct operational modes designed for security and hackathon judging:

| Feature / Property | Local Development Mode (Default) | Public Demo Mode (Render Hosted) |
| :--- | :--- | :--- |
| **Primary Use Case** | Real pair programming on developer machine | Live hackathon demo & judge evaluation |
| **Activation** | Default or `LAZYDEV_AI_MODE=demo` | `LAZYDEV_PUBLIC_DEMO=true` |
| **Network Interface** | Loopback only: `127.0.0.1` | Platform interface: `0.0.0.0` (Render) |
| **Server Disk Access** | Active local project directory | **ZERO disk access** (403 Forbidden on `POST /api/project/root`) |
| **Workspace Storage** | Real local filesystem with atomic rollback backups | Isolated disposable in-memory virtual sandbox |
| **AI Model Inference** | Local Ollama (`http://127.0.0.1:11434`) | Offline deterministic sample proposals (no Ollama required) |
| **Rate Limiting** | Disabled (local developer speed) | Active sliding window (30 mutations/min per session/IP) |
| **Anti-CSRF & Origin** | Local origin & loopback host validation | Verified host wildcard matching (`*.onrender.com`) |
| **External Dependencies**| Zero cloud APIs, zero telemetry, zero databases | Zero cloud APIs, zero telemetry, zero databases |

---

## 7. Render Deployment Guide (Public Demo Mode Only)

LazyDev is pre-configured for one-click deployment as a Web Service on [Render](https://render.com).

> [!IMPORTANT]
> When deployed to Render or any public hosting provider, LazyDev runs strictly in **Public Demo Mode**. All arbitrary filesystem reads, writes, path browsing, and shell executions are blocked. File operations and proposals exist purely in disposable memory per judge session.

### Manual Render Setup Steps

1. **Create Web Service**:
   - In your Render dashboard, click **New +** → **Web Service**.
   - Connect your GitHub repository: `Yash2031v/LazyDev`.
2. **Configure Runtime & Commands**:
   - **Environment**: `Node`
   - **Build Command**: `npm run build`
   - **Start Command**: `npm start`
   - **Plan**: `Free`
3. **Configure Environment Variables**:
   Add the following environment variables in the Render dashboard:
   - `NODE_VERSION`: `22`
   - `NODE_ENV`: `production`
   - `NPM_CONFIG_PRODUCTION`: `false`
   - `LAZYDEV_PUBLIC_DEMO`: `true`
   - `LAZYDEV_AI_MODE`: `demo`
   - `HOST`: `0.0.0.0`
   - `ALLOWED_HOSTS`: `*.onrender.com,localhost:*,127.0.0.1:*`
4. **Health Check Path**:
   - Set Health Check Path to: `/api/health`
5. **Deploy**:
   - Click **Create Web Service**.
   - Once deployed, open `https://<your-service-name>.onrender.com` in your browser.
   - The UI will display the **Public Demo** banner with a pre-indexed sample project ready for judges to test AI proposals, visual diffs, and permission-gated approvals.

---

## 8. Architecture Roadmap

| Milestone | Focus | Status |
| :---: | :--- | :---: |
| **0** | Repository Inspection & Architecture Plan | Complete |
| **1** | Professional Foundation & Local Scaffolding | Complete |
| **2** | Safe Codebase Indexing & Read-Only Tools | Complete |
| **2.1** | Security Audit & Multi-Layer Hardening | Complete |
| **3** | Permission-Gated File Editing & Diff Engine | Complete |
| **3.1** | Permission & Atomic Safety Audit | Complete |
| **4** | Local AI Assistant & Permission-Gated Edit Automation | **Complete (Current)** |
| **5** | Advanced Task Decomposition & Multi-File Planning | Next |

---

## 7. License

MIT License. See [LICENSE](LICENSE) for details.
