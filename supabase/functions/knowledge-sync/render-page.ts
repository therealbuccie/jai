import puppeteer, { type ConnectionTransport } from "npm:puppeteer-core@24.31.0";

export type RenderedPage = { title: string; text: string; links: string[]; url: string };
export type RendererResourcePolicy = {
  category: 'javascript' | 'css' | 'document' | 'data';
  maxBytes: number;
  consumeBytes: (bytes: number) => void;
};
type Resource = { status: number; location?: string; html: string; contentType?: string };

async function rendererRejection(response: Response): Promise<Error> {
  // Bound the error body; expose only numeric codes and fixed categories.
  // Never return provider messages, which can contain credentials or URLs.
  let detail = 'unclassified';
  let code = '';
  const reader = response.body?.getReader();
  try {
    let body = '';
    let size = 0;
    const decoder = new TextDecoder();
    if (reader) while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error('oversized');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const payload = JSON.parse(body);
    const errors = Array.isArray(payload?.errors) ? payload.errors.slice(0, 5) : [payload];
    const messages = errors.map((error: { message?: unknown }) =>
      typeof error?.message === 'string' ? error.message : '').join(' ').toLowerCase();
    const providerCode = errors.find((error: { code?: unknown }) =>
      typeof error?.code === 'number' && Number.isSafeInteger(error.code) && error.code >= 0)?.code;
    if (providerCode !== undefined) code = `_cf_${providerCode}`;
    const reasons: [RegExp, string][] = [
      [/keep.?alive/, 'keep_alive'], [/guardrail|alloweddomain/, 'guardrails'],
      [/permission|unauthori|authentication|api.?token/, 'authorization'],
      [/concurren|session limit/, 'session_limit'], [/quota|rate.limit|too many/, 'quota'],
      [/billing|subscription|plan/, 'account_plan'], [/json|body|schema|validation|parameter/, 'invalid_request'],
    ];
    detail = reasons.find(([pattern]) => pattern.test(messages))?.[1] ?? detail;
  } catch { /* Retain status when the rejection body cannot be read or parsed. */ }
  finally { await reader?.cancel().catch(() => {}); }
  return new Error(`renderer_http_${response.status}_${detail}${code}`);
}


// Supabase's Node HTTP shim cannot support ws's createConnection hook.
// This CDP-only transport uses verified Deno TLS, with no redirects or Node HTTP.
async function connectRenderer(endpoint: string, token: string, signal: AbortSignal): Promise<ConnectionTransport> {
  const url = new URL(endpoint);
  if (url.protocol !== 'wss:' || url.hostname !== 'api.cloudflare.com' || url.port ||
    url.username || url.password || url.search || url.hash ||
    !/^\/client\/v4\/accounts\/[a-f0-9]{32}\/browser-rendering\/devtools\/browser\/[a-f0-9-]{36}$/i.test(url.pathname)) {
    throw new Error('renderer_transport_endpoint');
  }
  // Validate without including the credential in errors or URLs.
  const authorization = new Headers({ Authorization: `Bearer ${token}` }).get('Authorization')!;
  let conn: Deno.TlsConn | undefined;
  let closed = false;
  let transport: ConnectionTransport | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    try { conn?.close(); } catch { /* Already closed. */ }
    transport?.onclose?.();
  };
  signal.addEventListener('abort', close, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal.aborted) throw new Error('renderer_timeout');
    const opening = (async () => {
      conn = await Deno.connectTls({ hostname: url.hostname, port: 443, alpnProtocols: ['http/1.1'] });
      if (closed) { conn.close(); throw new Error('renderer_transport_closed'); }
      return conn;
    })();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { close(); reject(new Error('renderer_transport_timeout')); }, 10000);
    });
    const setup = (async () => {
      const socket = await opening;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const write = async (bytes: Uint8Array) => {
        for (let offset = 0; offset < bytes.length;) {
          const n = await socket.write(bytes.subarray(offset));
          if (!n) throw new Error('renderer_transport_closed');
          offset += n;
        }
      };
      let pending = new Uint8Array(0);
      const read = async (length: number): Promise<Uint8Array> => {
        const output = new Uint8Array(length);
        let offset = Math.min(length, pending.length);
        output.set(pending.subarray(0, offset));
        pending = pending.subarray(offset);
        while (offset < length) {
          const n = await socket.read(output.subarray(offset));
          if (n === null || n === 0) throw new Error('renderer_transport_closed');
          offset += n;
        }
        return output;
      };
      const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      await write(encoder.encode(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.hostname}\r\nAuthorization: ${authorization}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`));
      // Read bounded headers without consuming the first CDP frame.
      const header = new Uint8Array(16384);
      let used = 0;
      let end = -1;
      while (end < 0) {
        if (used === header.length) throw new Error('renderer_transport_handshake');
        const n = await socket.read(header.subarray(used));
        if (!n) throw new Error('renderer_transport_closed');
        const start = Math.max(0, used - 3);
        used += n;
        for (let i = start; i <= used - 4; i++) {
          if (header[i] === 13 && header[i + 1] === 10 && header[i + 2] === 13 && header[i + 3] === 10) { end = i + 4; break; }
        }
      }
      pending = header.slice(end, used);
      const lines = decoder.decode(header.subarray(0, end)).split('\r\n');
      const status = /^HTTP\/1\.1 (\d{3})\b/.exec(lines.shift() ?? '')?.[1];
      if (status !== '101') throw new Error(status ? `renderer_transport_http_${status}` : 'renderer_transport_handshake');
      const headers = new Headers();
      for (const line of lines.filter(Boolean)) {
        const separator = line.indexOf(':');
        if (separator <= 0) throw new Error('renderer_transport_handshake');
        headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
      }
      const digest = await crypto.subtle.digest('SHA-1', encoder.encode(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'));
      const accept = btoa(String.fromCharCode(...new Uint8Array(digest)));
      if (headers.get('sec-websocket-accept') !== accept || headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
        !headers.get('connection')?.toLowerCase().split(',').map(s => s.trim()).includes('upgrade') ||
        headers.has('sec-websocket-extensions') || headers.has('sec-websocket-protocol')) throw new Error('renderer_transport_handshake');
      let writes = Promise.resolve();
      const send = (payload: Uint8Array, opcode: number) => {
        if (closed) throw new Error('renderer_transport_closed');
        if (payload.length > 16_000_000) throw new Error('renderer_transport_limit');
        const lengthBytes = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
        const frame = new Uint8Array(2 + lengthBytes + 4 + payload.length);
        frame[0] = 0x80 | opcode;
        frame[1] = 0x80 | (lengthBytes === 0 ? payload.length : lengthBytes === 2 ? 126 : 127);
        const view = new DataView(frame.buffer);
        if (lengthBytes === 2) view.setUint16(2, payload.length);
        if (lengthBytes === 8) view.setBigUint64(2, BigInt(payload.length));
        const mask = crypto.getRandomValues(new Uint8Array(4));
        frame.set(mask, 2 + lengthBytes);
        for (let i = 0; i < payload.length; i++) frame[6 + lengthBytes + i] = payload[i] ^ mask[i % 4];
        writes = writes.then(() => write(frame)).catch(() => { close(); });
      };
      transport = { send: message => send(encoder.encode(message), 1), close };
      // Start on the next task so Puppeteer installs its callbacks first.
      setTimeout(() => { void (async () => {
        let fragments: Uint8Array[] = [];
        let size = 0;
        let fragmented = false;
        while (!closed) {
          const head = await read(2);
          const final = (head[0] & 0x80) !== 0;
          const opcode = head[0] & 15;
          if ((head[0] & 0x70) || (head[1] & 0x80)) throw new Error('frame');
          let length = head[1] & 127;
          if (opcode >= 8 && (!final || length > 125)) throw new Error('frame');
          if (length === 126) { const bytes = await read(2); length = new DataView(bytes.buffer).getUint16(0); }
          else if (length === 127) {
            const bytes = await read(8);
            const wide = new DataView(bytes.buffer).getBigUint64(0);
            if (wide > 16_000_000n) throw new Error('frame');
            length = Number(wide);
          }
          if (length + size > 16_000_000) throw new Error('frame');
          const payload = await read(length);
          if (opcode === 8) { close(); return; }
          if (opcode === 9) { send(payload, 10); continue; }
          if (opcode === 10) continue;
          if ((opcode !== 0 && opcode !== 1) || (opcode === 0) !== fragmented) throw new Error('frame');
          fragments.push(payload); size += length; fragmented = !final;
          if (final) {
            const message = new Uint8Array(size);
            let offset = 0;
            for (const fragment of fragments) { message.set(fragment, offset); offset += fragment.length; }
            fragments = []; size = 0;
            transport?.onmessage?.(decoder.decode(message));
          }
        }
      })().catch(() => { close(); }); }, 0);
      return transport;
    })();
    return await Promise.race([setup, deadline]);
  } catch (error) {
    close();
    const message = error instanceof Error ? error.message : '';
    throw new Error(/^renderer_(transport_(closed|timeout|handshake|http_[0-9]{3})|timeout)$/.test(message) ? message : 'renderer_transport_tls_or_io');
  } finally { clearTimeout(timer); }
}

// Provider boundary. No app identity, database key, cookies or user credentials.
export async function renderPage(url: URL, options: {
  signal: AbortSignal;
  fetchPublic: (url: URL, signal: AbortSignal, policy: RendererResourcePolicy) => Promise<Resource>;
  validate: (value: string, navigation: boolean) => URL;
}): Promise<RenderedPage> {
  const account = Deno.env.get('CLOUDFLARE_ACCOUNT_ID');
  const token = Deno.env.get('CLOUDFLARE_BROWSER_RENDERING_TOKEN');
  if (!account || !/^[a-f0-9]{32}$/i.test(account) || !token) throw new Error('renderer_not_configured');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/devtools/browser`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let stage = 'session';
  let contentFailure: string | undefined;
  let transport: ConnectionTransport | undefined;
  let sessionId: string | undefined;
  let browser: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
  const stop = () => { transport?.close(); void browser?.close().catch(() => {}); };
  options.signal.addEventListener('abort', stop, { once: true });
  try {
    const response = await fetch(`${endpoint}?keep_alive=60000`, { method: 'POST', headers, redirect: 'error', signal: options.signal,
      body: JSON.stringify({ guardrails: { allowedDomains: [] } }) });
    if (!response.ok) throw await rendererRejection(response);
    const payload = await response.json();
    const session = payload.result ?? payload;
    if (typeof session.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(session.sessionId)) throw new Error('renderer_invalid_response');
    sessionId = session.sessionId;
    // Construct the trusted Cloudflare endpoint instead of trusting a returned URL.
    stage = 'transport';
    transport = await connectRenderer(`${endpoint.replace('https:', 'wss:')}/${sessionId}`, token, options.signal);
    stage = 'cdp_connect';
    browser = await puppeteer.connect({ transport, protocolTimeout: 10000 });
    if (options.signal.aborted) throw new Error('renderer_timeout');
    stage = 'page_setup';
    const page = await browser.newPage();
    await page.setBypassServiceWorker(true);
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.setDefaultTimeout(15000);
    let requests = 0; let active = 0; let bytes = 0;
    const waiting: (() => void)[] = [];
    const diagnostics = {
      scriptsRequested: 0, scriptsServed: 0, scriptsFinished: 0, scriptsFailed: 0,
      requiredAssetsBlocked: 0, jsErrors: 0, consoleErrors: 0,
      navigationStatus: 0, blockedReason: '', blockedCategory: '', jsReason: '',
    };
    const required = (type: string) => ['script', 'stylesheet'].includes(type);
    const recordBlock = (type: string, reason: string) => {
      if (!required(type)) return;
      diagnostics.requiredAssetsBlocked++;
      if (!diagnostics.blockedReason) {
        diagnostics.blockedReason = reason;
        diagnostics.blockedCategory = type === 'script' ? 'javascript' : 'css';
      }
    };
    page.on('pageerror', error => {
      diagnostics.jsErrors++;
      const name = error?.name;
      diagnostics.jsReason = ['SyntaxError', 'ReferenceError', 'TypeError'].includes(name ?? '') ? name! : 'execution';
    });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      diagnostics.consoleErrors++;
      // Inspect for fixed categories only: never log console text or URLs.
      const text = message.text();
      if (/mime type/i.test(text)) diagnostics.jsReason = 'script_mime';
      else if (/content security policy/i.test(text)) diagnostics.jsReason = 'script_policy';
    });
    page.on('requestfinished', request => {
      if (request.resourceType() === 'script') diagnostics.scriptsFinished++;
    });
    page.on('requestfailed', request => {
      if (request.resourceType() === 'script') diagnostics.scriptsFailed++;
    });
    page.on('request', request => { void (async () => {
      let counted = false;
      let phase = 'policy';
      const type = request.resourceType();
      const abort = async (reason: string) => { recordBlock(type, reason); await request.abort(); };
      try {
        if (type === 'script') diagnostics.scriptsRequested++;
        if (options.signal.aborted || ++requests > 100 || request.method() !== 'GET' ||
          !['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(type)) {
          await abort(options.signal.aborted ? 'aborted' : requests > 100 ? 'request_limit' : 'policy'); return;
        }
        const navigation = request.isNavigationRequest();
        if (navigation && request.frame() !== page.mainFrame()) { await abort('frame'); return; }
        const target = options.validate(request.url(), navigation || ['xhr', 'fetch'].includes(type));
        if (request.redirectChain().length > 4) { await abort('redirect_limit'); return; }
        // Preserve the six-fetch limit without permanently aborting SPA chunks
        // merely because other validated resources are currently downloading.
        if (active >= 6) await new Promise<void>(resolve => waiting.push(resolve));
        else active++;
        counted = true;
        if (options.signal.aborted) { await abort('aborted'); return; }
        phase = 'fetch';
        const category = type === 'script' ? 'javascript' : type === 'stylesheet' ? 'css'
          : type === 'document' ? 'document' : 'data';
        const resource = await options.fetchPublic(target, options.signal, {
          category,
          maxBytes: category === 'javascript' ? 5_000_000 : category === 'css' ? 1_000_000 : 2_000_000,
          consumeBytes: count => {
            if (!Number.isSafeInteger(count) || count < 0 || count > 12_000_000 - bytes) {
              throw new Error('renderer_total_byte_limit');
            }
            bytes += count;
          },
        });
        phase = 'redirect';
        if (resource.location) options.validate(new URL(resource.location, target).href, navigation);
        if (required(type) && resource.status >= 400) recordBlock(type, 'http');
        phase = 'fulfill';
        await request.respond({ status: resource.status,
          headers: { 'access-control-allow-origin': '*', 'content-type': resource.contentType ?? 'text/html', ...(resource.location ? { location: resource.location } : {}) },
          body: resource.html });
        if (type === 'script' && resource.status >= 200 && resource.status < 300) diagnostics.scriptsServed++;
      } catch (error) {
        // Keep only fixed reason categories, never raw network errors or URLs.
        const message = error instanceof Error ? error.message : '';
        const reason = /renderer_total_byte_limit/.test(message) ? 'total_byte_limit'
          : /too.large|size.limit|body.limit|byte.limit/i.test(message) ? 'size_limit'
          : /content.type|mime|not.html/i.test(message) ? 'content_type'
          : /private|reserved|unsafe|blocked|forbidden/i.test(message) ? 'network_policy'
          : /timeout|timed.out/i.test(message) ? 'timeout' : phase;
        recordBlock(type, reason);
        await request.abort().catch(() => {});
      } finally {
        if (counted) {
          const next = waiting.shift();
          if (next) next(); // Transfer this slot; active remains unchanged.
          else active--;
        }
      }
    })(); });
    stage = 'navigation';
    const navigation = await page.goto(url.href, { waitUntil: 'networkidle2', timeout: 20000 });
    diagnostics.navigationStatus = navigation?.status() ?? 0;
    if (!navigation || navigation.status() >= 400) {
      console.warn('Renderer navigation rejected', { status: diagnostics.navigationStatus });
      contentFailure = 'renderer_navigation_http_error';
      throw new Error(contentFailure);
    }
    options.validate(page.url(), true);
    stage = 'content_wait';
    try {
      await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length >= 200, { timeout: 8000 });
    } catch (error) {
      if (options.signal.aborted || !(error instanceof Error) || error.name !== 'TimeoutError') throw error;
      const dom = await page.evaluate(() => ({
        visibleCharacters: (document.body?.innerText ?? '').trim().length,
        bodyElements: document.body?.childElementCount ?? 0,
        readyState: document.readyState,
        moduleScripts: document.querySelectorAll('script[type="module"][src]').length,
      }));
      // Counters and fixed categories only; no HTML, page text, URLs or secrets.
      console.warn('Renderer content readiness failed', { ...diagnostics, ...dom, active, queued: waiting.length });
      contentFailure = diagnostics.requiredAssetsBlocked > 0 ? `renderer_required_asset_${diagnostics.blockedReason}`
        : diagnostics.scriptsFailed > 0 ? 'renderer_required_asset_browser_failed'
        : diagnostics.jsErrors > 0 || diagnostics.jsReason ? 'renderer_js_execution_failed'
        : active > 0 || waiting.length > 0 || dom.readyState !== 'complete' ? 'renderer_content_wait_timeout'
        : 'renderer_rendered_thin_content';
      throw new Error(contentFailure);
    }
    options.validate(page.url(), true);
    stage = 'extraction';
    const result = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map(a => a.href).slice(0, 250);
      // Remove noise only after scripts have rendered. innerText excludes CSS-hidden text.
      for (const node of document.querySelectorAll('script,style,nav,header,footer,aside,form,noscript,svg,iframe,[hidden],[aria-hidden="true"]')) node.remove();
      const main = document.querySelector<HTMLElement>('main,article,[role="main"]');
      const text = ((main?.innerText.trim().length ?? 0) >= 200 ? main!.innerText : document.body.innerText)
        .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 180000);
      return { title: document.title.slice(0, 500), text, links, url: location.href };
    });
    options.validate(result.url, true);
    if (result.text.length < 200) throw new Error('renderer_thin_content');
    return { ...result, links: result.links.filter(link => { try { options.validate(link, true); return true; } catch { return false; } }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (contentFailure && message === contentFailure) throw new Error(contentFailure);
    // Never return a CDP error, websocket URL, API response, or token verbatim.
    throw new Error(/^renderer_(not_configured|http_[0-9]{3}_[a-z_]+(?:_cf_[0-9]+)?|transport_(endpoint|closed|timeout|handshake|http_[0-9]{3}|tls_or_io)|invalid_response|timeout|thin_content)$/.test(message) ? message : `renderer_${stage}_${options.signal.aborted || (error instanceof Error && error.name === 'TimeoutError') ? 'timeout' : 'failed'}`);
  } finally {
    options.signal.removeEventListener('abort', stop);
    await browser?.close().catch(() => {});
    transport?.close();
    if (sessionId) {
      try { const r = await fetch(`${endpoint}/${sessionId}`, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(5000) }); await r.body?.cancel(); }
      catch { /* Cloudflare session TTL is the final cleanup boundary. */ }
    }
  }
}
