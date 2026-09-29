import { useAgentNotifications } from './useAgentNotifications';
import { useInboxRealtime } from './useInboxRealtime';
import { useAgentPresence, type AgentPresence } from './useAgentPresence';
import { AcceptInvitation } from './AcceptInvitation';
import { useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, supabaseConfigError } from './supabaseClient';
import { AppsPage } from './AppsPage';
import { TeamPage } from './TeamPage';

type Agent = { id: string; auth_user_id: string; organization_id: string; name: string; email: string; role: 'admin' | 'agent'; status: 'online' | 'offline' | 'away' };
type AuthorizedApp = { id: string; organization_id: string; name: string; slug: string; status: 'active' | 'inactive' };
type Organization = { id: string; name: string };
type AgentContext = { user: User; agent: Agent; organization: Organization; apps: AuthorizedApp[]; appAccess: Array<{ app_id: string }> };
type Message = { id: string; conversation_id: string; sender_type: 'customer' | 'automation' | 'human_agent' | 'system'; sender_id: string | null; message_type: 'text' | 'attachment' | 'system' | 'internal_note'; status: 'sent' | 'delivered' | 'read'; content: string | null; created_at: string };
type Customer = { id: string; display_name: string | null; email: string | null; phone: string | null };
type App = { id: string; name: string; slug: string; status: 'active' | 'inactive' };
type Conversation = { id: string; app_id: string; customer_id: string; status: 'open' | 'pending' | 'resolved'; handler: 'automation' | 'human_queue' | 'human_agent'; assigned_agent_id: string | null; created_at: string; updated_at: string; customer: Customer | null; app: App | null; latestMessage: Message | null; waitingSince?: string; assignedAgent?: { name: string } | null };
type ConversationRow = Omit<Conversation, 'customer' | 'app' | 'latestMessage' | 'assignedAgent'> & { assigned_agent: { name: string }[] | { name: string } | null; customers: Customer[] | Customer | null; apps: App[] | App | null };
type CustomerInboxGroup = { customerId: string; customer: Customer | null; openConversations: Conversation[]; latestConversation: Conversation };
type ConversationFeedback = { id: string; conversation_id: string; rating: number; review_text: string | null; submitted_at: string };

const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const formatDate = (value: string) => new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const initialsFor = (name: string | null | undefined) => (name || 'Customer').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'C';
const toneFor = (id: string) => ['sage', 'sand', 'rose', 'blue', 'lilac', 'peach', 'mint'][Number.parseInt(id.replace(/-/g, '').slice(0, 2), 16) % 7];
const relationOne = <T,>(value: T[] | T | null | undefined): T | null => Array.isArray(value) ? value[0] ?? null : value ?? null;

const isWaiting = (conversation: Conversation) => conversation.handler === 'human_queue' && conversation.status !== 'resolved';
const inInbox = (conversation: Conversation) => conversation.status === 'open' || isWaiting(conversation);
const waitingAt = (conversation: Conversation) => Date.parse(conversation.waitingSince || conversation.updated_at);
const inboxPriority = (left: Conversation, right: Conversation) => {
  if (isWaiting(left) !== isWaiting(right)) return isWaiting(left) ? -1 : 1;
  if (isWaiting(left)) return waitingAt(left) - waitingAt(right) || left.id.localeCompare(right.id);
  return Date.parse(right.latestMessage?.created_at || right.updated_at) - Date.parse(left.latestMessage?.created_at || left.updated_at);
};
const conversationLabel = (conversation: Conversation, agent: Agent) => conversation.status === 'resolved' ? 'Closed'
  : isWaiting(conversation) ? 'Waiting for agent'
  : conversation.handler === 'human_agent' ? (conversation.assigned_agent_id === agent.id ? 'Assigned to you' : conversation.assignedAgent?.name?.trim() ? `Assigned to ${conversation.assignedAgent.name}` : 'Assigned to agent')
  : conversation.status;
const waitingTime = (conversation: Conversation, now: number) => {
  const minutes = Math.max(0, Math.floor((now - waitingAt(conversation)) / 60000));
  return minutes < 1 ? 'less than a minute' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
};

async function loadConversations(): Promise<Conversation[]> {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  const { data, error } = await supabase.from('conversations')
    .select('id, app_id, customer_id, status, handler, assigned_agent_id, created_at, updated_at, customers (id, display_name, email, phone), apps (id, name, slug, status), assigned_agent:human_agents!conversations_assigned_agent_id_fkey (name)')
    .order('updated_at', { ascending: false });
  if (error) throw new Error('Unable to load authorized conversations.');
  const rows = (data ?? []) as unknown as ConversationRow[];
  if (!rows.length) return [];
  const { data: messages, error: messagesError } = await supabase.from('messages')
    .select('id, conversation_id, sender_type, sender_id, message_type, status, content, created_at')
    .in('conversation_id', rows.map((row) => row.id)).order('created_at', { ascending: false });
  if (messagesError) throw new Error('Unable to load conversation previews.');
  const handoffs = new Map<string, string>();
  for (const message of (messages ?? []) as Message[]) {
    if (message.sender_type === 'automation' && message.message_type === 'text' &&
      message.content === "I couldn't complete that request right now. I'll connect you with a member of our support team. Please hold on for a moment." &&
      !handoffs.has(message.conversation_id)) handoffs.set(message.conversation_id, message.created_at);
  }
  const latest = new Map<string, Message>();
  for (const message of (messages ?? []) as Message[]) if (!latest.has(message.conversation_id)) latest.set(message.conversation_id, message);
  return rows.map(({ customers, apps, assigned_agent, ...row }) => ({ ...row, assignedAgent: relationOne(assigned_agent), customer: relationOne(customers), app: relationOne(apps), latestMessage: latest.get(row.id) ?? null, waitingSince: handoffs.get(row.id) }));
}

async function loadMessages(conversationId: string): Promise<Message[]> {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  const { data, error } = await supabase.from('messages').select('id, conversation_id, sender_type, sender_id, message_type, status, content, created_at').eq('conversation_id', conversationId).order('created_at', { ascending: true });
  if (error) throw new Error('Unable to load this conversation.');
  return (data ?? []) as Message[];
}

async function loadFeedback(conversationId: string): Promise<ConversationFeedback | null> {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  const { data, error } = await supabase.from('conversation_feedback').select('id, conversation_id, rating, review_text, submitted_at').eq('conversation_id', conversationId).maybeSingle();
  if (error) throw new Error('Unable to load conversation feedback.');
  return data as ConversationFeedback | null;
}

async function loadAgentPoints(agentId: string): Promise<number> {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  const { data, error } = await supabase.from('agent_points').select('points').eq('agent_id', agentId);
  if (error) throw new Error('Unable to load agent points.');
  return (data ?? []).reduce((total, row) => total + (typeof row.points === 'number' ? row.points : 0), 0);
}

function getSection() { const section = window.location.hash.slice(1).split('?')[0]; return ['inbox', 'apps', 'customers', 'team', 'settings'].includes(section) ? section : 'inbox'; }

function TransferControl({ conversation, onTransferred, assign = false }: { conversation: Conversation; onTransferred: (conversation: Conversation) => void; assign?: boolean }) {
  const action = assign ? 'Assign' : 'Transfer';
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; assignment_id: string | null; presence: AgentPresence }>>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    if (!supabase || busy) return;
    setOpen(true); setBusy(true); setError(''); setAgents([]); setTarget('');
    try {
      const { data, error } = await supabase.rpc('eligible_transfer_agents', { p_conversation_id: conversation.id });
      if (error || !Array.isArray(data)) throw new Error();
      setAgents(data);
    } catch { setError('Unable to load eligible agents.'); }
    finally { setBusy(false); }
  }
  async function transfer() {
    const agent = agents.find(item => item.id === target);
    if (!supabase || !agent || busy) return;
    setBusy(true); setError('');
    try {
      const { data, error } = await supabase.rpc(assign ? 'assign_conversation' : 'transfer_conversation', {
        p_conversation_id: conversation.id, p_target_agent_id: agent.id,
        ...(assign ? {} : { p_assignment_id: agent.assignment_id }),
      });
      if (error || !data || data.id !== conversation.id || data.assigned_agent_id !== agent.id) throw new Error();
      onTransferred({ ...conversation, ...data, assignedAgent: { name: agent.name } });
      setOpen(false);
    } catch { setError(`Unable to ${action.toLowerCase()}. Refresh the conversation before retrying.`); }
    finally { setBusy(false); }
  }
  return <div><button type="button" disabled={busy} className={assign ? 'assign-button' : undefined} onClick={() => void load()}>{action}</button>
    {open && <div className={assign ? "assign-popover" : undefined} role="dialog" aria-label={`${action} conversation`}>
      {busy && <p role="status">Please wait...</p>}
      {!busy && !error && !agents.length && <p>No eligible agents available.</p>}
      {!!agents.length && <><select aria-label="New assigned agent" value={target} disabled={busy} onChange={event => setTarget(event.target.value)}>
        <option value="">Select an agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} ? {agent.presence === 'online' ? 'Online' : agent.presence === 'away' ? 'Away' : 'Offline'}</option>)}
      </select><button type="button" disabled={busy || !target} onClick={() => void transfer()}>Confirm {action.toLowerCase()}</button></>}
      <button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
    </div>}{error && <p role="alert">{error}</p>}
  </div>;
}

function ApprovedDashboardPresentation({
  section,
  agent,
  conversations,
  selected,
  messages,
  selectedConversationId,
  setSelectedConversationId,
  selectedCustomerId,
  setSelectedCustomerId,
  openCount,
  mineCount,
  unassignedCount,
  inboxLoading,
  threadLoading,
  dataError,
  customerPanelOpen,
  setCustomerPanelOpen,
  composerText,
  setComposerText,
  sendMessage,
  closeConversation,
  onTransferred,
  claimConversation,
  isClaiming,
  claimError,
  feedback,
  agentPoints,
  onLogout,
  presence,
  sendError,
  isSending,
}: {
  section: string;
  agent: Agent;
  conversations: Conversation[];
  selected: Conversation | null;
  messages: Message[];
  selectedConversationId: string | null;
  setSelectedConversationId: (id: string) => void;
  selectedCustomerId: string | null;
  setSelectedCustomerId: (id: string) => void;
  openCount: number;
  mineCount: number;
  unassignedCount: number;
  inboxLoading: boolean;
  threadLoading: boolean;
  dataError: string | null;
  customerPanelOpen: boolean;
  setCustomerPanelOpen: (open: boolean) => void;
  composerText: string;
  setComposerText: (text: string) => void;
  sendMessage: () => Promise<void>;
  closeConversation: () => Promise<void>;
  onTransferred: (conversation: Conversation) => void;
  claimConversation: () => Promise<void>;
  isClaiming: boolean;
  claimError: string | null;
  feedback: ConversationFeedback | null;
  agentPoints: number;
  onLogout: () => Promise<void>;
  presence: AgentPresence;
  sendError: string | null;
  isSending: boolean;
}) {
  const canControl = !!selected && (agent.role === 'admin' || selected.assigned_agent_id === agent.id);
  const canReply = selected?.handler === 'human_agent' && selected.assigned_agent_id === agent.id && selected.status !== 'resolved';
  const [moreOpen, setMoreOpen] = useState(false);
  const [internalNote, setInternalNote] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  const threadRef = useRef<HTMLDivElement>(null);
  const customerName = selected?.customer?.display_name || 'Unknown customer';
  const customerInitials = initialsFor(selected?.customer?.display_name);
  const customerGroups = Array.from(
    conversations.filter(inInbox).reduce((groups, conversation) => {
      const existing = groups.get(conversation.customer_id);
      if (existing) existing.openConversations.push(conversation);
      else groups.set(conversation.customer_id, { customerId: conversation.customer_id, customer: conversation.customer, openConversations: [conversation], latestConversation: conversation });
      return groups;
    }, new Map<string, CustomerInboxGroup>()),
  ).map(([, group]) => {
    group.openConversations.sort(inboxPriority);
    group.latestConversation = group.openConversations[0];
    return group;
  }).sort((left, right) => inboxPriority(left.latestConversation, right.latestConversation));
  const selectedCustomerConversations = selectedCustomerId
    ? conversations.filter((conversation) => conversation.customer_id === selectedCustomerId).sort((left, right) => Date.parse(right.latestMessage?.created_at || right.updated_at) - Date.parse(left.latestMessage?.created_at || left.updated_at))
    : [];
  const selectConversation = (conversation: Conversation) => {
    setSelectedCustomerId(conversation.customer_id);
    setSelectedConversationId(conversation.id);
  };

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, threadLoading]);

  return <div className="dashboard">
    <aside className="sidebar" aria-label="JAI sidebar">
      <div className="wordmark" aria-label="JAI"><svg viewBox="0 0 76 44" aria-hidden="true"><path d="M20 9v23c0 6-3 9-9 9-4 0-7-2-9-5l4-4c1 2 3 3 5 3 3 0 4-1 4-4V9Z" /><path d="M27 40 44 9l17 31h-7L44 21 34 40Z" /><path d="M66 14h6v26h-6Z" /><circle className="wordmark-dot" cx="69" cy="6" r="4" /></svg></div>
      <nav className="navigation" aria-label="Main navigation">
        <a className="nav-item" href="#inbox" aria-current={section === 'inbox' ? 'page' : undefined}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3h.5a8.5 8.5 0 0 1 8 8v.5Z" /></svg><span>Inbox</span></a>
        <a className="nav-item" href="#customers" aria-current={section === 'customers' ? 'page' : undefined}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2" /></svg><span>Customers</span></a>
        <a className="nav-item" href="#team" aria-current={section === 'team' ? 'page' : undefined}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="3.5" /><path d="M2 21v-2a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v2M16 3.5a3.5 3.5 0 0 1 0 7M22 21v-2a6 6 0 0 0-4-5.65" /></svg><span>Team</span></a>
        <a className="nav-item" href="#settings" aria-current={section === 'settings' ? 'page' : undefined}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 3-.6 2.3-1.6.9-2.3-.6-2.5 4.3 1.7 1.7v1.8l-1.7 1.7L5 19.4l2.3-.6 1.6.9.6 2.3h5l.6-2.3 1.6-.9 2.3.6 2.5-4.3-1.7-1.7v-1.8l1.7-1.7L19 5.6l-2.3.6-1.6-.9L14.5 3Z" /><circle cx="12" cy="12.5" r="3.3" /></svg><span>Settings</span></a>
        <a className="nav-item" href="#apps" aria-current={section === 'apps' ? 'page' : undefined}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg><span>Apps</span></a>
      </nav>
      <div className="agent-profile" aria-label="Agent profile"><div className="agent-avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 22v-2a8 8 0 0 1 16 0v2" /></svg><span className="status-dot" style={{ background: presence === 'online' ? '#19ad7a' : presence === 'away' ? '#c68a22' : '#87928c' }} /></div><span className="agent-name">{agent.name}</span><span className="agent-status">{presence === 'online' ? 'Online' : presence === 'away' ? 'Away' : 'Offline'}</span><span className="agent-points">{agentPoints} points</span><button type="button" onClick={() => void onLogout()} style={{ gridColumn: '2 / -1', justifySelf: 'start', background: 'none', border: 0, padding: '4px 0', color: 'inherit', font: 'inherit', cursor: 'pointer' }}>Log out</button></div>
    </aside>
    <main className="content" aria-label={section} id={section} tabIndex={-1}>
      {section === 'apps' && <AppsPage organizationId={agent.organization_id} isAdmin={agent.role === 'admin'} />}
      {section === 'team' && <TeamPage organizationId={agent.organization_id} isAdmin={agent.role === 'admin'} />} 
      {section === 'inbox' && <section className="inbox-panel" aria-labelledby="inbox-title">
        <header className="inbox-header"><h1 id="inbox-title">Inbox</h1><p>Conversations</p></header>
        <label className="conversation-search"><span className="sr-only">Search conversations</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg><input type="search" placeholder="Search conversations" /></label>
        <div className="conversation-tabs" role="tablist" aria-label="Conversation filters"><button className="conversation-tab is-active" role="tab" aria-selected="true">Open <span>{openCount}</span></button><button className="conversation-tab" role="tab" aria-selected="false">Mine <span>{mineCount}</span></button><button className="conversation-tab" role="tab" aria-selected="false">Unassigned <span>{unassignedCount}</span></button></div>
        <div className="conversation-list" aria-label="Authorized conversations">
          {inboxLoading && <p className="data-state">Loading conversations...</p>}{!inboxLoading && dataError && <p className="data-state data-error">{dataError}</p>}{!inboxLoading && !dataError && !customerGroups.length && <p className="data-state">No open conversations yet.</p>}
          {customerGroups.map((group) => { const conversation = group.latestConversation; const name = group.customer?.display_name || 'Unknown customer'; return <button className={`conversation${group.customerId === selectedCustomerId ? ' is-selected' : ''}`} key={group.customerId} onClick={() => selectConversation(conversation)}><div className={`conversation-avatar ${toneFor(group.customerId)}`} aria-hidden="true">{initialsFor(name)}</div><div className="conversation-copy"><div className="conversation-meta"><h2>{name}</h2><time>{formatTime(conversation.latestMessage?.created_at || conversation.updated_at)}</time></div><p>{isWaiting(conversation) ? `Waiting for agent \u00b7 ${waitingTime(conversation, now)}` : conversation.handler === 'human_agent' ? conversationLabel(conversation, agent) : conversation.latestMessage?.content || 'No messages yet.'}</p><small>{conversation.app?.name || 'Unknown app'}{group.openConversations.length > 1 ? ` · ${group.openConversations.length} open` : ''}</small></div></button>; })}
        </div>
      </section>}
      {section === 'inbox' && selected && <section className="workspace" aria-label={`${customerName} conversation`}>
        <header className="workspace-header"><div className="workspace-person"><div className="workspace-avatar">{customerInitials}<span /></div><div><h1>{customerName}</h1><p>Customer <span>&bull;</span> {selected.app?.name || 'Unknown app'}</p></div></div><div className="workspace-actions"><span className="status-control">{conversationLabel(selected, agent)}</span><div className="assign-wrap">{selected.handler === 'human_queue' && selected.status !== 'resolved' && selected.assigned_agent_id === null && <button className="assign-button" style={{ background: '#123f32', color: 'white', borderColor: '#123f32' }} type="button" disabled={isClaiming} onClick={() => void claimConversation()}>{isClaiming ? 'Claiming...' : 'Claim'}</button>}{agent.role === 'admin' && selected.status === 'open' && selected.handler === 'human_queue' && selected.assigned_agent_id === null && <TransferControl key={selected.id} assign conversation={selected} onTransferred={onTransferred} />}</div><div className="overflow-wrap"><button className="overflow-button" onClick={() => setMoreOpen((open) => !open)} aria-label="More options"><span /><span /><span /></button>{moreOpen && <div className="more-menu" role="menu">{canControl && selected.handler === 'human_agent' && selected.status === 'open' && <TransferControl key={`${selected.id}:${selected.assigned_agent_id}`} conversation={selected} onTransferred={onTransferred} />}<button onClick={() => { setInternalNote((note) => !note); setMoreOpen(false); }}>Add internal note</button>{canControl && <button disabled={selected.status === 'resolved'} onClick={() => { void closeConversation(); setMoreOpen(false); }}>Resolve</button>}</div>}</div></div></header>
        <div className="thread" ref={threadRef}>{claimError && <p className="data-state data-error" role="alert">{claimError}</p>}{threadLoading && <p className="data-state">Loading messages...</p>}{!threadLoading && !messages.length && <p className="data-state">No messages in this conversation.</p>}{messages.map((message) => { const isCustomer = message.sender_type === 'customer'; return <div className={`message ${isCustomer ? 'customer-message' : 'agent-message'}`} key={message.id}><p>{message.content || (message.message_type === 'attachment' ? 'Attachment' : 'System message')}</p><div className="message-footer"><time>{formatTime(message.created_at)}</time>{!isCustomer && <span className="read-indicator" aria-label="Sent">&#10003;</span>}</div></div>; })}</div>
        <div className={internalNote ? 'composer-area is-internal-note' : 'composer-area'}><div className="composer"><button className="attachment-button" aria-label="Attach file" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20.5 11.5-8.8 8.8a5 5 0 0 1-7.1-7.1l9.5-9.5a3.4 3.4 0 1 1 4.8 4.8l-9.5 9.5a1.7 1.7 0 1 1-2.4-2.4l8.8-8.8" /></svg></button><input aria-label={`Message ${customerName}`} placeholder={selected.status === 'resolved' ? 'Conversation closed' : internalNote ? 'Write an internal note...' : 'Write a message...'} value={composerText} onChange={(event) => { setComposerText(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} disabled={isSending || !canReply} /><button className="send-button" aria-label="Send message" onClick={() => void sendMessage()} disabled={isSending || !composerText.trim() || !canReply}>{isSending ? '...' : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-8.2 18-3.1-7-6.7-3.1Z" /><path d="m9.7 14 4.2-4.2" /></svg>}</button></div>{sendError && <p className="composer-error" role="alert">{sendError}</p>}<button className="note-toggle" onClick={() => setInternalNote((note) => !note)} disabled={selected.status === 'resolved'}><span>+</span> {internalNote ? 'Reply mode' : 'Internal note'}</button></div>
      </section>}
      {section === 'inbox' && !inboxLoading && !selected && <section className="workspace"><div className="data-state">Select an authorized conversation to view its thread.</div></section>}
      {section === 'inbox' && selected && customerPanelOpen && <aside className="customer-panel" aria-label="Customer context"><button className="customer-close" onClick={() => setCustomerPanelOpen(false)} aria-label="Close customer panel">x</button><div className="customer-summary"><div className="customer-context-avatar">{customerInitials}</div><h2>{customerName}</h2>{selected.customer?.email && <a href={`mailto:${selected.customer.email}`}>{selected.customer.email}</a>}</div><dl className="customer-facts"><div><dt>Product</dt><dd>{selected.app?.name || 'Unknown app'}</dd></div><div><dt>Status</dt><dd>{conversationLabel(selected, agent)}</dd></div><div><dt>Created</dt><dd>{formatDate(selected.created_at)}</dd></div></dl><section className="recent-conversations"><h3>Conversations</h3>{selectedCustomerConversations.map((conversation) => <button className={`customer-conversation${conversation.id === selectedConversationId ? ' is-selected' : ''}`} key={conversation.id} onClick={() => selectConversation(conversation)}><strong>{conversation.latestMessage?.content || 'Conversation'}</strong><span>{conversationLabel(conversation, agent)} · {formatTime(conversation.latestMessage?.created_at || conversation.updated_at)}</span></button>)}</section>{feedback && <section className="customer-feedback"><h3>Support feedback</h3><div className="feedback-stars" aria-label={`${feedback.rating} out of 5 stars`}>{[1, 2, 3, 4, 5].map((star) => <span className={star <= feedback.rating ? 'is-selected' : ''} key={star}>★</span>)}</div>{feedback.review_text && <p>{feedback.review_text}</p>}</section>}<section className="customer-notes"><div><h3>Notes</h3><button aria-label="Add note" disabled>+</button></div><p>Customer notes are not available.</p></section></aside>}
    </main>
  </div>;
}

function DashboardApp({ agentContext, onLogout, presence }: { agentContext: AgentContext; onLogout: () => Promise<void>; presence: AgentPresence }) {
  const [section, setSection] = useState(getSection);
  const [customerPanelOpen, setCustomerPanelOpen] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<Message[]>([]);
  const [conversationFeedback, setConversationFeedback] = useState<ConversationFeedback | null>(null);
  const [agentPoints, setAgentPoints] = useState(0);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const claimingRef = useRef(false);
  const [claimError, setClaimError] = useState<{ conversationId: string; message: string } | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const update = () => setSection(getSection()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  const selectionRef = useRef(selectedConversationId);
  selectionRef.current = selectedConversationId;
  const notifications = useAgentNotifications(agentContext.agent.id, conversations);
  const [linkError, setLinkError] = useState('');
  const [linkRequest, setLinkRequest] = useState(() => window.location.hash);
  useEffect(() => {
    const changed = () => setLinkRequest(window.location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    const id = new URLSearchParams(linkRequest.split('?')[1] || '').get('conversation');
    if (!id) { setLinkError(''); return; }
    let active = true;
    void loadConversations().then(items => {
      if (!active) return;
      const target = items.find(item => item.id === id);
      if (!target) { setLinkError('Conversation unavailable.'); return; }
      setConversations(items); setSelectedCustomerId(target.customer_id); setSelectedConversationId(target.id); setLinkError('');
    }).catch(() => { if (active) setLinkError('Conversation unavailable.'); });
    return () => { active = false; };
  }, [linkRequest, agentContext.agent.id]);
  const initializedInbox = useRef(false);
  const threadVersion = useRef(0);
  useInboxRealtime(agentContext.user.id, agentContext.apps.map(app => app.id), conversations.map(item => item.id), async current => {
    const selectedId = selectionRef.current;
    const version = ++threadVersion.current;
    try {
      const items = await loadConversations();
      if (!current()) return;
      setConversations(items); setDataError(null); setInboxLoading(false);
      if (!initializedInbox.current) {
        initializedInbox.current = true;
        const linkedId = new URLSearchParams(window.location.hash.split('?')[1] || '').get('conversation');
        const initial = linkedId ? items.find(item => item.id === linkedId) ?? null : items.filter(inInbox).sort(inboxPriority)[0] ?? items[0] ?? null;
        setSelectedConversationId(initial?.id ?? null); setSelectedCustomerId(initial?.customer_id ?? null);
        return;
      }
      if (selectionRef.current !== selectedId) return;
      if (selectedId && !items.some(item => item.id === selectedId)) {
        setSelectedConversationId(null); setSelectedCustomerId(null); setThreadMessages([]); setConversationFeedback(null); setComposerText('');
        return;
      }
      if (selectedId) {
        const [messages, feedback] = await Promise.all([loadMessages(selectedId), loadFeedback(selectedId)]);
        if (!current() || selectionRef.current !== selectedId || threadVersion.current !== version) return;
        setThreadMessages(messages); setConversationFeedback(feedback);
      }
    } catch {
      if (current() && !initializedInbox.current) { setDataError('Unable to load conversations. Retrying automatically.'); setInboxLoading(false); }
    }
  });
  useEffect(() => {
    if (!selectedConversationId) { setThreadMessages([]); setConversationFeedback(null); return; }
    const version = ++threadVersion.current;
    let mounted = true; setThreadLoading(true); setDataError(null); setSendError(null); setComposerText('');
    void Promise.all([loadMessages(selectedConversationId), loadFeedback(selectedConversationId)]).then(([items, feedback]) => { if (mounted && version === threadVersion.current) { setThreadMessages(items); setConversationFeedback(feedback); } }).catch((error) => { if (mounted) setDataError(error instanceof Error ? error.message : 'Unable to load this conversation.'); }).finally(() => { if (mounted) setThreadLoading(false); });
    return () => { mounted = false; };
  }, [selectedConversationId]);

  useEffect(() => {
    let mounted = true;
    void loadAgentPoints(agentContext.agent.id).then((points) => { if (mounted) setAgentPoints(points); }).catch(() => undefined);
    return () => { mounted = false; };
  }, [agentContext.agent.id]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [threadMessages, threadLoading]);

  const sendMessage = async () => {
    const content = composerText.trim();
    if (!content || !selectedConversationId || isSending || !supabase) return;
    if (selected?.status === 'resolved' || selected?.handler !== 'human_agent' || selected?.assigned_agent_id !== agentContext.agent.id) {
      setSendError('This conversation is closed.');
      return;
    }
    setIsSending(true);
    setSendError(null);
    const { data: insertedMessage, error } = await supabase.from('messages').insert({
      conversation_id: selectedConversationId,
      sender_type: 'human_agent',
      sender_id: agentContext.agent.id,
      content,
    }).select('id, conversation_id, sender_type, sender_id, message_type, status, content, created_at').single();
    if (error || !insertedMessage) {
      setSendError('Unable to send your reply. Please try again.');
      setIsSending(false);
      return;
    }
    const message = insertedMessage as Message;
    ++threadVersion.current;
    setThreadMessages((messages) => messages.some(item => item.id === message.id) ? messages : [...messages, message]);
    setConversations((items) => items.map((conversation) => conversation.id === selectedConversationId
      ? { ...conversation, latestMessage: message, updated_at: message.created_at }
      : conversation));
    setComposerText('');
    setIsSending(false);
  };

  const claimConversation = async () => {
    if (!supabase || !selected || claimingRef.current || selected.handler !== 'human_queue'
      || selected.status === 'resolved' || selected.assigned_agent_id !== null) return;
    const conversationId = selected.id;
    claimingRef.current = true;
    setIsClaiming(true);
    setClaimError(null);
    try {
      const { data, error } = await supabase.rpc('claim_conversation', { p_conversation_id: conversationId });
      if (error || !data) throw new Error('Claim failed');
      const claimed = data as Conversation;
      setConversations((items) => items.map((conversation) => conversation.id === conversationId
        ? { ...conversation, handler: claimed.handler, assigned_agent_id: claimed.assigned_agent_id }
        : conversation));
    } catch {
      setClaimError({ conversationId, message: 'Unable to claim this conversation. It may already have been claimed or closed.' });
    } finally {
      try {
        setConversations(await loadConversations());
      } catch {
        setClaimError((current) => ({ conversationId, message: `${current?.conversationId === conversationId ? current.message + ' ' : ''}Unable to refresh conversation state. Please reload before retrying.` }));
      } finally {
        claimingRef.current = false;
        setIsClaiming(false);
      }
    }
  };

  const lifecycleBusy = useRef(false);
  const closeConversation = async () => {
    if (!selected || !supabase || selected.status === 'resolved' || lifecycleBusy.current) return;
    const conversationId = selected.id;
    lifecycleBusy.current = true; setSendError(null);
    try {
      const { data, error } = await supabase.rpc('resolve_conversation', {
        p_conversation_id: conversationId, p_expected_agent_id: selected.assigned_agent_id,
      });
      if (error || !data || data.id !== conversationId || data.status !== 'resolved') throw new Error();
      setConversations(items => items.map(item => item.id === conversationId ? { ...item, ...data } : item));
    } catch { setSendError('Unable to resolve. Refresh the conversation and try again.'); }
    finally { lifecycleBusy.current = false; }
  };

  const selected = conversations.find((conversation) => conversation.id === selectedConversationId) as Conversation;
  const openCount = conversations.filter(inInbox).length;
  const mineCount = conversations.filter((conversation) => inInbox(conversation) && conversation.assigned_agent_id === agentContext.agent.id).length;
  const unassignedCount = conversations.filter((conversation) => inInbox(conversation) && conversation.assigned_agent_id === null).length;
  const customerName = selected?.customer?.display_name || 'Unknown customer';
  const customerInitials = initialsFor(selected?.customer?.display_name);

  return <>
    {(notifications.notices.length > 0 || linkError) && <aside aria-live="polite" style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 100, maxWidth: 340, padding: 14, background: 'white', color: '#17342c', border: '1px solid #dfe8e3', borderRadius: 8, boxShadow: '0 3px 14px #0002' }}>
      {notifications.notices.map(notice => <div key={notice.id}><button type="button" onClick={() => notifications.open(notice)} style={{ background: 'none', border: 0, textAlign: 'left', color: 'inherit', cursor: 'pointer' }}><strong>{notice.title} ? {notice.app_name}</strong>{notice.body && <p>{notice.body}</p>}</button><button type="button" onClick={() => notifications.dismiss(notice.id)} aria-label="Dismiss notification">?</button></div>)}
      {linkError && <p>{linkError}<button type="button" onClick={() => setLinkError('')}>Dismiss</button></p>}
    </aside>}
    <ApprovedDashboardPresentation
    section={section}
    agent={agentContext.agent}
    conversations={conversations}
    selected={selected}
    messages={threadMessages}
    selectedConversationId={selectedConversationId}
    setSelectedConversationId={setSelectedConversationId}
    selectedCustomerId={selectedCustomerId}
    setSelectedCustomerId={setSelectedCustomerId}
    openCount={openCount}
    mineCount={mineCount}
    unassignedCount={unassignedCount}
    inboxLoading={inboxLoading}
    threadLoading={threadLoading}
    dataError={dataError}
    customerPanelOpen={customerPanelOpen}
    setCustomerPanelOpen={setCustomerPanelOpen}
    composerText={composerText}
    setComposerText={setComposerText}
    sendMessage={sendMessage}
    onTransferred={conversation => {
      setConversations(items => items.map(item => item.id === conversation.id ? conversation : item));
      setComposerText('');
    }}
    closeConversation={closeConversation}
    claimConversation={claimConversation}
    isClaiming={isClaiming}
    claimError={claimError?.conversationId === selectedConversationId ? claimError.message : null}
    feedback={conversationFeedback}
    agentPoints={agentPoints}
    onLogout={onLogout}
    presence={presence}
    sendError={sendError}
    isSending={isSending}
  /></>;

  return <div className="dashboard">
    <aside className="sidebar" aria-label="JAI sidebar"><div className="wordmark" aria-label="JAI"><svg viewBox="0 0 76 44" aria-hidden="true"><path d="M20 9v23c0 6-3 9-9 9-4 0-7-2-9-5l4-4c1 2 3 3 5 3 3 0 4-1 4-4V9Z" /><path d="M27 40 44 9l17 31h-7L44 21 34 40Z" /><path d="M66 14h6v26h-6Z" /><circle className="wordmark-dot" cx="69" cy="6" r="4" /></svg></div><nav className="navigation" aria-label="Main navigation"><a className="nav-item" href="#inbox" aria-current={section === 'inbox' ? 'page' : undefined}>Inbox</a><a className="nav-item" href="#customers" aria-current={section === 'customers' ? 'page' : undefined}>Customers</a><a className="nav-item" href="#team" aria-current={section === 'team' ? 'page' : undefined}>Team</a><a className="nav-item" href="#settings" aria-current={section === 'settings' ? 'page' : undefined}>Settings</a></nav><div className="agent-profile"><div className="agent-avatar" aria-hidden="true">{initialsFor(agentContext.agent.name)}</div><span className="agent-name">{agentContext.agent.name}</span><span className="agent-status">{agentContext.agent.status}</span></div></aside>
    <main className="content" aria-label={section} id={section} tabIndex={-1}>
      {section === 'inbox' && <section className="inbox-panel" aria-labelledby="inbox-title"><header className="inbox-header"><h1 id="inbox-title">Inbox</h1><p>Conversations</p></header><label className="conversation-search"><span className="sr-only">Search conversations</span><input type="search" placeholder="Search conversations" /></label><div className="conversation-tabs" role="tablist" aria-label="Conversation filters"><button className="conversation-tab is-active" role="tab" aria-selected="true">Open <span>{openCount}</span></button><button className="conversation-tab" role="tab" aria-selected="false">Mine <span>{mineCount}</span></button><button className="conversation-tab" role="tab" aria-selected="false">Unassigned <span>{unassignedCount}</span></button></div><div className="conversation-list" aria-label="Authorized conversations">{inboxLoading && <p className="data-state">Loading conversations...</p>}{!inboxLoading && dataError && <p className="data-state data-error">{dataError}</p>}{!inboxLoading && !dataError && !conversations.length && <p className="data-state">No authorized conversations yet.</p>}{conversations.map((conversation) => { const name = conversation.customer?.display_name || 'Unknown customer'; return <button className={`conversation${conversation.id === selectedConversationId ? ' is-selected' : ''}`} key={conversation.id} onClick={() => setSelectedConversationId(conversation.id)}><div className={`conversation-avatar ${toneFor(conversation.id)}`} aria-hidden="true">{initialsFor(name)}</div><div className="conversation-copy"><div className="conversation-meta"><h2>{name}</h2><time>{formatTime(conversation.latestMessage?.created_at || conversation.updated_at)}</time></div><p>{conversation.latestMessage?.content || 'No messages yet.'}</p><small>{conversation.app?.name || 'Unknown app'}</small></div></button>; })}</div></section>}
      {section === 'inbox' && selected && <section className="workspace" aria-label={`${customerName} conversation`}><header className="workspace-header"><div className="workspace-person"><div className="workspace-avatar">{customerInitials}</div><div><h1>{customerName}</h1><p>Customer <span>&bull;</span> {selected.app?.name || 'Unknown app'}</p></div></div><div className="workspace-actions"><span className="status-control">{selected.status}</span><button className="assign-button" disabled>Assign</button></div></header><div className="thread" ref={threadRef}>{threadLoading && <p className="data-state">Loading messages...</p>}{!threadLoading && !threadMessages.length && <p className="data-state">No messages in this conversation.</p>}{threadMessages.map((message) => { const isCustomer = message.sender_type === 'customer'; return <div className={`message ${isCustomer ? 'customer-message' : 'agent-message'}`} key={message.id}><p>{message.content || (message.message_type === 'attachment' ? 'Attachment' : 'System message')}</p><time>{formatTime(message.created_at)}</time></div>; })}</div><div className="composer-area"><div className="composer"><input aria-label={`Message ${customerName}`} placeholder="Write a reply..." value={composerText} onChange={(event) => { setComposerText(event.target.value); setSendError(null); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} disabled={isSending} /><button className="send-button" aria-label="Send reply" onClick={() => void sendMessage()} disabled={isSending || !composerText.trim()}>{isSending ? '...' : 'Send'}</button></div>{sendError && <p className="composer-error" role="alert">{sendError}</p>}</div></section>}
      {section === 'inbox' && !inboxLoading && !selected && <section className="workspace"><div className="data-state">Select an authorized conversation to view its thread.</div></section>}
      {section === 'inbox' && selected && customerPanelOpen && <aside className="customer-panel" aria-label="Customer context"><button className="customer-close" onClick={() => setCustomerPanelOpen(false)} aria-label="Close customer panel">x</button><div className="customer-summary"><div className="customer-context-avatar">{customerInitials}</div><h2>{customerName}</h2>{selected.customer?.email && <a href={`mailto:${selected.customer?.email}`}>{selected.customer?.email}</a>}</div><dl className="customer-facts"><div><dt>Product</dt><dd>{selected.app?.name || 'Unknown app'}</dd></div><div><dt>Status</dt><dd>{selected.status}</dd></div><div><dt>Created</dt><dd>{formatDate(selected.created_at)}</dd></div></dl><section className="customer-notes"><h3>Notes</h3><p>Customer notes are not available.</p></section></aside>}
    </main>
  </div>;
}

function LoginScreen({ onSubmit, error, isSubmitting }: { onSubmit: (email: string, password: string) => Promise<void>; error: string | null; isSubmitting: boolean }) { const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); return <main className="auth-screen"><form className="auth-card" onSubmit={(event) => { event.preventDefault(); void onSubmit(email, password); }}><div className="auth-mark">JAI</div><h1>Sign in to JAI</h1><p>Use your JAI human agent account.</p><label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <div className="auth-error" role="alert">{error}</div>}<button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Signing in...' : 'Sign in'}</button></form></main>; }
function AuthMessage({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) { return <main className="auth-screen"><section className="auth-card"><div className="auth-mark">JAI</div><h1>{children}</h1>{action}</section></main>; }

class AgentAccessDenied extends Error {}
class AgentSessionInvalid extends Error {}
function checkAgentAccessError(error: { code?: string } | null) {
  if (error?.code === 'PGRST301' || error?.code === 'PGRST303') throw new AgentSessionInvalid();
  if (error?.code === '42501') throw new AgentAccessDenied();
}

async function resolveAgentContext(user: User): Promise<AgentContext> { if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.'); const { data: agent, error: agentError } = await supabase.from('human_agents').select('id, auth_user_id, organization_id, name, email, role, status').eq('auth_user_id', user.id).maybeSingle(); checkAgentAccessError(agentError); if (agentError) throw new Error('Unable to resolve the JAI agent profile.'); if (!agent) throw new AgentAccessDenied('This account is authenticated but is not authorized as a JAI human agent.'); const [{ data: organization, error: organizationError }, { data: apps, error: appsError }, { data: appAccess, error: accessError }] = await Promise.all([supabase.from('organizations').select('id, name').eq('id', agent.organization_id).single(), supabase.from('apps').select('id, organization_id, name, slug, status').eq('organization_id', agent.organization_id).order('name'), supabase.from('agent_app_access').select('app_id').eq('agent_id', agent.id)]); checkAgentAccessError(organizationError); checkAgentAccessError(appsError); checkAgentAccessError(accessError); if (organizationError || appsError || accessError || !organization) throw new Error('Unable to load the JAI agent access context.'); return { user, agent, organization, apps: apps ?? [], appAccess: appAccess ?? [] }; }

export default function App() {
  const invitationId = new URLSearchParams(window.location.search).get('invitation');
  if (invitationId) return <AcceptInvitation invitationId={invitationId} />;
  return <AuthenticatedApp />;
}
function AuthenticatedApp() {
  const [authState, setAuthState] = useState<'checking' | 'signed-out' | 'authenticated' | 'unauthorized'>(supabase ? 'checking' : 'signed-out');
  const [agentContext, setAgentContext] = useState<AgentContext | null>(null);
  const [authError, setAuthError] = useState<string | null>(supabaseConfigError);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const sessionVersion = useRef(0);
  const establishedUserId = useRef<string | null>(null);
  const loggingOut = useRef(false);
  const [presenceAgentId, setPresenceAgentId] = useState<string>();
  const { presence, stopPresence } = useAgentPresence(presenceAgentId);
  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    const applySession = (user: User | null) => {
      const version = ++sessionVersion.current;
      const sameUser = !!user && establishedUserId.current === user.id;
      setAuthError(null);
      if (!user || loggingOut.current) {
        establishedUserId.current = null; setAgentContext(null);
        setPresenceAgentId(undefined); setAuthState('signed-out'); return;
      }
      if (!sameUser) {
        establishedUserId.current = null; setAgentContext(null);
        setPresenceAgentId(undefined); setAuthState('checking');
      }
      // Leave the Auth callback before starting authenticated database requests.
      void Promise.resolve().then(() => {
        if (!mounted || version !== sessionVersion.current) return null;
        return resolveAgentContext(user);
      }).then(context => {
        if (!mounted || version !== sessionVersion.current || !context) return;
        establishedUserId.current = user.id;
        setAgentContext(context); setPresenceAgentId(user.id); setAuthState('authenticated');
      }).catch(error => {
        if (!mounted || version !== sessionVersion.current) return;
        if (sameUser && !(error instanceof AgentAccessDenied) && !(error instanceof AgentSessionInvalid)) return;
        establishedUserId.current = null; setAgentContext(null);
        if (error instanceof AgentSessionInvalid) {
          setPresenceAgentId(undefined); setAuthError('Please sign in again.'); setAuthState('signed-out'); return;
        }
        setPresenceAgentId(undefined); setAuthError('Unable to load your authorized agent account.'); setAuthState('unauthorized');
      });
    };
    const initialVersion = sessionVersion.current;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) applySession(session?.user ?? null);
    });
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted || sessionVersion.current !== initialVersion) return;
      if (error) { setAuthError('Unable to load your session. Please sign in.'); setAuthState('signed-out'); }
      else applySession(data.session?.user ?? null);
    }).catch(() => {
      if (mounted && sessionVersion.current === initialVersion) {
        setAuthError('Unable to load your session. Please sign in.'); setAuthState('signed-out');
      }
    });
    return () => { mounted = false; ++sessionVersion.current; subscription.unsubscribe(); };
  }, []);
  const signIn = async (email: string, password: string) => {
    if (!supabase || loggingOut.current) return;
    setIsSubmitting(true); setAuthError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setAuthError('Unable to sign in. Check your credentials.');
    } catch { setAuthError('Unable to sign in. Please try again.'); }
    finally { setIsSubmitting(false); }
  };
  const signOut = async () => {
    if (!supabase || loggingOut.current) return;
    loggingOut.current = true;
    establishedUserId.current = null;
    ++sessionVersion.current;
    const presenceCleanup = stopPresence();
    setPresenceAgentId(undefined);
    setAgentContext(null); setAuthError(null); setAuthState('signed-out'); setIsSubmitting(true);
    try {
      await Promise.race([presenceCleanup, new Promise<void>(resolve => setTimeout(resolve, 1500))]);
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    } catch {
      setAuthError('Log out could not be completed. Please retry.'); setAuthState('unauthorized');
    } finally { loggingOut.current = false; setIsSubmitting(false); }
  };
  if (authState === 'checking') return <AuthMessage>Checking your JAI session...</AuthMessage>;
  if (authState === 'signed-out') return <LoginScreen onSubmit={signIn} error={authError} isSubmitting={isSubmitting} />;
  if (authState === 'unauthorized') return <AuthMessage action={<button type="button" onClick={() => void signOut()}>Log out</button>}>{authError ?? 'This account is not authorized as a JAI human agent.'}</AuthMessage>;
  if (!agentContext) return <AuthMessage>Unable to load the JAI dashboard.</AuthMessage>;
  return <DashboardApp key={agentContext.user.id} agentContext={agentContext} onLogout={signOut} presence={presence} />;
}
