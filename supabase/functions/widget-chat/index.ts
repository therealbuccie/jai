// Jai tokens are validated below; deploy with verify_jwt = false.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 65536;

class InputError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "input_error") { super(message); }
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ChatInput =
  | { action: "start_conversation"; message: string }
  | { action: "send_message"; conversationId: string; message: string }
  | { action: "get_messages"; conversationId: string }
  | { action: "list_conversations" }
   | { action: "identify_customer"; name: string | null; email: string | null }
   | { action: "submit_feedback"; conversationId: string; rating: number; review: string | null };

async function readInput(request: Request): Promise<ChatInput> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new InputError("Content-Type must be application/json", 415);
  }
  if (!request.body) throw new InputError("JSON body required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new InputError("Request body too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new InputError("Invalid JSON body"); }
  if (isObject(input) && input.action === "send_message") {
    if (Object.keys(input).some((key) => !["action", "conversationId", "message"].includes(key))) {
      throw new InputError("Expected action, conversationId and message only");
    }
    if (typeof input.conversationId !== "string" || !UUID.test(input.conversationId)) {
      throw new InputError("conversationId must be a UUID");
    }
    if (typeof input.message !== "string" || !input.message.trim()) {
      throw new InputError("message must be non-empty text");
    }
    return { action: "send_message", conversationId: input.conversationId, message: input.message.trim() };
  }
  if (isObject(input) && input.action === "get_messages") {
    if (Object.keys(input).some((key) => !["action", "conversationId"].includes(key))) {
      throw new InputError("Expected action and conversationId only");
    }
    if (typeof input.conversationId !== "string" || !UUID.test(input.conversationId)) {
      throw new InputError("conversationId must be a UUID");
    }
    return { action: "get_messages", conversationId: input.conversationId };
  }
  if (isObject(input) && input.action === "list_conversations") {
    if (Object.keys(input).some((key) => key !== "action")) {
      throw new InputError("Expected action only");
    }
    return { action: "list_conversations" };
  }
  if (isObject(input) && input.action === "identify_customer") {
    if (Object.keys(input).some((key) => !["action", "name", "email"].includes(key))) {
      throw new InputError("Expected action, name and email only");
    }
    const name = input.name === null ? null : typeof input.name === "string" ? input.name.trim() : undefined;
    const email = input.email === null ? null : typeof input.email === "string" ? input.email.trim() : undefined;
    if (name === undefined || email === undefined || (name !== null && (name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))) || (email !== null && (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)))) {
      throw new InputError("Invalid customer identity");
    }
    return { action: "identify_customer", name: name || null, email: email || null };
  }
  if (isObject(input) && input.action === "submit_feedback") {
    if (Object.keys(input).some((key) => !["action", "conversationId", "rating", "review"].includes(key))) {
      throw new InputError("Expected action, conversationId, rating and review only");
    }
    const review = input.review === null ? null : typeof input.review === "string" ? input.review.trim() : undefined;
    if (typeof input.conversationId !== "string" || !UUID.test(input.conversationId) ||
      typeof input.rating !== "number" || !Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5 ||
      review === undefined || (review !== null && review.length > 4000)) {
      throw new InputError("Invalid conversation feedback");
    }
    return { action: "submit_feedback", conversationId: input.conversationId, rating: input.rating, review: review || null };
  }
  if (!isObject(input) || Object.keys(input).some((key) => !["action", "message"].includes(key))) {
    throw new InputError("Expected action and message only");
  }
  if (input.action !== "start_conversation") throw new InputError("Unsupported action");
  if (typeof input.message !== "string" || !input.message.trim()) {
    throw new InputError("message must be non-empty text");
  }
  return { action: "start_conversation", message: input.message.trim() };
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") {
    const response = json(405, { error: "Method not allowed" });
    response.headers.set("Allow", "POST, OPTIONS");
    return response;
  }
  try {
    const authorization = request.headers.get("authorization");
    const bearer = authorization?.match(/^Bearer ([0-9a-f]{64})$/i);
    if (!bearer) throw new InputError("Valid Jai session required", 401);
    const input = await readInput(request);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return json(500, { error: "Chat service unavailable" });

    // Caller credentials never reach database requests or logs.
    async function database(path: string, method = "GET", body?: Record<string, unknown>, prefer = "return=minimal") {
      const response = await fetch(`${supabaseUrl!.replace(/\/$/, "")}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: serviceKey!,
          Authorization: `Bearer ${serviceKey!}`,
          "Content-Type": "application/json",
          Prefer: prefer,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Database request failed");
      }
      return response;
    }

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer[1]));
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const sessionResponse = await database(`customer_sessions?session_token_hash=eq.${tokenHash}&select=id,customer_id,app_id,expires_at,revoked_at&limit=1`);
    const sessions: unknown = await sessionResponse.json();
    if (!Array.isArray(sessions)) throw new Error("Invalid database response");
    if (sessions.length !== 1) throw new InputError("Invalid or expired session", 401);
    const session: unknown = sessions[0];
    if (!isObject(session) || typeof session.expires_at !== "string" ||
      !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.now() ||
      session.revoked_at !== null) {
      throw new InputError("Invalid or expired session", 401);
    }
    if (typeof session.id !== "string" || !UUID.test(session.id) ||
      typeof session.customer_id !== "string" || !UUID.test(session.customer_id) ||
      typeof session.app_id !== "string" || !UUID.test(session.app_id)) {
      throw new Error("Invalid database response");
    }
    const appResponse = await database(`apps?id=eq.${session.app_id}&status=eq.active&select=id&limit=1`);
    const apps: unknown = await appResponse.json();
    if (!Array.isArray(apps)) throw new Error("Invalid database response");
    if (apps.length !== 1) throw new InputError("Active app required", 403);

    // Best effort after persistence. Recheck routing using session-scoped ownership;
    // finalization also guards against handoff/close after this eligibility read.
    const aiJobAppId = session.app_id;
    const aiJobCustomerId = session.customer_id;
    async function enqueueAiJob(messageId: string, conversationId: string) {
      try {
        const response = await database(
          `conversations?id=eq.${conversationId}&customer_id=eq.${aiJobCustomerId}&app_id=eq.${aiJobAppId}&select=id,status,handler&limit=1`,
        );
        const rows: unknown = await response.json();
        if (!Array.isArray(rows) || rows.length !== 1 || !isObject(rows[0]) ||
          rows[0].handler !== "automation" || typeof rows[0].status !== "string" ||
          rows[0].status === "resolved") return;
        await database("ai_jobs?on_conflict=source_message_id", "POST", {
          source_message_id: messageId,
          conversation_id: conversationId,
          app_id: aiJobAppId,
        }, "return=minimal,resolution=ignore-duplicates");
        // Wake after enqueue; the worker claims its own job. Never await generation.
        EdgeRuntime.waitUntil((async () => {
          try {
            const wake = await fetch(`${supabaseUrl!.replace(/\/$/, "")}/functions/v1/ai-runtime`, {
              method: "POST",
              headers: { Authorization: `Bearer ${serviceKey!}`, apikey: serviceKey! },
              redirect: "error",
              signal: AbortSignal.timeout(120000),
            });
            await wake.body?.cancel();
            if (!wake.ok) console.error("AI runtime wake failed");
          } catch {
            // Do not log request details, credentials or provider errors.
            console.error("AI runtime wake failed");
          }
        })());
      } catch {
        // Never turn an already-saved customer message into a send failure.
        console.error("AI job enqueue failed");
      }
    }

    if (input.action === "get_messages") {
      const conversationId = input.conversationId;
      const conversationPath = `conversations?id=eq.${conversationId}&customer_id=eq.${session.customer_id}&app_id=eq.${session.app_id}`;
      const conversationResponse = await database(`${conversationPath}&select=id&limit=1`);
      const conversations: unknown = await conversationResponse.json();
      if (!Array.isArray(conversations)) throw new Error("Invalid database response");
      if (conversations.length !== 1) throw new InputError("Conversation not found", 404);

      const messagesResponse = await database(
        `messages?conversation_id=eq.${conversationId}&sender_type=in.(customer,human_agent,automation)&message_type=eq.text&select=id,conversation_id,sender_type,status,content,created_at&order=created_at.asc,id.asc`,
      );
      const messages: unknown = await messagesResponse.json();
      if (!Array.isArray(messages)) throw new Error("Invalid database response");
      await database(`customer_sessions?id=eq.${session.id}`, "PATCH", { last_seen_at: new Date().toISOString() });
      return json(200, { conversationId, messages });
    }

    if (input.action === "list_conversations") {
      const conversationResponse = await database(
        `conversations?customer_id=eq.${session.customer_id}&app_id=eq.${session.app_id}&select=id,status,created_at,updated_at&order=updated_at.desc`,
      );
      const conversations: unknown = await conversationResponse.json();
      if (!Array.isArray(conversations)) throw new Error("Invalid database response");
      const conversationIds = conversations.flatMap((value) => {
        if (!isObject(value) || typeof value.id !== "string" || !UUID.test(value.id)) return [];
        return [value.id];
      });
      if (conversationIds.length === 0) {
        await database(`customer_sessions?id=eq.${session.id}`, "PATCH", { last_seen_at: new Date().toISOString() });
        return json(200, { conversations: [] });
      }

      const messagesResponse = await database(
        `messages?conversation_id=in.(${conversationIds.join(",")})&sender_type=in.(customer,human_agent,automation)&message_type=eq.text&select=id,conversation_id,sender_type,content,created_at&order=created_at.desc,id.desc`,
      );
      const messages: unknown = await messagesResponse.json();
      if (!Array.isArray(messages)) throw new Error("Invalid database response");
      const latestByConversation = new Map<string, Record<string, unknown>>();
      for (const value of messages) {
        if (!isObject(value) || typeof value.conversation_id !== "string" || !UUID.test(value.conversation_id)) continue;
        if (!latestByConversation.has(value.conversation_id)) latestByConversation.set(value.conversation_id, value);
      }
      const feedbackResponse = await database(
        `conversation_feedback?conversation_id=in.(${conversationIds.join(",")})&select=conversation_id,rating,review_text,submitted_at`,
      );
      const feedbackRows: unknown = await feedbackResponse.json();
      if (!Array.isArray(feedbackRows)) throw new Error("Invalid database response");
      const feedbackByConversation = new Map<string, Record<string, unknown>>();
      for (const value of feedbackRows) {
        if (isObject(value) && typeof value.conversation_id === "string") feedbackByConversation.set(value.conversation_id, value);
      }
      const history = conversations.flatMap((value) => {
        if (!isObject(value) || typeof value.id !== "string" || !UUID.test(value.id) ||
          typeof value.status !== "string" || typeof value.created_at !== "string" || typeof value.updated_at !== "string") return [];
        const latest = latestByConversation.get(value.id);
        const feedback = feedbackByConversation.get(value.id);
        return [{
          conversationId: value.id,
          status: value.status,
          createdAt: value.created_at,
          updatedAt: value.updated_at,
          latestMessagePreview: latest && typeof latest.content === "string" ? latest.content : null,
          latestMessageAt: latest && typeof latest.created_at === "string" ? latest.created_at : null,
          feedbackRating: feedback && typeof feedback.rating === "number" ? feedback.rating : null,
          feedbackReview: feedback && typeof feedback.review_text === "string" ? feedback.review_text : null,
          feedbackSubmittedAt: feedback && typeof feedback.submitted_at === "string" ? feedback.submitted_at : null,
        }];
      }).sort((left, right) => Date.parse(right.latestMessageAt || right.updatedAt) - Date.parse(left.latestMessageAt || left.updatedAt)).slice(0, 10);
      await database(`customer_sessions?id=eq.${session.id}`, "PATCH", { last_seen_at: new Date().toISOString() });
      return json(200, { conversations: history });
    }

    if (input.action === "submit_feedback") {
      const conversationId = input.conversationId;
      const conversationResponse = await database(
        `conversations?id=eq.${conversationId}&customer_id=eq.${session.customer_id}&app_id=eq.${session.app_id}&select=id,status,customer_id,app_id,assigned_agent_id&limit=1`,
      );
      const conversations: unknown = await conversationResponse.json();
      if (!Array.isArray(conversations) || conversations.length !== 1) throw new InputError("Conversation not found", 404);
      const conversation = conversations[0];
      if (!isObject(conversation) || conversation.status !== "resolved" || conversation.customer_id !== session.customer_id || conversation.app_id !== session.app_id) {
        throw new InputError("Closed conversation required", 409, "conversation_not_closed");
      }
      const existingResponse = await database(`conversation_feedback?conversation_id=eq.${conversationId}&select=id&limit=1`);
      const existing: unknown = await existingResponse.json();
      if (!Array.isArray(existing)) throw new Error("Invalid database response");
      if (existing.length > 0) throw new InputError("Feedback already submitted", 409, "feedback_already_submitted");

      const assignmentsResponse = await database(`conversation_assignments?conversation_id=eq.${conversationId}&select=agent_id`);
      const assignments: unknown = await assignmentsResponse.json();
      if (!Array.isArray(assignments)) throw new Error("Invalid database response");
      const agentIds = new Set<string>();
      if (typeof conversation.assigned_agent_id === "string" && UUID.test(conversation.assigned_agent_id)) agentIds.add(conversation.assigned_agent_id);
      for (const assignment of assignments) {
        if (isObject(assignment) && typeof assignment.agent_id === "string" && UUID.test(assignment.agent_id)) agentIds.add(assignment.agent_id);
      }
      const humanMessagesResponse = await database(`messages?conversation_id=eq.${conversationId}&sender_type=eq.human_agent&select=sender_id`);
      const humanMessages: unknown = await humanMessagesResponse.json();
      if (!Array.isArray(humanMessages)) throw new Error("Invalid database response");
      for (const message of humanMessages) {
        if (isObject(message) && typeof message.sender_id === "string" && UUID.test(message.sender_id)) agentIds.add(message.sender_id);
      }
      const attributedAgentId = agentIds.size === 1 ? [...agentIds][0] : null;
      const feedbackId = crypto.randomUUID();
      await database("conversation_feedback", "POST", {
        id: feedbackId,
        conversation_id: conversationId,
        customer_id: session.customer_id,
        app_id: session.app_id,
        attributed_agent_id: attributedAgentId,
        rating: input.rating,
        review_text: input.review,
      });
      return json(201, { feedbackId, conversationId, rating: input.rating, review: input.review, attributed: attributedAgentId !== null });
    }

    if (input.action === "identify_customer") {
      await database(`customers?id=eq.${session.customer_id}`, "PATCH", {
        display_name: input.name,
        email: input.email,
      });
      await database(`customer_sessions?id=eq.${session.id}`, "PATCH", { last_seen_at: new Date().toISOString() });
      return json(200, { customerId: session.customer_id, name: input.name, email: input.email, identityLevel: "anonymous" });
    }

    if (input.action === "send_message") {
      const conversationId = input.conversationId;
      const conversationPath = `conversations?id=eq.${conversationId}&customer_id=eq.${session.customer_id}&app_id=eq.${session.app_id}`;
      const conversationResponse = await database(`${conversationPath}&select=id,status,handler&limit=1`);
      const conversations: unknown = await conversationResponse.json();
      if (!Array.isArray(conversations)) throw new Error("Invalid database response");
      if (conversations.length !== 1) throw new InputError("Conversation not found", 404);
      const conversation: unknown = conversations[0];
      if (!isObject(conversation) || typeof conversation.status !== "string") {
        throw new Error("Invalid database response");
      }
      if (conversation.status === "resolved") throw new InputError("Conversation is closed", 409, "conversation_closed");
      const messageId = crypto.randomUUID();
      try {
        await database("messages", "POST", {
          id: messageId,
          conversation_id: conversationId,
          sender_type: "customer",
          sender_id: session.customer_id,
          message_type: "text",
          content: input.message,
          status: "sent",
        });
      } catch {
        return json(500, { error: "Unable to send message" });
      }
      // Persistence is authoritative; enqueue and each timestamp update are isolated.
      if (conversation.handler === "automation") await enqueueAiJob(messageId, conversationId);
      const now = new Date().toISOString();
      await database(conversationPath, "PATCH", { updated_at: now })
        .catch(() => { console.error("Conversation timestamp update failed"); });
      await database(`customer_sessions?id=eq.${session.id}`, "PATCH", { last_seen_at: now })
        .catch(() => { console.error("Session timestamp update failed"); });
      return json(201, { messageId, conversationId });
    }

    // Record authenticated activity before creating records to avoid reporting
    // a completed conversation as failed solely because this update failed.
    await database(`customer_sessions?id=eq.${session.id}`, "PATCH", { last_seen_at: new Date().toISOString() });
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    try {
      await database("conversations", "POST", {
        id: conversationId,
        customer_id: session.customer_id,
        app_id: session.app_id,
        channel: "widget",
        status: "open",
        handler: "automation",
      });
      await database("messages", "POST", {
        id: messageId,
        conversation_id: conversationId,
        sender_type: "customer",
        sender_id: session.customer_id,
        message_type: "text",
        content: input.message,
        status: "sent",
      });
    } catch {
      // Best-effort compensation scoped to this request's generated ID.
      // A message committed before a network error may prevent deletion via FK.
      try { await database(`conversations?id=eq.${conversationId}`, "DELETE"); }
      catch { /* Never log tokens, secrets, or database errors. */ }
      return json(500, { error: "Unable to start conversation" });
    }
    await enqueueAiJob(messageId, conversationId);
    return json(201, { conversationId, messageId, status: "open", handler: "automation" });
  } catch (error) {
    if (error instanceof InputError) return json(error.status, { error: error.message, code: error.code });
    return json(500, { error: "Unable to start conversation" });
  }
});
