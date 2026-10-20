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

export function matchesHostPattern(candidateHost: string, pattern: string): boolean {
  const lowerCandidate = candidateHost.toLowerCase().trim();
  let lowerPattern = pattern.toLowerCase().trim();

  // Strip protocol and path if pattern was specified as origin URL (e.g. https://domain.com/)
  if (lowerPattern.startsWith('https://')) {
    lowerPattern = lowerPattern.slice(8);
  } else if (lowerPattern.startsWith('http://')) {
    lowerPattern = lowerPattern.slice(7);
  }
  lowerPattern = lowerPattern.split('/')[0] || '';

  if (lowerPattern === '*') {
    return true;
  }

  const candidateWithoutPort = lowerCandidate.split(':')[0] || '';

  if (lowerPattern.startsWith('*.')) {
    const suffix = lowerPattern.slice(2);
    return candidateWithoutPort === suffix || candidateWithoutPort.endsWith('.' + suffix);
  }

  if (lowerPattern.endsWith(':*')) {
    const prefix = lowerPattern.slice(0, -2);
    return lowerCandidate === prefix || lowerCandidate.startsWith(prefix + ':');
  }

  if (lowerPattern === lowerCandidate) {
    return true;
  }

  // Allow matching when candidate includes default HTTP/HTTPS ports (80 or 443)
  if (
    (lowerCandidate.endsWith(':443') || lowerCandidate.endsWith(':80')) &&
    candidateWithoutPort === lowerPattern
  ) {
    return true;
  }

  return false;
}

export function validateHostHeader(req: IncomingMessage, allowedHosts: readonly string[]): boolean {
  const hostHeader = req.headers['host'];
  if (!hostHeader) {
    return false;
  }

  const normalizedHost = hostHeader.trim().toLowerCase();
  return allowedHosts.some(allowed => matchesHostPattern(normalizedHost, allowed));
}

function getHeaderString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function isTrustedOrigin(originHeader: string, allowedHosts: readonly string[]): boolean {
  try {
    const originUrl = new URL(originHeader.trim());
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return false;
    }

    const originHost = originUrl.host.toLowerCase();
    return allowedHosts.some(allowed => matchesHostPattern(originHost, allowed));
  } catch {
    return false;
  }
}

/**
 * Validates Origin and Sec-Fetch-Site headers to protect against cross-site request forgery
 * and malicious external browser web pages querying local loopback endpoints.
 */
export function validateOriginHeader(
  req: IncomingMessage,
  allowedHosts: readonly string[]
): boolean {
  const secFetchSite = getHeaderString(req.headers['sec-fetch-site']);
  const secFetchMode = getHeaderString(req.headers['sec-fetch-mode']);
  const secFetchDest = getHeaderString(req.headers['sec-fetch-dest']);
  const originHeader = getHeaderString(req.headers['origin']);
  const method = (req.method ?? 'GET').toUpperCase();

  // If Sec-Fetch-Site indicates cross-site:
  if (secFetchSite === 'cross-site') {
    // Top-level document navigation (e.g. clicking a link to open the public app)
    // is safe for read-only GET / HEAD.
    // We reject iframe embedding (nested-document/iframe/embed/object) and cross-site mutations/fetches.
    const isSafeTopLevelNavigation =
      (method === 'GET' || method === 'HEAD') &&
      secFetchMode === 'navigate' &&
      secFetchDest !== 'iframe' &&
      secFetchDest !== 'nested-document' &&
      secFetchDest !== 'embed' &&
      secFetchDest !== 'object';

    if (!isSafeTopLevelNavigation) {
      return false;
    }

    // If an Origin header is explicitly sent on the cross-site request, ensure it is trusted
    if (originHeader) {
      return isTrustedOrigin(originHeader, allowedHosts);
    }

    return true;
  }

  // If no Origin header is present (direct CLI, curl, same-origin top-level navigation), permit
  if (!originHeader) {
    return true;
  }

  return isTrustedOrigin(originHeader, allowedHosts);
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  applySecurityHeaders(res);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
