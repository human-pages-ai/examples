import { config } from './config.js';
import { isPaymentConfigured } from './pay.js';
import { confirm } from './prompt.js';
import { getX402Client } from './x402.js';
import type {
  Human,
  Job,
  Message,
  RegisterResponse,
  CreateJobResponse,
  PaidJobResponse,
  ReviewResponse,
  ActivationStatusResponse,
  ActivationCodeResponse,
  CreateListingResponse,
  ListingsResponse,
  ListingApplication,
  Listing,
} from './types.js';

// Retry delays in ms — exponential backoff matching the platform's webhook delivery pattern
const RETRY_DELAYS = [1000, 4000, 16000];

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query } = opts;

  let url = `${config.apiUrl}${path}`;
  if (query) {
    const params = new URLSearchParams(query);
    url += `?${params.toString()}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.agentApiKey) {
    headers['X-Agent-Key'] = config.agentApiKey;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      // Don't retry client errors (4xx) — they won't succeed on retry
      if (res.status >= 400 && res.status < 500) {
        const errorBody = await res.json().catch(() => ({})) as Record<string, any>;

        // ── x402 pay-per-use: intercept 402 and offer to pay ──
        if (res.status === 402) {
          // The 402 body may have PaymentRequired spread at top level (rate-limit)
          // or nested under paymentRequired (requireActiveOrPaid). Handle both.
          const paymentRequired = errorBody.paymentRequired || errorBody;

          if (!paymentRequired.accepts?.length) {
            throw new Error(
              `API 402: ${errorBody.message || 'Payment required (no x402 payment options available)'}`,
            );
          }

          // Display price from the friendliest source available
          const displayPrice = errorBody.x402?.price
            || errorBody.x402Price
            || `$${(Number(paymentRequired.accepts[0].amount) / 1e6).toFixed(2)}`;

          if (!isPaymentConfigured()) {
            throw new Error(
              `API 402: Payment required (${displayPrice} USDC). No wallet configured.\n`
              + 'Set up a wallet to enable x402 pay-per-use:\n'
              + '  npm run generate-keystore    (recommended)\n'
              + '  or set WALLET_PRIVATE_KEY     (for testing)',
            );
          }

          const ok = await confirm(`  API requires x402 payment of ${displayPrice} USDC on Base. Pay and retry?`);
          if (!ok) {
            throw new Error('API 402: Payment declined by operator');
          }

          const httpClient = await getX402Client();
          if (!httpClient) {
            throw new Error('API 402: Failed to initialize x402 payment client');
          }

          console.log('  Signing x402 payment authorization...');
          let paymentPayload;
          try {
            paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
          } catch (payErr) {
            throw new Error(`API 402: x402 payment signing failed: ${(payErr as Error).message}`);
          }

          // Retry the same request with the payment header
          const retryHeaders = { ...headers, 'x-payment': JSON.stringify(paymentPayload) };
          const retryRes = await fetch(url, {
            method,
            headers: retryHeaders,
            body: body ? JSON.stringify(body) : undefined,
          });

          if (!retryRes.ok) {
            const retryBody = await retryRes.json().catch(() => ({})) as Record<string, any>;
            throw new Error(
              `API ${retryRes.status} (after x402 payment): ${retryBody.message || retryBody.error || retryRes.statusText}`,
            );
          }

          console.log('  x402 payment accepted!');
          return (await retryRes.json()) as T;
        }

        if (res.status === 403 && errorBody.code === 'AGENT_PENDING') {
          throw new Error(
            'Agent is not yet activated. You must activate before performing this action.\n'
            + `Activate via social post (free, BASIC tier) or payment (PRO tier) at ${config.apiUrl}.`
          );
        }
        throw new Error(
          `API ${res.status}: ${errorBody.message || errorBody.error || res.statusText}`
        );
      }

      if (!res.ok) {
        throw new Error(`API ${res.status}: ${res.statusText}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err as Error;

      // Don't retry client errors
      if (lastError.message.startsWith('API 4')) {
        throw lastError;
      }

      // Wait before retry (if we have retries left)
      if (attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        console.log(`  Retrying in ${delay}ms (attempt ${attempt + 2}/${RETRY_DELAYS.length + 1})...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}

// ── API methods ──

export async function registerAgent(): Promise<RegisterResponse> {
  return request<RegisterResponse>('/api/agents/register', {
    method: 'POST',
    body: {
      name: config.agentName,
      description: config.agentDescription,
      contactEmail: config.agentContactEmail,
    },
  });
}

export async function searchHumans(params?: {
  lat?: number;
  lng?: number;
  radius?: number;
}): Promise<Human[]> {
  const query: Record<string, string> = { available: 'true' };
  if (params?.lat) query.lat = params.lat.toString();
  if (params?.lng) query.lng = params.lng.toString();
  if (params?.radius) query.radius = params.radius.toString();
  return request<Human[]>('/api/humans/search', { query });
}

export async function getHuman(humanId: string): Promise<Human> {
  return request<Human>(`/api/humans/${humanId}`);
}

export async function getHumanProfile(humanId: string): Promise<Human> {
  return request<Human>(`/api/humans/${humanId}/profile`);
}

export async function getActivationStatus(): Promise<ActivationStatusResponse> {
  return request<ActivationStatusResponse>('/api/agents/activate/status');
}

export async function requestActivationCode(): Promise<ActivationCodeResponse> {
  return request<ActivationCodeResponse>('/api/agents/activate/social', { method: 'POST' });
}

export async function verifySocialActivation(postUrl: string): Promise<{ status: string; tier: string }> {
  return request<{ status: string; tier: string }>('/api/agents/activate/social/verify', {
    method: 'POST',
    body: { postUrl },
  });
}

export async function getJob(jobId: string): Promise<Job> {
  return request<Job>(`/api/jobs/${jobId}`);
}

export async function createJob(params: {
  humanId: string;
  agentId: string;
  title: string;
  description: string;
  priceUsdc: number;
  callbackUrl?: string;
  callbackSecret?: string;
}): Promise<CreateJobResponse> {
  return request<CreateJobResponse>('/api/jobs', {
    method: 'POST',
    body: params,
  });
}

export async function markJobPaid(
  jobId: string,
  payment: {
    paymentTxHash: string;
    paymentNetwork: string;
    paymentToken?: string;
    paymentAmount: number;
  },
): Promise<PaidJobResponse> {
  return request<PaidJobResponse>(`/api/jobs/${jobId}/paid`, {
    method: 'PATCH',
    body: payment,
  });
}

export async function reviewJob(
  jobId: string,
  review: { rating: number; comment?: string },
): Promise<ReviewResponse> {
  return request<ReviewResponse>(`/api/jobs/${jobId}/review`, {
    method: 'POST',
    body: review,
  });
}

export async function sendMessage(jobId: string, content: string): Promise<Message> {
  return request<Message>(`/api/jobs/${jobId}/messages`, {
    method: 'POST',
    body: { content },
  });
}

export async function getMessages(jobId: string): Promise<Message[]> {
  return request<Message[]>(`/api/jobs/${jobId}/messages`);
}

// ── Listings (Job Board) ──

export async function createListing(params: {
  title: string;
  description: string;
  budgetUsdc: number;
  category?: string;
  requiredSkills?: string[];
  requiredEquipment?: string[];
  location?: string;
  workMode?: string;
  expiresAt: string;
  maxApplicants?: number;
  callbackUrl?: string;
  callbackSecret?: string;
}): Promise<CreateListingResponse> {
  return request<CreateListingResponse>('/api/listings', {
    method: 'POST',
    body: params,
  });
}

export async function getListings(params?: {
  page?: number;
  limit?: number;
  skill?: string;
}): Promise<ListingsResponse> {
  const query: Record<string, string> = {};
  if (params?.page) query.page = params.page.toString();
  if (params?.limit) query.limit = params.limit.toString();
  if (params?.skill) query.skill = params.skill;
  return request<ListingsResponse>('/api/listings', { query });
}

export async function getListing(id: string): Promise<Listing> {
  const data = await request<{ listing: Listing } & Listing>(`/api/listings/${id}`);
  // API may return listing directly or nested
  return data.listing ?? data;
}

export async function getListingApplications(listingId: string): Promise<ListingApplication[]> {
  const data = await request<{ applications: ListingApplication[] }>(`/api/listings/${listingId}/applications`);
  return data.applications ?? [];
}

export async function makeListingOffer(listingId: string, applicationId: string): Promise<{ jobId: string; status: string }> {
  return request<{ jobId: string; status: string }>(`/api/listings/${listingId}/applications/${applicationId}/offer`, {
    method: 'POST',
    body: { confirm: true },
  });
}

export async function cancelListing(listingId: string): Promise<void> {
  await request<unknown>(`/api/listings/${listingId}`, { method: 'DELETE' });
}
