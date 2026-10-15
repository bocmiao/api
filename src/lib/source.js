// These headers describe a caller-supplied website, never an authenticated identity.
import { isIP } from 'node:net';

export function websiteHost(raw, { origin = false } = {}) {
  if (typeof raw !== 'string' || !raw || raw === 'null' || raw.length > 16_384
    || /[\s\u0000-\u001f\u007f\\,]/u.test(raw) || !/^https?:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    const authority = raw.match(/^https?:\/\/([^/?#]+)/i)?.[1];
    if (!authority || /[@%]/.test(authority) || u.username || u.password
      || (origin && !/^https?:\/\/[^/?#]+\/?$/i.test(raw))
      || (origin && (u.pathname !== '/' || u.search || u.hash))) return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (isIP(host.replace(/^\[|\]$/g, ''))) return host;
    if (!host || host.length > 253 || !host.split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return host;
  } catch { return null; }
}

export function requestSource(headers = {}) {
  const origin = headers.origin, referer = headers.referer;
  const originHost = websiteHost(origin, { origin: true });
  const refererHost = websiteHost(referer);
  const host = originHost || refererHost;
  const basis = originHost ? 'origin' : refererHost ? 'referer' : 'unknown';
  let state;
  if (originHost && refererHost) state = originHost === refererHost ? 'matched' : 'conflict';
  else if (host) state = !originHost && origin != null && origin !== '' ? 'fallback' : 'single';
  else if ([origin, referer].every(v => v == null || v === '')) state = 'missing';
  else if ([origin, referer].every(v => v == null || v === '' || v === 'null')) state = 'opaque';
  else state = 'invalid';
  return { host: host || null, basis, state, originHost, refererHost };
}

// Older releases stored at most 100 characters. Such values cannot be attributed safely.
export function legacySource(host) {
  const normalized = typeof host === 'string' && host.length !== 100 && !/[/@?#%]/.test(host) ? websiteHost(`https://${host}`) : null;
  return { host: normalized, state: host && !normalized ? 'legacy_unverifiable' : 'legacy' };
}
