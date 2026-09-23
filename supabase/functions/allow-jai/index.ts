import { resolve4 } from "node:dns/promises";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { ...cors, "Cache-Control": "no-store" } });
}
// Configuration validation only. knowledge-sync revalidates DNS and every fetch.
async function website(value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('url');
  const u = new URL(value.trim());
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port ||
    !u.hostname.includes('.') || /^[0-9.]+$/.test(u.hostname) || u.hostname.includes(':') ||
    u.hostname.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|onion)$/.test(u.hostname)) throw new Error('url');
  u.hash = ''; u.search = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ips = await Promise.race([resolve4(u.hostname), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('dns_timeout')), 5000);
    })]);
    if (!ips.length || ips.some(ip => {
      const n = ip.split('.').map(Number); const [a,b,c] = n;
      return n.length !== 4 || n.some(x => !Number.isInteger(x) || x < 0 || x > 255) ||
        a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113) || ip === '168.63.129.16';
    })) throw new Error('url');
  } finally { clearTimeout(timer); }
  if (u.href.length > 2000) throw new Error('url');
  return u.href;
}
Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'POST required' });
  const base = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) return json(503, { error: 'Service unavailable' });
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ') || authorization.length > 8192) return json(401, { error: 'Authentication required' });
  try {
    const auth = await fetch(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: authorization },
      signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!auth.ok) { await auth.body?.cancel(); return json(401, { error: 'Invalid session' }); }
    const user = await auth.json();
    if (typeof user.id !== 'string' || !UUID.test(user.id)) return json(401, { error: 'Invalid session' });
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json(415, { error: 'JSON required' });
    const reader = request.body?.getReader(); if (!reader) return json(400, { error: 'Body required' });
    let text = ''; let size = 0; const decoder = new TextDecoder();
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 8192) { await reader.cancel(); return json(413, { error: 'Body too large' }); }
      text += decoder.decode(value, { stream: true }); }
    text += decoder.decode();
    let input; try { input = JSON.parse(text); } catch { return json(400, { error: 'Invalid JSON' }); }
    if (!input || typeof input.app_id !== 'string' || !UUID.test(input.app_id) ||
      Object.keys(input).some(k => !['app_id', 'website_url'].includes(k))) return json(400, { error: 'app_id and website_url required' });
    // Check the caller's organization-admin membership before DNS validation.
    const access = await fetch(`${base}/rest/v1/apps?id=eq.${input.app_id}&select=organization_id&limit=1`, {
      headers: { apikey: key, Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!access.ok) { await access.body?.cancel(); return json(403, { error: 'App access denied' }); }
    const apps = await access.json();
    if (!Array.isArray(apps) || apps.length !== 1 || !UUID.test(apps[0].organization_id)) return json(403, { error: 'App access denied' });
    const admin = await fetch(`${base}/rest/v1/human_agents?auth_user_id=eq.${user.id}&organization_id=eq.${apps[0].organization_id}&role=eq.admin&select=id&limit=1`, {
      headers: { apikey: key, Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!admin.ok) { await admin.body?.cancel(); return json(403, { error: 'Admin required' }); }
    const agents = await admin.json();
    if (!Array.isArray(agents) || agents.length !== 1) return json(403, { error: 'Admin required' });
    let url: string; try { url = await website(input.website_url); } catch { return json(400, { error: 'Public HTTP/HTTPS website required (IPv4)' }); }
    const saved = await fetch(`${base}/rest/v1/rpc/allow_jai`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_app_id: input.app_id, p_actor_id: user.id, p_website_url: url }) });
    if (!saved.ok) { await saved.body?.cancel(); return json(saved.status === 403 ? 403 : 503, { error: 'Consent could not be saved' }); }
    const result = await saved.json();
    // Consent has committed. Scheduling and network failures cannot undo it.
    try {
      EdgeRuntime.waitUntil((async () => {
        try {
          const sync = await fetch(`${base}/functions/v1/knowledge-sync`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(150000),
            headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: input.app_id }) });
          await sync.body?.cancel();
          if (!sync.ok) console.error('Knowledge sync wake failed');
        } catch { console.error('Knowledge sync wake failed'); }
      })());
    } catch { console.error('Knowledge sync scheduling failed'); }
    return json(200, result);
  } catch { return json(503, { error: 'Onboarding unavailable' }); }
});
