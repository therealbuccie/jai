import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (!supabase) { setError('Sign in is unavailable.'); setLoading(false); return; }
    let active = true;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (active) { setUser(data.session?.user ?? null); setLoading(false); if (error) setError('Unable to load your session.'); }
    }).catch(() => { if (active) { setError('Unable to load your session.'); setLoading(false); } });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { if (active) { setUser(session?.user ?? null); setLoading(false); } });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  async function submit() {
    if (!supabase || busy) return;
    setBusy(true); setError('');
    try {
      if (!user) {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw new Error(); setPassword('');
      } else {
        // Optional password setup uses the existing authenticated Supabase session.
        if (password) { const { error } = await supabase.auth.updateUser({ password }); if (error) throw new Error(); }
        const { error } = await supabase.rpc('accept_team_invitation', { p_invitation_id: invitationId });
        if (error) throw new Error();
        const url = new URL(window.location.href); url.searchParams.delete('invitation'); url.hash = 'inbox';
        window.location.replace(url.href);
      }
    } catch { setError('Unable to continue. Use the invited account and a valid, unexpired invitation.'); }
    finally { setBusy(false); }
  }
  return <main className="auth-screen"><form className="auth-card" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h1>Join your support team</h1>
    {loading ? <p>Checking your session...</p> : <>
      <p>{user ? 'Accept using your signed-in account. You may set a password for future sign-ins.' : 'Sign in with the invited account, or open the authentication link from your invitation email.'}</p>
      {!user && <label>Email<input type="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>}
      <label>{user ? 'Set password (optional)' : 'Password'}<input type="password" minLength={8} required={!user} autoComplete={user ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={busy}>{busy ? 'Please wait...' : user ? 'Accept invitation' : 'Sign in'}</button>
      {user && <button type="button" disabled={busy} onClick={() => { setPassword(''); void supabase?.auth.signOut(); }}>Use another account</button>}
    </>}{error && <p role="alert">{error}</p>}
  </form></main>;
}
