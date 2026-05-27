import type { DigestMode } from '../shared/types';

export type DigestChannelOption = {
  id: number;
  name: string;
  type: string;
  isDm?: boolean | null;
};

export type InlinePart = {
  type: 'text' | 'strong' | 'link' | 'code';
  text: string;
  href?: string;
};

export type MarkdownBlock =
  | {
      type: 'heading';
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      type: 'paragraph';
      text: string;
    }
  | {
      type: 'list';
      items: string[];
    };

export type ResolveChannelSelectionOptions = {
  channels: DigestChannelOption[];
  hostSelectedChannelId?: number;
  currentSelectedChannelId?: number;
  lastSyncedHostChannelId?: number;
};

export type DigestQuotaView = {
  balance: number;
  maxBalance: number;
  refillAmount?: number;
  nextRefillAt?: number;
  requestCooldownRemainingMs: number;
  startCost: number;
  regenerateCost: number;
};

export type DigestResultCacheEntry = {
  channelId: number;
  generatedAt: number;
  digestMode?: DigestMode;
};

export type ActiveDigestJobCacheEntry = {
  jobId: string;
  channelId: number;
  digestMode: DigestMode;
  createdAt: number;
};

export type OllamaAvailabilityState = 'checking' | 'up' | 'down';

export const DIGEST_CACHE_TTL_MS = 24 * 60 * 60_000;
export const ACTIVE_DIGEST_JOB_TTL_MS = 60 * 60_000;
export const OLLAMA_STATUS_MIN_VISIBLE_MS = 500;
export const DIGEST_PLUGIN_DISABLED_LABEL =
  'This plugin is disabled. Contact admin.';

const isPublicTextChannel = (channel: DigestChannelOption): boolean => {
  return channel.type === 'TEXT' && !channel.isDm;
};

export const getTextChannelOptions = (
  channels: DigestChannelOption[]
): Array<Pick<DigestChannelOption, 'id' | 'name'>> => {
  return channels
    .filter(isPublicTextChannel)
    .map((channel) => ({
      id: channel.id,
      name: channel.name
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

export const resolveChannelSelection = ({
  channels,
  hostSelectedChannelId,
  currentSelectedChannelId,
  lastSyncedHostChannelId
}: ResolveChannelSelectionOptions): {
  selectedChannelId?: number;
  syncedHostChannelId?: number;
} => {
  const textChannels = getTextChannelOptions(channels);
  const fallbackChannelId = textChannels[0]?.id;
  const hostTextChannel = textChannels.find(
    (channel) => channel.id === hostSelectedChannelId
  );
  const currentSelectionIsValid = textChannels.some(
    (channel) => channel.id === currentSelectedChannelId
  );

  // Follow Sharkord navigation, but preserve a manual dropdown choice until
  // the host selected channel changes.
  if (hostTextChannel && hostTextChannel.id !== lastSyncedHostChannelId) {
    return {
      selectedChannelId: hostTextChannel.id,
      syncedHostChannelId: hostTextChannel.id
    };
  }

  if (currentSelectionIsValid) {
    return {
      selectedChannelId: currentSelectedChannelId,
      syncedHostChannelId: lastSyncedHostChannelId
    };
  }

  return {
    selectedChannelId: hostTextChannel?.id ?? fallbackChannelId,
    syncedHostChannelId: hostTextChannel?.id ?? lastSyncedHostChannelId
  };
};

export const getDigestResultCacheKey = (
  channelId: number,
  digestMode: DigestMode
): string => {
  return `${channelId}:${digestMode}`;
};

export const getFreshDigestForChannelMode = <T extends DigestResultCacheEntry>(
  resultsByKey: Record<string, T>,
  channelId: number | undefined,
  digestMode: DigestMode,
  now: number,
  ttlMs = DIGEST_CACHE_TTL_MS
): T | undefined => {
  if (!channelId) return undefined;

  const result = resultsByKey[getDigestResultCacheKey(channelId, digestMode)];
  if (!result || result.digestMode !== digestMode) return undefined;

  return now - result.generatedAt < ttlMs ? result : undefined;
};

export const removeDigestResultFromCache = <T extends DigestResultCacheEntry>(
  resultsByKey: Record<string, T>,
  channelId: number,
  digestMode: DigestMode
): Record<string, T> => {
  const cacheKey = getDigestResultCacheKey(channelId, digestMode);
  if (!(cacheKey in resultsByKey)) return resultsByKey;

  const next = { ...resultsByKey };
  delete next[cacheKey];
  return next;
};

export const shouldShowDeleteCachedDigestButton = (
  hasResult: boolean,
  loading: boolean
): boolean => {
  return hasResult && !loading;
};

export const getDigestModeLabel = (digestMode: DigestMode): string => {
  return digestMode === 'last24messages' ? '24M' : '24H';
};

export const getDigestModeEmptyLabel = (digestMode: DigestMode): string => {
  return digestMode === 'last24messages'
    ? 'Choose a text channel and start a private 24-message recap.'
    : 'Choose a text channel and start a private 24h recap.';
};

export const getOllamaStatusTooltip = (
  status: OllamaAvailabilityState
): string => {
  if (status === 'up') return 'Ollama Up';
  if (status === 'down') return 'Ollama Down';
  return 'Checking Ollama';
};

export const getOllamaStatusClassName = (
  status: OllamaAvailabilityState
): string => {
  return `sharkord-digest-ollama-dot sharkord-digest-ollama-dot-${status}`;
};

export const areDigestInteractionsDisabledByOllama = (
  status: OllamaAvailabilityState
): boolean => {
  return status !== 'up';
};

export const shouldShowDigestDisabledPlaceholder = (
  pluginEnabled: boolean | undefined
): boolean => {
  return pluginEnabled === false;
};

export const shouldShowDigestFunctionalUi = (
  pluginEnabled: boolean | undefined
): boolean => {
  return pluginEnabled === true;
};

export const withMinimumDelay = async <T>(
  promise: Promise<T>,
  minimumMs = OLLAMA_STATUS_MIN_VISIBLE_MS
): Promise<T> => {
  const [result] = await Promise.all([
    promise,
    new Promise((resolve) => setTimeout(resolve, minimumMs))
  ]);
  return result;
};

export const getActiveDigestJobStorageKey = (userId: number | undefined): string => {
  return `sharkord-digest:v1:active-job:${userId ?? 'anonymous'}`;
};

export const parseActiveDigestJobCacheEntry = (
  value: unknown,
  now = Date.now()
): ActiveDigestJobCacheEntry | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ActiveDigestJobCacheEntry>;

  if (
    typeof candidate.jobId !== 'string' ||
    typeof candidate.channelId !== 'number' ||
    typeof candidate.createdAt !== 'number' ||
    (candidate.digestMode !== 'last24h' && candidate.digestMode !== 'last24messages')
  ) {
    return undefined;
  }

  return now - candidate.createdAt < ACTIVE_DIGEST_JOB_TTL_MS
    ? {
        jobId: candidate.jobId,
        channelId: candidate.channelId,
        digestMode: candidate.digestMode,
        createdAt: candidate.createdAt
      }
    : undefined;
};

const isSafeHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const parseInlineMarkdown = (text: string): InlinePart[] => {
  const parts: InlinePart[] = [];
  // Markdown is rendered as React text nodes; only safe http(s) URLs become links.
  const pattern =
    /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/\S+)/g;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index ?? 0;

    if (start < index) {
      continue;
    }

    if (start > index) {
      parts.push({ type: 'text', text: text.slice(index, start) });
    }

    if (raw.startsWith('**') && raw.endsWith('**')) {
      parts.push({ type: 'strong', text: raw.slice(2, -2) });
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      parts.push({ type: 'code', text: raw.slice(1, -1) });
    } else if (raw.startsWith('[')) {
      const labelEnd = raw.indexOf('](');
      const href = raw.slice(labelEnd + 2, -1);

      if (labelEnd > 0 && isSafeHttpUrl(href)) {
        parts.push({
          type: 'link',
          text: raw.slice(1, labelEnd),
          href
        });
      } else {
        let unsafeText = raw;
        while (text[start + unsafeText.length] === ')') {
          unsafeText += ')';
        }
        parts.push({ type: 'text', text: unsafeText });
        index = start + unsafeText.length;
        continue;
      }
    } else if (isSafeHttpUrl(raw)) {
      parts.push({ type: 'link', text: raw, href: raw });
    } else {
      parts.push({ type: 'text', text: raw });
    }

    index = start + raw.length;
  }

  if (index < text.length) {
    parts.push({ type: 'text', text: text.slice(index) });
  }

  return parts;
};

export const parseMarkdownBlocks = (markdown: string): MarkdownBlock[] => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({ type: 'list', items: listItems });
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushList();
      continue;
    }

    const listMatch = /^[-*]\s+(.+)$/.exec(line);
    if (listMatch) {
      listItems.push(listMatch[1] ?? '');
      continue;
    }

    flushList();

    if (line.startsWith('### ')) {
      blocks.push({ type: 'heading', level: 3, text: line.slice(4) });
    } else if (line.startsWith('## ')) {
      blocks.push({ type: 'heading', level: 2, text: line.slice(3) });
    } else if (line.startsWith('# ')) {
      blocks.push({ type: 'heading', level: 1, text: line.slice(2) });
    } else {
      blocks.push({ type: 'paragraph', text: line });
    }
  }

  flushList();

  return blocks;
};

export const markdownToPlainText = (markdown: string): string => {
  const renderInline = (text: string): string =>
    parseInlineMarkdown(text)
      .map((part) => part.text)
      .join('');

  const blocks = parseMarkdownBlocks(markdown);
  const sections = blocks.map((block) => {
    if (block.type === 'list') {
      return block.items.map((item) => `- ${renderInline(item)}`).join('\n');
    }
    return renderInline(block.text);
  });

  return sections.join('\n\n').trimEnd();
};

export const getCopyButtonLabel = (
  copied: boolean,
  defaultLabel: string
): string => {
  return copied ? '\u2713 Copied' : defaultLabel;
};

export const getCoinActionLabel = (
  action: 'start' | 'regen',
  cost = 1
): string => {
  return `${action === 'start' ? 'Start' : 'Regen'} - ${cost}`;
};

export const getCoinBadgeLabel = (
  balance: number | undefined,
  maxBalance: number | undefined
): string => {
  if (balance === undefined || maxBalance === undefined) return '...';
  return `${balance} / ${maxBalance}`;
};

export const formatDurationHoursMinutes = (durationMs: number): string => {
  const totalMinutes = Math.max(1, Math.ceil(Math.max(0, durationMs) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours.toString().padStart(2, '0')}h${minutes
    .toString()
    .padStart(2, '0')}`;
};

export const getRefillLabel = (
  quota: Pick<
    DigestQuotaView,
    'balance' | 'maxBalance' | 'refillAmount' | 'nextRefillAt'
  > | undefined,
  now = Date.now()
): string => {
  if (!quota) return 'Digest coins';

  const amount =
    typeof quota.refillAmount === 'number' && Number.isFinite(quota.refillAmount)
      ? Math.max(0, Math.floor(quota.refillAmount))
      : undefined;

  if (amount === 0) return 'No refill enabled';
  if (quota.balance >= quota.maxBalance) return 'Max reached';
  if (amount === undefined || quota.nextRefillAt === undefined) return 'Digest coins';

  return `+${amount} ${amount === 1 ? 'coin' : 'coins'} in ${formatDurationHoursMinutes(
    quota.nextRefillAt - now
  )}`;
};

export const getDigestLoadingLabel = (queuePosition: number | undefined): string => {
  if (queuePosition === undefined) return 'Starting digest job...';
  if (queuePosition > 0) return `Queued for Ollama - position #${queuePosition}`;
  return 'Preparing digest with Ollama...';
};

export const getQuotaBlockReason = (
  quota: DigestQuotaView | undefined,
  action: 'start' | 'regen'
): string | undefined => {
  if (!quota) return undefined;

  const cost = action === 'start' ? quota.startCost : quota.regenerateCost;
  if (quota.balance < cost) return 'Not enough digest coins.';
  if (quota.requestCooldownRemainingMs > 0) {
    const seconds = Math.ceil(quota.requestCooldownRemainingMs / 1000);
    return `Cooldown ${seconds}s`;
  }

  return undefined;
};
