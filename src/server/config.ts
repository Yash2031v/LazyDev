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
  readonly aiMode: 'ollama' | 'demo';
  readonly isPublicDemo: boolean;
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

  // Check if explicit public demo deployment is active
  const isPublicDemo =
    env['LAZYDEV_PUBLIC_DEMO'] === 'true' ||
    env['LAZYDEV_DEPLOY_MODE'] === 'public-demo';

  // Validate HOST - Local development permits ONLY loopback (127.0.0.1/localhost).
  // Public demo allows 0.0.0.0 for platform container ingress.
  const defaultHost = isPublicDemo ? '0.0.0.0' : DEFAULT_HOST;
  const host = (env['HOST'] || defaultHost).trim();
  if (!isPublicDemo && host !== '127.0.0.1' && host !== 'localhost') {
    throw new ConfigError(
      `Invalid HOST: "${host}". For security, LazyDev local server only permits binding to 127.0.0.1 or localhost.`
    );
  }
  if (isPublicDemo && host !== '0.0.0.0' && host !== '127.0.0.1' && host !== 'localhost') {
    throw new ConfigError(
      `Invalid HOST: "${host}". Public demo mode permits binding to 0.0.0.0, 127.0.0.1, or localhost.`
    );
  }

  // Validate OLLAMA_HOST - Strictly local loopback only
  const rawOllamaHost = (env['OLLAMA_HOST'] || DEFAULT_OLLAMA_HOST).trim();
  let ollamaUrl: URL;
  try {
    ollamaUrl = new URL(rawOllamaHost);
    if (ollamaUrl.protocol !== 'http:' && ollamaUrl.protocol !== 'https:') {
      throw new Error('Protocol must be http or https');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Invalid OLLAMA_HOST: "${rawOllamaHost}". Must be a valid HTTP/HTTPS URL (${msg}).`);
  }

  // Reject credentials (username/password), query parameters, and hash fragments
  if (ollamaUrl.username || ollamaUrl.password) {
    throw new ConfigError(
      `Invalid OLLAMA_HOST: "${rawOllamaHost}". Credentials (username/password) are forbidden in OLLAMA_HOST.`
    );
  }

  if (ollamaUrl.search) {
    throw new ConfigError(
      `Invalid OLLAMA_HOST: "${rawOllamaHost}". Query parameters are forbidden in OLLAMA_HOST.`
    );
  }

  if (ollamaUrl.hash) {
    throw new ConfigError(
      `Invalid OLLAMA_HOST: "${rawOllamaHost}". Hash fragments are forbidden in OLLAMA_HOST.`
    );
  }

  // Exact hostname matching after URL parsing
  const rawHostname = ollamaUrl.hostname.toLowerCase();
  const unbracketedHostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  const isLoopback =
    unbracketedHostname === '127.0.0.1' ||
    unbracketedHostname === 'localhost' ||
    unbracketedHostname === '::1';

  if (!isLoopback) {
    throw new ConfigError(
      `Invalid OLLAMA_HOST: "${rawOllamaHost}". For security, LazyDev only permits connecting to local loopback endpoints (127.0.0.1, localhost, or [::1]). Remote DNS, LAN, or external hosts are forbidden.`
    );
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

  // Validate LAZYDEV_AI_MODE - Opt-in local demo mode or standard Ollama
  const defaultAiMode = isPublicDemo ? 'demo' : 'ollama';
  const rawAiMode = (env['LAZYDEV_AI_MODE'] || defaultAiMode).trim().toLowerCase();
  if (rawAiMode !== 'ollama' && rawAiMode !== 'demo') {
    throw new ConfigError(
      `Invalid LAZYDEV_AI_MODE: "${env['LAZYDEV_AI_MODE']}". Must be "ollama" or "demo".`
    );
  }
  if (isPublicDemo && rawAiMode !== 'demo') {
    throw new ConfigError(
      `Invalid LAZYDEV_AI_MODE: "${rawAiMode}". Public demo mode requires LAZYDEV_AI_MODE=demo.`
    );
  }
  const aiMode: 'ollama' | 'demo' = rawAiMode;

  // Allowed Host header values
  let allowedHostsList: string[];
  if (env['ALLOWED_HOSTS'] && env['ALLOWED_HOSTS'].trim() !== '') {
    allowedHostsList = env['ALLOWED_HOSTS'].split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  } else if (isPublicDemo) {
    allowedHostsList = [
      'lazydev-demo.onrender.com',
      'localhost',
      '127.0.0.1',
      'localhost:*',
      '127.0.0.1:*',
      '0.0.0.0:*',
      '*.onrender.com',
      'onrender.com'
    ];
    if (port !== 0) {
      allowedHostsList.push(`localhost:${port}`, `127.0.0.1:${port}`);
    }
  } else {
    allowedHostsList = port === 0
      ? ['localhost', '127.0.0.1', 'localhost:*', '127.0.0.1:*']
      : ['localhost', '127.0.0.1', `localhost:${port}`, `127.0.0.1:${port}`];
  }
  const allowedHosts = Object.freeze(allowedHostsList);

  return Object.freeze({
    port,
    host,
    ollamaHost: rawOllamaHost,
    ollamaTimeoutMs,
    allowedHosts,
    aiMode,
    isPublicDemo
  });
}
