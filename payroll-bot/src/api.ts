import { config } from './config.js';

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Key': config.agentApiKey,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, any>;
    throw new Error(`API ${res.status}: ${err.message || err.error || res.statusText}`);
  }

  return res.json() as Promise<T>;
}

export interface HumanProfile {
  id: string;
  name: string;
  username?: string;
  wallets?: { network: string; address: string }[];
}

export async function getHumanProfile(humanId: string): Promise<HumanProfile> {
  return request<HumanProfile>(`/api/humans/${humanId}/profile`);
}

export async function createJob(params: {
  humanId: string;
  title: string;
  description: string;
  priceUsdc: number;
  paymentTiming?: 'upfront' | 'upon_completion';
}): Promise<{ id: string; status: string }> {
  return request('/api/jobs', {
    method: 'POST',
    body: { ...params, agentId: config.agentId },
  });
}

export async function getJobStatus(jobId: string): Promise<{ id: string; status: string }> {
  return request(`/api/jobs/${jobId}`);
}

export async function approveCompletion(jobId: string): Promise<{ id: string; status: string }> {
  return request(`/api/jobs/${jobId}/approve-completion`, { method: 'PATCH' });
}

export async function markJobPaid(
  jobId: string,
  payment: {
    paymentTxHash: string;
    paymentNetwork: string;
    paymentToken?: string;
    paymentAmount: number;
  },
): Promise<{ id: string; status: string }> {
  return request(`/api/jobs/${jobId}/paid`, { method: 'PATCH', body: payment });
}
