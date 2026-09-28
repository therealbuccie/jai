const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { ...cors, 'Cache-Control': 'no-store' } });
Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return reply(405, { error: 'POST required' });
  try {
    const base = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const redirect = new URL(Deno.env.get('TEAM_INVITATION_REDIRECT_URL') || '');
    if (!base || !key || redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash) throw new Error();
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ') || authorization.length > 8192) return reply(401, { error: 'Sign in required' });
    const call = (path: string, body?: unknown, auth = `Bearer ${key}`) => fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { apikey: key, Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const userResponse = await call('/auth/v1/user', undefined, authorization);
    if (!userResponse.ok) return reply(401, { error: 'Sign in required' });
    const user = await userResponse.json();
    const reader = request.body?.getReader(); if (!reader) throw new Error();
    let body = ''; let size = 0; const decoder = new TextDecoder();
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 1024) { await reader.cancel(); return reply(413, { error: 'Invalid request' }); }
      body += decoder.decode(value, { stream: true }); }
    const input = JSON.parse(body + decoder.decode());
    if (!input || Object.keys(input).some(k => k !== 'invitation_id') || typeof input.invitation_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.invitation_id)) return reply(400, { error: 'Invalid invitation' });
    const reserved = await call('/rest/v1/rpc/reserve_team_invitation_email', { p_invitation_id: input.invitation_id, p_actor_id: user.id });
    if (!reserved.ok) return reply(403, { error: 'Invitation unavailable or sent recently. Try again after a minute.' });
    const email = await reserved.json(); if (typeof email !== 'string') throw new Error();
    redirect.searchParams.set('invitation', input.invitation_id);
    const suffix = `?redirect_to=${encodeURIComponent(redirect.href)}`;
    let delivery = await call(`/auth/v1/invite${suffix}`, { email });
    if (!delivery.ok) {
      const failure = await delivery.json();
      if (!['email_exists', 'user_already_exists'].includes(failure.error_code || failure.code)) throw new Error();
      delivery = await call(`/auth/v1/otp${suffix}`, { email, create_user: false });
    }
    if (!delivery.ok) throw new Error();
    await delivery.body?.cancel();
    return reply(200, { sent: true });
  } catch { return reply(503, { error: 'Email could not be sent. The invitation remains pending; retry after a minute.' }); }
});
