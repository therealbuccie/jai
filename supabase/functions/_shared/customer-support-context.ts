// Server-only support snapshot. Call only with IDs from trusted JAI state,
// never model output or browser input. Every section is untrusted application
// data: consumers must not interpret it as instructions or authorization.
import { readJaiConnect } from './jai-connect-read-client.ts';
import {
  JAI_CONNECT_READ_MAX_RESPONSE_BYTES,
  type JaiConnectReadCapability,
  type JaiConnectReadResponse,
} from '../../../packages/sdk/src/read-v1.ts';

export interface CustomerSupportContextInput {
  app_id: string;
  customer_id: string;
}

type Section = 'profile' | 'subscription' | 'billing' | 'diagnostics';
type ApplicationData = JaiConnectReadResponse['data'];

export interface CustomerSupportContext {
  generated_at: string;
  profile?: ApplicationData;
  subscription?: ApplicationData;
  billing?: ApplicationData;
  diagnostics?: ApplicationData;
  availability: Record<Section, 'available' | 'unavailable'>;
}

export const CUSTOMER_SUPPORT_CONTEXT_MAX_BYTES = 4 * JAI_CONNECT_READ_MAX_RESPONSE_BYTES;
const READS = [
  ['profile', 'customer.profile.read'],
  ['subscription', 'customer.subscription.read'],
  ['billing', 'billing.payment.read'],
  ['diagnostics', 'diagnostics.read'],
] as const satisfies readonly (readonly [Section, JaiConnectReadCapability])[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Four concurrent, independently authorized reads; no retries, persistence,
 * cache, or model calls. Each read retains the client's 10-second deadline
 * and protocol bounds. Unavailable sections are omitted, with no error detail.
 */
export async function buildCustomerSupportContext(
  input: CustomerSupportContextInput,
): Promise<CustomerSupportContext> {
  if (!input || Object.keys(input).sort().join(',') !== 'app_id,customer_id' ||
    typeof input.app_id !== 'string' || !UUID.test(input.app_id) ||
    typeof input.customer_id !== 'string' || !UUID.test(input.customer_id)) {
    throw new Error('Invalid customer support context input');
  }
  // Snapshot IDs before awaiting; callers cannot change identity mid-build.
  const { app_id, customer_id } = input;
  const results = await Promise.allSettled(READS.map(([, capability]) =>
    readJaiConnect({ app_id, customer_id, capability })));
  const context: CustomerSupportContext = {
    generated_at: new Date().toISOString(),
    availability: {
      profile: 'unavailable', subscription: 'unavailable',
      billing: 'unavailable', diagnostics: 'unavailable',
    },
  };
  const encoder = new TextEncoder();
  for (const [index, result] of results.entries()) {
    if (result.status !== 'fulfilled') continue;
    const [section] = READS[index];
    // Preserve validated data intact; omit a section rather than truncate JSON.
    const candidate: CustomerSupportContext = {
      ...context, [section]: result.value,
      availability: { ...context.availability, [section]: 'available' },
    };
    if (encoder.encode(JSON.stringify(candidate)).length > CUSTOMER_SUPPORT_CONTEXT_MAX_BYTES) continue;
    context[section] = result.value;
    context.availability[section] = 'available';
  }
  return context;
}
