// Language-neutral JAI Connect Read Protocol v1 envelope.
// This module defines no transport, authentication, or product data schema.
export const JAI_CONNECT_READ_VERSION = 1 as const;
export const JAI_CONNECT_READ_CAPABILITIES = [
  'customer.profile.read',
  'customer.subscription.read',
  'billing.payment.read',
  'diagnostics.read',
] as const;
export type JaiConnectReadCapability = typeof JAI_CONNECT_READ_CAPABILITIES[number];
export type JaiConnectJson = null | boolean | number | string | JaiConnectJson[] | { [key: string]: JaiConnectJson };

export interface JaiConnectReadRequest {
  version: typeof JAI_CONNECT_READ_VERSION;
  request_id: string;
  app_id: string;
  capability: JaiConnectReadCapability;
  customer: { external_subject: string };
}

export interface JaiConnectReadResponse {
  version: typeof JAI_CONNECT_READ_VERSION;
  request_id: string;
  capability: JaiConnectReadCapability;
  observed_at: string;
  data: { [key: string]: JaiConnectJson };
}

export const JAI_CONNECT_READ_MAX_REQUEST_BYTES = 4096;
export const JAI_CONNECT_READ_MAX_RESPONSE_BYTES = 16384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function boundedBytes(value: unknown, max: number): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' && new TextEncoder().encode(encoded).length <= max;
  } catch { return false; }
}
function json(value: unknown, depth = 0): value is JaiConnectJson {
  if (depth > 5) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 2048;
  if (Array.isArray(value)) return value.length <= 50 && value.every(item => json(item, depth + 1));
  if (!object(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 64 && entries.every(([key, item]) =>
    key.length <= 100 && !['__proto__', 'constructor', 'prototype'].includes(key) && json(item, depth + 1));
}
export function isJaiConnectReadCapability(value: unknown): value is JaiConnectReadCapability {
  return typeof value === 'string' &&
    (JAI_CONNECT_READ_CAPABILITIES as readonly string[]).includes(value);
}
export function isJaiConnectReadRequest(value: unknown): value is JaiConnectReadRequest {
  if (!object(value) || !keys(value, ['version', 'request_id', 'app_id', 'capability', 'customer']) ||
    value.version !== JAI_CONNECT_READ_VERSION || typeof value.request_id !== 'string' || !UUID.test(value.request_id) ||
    typeof value.app_id !== 'string' || !UUID.test(value.app_id) || !isJaiConnectReadCapability(value.capability) ||
    !object(value.customer) || !keys(value.customer, ['external_subject'])) return false;
  const subject = value.customer.external_subject;
  return typeof subject === 'string' && subject.trim().length > 0 && subject.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(subject) && boundedBytes(value, JAI_CONNECT_READ_MAX_REQUEST_BYTES);
}
export function isJaiConnectReadResponse(value: unknown): value is JaiConnectReadResponse {
  return object(value) && keys(value, ['version', 'request_id', 'capability', 'observed_at', 'data']) &&
    value.version === JAI_CONNECT_READ_VERSION &&
    typeof value.request_id === 'string' && UUID.test(value.request_id) &&
    isJaiConnectReadCapability(value.capability) &&
    typeof value.observed_at === 'string' && value.observed_at.length <= 40 &&
    RFC3339.test(value.observed_at) && Number.isFinite(Date.parse(value.observed_at)) &&
    object(value.data) && json(value.data) &&
    boundedBytes(value, JAI_CONNECT_READ_MAX_RESPONSE_BYTES);
}
