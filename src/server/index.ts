import type { PluginContext, PluginSettings } from '@sharkord/plugin-sdk';
import { Database } from 'bun:sqlite';
import path from 'node:path';
import manifest from '../../manifest.json';
import type {
  DigestActionResponse,
  DigestJobPayload,
  DigestJobResponse,
  DigestJobStatus,
  DigestMode,
  DigestPluginHealthResponse,
  DigestQuotaResponse,
  OllamaStatusResponse,
  StartDigestJobPayload,
  StartDigestJobResponse
} from '../shared/types';

export type StoredMessage = {
  messageId: number;
  channelId: number;
  authorLabel: string;
  textContent: string;
  createdAt: number;
};

type OllamaResponse = {
  message?: {
    content?: string;
  };
  response?: string;
  error?: string;
};

type DbMessageRow = {
  id: number;
  channel_id: number;
  user_id: number | null;
  user_name: string | null;
  plugin_id: string | null;
  content: string | null;
  created_at: number;
};

type DbLatestMessageRow = {
  latest_created_at: number | null;
};

export type CoinLedgerEntry = {
  balance: number;
  lastRefillAt: number;
  lastRequestAt?: number;
  pendingCosts?: Record<string, number>;
};

export type CoinLedger = Record<string, CoinLedgerEntry>;

export type DigestSettingsSnapshot = {
  maxMessages: number;
  maxMessageLength: number;
  maxTranscriptChars: number;
  defaultPrompt: string;
  ollamaModel: string;
  ollamaUrl: string;
  coinRefillAmount: number;
  coinRefillHours: number;
  coinMaxBalance: number;
  requestCooldownMinutes: number;
  requestCooldownMs: number;
  maxConcurrentDigestJobs: number;
};

export type SettingsValidation =
  | {
      enabled: true;
      settings: DigestSettingsSnapshot;
    }
  | {
      enabled: false;
      invalidSettingKey: string;
      reason: string;
    };

export type DigestJob = {
  id: string;
  userId: number;
  channelId: number;
  channelName: string;
  model: string;
  regenerate: boolean;
  digestMode: DigestMode;
  status: DigestJobStatus;
  createdAt: number;
  cost: number;
  refunded: boolean;
  result?: DigestActionResponse;
  error?: string;
};

type DigestQueuedWork = {
  ctx: PluginContext;
  settings: DigestSettingsSnapshot;
  messages: StoredMessage[];
};

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const DIGEST_WINDOW_MS = 24 * ONE_HOUR_MS;
const OLLAMA_TIMEOUT_MS = 120_000;
const OLLAMA_STATUS_TIMEOUT_MS = 2_500;
const JOB_TTL_MS = 60 * ONE_MINUTE_MS;
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3:4b-instruct';
const DEFAULT_MAX_MESSAGES = 120;
const LAST_MESSAGES_DIGEST_COUNT = 24;
const DEFAULT_MAX_MESSAGE_LENGTH = 500;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 24_000;
const DEFAULT_COIN_REFILL_AMOUNT = 3;
const DEFAULT_COIN_REFILL_HOURS = 24;
const DEFAULT_COIN_MAX_BALANCE = 10;
const DEFAULT_REQUEST_COOLDOWN_MINUTES = 5;
const DEFAULT_MAX_CONCURRENT_DIGEST_JOBS = 1;
const DIGEST_COST = 1;
const COIN_LEDGER_SETTING = 'coinLedger';
const MAX_PROMPT_CHARS = 20_000;
const MAX_OLLAMA_URL_CHARS = 2048;
const MAX_MODEL_CHARS = 120;
const MAX_MESSAGES_SETTING = 1000;
const MAX_MESSAGE_LENGTH_SETTING = 5_000;
const MAX_TRANSCRIPT_CHARS_SETTING = 200_000;
const DISABLED_MESSAGE = 'This plugin is disabled. Contact admin.';

const DEFAULT_PROMPT = [
  'You are Sharkord Digest, a private assistant that summarizes a selected message window from a Discord-like text channel.',
  'Write a clear, useful recap in English. Be concise, but keep the details that help someone catch up quickly.',
  'Preserve the conversation intent and tone without copying long passages. Do not invent facts, dates, links, names, decisions, or action items.',
  'Respect the Window value provided by the user message: it may be the last 24 hours or the last 24 messages.',
  'Do not copy raw ISO timestamps into the title or recap. If a date or range is useful, write it in readable US English, for example "May 27, 2026, 7:54 AM CEST".',
  'Use Markdown and include only the sections that are relevant:',
  '- Highlights',
  '- Decisions',
  '- Action items',
  '- Open questions',
  '- Links and resources',
  '',
  'For each important point, mention the involved users only when it adds useful context.',
  'Ignore noise, repeated messages, greetings, bot-like clutter, and very short messages with no context.',
  'If the channel contains no meaningful discussion, say that there is not enough useful content to summarize.'
].join('\n');

const SETTINGS_DEFINITION = [
  {
    key: 'ollamaUrl',
    name: 'Ollama URL',
    description:
      'Default: http://127.0.0.1:11434. Min: 1 char. Max: 2048 chars. Must be an http(s) Ollama base URL.',
    type: 'string',
    defaultValue: DEFAULT_OLLAMA_URL
  },
  {
    key: 'ollamaModel',
    name: 'Ollama model',
    description:
      'Default: qwen3:4b-instruct. Min: 1 char. Max: 120 chars. Model name to use for digests.',
    type: 'string',
    defaultValue: DEFAULT_MODEL
  },
  {
    key: 'defaultPrompt',
    name: 'Default digest prompt',
    description:
      'Default: bundled English prompt. Min: 1 char. Max: 20000 chars. System prompt sent to Ollama before messages.',
    type: 'string',
    defaultValue: DEFAULT_PROMPT
  },
  {
    key: 'maxMessages',
    name: 'Maximum messages per digest',
    description:
      'Default: 120. Min: 1. Max: 1000. Sensitive parameter: higher values increase Ollama context and timeout risk.',
    type: 'number',
    defaultValue: DEFAULT_MAX_MESSAGES
  },
  {
    key: 'maxMessageLength',
    name: 'Maximum characters per message',
    description:
      'Default: 500. Min: 1. Max: 5000. Sensitive parameter: each message is truncated before Ollama sees it.',
    type: 'number',
    defaultValue: DEFAULT_MAX_MESSAGE_LENGTH
  },
  {
    key: 'maxTranscriptChars',
    name: 'Maximum transcript characters',
    description:
      'Default: 24000. Min: 1000. Max: 200000. Sensitive parameter: total transcript budget sent to Ollama.',
    type: 'number',
    defaultValue: DEFAULT_MAX_TRANSCRIPT_CHARS
  },
  {
    key: 'coinRefillAmount',
    name: 'Coin refill amount',
    description:
      'Default: 3. Min: 0. Max: 100. Coins added to each user at every refill. Use 0 to disable.',
    type: 'number',
    defaultValue: DEFAULT_COIN_REFILL_AMOUNT
  },
  {
    key: 'coinRefillHours',
    name: 'Coin refill hours',
    description: 'Default: 24. Min: 1. Max: 168. How often users receive more digest coins.',
    type: 'number',
    defaultValue: DEFAULT_COIN_REFILL_HOURS
  },
  {
    key: 'coinMaxBalance',
    name: 'Coin max balance',
    description: 'Default: 10. Min: 1. Max: 1000. Maximum number of digest coins one user can store.',
    type: 'number',
    defaultValue: DEFAULT_COIN_MAX_BALANCE
  },
  {
    key: 'requestCooldownMinutes',
    name: 'Request cooldown minutes',
    description:
      'Default: 5. Min: 0. Max: 1440. Minimum delay per user between two digest jobs. Use 0 to disable.',
    type: 'number',
    defaultValue: DEFAULT_REQUEST_COOLDOWN_MINUTES
  },
  {
    key: 'maxConcurrentDigestJobs',
    name: 'Maximum concurrent digest jobs',
    description:
      'Default: 1. Min: 1. Max: 10. How many Ollama digest jobs may run at the same time.',
    type: 'number',
    defaultValue: DEFAULT_MAX_CONCURRENT_DIGEST_JOBS
  },
  {
    key: COIN_LEDGER_SETTING,
    name: 'Internal coin ledger (JSON)',
    description:
      'Default: {}. Min: valid JSON object. Max: valid JSON object. Internal per-user quota state.',
    type: 'string',
    defaultValue: '{}'
  }
] as const;

type SettingsDefinition = typeof SETTINGS_DEFINITION;
type DigestSettings = PluginSettings<SettingsDefinition>;

const messagesByChannel = new Map<number, StoredMessage[]>();
const lastDigestByUserChannel = new Map<string, number>();
const lastRegenerateByUserChannel = new Map<string, number>();
const activeDigestUsers = new Set<number>();
const digestJobs = new Map<string, DigestJob>();
const queuedDigestJobIds: string[] = [];
const runningDigestJobIds = new Set<string>();
const digestWorkByJobId = new Map<string, DigestQueuedWork>();
let settingsRef: DigestSettings | undefined;
let unsubscribeMessages: (() => void) | undefined;
let settingsValidationWatcher: ReturnType<typeof setInterval> | undefined;
let lastLoggedSettingsValidationKey: string | undefined;
let ledgerChain: Promise<void> = Promise.resolve();

const runLedgerMutation = <T>(task: () => T): Promise<T> => {
  const next = ledgerChain.then(task, task);
  ledgerChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
};

const decodeBasicEntities = (content: string): string => {
  return content
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ');
};

const stripMessageHtml = (content: string): string => {
  return decodeBasicEntities(
    content
      .replace(/<img[^>]*ProseMirror-separator[^>]*>/gi, '')
      .replace(/<br[^>]*ProseMirror-trailingBreak[^>]*>/gi, '')
      .replace(/<command\b[^>]*>.*?<\/command>/gi, '')
      .replace(/<span[^>]*data-type="emoji"[^>]*>.*?<\/span>/gi, '')
      .replace(/<img[^>]*class="emoji-image"[^>]*\/?>/gi, '')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
};

const getDatabasePath = (ctx: PluginContext): string => {
  return path.resolve(ctx.path, '..', '..', 'db.sqlite');
};

type StrictParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      reason: string;
    };

const parseStrictInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
): StrictParseResult<number> => {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value === 'string' && !value.trim()) {
    return { ok: false, reason: `expected integer between ${min} and ${max}` };
  }

  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue)) {
    return { ok: false, reason: `expected integer between ${min} and ${max}` };
  }
  if (numericValue < min || numericValue > max) {
    return { ok: false, reason: `expected integer between ${min} and ${max}` };
  }

  return { ok: true, value: numericValue };
};

const parseStrictString = (
  value: unknown,
  fallback: string,
  minLength: number,
  maxLength: number
): StrictParseResult<string> => {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'string') {
    return { ok: false, reason: `expected string between ${minLength} and ${maxLength} chars` };
  }

  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    return { ok: false, reason: `expected string between ${minLength} and ${maxLength} chars` };
  }

  return { ok: true, value: trimmed };
};

const parseStrictOllamaUrl = (value: unknown): StrictParseResult<string> => {
  const parsed = parseStrictString(value, DEFAULT_OLLAMA_URL, 1, MAX_OLLAMA_URL_CHARS);
  if (!parsed.ok) return parsed;

  try {
    const url = new URL(parsed.value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { ok: false, reason: 'expected http(s) URL' };
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return { ok: true, value: url.toString().replace(/\/$/, '') };
  } catch {
    return { ok: false, reason: 'expected http(s) URL' };
  }
};

const validateCoinLedgerSetting = (value: unknown): StrictParseResult<true> => {
  if (value === undefined) return { ok: true, value: true };

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'expected valid JSON object' };
    }
    return { ok: true, value: true };
  } catch {
    return { ok: false, reason: 'expected valid JSON object' };
  }
};

const invalidSettings = (
  invalidSettingKey: string,
  reason: string
): SettingsValidation => ({
  enabled: false,
  invalidSettingKey,
  reason
});

const getSettingsValidation = (): SettingsValidation => {
  const ollamaUrl = parseStrictOllamaUrl(settingsRef?.get('ollamaUrl'));
  if (!ollamaUrl.ok) return invalidSettings('ollamaUrl', ollamaUrl.reason);

  const ollamaModel = parseStrictString(
    settingsRef?.get('ollamaModel'),
    DEFAULT_MODEL,
    1,
    MAX_MODEL_CHARS
  );
  if (!ollamaModel.ok) return invalidSettings('ollamaModel', ollamaModel.reason);

  const defaultPrompt = parseStrictString(
    settingsRef?.get('defaultPrompt'),
    DEFAULT_PROMPT,
    1,
    MAX_PROMPT_CHARS
  );
  if (!defaultPrompt.ok) return invalidSettings('defaultPrompt', defaultPrompt.reason);

  const maxMessages = parseStrictInteger(
    settingsRef?.get('maxMessages'),
    DEFAULT_MAX_MESSAGES,
    1,
    MAX_MESSAGES_SETTING
  );
  if (!maxMessages.ok) return invalidSettings('maxMessages', maxMessages.reason);

  const maxMessageLength = parseStrictInteger(
    settingsRef?.get('maxMessageLength'),
    DEFAULT_MAX_MESSAGE_LENGTH,
    1,
    MAX_MESSAGE_LENGTH_SETTING
  );
  if (!maxMessageLength.ok) {
    return invalidSettings('maxMessageLength', maxMessageLength.reason);
  }

  const maxTranscriptChars = parseStrictInteger(
    settingsRef?.get('maxTranscriptChars'),
    DEFAULT_MAX_TRANSCRIPT_CHARS,
    1_000,
    MAX_TRANSCRIPT_CHARS_SETTING
  );
  if (!maxTranscriptChars.ok) {
    return invalidSettings('maxTranscriptChars', maxTranscriptChars.reason);
  }

  const coinRefillAmount = parseStrictInteger(
    settingsRef?.get('coinRefillAmount'),
    DEFAULT_COIN_REFILL_AMOUNT,
    0,
    100
  );
  if (!coinRefillAmount.ok) {
    return invalidSettings('coinRefillAmount', coinRefillAmount.reason);
  }

  const coinRefillHours = parseStrictInteger(
    settingsRef?.get('coinRefillHours'),
    DEFAULT_COIN_REFILL_HOURS,
    1,
    168
  );
  if (!coinRefillHours.ok) return invalidSettings('coinRefillHours', coinRefillHours.reason);

  const coinMaxBalance = parseStrictInteger(
    settingsRef?.get('coinMaxBalance'),
    DEFAULT_COIN_MAX_BALANCE,
    1,
    1000
  );
  if (!coinMaxBalance.ok) return invalidSettings('coinMaxBalance', coinMaxBalance.reason);

  const requestCooldownMinutes = parseStrictInteger(
    settingsRef?.get('requestCooldownMinutes'),
    DEFAULT_REQUEST_COOLDOWN_MINUTES,
    0,
    1440
  );
  if (!requestCooldownMinutes.ok) {
    return invalidSettings('requestCooldownMinutes', requestCooldownMinutes.reason);
  }

  const maxConcurrentDigestJobs = parseStrictInteger(
    settingsRef?.get('maxConcurrentDigestJobs'),
    DEFAULT_MAX_CONCURRENT_DIGEST_JOBS,
    1,
    10
  );
  if (!maxConcurrentDigestJobs.ok) {
    return invalidSettings('maxConcurrentDigestJobs', maxConcurrentDigestJobs.reason);
  }

  const coinLedger = validateCoinLedgerSetting(settingsRef?.get(COIN_LEDGER_SETTING));
  if (!coinLedger.ok) return invalidSettings(COIN_LEDGER_SETTING, coinLedger.reason);

  return {
    enabled: true,
    settings: {
      maxMessages: maxMessages.value,
      maxMessageLength: maxMessageLength.value,
      maxTranscriptChars: maxTranscriptChars.value,
      defaultPrompt: defaultPrompt.value,
      ollamaModel: ollamaModel.value,
      ollamaUrl: ollamaUrl.value,
      coinRefillAmount: coinRefillAmount.value,
      coinRefillHours: coinRefillHours.value,
      coinMaxBalance: coinMaxBalance.value,
      requestCooldownMinutes: requestCooldownMinutes.value,
      requestCooldownMs: requestCooldownMinutes.value * ONE_MINUTE_MS,
      maxConcurrentDigestJobs: maxConcurrentDigestJobs.value
    }
  };
};

const getSettings = (): DigestSettingsSnapshot => {
  const validation = getSettingsValidation();
  if (validation.enabled) return validation.settings;
  throw new Error(DISABLED_MESSAGE);
};

const logSettingsValidationIfDisabled = (
  ctx: PluginContext,
  validation = getSettingsValidation()
): boolean => {
  if (validation.enabled) {
    lastLoggedSettingsValidationKey = undefined;
    return true;
  }

  const validationKey = `${validation.invalidSettingKey}:${validation.reason}`;
  if (lastLoggedSettingsValidationKey !== validationKey) {
    ctx.error(
      `Invalid setting ${validation.invalidSettingKey}: ${validation.reason}. Digest plugin is disabled.`
    );
    lastLoggedSettingsValidationKey = validationKey;
  }
  return false;
};

const startSettingsValidationWatcher = (ctx: PluginContext): void => {
  if (settingsValidationWatcher) clearInterval(settingsValidationWatcher);

  logSettingsValidationIfDisabled(ctx);
  settingsValidationWatcher = setInterval(() => {
    logSettingsValidationIfDisabled(ctx);
  }, 5_000);
};

const stopSettingsValidationWatcher = (): void => {
  if (settingsValidationWatcher) clearInterval(settingsValidationWatcher);
  settingsValidationWatcher = undefined;
  lastLoggedSettingsValidationKey = undefined;
};

const getSettingsOrDisable = (ctx: PluginContext): DigestSettingsSnapshot => {
  const validation = getSettingsValidation();
  if (validation.enabled) return validation.settings;

  logSettingsValidationIfDisabled(ctx, validation);
  throw new Error(DISABLED_MESSAGE);
};

const parseCoinLedger = (raw: unknown): CoinLedger => {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const ledger: CoinLedger = {};
    for (const [userId, entry] of Object.entries(parsed)) {
      if (!/^\d+$/.test(userId) || !entry || typeof entry !== 'object') continue;
      const candidate = entry as Partial<CoinLedgerEntry>;
      if (
        typeof candidate.balance !== 'number' ||
        !Number.isFinite(candidate.balance) ||
        typeof candidate.lastRefillAt !== 'number' ||
        !Number.isFinite(candidate.lastRefillAt)
      ) {
        continue;
      }

      const pendingCosts =
        candidate.pendingCosts &&
        typeof candidate.pendingCosts === 'object' &&
        !Array.isArray(candidate.pendingCosts)
          ? Object.fromEntries(
              Object.entries(candidate.pendingCosts).flatMap(([jobId, cost]) =>
                typeof cost === 'number' && Number.isFinite(cost) && cost > 0
                  ? [[jobId, Math.floor(cost)]]
                  : []
              )
            )
          : undefined;

      ledger[userId] = {
        balance: Math.max(0, Math.floor(candidate.balance)),
        lastRefillAt: candidate.lastRefillAt,
        lastRequestAt:
          typeof candidate.lastRequestAt === 'number' && Number.isFinite(candidate.lastRequestAt)
            ? candidate.lastRequestAt
            : undefined,
        ...(pendingCosts && Object.keys(pendingCosts).length > 0 ? { pendingCosts } : {})
      };
    }
    return ledger;
  } catch {
    return {};
  }
};

const getStoredCoinLedger = (): CoinLedger => {
  return parseCoinLedger(settingsRef?.get(COIN_LEDGER_SETTING));
};

const persistCoinLedger = (ledger: CoinLedger): void => {
  settingsRef?.set(COIN_LEDGER_SETTING, JSON.stringify(ledger));
};

const refillLedgerEntry = (
  entry: CoinLedgerEntry | undefined,
  settings: Pick<
    DigestSettingsSnapshot,
    'coinRefillAmount' | 'coinRefillHours' | 'coinMaxBalance'
  >,
  now = Date.now()
): CoinLedgerEntry => {
  const cap = settings.coinMaxBalance;
  const refillAmount = settings.coinRefillAmount;
  const refillMs = settings.coinRefillHours * ONE_HOUR_MS;
  const initialBalance = Math.min(refillAmount, cap);

  if (!entry) {
    return {
      balance: initialBalance,
      lastRefillAt: now
    };
  }

  const cleanEntry: CoinLedgerEntry = {
    balance: Math.min(cap, Math.max(0, Math.floor(entry.balance))),
    lastRefillAt: entry.lastRefillAt,
    lastRequestAt: entry.lastRequestAt,
    pendingCosts: entry.pendingCosts
  };

  if (refillAmount <= 0 || cap <= 0) {
    return {
      ...cleanEntry,
      balance: Math.min(cleanEntry.balance, cap)
    };
  }

  const intervals = Math.floor(Math.max(0, now - cleanEntry.lastRefillAt) / refillMs);
  if (intervals <= 0) return cleanEntry;

  return {
    ...cleanEntry,
    balance: Math.min(cap, cleanEntry.balance + intervals * refillAmount),
    lastRefillAt: cleanEntry.lastRefillAt + intervals * refillMs
  };
};

const getNextRefillAt = (
  entry: CoinLedgerEntry,
  settings: Pick<DigestSettingsSnapshot, 'coinRefillAmount' | 'coinRefillHours' | 'coinMaxBalance'>
): number | undefined => {
  if (settings.coinRefillAmount <= 0) return undefined;
  if (entry.balance >= settings.coinMaxBalance) return undefined;
  return entry.lastRefillAt + settings.coinRefillHours * ONE_HOUR_MS;
};

const getRequestCooldown = (
  entry: CoinLedgerEntry,
  settings: Pick<DigestSettingsSnapshot, 'requestCooldownMs'>,
  now = Date.now()
): { remainingMs: number; nextAllowedAt?: number } => {
  if (!settings.requestCooldownMs || !entry.lastRequestAt) {
    return { remainingMs: 0 };
  }

  const nextAllowedAt = entry.lastRequestAt + settings.requestCooldownMs;
  const remainingMs = Math.max(0, nextAllowedAt - now);
  return {
    remainingMs,
    nextAllowedAt: remainingMs > 0 ? nextAllowedAt : undefined
  };
};

const assertUserRequestCooldown = (
  entry: CoinLedgerEntry,
  settings: Pick<DigestSettingsSnapshot, 'requestCooldownMs'>,
  now = Date.now()
): void => {
  const cooldown = getRequestCooldown(entry, settings, now);
  if (cooldown.remainingMs > 0) {
    const waitSeconds = Math.ceil(cooldown.remainingMs / 1000);
    throw new Error(`Digest cooldown active. Try again in ${waitSeconds} second(s).`);
  }
};

const debitCoinCost = (
  ledger: CoinLedger,
  userId: number,
  settings: DigestSettingsSnapshot,
  cost: number,
  now = Date.now(),
  pendingJobId?: string
): CoinLedgerEntry => {
  const key = String(userId);
  const entry = refillLedgerEntry(ledger[key], settings, now);
  assertUserRequestCooldown(entry, settings, now);

  if (entry.balance < cost) {
    throw new Error('Not enough digest coins.');
  }

  const nextEntry = {
    ...entry,
    balance: entry.balance - cost,
    lastRequestAt: now,
    pendingCosts: pendingJobId
      ? {
          ...(entry.pendingCosts ?? {}),
          [pendingJobId]: cost
        }
      : entry.pendingCosts
  };
  ledger[key] = nextEntry;
  return nextEntry;
};

const clearPendingCoinCost = (
  ledger: CoinLedger,
  userId: number,
  pendingJobId: string
): void => {
  const entry = ledger[String(userId)];
  if (!entry?.pendingCosts) return;

  const { [pendingJobId]: _cleared, ...remaining } = entry.pendingCosts;
  if (Object.keys(remaining).length > 0) {
    entry.pendingCosts = remaining;
  } else {
    delete entry.pendingCosts;
  }
};

const refundCoinCost = (
  ledger: CoinLedger,
  userId: number,
  settings: Pick<DigestSettingsSnapshot, 'coinMaxBalance'>,
  cost: number
): CoinLedgerEntry => {
  const key = String(userId);
  const entry = ledger[key] ?? {
    balance: 0,
    lastRefillAt: Date.now()
  };
  const nextEntry = {
    ...entry,
    balance: Math.min(settings.coinMaxBalance, Math.max(0, entry.balance) + cost)
  };
  ledger[key] = nextEntry;
  return nextEntry;
};

const getQuotaForUser = async (
  userId: number,
  now = Date.now(),
  settings = getSettings()
): Promise<DigestQuotaResponse> => {
  return runLedgerMutation(() => {
    const ledger = getStoredCoinLedger();
    const key = String(userId);
    const entry = refillLedgerEntry(ledger[key], settings, now);
    ledger[key] = entry;
    persistCoinLedger(ledger);
    const cooldown = getRequestCooldown(entry, settings, now);

    return {
      balance: entry.balance,
      maxBalance: settings.coinMaxBalance,
      refillAmount: settings.coinRefillAmount,
      nextRefillAt: getNextRefillAt(entry, settings),
      requestCooldownRemainingMs: cooldown.remainingMs,
      nextRequestAllowedAt: cooldown.nextAllowedAt,
      startCost: DIGEST_COST,
      regenerateCost: DIGEST_COST
    };
  });
};

const refundJobInLedgerOnce = (
  job: DigestJob,
  ledger: CoinLedger,
  settings: Pick<DigestSettingsSnapshot, 'coinMaxBalance'>
): void => {
  if (job.refunded) return;
  clearPendingCoinCost(ledger, job.userId, job.id);
  refundCoinCost(ledger, job.userId, settings, job.cost);
  job.refunded = true;
};

const refundJobOnce = (job: DigestJob, settings: DigestSettingsSnapshot): void => {
  const ledger = getStoredCoinLedger();
  refundJobInLedgerOnce(job, ledger, settings);
  persistCoinLedger(ledger);
};

const settleJobDebit = (job: DigestJob): void => {
  const ledger = getStoredCoinLedger();
  clearPendingCoinCost(ledger, job.userId, job.id);
  persistCoinLedger(ledger);
};

const recoverPendingCoinCostsInLedger = (
  ledger: CoinLedger,
  settings: Pick<DigestSettingsSnapshot, 'coinMaxBalance'>
): boolean => {
  let changed = false;

  for (const entry of Object.values(ledger)) {
    const pendingCosts = entry.pendingCosts ?? {};
    const pendingTotal = Object.values(pendingCosts).reduce((total, cost) => total + cost, 0);
    if (pendingTotal <= 0) continue;

    entry.balance = Math.min(settings.coinMaxBalance, entry.balance + pendingTotal);
    delete entry.pendingCosts;
    changed = true;
  }

  return changed;
};

const recoverPendingCoinCosts = (): void => {
  const validation = getSettingsValidation();
  if (!validation.enabled) return;

  const ledger = getStoredCoinLedger();
  if (!recoverPendingCoinCostsInLedger(ledger, validation.settings)) return;
  persistCoinLedger(ledger);
};

const getDigestWindowBounds = (
  messages: Array<Pick<StoredMessage, 'createdAt'>>,
  now = Date.now()
): { start: number; end: number } | undefined => {
  if (messages.length === 0) return undefined;

  const currentWindowStart = now - DIGEST_WINDOW_MS;
  const hasCurrentMessages = messages.some(
    (message) => message.createdAt >= currentWindowStart && message.createdAt <= now
  );
  const end = hasCurrentMessages
    ? now
    : Math.max(...messages.map((message) => message.createdAt));

  return {
    start: end - DIGEST_WINDOW_MS,
    end
  };
};

const pruneOldMessages = (): void => {
  const now = Date.now();

  for (const [channelId, messages] of messagesByChannel.entries()) {
    const bounds = getDigestWindowBounds(messages, now);
    const windowMessages = bounds
      ? messages.filter(
          (message) => message.createdAt >= bounds.start && message.createdAt <= bounds.end
        )
      : [];
    const lastMessages = messages.slice(-LAST_MESSAGES_DIGEST_COUNT);
    const freshById = new Map<number, StoredMessage>();
    for (const message of [...windowMessages, ...lastMessages]) {
      freshById.set(message.messageId, message);
    }
    const fresh = [...freshById.values()].sort((a, b) => a.createdAt - b.createdAt);

    if (fresh.length === 0) {
      messagesByChannel.delete(channelId);
    } else {
      messagesByChannel.set(channelId, fresh);
    }
  }
};

const pruneOldJobs = (): void => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [jobId, job] of digestJobs.entries()) {
    if (job.createdAt < cutoff) digestJobs.delete(jobId);
  }
};

const rememberMessage = (message: StoredMessage): void => {
  pruneOldMessages();

  const messages = messagesByChannel.get(message.channelId) ?? [];
  messages.push({
    ...message,
    textContent: message.textContent.trim().slice(0, getSettings().maxMessageLength)
  });
  messagesByChannel.set(message.channelId, messages);
};

const getRecentMessages = (channelId: number, maxMessages: number): StoredMessage[] => {
  pruneOldMessages();

  const messages = messagesByChannel.get(channelId) ?? [];
  const bounds = getDigestWindowBounds(messages);
  if (!bounds) return [];

  return messages
    .filter(
      (message) =>
        message.createdAt >= bounds.start &&
        message.createdAt <= bounds.end &&
        message.textContent.length > 0
    )
    .slice(-maxMessages);
};

const getLastMessages = (channelId: number, maxMessages: number): StoredMessage[] => {
  const messages = messagesByChannel.get(channelId) ?? [];

  return messages
    .filter((message) => message.textContent.length > 0)
    .slice(-maxMessages);
};

const getRecentMessagesFromDatabase = (
  ctx: PluginContext,
  channelId: number,
  maxMessages: number,
  maxMessageLength = getSettings().maxMessageLength
): StoredMessage[] => {
  const db = new Database(getDatabasePath(ctx), { readonly: true });
  const now = Date.now();

  try {
    const recentCutoff = now - DIGEST_WINDOW_MS;
    const latestCurrentWindow = db
      .query<DbLatestMessageRow, [number, number, number, string]>(
        [
          'SELECT MAX(messages.created_at) AS latest_created_at',
          'FROM messages',
          'WHERE messages.channel_id = ?',
          'AND messages.created_at >= ?',
          'AND messages.created_at <= ?',
          'AND (messages.plugin_id IS NULL OR messages.plugin_id != ?)'
        ].join(' ')
      )
      .get(channelId, recentCutoff, now, ctx.pluginId);
    const latestAnyWindow = latestCurrentWindow?.latest_created_at
      ? latestCurrentWindow
      : db
          .query<DbLatestMessageRow, [number, string]>(
            [
              'SELECT MAX(messages.created_at) AS latest_created_at',
              'FROM messages',
              'WHERE messages.channel_id = ?',
              'AND (messages.plugin_id IS NULL OR messages.plugin_id != ?)'
            ].join(' ')
          )
          .get(channelId, ctx.pluginId);
    const windowEnd = latestCurrentWindow?.latest_created_at
      ? now
      : latestAnyWindow?.latest_created_at;
    if (!windowEnd) return [];

    const windowStart = windowEnd - DIGEST_WINDOW_MS;
    const rows = db
      .query<DbMessageRow, [number, number, number, string, number]>(
        [
          'SELECT * FROM (',
          'SELECT messages.id, messages.channel_id, messages.user_id, users.name AS user_name, messages.plugin_id, messages.content, messages.created_at',
          'FROM messages',
          'LEFT JOIN users ON users.id = messages.user_id',
          'WHERE messages.channel_id = ?',
          'AND messages.created_at >= ?',
          'AND messages.created_at <= ?',
          'AND (messages.plugin_id IS NULL OR messages.plugin_id != ?)',
          'ORDER BY messages.created_at DESC',
          'LIMIT ?',
          ') ORDER BY created_at ASC'
        ].join(' ')
      )
      .all(channelId, windowStart, windowEnd, ctx.pluginId, maxMessages);

    return rows.flatMap((row) => {
      const textContent = stripMessageHtml(row.content ?? '').slice(0, maxMessageLength);
      if (!textContent) return [];

      return [
        {
          messageId: row.id,
          channelId: row.channel_id,
          authorLabel:
            row.user_id === null
              ? `plugin:${row.plugin_id ?? 'unknown'}`
              : row.user_name || `user:${row.user_id}`,
          textContent,
          createdAt: row.created_at
        }
      ];
    });
  } finally {
    db.close();
  }
};

const getLastMessagesFromDatabase = (
  ctx: PluginContext,
  channelId: number,
  maxMessages: number,
  maxMessageLength = getSettings().maxMessageLength
): StoredMessage[] => {
  const db = new Database(getDatabasePath(ctx), { readonly: true });

  try {
    const rows = db
      .query<DbMessageRow, [number, string, number]>(
        [
          'SELECT * FROM (',
          'SELECT messages.id, messages.channel_id, messages.user_id, users.name AS user_name, messages.plugin_id, messages.content, messages.created_at',
          'FROM messages',
          'LEFT JOIN users ON users.id = messages.user_id',
          'WHERE messages.channel_id = ?',
          'AND (messages.plugin_id IS NULL OR messages.plugin_id != ?)',
          'ORDER BY messages.created_at DESC',
          'LIMIT ?',
          ') ORDER BY created_at ASC'
        ].join(' ')
      )
      .all(channelId, ctx.pluginId, maxMessages);

    return rows.flatMap((row) => {
      const textContent = stripMessageHtml(row.content ?? '').slice(0, maxMessageLength);
      if (!textContent) return [];

      return [
        {
          messageId: row.id,
          channelId: row.channel_id,
          authorLabel:
            row.user_id === null
              ? `plugin:${row.plugin_id ?? 'unknown'}`
              : row.user_name || `user:${row.user_id}`,
          textContent,
          createdAt: row.created_at
        }
      ];
    });
  } finally {
    db.close();
  }
};

const getDigestMessages = (
  ctx: PluginContext,
  channelId: number,
  maxMessages: number,
  maxMessageLength = getSettings().maxMessageLength,
  digestMode: DigestMode = 'last24h'
): StoredMessage[] => {
  const effectiveMaxMessages =
    digestMode === 'last24messages' ? LAST_MESSAGES_DIGEST_COUNT : maxMessages;

  try {
    const databaseMessages =
      digestMode === 'last24messages'
        ? getLastMessagesFromDatabase(ctx, channelId, effectiveMaxMessages, maxMessageLength)
        : getRecentMessagesFromDatabase(ctx, channelId, effectiveMaxMessages, maxMessageLength);
    if (databaseMessages.length > 0) return databaseMessages;
  } catch (error) {
    ctx.error('Digest database history lookup failed; falling back to runtime cache', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return digestMode === 'last24messages'
    ? getLastMessages(channelId, effectiveMaxMessages)
    : getRecentMessages(channelId, effectiveMaxMessages);
};

const getUserChannelKey = (userId: number, channelId: number): string => {
  return `${userId}:${channelId}`;
};

const normalizeDigestMode = (value: unknown): DigestMode => {
  return value === 'last24messages' ? 'last24messages' : 'last24h';
};

const getUserDigestKey = (
  userId: number,
  channelId: number,
  digestMode: DigestMode
): string => {
  return `${getUserChannelKey(userId, channelId)}:${digestMode}`;
};

const assertRegenerateCooldown = (
  userId: number,
  channelId: number,
  digestMode: DigestMode = 'last24h',
  settings: Pick<DigestSettingsSnapshot, 'requestCooldownMs'> = getSettings()
): void => {
  const key = getUserDigestKey(userId, channelId, digestMode);

  if (!lastDigestByUserChannel.has(key)) {
    throw new Error('Generate a digest for this channel and mode before regenerating it.');
  }

  if (!settings.requestCooldownMs) {
    if (activeDigestUsers.has(userId)) {
      throw new Error('A digest is already running for your account.');
    }
    return;
  }

  const nextAllowedAt = (lastRegenerateByUserChannel.get(key) ?? 0) + settings.requestCooldownMs;

  if (Date.now() < nextAllowedAt) {
    const waitSeconds = Math.ceil((nextAllowedAt - Date.now()) / 1000);
    throw new Error(
      `Regenerate cooldown active for this channel. Try again in ${waitSeconds} second(s).`
    );
  }

  if (activeDigestUsers.has(userId)) {
    throw new Error('A digest is already running for your account.');
  }
};

const assertActiveJobAvailable = (userId: number): void => {
  if (activeDigestUsers.has(userId)) {
    throw new Error('A digest is already running for your account.');
  }
};

const resetRuntimeStateForTests = (): void => {
  stopSettingsValidationWatcher();
  messagesByChannel.clear();
  lastDigestByUserChannel.clear();
  lastRegenerateByUserChannel.clear();
  activeDigestUsers.clear();
  digestJobs.clear();
  queuedDigestJobIds.length = 0;
  runningDigestJobIds.clear();
  digestWorkByJobId.clear();
  settingsRef = undefined;
  ledgerChain = Promise.resolve();
};

const setSettingsForTests = (settings: Record<string, unknown>): void => {
  const store = { ...settings };
  settingsRef = {
    get: (key: string) => store[key],
    set: (key: string, value: unknown) => {
      store[key] = value;
    }
  } as DigestSettings;
};

const setLastDigestForTests = (
  userId: number,
  channelId: number,
  timestamp: number,
  digestMode: DigestMode = 'last24h'
): void => {
  lastDigestByUserChannel.set(getUserDigestKey(userId, channelId, digestMode), timestamp);
};

const setLastRegenerateForTests = (
  userId: number,
  channelId: number,
  timestamp: number,
  digestMode: DigestMode = 'last24h'
): void => {
  lastRegenerateByUserChannel.set(
    getUserDigestKey(userId, channelId, digestMode),
    timestamp
  );
};

const setQueuedDigestJobForTests = (
  job: DigestJob,
  settings: DigestSettingsSnapshot,
  messages: StoredMessage[] = []
): void => {
  digestJobs.set(job.id, job);
  digestWorkByJobId.set(job.id, { ctx: {} as PluginContext, settings, messages });
  queuedDigestJobIds.push(job.id);
  activeDigestUsers.add(job.userId);
};

const formatMessagesForPrompt = (messages: StoredMessage[]): string => {
  return messages
    .map((message) => {
      const date = new Date(message.createdAt).toISOString();
      return `[${date}] ${message.authorLabel} message: ${message.textContent}`;
    })
    .join('\n');
};

const limitMessagesForTranscript = (
  messages: StoredMessage[],
  maxChars = DEFAULT_MAX_TRANSCRIPT_CHARS
): StoredMessage[] => {
  const selected: StoredMessage[] = [];
  let remaining = maxChars;

  for (const message of [...messages].reverse()) {
    const line = formatMessagesForPrompt([message]);
    const lineLength = line.length + (selected.length > 0 ? 1 : 0);
    if (lineLength > remaining) continue;

    selected.push(message);
    remaining -= lineLength;
  }

  return selected.reverse();
};

const formatDigestWindowDate = (timestamp: number): string => {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(new Date(timestamp));
};

const getDigestWindowLabel = (
  messages: StoredMessage[],
  digestMode: DigestMode,
  now = Date.now()
): string => {
  const latestMessageAt = Math.max(...messages.map((message) => message.createdAt));
  const earliestMessageAt = Math.min(...messages.map((message) => message.createdAt));
  const startLabel = formatDigestWindowDate(earliestMessageAt);
  const endLabel = formatDigestWindowDate(latestMessageAt);

  if (digestMode === 'last24messages') {
    return `last ${messages.length} messages, independent of age (${startLabel} to ${endLabel})`;
  }

  return latestMessageAt < now - DIGEST_WINDOW_MS
    ? `24 hours ending at ${endLabel}`
    : `last 24 hours (${startLabel} to ${endLabel})`;
};

const buildOllamaUserContent = (options: {
  channelName: string;
  messages: StoredMessage[];
  digestMode: DigestMode;
  maxTranscriptChars?: number;
  now?: number;
}): string => {
  const promptMessages = limitMessagesForTranscript(
    options.messages,
    options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS
  );
  if (promptMessages.length === 0) {
    throw new Error('Transcript budget is too small for the selected messages.');
  }

  return [
    `Channel: #${options.channelName}`,
    `Window: ${getDigestWindowLabel(promptMessages, options.digestMode, options.now)}`,
    `Message count: ${promptMessages.length}`,
    '',
    formatMessagesForPrompt(promptMessages)
  ].join('\n');
};

type StatusFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

const checkOllamaStatus = async (
  baseUrl: string,
  fetchImpl: StatusFetch = fetch,
  timeoutMs = OLLAMA_STATUS_TIMEOUT_MS
): Promise<OllamaStatusResponse> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(baseUrl, {
      method: 'GET',
      headers: {
        'User-Agent': `sharkord-digest/${manifest.version}`
      },
      signal: controller.signal
    });
    const body = await response.text().catch(() => '');

    if (!response.ok) {
      return {
        available: false,
        checkedAt: Date.now(),
        error: `Ollama returned HTTP ${response.status}.`
      };
    }

    if (!body.includes('Ollama is running')) {
      return {
        available: false,
        checkedAt: Date.now(),
        error: 'Ollama returned an unexpected status response.'
      };
    }

    return {
      available: true,
      checkedAt: Date.now()
    };
  } catch (error) {
    return {
      available: false,
      checkedAt: Date.now(),
      error:
        error instanceof Error && error.name === 'AbortError'
          ? 'Ollama status check timed out.'
          : error instanceof Error
            ? error.message
            : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
};

const callOllama = async (options: {
  baseUrl: string;
  model: string;
  prompt: string;
  channelName: string;
  messages: StoredMessage[];
  digestMode: DigestMode;
  maxTranscriptChars?: number;
}): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  const userContent = buildOllamaUserContent({
    channelName: options.channelName,
    messages: options.messages,
    digestMode: options.digestMode,
    maxTranscriptChars: options.maxTranscriptChars
  });

  try {
    const response = await fetch(`${options.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `sharkord-digest/${manifest.version}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: options.prompt
          },
          {
            role: 'user',
            content: userContent
          }
        ]
      })
    });

    const payload = (await response.json().catch(() => ({}))) as OllamaResponse;

    if (!response.ok) {
      throw new Error(payload.error || `Ollama returned HTTP ${response.status}.`);
    }

    const content = payload.message?.content ?? payload.response;
    if (!content || typeof content !== 'string') {
      throw new Error('Ollama returned an empty digest.');
    }

    return content.trim();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Ollama timed out while preparing the digest.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const getTextChannelName = async (ctx: PluginContext, channelId: number): Promise<string> => {
  const channel = (await ctx.data.getChannel(channelId)) as
    | { id?: number; name?: string; type?: string; isDm?: boolean }
    | undefined;

  if (!channel || channel.type !== 'TEXT' || channel.isDm) {
    throw new Error('Select a public text channel to generate a digest.');
  }

  return channel.name || `channel-${channelId}`;
};

const buildDigestResult = (
  job: DigestJob,
  settings: DigestSettingsSnapshot,
  summary: string,
  messages: StoredMessage[],
  generatedAt: number
): DigestActionResponse => {
  const key = getUserDigestKey(job.userId, job.channelId, job.digestMode);
  lastDigestByUserChannel.set(key, generatedAt);

  return {
    summary,
    channelId: job.channelId,
    channelName: job.channelName,
    model: settings.ollamaModel,
    generatedAt,
    messageCount: messages.length,
    since:
      job.digestMode === 'last24messages'
        ? (messages[0]?.createdAt ?? generatedAt)
        : generatedAt - DIGEST_WINDOW_MS,
    nextAllowedAt: generatedAt + settings.requestCooldownMs,
    nextRegenerateAt:
      settings.requestCooldownMs > 0
        ? (lastRegenerateByUserChannel.get(key) ?? 0) + settings.requestCooldownMs
        : 0,
    regenerated: job.regenerate,
    digestMode: job.digestMode
  };
};

const executeDigestJob = async (
  ctx: PluginContext,
  job: DigestJob,
  settings: DigestSettingsSnapshot,
  messages: StoredMessage[]
): Promise<void> => {
  try {
    const summary = await callOllama({
      baseUrl: settings.ollamaUrl,
      model: settings.ollamaModel,
      prompt: settings.defaultPrompt,
      channelName: job.channelName,
      digestMode: job.digestMode,
      messages,
      maxTranscriptChars: settings.maxTranscriptChars
    });

    job.result = buildDigestResult(job, settings, summary, messages, Date.now());
    await runLedgerMutation(() => settleJobDebit(job));
    job.status = 'completed';
  } catch (error) {
    await runLedgerMutation(() => refundJobOnce(job, settings));
    job.error = error instanceof Error ? error.message : String(error);
    job.status = 'failed';
    ctx.error('Digest job failed', {
      jobId: job.id,
      userId: job.userId,
      channelId: job.channelId,
      error: job.error
    });
  } finally {
    activeDigestUsers.delete(job.userId);
  }
};

const processDigestQueue = (): void => {
  const validation = getSettingsValidation();
  if (!validation.enabled) {
    failQueuedDigestJobs(DISABLED_MESSAGE);
    return;
  }

  const concurrency = validation.settings.maxConcurrentDigestJobs;

  while (runningDigestJobIds.size < concurrency && queuedDigestJobIds.length > 0) {
    const jobId = queuedDigestJobIds.shift();
    if (!jobId) return;

    const job = digestJobs.get(jobId);
    const work = digestWorkByJobId.get(jobId);
    if (!job || !work || job.status !== 'pending') {
      digestWorkByJobId.delete(jobId);
      continue;
    }

    runningDigestJobIds.add(jobId);
    executeDigestJob(work.ctx, job, work.settings, work.messages)
      .catch((error) => {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = 'failed';
      })
      .finally(() => {
        runningDigestJobIds.delete(jobId);
        digestWorkByJobId.delete(jobId);
        processDigestQueue();
      });
  }
};

const getQueuePositionFromState = (
  jobId: string,
  queuedJobIds: string[],
  runningJobIds: ReadonlySet<string>
): number | undefined => {
  const queuedIndex = queuedJobIds.indexOf(jobId);
  if (queuedIndex >= 0) return queuedIndex + 1;
  if (runningJobIds.has(jobId)) return 0;
  return undefined;
};

const getDigestQueuePosition = (jobId: string): number | undefined => {
  return getQueuePositionFromState(jobId, queuedDigestJobIds, runningDigestJobIds);
};

const failQueuedDigestJobs = (error: string): void => {
  const queuedJobIds = queuedDigestJobIds.splice(0);

  for (const jobId of queuedJobIds) {
    const job = digestJobs.get(jobId);
    const work = digestWorkByJobId.get(jobId);
    digestWorkByJobId.delete(jobId);

    if (!job || job.status !== 'pending') continue;

    job.error = error;
    job.status = 'failed';
    activeDigestUsers.delete(job.userId);

    if (work) {
      void runLedgerMutation(() => refundJobOnce(job, work.settings));
    }
  }
};

const startDigestJob = async (
  ctx: PluginContext,
  invoker: { userId: number },
  payload: StartDigestJobPayload
): Promise<StartDigestJobResponse> => {
  if (!payload || typeof payload.channelId !== 'number') {
    throw new Error('Missing channelId.');
  }

  pruneOldJobs();
  const settings = getSettingsOrDisable(ctx);
  const regenerate = payload.regenerate === true;
  const digestMode = normalizeDigestMode(payload.digestMode);

  if (regenerate) {
    assertRegenerateCooldown(invoker.userId, payload.channelId, digestMode, settings);
  } else {
    assertActiveJobAvailable(invoker.userId);
  }

  const channelName = await getTextChannelName(ctx, payload.channelId);
  const messages = limitMessagesForTranscript(
    getDigestMessages(
      ctx,
      payload.channelId,
      settings.maxMessages,
      settings.maxMessageLength,
      digestMode
    ),
    settings.maxTranscriptChars
  );
  if (messages.length === 0) {
    throw new Error(
      digestMode === 'last24messages'
        ? 'No messages captured for this channel yet.'
        : 'No messages captured for this channel in the selected 24-hour window yet.'
    );
  }

  const startedAt = Date.now();
  const jobId = `${startedAt}-${crypto.randomUUID()}`;
  await runLedgerMutation(() => {
    const ledger = getStoredCoinLedger();
    debitCoinCost(ledger, invoker.userId, settings, DIGEST_COST, startedAt, jobId);
    persistCoinLedger(ledger);
  });

  const key = getUserDigestKey(invoker.userId, payload.channelId, digestMode);
  if (regenerate) {
    lastRegenerateByUserChannel.set(key, startedAt);
  }

  const job: DigestJob = {
    id: jobId,
    userId: invoker.userId,
    channelId: payload.channelId,
    channelName,
    model: settings.ollamaModel,
    regenerate,
    digestMode,
    status: 'pending',
    createdAt: startedAt,
    cost: DIGEST_COST,
    refunded: false
  };
  digestJobs.set(jobId, job);
  digestWorkByJobId.set(jobId, { ctx, settings, messages });
  queuedDigestJobIds.push(jobId);
  activeDigestUsers.add(invoker.userId);
  processDigestQueue();

  return {
    jobId,
    status: job.status,
    queuePosition: getDigestQueuePosition(jobId),
    quota: await getQuotaForUser(invoker.userId, Date.now(), settings)
  };
};

const getDigestJob = async (
  ctx: PluginContext,
  invoker: { userId: number },
  payload: DigestJobPayload
): Promise<DigestJobResponse> => {
  getSettingsOrDisable(ctx);

  if (!payload || typeof payload.jobId !== 'string') {
    throw new Error('Missing jobId.');
  }

  pruneOldJobs();
  const job = digestJobs.get(payload.jobId);
  if (!job || job.userId !== invoker.userId) {
    throw new Error('Digest job not found.');
  }

  return {
    jobId: job.id,
    status: job.status,
    queuePosition: getDigestQueuePosition(job.id),
    result: job.result,
    error: job.error
  };
};

const getDigestQuota = async (
  ctx: PluginContext,
  invoker: { userId: number }
): Promise<DigestQuotaResponse> => {
  return getQuotaForUser(invoker.userId, Date.now(), getSettingsOrDisable(ctx));
};

const getDigestPluginHealth = async (
  ctx: PluginContext
): Promise<DigestPluginHealthResponse> => {
  return { enabled: logSettingsValidationIfDisabled(ctx) };
};

const getOllamaStatus = async (ctx: PluginContext): Promise<OllamaStatusResponse> => {
  return checkOllamaStatus(getSettingsOrDisable(ctx).ollamaUrl);
};

const onLoad = async (ctx: PluginContext): Promise<void> => {
  ctx.log('Sharkord Digest plugin loaded');

  settingsRef = await ctx.settings.register(SETTINGS_DEFINITION);
  startSettingsValidationWatcher(ctx);
  recoverPendingCoinCosts();

  ctx.actions.register<undefined>({
    name: 'getDigestPluginHealth',
    description: 'Return whether Sharkord Digest settings are valid.',
    execute: () => getDigestPluginHealth(ctx)
  });

  ctx.actions.register<undefined>({
    name: 'getDigestQuota',
    description: 'Return the current user digest coin balance and cooldown.',
    execute: (invoker) => getDigestQuota(ctx, invoker)
  });

  ctx.actions.register<undefined>({
    name: 'getOllamaStatus',
    description: 'Check whether the configured Ollama endpoint is reachable.',
    execute: () => getOllamaStatus(ctx)
  });

  ctx.actions.register<StartDigestJobPayload>({
    name: 'startDigestJob',
    description: 'Start a private local-AI digest job for one text channel.',
    execute: (invoker, payload) => startDigestJob(ctx, invoker, payload)
  });

  ctx.actions.register<DigestJobPayload>({
    name: 'getDigestJob',
    description: 'Return the current status of a digest job.',
    execute: (invoker, payload) => getDigestJob(ctx, invoker, payload)
  });

  unsubscribeMessages = ctx.events.on('message:created', (payload) => {
    if (payload.pluginId === ctx.pluginId) return;

    rememberMessage({
      messageId: payload.messageId,
      channelId: payload.channelId,
      authorLabel:
        payload.userId === null
          ? `plugin:${payload.pluginId ?? 'unknown'}`
          : `user:${payload.userId}`,
      textContent: payload.textContent,
      createdAt: Date.now()
    });
  });

  ctx.ui.enable();
};

const onUnload = (ctx: PluginContext): void => {
  stopSettingsValidationWatcher();
  unsubscribeMessages?.();
  unsubscribeMessages = undefined;
  messagesByChannel.clear();
  lastDigestByUserChannel.clear();
  lastRegenerateByUserChannel.clear();
  activeDigestUsers.clear();
  digestJobs.clear();
  queuedDigestJobIds.length = 0;
  runningDigestJobIds.clear();
  digestWorkByJobId.clear();
  settingsRef = undefined;
  ctx.ui.disable();
  ctx.log('Sharkord Digest plugin unloaded');
};

export {
  DEFAULT_PROMPT,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_TRANSCRIPT_CHARS,
  SETTINGS_DEFINITION,
  LAST_MESSAGES_DIGEST_COUNT,
  assertRegenerateCooldown,
  assertUserRequestCooldown,
  buildDigestResult,
  buildOllamaUserContent,
  callOllama,
  checkOllamaStatus,
  debitCoinCost,
  DIGEST_COST,
  failQueuedDigestJobs,
  formatMessagesForPrompt,
  formatDigestWindowDate,
  getDigestJob,
  getDigestPluginHealth,
  getDigestMessages,
  getOllamaStatus,
  getNextRefillAt,
  getQuotaForUser,
  getQueuePositionFromState,
  getLastMessages,
  getLastMessagesFromDatabase,
  getDigestWindowLabel,
  getRecentMessages,
  getRecentMessagesFromDatabase,
  logSettingsValidationIfDisabled,
  normalizeDigestMode,
  onLoad,
  onUnload,
  parseCoinLedger,
  getSettingsValidation,
  limitMessagesForTranscript,
  refillLedgerEntry,
  recoverPendingCoinCosts,
  recoverPendingCoinCostsInLedger,
  refundCoinCost,
  refundJobInLedgerOnce,
  refundJobOnce,
  rememberMessage,
  resetRuntimeStateForTests,
  setLastDigestForTests,
  setLastRegenerateForTests,
  setQueuedDigestJobForTests,
  setSettingsForTests,
  startDigestJob,
  stripMessageHtml
};
