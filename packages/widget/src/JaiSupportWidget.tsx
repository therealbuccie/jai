import { useEffect, useRef, useState } from 'react';
import './styles.css';

export interface JaiSupportWidgetProps {
  appId: string;
  productName: string;
  supabaseUrl?: string;
  className?: string;
}

type Message = {
  id: string;
  sender: 'customer' | 'support';
  text: string;
  time: string;
  status?: 'sent' | 'delivered' | 'read';
};

type StoredSession = { sessionToken: string; expiresAt: string };
type ConversationSummary = {
  conversationId: string;
  status: 'open' | 'pending' | 'resolved';
  createdAt: string;
  updatedAt: string;
  latestMessagePreview: string | null;
  latestMessageAt: string | null;
  feedbackRating: number | null;
  feedbackReview: string | null;
  feedbackSubmittedAt: string | null;
};
type CustomerIdentity = { name: string; email: string };
type ChatAction =
  | { action: 'start_conversation'; message: string }
  | { action: 'send_message'; conversationId: string; message: string }
  | { action: 'get_messages'; conversationId: string }
  | { action: 'list_conversations' }
  | { action: 'identify_customer'; name: string | null; email: string | null }
  | { action: 'submit_feedback'; conversationId: string; rating: number; review: string | null };

const sessionStoragePrefix = 'jai:anonymous-session:';
const conversationStoragePrefix = 'jai:active-conversation:';
const identityStoragePrefix = 'jai:customer-identity-saved:';
const defaultSupabaseUrl = (import.meta as ImportMeta & {
  env?: { VITE_SUPABASE_URL?: string };
}).env?.VITE_SUPABASE_URL;

function isStoredSession(value: unknown): value is StoredSession {
  return typeof value === 'object' && value !== null &&
    typeof (value as StoredSession).sessionToken === 'string' && /^[0-9a-f]{64}$/i.test((value as StoredSession).sessionToken) &&
    typeof (value as StoredSession).expiresAt === 'string' && Date.parse((value as StoredSession).expiresAt) > Date.now();
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function formatHistoryTime(value: string | null): string {
  if (!value) return 'No messages';
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function JaiSupportWidget({ appId, productName, supabaseUrl = defaultSupabaseUrl, className = '' }: JaiSupportWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [screen, setScreen] = useState<'home' | 'conversation'>('home');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [feedbackRating, setFeedbackRating] = useState<number | null>(null);
  const [feedbackReview, setFeedbackReview] = useState('');
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<CustomerIdentity>({ name: '', email: '' });
  const [identityDraft, setIdentityDraft] = useState<CustomerIdentity>({ name: '', email: '' });
  const [identitySaved, setIdentitySaved] = useState(false);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sessionRequestRef = useRef<Promise<string> | null>(null);
  const sendingRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [focusNewConversation, setFocusNewConversation] = useState(false);

  const sessionStorageKey = `${sessionStoragePrefix}${appId}`;
  const conversationStorageKey = `${conversationStoragePrefix}${appId}`;
  const identityStorageKey = `${identityStoragePrefix}${appId}`;

  const readStoredConversationId = (): string | null => {
    try {
      const value = window.localStorage.getItem(conversationStorageKey);
      return isUuid(value) ? value : null;
    } catch {
      return null;
    }
  };

  const storeConversationId = (conversationId: string) => {
    try { window.localStorage.setItem(conversationStorageKey, conversationId); } catch { /* Continue in memory. */ }
  };

  const readStoredSession = (): StoredSession | null => {
    try {
      const raw = window.localStorage.getItem(sessionStorageKey);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (isStoredSession(parsed)) return parsed;
      window.localStorage.removeItem(sessionStorageKey);
    } catch {
      // Storage may be unavailable in privacy-restricted browsers.
    }
    return null;
  };

  const requestSession = async (): Promise<string> => {
    if (!supabaseUrl) throw new Error('Support connection is not configured.');
    const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/widget-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId }),
    });
    if (!response.ok) throw new Error('Unable to connect to support.');
    const result: unknown = await response.json();
    if (!isStoredSession(result)) throw new Error('Unable to connect to support.');
    try { window.localStorage.setItem(sessionStorageKey, JSON.stringify(result)); } catch { /* Continue with in-memory session. */ }
    return result.sessionToken;
  };

  const getSessionToken = async (forceNew = false): Promise<string> => {
    if (!forceNew) {
      const stored = readStoredSession();
      if (stored) return stored.sessionToken;
    }
    if (!sessionRequestRef.current) {
      sessionRequestRef.current = requestSession().finally(() => { sessionRequestRef.current = null; });
    }
    return sessionRequestRef.current;
  };

  const sendChatAction = async (action: ChatAction, recovered = false): Promise<Record<string, unknown>> => {
    const token = await getSessionToken();
    if (!supabaseUrl) throw new Error('Support connection is not configured.');
    const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/widget-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(action),
    });
    if (response.status === 401 && !recovered) {
      try { window.localStorage.removeItem(sessionStorageKey); } catch { /* Continue with a fresh in-memory session. */ }
      return sendChatAction({ ...action }, true);
    }
    const result: unknown = await response.json().catch(() => null);
    if (response.status === 409 && typeof result === 'object' && result !== null && (result as Record<string, unknown>).code === 'conversation_closed') {
      throw new Error('This conversation is closed. Start a new conversation to reply.');
    }
    if (!response.ok || typeof result !== 'object' || result === null) throw new Error(action.action === 'get_messages' ? 'Messages could not be loaded.' : action.action === 'list_conversations' ? 'Conversations could not be loaded.' : action.action === 'identify_customer' ? 'Identity could not be saved.' : action.action === 'submit_feedback' ? 'Feedback could not be submitted.' : 'Message could not be sent. Please try again.');
    return result as Record<string, unknown>;
  };

  const syncConversationHistory = async (): Promise<ConversationSummary[]> => {
    const result = await sendChatAction({ action: 'list_conversations' });
    if (!Array.isArray(result.conversations)) throw new Error('Conversations could not be loaded.');
    const nextHistory: ConversationSummary[] = result.conversations.flatMap((value) => {
      if (typeof value !== 'object' || value === null) return [];
      const conversation = value as Record<string, unknown>;
      if (!isUuid(conversation.conversationId) || typeof conversation.status !== 'string' ||
        typeof conversation.createdAt !== 'string' || typeof conversation.updatedAt !== 'string') return [];
      return [{
        conversationId: conversation.conversationId,
        status: conversation.status as ConversationSummary['status'],
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        latestMessagePreview: typeof conversation.latestMessagePreview === 'string' ? conversation.latestMessagePreview : null,
        latestMessageAt: typeof conversation.latestMessageAt === 'string' ? conversation.latestMessageAt : null,
        feedbackRating: typeof conversation.feedbackRating === 'number' ? conversation.feedbackRating : null,
        feedbackReview: typeof conversation.feedbackReview === 'string' ? conversation.feedbackReview : null,
        feedbackSubmittedAt: typeof conversation.feedbackSubmittedAt === 'string' ? conversation.feedbackSubmittedAt : null,
      }];
    });
    setConversationHistory(nextHistory);
    const activeFeedback = activeConversationId ? nextHistory.find((conversation) => conversation.conversationId === activeConversationId) : null;
    if (activeFeedback) {
      if (activeFeedback.feedbackRating !== null) {
        setFeedbackRating(activeFeedback.feedbackRating);
        setFeedbackReview(activeFeedback.feedbackReview || '');
        setFeedbackSubmitted(true);
      }
    }
    const storedId = readStoredConversationId();
    if (storedId && !nextHistory.some((conversation) => conversation.conversationId === storedId)) {
      try { window.localStorage.removeItem(conversationStorageKey); } catch { /* Continue without browser storage. */ }
    }
    return nextHistory;
  };

  const saveIdentity = async () => {
    const name = identityDraft.name.trim();
    const email = identityDraft.email.trim();
    if (!name && !email) return;
    setIdentitySaving(true);
    setIdentityError(null);
    try {
      await sendChatAction({ action: 'identify_customer', name: name || null, email: email || null });
      setIdentity({ name, email });
      setIdentityDraft({ name, email });
      setIdentitySaved(true);
      try { window.localStorage.setItem(identityStorageKey, 'true'); } catch { /* Continue in memory. */ }
    } catch (error) {
      setIdentityError(error instanceof Error ? error.message : 'Identity could not be saved.');
    } finally {
      setIdentitySaving(false);
    }
  };

  const submitFeedback = async () => {
    if (!activeConversationId || feedbackRating === null || feedbackSaving) return;
    setFeedbackSaving(true);
    setFeedbackError(null);
    try {
      await sendChatAction({ action: 'submit_feedback', conversationId: activeConversationId, rating: feedbackRating, review: feedbackReview.trim() || null });
      setFeedbackSubmitted(true);
      await syncConversationHistory();
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : 'Feedback could not be submitted.');
    } finally {
      setFeedbackSaving(false);
    }
  };

  const syncMessages = async (conversationId: string): Promise<void> => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    try {
      const result = await sendChatAction({ action: 'get_messages', conversationId });
      if (!Array.isArray(result.messages)) throw new Error('Messages could not be loaded.');
      const nextMessages: Message[] = result.messages.flatMap((value) => {
        if (typeof value !== 'object' || value === null) return [];
        const message = value as Record<string, unknown>;
        if (!isUuid(message.id) || !isUuid(message.conversation_id as string) || typeof message.sender_type !== 'string' || typeof message.created_at !== 'string') return [];
        return [{
          id: message.id,
          sender: message.sender_type === 'customer' ? 'customer' : 'support',
          text: typeof message.content === 'string' && message.content ? message.content : 'Message unavailable',
          time: new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          status: message.status === 'read' || message.status === 'delivered' ? message.status : 'sent',
        }];
      });
      setMessages(nextMessages);
    } finally {
      syncInFlightRef.current = false;
    }
  };

  useEffect(() => {
    try { setIdentitySaved(window.localStorage.getItem(identityStorageKey) === 'true'); } catch { /* Continue with the form visible. */ }
    void getSessionToken().catch(() => undefined);
  }, [appId, identityStorageKey, supabaseUrl]);

  useEffect(() => {
    if (!isOpen || screen !== 'home') return;
    void syncConversationHistory().catch(() => undefined);
  }, [isOpen, screen, appId]);

  useEffect(() => {
    if (!isOpen || screen !== 'conversation' || !activeConversationId) return;
    void syncMessages(activeConversationId).catch(() => undefined);
    const interval = window.setInterval(() => {
      if (!syncInFlightRef.current) void syncConversationHistory().then(() => syncMessages(activeConversationId)).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [isOpen, screen, activeConversationId]);

  useEffect(() => {
    if (!focusNewConversation) return;
    if (isOpen && screen === 'conversation' && !activeConversationId) {
      if (isSending) return;
      messageInputRef.current?.focus();
    }
    setFocusNewConversation(false);
  }, [focusNewConversation, isOpen, screen, activeConversationId, isSending]);

  const closeWidget = () => {
    setIsOpen(false);
    setScreen('home');
    setMessages([]);
    setActiveConversationId(null);
    setDraft('');
    setSendError(null);
  };

  const toggleWidget = () => {
    if (isOpen) {
      closeWidget();
      return;
    }
    setScreen('home');
    setMessages([]);
    setActiveConversationId(null);
    setDraft('');
    setSendError(null);
    setIsOpen(true);
  };

  const startNewConversation = () => {
    setFocusNewConversation(true);
    setMessages([]);
    setActiveConversationId(null);
    setFeedbackRating(null);
    setFeedbackReview('');
    setFeedbackSubmitted(false);
    setFeedbackError(null);
    setDraft('');
    setSendError(null);
    setScreen('conversation');
  };

  const openConversation = (conversationId: string) => {
    const summary = conversationHistory.find((conversation) => conversation.conversationId === conversationId);
    if (!summary) return;
    setMessages([]);
    setActiveConversationId(conversationId);
    setFeedbackRating(summary.feedbackRating);
    setFeedbackReview(summary.feedbackReview || '');
    setFeedbackSubmitted(summary.feedbackRating !== null);
    setFeedbackError(null);
    storeConversationId(conversationId);
    setDraft('');
    setSendError(null);
    setScreen('conversation');
  };

  const sendMessage = async () => {
    const text = draft.trim();
    if (!text || sendingRef.current) return;
    if (conversationHistory.find((conversation) => conversation.conversationId === activeConversationId)?.status === 'resolved') {
      setSendError('This conversation is closed. Start a new conversation to reply.');
      return;
    }

    sendingRef.current = true;
    setIsSending(true);
    setSendError(null);
    try {
      const result = await sendChatAction(activeConversationId
        ? { action: 'send_message', conversationId: activeConversationId, message: text }
        : { action: 'start_conversation', message: text });
      if (!activeConversationId) {
        if (!isUuid(result.conversationId)) throw new Error('Message could not be sent. Please try again.');
        setActiveConversationId(result.conversationId);
        storeConversationId(result.conversationId);
      }
      const messageId = isUuid(result.messageId) ? result.messageId : `customer-${Date.now()}`;
      setMessages((current) => [...current, {
        id: messageId,
        sender: 'customer',
        text,
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        status: 'delivered',
      }]);
      setDraft('');
      const conversationId = activeConversationId || (isUuid(result.conversationId) ? result.conversationId : null);
      if (conversationId) {
        storeConversationId(conversationId);
        await syncMessages(conversationId);
        await syncConversationHistory();
      }
    } catch (error) {
      const message = error instanceof Error && error.message !== 'Failed to fetch'
        ? error.message
        : 'Message could not be sent. Please try again.';
      setSendError(message);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  };

  useEffect(() => {
    if (!threadRef.current) return;
    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const activeConversationSummary = conversationHistory.find((conversation) => conversation.conversationId === activeConversationId);
  const activeConversationClosed = activeConversationSummary?.status === 'resolved';
  const widgetClassName = ['jai-support-widget', isOpen ? 'is-open' : '', className].filter(Boolean).join(' ');

  return (
    <div className={widgetClassName}>
      {isOpen && (
        <div className="jai-support-shell" role="dialog" aria-label={`${productName} Support`}>
          <header className="jai-support-header">
            {screen === 'conversation' ? (
              <div className="jai-support-conversation-header">
                <button
                  className="jai-support-back"
                  type="button"
                  aria-label="Back to conversation list"
                  onClick={() => setScreen('home')}
                >
                  <span aria-hidden="true">←</span>
                </button>
                <div className="jai-support-header-copy">
                  <strong>{productName} Support</strong>
                  <span>{conversationHistory.find((conversation) => conversation.conversationId === activeConversationId)?.status === 'resolved' ? 'Closed' : 'Typically replies in a few minutes'}</span>
                </div>
              </div>
            ) : (
              <div className="jai-support-header-copy">
                <strong>{productName} Support</strong>
                <span>Powered by JAI</span>
              </div>
            )}
            <div className="jai-support-header-actions">
              <button className="jai-support-menu" type="button" aria-label="Open support menu">
                <i /><i /><i />
              </button>
              <button
                className="jai-support-close"
                type="button"
                aria-label="Close JAI support chat"
                onClick={closeWidget}
              >
                <span />
                <span />
              </button>
            </div>
          </header>
          <div className={`jai-support-body${activeConversationClosed ? ' is-closed' : ''}`}>
            {screen === 'home' ? (
              <div className="jai-support-home">
                <div className="jai-support-welcome-icon" aria-hidden="true">
                  <svg viewBox="0 0 74 74">
                    <path d="M37 0C16.565 0 0 16.565 0 37s16.565 37 37 37c7 0 13.25-1.95 18.65-4.95 5 .05 9.55 2.5 14.2 4.1 1.75.6 3.05-.9 2.4-2.65-1.8-5.1-2.45-10.1-1.3-15.45C72.85 49.7 74 43.5 74 37 74 16.565 57.435 0 37 0Z" />
                  </svg>
                  <span className="jai-support-welcome-dots"><i /><i /><i /></span>
                </div>
                <p className="jai-support-eyebrow">Hi there 👋</p>
                <h1>How can we help?</h1>
                <p className="jai-support-intro">
                  Start a conversation with the {productName} support team. We&apos;re here to help you get the most from your experience.
                </p>

                <button className="jai-support-start" type="button" onClick={startNewConversation}>
                  <span className="jai-support-send-icon" aria-hidden="true" />
                  <strong>Start a conversation</strong>
                  <span className="jai-support-arrow" aria-hidden="true" />
                </button>

                <div className="jai-support-recent-heading">
                  <h2>Recent conversations</h2>
                  <button type="button" className="jai-support-see-all">See all <span aria-hidden="true">&gt;</span></button>
                </div>
                <div className="jai-support-identity">
                  {identitySaved ? <span className="jai-support-identity-confirmation">Details saved</span> : <form onSubmit={(event) => { event.preventDefault(); void saveIdentity(); }}>
                    <strong>Stay connected</strong>
                    <span>Optional: add your name and email for future support.</span>
                    <input aria-label="Your name" placeholder="Your name" value={identityDraft.name} onChange={(event) => setIdentityDraft((current) => ({ ...current, name: event.target.value }))} />
                    <input aria-label="Your email" type="email" placeholder="Your email" value={identityDraft.email} onChange={(event) => setIdentityDraft((current) => ({ ...current, email: event.target.value }))} />
                    <button type="submit" disabled={identitySaving || (!identityDraft.name.trim() && !identityDraft.email.trim())}>{identitySaving ? 'Saving...' : 'Save details'}</button>
                    {identityError && <small role="alert">{identityError}</small>}
                  </form>}
                </div>
                <div className="jai-support-conversations">
                  {conversationHistory.map((conversation) => <button className="jai-support-conversation" type="button" key={conversation.conversationId} onClick={() => openConversation(conversation.conversationId)}>
                    <span className="jai-support-row-icon" aria-hidden="true">◌</span>
                    <span className="jai-support-row-copy">
                      <strong>{conversation.latestMessagePreview || 'Conversation'}</strong>
                      <span>{conversation.status}</span>
                    </span>
                    <time>{formatHistoryTime(conversation.latestMessageAt || conversation.updatedAt)}</time>
                  </button>)}
                </div>
              </div>
            ) : (
              <div className={`jai-support-conversation-screen${activeConversationClosed ? ' is-closed' : ''}`}>
                <div className="jai-support-thread" ref={threadRef} aria-live="polite">
                  {messages.map((message) => (
                    <div key={message.id} className={`jai-support-message-row ${message.sender}`}>
                      {message.sender === 'support' && (
                        <span className="jai-support-support-avatar" aria-hidden="true">J</span>
                      )}
                      <div className="jai-support-message-content">
                        <div className="jai-support-bubble">
                          <p>{message.text}</p>
                        </div>
                        <div className="jai-support-meta">
                          <time>{message.time}</time>
                          {message.sender === 'customer' && message.status && (
                            <span className="jai-support-read" aria-label="Read status">
                              {message.status === 'read' ? '✓✓' : '✓'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {activeConversationClosed ? <div className="jai-support-closed-panel">
                  <div className="jai-support-feedback">
                    <div className="jai-support-rating-emblem" aria-hidden="true"><span>★</span></div>
                    <div className="jai-support-feedback-intro"><strong>How was your support experience?</strong><span>Your feedback helps us improve and means a lot to the team.</span><span>Please take a moment to rate this conversation.</span></div>
                    {!feedbackSubmitted ? <form onSubmit={(event) => { event.preventDefault(); void submitFeedback(); }}>
                      <div className="jai-support-rating-options" role="radiogroup" aria-label="Support rating">{[1, 2, 3, 4, 5].map((rating) => <button type="button" role="radio" aria-checked={feedbackRating === rating} className={feedbackRating !== null && rating <= feedbackRating ? 'is-selected' : ''} key={rating} onClick={() => setFeedbackRating(rating)} disabled={feedbackSaving} aria-label={`${rating} star${rating === 1 ? '' : 's'}`}><span className="jai-support-rating-star">★</span><span className="jai-support-rating-number">{rating}</span><span className="jai-support-rating-label">{['Very poor', 'Poor', 'Okay', 'Good', 'Excellent'][rating - 1]}</span></button>)}</div>
                      <div className="jai-support-review-wrap"><textarea aria-label="Tell us more" placeholder="Tell us more (optional)..." maxLength={500} value={feedbackReview} onChange={(event) => setFeedbackReview(event.target.value)} disabled={feedbackSaving} /><span>{feedbackReview.length}/500</span></div>
                      <button className="jai-support-feedback-submit" type="submit" disabled={feedbackRating === null || feedbackSaving}>{feedbackSaving ? 'Submitting...' : 'Submit feedback'}</button>
                      {feedbackError && <small role="alert">{feedbackError}</small>}
                      <div className="jai-support-privacy"><span aria-hidden="true">&#128274;</span> Your feedback is private and helps us serve you better.</div>
                    </form> : <div className="jai-support-feedback-thanks"><div className="jai-support-rating-options is-readonly" aria-label={`${feedbackRating} out of 5 stars`}>{[1, 2, 3, 4, 5].map((star) => <span className={star <= (feedbackRating || 0) ? 'is-selected' : ''} key={star}><span className="jai-support-rating-star">★</span><span className="jai-support-rating-number">{star}</span></span>)}</div><strong>Thanks for your feedback</strong>{feedbackReview && <p>{feedbackReview}</p>}</div>}
                  </div>
                  <div className="jai-support-closed-state"><div className="jai-support-closed-copy"><span className="jai-support-closed-icon" aria-hidden="true">◔</span><span><strong>Closed conversation</strong><small>You can still view this conversation</small></span></div><button type="button" onClick={startNewConversation}>Start a new conversation <span aria-hidden="true">›</span></button></div>
                </div> : <div className="jai-support-composer">
                  <button type="button" className="jai-support-attach" aria-label="Attach file" disabled={isSending}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M9.5 12.8 15.9 6.4A3 3 0 0 1 20 10.5l-8.7 8.7a5 5 0 0 1-7.1-7.1l9.3-9.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <textarea
                    ref={messageInputRef}
                    className="jai-support-composer-input"
                    aria-label="Write a message"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="Write a message..."
                    rows={1}
                    disabled={isSending || activeConversationClosed}
                  />
                  <button type="button" className="jai-support-send" aria-label="Send message" onClick={() => void sendMessage()} disabled={isSending || !draft.trim() || activeConversationClosed}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3 11.7 20 4l-4.4 16-3.7-6.1-8.9-2.2Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
                    </svg>
                  </button>
                  {sendError && <p className="jai-support-send-error" role="alert">{sendError}</p>}
                </div>}
              </div>
            )}
          </div>
          <footer className="jai-support-footer">
            <strong>{productName} Support</strong>
            <span>Powered by JAI</span>
          </footer>
        </div>
      )}

      <div className="jai-support-launcher-wrap">
        <div className="jai-support-message" aria-hidden="true">
          <strong>Need help?</strong>
          <span>Chat with our support team.</span>
        </div>

        <button
          className="jai-support-launcher"
          type="button"
          aria-expanded={isOpen}
          aria-label={isOpen ? 'Close JAI support chat' : 'Open JAI support chat'}
          onClick={toggleWidget}
        >
          <svg className="jai-support-launcher-art" viewBox="0 0 74 74" aria-hidden="true">
            <path d="M37 0C16.565 0 0 16.565 0 37s16.565 37 37 37c7 0 13.25-1.95 18.65-4.95 5 .05 9.55 2.5 14.2 4.1 1.75.6 3.05-.9 2.4-2.65-1.8-5.1-2.45-10.1-1.3-15.45C72.85 49.7 74 43.5 74 37 74 16.565 57.435 0 37 0Z" fill="currentColor" />
          </svg>
          <span className="jai-support-icon" aria-hidden="true">
            <span className="jai-support-dots"><i /><i /><i /></span>
            <span className="jai-support-smile" />
          </span>
        </button>
      </div>
    </div>
  );
}

export default JaiSupportWidget;