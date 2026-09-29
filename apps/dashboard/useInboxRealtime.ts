import { useEffect, useRef } from 'react';
import { supabase } from './supabaseClient';

export function useInboxRealtime(userId: string, appIds: string[], conversationIds: string[], reconcile: (current: () => boolean) => Promise<void>) {
  const callback = useRef(reconcile); callback.current = reconcile;
  const apps = [...new Set(appIds)].sort().join(',');
  const conversations = [...new Set(conversationIds)].sort().join(',');
  // Shared across subscription rebuilds: never overlap authoritative refreshes.
  const running = useRef(false);
  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let active = true, dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function flush() {
      timer = undefined;
      if (!active) return;
      if (running.current) { timer = setTimeout(() => void flush(), 150); return; }
      if (!dirty) return;
      dirty = false; running.current = true;
      try { await callback.current(() => active); } catch { /* Preserve rendered state; fallback retries. */ }
      finally { running.current = false; if (active && dirty) schedule(); }
    }
    function schedule() { if (!active) return; dirty = true; if (!timer) timer = setTimeout(() => void flush(), 150); }
    const channel = client.channel(`inbox:${userId}:${crypto.randomUUID()}`);
    const chunks = (value: string) => {
      const ids = value ? value.split(',') : []; const result: string[][] = [];
      for (let i = 0; i < ids.length; i += 50) result.push(ids.slice(i, i + 50));
      return result;
    };
    for (const ids of chunks(apps)) for (const event of ['INSERT', 'UPDATE'] as const) {
      channel.on('postgres_changes', { event, schema: 'public', table: 'conversations', filter: `app_id=in.(${ids.join(',')})` }, schedule);
    }
    for (const ids of chunks(conversations)) for (const event of ['INSERT', 'UPDATE'] as const) {
      channel.on('postgres_changes', { event, schema: 'public', table: 'messages', filter: `conversation_id=in.(${ids.join(',')})` }, schedule);
    }
    channel.subscribe(status => { if (status === 'SUBSCRIBED') schedule(); });
    const visible = () => { if (document.visibilityState === 'visible') schedule(); };
    window.addEventListener('online', schedule); document.addEventListener('visibilitychange', visible);
    const fallback = setInterval(visible, 60000);
    schedule();
    return () => {
      active = false; clearTimeout(timer); clearInterval(fallback);
      window.removeEventListener('online', schedule); document.removeEventListener('visibilitychange', visible);
      void client.removeChannel(channel);
    };
  }, [userId, apps, conversations]);
}
