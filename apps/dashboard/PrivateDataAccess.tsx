import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabaseClient';

const readCapabilities = [
  ['customer.profile.read', 'Customer profile'],
  ['customer.subscription.read', 'Subscription'],
  ['billing.payment.read', 'Payment status'],
  ['diagnostics.read', 'Diagnostics'],
] as const;
type ReadCapability = typeof readCapabilities[number][0];
type Endpoint = { endpoint_url: string; enabled: boolean };
type Grant = { capability_key: string; enabled: boolean };
type CatalogEntry = { key: string; available: boolean; kind: string };

function connectorUrl(value: string): string {
  const message = 'Enter a public HTTPS endpoint URL without credentials, a port, query parameters, or a fragment.';
  try {
    const raw = value.trim();
    // Match migration 019 before canonicalizing; never silently remove URL parts.
    if (!/^https:\/\/([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}(\/[A-Za-z0-9._~/%-]*)?$/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      /(?:^|\.)(localhost|local|internal|test|invalid|lan|home|onion)$/.test(url.hostname) ||
      url.hostname.split('.').some(label => label.startsWith('-') || label.endsWith('-') || label.length > 63) ||
      /%(?![0-9a-f]{2})/i.test(raw) || url.href.length < 12 || url.href.length > 2048) throw new Error();
    return url.href;
  } catch { throw new Error(message); }
}

export function PrivateDataAccess({ appId, appStatus, isAdmin }: {
  appId: string; appStatus: string; isAdmin: boolean;
}) {
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [url, setUrl] = useState('');
  const [grants, setGrants] = useState<Grant[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const working = useRef(false);
  const generation = useRef(0);

  async function load(current: number, resetUrl = false) {
    if (!supabase || !isAdmin) throw new Error('Organization admin access is required.');
    const [configuration, permissions, definitions] = await Promise.all([
      supabase.from('jai_connect_read_endpoints').select('endpoint_url,enabled').eq('app_id', appId).maybeSingle(),
      supabase.from('app_capabilities').select('capability_key,enabled').eq('app_id', appId)
        .in('capability_key', readCapabilities.map(([key]) => key)),
      supabase.from('capabilities').select('key,available,kind').in('key', readCapabilities.map(([key]) => key)),
    ]);
    if (configuration.error || permissions.error || definitions.error) {
      throw new Error('Unable to load Private Data Access. Check your admin access and retry.');
    }
    if (generation.current !== current) return;
    setEndpoint(configuration.data);
    if (resetUrl) setUrl(configuration.data?.endpoint_url ?? '');
    setGrants(permissions.data ?? []);
    setCatalog(definitions.data ?? []);
    setReady(true);
  }
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setReady(false); setEndpoint(null); setUrl(''); setGrants([]); setCatalog([]);
    void load(current, true).catch(() => {
      if (generation.current === current) setError('Unable to load Private Data Access. Check your admin access and retry.');
    }).finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current++; };
  }, [appId, isAdmin]);

  async function run(action: () => Promise<void>, message: string, resetUrl = false) {
    if (working.current || !isAdmin) return;
    const current = generation.current;
    working.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await action();
      await load(current, resetUrl);
      if (generation.current === current) setNotice(message);
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : 'Unable to update Private Data Access. Please retry.');
    } finally {
      working.current = false;
      if (generation.current === current) setBusy(false);
    }
  }
  async function save() {
    const endpoint_url = connectorUrl(url);
    if (!supabase || !ready) throw new Error('Reload Private Data Access before saving.');
    // Separate insert/update respects the existing column grants and preserves enabled.
    const result = endpoint
      ? await supabase.from('jai_connect_read_endpoints').update({ endpoint_url }).eq('app_id', appId).select('endpoint_url,enabled').single()
      : await supabase.from('jai_connect_read_endpoints').insert({ app_id: appId, endpoint_url, enabled: false }).select('endpoint_url,enabled').single();
    if (result.error || !result.data) throw new Error('Unable to save the endpoint. Check your admin access and refresh before retrying.');
  }
  async function toggleEndpoint() {
    if (!supabase || !endpoint || !ready) throw new Error('Save an endpoint first.');
    const result = await supabase.from('jai_connect_read_endpoints').update({ enabled: !endpoint.enabled })
      .eq('app_id', appId).select('endpoint_url,enabled').single();
    if (result.error || !result.data) throw new Error('Unable to change connector status. Check your admin access and retry.');
  }
  async function toggleCapability(key: ReadCapability) {
    if (!supabase || !ready) throw new Error('Reload Private Data Access before changing permissions.');
    const grant = grants.find(item => item.capability_key === key);
    const enabled = !grant?.enabled;
    const result = grant
      ? await supabase.from('app_capabilities').update({ enabled }).eq('app_id', appId).eq('capability_key', key).select('capability_key,enabled').single()
      : await supabase.from('app_capabilities').insert({ app_id: appId, capability_key: key, enabled }).select('capability_key,enabled').single();
    if (result.error || !result.data) throw new Error('Unable to change this permission. Check your admin access and retry.');
  }
  if (!isAdmin) return null;
  return <section className="apps-form" aria-labelledby="private-data-heading">
    <h3 id="private-data-heading">Private Data Access</h3>
    <p>Let JAI securely read permitted account information from your application's backend.</p>
    <p role="status">Connector: {loading ? 'Checking setup...' : !ready ? 'Status unavailable' : !endpoint ? 'Not configured' : endpoint.enabled ? 'Connected/Enabled' : 'Disabled'}</p>
    {error && <p className="apps-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <form className="apps-form" noValidate onSubmit={event => { event.preventDefault(); void run(save, 'Endpoint saved. No permissions were changed.', true); }}>
      <label>JAI Connect endpoint<input type="url" required maxLength={2048} placeholder="https://example.com/jai-connect/read"
        value={url} disabled={busy || loading || !ready} onChange={event => setUrl(event.target.value)} /></label>
      <button disabled={busy || loading || !ready}>{endpoint ? 'Update endpoint' : 'Save endpoint'}</button>
    </form>
    <button className="secondary" disabled={busy || loading || !ready || !endpoint}
      onClick={() => void run(toggleEndpoint, endpoint?.enabled ? 'Connector disabled.' : 'Connector enabled. Only allowed capabilities can be read.')}>
      {endpoint?.enabled ? 'Disable connector' : 'Enable connector'}
    </button>
    <p>Saving an endpoint does not grant permissions. Enabled reflects configuration; it does not confirm backend connectivity.</p>
    <ul>{readCapabilities.map(([key, label]) => {
      const granted = grants.some(grant => grant.capability_key === key && grant.enabled);
      const available = catalog.some(entry => entry.key === key && entry.available && ['read', 'diagnostic'].includes(entry.kind));
      const allowed = granted && available && appStatus === 'active';
      return <li key={key}>{label} — {loading || !ready ? 'Status unavailable' : allowed ? 'Allowed' : 'Not allowed'}{' '}
        <button type="button" className="secondary" disabled={busy || loading || !ready || (!granted && (!available || appStatus !== 'active'))}
          aria-label={`${granted ? 'Revoke' : 'Allow'} ${label.toLowerCase()} access`}
          onClick={() => void run(() => toggleCapability(key), `${label} permission updated.`)}>{granted ? 'Revoke' : 'Allow'}</button>
      </li>;
    })}</ul>
    <button className="secondary" disabled={busy || loading} onClick={() => void run(async () => {}, 'Private Data Access refreshed.', true)}>Refresh Private Data Access</button>
  </section>;
}