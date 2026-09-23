import { isJaiConnectReadRequest, type JaiConnectReadRequest,
  JAI_CONNECT_READ_MAX_REQUEST_BYTES } from './read-v1';

export interface JaiConnectReadPublicJwk {
  kty: 'OKP'; crv: 'Ed25519'; x: string; alg: 'EdDSA'; use: 'sig'; kid: string;
}
export interface JaiConnectReadJwks { keys: JaiConnectReadPublicJwk[] }
export interface JaiConnectReadVerification {
  body: string;
  authorization: string;
  expectedAudience: string; // Exact, pinned HTTPS connector URL.
  expectedIssuer: string; // Exact, pinned JAI JWKS URL.
  jwks: JaiConnectReadJwks;
  // Atomically reserve (issuer, kid, jti) until exp; false means replay.
  reserveReplay: (issuer: string, kid: string, jti: string, exp: number) => Promise<boolean>;
}
const encoder = new TextEncoder();
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === names.length && names.every(name => Object.hasOwn(value, name));
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(value)) throw new Error('Invalid encoding');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function parse(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(value)));
  if (!object(parsed)) throw new Error('Invalid JSON');
  return parsed;
}
function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Verification has no transport: the app supplies pinned keys, the exact
// received body, and a durable atomic replay reservation implementation.
export async function verifyJaiConnectReadRequest(input: JaiConnectReadVerification): Promise<JaiConnectReadRequest | null> {
  try {
    if (encoder.encode(input.body).length > JAI_CONNECT_READ_MAX_REQUEST_BYTES ||
      !input.authorization.startsWith('Bearer ') || input.authorization.length > 8192 ||
      typeof input.reserveReplay !== 'function') return null;
    const request: unknown = JSON.parse(input.body);
    if (!isJaiConnectReadRequest(request)) return null;
    const token = input.authorization.slice(7);
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !BASE64URL.test(part))) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = parse(encodedHeader);
    const claims = parse(encodedClaims);
    if (!exact(header, ['alg', 'typ', 'kid']) || header.alg !== 'EdDSA' || header.typ !== 'JWT' ||
      typeof header.kid !== 'string' || !BASE64URL.test(header.kid) || header.kid.length !== 43 ||
      !exact(claims, ['iss', 'aud', 'version', 'request_id', 'app_id', 'capability',
        'external_subject', 'iat', 'exp', 'jti', 'body_sha256']) ||
      claims.iss !== input.expectedIssuer || claims.aud !== input.expectedAudience ||
      claims.version !== request.version || claims.request_id !== request.request_id ||
      claims.app_id !== request.app_id || claims.capability !== request.capability ||
      claims.external_subject !== request.customer.external_subject ||
      typeof claims.jti !== 'string' || !UUID.test(claims.jti) ||
      typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) ||
      typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) ||
      typeof claims.body_sha256 !== 'string' || claims.body_sha256.length !== 43) return null;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iat > now + 30 || claims.exp <= now || claims.exp <= claims.iat ||
      claims.exp - claims.iat > 300) return null;
    const bodyHash = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input.body))));
    if (claims.body_sha256 !== bodyHash) return null;
    const key = input.jwks.keys.find(item => item.kid === header.kid);
    if (!key || key.kty !== 'OKP' || key.crv !== 'Ed25519' || key.alg !== 'EdDSA' ||
      key.use !== 'sig' || !BASE64URL.test(key.x) || key.x.length !== 43 ||
      Object.hasOwn(key, 'd')) return null;
    const publicBytes = decode(key.x);
    const signature = decode(encodedSignature);
    if (publicBytes.length !== 32 || signature.length !== 64) return null;
    const publicKey = await crypto.subtle.importKey('raw', publicBytes,
      { name: 'Ed25519' }, false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', publicKey, signature,
      encoder.encode(`${encodedHeader}.${encodedClaims}`))) return null;
    if (claims.exp <= Math.floor(Date.now() / 1000) ||
      !await input.reserveReplay(input.expectedIssuer, key.kid, claims.jti, claims.exp)) return null;
    return request;
  } catch { return null; }
}
