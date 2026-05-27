export type DigestMode = 'last24h' | 'last24messages';

export type StartDigestJobPayload = {
  channelId: number;
  regenerate?: boolean;
  digestMode?: DigestMode;
};

export type DigestJobPayload = {
  jobId: string;
};

export type DigestActionResponse = {
  summary: string;
  channelId: number;
  channelName: string;
  model: string;
  generatedAt: number;
  messageCount: number;
  since: number;
  nextAllowedAt: number;
  nextRegenerateAt: number;
  regenerated: boolean;
  digestMode: DigestMode;
};

export type DigestJobStatus = 'pending' | 'completed' | 'failed';

export type DigestQuotaResponse = {
  balance: number;
  maxBalance: number;
  refillAmount: number;
  nextRefillAt?: number;
  requestCooldownRemainingMs: number;
  nextRequestAllowedAt?: number;
  startCost: number;
  regenerateCost: number;
};

export type StartDigestJobResponse = {
  jobId: string;
  status: DigestJobStatus;
  queuePosition?: number;
  quota: DigestQuotaResponse;
};

export type DigestJobResponse = {
  jobId: string;
  status: DigestJobStatus;
  queuePosition?: number;
  result?: DigestActionResponse;
  error?: string;
};

export type OllamaStatusResponse = {
  available: boolean;
  checkedAt: number;
  error?: string;
};

export type DigestPluginHealthResponse = {
  enabled: boolean;
};
