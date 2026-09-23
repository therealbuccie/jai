import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabaseClient';
import './apps.css';

type Application = { id: string; name: string; website_url: string | null; status: string };
type Knowledge = { app_id: string; ready_pages: number; failed_pages: number; pending_pages: number; last_synced_at: string | null };
type Capability = { key: string; kind: string };
const descriptions: Record<string, string> = {
  'knowledge.website.read': 'Read public website pages to learn about your application.',
  'customer.profile.read': 'Read customer profile details when a supported connection is available.',
  'customer.subscription.read': 'Read subscription details when a supported connection is available.',
  'billing.payment.read': 'Read payment information when a supported connection is available.',
  'diagnostics.read': 'Read diagnostics to help investigate support questions when connected.',
};
function website(value: string) {
  const u = new URL(value.trim());
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port || !u.hostname.includes('.') ||
    /^[0-9.]+$/.test(u.hostname) || u.hostname.includes(':') || /(?:^|\.)(localhost|local|internal|test|invalid|lan|home|onion)$/.test(u.hostname)) throw new Error('Enter a public HTTP or HTTPS website URL.');
  u.hash = ''; u.search = ''; return u.href;
}
export function AppsPage({ organizationId, isAdmin }: { organizationId: string; isAdmin: boolean }) {
  const [apps, setApps] = useState<Application[]>([]);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]);
  const [grants, setGrants] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [step, setStep] = useState<'list' | 'create' | 'consent' | 'install'>('list');
  const [selected, setSelected] = useState<Application | null>(null);
  const [name, setName] = useState(''); const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const requestId = useRef<string | null>(null); const working = useRef(false);
  async function load() {
    if (!supabase || !isAdmin) return;
    const [a, k, g, c] = await Promise.all([
      supabase.from('apps').select('id,name,website_url,status').eq('organization_id', organizationId).order('name'),
      supabase.rpc('application_knowledge_status'),
      supabase.from('app_capabilities').select('app_id').eq('capability_key', 'knowledge.website.read').eq('enabled', true),
      supabase.from('capabilities').select('key,kind').eq('recommended', true).eq('available', true).in('kind', ['read', 'diagnostic']).order('key'),
    ]);
    if (a.error || k.error || g.error || c.error) throw new Error('Unable to load applications. Please retry.');
    setApps(a.data ?? []); setKnowledge(k.data ?? []); setGrants((g.data ?? []).map(row => row.app_id)); setCapabilities(c.data ?? []);
  }
  useEffect(() => { void load().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [organizationId, isAdmin]);
  async function run(action: () => Promise<void>) {
    if (working.current) return; working.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to complete this action.'); }
    finally { working.current = false; setBusy(false); }
  }
  async function create() {
    if (!supabase) return;
    const canonical = website(url);
    requestId.current ??= crypto.randomUUID();
    const result = await supabase.rpc('create_application', { p_app_id: requestId.current, p_name: name.trim(), p_website_url: canonical });
    if (result.error || !result.data) throw new Error('Unable to create application. Check your admin access and retry.');
    const app = result.data as Application;
    setSelected(app); setUrl(app.website_url ?? canonical); setStep('consent');
    setApps(items => [...items.filter(a => a.id !== app.id), app]);
  }
  async function consent() {
    if (!supabase || !selected) return;
    const result = await supabase.functions.invoke('allow-jai', { body: { app_id: selected.id, website_url: website(url) } });
    if (result.error || !result.data?.app) throw new Error('Unable to save consent. Confirm the public website and your admin access, then retry.');
    setSelected(result.data.app); setStep('install');
    setNotice('Access granted. Website knowledge sync can continue in the background.');
    // Consent success remains successful even if refreshing the list fails.
    try { await load(); } catch { setNotice('Access granted. Refresh Apps later to see the latest knowledge status.'); }
  }
  const snippet = selected ? `import { JaiSupportWidget } from '@jai/widget';

export function Support() {
  return (
    <JaiSupportWidget
      appId={${JSON.stringify(selected.id)}}
      productName={${JSON.stringify(selected.name)}}
      supabaseUrl={${JSON.stringify(import.meta.env.VITE_SUPABASE_URL)}}
    />
  );
}` : '';
  if (!isAdmin) return <section className="apps-page"><h1>Apps</h1><p>Organization admin access is required.</p></section>;
  return <section className="apps-page" aria-labelledby="apps-heading">
    <header className="apps-header"><div><h1 id="apps-heading">Apps</h1><p>Connect your applications to JAI.</p></div>
      {step === 'list' ? <button disabled={busy || loading} onClick={() => { setName(''); setUrl(''); setSelected(null); requestId.current = null; setError(''); setNotice(''); setStep('create'); }}>+ Add application</button>
        : <button className="secondary" disabled={busy} onClick={() => { setStep('list'); setError(''); setNotice(''); }}>Back to Apps</button>}</header>
    {error && <p className="apps-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {step === 'list' && <><button className="secondary" disabled={busy} onClick={() => void run(load)}>Refresh status</button>
      {loading ? <p>Loading applications...</p> : !apps.length ? <p>No applications yet. Add your first application to get started.</p> :
        <div className="apps-grid">{apps.map(app => { const k = knowledge.find(item => item.app_id === app.id); return <article className="apps-card" key={app.id}>
          <h2>{app.name}</h2><p>{app.website_url || 'Website not configured'}</p><dl><dt>Application</dt><dd>{app.status}</dd>
            <dt>Website access</dt><dd>{grants.includes(app.id) ? 'Allowed' : 'Not granted'}</dd>
            <dt>Knowledge</dt><dd>{k ? `${k.ready_pages} ready ? ${k.failed_pages} failed ? ${k.pending_pages} pending` : 'Status unavailable'}</dd>
            {k?.last_synced_at && <><dt>Last synced</dt><dd>{new Date(k.last_synced_at).toLocaleString()}</dd></>}
            <dt>AI</dt><dd>Uses conversation routing; no per-app AI setting</dd></dl>
          <button onClick={() => { setSelected(app); setUrl(app.website_url ?? ''); setStep(grants.includes(app.id) ? 'install' : 'consent'); setError(''); setNotice(''); }}>Manage</button>
        </article>; })}</div>}</>}
    {step === 'create' && <form className="apps-card apps-form" onSubmit={event => { event.preventDefault(); void run(create); }}>
      <h2>Add application</h2><label>App name<input required maxLength={120} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
      <label>Website URL<input type="url" required maxLength={2000} placeholder="https://example.com" value={url} disabled={busy} onChange={e => setUrl(e.target.value)} /></label>
      <p>You will review access before JAI reads your website.</p><button disabled={busy || !name.trim()}>{busy ? 'Creating...' : 'Create application'}</button></form>}
    {step === 'consent' && selected && <form className="apps-card apps-form" onSubmit={event => { event.preventDefault(); void run(consent); }}>
      <h2>Allow JAI for {selected.name}</h2><label>Website URL<input type="url" required maxLength={2000} value={url} disabled={busy} onChange={e => setUrl(e.target.value)} /></label>
      <h3>Recommended Access</h3><p>Let JAI read information that helps answer support questions. This does not allow changes to your accounts, subscriptions or payments.</p>
      <ul>{capabilities.map(c => <li key={c.key}>{descriptions[c.key] ?? `Read access: ${c.key}`}</li>)}</ul>
      <p>Website learning starts in the background. Other data requires a supported connection, which is not set up here. Permissions can be changed individually later.</p>
      <button disabled={busy || !capabilities.length}>{busy ? 'Saving consent...' : 'Allow JAI'}</button></form>}
    {step === 'install' && selected && <div className="apps-card apps-form"><h2>Install JAI for {selected.name}</h2>
      <label>App ID<input readOnly value={selected.id} onFocus={e => e.target.select()} /></label>
      <h3>React installation</h3><ol><li>Add the JAI widget package to your React application. The current package is private; obtain it from your JAI administrator or use the supplied workspace package.</li>
        <li>Copy this component into your application and render it once in your shared layout. The package includes its widget styles.</li>
        <li>Open your website and send a test message. Check the JAI Inbox for the new conversation.</li></ol>
      <textarea aria-label="JAI widget installation snippet" readOnly rows={14} value={snippet} onFocus={e => e.target.select()} />
      <button onClick={() => void run(async () => { await navigator.clipboard.writeText(snippet); setNotice('Installation snippet copied.'); })}>Copy installation snippet</button>
      <p>Website knowledge can continue syncing in the background. Use Refresh status in Apps to check progress.</p>
      <button className="secondary" onClick={() => { setStep('consent'); setNotice(''); }}>Review website and access</button>
    </div>}
  </section>;
}
