import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { validateHostHeader, applySecurityHeaders } from '../src/server/security.js';

describe('Security Layer', () => {
  const allowedHosts = Object.freeze(['localhost', '127.0.0.1', 'localhost:4173', '127.0.0.1:4173']);

  test('validateHostHeader permits exact valid loopback hosts', () => {
    const validRequests: Partial<IncomingMessage>[] = [
      { headers: { host: '127.0.0.1:4173' } },
      { headers: { host: 'localhost:4173' } },
      { headers: { host: '127.0.0.1' } },
      { headers: { host: 'localhost' } }
    ];

    for (const req of validRequests) {
      assert.equal(validateHostHeader(req as IncomingMessage, allowedHosts), true);
    }
  });

  test('validateHostHeader rejects untrusted external and spoofed hosts', () => {
    const untrustedRequests: Partial<IncomingMessage>[] = [
      { headers: { host: 'evil.com' } },
      { headers: { host: '192.168.1.10:4173' } },
      { headers: { host: 'localhost:8080' } },
      { headers: { host: 'attacker.local' } },
      { headers: {} }
    ];

    for (const req of untrustedRequests) {
      assert.equal(validateHostHeader(req as IncomingMessage, allowedHosts), false);
    }
  });

  test('applySecurityHeaders sets defensive headers on response', () => {
    const headersMap = new Map<string, string>();
    const mockRes = {
      setHeader(name: string, value: string) {
        headersMap.set(name.toLowerCase(), value);
      }
    };

    applySecurityHeaders(mockRes as any);

    assert.equal(headersMap.get('x-content-type-options'), 'nosniff');
    assert.equal(headersMap.get('x-frame-options'), 'DENY');
    assert.equal(headersMap.get('referrer-policy'), 'no-referrer');
    assert.ok(headersMap.get('content-security-policy')?.includes("default-src 'self'"));
    assert.ok(headersMap.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  });
});
