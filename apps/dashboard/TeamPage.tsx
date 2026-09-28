import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import './apps.css';

type TeamAgent = { id: string; name: string; role: string };
export function TeamPage({ organizationId, isAdmin }: { organizationId: string; isAdmin: boolean }) {
  const [agents, setAgents] = useState<TeamAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setLoading(true); setError(''); setAgents([]);
    async function load() {
      try {
        if (!supabase || !organizationId) throw new Error();
        const { data, error } = await supabase.from('human_agents').select('id, name, role')
          .eq('organization_id', organizationId).order('name').abortSignal(controller.signal);
        if (error || !Array.isArray(data) || data.some(row => !row || typeof row.id !== 'string' ||
          typeof row.name !== 'string' || !['admin', 'agent'].includes(row.role))) throw new Error();
        if (active) setAgents(data);
      } catch {
        if (active) setError('Unable to load your team. Please reload the page to try again.');
      } finally {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [organizationId]);
  async function save(agent: TeamAgent) {
    if (!supabase || !isAdmin || saving) return;
    setError(''); setNotice('');
    const name = agent.name.trim();
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f-\u009f@]/.test(name)) {
      setError('Enter a display name of 1 to 120 characters, not an email address.'); return;
    }
    setSaving(agent.id);
    try {
      const { data, error } = await supabase.rpc('set_agent_display_name', { p_agent_id: agent.id, p_name: name });
      if (error || typeof data !== 'string') throw new Error();
      setAgents(items => items.map(item => item.id === agent.id ? { ...item, name: data } : item));
      setEditing(null);
      setNotice('Display name saved. Future joined messages will use this name.');
    } catch { setError('Unable to save the display name. Please try again.'); }
    finally { setSaving(null); }
  }
  return <section className="apps-page" aria-label="Team">
    <header className="apps-header"><h1>Team</h1></header>
    <p>Display names are shown to customers. Use a person or support-team name, not an authentication email.</p>
    {!isAdmin && <p role="status">You do not have permission to edit display names. Contact an organization admin.</p>}
    {loading && <p>Loading team...</p>}
    {error && <p className="apps-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!loading && !error && !agents.length && <p role="status">No agents are available for this organization. Contact an organization admin.</p>}
    {isAdmin && <Invitations organizationId={organizationId} />}
    <div className="apps-grid">{agents.map(agent => <form className="apps-card apps-form" key={agent.id} onSubmit={event => { event.preventDefault(); void save(agent); }}>
      <label>Customer-facing display name<input value={agent.name} maxLength={120} required disabled={!isAdmin || editing !== agent.id || saving !== null} onChange={event => {
        const name = event.target.value;
        setAgents(items => items.map(item => item.id === agent.id ? { ...item, name } : item));
        setNotice('');
      }} /></label>
      <p>{agent.role === 'admin' ? 'Administrator' : 'Agent'}</p>
      {isAdmin && (editing === agent.id ? <button type="submit" disabled={saving !== null}>{saving === agent.id ? 'Saving...' : 'Save display name'}</button> : <button type="button" disabled={saving !== null} onClick={() => setEditing(agent.id)}>Edit name</button>)}
    </form>)}</div>
  </section>;
}

type Invitation = { id: string; email: string; display_name: string; expires_at: string };
function Invitations({ organizationId }: { organizationId: string }) {
  const [apps, setApps] = useState<Array<{ id: string; name: string }>>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState(''); const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  async function refresh() {
    if (!supabase) throw new Error();
    const [a, i] = await Promise.all([
      supabase.from('apps').select('id, name').eq('organization_id', organizationId).order('name'),
      supabase.rpc('list_team_invitations'),
    ]);
    if (a.error || i.error || !Array.isArray(i.data)) throw new Error();
    setApps(a.data ?? []); setInvitations(i.data);
  }
  useEffect(() => { void refresh().catch(() => setError('Unable to load invitations.')).finally(() => setLoading(false)); }, [organizationId]);
  async function deliver(id: string) {
    if (!supabase) throw new Error();
    const { data, error } = await supabase.functions.invoke('team-invitations', { body: { invitation_id: id } });
    if (error || data?.sent !== true) throw new Error();
  }
  async function act(action: 'create' | 'resend' | 'revoke', id?: string) {
    if (!supabase || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'create') {
        const normalized = email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || !name.trim() || name.trim().length > 120 ||
          /[\u0000-\u001f\u007f-\u009f@]/.test(name) || !selected.length) throw new Error();
        const result = await supabase.rpc('create_team_invitation', { p_email: normalized, p_name: name.trim(), p_app_ids: selected });
        if (result.error || typeof result.data !== 'string') throw new Error();
        setEmail(''); setName(''); setSelected([]);
        await refresh(); await deliver(result.data); setNotice('Invitation email sent.');
      } else if (action === 'resend' && id) { await deliver(id); setNotice('Invitation email sent.'); }
      else if (id) { const { error } = await supabase.rpc('revoke_team_invitation', { p_invitation_id: id }); if (error) throw new Error(); setNotice('Invitation revoked.'); }
      await refresh();
    } catch { setError('Unable to complete this request. Check pending invitations before retrying. Email failures can be retried after one minute.'); }
    finally { setBusy(false); }
  }
  return <section className="apps-card">
    <h2>Invite agent</h2>
    {loading ? <p>Loading invitations...</p> : <>
      <form className="apps-form" onSubmit={event => { event.preventDefault(); void act('create'); }}>
        <label>Email<input type="email" maxLength={254} required disabled={busy} value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Customer-facing display name<input required maxLength={120} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
        <fieldset disabled={busy}><legend>Apps this agent may support</legend>{apps.map(app => <label key={app.id}>
          <input type="checkbox" checked={selected.includes(app.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, app.id] : ids.filter(id => id !== app.id))} />{app.name}
        </label>)}</fieldset>
        <button disabled={busy || !selected.length}>Send invite</button>
      </form>
      <h3>Pending invitations</h3>
      {!invitations.length && <p>No pending invitations.</p>}
      {invitations.map(invite => <div key={invite.id}><p>{invite.display_name} ? {invite.email} ? Expires {new Date(invite.expires_at).toLocaleDateString()}</p>
        <button disabled={busy} onClick={() => void act('resend', invite.id)}>Resend</button>{' '}
        <button disabled={busy} onClick={() => void act('revoke', invite.id)}>Revoke</button>
      </div>)}
    </>}{error && <p role="alert" className="apps-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
