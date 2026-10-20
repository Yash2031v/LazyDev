# LazyDev — Local-First Open-Weight AI Developer Assistant

> **Slow and Steady Open-Source AI**: Keep your source code, project analysis, and workflows completely local, private, and under explicit developer permission control.

---

## 1. Overview

**LazyDev** is a local-first AI coding assistant designed for safe developer-workflow automation. It is architected specifically around open-weight models executed locally via Ollama, ensuring:

- **100% Local-First Privacy**: Source code, project analysis, and logs never leave your machine or get sent to remote AI cloud APIs.
- **Permission-Controlled Safety**: Two-phase action execution where file mutations and terminal commands require visual diff inspection and explicit developer approval.
- **Reliable Offline Operation**: Works without an internet connection once the runtime and local open-weight models are installed.

---

## 2. Current Status — Milestone 1: Professional Foundation

This repository currently implements **Milestone 1**. The foundational runtime and security scaffolding are established:

### Implemented Features
- **Strict Loopback Server**: An HTTP server built on Node.js standard libraries, binding exclusively to `127.0.0.1` (never `0.0.0.0`).
- **Validated Environment Configuration**: Support for `PORT` (default: `4173`), `HOST` (default: `127.0.0.1`), `OLLAMA_HOST` (default: `http://127.0.0.1:11434`), and `OLLAMA_TIMEOUT_MS` (default: `2000`).
- **Defensive Host Header Validation**: Enforces trusted loopback hosts and rejects external or spoofed host headers with `400 Bad Request`.
- **Security Headers**: Standard defense-in-depth headers applied on all responses (`Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`).
- **Resilient Ollama Health Probe**:
  - Probes `GET /api/tags` with configurable timeout.
  - Gracefully handles offline status, connection timeouts, refused connections, and malformed responses without crashing.
  - Reports status at `GET /api/status`.
- **Health Check Endpoint**: `GET /api/health` providing uptime, status, and version.
- **Developer Shell Interface**: Desktop-oriented web interface served at `http://127.0.0.1:4173/`, featuring:
  - High-contrast graphite and restrained emerald aesthetic.
  - Live local-AI connectivity status pill.
  - Model catalog display and offline setup guidance.
  - Zero external CDN scripts, remote fonts, or telemetry.
- **Graceful Lifecycle Management**: Clean server termination on `SIGINT` and `SIGTERM`.
- **Automated Test Suite**: 23 unit and integration tests using Node's built-in test runner (`node:test`).

### Current Limitations
- **Model Inference Not Yet Implemented**: Milestone 1 establishes the connection probe and UI foundation. Active LLM prompt orchestration, streaming completion, and agent loops will be implemented in Milestone 4.
- **Codebase Indexing & File Tools Pending**: Safe read-only project traversal will be added in Milestone 2.
- **Tool Execution & Diff Engine Pending**: Mutation tools and permission gates will be added in Milestone 3.

---

## 3. Privacy Boundary & Security Model

LazyDev adheres strictly to zero-leakage principles:

1. **No External Network Calls**: The server only listens on loopback (`127.0.0.1`) and only talks to the local Ollama daemon (`http://127.0.0.1:11434`).
2. **No Third-Party Telemetry**: There are zero tracking pixels, analytics scripts, remote fonts, or cloud SDKs.
3. **No Unsanitized Error Leaks**: API error responses never expose stack traces, directory trees, or system environment variables.
4. **Planned Two-Phase Action Gate**:
   - *Phase 1 (Read/Analyze)*: File inspection is read-only by default.
   - *Phase 2 (Modify/Run)*: Any proposed edit or shell command generates an in-memory diff preview that halts for human approval before execution.

---

## 4. Setup & Development Guide (Windows PowerShell)

### Prerequisites
- **Node.js**: `v20.0.0` or higher (tested on `v24.13.0` x64)
- **npm**: `v10.0.0` or higher (tested on `11.6.2`)
- **Git**: Installed and available in PATH
- **Ollama (Optional for Milestone 1)**: Can be installed from [https://ollama.com/download/windows](https://ollama.com/download/windows) to test live open-weight model detection.

### Installation

Clone the repository and install the minimal developer dependencies:

```powershell
# Navigate to project directory
cd "d:\Project main\LazyDev"

# Install dependencies (only typescript, @types/node, tsx)
npm install
```

### Running the Development Server

Start the local server with live TypeScript compilation:

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

All 23 tests run offline without requiring Ollama or internet access.

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

## 5. Environment Variables

Create a `.env` file (refer to `.env.example`) to customize configuration:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4173` | Port for the local web server (0-65535) |
| `HOST` | `127.0.0.1` | Loopback host (`127.0.0.1` or `localhost` only) |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | URL to local Ollama API |
| `OLLAMA_TIMEOUT_MS` | `2000` | Health check probe timeout in milliseconds |

---

## 6. Architecture Roadmap

| Milestone | Focus | Status |
| :---: | :--- | :---: |
| **0** | Repository Inspection & Architecture Plan | Complete |
| **1** | Professional Foundation & Local Scaffolding | **Complete (Current)** |
| **2** | Safe Codebase Indexing & Read-Only Tools | Planned |
| **3** | Permission-Controlled Tool System & Diff Engine | Planned |
| **4** | Open-Weight Model Orchestration & Prompts | Planned |
| **5** | Desktop UI & User Approval Workflows | Planned |
| **6** | End-to-End Testing & Packaging | Planned |

---

## 7. License

MIT License. See [LICENSE](LICENSE) for details.
