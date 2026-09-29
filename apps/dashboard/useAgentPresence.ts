import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabaseClient';
export type AgentPresence = 'online' | 'away' | 'offline';
export function useAgentPresence(agentId: string | undefined) {
  const [presence, setPresence] = useState<AgentPresence>('offline');
  const stopRef = useRef<(session?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    setPresence('offline');
    if (!agentId || !supabase) return;
    const client = supabase;
    const tab = crypto.randomUUID();
    let stopped = false, busy = false, lastActivityReport = 0, pendingActivity = false;
    const controller = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    async function beat() {
      if (stopped || busy) return;
      busy = true;
      const activity = pendingActivity && document.visibilityState === 'visible';
      pendingActivity = false;
      if (activity) lastActivityReport = Date.now();
      try {
        const { data, error } = await client.rpc(activity ? 'activity_agent_presence' : 'heartbeat_agent_presence', { p_tab_id: tab })
          .abortSignal(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
        if (!stopped && !error && ['online', 'away', 'offline'].includes(data)) {
          setPresence(data as AgentPresence);
          clearTimeout(expiry);
          // Never keep showing a fresh status indefinitely after losing connectivity.
          expiry = setTimeout(() => setPresence('offline'), 120000);
        }
      } catch { /* Last server result expires locally; next heartbeat retries. */ }
      finally { busy = false; }
    }
    function activity(event: Event) {
      if (!event.isTrusted || stopped || document.visibilityState !== 'visible') return;
      pendingActivity = true;
      if (Date.now() - lastActivityReport >= 30000) void beat();
    }
    function resume() { if (document.visibilityState === 'visible') void beat(); }
    const events = ['keydown', 'pointerdown', 'pointermove', 'scroll'];
    events.forEach(name => window.addEventListener(name, activity, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    const interval = setInterval(() => void beat(), 30000);
    const stop = async (session = false) => {
      if (stopped) return;
      stopped = true; controller.abort(); clearInterval(interval); clearTimeout(expiry);
      events.forEach(name => window.removeEventListener(name, activity, true));
      document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume);
      try { await client.rpc('end_agent_presence', { p_tab_id: session ? null : tab }).abortSignal(AbortSignal.timeout(1500)); }
      catch { /* Expiry is authoritative if best-effort cleanup fails. */ }
    };
    stopRef.current = stop;
    void beat();
    return () => { void stop(); };
  }, [agentId]);
  return { presence, stopPresence: () => stopRef.current(true) };
}
