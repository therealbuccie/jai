// Public anonymous bootstrap: configure verify_jwt = false when deploying.
// TODO: Restrict origins to each app's approved product domains.
// TODO: Add abuse controls/rate limiting before opening this endpoint broadly.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};
const MAX_BODY_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readInput(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new InputError("Content-Type must be application/json", 415);
  }
  if (!request.body) throw new InputError("JSON body required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new InputError("Request body too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new InputError("Invalid JSON body"); }
  if (!isObject(input) || Object.keys(input).some((key) => !["appId", "visitor"].includes(key))) {
    throw new InputError("Expected appId and optional visitor");
  }
  if (typeof input.appId !== "string" || !UUID.test(input.appId)) {
    throw new InputError("appId must be a UUID");
  }
  const visitor = input.visitor === undefined ? {} : input.visitor;
  if (!isObject(visitor) || Object.keys(visitor).some((key) => !["name", "email"].includes(key))) {
    throw new InputError("visitor must contain only optional name and email");
  }
  const visitorFields: Record<string, unknown> = visitor;
  function optionalText(key: string, max: number): string | null {
    const value = visitorFields[key];
    if (value === undefined) return null;
    if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new InputError(`Invalid visitor ${key}`);
    }
    return value.trim() || null;
  }
  const name = optionalText("name", 200);
  const email = optionalText("email", 254);
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new InputError("Invalid visitor email");
  }
  return { appId: input.appId, name, email };
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") {
    const response = json(405, { error: "Method not allowed" });
    response.headers.set("Allow", "POST, OPTIONS");
    return response;
  }

  try {
    const input = await readInput(request);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return json(500, { error: "Session service unavailable" });

    // Native REST calls use only server credentials, never caller authorization.
    async function database(path: string, method = "GET", body?: Record<string, unknown>) {
      const response = await fetch(`${supabaseUrl!.replace(/\/$/, "")}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: serviceKey!,
          Authorization: `Bearer ${serviceKey!}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Do not expose database errors, credentials, or request contents.
        throw new Error("Database request failed");
      }
      return response;
    }

    const appResponse = await database(`apps?id=eq.${encodeURIComponent(input.appId)}&status=eq.active&select=id,organization_id&limit=1`);
    const apps: unknown = await appResponse.json();
    if (!Array.isArray(apps)) throw new Error("Invalid database response");
    if (apps.length === 0) return json(404, { error: "Active app not found" });
    const app: unknown = apps[0];
    if (!isObject(app) || typeof app.organization_id !== "string" || !UUID.test(app.organization_id)) {
      throw new Error("Invalid database response");
    }

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const sessionToken = Array.from(tokenBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken));
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const customerId = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    try {
      // Visitor fields are unverified metadata, never identity or email matching.
      await database("customers", "POST", {
        id: customerId,
        organization_id: app.organization_id,
        display_name: input.name,
        email: input.email,
      });
      await database("customer_sessions", "POST", {
        customer_id: customerId,
        app_id: input.appId,
        session_token_hash: tokenHash,
        identity_level: "anonymous",
        created_at: createdAt.toISOString(),
        expires_at: expiresAt,
      });
    } catch {
      // Best-effort compensation, including ambiguous network failures. Deleting
      // this newly generated customer also cascades any just-created session.
      // These REST writes are not atomic; interrupted cleanup may leave records.
      try { await database(`customers?id=eq.${customerId}`, "DELETE"); }
      catch { /* Never log tokens, visitor details, credentials, or DB errors. */ }
      return json(500, { error: "Unable to create session" });
    }

    return json(201, { sessionToken, customerId, expiresAt });
  } catch (error) {
    if (error instanceof InputError) return json(error.status, { error: error.message });
    return json(500, { error: "Unable to create session" });
  }
});
