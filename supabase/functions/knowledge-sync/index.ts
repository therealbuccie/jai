import { renderPage, type RendererResourcePolicy } from "./render-page.ts";
// Server-only, bounded synchronous sync. Invoke with the service-role bearer.
import { Buffer } from "node:buffer";
import { parseHTML } from "npm:linkedom@0.18.12";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 2_000_000;
// Persist only bounded, allowlisted diagnostics, never raw network/DB messages.
function failureCode(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const codes = ['ECONNREFUSED', 'ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ETIMEOUT', 'ETIMEDOUT',
    'ECONNRESET', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_NOT_IMPLEMENTED'];
  if (typeof e?.code === 'string' && codes.includes(e.code)) return e.code;
  if (typeof e?.message === 'string' && codes.includes(e.message)) return e.message;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'timeout';
  if (typeof e?.message === 'string' && /^(unsafe_url|unsafe_dns|unsafe_redirect|redirect_limit|empty_content|page_too_large|fetch_failed|timeout|unsupported_encoding|invalid_headers|invalid_status|invalid_framing|unexpected_eof|not_html|http_[0-9]{3}|database_[0-9]{3}(?:_[A-Z0-9]{5})?)$/.test(e.message)) return e.message;
  if (typeof e?.message === 'string' && /^(dns|connect|tls|write|read|headers|body):[a-zA-Z0-9_]+$/.test(e.message)) return e.message;
  if (typeof e?.name === 'string' && ['NotSupported', 'NotCapable', 'PermissionDenied', 'ConnectionRefused', 'ConnectionReset', 'InvalidData', 'UnexpectedEof', 'TypeError'].includes(e.name)) return e.name;
  if (typeof e?.message === 'string' && /certificate|certvalid|tls handshake/i.test(e.message)) return 'tls_verification_failed';
  if (typeof e?.message === 'string' && /^renderer_[a-z0-9_]+$/.test(e.message)) return e.message;
  return 'unexpected_error';
}

const ignore = /\/(?:login|logout|signin|signup|admin|account|checkout|cart|search|wp-admin|auth)(?:[/._-]|$)|\.(?:pdf|png|jpe?g|gif|svg|webp|ico|css|js|zip|mp[34]|woff2?|xml|json)$/i;
const useful = /pricing|faq|help|docs|features|support|polic|terms|privacy|about/i;
function canonical(value: string, base?: string): URL {
  const u = new URL(value, base);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port ||
    !u.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|onion)$/.test(u.hostname) ||
    /^[0-9.]+$/.test(u.hostname) || u.hostname.includes(':') || u.hostname.endsWith('.')) throw new Error('unsafe_url');
  u.hash = ''; u.search = ''; // Avoid tracking, session and unbounded query variants.
  if (u.href.length > 2000) throw new Error('unsafe_url');
  return u;
}
function sameSite(u: URL, start: URL): boolean {
  return u.hostname === start.hostname && !(start.protocol === 'https:' && u.protocol !== 'https:');
}
function publicIPv4(ip: string): boolean {
  const n = ip.split('.').map(Number);
  if (n.length !== 4 || n.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a,b,c] = n;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || ip === '168.63.129.16');
}
// Pin TCP to validated DNS results; startTls preserves the original TLS identity.
// Do not use node:https({hostname: ip, servername}): Edge's shim ignores servername.
async function download(u: URL, signal: AbortSignal, resource = false, policy?: RendererResourcePolicy): Promise<{ status: number; location?: string; html: string; contentType?: string }> {
  // Only the server's validated renderer path supplies a resource policy.
  // Static HTML downloads retain MAX_BYTES and their existing MIME restriction.
  const category = resource && policy ? policy.category : 'document';
  const categoryLimit = category === 'javascript' ? 5_000_000 : category === 'css' ? 1_000_000 : MAX_BYTES;
  const maxBytes = resource && policy ? Math.min(categoryLimit, policy.maxBytes) : MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('page_too_large');
  const sizeFailure = (observedBytes: number, wire = false): never => {
    if (resource) console.warn('Renderer resource size rejected', {
      category, reason: wire ? 'wire_limit' : 'body_limit',
      limitBytes: wire ? maxBytes + 131072 : maxBytes,
      observedBytes: Number.isSafeInteger(observedBytes) ? observedBytes : null,
    });
    throw new Error('page_too_large');
  };
  let conn: Deno.Conn | undefined;
  let phase = 'dns';
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { try { conn?.close(); } catch { /* Already closed. */ } reject(new Error('timeout')); };
    signal.addEventListener('abort', abort, { once: true });
  });
  const work = async () => {
    if (signal.aborted) throw new Error('timeout');
    const addresses = await Deno.resolveDns(u.hostname, 'A');
    if (signal.aborted) throw new Error('timeout');
    if (!addresses.length || addresses.some(ip => !publicIPv4(ip))) throw new Error('unsafe_dns');
    phase = 'connect';
    conn = await Deno.connect({ hostname: addresses[0], port: u.protocol === 'https:' ? 443 : 80 });
    if (signal.aborted) { conn.close(); throw new Error('timeout'); }
    if (u.protocol === 'https:') {
      phase = 'tls';
      const tls = await Deno.startTls(conn, { hostname: u.hostname, alpnProtocols: ['http/1.1'] });
      conn = tls;
      if (signal.aborted) { conn.close(); throw new Error('timeout'); }
      await tls.handshake(); // Default CA trust and hostname verification, no bypass.
    }
    phase = 'write';
    const request = new TextEncoder().encode(`GET ${u.pathname}${resource ? u.search : ''} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: JAI-KnowledgeSync/1.0\r\nAccept: text/html\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
    for (let offset = 0; offset < request.length;) {
      const written = await conn.write(request.subarray(offset));
      if (!written) throw new Error('unexpected_eof');
      offset += written;
    }
    // Bounded HTTP/1.1 framing, including chunked responses. No automatic redirects.
    let pending = Buffer.alloc(0); let wireBytes = 0;
    async function more() {
      const buffer = new Uint8Array(16384);
      const n = await conn!.read(buffer);
      if (n === null) return false;
      wireBytes += n;
      if (wireBytes > maxBytes + 131072) sizeFailure(wireBytes, true);
      pending = Buffer.concat([pending, buffer.subarray(0, n)]); return true;
    }
    async function line(): Promise<string> {
      while (true) {
        const end = pending.indexOf('\r\n');
        if (end >= 0) { const value = pending.subarray(0, end).toString('latin1'); pending = pending.subarray(end + 2); return value; }
        if (pending.length > 16384) throw new Error('invalid_headers');
        if (!await more()) throw new Error('unexpected_eof');
      }
    }
    phase = 'headers';
    const statusLine = await line();
    const match = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(statusLine);
    if (!match) throw new Error('invalid_status');
    const status = Number(match[1]); const headers = new Map<string, string>();
    let headerBytes = statusLine.length;
    while (true) {
      const value = await line(); headerBytes += value.length + 2;
      if (headerBytes > 32768) throw new Error('invalid_headers');
      if (!value) break;
      const colon = value.indexOf(':'); if (colon < 1) throw new Error('invalid_headers');
      const key = value.slice(0, colon).toLowerCase();
      if (headers.has(key) && ['content-length', 'transfer-encoding', 'location'].includes(key)) throw new Error('invalid_headers');
      headers.set(key, value.slice(colon + 1).trim());
    }
    if ([301,302,303,307,308].includes(status)) return { status, location: headers.get('location'), html: '' };
    if (status !== 200) throw new Error(`http_${status}`);
    if (resource && /^attachment(?:;|$)/i.test(headers.get('content-disposition') ?? '')) throw new Error('not_html');
    const mime = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (resource && ((category === 'javascript' && !['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'application/x-javascript'].includes(mime)) ||
      (category === 'css' && mime !== 'text/css'))) throw new Error('not_html');
    if (!resource && !/^text\/html(?:;|$)/i.test(headers.get('content-type') ?? '')) throw new Error('not_html');
    if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity') throw new Error('unsupported_encoding');
    phase = 'body';
    const parts: Uint8Array[] = []; let total = 0;
    async function take(size: number) {
      if (!Number.isSafeInteger(size) || size < 0 || total + size > maxBytes) sizeFailure(total + size);
      // Charge before reading/retaining the body. Concurrent resources share the
      // same renderer counter; failed downloads conservatively keep their charge.
      if (resource && policy) {
        try { policy.consumeBytes(size); }
        catch {
          console.warn('Renderer resource size rejected', { category, reason: 'total_byte_limit', limitBytes: 12_000_000 });
          throw new Error('renderer_total_byte_limit');
        }
      }
      while (pending.length < size) if (!await more()) throw new Error('unexpected_eof');
      parts.push(pending.subarray(0, size)); pending = pending.subarray(size); total += size;
    }
    const encoding = headers.get('transfer-encoding');
    if (encoding) {
      if (encoding.toLowerCase() !== 'chunked' || headers.has('content-length')) throw new Error('invalid_framing');
      while (true) {
        const sizeText = (await line()).split(';')[0];
        if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error('invalid_framing');
        const size = Number.parseInt(sizeText, 16); if (!size) break;
        await take(size); if (await line() !== '') throw new Error('invalid_framing');
      }
    } else if (headers.has('content-length')) {
      const length = headers.get('content-length')!;
      if (!/^[0-9]+$/.test(length)) throw new Error('invalid_framing');
      await take(Number(length));
    } else {
      do { await take(pending.length); } while (await more());
    }
    return { status, html: Buffer.concat(parts).toString('utf8'), contentType: headers.get('content-type') };
  };
  try { return await Promise.race([work(), cancelled]); }
  catch (error) {
    // The phase is fixed by code, and exception messages are never persisted verbatim.
    throw new Error(`${phase}:${failureCode(error)}`);
  } finally {
    signal.removeEventListener('abort', abort);
    try { conn?.close(); } catch { /* Already closed. */ }
  }
}
// Extract only published text; never execute scripts or interpret JS bundles.
function extractPage(document: ReturnType<typeof parseHTML>['document']): { title: string; content: string; metadataOnly: boolean } {
  const plain = (value: string) => {
    const fragment = parseHTML(`<html><body>${value.slice(0, 180000)}</body></html>`).document;
    for (const node of fragment.querySelectorAll('script,style,iframe,svg')) node.remove();
    return (fragment.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  };
  const title = (document.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const descriptions = [...document.querySelectorAll('meta[name="description"],meta[property="og:description"],meta[name="twitter:description"]')]
    .map(node => plain(node.getAttribute('content') ?? '')).filter(Boolean);
  const structured: string[] = [];
  let visited = 0;
  function collect(value: unknown, depth = 0) {
    if (depth > 8 || ++visited > 500 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value.slice(0, 100)) collect(child, depth + 1); return; }
    const item = value as Record<string, unknown>;
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    if (types.some(t => ['WebSite', 'WebPage', 'Organization', 'Product', 'SoftwareApplication', 'Article', 'TechArticle', 'FAQPage', 'Question', 'Answer'].includes(String(t)))) {
      for (const key of ['headline', 'description', 'articleBody', 'text']) {
        if (typeof item[key] === 'string') { const text = plain(item[key]); if (text) structured.push(text); }
      }
      if (types.includes('Question') && typeof item.name === 'string') structured.push(plain(item.name));
    }
    for (const key of ['@graph', 'mainEntity', 'acceptedAnswer', 'hasPart']) collect(item[key], depth + 1);
  }
  for (const node of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20)) {
    const data = node.textContent ?? '';
    if (data.length > 200000) continue;
    try { collect(JSON.parse(data)); } catch { /* Malformed structured data is not knowledge. */ }
  }
  for (const node of document.querySelectorAll('script,style,nav,header,footer,aside,form,noscript,svg,iframe,[hidden],[aria-hidden="true"]')) node.remove();
  for (const node of document.querySelectorAll('p,div,section,li,h1,h2,h3,h4,tr,br')) node.appendChild(document.createTextNode('\n'));
  const textOf = (node: { textContent: string | null } | null) => (node?.textContent ?? '').split(/\n/)
    .map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  const mainText = textOf(document.querySelector('main,article,[role="main"]'));
  const bodyText = mainText.length >= 40 ? mainText : textOf(document.body);
  const supporting = [...new Set([...descriptions, ...structured].filter(Boolean))];
  // A title alone is insufficient. A real, short published description is valid
  // but must not be presented as a successfully rendered SPA body.
  // Empty/thin pages are handed to the renderer before being marked ready.
  const content = [...new Set([title, bodyText, ...supporting].filter(Boolean))].join('\n').slice(0, 180000);
  return { title, content, metadataOnly: bodyText.length < 200 };
}

function split(text: string): string[] {
  const chunks: string[] = []; let pending = '';
  for (const paragraph of text.split(/\n+/)) {
    for (let i = 0; i < paragraph.length; i += 1800) {
      const part = paragraph.slice(i, i + 1800);
      if (pending.length + part.length > 2200) { chunks.push(pending); pending = ''; }
      pending += (pending ? '\n' : '') + part;
    }
  }
  if (pending) chunks.push(pending);
  return [...new Set(chunks)];
}
function reply(status: number, data: unknown): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function hash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}
Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return reply(405, { error: 'POST required' });
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), base = Deno.env.get('SUPABASE_URL');
  if (!key || !base) return reply(503, { error: 'Service unavailable' });
  const auth = request.headers.get('authorization') ?? '';
  if (auth.length > 8192 || await hash(auth) !== await hash(`Bearer ${key}`)) return reply(401, { error: 'Unauthorized' });
  async function db(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', prefer = 'return=representation'): Promise<any> {
    const r = await fetch(`${base}/rest/v1/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { apikey: key!, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: prefer },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) {
      let code = '';
      try { const error = await r.json(); if (typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)) code = `_${error.code}`; } catch { /* Omit unstructured error bodies. */ }
      throw new Error(`database_${r.status}${code}`);
    }
    const text = await r.text(); return text ? JSON.parse(text) : null;
  }
  try {
    // Authenticated payload is still bounded and contains only an app identifier.
    const reader = request.body?.getReader(); if (!reader) return reply(400, { error: 'app_id required' });
    let raw = ''; let bytes = 0; const decoder = new TextDecoder();
    while (true) { const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 1024) { await reader.cancel(); return reply(413, { error: 'Body too large' }); }
      raw += decoder.decode(value, { stream: true }); }
    raw += decoder.decode();
    let input; try { input = JSON.parse(raw); } catch { return reply(400, { error: 'Invalid JSON' }); }
    if (!input || typeof input.app_id !== 'string' || !UUID.test(input.app_id) || Object.keys(input).some(k => k !== 'app_id')) return reply(400, { error: 'app_id required' });
    const appId = input.app_id;
    const apps = await db(`apps?id=eq.${appId}&select=id,website_url&limit=1`);
    if (!Array.isArray(apps) || apps.length !== 1) return reply(404, { error: 'App not found' });
    if (!await db('rpc/app_has_capability', { p_app_id: appId, p_capability_key: 'knowledge.website.read' })) return reply(403, { error: 'Website permission required' });
    if (!apps[0].website_url) return reply(409, { error: 'App website_url is not configured' });
    let start: URL; try { start = canonical(apps[0].website_url); } catch { return reply(422, { error: 'Unsafe website configuration' }); }
    const queue = [start.href], seen = new Set<string>();
    const summary = { attempted: 0, updated: 0, unchanged: 0, failed: 0, superseded: 0 };
    const deadline = Date.now() + 110000;
    while (queue.length && summary.attempted < 25 && Date.now() < deadline) {
      queue.sort((a,b) => Number(useful.test(b)) - Number(useful.test(a)));
      const address = queue.shift()!; if (seen.has(address)) continue;
      seen.add(address); summary.attempted++;
      const checkedAt = new Date().toISOString();
      let storedUrl = address;
      let stage = 'capability';
      try {
        if (!await db('rpc/app_has_capability', { p_app_id: appId, p_capability_key: 'knowledge.website.read' })) break;
        let current = canonical(address); let html = '';
        const signal = AbortSignal.timeout(Math.max(1, Math.min(12000, deadline - Date.now())));
        for (let hop = 0; hop <= 4; hop++) {
          if (!sameSite(current, start) || ignore.test(current.pathname)) throw new Error('unsafe_redirect');
          stage = 'fetch';
          const result = await download(current, signal);
          if (result.status === 200) { html = result.html; break; }
          if (!result.location || hop === 4) throw new Error('redirect_limit');
          current = canonical(result.location, current.href);
        }
        storedUrl = current.href;
        if (storedUrl !== address && seen.has(storedUrl)) continue;
        seen.add(storedUrl);
        stage = 'extract';
        const { document } = parseHTML(html);
        for (const a of document.querySelectorAll('a[href]')) {
          try { const link = canonical(a.getAttribute('href')!, current.href);
            if (sameSite(link, start) && !ignore.test(link.pathname) && !seen.has(link.href) && !queue.includes(link.href) && queue.length < 250) queue.push(link.href);
          } catch { /* Skip unsupported links. */ }
        }
        let { title, content, metadataOnly } = extractPage(document);
        if (metadataOnly) {
          stage = 'render';
          if (deadline - Date.now() < 10000) throw new Error('renderer_timeout');
          const rendered = await renderPage(current, {
            signal: AbortSignal.timeout(Math.min(35000, deadline - Date.now())),
            fetchPublic: (target, timeout, policy) => download(target, timeout, true, policy),
            validate: (value, navigation) => {
              const raw = new URL(value);
              const target = canonical(value);
              // Resource queries may carry bundle versions, but never browser credentials.
              if (!navigation) target.search = raw.search;
              if (ignore.test(target.pathname) && navigation) throw new Error('unsafe_url');
              if (navigation && !sameSite(target, start)) throw new Error('unsafe_redirect');
              if (start.protocol === 'https:' && target.protocol !== 'https:') throw new Error('unsafe_url');
              return target;
            },
          });
          storedUrl = canonical(rendered.url).href;
          title = rendered.title;
          content = `${title}\n${rendered.text}`.slice(0, 180000);
          for (const href of rendered.links) {
            try {
              const link = canonical(href, storedUrl);
              if (sameSite(link, start) && !ignore.test(link.pathname) && !seen.has(link.href) && !queue.includes(link.href) && queue.length < 250) queue.push(link.href);
            } catch { /* Skip invalid rendered links. */ }
          }
          seen.add(storedUrl);
        }
        const digest = await hash(content);
        stage = 'read_page';
        const rows = await db(`website_pages?app_id=eq.${appId}&url=eq.${encodeURIComponent(storedUrl)}&select=content_hash,processed_content_hash&limit=1`);
        const unchanged = rows[0]?.content_hash === digest && rows[0]?.processed_content_hash === digest;
        // RPC independently hashes and locks: client-side comparison is only an optimization.
        stage = 'replace_page';
        const outcome = await db('rpc/replace_website_page', { p_app_id: appId, p_website_url: apps[0].website_url,
          p_url: storedUrl, p_title: title, p_content: content, p_chunks: unchanged ? [] : split(content), p_checked_at: checkedAt });
        if (outcome === 'updated') summary.updated++; else if (outcome === 'unchanged') summary.unchanged++; else summary.superseded++;
      } catch (error) {
        summary.failed++;
        const diagnostic = `${stage}:${failureCode(error)}`;
        console.error('Knowledge page sync failed', { app_id: appId, code: diagnostic });
        try {
          await db('website_pages?on_conflict=app_id,url', { app_id: appId, url: storedUrl }, 'POST', 'resolution=ignore-duplicates,return=minimal');
          await db(`website_pages?app_id=eq.${appId}&url=eq.${encodeURIComponent(storedUrl)}&or=(last_checked_at.is.null,last_checked_at.lte.${encodeURIComponent(checkedAt)})`,
            { sync_status: 'failed', last_error: diagnostic, last_checked_at: checkedAt }, 'PATCH');
        } catch { /* Permission revocation or DB outage must not expose errors. */ }
      }
    }
    return reply(200, { ...summary, remaining: queue.length });
  } catch { return reply(503, { error: 'Knowledge sync unavailable' }); }
});
