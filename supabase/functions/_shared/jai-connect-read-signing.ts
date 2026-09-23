// Server-only signing foundation. The private JWK set is supplied through a
// Supabase Edge secret, never a table or browser response.
export type ReadRequest = {
  version: 1;
  request_id: string;
  app_id: string;
  capability: 'customer.profile.read' | 'customer.subscription.read' |
    'billing.payment.read' | 'diagnostics.read';
  customer: { external_subject: string };
};

export type PublicJwk = {
  kty: 'OKP'; crv: 'Ed25519'; x: string; alg: 'EdDSA'; use: 'sig'; kid: string;
};
type SigningKey = { privateKey: CryptoKey; publicJwk: PublicJwk };
export type JwksDiagnosticCode = 'secret_missing' | 'json_parse_failed' | 'not_array' |
  'empty_array' | 'invalid_jwk_shape' | 'missing_public_x' | 'no_usable_keys' |
  'unexpected_error';
export class JwksDiagnosticError extends Error {
  constructor(readonly code: JwksDiagnosticCode) { super(code); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const CAPABILITIES = new Set([
  'customer.profile.read', 'customer.subscription.read',
  'billing.payment.read', 'diagnostics.read',
]);
const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_32.test(value)) throw new Error('Signing identity unavailable');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=');
  if (binary.length !== 32) throw new Error('Signing identity unavailable');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function loadKey(value: unknown): Promise<SigningKey> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Signing identity unavailable');
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' || typeof jwk.d !== 'string') throw new Error('Signing identity unavailable');
  const publicBytes = decode(jwk.x);
  decode(jwk.d);
  const privateKey = await crypto.subtle.importKey('jwk',
    { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d },
    { name: 'Ed25519' }, false, ['sign']);
  const publicKey = await crypto.subtle.importKey('raw', publicBytes,
    { name: 'Ed25519' }, false, ['verify']);
  // Reject a mismatched public/private pair before publishing or signing.
  const challenge = encoder.encode('jai-connect-read-v1-key-check');
  const signature = await crypto.subtle.sign('Ed25519', privateKey, challenge);
  if (!await crypto.subtle.verify('Ed25519', publicKey, signature, challenge)) {
    throw new Error('Signing identity unavailable');
  }
  const thumbprint = encoder.encode(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }));
  const kid = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', thumbprint)));
  return { privateKey, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x,
    alg: 'EdDSA', use: 'sig', kid } };
}
// Public discovery needs only x. Do not make JWKS availability depend on
// private-key import/sign support in the Edge runtime.
async function loadPublicKey(value: unknown): Promise<PublicJwk> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JwksDiagnosticError('invalid_jwk_shape');
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw new JwksDiagnosticError('invalid_jwk_shape');
  if (typeof jwk.x !== 'string') throw new JwksDiagnosticError('missing_public_x');
  if (typeof jwk.d !== 'string') throw new JwksDiagnosticError('invalid_jwk_shape');
  try { decode(jwk.x); decode(jwk.d); }
  catch { throw new JwksDiagnosticError('invalid_jwk_shape'); }
  const thumbprint = encoder.encode(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }));
  const kid = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', thumbprint)));
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, alg: 'EdDSA', use: 'sig', kid };
}
function parseKeySet(secret: string | undefined): unknown[] {
  if (!secret || secret.length > 4096) throw new Error('Signing identity unavailable');
  let parsed: unknown;
  try { parsed = JSON.parse(secret); } catch { throw new Error('Signing identity unavailable'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 3) throw new Error('Signing identity unavailable');
  return parsed;
}
export async function loadSigningKeys(secret: string | undefined): Promise<SigningKey[]> {
  const keys = await Promise.all(parseKeySet(secret).map(loadKey));
  if (new Set(keys.map(key => key.publicJwk.kid)).size !== keys.length) throw new Error('Signing identity unavailable');
  return keys;
}
export async function publicJwks(secret: string | undefined): Promise<{ keys: PublicJwk[] }> {
  if (!secret) throw new JwksDiagnosticError('secret_missing');
  if (secret.length > 4096) throw new JwksDiagnosticError('invalid_jwk_shape');
  let parsed: unknown;
  try { parsed = JSON.parse(secret); }
  catch { throw new JwksDiagnosticError('json_parse_failed'); }
  if (!Array.isArray(parsed)) throw new JwksDiagnosticError('not_array');
  if (parsed.length === 0) throw new JwksDiagnosticError('empty_array');
  if (parsed.length > 3) throw new JwksDiagnosticError('invalid_jwk_shape');
  const keys = await Promise.all(parsed.map(loadPublicKey));
  if (keys.length === 0 || new Set(keys.map(key => key.kid)).size !== keys.length) {
    throw new JwksDiagnosticError('no_usable_keys');
  }
  return { keys };
}
export async function signReadRequest(
  request: ReadRequest, destination: string, issuer: string, secret: string | undefined,
): Promise<{ body: string; authorization: string; expires_at: string }> {
  const url = new URL(destination);
  const issuerUrl = new URL(issuer);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash ||
    !request || Object.keys(request).sort().join(',') !== 'app_id,capability,customer,request_id,version' ||
    request.version !== 1 || !UUID.test(request.request_id) || !UUID.test(request.app_id) ||
    !CAPABILITIES.has(request.capability) || !request.customer ||
    Object.keys(request.customer).join(',') !== 'external_subject' ||
    typeof request.customer.external_subject !== 'string' ||
    !request.customer.external_subject.trim() || request.customer.external_subject.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(request.customer.external_subject)) throw new Error('Invalid read request');
  const body = JSON.stringify(request);
  if (encoder.encode(body).length > 4096) throw new Error('Invalid read request');
  const [active] = await loadSigningKeys(secret);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 120;
  const bodyHash = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body))));
  const header = { alg: 'EdDSA', typ: 'JWT', kid: active.publicJwk.kid };
  const claims = {
    iss: issuerUrl.href, aud: url.href, version: 1, request_id: request.request_id,
    app_id: request.app_id, capability: request.capability,
    external_subject: request.customer.external_subject,
    iat, exp, jti: crypto.randomUUID(), body_sha256: bodyHash,
  };
  const input = `${encode(encoder.encode(JSON.stringify(header)))}.${encode(encoder.encode(JSON.stringify(claims)))}`;
  const signature = encode(new Uint8Array(await crypto.subtle.sign('Ed25519', active.privateKey, encoder.encode(input))));
  return { body, authorization: `Bearer ${input}.${signature}`,
    expires_at: new Date(exp * 1000).toISOString() };
}
