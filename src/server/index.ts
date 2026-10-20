/**
 * LazyDev Server Bootstrap
 * Binds strictly to 127.0.0.1 in local development, or platform interface in verified public demo mode.
 * Manages graceful lifecycle shutdown.
 */

import * as http from 'node:http';
import { loadConfig, type AppConfig } from './config.js';
import { OllamaClient } from './ollama.js';
import { createRequestHandler } from './app.js';

import { ProjectService } from './project/project-service.js';
import { EditorService } from './editor/editor-service.js';
import { AiService } from './ai/ai-service.js';
import { DemoProjectManager } from './demo/demo-project.js';
import { InMemoryRateLimiter } from './demo/rate-limiter.js';

export interface ServerInstance {
  readonly server: http.Server;
  readonly config: AppConfig;
  readonly projectService: ProjectService;
  readonly editorService: EditorService;
  readonly aiService: AiService;
  readonly demoManager: DemoProjectManager;
  readonly rateLimiter: InMemoryRateLimiter;
  readonly close: () => Promise<void>;
}

export function startServer(
  customConfig?: AppConfig,
  clientDirOverride?: string,
  customProjectService?: ProjectService,
  customEditorService?: EditorService,
  customAiService?: AiService,
  customDemoManager?: DemoProjectManager,
  customRateLimiter?: InMemoryRateLimiter
): Promise<ServerInstance> {
  const config = customConfig ?? loadConfig();
  const ollamaClient = new OllamaClient({
    endpoint: config.ollamaHost,
    timeoutMs: config.ollamaTimeoutMs
  });
  const projectService = customProjectService ?? new ProjectService();
  const editorService = customEditorService ?? new EditorService();
  const aiService = customAiService ?? new AiService(ollamaClient, projectService, editorService, undefined, config.aiMode);
  const demoManager = customDemoManager ?? new DemoProjectManager();
  const rateLimiter = customRateLimiter ?? new InMemoryRateLimiter({ windowMs: 60_000, maxRequests: 30 });

  const requestHandler = createRequestHandler(
    config,
    ollamaClient,
    clientDirOverride,
    projectService,
    editorService,
    aiService,
    demoManager,
    rateLimiter
  );
  const server = http.createServer(requestHandler);

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      reject(err);
    });

    server.listen(config.port, config.host, () => {
      const close = (): Promise<void> => {
        demoManager.destroy();
        rateLimiter.destroy();
        return new Promise((resClose, rejClose) => {
          server.close((err) => {
            if (err) rejClose(err);
            else resClose();
          });
        });
      };

      resolve({ server, config, projectService, editorService, aiService, demoManager, rateLimiter, close });
    });
  });
}

// Standalone execution entry point
const isMainModule = process.argv[1]?.replace(/\\/g, '/').endsWith('src/server/index.ts') ||
  process.argv[1]?.replace(/\\/g, '/').endsWith('dist/server/index.js');

if (isMainModule) {
  try {
    const config = loadConfig();
    startServer(config)
      .then(({ close }) => {
        console.log(`[LazyDev] Server listening at http://${config.host}:${config.port}`);
        if (config.isPublicDemo) {
          console.log(`[LazyDev] Mode: PUBLIC DEMO (LAZYDEV_PUBLIC_DEMO=true) — Bound to ${config.host}:${config.port}`);
          console.log('[LazyDev] Security check: Server filesystem access blocked. In-memory disposable sandbox active.');
        } else {
          console.log(`[LazyDev] Security check: Bound exclusively to loopback (${config.host})`);
          if (config.aiMode === 'demo') {
            console.log('[LazyDev] Mode: LOCAL DEMO (LAZYDEV_AI_MODE=demo) — Ollama will not be contacted.');
          } else {
            console.log(`[LazyDev] Mode: OLLAMA (${config.ollamaHost})`);
          }
        }

        const handleShutdown = (signal: string) => {
          console.log(`\n[LazyDev] Received ${signal}. Shutting down gracefully...`);
          close()
            .then(() => {
              console.log('[LazyDev] Server closed cleanly.');
              process.exit(0);
            })
            .catch((err) => {
              console.error('[LazyDev] Error during server shutdown:', err);
              process.exit(1);
            });
        };

        process.on('SIGINT', () => handleShutdown('SIGINT'));
        process.on('SIGTERM', () => handleShutdown('SIGTERM'));
      })
      .catch((err) => {
        console.error('[LazyDev] Fatal startup error:', err.message);
        process.exit(1);
      });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
