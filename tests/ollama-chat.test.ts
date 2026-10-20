import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  OllamaClient,
  OllamaChatError,
  RequestCancellationManager,
  type OllamaChatRequest
} from '../src/server/ollama.js';

describe('Ollama Chat Client - Non-Streaming', () => {
  test('successfully executes non-streaming chat completion', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));

      return new Response(
        JSON.stringify({
          model: 'qwen2.5-coder:7b',
          created_at: '2026-10-20T12:00:00Z',
          message: {
            role: 'assistant',
            content: 'Hello! I am ready to help.'
          },
          done: true,
          total_duration: 5000000000,
          prompt_eval_count: 32,
          eval_count: 64
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 5000,
      fetchFn: mockFetch as any
    });

    const request: OllamaChatRequest = {
      model: 'qwen2.5-coder:7b',
      messages: [
        { role: 'system', content: 'You are a safe assistant.' },
        { role: 'user', content: 'Say hello.' }
      ],
      options: {
        temperature: 0.2
      }
    };

    const res = await client.chat(request);

    assert.equal(capturedUrl, 'http://127.0.0.1:11434/api/chat');
    assert.equal(capturedBody.model, 'qwen2.5-coder:7b');
    assert.equal(capturedBody.stream, false);
    assert.equal(capturedBody.messages.length, 2);
    assert.equal(capturedBody.options.temperature, 0.2);

    assert.equal(res.model, 'qwen2.5-coder:7b');
    assert.equal(res.message.role, 'assistant');
    assert.equal(res.message.content, 'Hello! I am ready to help.');
    assert.equal(res.done, true);
    assert.equal(res.totalDurationMs, 5000);
    assert.equal(res.promptEvalCount, 32);
    assert.equal(res.evalCount, 64);
  });

  test('rejects invalid, unsafe, or malformed model names', async () => {
    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000
    });

    const invalidModels = [
      '',
      '   ',
      '../traversal:7b',
      'model/../../etc/passwd',
      'model;rm -rf /',
      'model$(whoami)',
      '/leading-slash',
      'trailing-slash/',
      'org//model',
      'a'.repeat(129)
    ];

    for (const model of invalidModels) {
      await assert.rejects(
        async () => {
          await client.chat({
            model,
            messages: [{ role: 'user', content: 'Hi' }]
          });
        },
        (err: any) => {
          assert.ok(err instanceof OllamaChatError);
          assert.equal(err.code, 'INVALID_REQUEST');
          return true;
        },
        `Expected rejection for model: "${model}"`
      );
    }
  });

  test('accepts valid model names with tags and namespaces', async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          model: 'valid-model',
          message: { role: 'assistant', content: 'ok' },
          done: true
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    const validModels = [
      'llama3',
      'qwen2.5-coder:7b',
      'codellama:13b-instruct-q4_K_M',
      'deepseek-r1:14b',
      'library/qwen2.5-coder:latest'
    ];

    for (const model of validModels) {
      const res = await client.chat({
        model,
        messages: [{ role: 'user', content: 'Hi' }]
      });
      assert.equal(res.done, true);
    }
  });

  test('strictly enforces request payload bounds (PAYLOAD_TOO_LARGE)', async () => {
    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      maxRequestBytes: 100 // tiny bound for testing
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [
            { role: 'user', content: 'x'.repeat(101) }
          ]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
        assert.ok(err.message.includes('payload size'));
        return true;
      }
    );
  });

  test('strictly enforces response payload bounds (PAYLOAD_TOO_LARGE)', async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          model: 'qwen2.5-coder:7b',
          message: { role: 'assistant', content: 'y'.repeat(200) },
          done: true
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      maxResponseBytes: 150, // tiny bound for testing
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Generate code' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
        return true;
      }
    );
  });

  test('rejects responses with Content-Length header exceeding limit', async () => {
    const mockFetch = async () => {
      return new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '2000000'
        }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      maxResponseBytes: 512 * 1024,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
        return true;
      }
    );
  });

  test('successfully reads and parses chunked response without Content-Length under the limit', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"model":"qwen2.5-coder:7b",'));
        controller.enqueue(encoder.encode('"message":{"role":"assistant","content":"chunked-success"},'));
        controller.enqueue(encoder.encode('"done":true}'));
        controller.close();
      }
    });

    const mockFetch = async () => {
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    const res = await client.chat({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'Hi' }]
    });

    assert.equal(res.message.content, 'chunked-success');
    assert.equal(res.done, true);
  });

  test('aborts stream reader immediately when chunked response without Content-Length exceeds limit', async () => {
    let cancelCalled = false;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
        controller.enqueue(new Uint8Array(100)); // total 200 exceeds limit 150
      },
      cancel() {
        cancelCalled = true;
      }
    });

    const mockFetch = async () => {
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      maxResponseBytes: 150,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
        return true;
      }
    );

    assert.equal(cancelCalled, true);
  });

  test('cancels stream when body exceeds limit despite a misleading small Content-Length', async () => {
    let cancelCalled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
        controller.enqueue(new Uint8Array(100)); // total 200 exceeds limit 150
      },
      cancel() {
        cancelCalled = true;
      }
    });

    const mockFetch = async () => {
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '50' // Misleading header pretending it is small
        }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      maxResponseBytes: 150,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
        return true;
      }
    );

    assert.equal(cancelCalled, true);
  });

  test('handles stream errors during body read safely (MALFORMED_RESPONSE)', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
        controller.error(new Error('Underlying TCP connection reset'));
      }
    });

    const mockFetch = async () => {
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'MALFORMED_RESPONSE');
        assert.ok(err.message.includes('Failed to read response body'));
        return true;
      }
    );
  });

  test('handles caller cancellation while reading stream body (ABORTED)', async () => {
    const controller = new AbortController();

    const stream = new ReadableStream({
      start(streamController) {
        streamController.enqueue(new Uint8Array(20));
        setTimeout(() => {
          controller.abort();
        }, 20);
      }
    });

    const mockFetch = async (_url: any, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        // signal listener
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 5000,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat(
          {
            model: 'qwen2.5-coder:7b',
            messages: [{ role: 'user', content: 'Hi' }]
          },
          controller.signal
        );
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'ABORTED');
        return true;
      }
    );
  });

  test('strictly rejects HTTP redirect responses (redirect: error)', async () => {
    let capturedRedirect = '';
    const mockFetch = async (_url: any, init?: RequestInit) => {
      capturedRedirect = init?.redirect ?? '';
      return new Response('', {
        status: 307,
        statusText: 'Temporary Redirect',
        headers: { Location: 'http://169.254.169.254/latest/meta-data' }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'HTTP_ERROR');
        assert.equal(err.status, 307);
        assert.ok(err.message.includes('redirect'));
        return true;
      }
    );

    assert.equal(capturedRedirect, 'error');
  });

  test('handles fetch throwing redirect error safely (HTTP_ERROR)', async () => {
    const mockFetch = async () => {
      const err = new TypeError('Failed to fetch: redirect not allowed');
      throw err;
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'HTTP_ERROR');
        assert.ok(err.message.includes('redirect is forbidden'));
        return true;
      }
    );
  });

  test('handles finite timeouts safely (TIMEOUT)', async () => {
    const mockFetch = async (_url: any, init?: RequestInit) => {
      // Simulate hanging fetch until signal aborts
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 50,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'TIMEOUT');
        assert.ok(err.message.includes('timed out after 50ms'));
        return true;
      }
    );
  });

  test('handles client-initiated abort signal (ABORTED)', async () => {
    const mockFetch = async (_url: any, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 10000,
      fetchFn: mockFetch as any
    });

    const controller = new AbortController();
    const chatPromise = client.chat(
      {
        model: 'qwen2.5-coder:7b',
        messages: [{ role: 'user', content: 'Hi' }]
      },
      controller.signal
    );

    // Abort after 20ms
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(
      chatPromise,
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'ABORTED');
        return true;
      }
    );
  });

  test('rejects immediately when passed an already-aborted signal (ABORTED)', async () => {
    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 5000
    });

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        await client.chat(
          {
            model: 'qwen2.5-coder:7b',
            messages: [{ role: 'user', content: 'Hi' }]
          },
          controller.signal
        );
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'ABORTED');
        return true;
      }
    );
  });

  test('handles offline Ollama endpoint safely (OFFLINE)', async () => {
    const mockFetch = async () => {
      throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'OFFLINE');
        assert.ok(err.message.includes('not running or unreachable'));
        return true;
      }
    );
  });

  test('handles HTTP error statuses safely (HTTP_ERROR)', async () => {
    const mockFetch = async () => {
      return new Response('model not found', {
        status: 404,
        statusText: 'Not Found'
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'non-existent-model',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'HTTP_ERROR');
        assert.equal(err.status, 404);
        assert.ok(err.message.includes('HTTP error 404'));
        return true;
      }
    );
  });

  test('handles malformed non-JSON responses safely (MALFORMED_RESPONSE)', async () => {
    const mockFetch = async () => {
      return new Response('<html>502 Bad Gateway</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'MALFORMED_RESPONSE');
        assert.ok(err.message.includes('invalid JSON'));
        return true;
      }
    );
  });

  test('handles invalid schema missing message or content (MALFORMED_RESPONSE)', async () => {
    const mockFetch = async () => {
      return new Response(JSON.stringify({ done: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    await assert.rejects(
      async () => {
        await client.chat({
          model: 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'MALFORMED_RESPONSE');
        assert.ok(err.message.includes('missing "message" object'));
        return true;
      }
    );
  });

  test('never includes prompt, secret, or code contents in error messages', async () => {
    const sensitiveSecret = 'SUPER_SECRET_TOKEN_DO_NOT_LEAK_12345';
    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      maxRequestBytes: 10
    });

    try {
      await client.chat({
        model: 'qwen2.5-coder:7b',
        messages: [{ role: 'user', content: sensitiveSecret }]
      });
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.ok(err instanceof OllamaChatError);
      assert.ok(!err.message.includes(sensitiveSecret));
      assert.ok(!err.stack?.includes(sensitiveSecret));
    }
  });
});

describe('Cancellation Isolation (RequestCancellationManager)', () => {
  test('cancels only the target request while leaving concurrent requests unaffected', async () => {
    const manager = new RequestCancellationManager();

    const signal1 = manager.createSignal('req-1');
    const signal2 = manager.createSignal('req-2');
    const signal3 = manager.createSignal('req-3');

    assert.equal(manager.activeCount, 3);
    assert.equal(manager.isActive('req-1'), true);
    assert.equal(manager.isActive('req-2'), true);
    assert.equal(manager.isActive('req-3'), true);

    // Cancel req-2 only
    const cancelled = manager.cancel('req-2');
    assert.equal(cancelled, true);

    // Verify isolation
    assert.equal(signal1.aborted, false);
    assert.equal(signal2.aborted, true);
    assert.equal(signal3.aborted, false);

    assert.equal(manager.isActive('req-2'), false);
    assert.equal(manager.isActive('req-1'), true);
    assert.equal(manager.isActive('req-3'), true);
    assert.equal(manager.activeCount, 2);

    // Cleaning up finished requests
    manager.cleanup('req-1');
    manager.cleanup('req-3');
    assert.equal(manager.activeCount, 0);
  });

  test('safely handles cancellation of unknown or already-finished request IDs', () => {
    const manager = new RequestCancellationManager();

    const cancelled = manager.cancel('non-existent-id');
    assert.equal(cancelled, false);
    assert.equal(manager.activeCount, 0);
  });

  test('rejects duplicate active request IDs', () => {
    const manager = new RequestCancellationManager();
    manager.createSignal('req-dup');

    assert.throws(
      () => manager.createSignal('req-dup'),
      /already active/
    );

    manager.cleanup('req-dup');
    // Allowed after cleanup
    const signal = manager.createSignal('req-dup');
    assert.ok(signal);
    manager.cleanup('req-dup');
  });

  test('runTracked automatically manages lifecycle and cleanups on success and failure', async () => {
    const manager = new RequestCancellationManager();

    // Successful run
    const result = await manager.runTracked('task-success', async (signal) => {
      assert.equal(manager.isActive('task-success'), true);
      assert.equal(signal.aborted, false);
      return 42;
    });

    assert.equal(result, 42);
    assert.equal(manager.isActive('task-success'), false);
    assert.equal(manager.activeCount, 0);

    // Failed run
    await assert.rejects(
      async () => {
        await manager.runTracked('task-fail', async () => {
          throw new Error('boom');
        });
      },
      /boom/
    );

    assert.equal(manager.isActive('task-fail'), false);
    assert.equal(manager.activeCount, 0);
  });

  test('concurrent Ollama client calls with independent cancellation', async () => {
    const manager = new RequestCancellationManager();

    const mockFetch = async (_url: any, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve(
            new Response(
              JSON.stringify({
                model: 'qwen2.5-coder:7b',
                message: { role: 'assistant', content: 'Done!' },
                done: true
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          );
        }, 100);

        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    // Start two concurrent calls
    const p1 = manager.runTracked('call-1', (signal) =>
      client.chat({ model: 'qwen2.5-coder:7b', messages: [{ role: 'user', content: '1' }] }, signal)
    );

    const p2 = manager.runTracked('call-2', (signal) =>
      client.chat({ model: 'qwen2.5-coder:7b', messages: [{ role: 'user', content: '2' }] }, signal)
    );

    // Abort call-1 immediately
    manager.cancel('call-1');

    // p1 must fail with ABORTED
    await assert.rejects(
      p1,
      (err: any) => {
        assert.ok(err instanceof OllamaChatError);
        assert.equal(err.code, 'ABORTED');
        return true;
      }
    );

    // p2 must succeed
    const res2 = await p2;
    assert.equal(res2.message.content, 'Done!');
    assert.equal(manager.activeCount, 0);
  });
});
