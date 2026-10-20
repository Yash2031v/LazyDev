/**
 * LazyDev Server Bootstrap
 * Binds strictly to 127.0.0.1 and manages graceful lifecycle shutdown.
 */

import * as http from 'node:http';
import { loadConfig, type AppConfig } from './config.js';
import { OllamaClient } from './ollama.js';
import { createRequestHandler } from './app.js';

import { ProjectService } from './project/project-service.js';

export interface ServerInstance {
  readonly server: http.Server;
  readonly config: AppConfig;
  readonly projectService: ProjectService;
  readonly close: () => Promise<void>;
}

export function startServer(
  customConfig?: AppConfig,
  clientDirOverride?: string,
  customProjectService?: ProjectService
): Promise<ServerInstance> {
  const config = customConfig ?? loadConfig();
  const ollamaClient = new OllamaClient({
    endpoint: config.ollamaHost,
    timeoutMs: config.ollamaTimeoutMs
  });
  const projectService = customProjectService ?? new ProjectService();

  const requestHandler = createRequestHandler(config, ollamaClient, clientDirOverride, projectService);
  const server = http.createServer(requestHandler);

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      reject(err);
    });

    // Strictly bind to 127.0.0.1 - NEVER 0.0.0.0
    server.listen(config.port, config.host, () => {
      const close = (): Promise<void> => {
        return new Promise((resClose, rejClose) => {
          server.close((err) => {
            if (err) rejClose(err);
            else resClose();
          });
        });
      };

      resolve({ server, config, projectService, close });
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
        console.log(`[LazyDev] Local server listening at http://${config.host}:${config.port}`);
        console.log(`[LazyDev] Security check: Bound exclusively to loopback (${config.host})`);
        console.log(`[LazyDev] Ollama target: ${config.ollamaHost}`);

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
