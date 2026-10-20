/**
 * LazyDev Server Configuration
 * Environment-based configuration loader with strict validation and safe defaults.
 */

export interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly ollamaHost: string;
  readonly ollamaTimeoutMs: number;
  readonly allowedHosts: readonly string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`[LazyDev Configuration Error] ${message}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_TIMEOUT_MS = 2000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Validate and parse PORT (0 allowed for system-assigned ephemeral port in tests)
  let port = DEFAULT_PORT;
  if (env['PORT'] !== undefined && env['PORT'].trim() !== '') {
    const parsed = Number(env['PORT']);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new ConfigError(`Invalid PORT: "${env['PORT']}". Must be an integer between 0 and 65535.`);
    }
    port = parsed;
  }

  // Validate HOST - LazyDev must NEVER bind to 0.0.0.0 or any public interface
  const host = (env['HOST'] || DEFAULT_HOST).trim();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new ConfigError(
      `Invalid HOST: "${host}". For security, LazyDev local server only permits binding to 127.0.0.1 or localhost.`
    );
  }

  // Validate OLLAMA_HOST
  const rawOllamaHost = (env['OLLAMA_HOST'] || DEFAULT_OLLAMA_HOST).trim();
  try {
    const url = new URL(rawOllamaHost);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Protocol must be http or https');
    }
  } catch (err) {
    throw new ConfigError(`Invalid OLLAMA_HOST: "${rawOllamaHost}". Must be a valid HTTP/HTTPS URL.`);
  }

  // Validate OLLAMA_TIMEOUT_MS
  let ollamaTimeoutMs = DEFAULT_OLLAMA_TIMEOUT_MS;
  if (env['OLLAMA_TIMEOUT_MS'] !== undefined && env['OLLAMA_TIMEOUT_MS'].trim() !== '') {
    const parsed = Number(env['OLLAMA_TIMEOUT_MS']);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 60000) {
      throw new ConfigError(
        `Invalid OLLAMA_TIMEOUT_MS: "${env['OLLAMA_TIMEOUT_MS']}". Must be an integer between 1 and 60000.`
      );
    }
    ollamaTimeoutMs = parsed;
  }

  // Allowed Host header values
  const allowedHosts = Object.freeze(
    port === 0
      ? ['localhost', '127.0.0.1', 'localhost:*', '127.0.0.1:*']
      : ['localhost', '127.0.0.1', `localhost:${port}`, `127.0.0.1:${port}`]
  );

  return Object.freeze({
    port,
    host,
    ollamaHost: rawOllamaHost,
    ollamaTimeoutMs,
    allowedHosts
  });
}
