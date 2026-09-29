import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
type Notice = { type: string; id: string; conversation_id: string; app_name: string; title: string; body: string; created_at: string };
export function useAgentNotifications(agentId: string, conversations: Array<{ id: string; status: string; handler: string; assigned_agent_id: string | null }>) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [waiting, setWaiting] = useState<Notice[]>([]);
  useEffect(() => {
    setWaiting(items => items.filter(item => {
      const conversation = conversations.find(c => c.id === item.conversation_id);
      return !conversation || (conversation.status === 'open' && conversation.handler === 'human_queue' && conversation.assigned_agent_id === null);
    }));
  }, [conversations]);
  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let active = true, live = false, busy = false;
    const pending = new Set<string>(); const seen = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dismiss: ReturnType<typeof setTimeout> | undefined;
    let audio: AudioContext | undefined;
    function unlock() {
      audio ??= new AudioContext(); void audio.resume().catch(() => {});
    }
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    async function sound(id: string) {
      if (!navigator.locks || !audio || audio.state !== 'running') return;
      await navigator.locks.request(`jai-notice:${agentId}`, () => {
        if (!active || document.visibilityState !== 'visible') return;
        try {
          const key = `jai-sounded:${agentId}`;
          const ids: string[] = JSON.parse(localStorage.getItem(key) || '[]');
          if (ids.includes(id)) return;
          localStorage.setItem(key, JSON.stringify([...ids.slice(-99), id]));
          const oscillator = audio!.createOscillator(), gain = audio!.createGain();
          oscillator.frequency.value = 660; gain.gain.setValueAtTime(0.035, audio!.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, audio!.currentTime + 0.15);
          oscillator.connect(gain); gain.connect(audio!.destination); oscillator.start(); oscillator.stop(audio!.currentTime + 0.15);
        } catch { /* Sound is optional when storage/audio is unavailable. */ }
      });
    }
    async function refresh() {
      timer = undefined;
      if (!active || busy) return;
      busy = true;
      // Keep the shared queue intact until an individual event is handled.
      const liveIds = [...pending].slice(0, 100);
      try {
        let query = client.from('agent_notifications')
          .select('id, type, conversation_id, app_name, title, body, created_at, read_at')
          .eq('recipient_agent_id', agentId);
        // Target pending IDs so a busy inbox cannot push them outside the latest 100.
        if (liveIds.length) query = query.in('id', liveIds);
        const { data, error } = await query.order('created_at', { ascending: false }).limit(100);
        if (!active || error || !data) return;
        // An empty snapshot is a silent bootstrap/reconnect history fetch. Never
        // mark its rows seen: they may have arrived live while this fetch ran.
        if (!liveIds.length) return;
        const snapshot = new Set(liveIds);
        for (const row of data) {
          if (!snapshot.has(row.id)) continue;
          if (seen.has(row.id) || row.read_at) {
            // Already handled/read records are deliberately non-live.
            seen.add(row.id); pending.delete(row.id);
          }
        }
        const fresh = data.find(row => snapshot.has(row.id) && pending.has(row.id) && !seen.has(row.id) && !row.read_at);
        if (fresh && document.visibilityState === 'visible') {
          if (fresh.type === 'queue_entered') {
            const { data: conversation, error: stateError } = await client.from('conversations')
              .select('status, handler, assigned_agent_id').eq('id', fresh.conversation_id).maybeSingle();
            if (!active || stateError) return;
            if (!conversation || conversation.status !== 'open' || conversation.handler !== 'human_queue' || conversation.assigned_agent_id !== null) {
              seen.add(fresh.id); pending.delete(fresh.id); return;
            }
            setWaiting(items => items.some(item => item.id === fresh.id) ? items : [...items, fresh]);
          } else {
            setNotice(fresh);
            clearTimeout(dismiss); dismiss = setTimeout(() => setNotice(null), 12000);
          }
          seen.add(fresh.id); pending.delete(fresh.id);
          void sound(fresh.id);
        }
      } finally {
        busy = false;
        // Failed/invisible/unreturned events remain queued; avoid a tight retry loop.
        if (active && pending.size) schedule(5000);
      }
    }
    function schedule(delay = 150) { if (!timer) timer = setTimeout(() => { void refresh().catch(() => {}); }, delay); }
    const channel = client.channel(`agent-notices:${agentId}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'agent_notifications', filter: `recipient_agent_id=eq.${agentId}` }, payload => {
        if (active && live && typeof payload.new.id === 'string' && !seen.has(payload.new.id)) { pending.add(payload.new.id); schedule(); }
      }).subscribe(status => {
        if (!active) return;
        live = status === 'SUBSCRIBED';
        if (live) schedule();
      });
    setNotice(null); setWaiting([]);
    return () => {
      active = false; clearTimeout(timer); clearTimeout(dismiss); void client.removeChannel(channel);
      window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); void audio?.close();
    };
  }, [agentId]);
  const open = (notice: Notice) => {
    window.location.hash = `inbox?conversation=${encodeURIComponent(notice.conversation_id)}`;
    void supabase?.from('agent_notifications').update({ read_at: new Date().toISOString() }).eq('id', notice.id).then(() => {});
    if (notice.type !== 'queue_entered') setNotice(null);
  };
  return { notices: [...waiting, ...(notice ? [notice] : [])], open, dismiss: (id: string) => {
    setWaiting(items => items.filter(item => item.id !== id));
    setNotice(item => item?.id === id ? null : item);
  } };
}
