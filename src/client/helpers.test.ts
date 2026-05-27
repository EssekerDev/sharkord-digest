import { describe, expect, test } from 'bun:test';
import {
  DIGEST_PLUGIN_DISABLED_LABEL,
  OLLAMA_STATUS_MIN_VISIBLE_MS,
  areDigestInteractionsDisabledByOllama,
  formatDurationHoursMinutes,
  getActiveDigestJobStorageKey,
  getCoinActionLabel,
  getCoinBadgeLabel,
  getCopyButtonLabel,
  getDigestModeEmptyLabel,
  getDigestModeLabel,
  getOllamaStatusClassName,
  getOllamaStatusTooltip,
  getDigestLoadingLabel,
  getFreshDigestForChannelMode,
  getDigestResultCacheKey,
  getQuotaBlockReason,
  getRefillLabel,
  getTextChannelOptions,
  markdownToPlainText,
  parseActiveDigestJobCacheEntry,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  removeDigestResultFromCache,
  resolveChannelSelection,
  shouldShowDeleteCachedDigestButton,
  shouldShowDigestDisabledPlaceholder,
  shouldShowDigestFunctionalUi,
  type DigestChannelOption,
  withMinimumDelay
} from './helpers';

const channels: DigestChannelOption[] = [
  { id: 3, name: 'Voice', type: 'VOICE' },
  { id: 2, name: 'Beta', type: 'TEXT' },
  { id: 1, name: 'Alpha', type: 'TEXT' },
  { id: 4, name: 'DM', type: 'TEXT', isDm: true }
];

describe('getTextChannelOptions', () => {
  test('keeps only public text channels and sorts by name', () => {
    expect(getTextChannelOptions(channels)).toEqual([
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' }
    ]);
  });
});

describe('resolveChannelSelection', () => {
  test('selects the current Sharkord text channel', () => {
    expect(
      resolveChannelSelection({
        channels,
        hostSelectedChannelId: 2,
        currentSelectedChannelId: 1
      }).selectedChannelId
    ).toBe(2);
  });

  test('falls back to the first available text channel', () => {
    expect(
      resolveChannelSelection({
        channels,
        hostSelectedChannelId: 3,
        currentSelectedChannelId: undefined
      }).selectedChannelId
    ).toBe(1);
  });

  test('preserves manual selection until the host channel changes', () => {
    expect(
      resolveChannelSelection({
        channels,
        hostSelectedChannelId: 2,
        currentSelectedChannelId: 1,
        lastSyncedHostChannelId: 2
      }).selectedChannelId
    ).toBe(1);
  });

  test('never selects DM or non-text channels', () => {
    expect(
      resolveChannelSelection({
        channels,
        hostSelectedChannelId: 4,
        currentSelectedChannelId: 3
      }).selectedChannelId
    ).toBe(1);
  });
});

describe('mode-specific digest cache helpers', () => {
  const now = 10_000;
  const resultsByKey = {
    [getDigestResultCacheKey(1, 'last24h')]: {
      channelId: 1,
      digestMode: 'last24h' as const,
      generatedAt: now - 1000,
      summary: '24h'
    },
    [getDigestResultCacheKey(1, 'last24messages')]: {
      channelId: 1,
      digestMode: 'last24messages' as const,
      generatedAt: now - 1000,
      summary: '24m'
    }
  };

  test('returns only the selected channel and mode digest', () => {
    expect(
      getFreshDigestForChannelMode(resultsByKey, 1, 'last24messages', now, 5000)
        ?.summary
    ).toBe('24m');
    expect(
      getFreshDigestForChannelMode(resultsByKey, 2, 'last24messages', now, 5000)
    ).toBeUndefined();
  });

  test('removes only the selected channel and mode digest from cache', () => {
    const next = removeDigestResultFromCache(resultsByKey, 1, 'last24h');

    expect(getFreshDigestForChannelMode(next, 1, 'last24h', now, 5000)).toBeUndefined();
    expect(
      getFreshDigestForChannelMode(next, 1, 'last24messages', now, 5000)?.summary
    ).toBe('24m');
  });

  test('formats digest mode labels and empty states', () => {
    expect(getDigestModeLabel('last24h')).toBe('24H');
    expect(getDigestModeLabel('last24messages')).toBe('24M');
    expect(getDigestModeEmptyLabel('last24h')).toContain('24h recap');
    expect(getDigestModeEmptyLabel('last24messages')).toContain('24-message recap');
  });

  test('shows the delete cached digest button only for visible idle results', () => {
    expect(shouldShowDeleteCachedDigestButton(true, false)).toBe(true);
    expect(shouldShowDeleteCachedDigestButton(true, true)).toBe(false);
    expect(shouldShowDeleteCachedDigestButton(false, false)).toBe(false);
  });
});

describe('parseInlineMarkdown', () => {
  test('parses bold, code, markdown links, and bare links', () => {
    expect(
      parseInlineMarkdown(
        '**GG** `code` [Ollama](https://ollama.com) https://example.com'
      )
    ).toEqual([
      { type: 'strong', text: 'GG' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'Ollama', href: 'https://ollama.com' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'https://example.com', href: 'https://example.com' }
    ]);
  });

  test('leaves unsafe markdown links as text', () => {
    expect(parseInlineMarkdown('[bad](javascript:alert(1))')).toEqual([
      { type: 'text', text: '[bad](javascript:alert(1))' }
    ]);
  });
});

describe('parseMarkdownBlocks', () => {
  test('parses headings, paragraphs, and lists', () => {
    expect(parseMarkdownBlocks('# Title\n\nIntro\n- One\n- Two\n### End')).toEqual([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'paragraph', text: 'Intro' },
      { type: 'list', items: ['One', 'Two'] },
      { type: 'heading', level: 3, text: 'End' }
    ]);
  });
});

describe('getCopyButtonLabel', () => {
  test('returns a stable copied label without needing layout feedback', () => {
    expect(getCopyButtonLabel(false, 'Copy')).toBe('Copy');
    expect(getCopyButtonLabel(true, 'Copy')).toBe('\u2713 Copied');
  });
});

describe('quota helpers', () => {
  test('formats action labels and coin balances', () => {
    expect(getCoinActionLabel('start', 1)).toBe('Start - 1');
    expect(getCoinActionLabel('regen', 1)).toBe('Regen - 1');
    expect(getCoinBadgeLabel(3, 10)).toBe('3 / 10');
    expect(getCoinBadgeLabel(undefined, undefined)).toBe('...');
  });

  test('formats refill countdown labels', () => {
    expect(formatDurationHoursMinutes(90 * 60_000)).toBe('01h30');
    expect(
      getRefillLabel(
        { balance: 5, maxBalance: 10, refillAmount: 3, nextRefillAt: 240_000 },
        0
      )
    ).toBe('+3 coins in 00h04');
    expect(
      getRefillLabel(
        { balance: 5, maxBalance: 10, refillAmount: 1, nextRefillAt: 240_000 },
        0
      )
    ).toBe('+1 coin in 00h04');
  });

  test('formats refill edge states without showing zero coin gains', () => {
    expect(
      getRefillLabel({
        balance: 5,
        maxBalance: 10,
        refillAmount: 0,
        nextRefillAt: 240_000
      })
    ).toBe('No refill enabled');
    expect(
      getRefillLabel({
        balance: 10,
        maxBalance: 10,
        refillAmount: 3,
        nextRefillAt: undefined
      })
    ).toBe('Max reached');
    expect(
      getRefillLabel({
        balance: 5,
        maxBalance: 10,
        refillAmount: undefined,
        nextRefillAt: 240_000
      })
    ).toBe('Digest coins');
  });

  test('reports insufficient coins and active cooldowns', () => {
    expect(
      getQuotaBlockReason(
        {
          balance: 0,
          maxBalance: 10,
          requestCooldownRemainingMs: 0,
          startCost: 1,
          regenerateCost: 1
        },
        'start'
      )
    ).toBe('Not enough digest coins.');

    expect(
      getQuotaBlockReason(
        {
          balance: 2,
          maxBalance: 10,
          requestCooldownRemainingMs: 4200,
          startCost: 1,
          regenerateCost: 1
        },
        'regen'
      )
    ).toBe('Cooldown 5s');
  });
});

describe('loading helpers', () => {
  test('shows startup, queued, and running Ollama states', () => {
    expect(getDigestLoadingLabel(undefined)).toBe('Starting digest job...');
    expect(getDigestLoadingLabel(2)).toBe('Queued for Ollama - position #2');
    expect(getDigestLoadingLabel(0)).toBe('Preparing digest with Ollama...');
  });
});

describe('active digest job cache helpers', () => {
  test('uses a per-user active job storage key', () => {
    expect(getActiveDigestJobStorageKey(2)).toBe('sharkord-digest:v1:active-job:2');
  });

  test('parses fresh active jobs and rejects expired or malformed entries', () => {
    expect(
      parseActiveDigestJobCacheEntry(
        {
          jobId: 'job',
          channelId: 7,
          digestMode: 'last24messages',
          createdAt: 1000
        },
        2000
      )
    ).toEqual({
      jobId: 'job',
      channelId: 7,
      digestMode: 'last24messages',
      createdAt: 1000
    });

    expect(
      parseActiveDigestJobCacheEntry(
        {
          jobId: 'job',
          channelId: 7,
          digestMode: 'last24h',
          createdAt: 1000
        },
        1000 + 61 * 60_000
      )
    ).toBeUndefined();
    expect(parseActiveDigestJobCacheEntry({ jobId: 'job' }, 2000)).toBeUndefined();
  });
});

describe('Ollama status UI helpers', () => {
  test('formats tooltips and dot class names', () => {
    expect(getOllamaStatusTooltip('checking')).toBe('Checking Ollama');
    expect(getOllamaStatusTooltip('up')).toBe('Ollama Up');
    expect(getOllamaStatusTooltip('down')).toBe('Ollama Down');
    expect(getOllamaStatusClassName('checking')).toContain(
      'sharkord-digest-ollama-dot-checking'
    );
  });

  test('disables digest interactions while checking or down', () => {
    expect(areDigestInteractionsDisabledByOllama('checking')).toBe(true);
    expect(areDigestInteractionsDisabledByOllama('down')).toBe(true);
    expect(areDigestInteractionsDisabledByOllama('up')).toBe(false);
  });

  test('keeps the default status transition visible long enough to read', async () => {
    expect(OLLAMA_STATUS_MIN_VISIBLE_MS).toBe(500);

    const startedAt = Date.now();
    await withMinimumDelay(Promise.resolve('ok'), 15);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10);
  });
});

describe('plugin health UI helpers', () => {
  test('shows a generic disabled placeholder only when health is disabled', () => {
    expect(DIGEST_PLUGIN_DISABLED_LABEL).toBe(
      'This plugin is disabled. Contact admin.'
    );
    expect(shouldShowDigestDisabledPlaceholder(false)).toBe(true);
    expect(shouldShowDigestDisabledPlaceholder(true)).toBe(false);
    expect(shouldShowDigestDisabledPlaceholder(undefined)).toBe(false);
  });

  test('shows functional digest UI only after enabled health is confirmed', () => {
    expect(shouldShowDigestFunctionalUi(true)).toBe(true);
    expect(shouldShowDigestFunctionalUi(false)).toBe(false);
    expect(shouldShowDigestFunctionalUi(undefined)).toBe(false);
  });
});

describe('markdownToPlainText', () => {
  test('strips heading hashes', () => {
    expect(markdownToPlainText('## Title')).toBe('Title');
  });

  test('strips inline strong, code, and link URLs', () => {
    expect(
      markdownToPlainText('Use **bold** and `code` then see [docs](https://example.com).')
    ).toBe('Use bold and code then see docs.');
  });

  test('renders list items as plain dashed lines', () => {
    expect(markdownToPlainText('- one\n- two')).toBe('- one\n- two');
  });

  test('separates blocks with a blank line and trims trailing whitespace', () => {
    expect(markdownToPlainText('# Heading\n\nParagraph with **bold**.\n\n- a\n- b\n')).toBe(
      'Heading\n\nParagraph with bold.\n\n- a\n- b'
    );
  });
});
