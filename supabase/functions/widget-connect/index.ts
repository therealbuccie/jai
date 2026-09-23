// JAI Connect identity redemption. Deploy with --no-verify-jwt: browser requests
// carry a signed app assertion, never a JAI service credential.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};
function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { ...cors, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decode(part: string): Uint8Array {
  if (!BASE64URL.test(part)) throw new Error("invalid_assertion");
  const raw = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - part.length % 4) % 4));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
function parse(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(part)));
  if (!record(value)) throw new Error("invalid_assertion");
  return value;
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("invalid_assertion");
  if (!request.body) throw new Error("invalid_assertion");
  const reader = request.body.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) throw new Error("invalid_assertion");
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!record(value) || Object.keys(value).some(key => !["appId", "assertion"].includes(key))) throw new Error("invalid_assertion");
  return value;
}
Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply(405, { error: "POST required" });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return reply(503, { error: "Identity service unavailable" });
  try {
    const body = await readBody(request);
    if (typeof body.appId !== "string" || !UUID.test(body.appId) ||
      typeof body.assertion !== "string" || body.assertion.length > 4096) throw new Error("invalid_assertion");
    const pieces = body.assertion.split(".");
    if (pieces.length !== 3) throw new Error("invalid_assertion");
    const [encodedHeader, encodedClaims, encodedSignature] = pieces;
    const header = parse(encodedHeader);
    const claims = parse(encodedClaims);
    if (Object.keys(header).some(key => !["alg", "typ", "kid"].includes(key)) ||
      header.alg !== "EdDSA" || header.typ !== "JWT" ||
      typeof header.kid !== "string" || !UUID.test(header.kid) ||
      Object.keys(claims).some(key => !["iss", "aud", "app_id", "sub", "iat", "exp", "jti", "name", "email"].includes(key)) ||
      claims.iss !== "jai-connect" || claims.aud !== "jai-widget" || claims.app_id !== body.appId ||
      typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 200 || /[\u0000-\u001f\u007f]/.test(claims.sub) ||
      typeof claims.jti !== "string" || !UUID.test(claims.jti) ||
      typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) ||
      typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) ||
      (claims.name !== undefined && (typeof claims.name !== "string" || claims.name.length > 200 || /[\u0000-\u001f\u007f]/.test(claims.name))) ||
      (claims.email !== undefined && (typeof claims.email !== "string" || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)))) throw new Error("invalid_assertion");
    const now = Math.floor(Date.now() / 1000);
    if (claims.iat > now + 30 || claims.exp <= now || claims.exp <= claims.iat ||
      claims.exp - claims.iat > 300) throw new Error("invalid_assertion");
    const base = supabaseUrl.replace(/\/$/, "");
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const keysResponse = await fetch(`${base}/rest/v1/jai_connect_keys?app_id=eq.${body.appId}&kid=eq.${header.kid}&enabled=eq.true&select=public_key&limit=1`, {
      headers, signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (!keysResponse.ok) { await keysResponse.body?.cancel(); throw new Error("identity_service_failed"); }
    const keys: unknown = await keysResponse.json();
    if (!Array.isArray(keys) || keys.length !== 1 || !record(keys[0]) ||
      typeof keys[0].public_key !== "string") throw new Error("invalid_assertion");
    const publicKeyBytes = decode(keys[0].public_key);
    const signature = decode(encodedSignature);
    if (publicKeyBytes.length !== 32 || signature.length !== 64) throw new Error("invalid_assertion");
    const publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    if (!await crypto.subtle.verify("Ed25519", publicKey, signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`))) throw new Error("invalid_assertion");

    const sessionToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken));
    const sessionTokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const response = await fetch(`${base}/rest/v1/rpc/redeem_jai_connect_identity`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_app_id: body.appId, p_kid: header.kid, p_external_subject: claims.sub, p_jti: claims.jti,
        p_name: claims.name ?? null, p_email: claims.email ?? null,
        p_session_token_hash: sessionTokenHash,
      }),
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Includes replayed jti; do not expose database details or identifiers.
      return reply(response.status === 409 ? 409 : 401, { error: "Identity assertion rejected" });
    }
    const customerId: unknown = await response.json();
    if (typeof customerId !== "string" || !UUID.test(customerId)) throw new Error("identity_service_failed");
    return reply(201, {
      sessionToken, customerId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      identityLevel: "product_verified",
    });
  } catch (error) {
    return reply(error instanceof Error && error.message === "invalid_assertion" ? 401 : 503,
      { error: error instanceof Error && error.message === "invalid_assertion" ? "Identity assertion rejected" : "Identity service unavailable" });
  }
});
