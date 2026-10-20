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

export type OllamaMessageRole = 'system' | 'user' | 'assistant';

export interface OllamaChatMessage {
  readonly role: OllamaMessageRole;
  readonly content: string;
}

export interface OllamaChatOptions {
  readonly temperature?: number;
  readonly topP?: number;
  readonly numPredict?: number;
}

export interface OllamaChatRequest {
  readonly model: string;
  readonly messages: readonly OllamaChatMessage[];
  readonly options?: OllamaChatOptions;
}

export interface OllamaChatResponse {
  readonly model: string;
  readonly message: OllamaChatMessage;
  readonly done: boolean;
  readonly totalDurationMs?: number;
  readonly promptEvalCount?: number;
  readonly evalCount?: number;
}

export class OllamaChatError extends Error {
  readonly code:
    | 'INVALID_REQUEST'
    | 'PAYLOAD_TOO_LARGE'
    | 'OFFLINE'
    | 'TIMEOUT'
    | 'ABORTED'
    | 'HTTP_ERROR'
    | 'MALFORMED_RESPONSE';
  readonly status?: number;

  constructor(
    message: string,
    code: OllamaChatError['code'],
    status?: number,
    cause?: unknown
  ) {
    super(`[LazyDev Ollama] ${message}`);
    this.name = 'OllamaChatError';
    this.code = code;
    this.status = status;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface OllamaClientOptions {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly fetchFn?: typeof fetch;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

const MODEL_NAME_REGEX = /^[a-zA-Z0-9_.:\/-]+$/;

export class OllamaClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;

  constructor(options: OllamaClientOptions) {
    // Strip trailing slash
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.maxRequestBytes = options.maxRequestBytes ?? 128 * 1024; // 128 KB default limit
    this.maxResponseBytes = options.maxResponseBytes ?? 512 * 1024; // 512 KB default limit
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

  /**
   * Execute non-streaming chat completion against local Ollama endpoint.
   * Enforces strict model validation, payload size bounding, timeouts, and safe error handling.
   * Prompts, code, and model outputs are never logged.
   */
  async chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResponse> {
    if (
      typeof request?.model !== 'string' ||
      !request.model.trim() ||
      request.model.length > 128 ||
      !MODEL_NAME_REGEX.test(request.model) ||
      request.model.includes('..') ||
      request.model.includes('//') ||
      request.model.startsWith('/') ||
      request.model.endsWith('/')
    ) {
      throw new OllamaChatError(
        'Invalid model name format. Must be 1-128 alphanumeric characters with optional [._:-/] and no path traversal.',
        'INVALID_REQUEST'
      );
    }

    const trimmedModel = request.model.trim();

    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new OllamaChatError('Chat request must include a non-empty array of messages.', 'INVALID_REQUEST');
    }

    let totalRequestBytes = 0;
    for (let i = 0; i < request.messages.length; i++) {
      const msg = request.messages[i];
      if (typeof msg !== 'object' || msg === null) {
        throw new OllamaChatError(`Message at index ${i} must be an object.`, 'INVALID_REQUEST');
      }
      if (msg.role !== 'system' && msg.role !== 'user' && msg.role !== 'assistant') {
        throw new OllamaChatError(`Message at index ${i} has invalid role: "${String((msg as any).role)}".`, 'INVALID_REQUEST');
      }
      if (typeof msg.content !== 'string') {
        throw new OllamaChatError(`Message at index ${i} content must be a string.`, 'INVALID_REQUEST');
      }
      totalRequestBytes += Buffer.byteLength(msg.content, 'utf8');
    }

    if (totalRequestBytes > this.maxRequestBytes) {
      throw new OllamaChatError(
        `Chat request payload size (${totalRequestBytes} bytes) exceeds maximum limit (${this.maxRequestBytes} bytes).`,
        'PAYLOAD_TOO_LARGE'
      );
    }

    if (request.options !== undefined) {
      if (typeof request.options !== 'object' || request.options === null) {
        throw new OllamaChatError('Chat options must be an object if provided.', 'INVALID_REQUEST');
      }
      if (
        request.options.temperature !== undefined &&
        (typeof request.options.temperature !== 'number' || isNaN(request.options.temperature))
      ) {
        throw new OllamaChatError('Chat options "temperature" must be a number.', 'INVALID_REQUEST');
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let unhookSignal: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        throw new OllamaChatError('Chat request was aborted before execution.', 'ABORTED');
      }
      const onCallerAbort = () => {
        controller.abort();
      };
      signal.addEventListener('abort', onCallerAbort, { once: true });
      unhookSignal = () => signal.removeEventListener('abort', onCallerAbort);
    }

    const payload = {
      model: trimmedModel,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      ...(request.options ? { options: request.options } : {})
    };

    try {
      const chatUrl = `${this.endpoint}/api/chat`;
      const response = await this.fetchFn(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error'
      });

      if (response.status >= 300 && response.status < 400) {
        throw new OllamaChatError(
          `HTTP redirect (${response.status}) is forbidden for Ollama chat requests.`,
          'HTTP_ERROR',
          response.status
        );
      }

      if (!response.ok) {
        throw new OllamaChatError(
          `Ollama returned HTTP error ${response.status}: ${response.statusText}`,
          'HTTP_ERROR',
          response.status
        );
      }

      // Check content-length header if provided
      const contentLengthHeader = response.headers?.get('content-length');
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > this.maxResponseBytes) {
          throw new OllamaChatError(
            `Response payload size (${contentLength} bytes) exceeds maximum allowed limit (${this.maxResponseBytes} bytes).`,
            'PAYLOAD_TOO_LARGE'
          );
        }
      }

      let text = '';
      if (!response.body) {
        try {
          text = await response.text();
        } catch (err: unknown) {
          if (controller.signal.aborted) {
            throw err;
          }
          throw new OllamaChatError('Failed to read response body from Ollama.', 'MALFORMED_RESPONSE', undefined, err);
        }
        if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
          throw new OllamaChatError(
            `Response payload size exceeds maximum allowed limit (${this.maxResponseBytes} bytes).`,
            'PAYLOAD_TOO_LARGE'
          );
        }
      } else {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        const readChunk = async () => {
          if (controller.signal.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          }
          let onAbort: (() => void) | undefined;
          const abortPromise = new Promise<never>((_, reject) => {
            onAbort = () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            };
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });

          try {
            return await Promise.race([reader.read(), abortPromise]);
          } finally {
            if (onAbort) {
              controller.signal.removeEventListener('abort', onAbort);
            }
          }
        };

        try {
          while (true) {
            const { done, value } = await readChunk();
            if (done) {
              break;
            }
            if (value) {
              totalBytes += value.byteLength;
              if (totalBytes > this.maxResponseBytes) {
                try {
                  await reader.cancel('PAYLOAD_TOO_LARGE');
                } catch {
                  // Ignore cancel failure on aborted stream
                }
                throw new OllamaChatError(
                  `Response payload size exceeds maximum allowed limit (${this.maxResponseBytes} bytes).`,
                  'PAYLOAD_TOO_LARGE'
                );
              }
              chunks.push(value);
            }
          }
        } catch (err: unknown) {
          if (err instanceof OllamaChatError) {
            throw err;
          }
          if (controller.signal.aborted) {
            throw err;
          }
          throw new OllamaChatError('Failed to read response body from Ollama.', 'MALFORMED_RESPONSE', undefined, err);
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Ignore lock release error if stream was already closed or canceled
          }
        }

        if (chunks.length > 0) {
          const combined = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
          }
          text = new TextDecoder('utf-8').decode(combined);
        }
      }

      if (controller.signal.aborted) {
        if (signal?.aborted) {
          throw new OllamaChatError('Chat request was aborted.', 'ABORTED');
        }
        throw new OllamaChatError(`Chat request timed out after ${this.timeoutMs}ms.`, 'TIMEOUT');
      }

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (err: unknown) {
        throw new OllamaChatError('Malformed response received from Ollama endpoint (invalid JSON).', 'MALFORMED_RESPONSE', undefined, err);
      }

      if (typeof data !== 'object' || data === null) {
        throw new OllamaChatError('Invalid response from Ollama: expected JSON object.', 'MALFORMED_RESPONSE');
      }

      const resObj = data as Record<string, unknown>;
      if (typeof resObj.message !== 'object' || resObj.message === null) {
        throw new OllamaChatError('Invalid response schema from Ollama: missing "message" object.', 'MALFORMED_RESPONSE');
      }

      const msgObj = resObj.message as Record<string, unknown>;
      if (typeof msgObj.content !== 'string') {
        throw new OllamaChatError('Invalid response schema from Ollama: message "content" is not a string.', 'MALFORMED_RESPONSE');
      }

      const role: OllamaMessageRole =
        msgObj.role === 'assistant' || msgObj.role === 'user' || msgObj.role === 'system'
          ? msgObj.role
          : 'assistant';

      const totalDurationMs =
        typeof resObj.total_duration === 'number'
          ? Math.round(resObj.total_duration / 1_000_000)
          : undefined;

      return {
        model: typeof resObj.model === 'string' ? resObj.model : trimmedModel,
        message: {
          role,
          content: msgObj.content
        },
        done: resObj.done === true,
        totalDurationMs,
        promptEvalCount: typeof resObj.prompt_eval_count === 'number' ? resObj.prompt_eval_count : undefined,
        evalCount: typeof resObj.eval_count === 'number' ? resObj.eval_count : undefined
      };
    } catch (err: unknown) {
      if (err instanceof OllamaChatError) {
        throw err;
      }

      if (timedOut) {
        throw new OllamaChatError(`Chat request timed out after ${this.timeoutMs}ms.`, 'TIMEOUT');
      }

      if (signal?.aborted) {
        throw new OllamaChatError('Chat request was aborted.', 'ABORTED');
      }

      if (err instanceof Error && err.name === 'AbortError') {
        if (signal?.aborted) {
          throw new OllamaChatError('Chat request was aborted.', 'ABORTED');
        }
        throw new OllamaChatError(`Chat request timed out after ${this.timeoutMs}ms.`, 'TIMEOUT');
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.toLowerCase().includes('redirect')) {
        throw new OllamaChatError(
          'HTTP redirect is forbidden for Ollama chat requests.',
          'HTTP_ERROR',
          undefined,
          err
        );
      }

      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
        throw new OllamaChatError(
          'Ollama is not running or unreachable at the configured endpoint.',
          'OFFLINE',
          undefined,
          err
        );
      }

      throw new OllamaChatError(
        `Chat request failed: ${errorMessage}`,
        'MALFORMED_RESPONSE',
        undefined,
        err
      );
    } finally {
      clearTimeout(timeoutId);
      if (unhookSignal) {
        unhookSignal();
      }
    }
  }
}

/**
 * Isolated request cancellation manager.
 * Associates each task/request with its own dedicated AbortController.
 * Ensures cancellation of one task does not affect any other concurrent task.
 */
export class RequestCancellationManager {
  private readonly controllers = new Map<string, AbortController>();

  /**
   * Register a new request ID and return its AbortSignal.
   * Throws if an active request with the same ID already exists.
   */
  createSignal(requestId: string): AbortSignal {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('requestId must be a non-empty string.');
    }
    if (this.controllers.has(requestId)) {
      throw new Error(`Request with ID "${requestId}" is already active.`);
    }
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    return controller.signal;
  }

  /**
   * Cancel an active request by ID.
   * Returns true if the request was active and successfully aborted; false if unknown or already completed.
   */
  cancel(requestId: string): boolean {
    const controller = this.controllers.get(requestId);
    if (!controller) {
      return false;
    }
    this.controllers.delete(requestId);
    controller.abort();
    return true;
  }

  /**
   * Clean up request tracking state upon completion (success, error, or timeout).
   */
  cleanup(requestId: string): void {
    this.controllers.delete(requestId);
  }

  /**
   * Check if a request ID is currently active.
   */
  isActive(requestId: string): boolean {
    return this.controllers.has(requestId);
  }

  /**
   * Number of currently tracked active requests.
   */
  get activeCount(): number {
    return this.controllers.size;
  }

  /**
   * Helper to execute an async operation with automatic registration and cleanup.
   */
  async runTracked<T>(requestId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.createSignal(requestId);
    try {
      return await fn(signal);
    } finally {
      this.cleanup(requestId);
    }
  }
}
