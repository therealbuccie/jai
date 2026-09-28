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
