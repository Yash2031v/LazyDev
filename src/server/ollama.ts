/**
 * LazyDev Ollama Client
 * Safely inspects local Ollama endpoint without crashing or blocking when unavailable.
 */

export interface OllamaModelInfo {
  readonly name: string;
  readonly modifiedAt?: string;
  readonly size?: number;
}

export interface OllamaStatus {
  readonly connected: boolean;
  readonly endpoint: string;
  readonly models: readonly string[];
  readonly details: string;
  readonly latencyMs: number | null;
}

export interface OllamaClientOptions {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly fetchFn?: typeof fetch;
}

export class OllamaClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OllamaClientOptions) {
    // Strip trailing slash
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Check connection and retrieve available models from Ollama /api/tags
   */
  async checkStatus(): Promise<OllamaStatus> {
    const tagsUrl = `${this.endpoint}/api/tags`;
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(tagsUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: controller.signal
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        return {
          connected: false,
          endpoint: this.endpoint,
          models: [],
          details: `Ollama returned HTTP error ${response.status}: ${response.statusText}`,
          latencyMs
        };
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return {
          connected: false,
          endpoint: this.endpoint,
          models: [],
          details: 'Malformed response received from Ollama endpoint (invalid JSON).',
          latencyMs
        };
      }

      if (typeof data !== 'object' || data === null || !('models' in data) || !Array.isArray(data.models)) {
        return {
          connected: false,
          endpoint: this.endpoint,
          models: [],
          details: 'Unexpected response schema: missing "models" array.',
          latencyMs
        };
      }

      const models: string[] = [];
      for (const item of data.models) {
        if (typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string') {
          models.push(item.name);
        }
      }

      return {
        connected: true,
        endpoint: this.endpoint,
        models: Object.freeze(models),
        details: `Connected (${models.length} model${models.length === 1 ? '' : 's'} available)`,
        latencyMs
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - startTime;

      if (err instanceof Error && err.name === 'AbortError') {
        return {
          connected: false,
          endpoint: this.endpoint,
          models: [],
          details: `Connection timed out after ${this.timeoutMs}ms.`,
          latencyMs
        };
      }

      const errorMessage = err instanceof Error ? err.message : String(err);

      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
        return {
          connected: false,
          endpoint: this.endpoint,
          models: [],
          details: 'Ollama is not running or unreachable at the configured endpoint.',
          latencyMs: null
        };
      }

      return {
        connected: false,
        endpoint: this.endpoint,
        models: [],
        details: `Connection check failed: ${errorMessage}`,
        latencyMs: null
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
