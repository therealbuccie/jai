// Server-only. Import from trusted backend code, never from a browser entrypoint.
import {
  isJaiConnectReadCapability, isJaiConnectReadResponse,
  JAI_CONNECT_READ_MAX_RESPONSE_BYTES,
  type JaiConnectReadCapability, type JaiConnectReadResponse,
} from '../../../packages/sdk/src/read-v1.ts';
import { signReadRequest } from './jai-connect-read-signing.ts';

// The same native pinned TCP + hostname-verified TLS path used by Edge ingestion.
interface Connection {
  read(bytes: Uint8Array): Promise<number | null>;
  write(bytes: Uint8Array): Promise<number>;
  close(): void;
}
declare const Deno: {
  env: { get(name: string): string | undefined };
  resolveDns(host: string, type: 'A'): Promise<string[]>;
  connect(options: { hostname: string; port: number }): Promise<Connection>;
  startTls(conn: Connection, options: { hostname: string; alpnProtocols: string[] }):
    Promise<Connection & { handshake(): Promise<unknown> }>;
};

export interface JaiConnectReadInput {
  app_id: string;
  customer_id: string;
  capability: JaiConnectReadCapability;
}
export class JaiConnectReadError extends Error {
  constructor() { super('JAI Connect read unavailable'); this.name = 'JaiConnectReadError'; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const MAX_BODY = JAI_CONNECT_READ_MAX_RESPONSE_BYTES;
const MAX_WIRE = MAX_BODY + 32768;
function deny(): never { throw new JaiConnectReadError(); }
// Date.parse normalizes some impossible dates (for example February 30).
function validCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 &&
    Number(value.slice(17, 19)) < 60;
}
function publicIPv4(ip: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
  const n = ip.split('.').map(Number);
  if (n.some(x => x > 255)) return false;
  const [a, b, c] = n;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || ip === '168.63.129.16');
}
function endpoint(value: string): URL {
  const url = new URL(value);
  // Fail closed on normalization: the signer and receiver must agree on aud.
  if (value.length > 2048 || url.href !== value || url.protocol !== 'https:' ||
    url.port || url.username || url.password || url.search || url.hash ||
    !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|onion)$/.test(url.hostname)) deny();
  return url;
}
function parseResponse(wire: Uint8Array): unknown {
  let offset = 0;
  function line(): string {
    const start = offset;
    while (offset + 1 < wire.length) {
      if (wire[offset] === 13 && wire[offset + 1] === 10) {
        const end = offset; offset += 2;
        if (end - start > 8192) deny();
        return new TextDecoder('utf-8', { fatal: true }).decode(wire.subarray(start, end));
      }
      offset++;
    }
    return deny();
  }
  if (!/^HTTP\/1\.[01] 200(?: |$)/.test(line())) deny(); // Includes all redirects.
  const headers = new Map<string, string>();
  for (;;) {
    const entry = line();
    if (offset > 16384) deny();
    if (!entry) break;
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(entry);
    if (!match) deny();
    const key = match[1].toLowerCase();
    if (headers.has(key)) deny();
    headers.set(key, match[2].trim());
  }
  if (headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
    (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity')) deny();
  const parts: Uint8Array[] = [];
  let total = 0;
  function take(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || total + size > MAX_BODY || offset + size > wire.length) deny();
    parts.push(wire.subarray(offset, offset + size)); total += size; offset += size;
  }
  const transfer = headers.get('transfer-encoding');
  const length = headers.get('content-length');
  if (transfer !== undefined) {
    if (transfer.toLowerCase() !== 'chunked' || length !== undefined) deny();
    for (;;) {
      const chunk = line();
      if (!/^[0-9a-f]+$/i.test(chunk)) deny();
      const size = Number.parseInt(chunk, 16);
      if (size === 0) { if (line() !== '') deny(); break; }
      take(size);
      if (line() !== '') deny();
    }
  } else if (length !== undefined) {
    if (!/^\d+$/.test(length)) deny();
    take(Number(length));
  } else take(wire.length - offset);
  if (offset !== wire.length) deny();
  const body = new Uint8Array(total);
  let position = 0;
  for (const part of parts) { body.set(part, position); position += part.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}

async function post(url: URL, body: string, authorization: string, signal: AbortSignal): Promise<unknown> {
  let conn: Connection | undefined;
  const close = () => { try { conn?.close(); } catch { /* Already closed. */ } };
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    // IPv4 only deliberately: no IPv6, mapped address, or DNS fallback path.
    const addresses = await Deno.resolveDns(url.hostname, 'A');
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(ip => !publicIPv4(ip))) deny();
    conn = await Deno.connect({ hostname: addresses[0], port: 443 });
    signal.throwIfAborted();
    const tls = await Deno.startTls(conn, { hostname: url.hostname, alpnProtocols: ['http/1.1'] });
    conn = tls;
    signal.throwIfAborted();
    await tls.handshake();
    signal.throwIfAborted();
    const bytes = encoder.encode(`POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${authorization}\r\nContent-Type: application/json\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nContent-Length: ${encoder.encode(body).length}\r\nConnection: close\r\n\r\n${body}`);
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted();
      const written = await conn.write(bytes.subarray(offset));
      if (written <= 0) deny();
      offset += written;
    }
    const wire = new Uint8Array(MAX_WIRE + 1);
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const count = await conn.read(wire.subarray(size));
      if (count === null) break;
      size += count;
      if (size > MAX_WIRE) deny();
    }
    return parseResponse(wire.subarray(0, size));
  } finally { close(); signal.removeEventListener('abort', close); }
}

/** Trusted server callers only. Returns validated data, never identity or transport metadata.
 * Requires migration 020 and SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * JAI_CONNECT_SIGNING_KEYS. No retries, browser handler, or runtime integration.
 */
export async function readJaiConnect(input: JaiConnectReadInput): Promise<JaiConnectReadResponse['data']> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new JaiConnectReadError()); }, 10_000);
  });
  const work = async () => {
    if (!input || Object.keys(input).sort().join(',') !== 'app_id,capability,customer_id' || typeof input.app_id !== 'string' || !UUID.test(input.app_id) ||
      typeof input.customer_id !== 'string' || !UUID.test(input.customer_id) ||
      !isJaiConnectReadCapability(input.capability)) deny();
    // Snapshot trusted values before any await.
    const { app_id, customer_id, capability } = input;
    const base = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const signingKeys = Deno.env.get('JAI_CONNECT_SIGNING_KEYS');
    if (!base || !serviceKey || !signingKeys) deny();
    const project = new URL(base);
    if (project.protocol !== 'https:' || project.username || project.password ||
      project.search || project.hash || project.pathname !== '/') deny();
    async function rpc(name: string, args: Record<string, string>): Promise<unknown> {
      controller.signal.throwIfAborted();
      const response = await fetch(new URL(`/rest/v1/rpc/${name}`, project), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); deny(); }
      const reader = response.body.getReader();
      const bytes = new Uint8Array(4096);
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (size + value.length > bytes.length) deny();
          bytes.set(value, size); size += value.length;
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
      } finally { await reader.cancel(); reader.releaseLock(); }
    }
    const destination = await rpc('resolve_jai_connect_read_endpoint', { p_app_id: app_id, p_capability_key: capability });
    if (typeof destination !== 'string') deny();
    const url = endpoint(destination);
    const subject = await rpc('resolve_jai_connect_read_subject', { p_app_id: app_id, p_customer_id: customer_id });
    if (typeof subject !== 'string') deny();
    const request = { version: 1 as const, request_id: crypto.randomUUID(), app_id, capability,
      customer: { external_subject: subject } };
    const signed = await signReadRequest(request, destination,
      new URL('/functions/v1/jai-connect-jwks', project).href, signingKeys);
    controller.signal.throwIfAborted();
    const response = await post(url, signed.body, signed.authorization, controller.signal);
    if (!isJaiConnectReadResponse(response) || response.request_id !== request.request_id ||
      response.capability !== capability || !validCalendarDate(response.observed_at)) deny();
    return response.data;
  };
  try { return await Promise.race([work(), timeout]); }
  catch { throw new JaiConnectReadError(); } // Never propagate secrets, subjects, headers or raw errors.
  finally { clearTimeout(timer); controller.abort(); }
}
