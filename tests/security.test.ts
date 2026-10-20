import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  validateHostHeader,
  validateOriginHeader,
  matchesHostPattern,
  isTrustedOrigin,
  applySecurityHeaders
} from '../src/server/security.js';

describe('Security Layer', () => {
  const allowedHosts = Object.freeze([
    'lazydev-demo.onrender.com',
    'localhost',
    '127.0.0.1',
    'localhost:4173',
    '127.0.0.1:4173',
    '*.onrender.com'
  ]);

  test('validateHostHeader permits exact valid loopback hosts and deployed domain', () => {
    const validRequests: Partial<IncomingMessage>[] = [
      { headers: { host: '127.0.0.1:4173' } },
      { headers: { host: 'localhost:4173' } },
      { headers: { host: '127.0.0.1' } },
      { headers: { host: 'localhost' } },
      { headers: { host: 'lazydev-demo.onrender.com' } },
      { headers: { host: 'subdomain.onrender.com' } }
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
      { headers: { host: 'attacker-onrender.com' } },
      { headers: {} }
    ];

    for (const req of untrustedRequests) {
      assert.equal(validateHostHeader(req as IncomingMessage, allowedHosts), false);
    }
  });

  test('matchesHostPattern handles wildcards, ports, and origin formats', () => {
    assert.equal(matchesHostPattern('lazydev-demo.onrender.com', 'lazydev-demo.onrender.com'), true);
    assert.equal(matchesHostPattern('lazydev-demo.onrender.com', '*.onrender.com'), true);
    assert.equal(matchesHostPattern('lazydev-demo.onrender.com:443', 'lazydev-demo.onrender.com'), true);
    assert.equal(matchesHostPattern('lazydev-demo.onrender.com', 'https://lazydev-demo.onrender.com'), true);
    assert.equal(matchesHostPattern('localhost:4173', 'localhost:*'), true);
    assert.equal(matchesHostPattern('attacker-onrender.com', '*.onrender.com'), false);
    assert.equal(matchesHostPattern('evil.com', 'lazydev-demo.onrender.com'), false);
  });

  test('isTrustedOrigin verifies http/https protocols and allowed hostnames', () => {
    assert.equal(isTrustedOrigin('https://lazydev-demo.onrender.com', allowedHosts), true);
    assert.equal(isTrustedOrigin('http://localhost:4173', allowedHosts), true);
    assert.equal(isTrustedOrigin('http://127.0.0.1:4173', allowedHosts), true);
    assert.equal(isTrustedOrigin('https://another-preview.onrender.com', allowedHosts), true);
    assert.equal(isTrustedOrigin('https://evil.com', allowedHosts), false);
    assert.equal(isTrustedOrigin('javascript:alert(1)', allowedHosts), false);
    assert.equal(isTrustedOrigin('ftp://localhost:4173', allowedHosts), false);
    assert.equal(isTrustedOrigin('not a url', allowedHosts), false);
  });

  test('validateOriginHeader permits safe top-level document navigation from external links', () => {
    // Normal browser click from external link (Render dashboard, GitHub, email, etc.)
    const linkClickReq: Partial<IncomingMessage> = {
      method: 'GET',
      headers: {
        host: 'lazydev-demo.onrender.com',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document'
      }
    };
    assert.equal(validateOriginHeader(linkClickReq as IncomingMessage, allowedHosts), true);

    // HEAD request navigation
    const headReq: Partial<IncomingMessage> = {
      method: 'HEAD',
      headers: {
        host: 'lazydev-demo.onrender.com',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate'
      }
    };
    assert.equal(validateOriginHeader(headReq as IncomingMessage, allowedHosts), true);
  });

  test('validateOriginHeader blocks cross-site attacks and framing attempts', () => {
    // Cross-site iframe embedding
    const iframeReq: Partial<IncomingMessage> = {
      method: 'GET',
      headers: {
        host: 'lazydev-demo.onrender.com',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe'
      }
    };
    assert.equal(validateOriginHeader(iframeReq as IncomingMessage, allowedHosts), false);

    // Cross-site nested-document
    const nestedDocReq: Partial<IncomingMessage> = {
      method: 'GET',
      headers: {
        host: 'lazydev-demo.onrender.com',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'nested-document'
      }
    };
    assert.equal(validateOriginHeader(nestedDocReq as IncomingMessage, allowedHosts), false);

    // Cross-site form POST
    const formPostReq: Partial<IncomingMessage> = {
      method: 'POST',
      headers: {
        host: 'lazydev-demo.onrender.com',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        origin: 'https://evil.com'
      }
    };
    assert.equal(validateOriginHeader(formPostReq as IncomingMessage, allowedHosts), false);

    // Cross-site API fetch (POST)
    const apiFetchReq: Partial<IncomingMessage> = {
      method: 'POST',
      headers: {
        host: 'lazydev-demo.onrender.com',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'cors',
        origin: 'https://evil.com'
      }
    };
    assert.equal(validateOriginHeader(apiFetchReq as IncomingMessage, allowedHosts), false);

    // Cross-site API fetch (GET)
    const apiGetReq: Partial<IncomingMessage> = {
      method: 'GET',
      headers: {
        host: 'lazydev-demo.onrender.com',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'cors',
        origin: 'https://evil.com'
      }
    };
    assert.equal(validateOriginHeader(apiGetReq as IncomingMessage, allowedHosts), false);

    // Cross-site navigation with untrusted Origin header explicitly set
    const spoofedNavReq: Partial<IncomingMessage> = {
      method: 'GET',
      headers: {
        host: 'lazydev-demo.onrender.com',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        origin: 'https://attacker.com'
      }
    };
    assert.equal(validateOriginHeader(spoofedNavReq as IncomingMessage, allowedHosts), false);
  });

  test('validateOriginHeader permits legitimate same-origin and direct CLI requests', () => {
    // Direct CLI / curl request (no Origin header, no Sec-Fetch-Site)
    const curlReq: Partial<IncomingMessage> = {
      method: 'GET',
      headers: { host: 'lazydev-demo.onrender.com' }
    };
    assert.equal(validateOriginHeader(curlReq as IncomingMessage, allowedHosts), true);

    // Browser same-origin fetch from deployed domain
    const deployedFetchReq: Partial<IncomingMessage> = {
      method: 'POST',
      headers: {
        host: 'lazydev-demo.onrender.com',
        origin: 'https://lazydev-demo.onrender.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors'
      }
    };
    assert.equal(validateOriginHeader(deployedFetchReq as IncomingMessage, allowedHosts), true);

    // Browser same-origin fetch on localhost
    const localFetchReq: Partial<IncomingMessage> = {
      method: 'POST',
      headers: {
        host: 'localhost:4173',
        origin: 'http://localhost:4173',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors'
      }
    };
    assert.equal(validateOriginHeader(localFetchReq as IncomingMessage, allowedHosts), true);
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
