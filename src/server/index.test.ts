import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_TRANSCRIPT_CHARS,
  DEFAULT_PROMPT,
  assertRegenerateCooldown,
  buildDigestResult,
  buildOllamaUserContent,
  assertUserRequestCooldown,
  checkOllamaStatus,
  debitCoinCost,
  DIGEST_COST,
  failQueuedDigestJobs,
  formatMessagesForPrompt,
  formatDigestWindowDate,
  getLastMessages,
  getLastMessagesFromDatabase,
  getRecentMessages,
  getRecentMessagesFromDatabase,
  getNextRefillAt,
  getSettingsValidation,
  getQuotaForUser,
  getQueuePositionFromState,
  LAST_MESSAGES_DIGEST_COUNT,
  limitMessagesForTranscript,
  logSettingsValidationIfDisabled,
  parseCoinLedger,
  refillLedgerEntry,
  recoverPendingCoinCostsInLedger,
  refundCoinCost,
  refundJobInLedgerOnce,
  rememberMessage,
  resetRuntimeStateForTests,
  SETTINGS_DEFINITION,
  setLastDigestForTests,
  setLastRegenerateForTests,
  setQueuedDigestJobForTests,
  setSettingsForTests,
  startDigestJob,
  stripMessageHtml,
  type CoinLedger,
  type DigestJob,
  type DigestSettingsSnapshot,
  type StoredMessage
} from './index';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const settings: DigestSettingsSnapshot = {
  maxMessages: 120,
  maxMessageLength: 500,
  maxTranscriptChars: 24_000,
  defaultPrompt: 'prompt',
  ollamaModel: 'qwen3:4b-instruct',
  ollamaUrl: 'http://127.0.0.1:11434',
  coinRefillAmount: 3,
  coinRefillHours: 24,
  coinMaxBalance: 10,
  requestCooldownMinutes: 5,
  requestCooldownMs: 5 * 60_000,
  maxConcurrentDigestJobs: 1
};

beforeEach(() => {
  resetRuntimeStateForTests();
});

describe('settings validation', () => {
  test('accepts valid numeric strings from the Sharkord settings UI', () => {
    setSettingsForTests({
      coinRefillAmount: '0',
      requestCooldownMinutes: '0',
      maxMessages: '120'
    });

    const validation = getSettingsValidation();
    expect(validation.enabled).toBe(true);
    if (validation.enabled) {
      expect(validation.settings.coinRefillAmount).toBe(0);
      expect(validation.settings.requestCooldownMinutes).toBe(0);
      expect(validation.settings.maxMessages).toBe(120);
    }
  });

  test('disables on out-of-range numbers', () => {
    setSettingsForTests({ maxMessages: 0 });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'maxMessages'
    });

    setSettingsForTests({ maxTranscriptChars: 999 });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'maxTranscriptChars'
    });

    setSettingsForTests({ maxConcurrentDigestJobs: 11 });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'maxConcurrentDigestJobs'
    });
  });

  test('disables on fractional integer settings', () => {
    setSettingsForTests({ maxMessages: 12.5 });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'maxMessages'
    });

    setSettingsForTests({ coinRefillAmount: '1.5' });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'coinRefillAmount'
    });
  });

  test('allows zero only for refill amount and request cooldown', () => {
    setSettingsForTests({ coinRefillAmount: 0, requestCooldownMinutes: 0 });
    expect(getSettingsValidation()).toMatchObject({ enabled: true });

    setSettingsForTests({ coinMaxBalance: 0 });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'coinMaxBalance'
    });
  });

  test('disables on invalid strings and invalid coin ledger JSON', () => {
    setSettingsForTests({ ollamaUrl: 'file:///etc/passwd' });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'ollamaUrl'
    });

    setSettingsForTests({ ollamaModel: '' });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'ollamaModel'
    });

    setSettingsForTests({ defaultPrompt: '   ' });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'defaultPrompt'
    });

    setSettingsForTests({ coinLedger: '{bad json' });
    expect(getSettingsValidation()).toMatchObject({
      enabled: false,
      invalidSettingKey: 'coinLedger'
    });
  });

  test('documents defaults, ranges, and disable hints in setting descriptions', () => {
    const descriptions = Object.fromEntries(
      SETTINGS_DEFINITION.map((setting) => [setting.key, setting.description])
    );

    for (const key of [
      'ollamaUrl',
      'ollamaModel',
      'defaultPrompt',
      'maxMessages',
      'maxMessageLength',
      'maxTranscriptChars',
      'coinRefillAmount',
      'coinRefillHours',
      'coinMaxBalance',
      'requestCooldownMinutes',
      'maxConcurrentDigestJobs',
      'coinLedger'
    ]) {
      expect(descriptions[key]).toContain('Default:');
      expect(descriptions[key]).toContain('Min:');
      expect(descriptions[key]).toContain('Max:');
    }

    expect(descriptions.coinRefillAmount).toContain('Use 0 to disable');
    expect(descriptions.requestCooldownMinutes).toContain('Use 0 to disable');
  });

  test('digest actions refuse generically and log the invalid setting when disabled', async () => {
    const errors: string[] = [];
    setSettingsForTests({ maxMessages: 0 });

    await expect(
      startDigestJob(
        { error: (message: string) => errors.push(message) } as never,
        { userId: 2 },
        { channelId: 7 }
      )
    ).rejects.toThrow('This plugin is disabled. Contact admin.');

    expect(errors[0]).toContain('Invalid setting maxMessages');
  });

  test('validation logging is deduplicated for the same invalid setting', () => {
    const errors: string[] = [];
    const ctx = { error: (message: string) => errors.push(message) } as never;
    setSettingsForTests({ coinRefillAmount: 500 });

    expect(logSettingsValidationIfDisabled(ctx)).toBe(false);
    expect(logSettingsValidationIfDisabled(ctx)).toBe(false);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Invalid setting coinRefillAmount');
  });

  test('validation logging reports changed invalid settings and resets after valid settings', () => {
    const errors: string[] = [];
    const ctx = { error: (message: string) => errors.push(message) } as never;

    setSettingsForTests({ maxMessages: 0 });
    expect(logSettingsValidationIfDisabled(ctx)).toBe(false);

    setSettingsForTests({ coinRefillAmount: 500 });
    expect(logSettingsValidationIfDisabled(ctx)).toBe(false);

    setSettingsForTests({});
    expect(logSettingsValidationIfDisabled(ctx)).toBe(true);

    setSettingsForTests({ coinRefillAmount: 500 });
    expect(logSettingsValidationIfDisabled(ctx)).toBe(false);

    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('Invalid setting maxMessages');
    expect(errors[1]).toContain('Invalid setting coinRefillAmount');
    expect(errors[2]).toContain('Invalid setting coinRefillAmount');
  });
});

describe('checkOllamaStatus', () => {
  test('reports up when Ollama root returns the expected running text', async () => {
    const seenUrls: string[] = [];
    const status = await checkOllamaStatus(
      'http://127.0.0.1:11434',
      async (url) => {
        seenUrls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () => 'Ollama is running'
        };
      },
      50
    );

    expect(status.available).toBe(true);
    expect(status.error).toBeUndefined();
    expect(seenUrls).toEqual(['http://127.0.0.1:11434']);
  });

  test('reports down for non-OK HTTP responses', async () => {
    const status = await checkOllamaStatus(
      'http://127.0.0.1:11434',
      async () => ({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable'
      }),
      50
    );

    expect(status.available).toBe(false);
    expect(status.error).toContain('HTTP 503');
  });

  test('reports down for unexpected 200 bodies', async () => {
    const status = await checkOllamaStatus(
      'http://127.0.0.1:11434',
      async () => ({
        ok: true,
        status: 200,
        text: async () => 'not ollama'
      }),
      50
    );

    expect(status.available).toBe(false);
    expect(status.error).toContain('unexpected');
  });

  test('reports down for fetch errors', async () => {
    const status = await checkOllamaStatus(
      'http://127.0.0.1:11434',
      async () => {
        throw new Error('connection refused');
      },
      50
    );

    expect(status.available).toBe(false);
    expect(status.error).toBe('connection refused');
  });
});

describe('stripMessageHtml', () => {
  test('removes HTML, command nodes, emoji nodes, and ProseMirror artifacts', () => {
    const html = [
      '<p>Hello&nbsp;<strong>Esseker</strong></p>',
      '<command data-plugin-id="x">/secret</command>',
      '<span data-type="emoji">party</span>',
      '<img class="emoji-image" />',
      '<img class="ProseMirror-separator" />',
      '<br class="ProseMirror-trailingBreak" />',
      '<p>&amp; goodbye</p>'
    ].join('');

    expect(stripMessageHtml(html)).toBe('Hello Esseker & goodbye');
  });
});

describe('formatMessagesForPrompt', () => {
  test('includes timestamps, author names, and text content', () => {
    const messages: StoredMessage[] = [
      {
        messageId: 1,
        channelId: 7,
        authorLabel: 'Ryuuzaki',
        textContent: 'Helldivers at 21h?',
        createdAt: Date.UTC(2026, 4, 26, 19, 0, 0)
      },
      {
        messageId: 2,
        channelId: 7,
        authorLabel: 'Esseker',
        textContent: 'Yes, then Valorant later.',
        createdAt: Date.UTC(2026, 4, 26, 19, 2, 0)
      }
    ];

    expect(formatMessagesForPrompt(messages)).toContain(
      '[2026-05-26T19:00:00.000Z] Ryuuzaki message: Helldivers at 21h?'
    );
    expect(formatMessagesForPrompt(messages)).toContain(
      '[2026-05-26T19:02:00.000Z] Esseker message: Yes, then Valorant later.'
    );
  });
});

describe('Ollama prompt content', () => {
  const messages: StoredMessage[] = [
    {
      messageId: 1,
      channelId: 7,
      authorLabel: 'Esseker',
      textContent: 'Event starts at 21:30 CEST.',
      createdAt: Date.UTC(2026, 4, 27, 5, 54, 27)
    },
    {
      messageId: 2,
      channelId: 7,
      authorLabel: 'Ryuuzaki',
      textContent: 'I can scout.',
      createdAt: Date.UTC(2026, 4, 27, 6, 24, 32)
    }
  ];

  test('formats digest window dates in readable US English instead of raw ISO', () => {
    const content = buildOllamaUserContent({
      channelName: 'Events',
      messages,
      digestMode: 'last24messages',
      now: Date.UTC(2026, 4, 27, 6, 30, 0)
    });

    expect(content).toContain('Window: last 2 messages');
    expect(content).toContain('May 27, 2026');
    expect(content).not.toContain('2026-05-27T05:54:27.000Z to 2026-05-27T06:24:32.000Z');
  });

  test('keeps the default prompt from encouraging ISO timestamp headings', () => {
    expect(DEFAULT_PROMPT).toContain('Do not copy raw ISO timestamps');
    expect(DEFAULT_PROMPT).toContain('readable US English');
    expect(formatDigestWindowDate(Date.UTC(2026, 4, 27, 5, 54, 27))).toContain(
      'May 27, 2026'
    );
  });
});

describe('context caps', () => {
  test('uses Qwen-friendly max messages by default', () => {
    expect(DEFAULT_MAX_MESSAGES).toBe(120);
    expect(DEFAULT_MAX_MESSAGE_LENGTH).toBe(500);
    expect(DEFAULT_MAX_TRANSCRIPT_CHARS).toBe(24_000);
  });

  test('truncates runtime messages to the per-message cap', () => {
    rememberMessage({
      messageId: 1,
      channelId: 7,
      authorLabel: 'Esseker',
      textContent: 'x'.repeat(DEFAULT_MAX_MESSAGE_LENGTH + 50),
      createdAt: Date.now()
    });

    const [message] = getRecentMessages(7, 10);
    expect(message?.textContent.length).toBe(DEFAULT_MAX_MESSAGE_LENGTH);
  });

  test('uses the last channel message as the runtime 24h anchor when no current messages exist', () => {
    const latest = Date.now() - 3 * DAY_MS;

    rememberMessage({
      messageId: 1,
      channelId: 7,
      authorLabel: 'Esseker',
      textContent: 'too old for anchored window',
      createdAt: latest - DAY_MS - 1000
    });
    rememberMessage({
      messageId: 2,
      channelId: 7,
      authorLabel: 'Ryuuzaki',
      textContent: 'inside anchored window',
      createdAt: latest - HOUR_MS
    });
    rememberMessage({
      messageId: 3,
      channelId: 7,
      authorLabel: 'Admin',
      textContent: 'latest old message',
      createdAt: latest
    });

    expect(getRecentMessages(7, 10).map((message) => message.messageId)).toEqual([
      2,
      3
    ]);
  });

  test('can select the last 24 runtime messages regardless of age', () => {
    const start = Date.now() - 40 * DAY_MS;

    for (let index = 1; index <= 30; index += 1) {
      rememberMessage({
        messageId: index,
        channelId: 7,
        authorLabel: 'Esseker',
        textContent: `message ${index}`,
        createdAt: start + index * DAY_MS
      });
    }

    const messages = getLastMessages(7, LAST_MESSAGES_DIGEST_COUNT);
    expect(messages).toHaveLength(24);
    expect(messages[0]?.messageId).toBe(7);
    expect(messages.at(-1)?.messageId).toBe(30);
  });

  test('truncates database HTML messages to the per-message cap', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sharkord-digest-test-'));
    const pluginPath = path.join(root, 'data', 'plugins', 'sharkord-digest');
    mkdirSync(pluginPath, { recursive: true });

    try {
      const db = new Database(path.join(root, 'data', 'db.sqlite'));
      db.exec([
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
        'CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER, user_id INTEGER, plugin_id TEXT, content TEXT, created_at INTEGER);',
        "INSERT INTO users (id, name) VALUES (2, 'Esseker');"
      ].join(' '));
      db.query(
        'INSERT INTO messages (id, channel_id, user_id, plugin_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        1,
        7,
        2,
        null,
        `<p>${'x'.repeat(DEFAULT_MAX_MESSAGE_LENGTH + 50)}</p>`,
        Date.now()
      );
      db.close();

      const messages = getRecentMessagesFromDatabase(
        { path: pluginPath, pluginId: 'sharkord-digest', error: () => undefined } as never,
        7,
        10
      );
      expect(messages[0]?.textContent.length).toBe(DEFAULT_MAX_MESSAGE_LENGTH);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the last database message as the 24h anchor when no current messages exist', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sharkord-digest-test-'));
    const pluginPath = path.join(root, 'data', 'plugins', 'sharkord-digest');
    const latest = Date.now() - 3 * DAY_MS;
    mkdirSync(pluginPath, { recursive: true });

    try {
      const db = new Database(path.join(root, 'data', 'db.sqlite'));
      db.exec([
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
        'CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER, user_id INTEGER, plugin_id TEXT, content TEXT, created_at INTEGER);',
        "INSERT INTO users (id, name) VALUES (2, 'Esseker');"
      ].join(' '));
      const insert = db.query(
        'INSERT INTO messages (id, channel_id, user_id, plugin_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run(1, 7, 2, null, '<p>too old for anchored window</p>', latest - DAY_MS - 1000);
      insert.run(2, 7, 2, null, '<p>inside anchored window</p>', latest - HOUR_MS);
      insert.run(3, 7, 2, null, '<p>latest old message</p>', latest);
      db.close();

      const messages = getRecentMessagesFromDatabase(
        { path: pluginPath, pluginId: 'sharkord-digest', error: () => undefined } as never,
        7,
        10
      );
      expect(messages.map((message) => message.messageId)).toEqual([2, 3]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('can select the last 24 database messages regardless of age', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sharkord-digest-test-'));
    const pluginPath = path.join(root, 'data', 'plugins', 'sharkord-digest');
    const start = Date.now() - 40 * DAY_MS;
    mkdirSync(pluginPath, { recursive: true });

    try {
      const db = new Database(path.join(root, 'data', 'db.sqlite'));
      db.exec([
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
        'CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER, user_id INTEGER, plugin_id TEXT, content TEXT, created_at INTEGER);',
        "INSERT INTO users (id, name) VALUES (2, 'Esseker');"
      ].join(' '));
      const insert = db.query(
        'INSERT INTO messages (id, channel_id, user_id, plugin_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (let index = 1; index <= 30; index += 1) {
        insert.run(
          index,
          7,
          2,
          null,
          `<p>message ${index}</p>`,
          start + index * DAY_MS
        );
      }
      db.close();

      const messages = getLastMessagesFromDatabase(
        { path: pluginPath, pluginId: 'sharkord-digest', error: () => undefined } as never,
        7,
        LAST_MESSAGES_DIGEST_COUNT
      );
      expect(messages).toHaveLength(24);
      expect(messages[0]?.messageId).toBe(7);
      expect(messages.at(-1)?.messageId).toBe(30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps transcript under the total cap while preserving recent messages', () => {
    const messages: StoredMessage[] = Array.from({ length: 80 }, (_, index) => ({
      messageId: index + 1,
      channelId: 7,
      authorLabel: 'User',
      textContent: `${index + 1}: ${'x'.repeat(DEFAULT_MAX_MESSAGE_LENGTH)}`,
      createdAt: Date.UTC(2026, 4, 26, 12, index, 0)
    }));

    const limited = limitMessagesForTranscript(messages, DEFAULT_MAX_TRANSCRIPT_CHARS);
    const transcript = formatMessagesForPrompt(limited);

    expect(transcript.length).toBeLessThanOrEqual(DEFAULT_MAX_TRANSCRIPT_CHARS);
    expect(limited.at(-1)?.messageId).toBe(80);
    expect(limited[0]!.messageId).toBeGreaterThan(1);
  });
});

describe('regenerate cooldowns', () => {
  test('requires an initial digest for the same user and channel', () => {
    expect(() => assertRegenerateCooldown(2, 7)).toThrow(
      'Generate a digest for this channel and mode before regenerating it.'
    );
  });

  test('allows the first regeneration after an initial digest', () => {
    setLastDigestForTests(2, 7, Date.now());

    expect(() => assertRegenerateCooldown(2, 7)).not.toThrow();
  });

  test('blocks a second regeneration before requestCooldownMinutes expires', () => {
    setLastDigestForTests(2, 7, Date.now());
    setLastRegenerateForTests(2, 7, Date.now());

    expect(() => assertRegenerateCooldown(2, 7, 'last24h', settings)).toThrow(
      'Regenerate cooldown active for this channel'
    );
  });

  test('allows regeneration after requestCooldownMinutes expires', () => {
    setLastDigestForTests(2, 7, Date.now() - HOUR_MS);
    setLastRegenerateForTests(2, 7, Date.now() - settings.requestCooldownMs - 1000);

    expect(() => assertRegenerateCooldown(2, 7, 'last24h', settings)).not.toThrow();
  });

  test('allows regeneration cooldown when request cooldown is disabled', () => {
    setLastDigestForTests(2, 7, Date.now());
    setLastRegenerateForTests(2, 7, Date.now());

    expect(() =>
      assertRegenerateCooldown(2, 7, 'last24h', { requestCooldownMs: 0 })
    ).not.toThrow();
  });

  test('tracks regeneration history separately for 24h and 24-message modes', () => {
    setLastDigestForTests(2, 7, Date.now(), 'last24h');

    expect(() => assertRegenerateCooldown(2, 7, 'last24messages')).toThrow(
      'Generate a digest for this channel and mode before regenerating it.'
    );
  });
});

describe('coin ledger', () => {
  test('initializes a user to min(refillAmount, maxBalance)', () => {
    expect(refillLedgerEntry(undefined, settings, 1000).balance).toBe(3);
    expect(
      refillLedgerEntry(undefined, { ...settings, coinRefillAmount: 20 }, 1000).balance
    ).toBe(10);
  });

  test('refills by elapsed intervals without exceeding the cap', () => {
    const entry = refillLedgerEntry(
      { balance: 8, lastRefillAt: 1000 },
      settings,
      1000 + DAY_MS
    );

    expect(entry.balance).toBe(10);
    expect(entry.lastRefillAt).toBe(1000 + DAY_MS);
  });

  test('debits immediately, refunds to cap, and blocks insufficient balance', () => {
    const ledger: CoinLedger = {
      '2': { balance: 1, lastRefillAt: 1000 }
    };

    expect(debitCoinCost(ledger, 2, settings, DIGEST_COST, 2000).balance).toBe(0);
    expect(() => debitCoinCost(ledger, 2, settings, DIGEST_COST, 3000)).toThrow(
      'Digest cooldown active'
    );

    const noCooldownSettings = { ...settings, requestCooldownMs: 0 };
    expect(() => debitCoinCost(ledger, 2, noCooldownSettings, DIGEST_COST, 3000)).toThrow(
      'Not enough digest coins.'
    );
    expect(refundCoinCost(ledger, 2, settings, DIGEST_COST).balance).toBe(1);
    ledger['2']!.balance = 10;
    expect(refundCoinCost(ledger, 2, settings, DIGEST_COST).balance).toBe(10);
  });

  test('parses only valid user ledger entries', () => {
    expect(
      parseCoinLedger(
        JSON.stringify({
          '2': {
            balance: 4.7,
            lastRefillAt: 1000,
            lastRequestAt: 900,
            pendingCosts: { job: 1.8, bad: -1 }
          },
          bad: { balance: 3, lastRefillAt: 1000 },
          '3': { balance: '3', lastRefillAt: 1000 }
        })
      )
    ).toEqual({
      '2': {
        balance: 4,
        lastRefillAt: 1000,
        lastRequestAt: 900,
        pendingCosts: { job: 1 }
      }
    });
  });

  test('reports next refill only while below cap', () => {
    expect(
      getNextRefillAt({ balance: 2, lastRefillAt: 1000 }, settings)
    ).toBe(1000 + DAY_MS);
    expect(getNextRefillAt({ balance: 10, lastRefillAt: 1000 }, settings)).toBeUndefined();
  });

  test('exposes the configured refill amount in quota responses', async () => {
    const quota = await getQuotaForUser(2, 1000);

    expect(quota.refillAmount).toBe(3);
    expect(quota.balance).toBe(3);
  });
});

describe('request cooldowns', () => {
  test('blocks a second request before requestCooldownMinutes expires', () => {
    expect(() =>
      assertUserRequestCooldown(
        { balance: 3, lastRefillAt: Date.now(), lastRequestAt: Date.now() },
        settings
      )
    ).toThrow('Digest cooldown active');
  });

  test('allows requests when cooldown is disabled', () => {
    expect(() =>
      assertUserRequestCooldown(
        { balance: 3, lastRefillAt: Date.now(), lastRequestAt: Date.now() },
        { ...settings, requestCooldownMs: 0 }
      )
    ).not.toThrow();
  });
});

describe('digest jobs', () => {
  test('start and regen use the same one-coin cost', () => {
    expect(DIGEST_COST).toBe(1);
  });

  test('digest results expose regen availability from requestCooldownMinutes', () => {
    const job: DigestJob = {
      id: 'job',
      userId: 2,
      channelId: 7,
      channelName: 'Test',
      model: settings.ollamaModel,
      regenerate: true,
      digestMode: 'last24h',
      status: 'completed',
      createdAt: 2000,
      cost: DIGEST_COST,
      refunded: false
    };
    const messages: StoredMessage[] = [
      {
        messageId: 1,
        channelId: 7,
        authorLabel: 'Esseker',
        textContent: 'GG',
        createdAt: 1500
      }
    ];

    setLastRegenerateForTests(2, 7, 2000);
    expect(buildDigestResult(job, settings, 'summary', messages, 2500).nextRegenerateAt).toBe(
      2000 + settings.requestCooldownMs
    );
    expect(
      buildDigestResult(
        job,
        { ...settings, requestCooldownMs: 0, requestCooldownMinutes: 0 },
        'summary',
        messages,
        2500
      ).nextRegenerateAt
    ).toBe(0);
  });

  test('failed jobs refund exactly once and keep cooldown state', () => {
    const job: DigestJob = {
      id: 'job',
      userId: 2,
      channelId: 7,
      channelName: 'Test',
      model: settings.ollamaModel,
      regenerate: false,
      digestMode: 'last24h',
      status: 'failed',
      createdAt: 2000,
      cost: DIGEST_COST,
      refunded: false
    };

    const ledger: CoinLedger = {
      '2': {
        balance: 0,
        lastRefillAt: 1000,
        lastRequestAt: 2000,
        pendingCosts: { job: 1 }
      }
    };

    refundJobInLedgerOnce(job, ledger, settings);
    refundJobInLedgerOnce(job, ledger, settings);

    expect(ledger['2']).toEqual({ balance: 1, lastRefillAt: 1000, lastRequestAt: 2000 });
    expect(job.refunded).toBe(true);
  });

  test('recovers pending debits after a restart without exceeding cap', () => {
    const ledger: CoinLedger = {
      '2': {
        balance: 8,
        lastRefillAt: 1000,
        lastRequestAt: 2000,
        pendingCosts: { a: 1, b: 2 }
      }
    };

    expect(recoverPendingCoinCostsInLedger(ledger, settings)).toBe(true);
    expect(ledger['2']).toEqual({ balance: 10, lastRefillAt: 1000, lastRequestAt: 2000 });
  });

  test('reports queued and running job positions', () => {
    expect(getQueuePositionFromState('a', ['a', 'b'], new Set())).toBe(1);
    expect(getQueuePositionFromState('b', ['a', 'b'], new Set())).toBe(2);
    expect(getQueuePositionFromState('c', ['a', 'b'], new Set(['c']))).toBe(0);
    expect(getQueuePositionFromState('x', ['a', 'b'], new Set(['c']))).toBeUndefined();
  });

  test('failed queued jobs refund pending debits when settings become invalid', async () => {
    const job: DigestJob = {
      id: 'queued-job',
      userId: 2,
      channelId: 7,
      channelName: 'Events',
      model: settings.ollamaModel,
      regenerate: false,
      digestMode: 'last24h',
      status: 'pending',
      createdAt: 2000,
      cost: DIGEST_COST,
      refunded: false
    };

    setSettingsForTests({
      coinLedger: JSON.stringify({
        '2': {
          balance: 2,
          lastRefillAt: 1000,
          pendingCosts: {
            [job.id]: DIGEST_COST
          }
        }
      })
    });
    setQueuedDigestJobForTests(job, settings);

    failQueuedDigestJobs('disabled');
    const quota = await getQuotaForUser(2, 2000, settings);

    expect(job.status).toBe('failed');
    expect(job.error).toBe('disabled');
    expect(job.refunded).toBe(true);
    expect(quota.balance).toBe(3);
  });
});
