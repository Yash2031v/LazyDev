/**
 * LazyDev HTTP Application
 * Core request routing, static file delivery, and API endpoints.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { OllamaClient } from './ollama.js';
import { applySecurityHeaders, sendError, sendJson, validateHostHeader } from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In dev mode (tsx src/server/index.ts) client is at ../client
// In built mode (node dist/server/index.js) client is at ../../src/client or copy
const DEV_CLIENT_DIR = path.resolve(__dirname, '../client');
const PROD_CLIENT_DIR = path.resolve(__dirname, '../../src/client');

async function resolveClientDir(): Promise<string> {
  try {
    await fs.stat(DEV_CLIENT_DIR);
    return DEV_CLIENT_DIR;
  } catch {
    return PROD_CLIENT_DIR;
  }
}

export function createRequestHandler(config: AppConfig, ollamaClient: OllamaClient, clientDirOverride?: string) {
  const startTime = Date.now();

  return async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // 1. Validate Host Header
      if (!validateHostHeader(req, config.allowedHosts)) {
        sendError(res, 400, 'Invalid or untrusted Host header.');
        return;
      }

      const method = req.method ?? 'GET';
      const rawUrl = req.url ?? '/';
      const parsedUrl = new URL(rawUrl, `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = parsedUrl.pathname;

      // 2. API Routes
      if (pathname === '/api/health') {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET');
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        sendJson(res, 200, {
          status: 'ok',
          timestamp: new Date().toISOString(),
          uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
          version: '0.1.0'
        });
        return;
      }

      if (pathname === '/api/status') {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET');
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const ollamaStatus = await ollamaClient.checkStatus();

        sendJson(res, 200, {
          app: {
            name: 'LazyDev',
            version: '0.1.0',
            milestone: 'Milestone 1: Professional Foundation',
            environment: 'local'
          },
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch
          },
          ollama: ollamaStatus
        });
        return;
      }

      // 3. Static Assets
      if (method === 'GET' || method === 'HEAD') {
        const clientDir = clientDirOverride ?? (await resolveClientDir());

        let targetFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        // Prevent path traversal
        const resolvedPath = path.resolve(clientDir, targetFile);

        if (!resolvedPath.startsWith(clientDir)) {
          sendError(res, 403, 'Access Forbidden');
          return;
        }

        try {
          const stats = await fs.stat(resolvedPath);
          if (!stats.isFile()) {
            sendError(res, 404, 'Resource not found');
            return;
          }

          const ext = path.extname(resolvedPath).toLowerCase();
          const contentTypeMap: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.svg': 'image/svg+xml'
          };

          const contentType = contentTypeMap[ext] || 'application/octet-stream';

          applySecurityHeaders(res);
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Length', stats.size);

          if (method === 'HEAD') {
            res.writeHead(200);
            res.end();
            return;
          }

          const fileContent = await fs.readFile(resolvedPath);
          res.writeHead(200);
          res.end(fileContent);
          return;
        } catch {
          sendError(res, 404, 'Resource not found');
          return;
        }
      }

      sendError(res, 405, 'Method Not Allowed');
    } catch (err: unknown) {
      // Safe fallback: never leak internal stack traces or paths
      sendError(res, 500, 'Internal Server Error');
    }
  };
}
