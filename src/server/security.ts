/**
 * LazyDev Security Middleware & Headers
 * Validates Host headers against loopback and applies security headers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SecurityOptions {
  readonly allowedHosts: readonly string[];
}

export function applySecurityHeaders(res: ServerResponse): void {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent framing (clickjacking defense)
  res.setHeader('X-Frame-Options', 'DENY');

  // Do not leak referrers
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Strict CSP allowing only self resources, no remote CDNs or external fonts/scripts
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';"
  );

  // Disable sensitive hardware/browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
}

export function validateHostHeader(req: IncomingMessage, allowedHosts: readonly string[]): boolean {
  const hostHeader = req.headers['host'];
  if (!hostHeader) {
    return false;
  }

  // Normalize (strip any surrounding whitespace, lowercase)
  const normalizedHost = hostHeader.trim().toLowerCase();

  return allowedHosts.some(allowed => {
    const lowerAllowed = allowed.toLowerCase();
    if (lowerAllowed.endsWith(':*')) {
      const prefix = lowerAllowed.slice(0, -2);
      return normalizedHost === prefix || normalizedHost.startsWith(prefix + ':');
    }
    return lowerAllowed === normalizedHost;
  });
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  applySecurityHeaders(res);
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, statusCode: number, message: string): void {
  // Never leak internal stack traces or path disclosures to the client
  sendJson(res, statusCode, {
    error: {
      code: statusCode,
      message
    }
  });
}
