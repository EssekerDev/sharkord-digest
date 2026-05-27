import type {
  TPluginComponentsMapBySlotId,
  TPluginStore,
  TPluginStoreState
} from '@sharkord/plugin-sdk';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DIGEST_CACHE_TTL_MS,
  DIGEST_PLUGIN_DISABLED_LABEL,
  areDigestInteractionsDisabledByOllama,
  getActiveDigestJobStorageKey,
  getCoinActionLabel,
  getCoinBadgeLabel,
  getCopyButtonLabel,
  getDigestLoadingLabel,
  getDigestModeEmptyLabel,
  getDigestModeLabel,
  getDigestResultCacheKey,
  getFreshDigestForChannelMode,
  getOllamaStatusClassName,
  getOllamaStatusTooltip,
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
  type ActiveDigestJobCacheEntry,
  type DigestChannelOption,
  type OllamaAvailabilityState,
  withMinimumDelay
} from './helpers';
import type {
  DigestActionResponse,
  DigestJobPayload,
  DigestJobResponse,
  DigestMode,
  DigestPluginHealthResponse,
  DigestQuotaResponse,
  OllamaStatusResponse,
  StartDigestJobPayload,
  StartDigestJobResponse
} from '../shared/types';

declare global {
  interface Window {
    __SHARKORD_STORE__: TPluginStore;
  }
}

const styles = {
  wrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center'
  },
  trigger: {
    width: 28,
    height: 28,
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid transparent',
    background: 'transparent',
    color: 'var(--foreground)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontWeight: 700,
    fontSize: 13,
    lineHeight: 1
  },
  panel: {
    position: 'absolute',
    top: 36,
    right: 0,
    width: 500,
    maxWidth: 'calc(100vw - 24px)',
    zIndex: 50,
    borderRadius: 'var(--radius-lg, 10px)',
    border: '1px solid var(--border)',
    background: 'var(--popover)',
    boxShadow: '0 16px 40px rgba(0, 0, 0, 0.22)',
    color: 'var(--popover-foreground)',
    padding: 12
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    marginBottom: 10
  },
  headerDivider: {
    height: 1,
    borderTop: '1px solid var(--border)',
    margin: '0 -12px 10px',
    opacity: 0.72
  },
  titleGroup: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 4
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0
  },
  coinBadge: {
    height: 28,
    minWidth: 58,
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid color-mix(in oklch, #d5a92d, var(--border) 35%)',
    background: 'color-mix(in oklch, #d5a92d, var(--popover) 78%)',
    color: 'color-mix(in oklch, #ffd86b, var(--foreground) 25%)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '0 9px',
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1,
    whiteSpace: 'nowrap'
  },
  coinIcon: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    border: '1px solid currentColor',
    background: 'color-mix(in oklch, #ffd86b, transparent 20%)',
    boxShadow: 'inset 0 0 0 2px color-mix(in oklch, #d5a92d, transparent 35%)'
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid transparent',
    background: 'transparent',
    color: 'var(--muted-foreground)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1
  },
  actions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4
  },
  controls: {
    display: 'grid',
    gridTemplateColumns: '1fr auto auto',
    gap: 8,
    marginBottom: 10
  },
  selectWrap: {
    position: 'relative',
    minWidth: 0
  },
  select: {
    appearance: 'none',
    WebkitAppearance: 'none',
    minWidth: 0,
    width: '100%',
    height: 34,
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid var(--input)',
    background: 'var(--background)',
    color: 'var(--foreground)',
    padding: '0 34px 0 10px',
    fontSize: 13
  },
  selectChevron: {
    position: 'absolute',
    right: 12,
    top: '50%',
    width: 8,
    height: 8,
    borderRight: '2px solid var(--muted-foreground)',
    borderBottom: '2px solid var(--muted-foreground)',
    transform: 'translateY(-65%) rotate(45deg)',
    pointerEvents: 'none'
  },
  modeSwitch: {
    height: 34,
    borderRadius: '999px',
    border: '1px solid var(--border)',
    background: 'var(--background)',
    padding: 3,
    display: 'inline-grid',
    gridTemplateColumns: '1fr 1fr',
    alignItems: 'center',
    gap: 2
  },
  modeSwitchButton: {
    height: 26,
    minWidth: 38,
    border: 0,
    borderRadius: '999px',
    background: 'transparent',
    color: 'var(--muted-foreground)',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    padding: '0 8px',
    lineHeight: 1
  },
  modeSwitchButtonActive: {
    background: 'var(--primary)',
    color: 'var(--primary-foreground)',
    boxShadow: '0 1px 5px rgba(0, 0, 0, 0.2)'
  },
  primaryButton: {
    height: 34,
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid var(--primary)',
    background: 'var(--primary)',
    color: 'var(--primary-foreground)',
    fontWeight: 600,
    padding: '0 12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontSize: 13
  },
  buttonContent: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  disabled: {
    opacity: 0.55,
    cursor: 'not-allowed'
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid var(--border)',
    background: 'var(--muted)',
    padding: 10,
    marginTop: 8,
    color: 'var(--muted-foreground)',
    fontSize: 13,
    lineHeight: 1.4
  },
  spinner: {
    width: 16,
    height: 16,
    borderRadius: '50%',
    border: '2px solid var(--border)',
    borderTopColor: 'var(--foreground)',
    animation: 'sharkordDigestSpin 0.8s linear infinite'
  },
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8
  },
  meta: {
    minWidth: 0,
    fontSize: 12,
    color: 'var(--muted-foreground)',
    lineHeight: 1.35
  },
  quotaRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
    minHeight: 20
  },
  quotaText: {
    minWidth: 0,
    fontSize: 12,
    color: 'var(--muted-foreground)',
    lineHeight: 1.35
  },
  quotaWarning: {
    fontSize: 12,
    color: 'var(--destructive)',
    lineHeight: 1.35,
    textAlign: 'right'
  },
  output: {
    maxHeight: 380,
    overflow: 'auto',
    wordBreak: 'break-word',
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid var(--border)',
    background: 'var(--background)',
    padding: 12,
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--foreground)'
  },
  menuWrap: {
    position: 'relative'
  },
  menu: {
    position: 'absolute',
    top: 32,
    right: 0,
    width: 190,
    zIndex: 60,
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid var(--border)',
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    boxShadow: '0 12px 30px rgba(0, 0, 0, 0.22)',
    padding: 4
  },
  menuItem: {
    width: '100%',
    minHeight: 30,
    border: 0,
    borderRadius: 'var(--radius-sm, 6px)',
    background: 'transparent',
    color: 'var(--popover-foreground)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 8,
    padding: '0 9px',
    cursor: 'pointer',
    fontSize: 13
  },
  menuDangerItem: {
    color: 'color-mix(in oklch, var(--destructive), var(--popover-foreground) 18%)',
    background: 'color-mix(in oklch, var(--destructive), transparent 92%)'
  },
  menuIcon: {
    width: 16,
    minWidth: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'currentColor',
    fontSize: 13,
    lineHeight: 1,
    opacity: 0.9
  },
  menuText: {
    minWidth: 0,
    display: 'inline-flex',
    alignItems: 'center'
  },
  error: {
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid color-mix(in oklch, var(--destructive), var(--border) 55%)',
    background: 'color-mix(in oklch, var(--destructive), transparent 86%)',
    color: 'var(--foreground)',
    padding: 10,
    fontSize: 13,
    lineHeight: 1.4
  },
  empty: {
    borderRadius: 'var(--radius-md, 8px)',
    border: '1px solid var(--border)',
    background: 'var(--muted)',
    color: 'var(--muted-foreground)',
    padding: 10,
    fontSize: 13,
    lineHeight: 1.4
  },
  disabledPlaceholder: {
    minHeight: 112,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    color: 'var(--muted-foreground)',
    fontSize: 13,
    lineHeight: 1.4,
    padding: 12
  },
  statePrefix: {
    marginRight: 6
  }
} satisfies Record<string, React.CSSProperties>;

const markdownStyles = {
  paragraph: {
    margin: '0 0 10px'
  },
  heading1: {
    margin: '0 0 12px',
    fontSize: 17,
    lineHeight: 1.3,
    fontWeight: 700
  },
  heading2: {
    margin: '14px 0 8px',
    fontSize: 15,
    lineHeight: 1.35,
    fontWeight: 700
  },
  heading3: {
    margin: '12px 0 8px',
    fontSize: 14,
    lineHeight: 1.35,
    fontWeight: 700
  },
  list: {
    margin: '0 0 10px',
    paddingLeft: 20
  },
  listItem: {
    margin: '0 0 4px'
  },
  code: {
    borderRadius: 'var(--radius-sm, 6px)',
    background: 'var(--muted)',
    padding: '1px 5px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.92em'
  },
  link: {
    color: 'var(--primary)',
    textDecoration: 'underline',
    textUnderlineOffset: 2
  }
} satisfies Record<string, React.CSSProperties>;

const usePluginState = (): TPluginStoreState => {
  const [state, setState] = useState(() => window.__SHARKORD_STORE__.getState());

  useEffect(() => {
    return window.__SHARKORD_STORE__.subscribe(() => {
      setState(window.__SHARKORD_STORE__.getState());
    });
  }, []);

  return state;
};

const formatDateTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short'
  });
};

const getDigestCacheStorageKey = (userId: number | undefined): string => {
  return `sharkord-digest:v4:results:${userId ?? 'anonymous'}`;
};

const isDigestActionResponse = (value: unknown): value is DigestActionResponse => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DigestActionResponse>;
  return (
    typeof candidate.summary === 'string' &&
    typeof candidate.channelId === 'number' &&
    typeof candidate.channelName === 'string' &&
    typeof candidate.model === 'string' &&
    typeof candidate.generatedAt === 'number' &&
    typeof candidate.messageCount === 'number' &&
    typeof candidate.since === 'number' &&
    typeof candidate.nextAllowedAt === 'number' &&
    typeof candidate.nextRegenerateAt === 'number' &&
    typeof candidate.regenerated === 'boolean' &&
    (candidate.digestMode === 'last24h' || candidate.digestMode === 'last24messages')
  );
};

const readDigestCache = (
  storageKey: string,
  now: number
): Record<string, DigestActionResponse> => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, DigestActionResponse] =>
          isDigestActionResponse(entry[1])
        )
        .filter(([, result]) => now - result.generatedAt < DIGEST_CACHE_TTL_MS)
        .map(([, result]) => [
          getDigestResultCacheKey(result.channelId, result.digestMode),
          result
        ])
    );
  } catch {
    return {};
  }
};

const writeDigestCache = (
  storageKey: string,
  resultsByKey: Record<string, DigestActionResponse>
): void => {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(resultsByKey));
  } catch {
    // Cache persistence is best-effort; the in-memory digest remains available.
  }
};

const readActiveDigestJob = (
  storageKey: string
): ActiveDigestJobCacheEntry | undefined => {
  try {
    return parseActiveDigestJobCacheEntry(
      JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
    );
  } catch {
    return undefined;
  }
};

const writeActiveDigestJob = (
  storageKey: string,
  activeJob: ActiveDigestJobCacheEntry | undefined
): void => {
  try {
    if (activeJob) {
      window.localStorage.setItem(storageKey, JSON.stringify(activeJob));
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Active job resume is best-effort; the server still owns the job state.
  }
};

const InlineMarkdown = ({ text }: { text: string }) => {
  return (
    <>
      {parseInlineMarkdown(text).map((part, index) => {
        if (part.type === 'strong') {
          return <strong key={index}>{part.text}</strong>;
        }

        if (part.type === 'code') {
          return (
            <code key={index} style={markdownStyles.code}>
              {part.text}
            </code>
          );
        }

        if (part.type === 'link' && part.href) {
          return (
            <a
              key={index}
              href={part.href}
              target="_blank"
              rel="noopener noreferrer"
              style={markdownStyles.link}
            >
              {part.text}
            </a>
          );
        }

        return <React.Fragment key={index}>{part.text}</React.Fragment>;
      })}
    </>
  );
};

const CoinIcon = () => <span aria-hidden="true" style={styles.coinIcon} />;

const CoinActionLabel = ({
  action,
  cost
}: {
  action: 'start' | 'regen';
  cost?: number;
}) => (
  <span style={styles.buttonContent}>
    <span>{getCoinActionLabel(action, cost)}</span>
    <CoinIcon />
  </span>
);

const MenuIcon = ({
  kind
}: {
  kind: 'copy' | 'markdown' | 'regen' | 'delete';
}) => {
  if (kind === 'delete') {
    return (
      <span style={styles.menuIcon}>
        <span className="sharkord-digest-trash-icon" aria-hidden="true" />
      </span>
    );
  }

  const label = kind === 'copy' ? '\u2398' : kind === 'markdown' ? 'M' : '\u21bb';

  return (
    <span style={styles.menuIcon} aria-hidden="true">
      {label}
    </span>
  );
};

const MarkdownView = ({ markdown }: { markdown: string }) => {
  return (
    <>
      {parseMarkdownBlocks(markdown).map((block, index) => {
        if (block.type === 'list') {
          return (
            <ul key={index} style={markdownStyles.list}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} style={markdownStyles.listItem}>
                  <InlineMarkdown text={item} />
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === 'heading' && block.level === 1) {
          return (
            <h1 key={index} style={markdownStyles.heading1}>
              <InlineMarkdown text={block.text} />
            </h1>
          );
        }

        if (block.type === 'heading' && block.level === 2) {
          return (
            <h2 key={index} style={markdownStyles.heading2}>
              <InlineMarkdown text={block.text} />
            </h2>
          );
        }

        if (block.type === 'heading' && block.level === 3) {
          return (
            <h3 key={index} style={markdownStyles.heading3}>
              <InlineMarkdown text={block.text} />
            </h3>
          );
        }

        return (
          <p key={index} style={markdownStyles.paragraph}>
            <InlineMarkdown text={block.text} />
          </p>
        );
      })}
    </>
  );
};

const DigestTopbarButton = () => {
  const pluginState = usePluginState();
  const digestCacheStorageKey = getDigestCacheStorageKey(pluginState.ownUserId);
  const activeDigestJobStorageKey = getActiveDigestJobStorageKey(pluginState.ownUserId);
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<number | undefined>(
    pluginState.selectedChannelId
  );
  const [digestMode, setDigestMode] = useState<DigestMode>('last24h');
  const [lastSyncedHostChannelId, setLastSyncedHostChannelId] = useState<
    number | undefined
  >(pluginState.selectedChannelId);
  const [loading, setLoading] = useState(false);
  const [resultsByKey, setResultsByKey] = useState<
    Record<string, DigestActionResponse>
  >(() => readDigestCache(digestCacheStorageKey, Date.now()));
  const [activeDigestCacheStorageKey, setActiveDigestCacheStorageKey] =
    useState(digestCacheStorageKey);
  const [error, setError] = useState<string | undefined>();
  const [copyTarget, setCopyTarget] = useState<'main' | 'markdown' | undefined>();
  const [quota, setQuota] = useState<DigestQuotaResponse | undefined>();
  const [quotaTick, setQuotaTick] = useState(0);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [queuePosition, setQueuePosition] = useState<number | undefined>();
  const [pluginEnabled, setPluginEnabled] = useState<boolean | undefined>();
  const [ollamaStatus, setOllamaStatus] =
    useState<OllamaAvailabilityState>('checking');
  const [activeJob, setActiveJob] = useState<ActiveDigestJobCacheEntry | undefined>(
    () => readActiveDigestJob(activeDigestJobStorageKey)
  );
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  const channels = useMemo(
    () => getTextChannelOptions(pluginState.channels as DigestChannelOption[]),
    [pluginState.channels]
  );

  useEffect(() => {
    setResultsByKey(readDigestCache(digestCacheStorageKey, Date.now()));
    setActiveDigestCacheStorageKey(digestCacheStorageKey);
  }, [digestCacheStorageKey]);

  useEffect(() => {
    setActiveJob(readActiveDigestJob(activeDigestJobStorageKey));
  }, [activeDigestJobStorageKey]);

  useEffect(() => {
    if (activeDigestCacheStorageKey !== digestCacheStorageKey) return;
    writeDigestCache(activeDigestCacheStorageKey, resultsByKey);
  }, [activeDigestCacheStorageKey, digestCacheStorageKey, resultsByKey]);

  useEffect(() => {
    writeActiveDigestJob(activeDigestJobStorageKey, activeJob);
  }, [activeDigestJobStorageKey, activeJob]);

  useEffect(() => {
    const next = resolveChannelSelection({
      channels: pluginState.channels as DigestChannelOption[],
      hostSelectedChannelId: pluginState.selectedChannelId,
      currentSelectedChannelId: selectedChannelId,
      lastSyncedHostChannelId
    });

    setSelectedChannelId(next.selectedChannelId);
    setLastSyncedHostChannelId(next.syncedHostChannelId);
  }, [
    channels,
    lastSyncedHostChannelId,
    pluginState.channels,
    pluginState.selectedChannelId,
    selectedChannelId
  ]);

  useEffect(() => {
    if (!open) {
      setPluginEnabled(undefined);
      return undefined;
    }

    let cancelled = false;
    setPluginEnabled(undefined);
    setError(undefined);
    setMenuOpen(false);

    window.__SHARKORD_STORE__.actions
      .executePluginAction<DigestPluginHealthResponse>('getDigestPluginHealth')
      .then((health) => {
        if (!cancelled) {
          setPluginEnabled(health.enabled);
          if (!health.enabled) {
            setActiveJob(undefined);
            setLoading(false);
            setQueuePosition(undefined);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPluginEnabled(false);
          setActiveJob(undefined);
          setLoading(false);
          setQueuePosition(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !shouldShowDigestFunctionalUi(pluginEnabled)) return undefined;

    let cancelled = false;
    window.__SHARKORD_STORE__.actions
      .executePluginAction<DigestQuotaResponse>('getDigestQuota')
      .then((nextQuota) => {
        if (!cancelled) setQuota(nextQuota);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });

    return () => {
      cancelled = true;
    };
  }, [open, pluginEnabled, quotaTick]);

  useEffect(() => {
    if (!open) {
      setOllamaStatus('checking');
      return undefined;
    }
    if (!shouldShowDigestFunctionalUi(pluginEnabled)) return undefined;

    let cancelled = false;
    setOllamaStatus('checking');

    withMinimumDelay(
      window.__SHARKORD_STORE__.actions.executePluginAction<OllamaStatusResponse>(
        'getOllamaStatus'
      )
    )
      .then((status) => {
        if (!cancelled) setOllamaStatus(status.available ? 'up' : 'down');
      })
      .catch(() => {
        if (!cancelled) setOllamaStatus('down');
      });

    return () => {
      cancelled = true;
    };
  }, [open, pluginEnabled]);

  useEffect(() => {
    if (
      !open ||
      !shouldShowDigestFunctionalUi(pluginEnabled) ||
      (!quota?.requestCooldownRemainingMs && !quota?.nextRefillAt)
    ) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, [open, pluginEnabled, quota?.nextRefillAt, quota?.requestCooldownRemainingMs]);

  useEffect(() => {
    if (!open || !quota || !shouldShowDigestFunctionalUi(pluginEnabled)) return undefined;

    const refreshTargets = [
      quota.nextRequestAllowedAt,
      quota.nextRefillAt && quota.balance < quota.maxBalance ? quota.nextRefillAt : undefined
    ].filter((value): value is number => typeof value === 'number');
    if (refreshTargets.length === 0) return undefined;

    const refreshAt = Math.min(...refreshTargets);
    const timeout = window.setTimeout(() => {
      setQuotaTick((value) => value + 1);
    }, Math.max(250, refreshAt - Date.now() + 250));

    return () => window.clearTimeout(timeout);
  }, [
    open,
    pluginEnabled,
    quota?.balance,
    quota?.maxBalance,
    quota?.nextRefillAt,
    quota?.nextRequestAllowedAt
  ]);

  const cachedResult = getFreshDigestForChannelMode(
    resultsByKey,
    selectedChannelId,
    digestMode,
    clockNow
  );
  const result =
    loading || !shouldShowDigestFunctionalUi(pluginEnabled) ? undefined : cachedResult;

  useEffect(() => {
    setError(undefined);
    setCopyTarget(undefined);
    setMenuOpen(false);
  }, [selectedChannelId, digestMode]);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuWrapRef.current?.contains(target)) return;
      setMenuOpen(false);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    const expiredCacheKeys = Object.entries(resultsByKey)
      .filter(([, cachedResult]) => clockNow - cachedResult.generatedAt >= DIGEST_CACHE_TTL_MS)
      .map(([cacheKey]) => cacheKey);

    if (expiredCacheKeys.length === 0) return;

    setResultsByKey((current) => {
      const next = { ...current };
      for (const cacheKey of expiredCacheKeys) {
        delete next[cacheKey];
      }
      return next;
    });
  }, [clockNow, resultsByKey]);

  useEffect(() => {
    if (!activeJob || !shouldShowDigestFunctionalUi(pluginEnabled)) return undefined;

    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setSelectedChannelId(activeJob.channelId);
    setDigestMode(activeJob.digestMode);

    const pollActiveJob = async () => {
      try {
        let lastJob: DigestJobResponse | undefined;
        while (!cancelled && (!lastJob || lastJob.status === 'pending')) {
          lastJob = await window.__SHARKORD_STORE__.actions.executePluginAction<
            DigestJobResponse,
            DigestJobPayload
          >('getDigestJob', {
            jobId: activeJob.jobId
          });
          if (cancelled) return;

          setQueuePosition(lastJob.queuePosition);
          if (lastJob.status === 'pending') {
            await new Promise((resolve) => window.setTimeout(resolve, 1500));
          }
        }

        if (cancelled || !lastJob) return;

        if (lastJob.status === 'completed' && lastJob.result) {
          const completedResult = lastJob.result;
          setResultsByKey((current) => ({
            ...current,
            [getDigestResultCacheKey(completedResult.channelId, completedResult.digestMode)]:
              completedResult
          }));
        } else {
          throw new Error(lastJob.error || 'Digest job failed.');
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) {
          setActiveJob(undefined);
          setQuotaTick((value) => value + 1);
          setQueuePosition(undefined);
          setLoading(false);
        }
      }
    };

    void pollActiveJob();

    return () => {
      cancelled = true;
    };
  }, [activeJob, pluginEnabled]);

  const copySummary = async (target: 'main' | 'markdown') => {
    if (!result || ollamaInteractionsDisabled || !shouldShowDigestFunctionalUi(pluginEnabled)) {
      return;
    }

    const textToCopy =
      target === 'markdown' ? result.summary : markdownToPlainText(result.summary);
    await navigator.clipboard.writeText(textToCopy);
    setCopyTarget(target);
    setTimeout(() => setCopyTarget(undefined), 1600);
  };

  const requestDigest = async (regenerate: boolean) => {
    if (
      !selectedChannelId ||
      loading ||
      ollamaInteractionsDisabled ||
      !shouldShowDigestFunctionalUi(pluginEnabled)
    ) {
      return;
    }

    setLoading(true);
    setMenuOpen(false);
    setError(undefined);

    try {
      const started = await window.__SHARKORD_STORE__.actions.executePluginAction<
        StartDigestJobResponse,
        StartDigestJobPayload
      >('startDigestJob', {
        channelId: selectedChannelId,
        regenerate,
        digestMode
      });

      setQuota(started.quota);
      setQueuePosition(started.queuePosition);
      setActiveJob({
        jobId: started.jobId,
        channelId: selectedChannelId,
        digestMode,
        createdAt: Date.now()
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setQuotaTick((value) => value + 1);
      setQueuePosition(undefined);
      setLoading(false);
    }
  };

  const liveQuota = quota
    ? {
        ...quota,
        requestCooldownRemainingMs: quota.nextRequestAllowedAt
          ? Math.max(0, quota.nextRequestAllowedAt - clockNow)
          : quota.requestCooldownRemainingMs
      }
    : undefined;
  const startBlockReason = getQuotaBlockReason(liveQuota, 'start');
  const regenBlockReason = getQuotaBlockReason(liveQuota, 'regen');
  const ollamaInteractionsDisabled =
    areDigestInteractionsDisabledByOllama(ollamaStatus);
  const canRegenerate =
    !!result &&
    !!quota &&
    result.channelId === selectedChannelId &&
    result.digestMode === digestMode &&
    !loading &&
    !ollamaInteractionsDisabled &&
    clockNow >= result.nextRegenerateAt &&
    !regenBlockReason;

  const disabled =
    loading ||
    ollamaInteractionsDisabled ||
    !quota ||
    !selectedChannelId ||
    channels.length === 0 ||
    !!startBlockReason;
  const coinBadgeTitle = getRefillLabel(quota, clockNow);

  return (
    <div style={styles.wrapper}>
      <style>
        {`
          @keyframes sharkordDigestSpin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          .sharkord-digest-hover:hover {
            background: var(--accent) !important;
            color: var(--accent-foreground) !important;
          }
          .sharkord-digest-select::-ms-expand {
            display: none;
          }
          .sharkord-digest-close-icon {
            position: relative;
            display: block;
            width: 12px;
            height: 12px;
          }
          .sharkord-digest-close-icon::before,
          .sharkord-digest-close-icon::after {
            content: "";
            position: absolute;
            left: 50%;
            top: 50%;
            width: 12px;
            height: 1.75px;
            border-radius: 999px;
            background: currentColor;
            transform-origin: center;
          }
          .sharkord-digest-close-icon::before {
            transform: translate(-50%, -50%) rotate(45deg);
          }
          .sharkord-digest-close-icon::after {
            transform: translate(-50%, -50%) rotate(-45deg);
          }
          .sharkord-digest-trigger-star {
            display: block;
            width: 16px;
            height: 16px;
            background: currentColor;
            clip-path: polygon(
              50% 0%,
              63% 35%,
              100% 50%,
              63% 65%,
              50% 100%,
              37% 65%,
              0% 50%,
              37% 35%
            );
            filter: drop-shadow(0 0 4px color-mix(in oklch, currentColor, transparent 70%));
          }
          .sharkord-digest-ollama-dot {
            width: 9px;
            height: 9px;
            border-radius: 999px;
            display: inline-block;
            flex: 0 0 auto;
            transform: scale(0.94);
            box-shadow: 0 0 6px 2px color-mix(in oklch, currentColor, transparent 76%);
            animation: sharkordDigestStatusBreath 3.2s ease-in-out infinite;
            transition:
              background-color 360ms ease,
              color 360ms ease,
              box-shadow 360ms ease,
              opacity 360ms ease;
            will-change: transform, box-shadow, opacity;
          }
          .sharkord-digest-ollama-dot-checking {
            color: #f59e0b;
            background: #f59e0b;
          }
          .sharkord-digest-ollama-dot-up {
            color: #22c55e;
            background: #22c55e;
          }
          .sharkord-digest-ollama-dot-down {
            color: #ef4444;
            background: #ef4444;
          }
          @keyframes sharkordDigestStatusBreath {
            0% {
              transform: scale(0.94);
              box-shadow: 0 0 6px 2px color-mix(in oklch, currentColor, transparent 76%);
              opacity: 0.82;
            }
            50% {
              transform: scale(1.02);
              box-shadow: 0 0 9px 3px color-mix(in oklch, currentColor, transparent 66%);
              opacity: 0.98;
            }
            100% {
              transform: scale(0.94);
              box-shadow: 0 0 6px 2px color-mix(in oklch, currentColor, transparent 76%);
              opacity: 0.82;
            }
          }
          .sharkord-digest-trash-icon {
            position: relative;
            display: block;
            width: 14px;
            height: 14px;
          }
          .sharkord-digest-trash-icon::before {
            content: "";
            position: absolute;
            left: 3px;
            top: 5px;
            width: 8px;
            height: 8px;
            border: 1.7px solid currentColor;
            border-top: 0;
            border-radius: 0 0 2px 2px;
          }
          .sharkord-digest-trash-icon::after {
            content: "";
            position: absolute;
            left: 2px;
            top: 2px;
            width: 10px;
            height: 1.7px;
            border-radius: 999px;
            background: currentColor;
            box-shadow: 3px -2.5px 0 -0.5px currentColor;
          }
        `}
      </style>
      <button
        type="button"
        className="sharkord-digest-hover"
        style={styles.trigger}
        title="Sharkord Digest"
        aria-label="Open Sharkord Digest"
        onClick={() => {
          setOpen((value) => {
            const nextOpen = !value;
            if (nextOpen) setOllamaStatus('checking');
            return nextOpen;
          });
        }}
      >
        <span className="sharkord-digest-trigger-star" aria-hidden="true" />
      </button>

      {open && (
        <div style={styles.panel}>
          {shouldShowDigestFunctionalUi(pluginEnabled) ? (
            <>
          <div style={styles.header}>
            <div style={styles.titleGroup}>
              <span
                className={getOllamaStatusClassName(ollamaStatus)}
                title={getOllamaStatusTooltip(ollamaStatus)}
                aria-label={getOllamaStatusTooltip(ollamaStatus)}
              />
              <h2 style={styles.title}>Sharkord Digest</h2>
            </div>
            <div style={styles.actions}>
              <div style={styles.coinBadge} title={coinBadgeTitle}>
                <CoinIcon />
                <span>{getCoinBadgeLabel(quota?.balance, quota?.maxBalance)}</span>
              </div>

              {result && (
                <div ref={menuWrapRef} style={styles.menuWrap}>
                  <button
                    type="button"
                    className="sharkord-digest-hover"
                    style={styles.iconButton}
                    title="More"
                    aria-label="More"
                    onClick={() => setMenuOpen((value) => !value)}
                  >
                    {'\u22EE'}
                  </button>
                  {menuOpen && (
                    <div style={styles.menu}>
                      <button
                        type="button"
                        className="sharkord-digest-hover"
                        style={{
                          ...styles.menuItem,
                          ...(ollamaInteractionsDisabled ? styles.disabled : undefined)
                        }}
                        disabled={ollamaInteractionsDisabled}
                        onClick={() => copySummary('main')}
                      >
                        <MenuIcon kind="copy" />
                        <span style={styles.menuText}>
                          {getCopyButtonLabel(copyTarget === 'main', 'Copy')}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="sharkord-digest-hover"
                        style={{
                          ...styles.menuItem,
                          ...(ollamaInteractionsDisabled ? styles.disabled : undefined)
                        }}
                        disabled={ollamaInteractionsDisabled}
                        onClick={() => copySummary('markdown')}
                      >
                        <MenuIcon kind="markdown" />
                        <span style={styles.menuText}>
                          {getCopyButtonLabel(
                            copyTarget === 'markdown',
                            'Copy Markdown'
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="sharkord-digest-hover"
                        style={{
                          ...styles.menuItem,
                          ...(canRegenerate && !ollamaInteractionsDisabled
                            ? undefined
                            : styles.disabled)
                        }}
                        disabled={!canRegenerate || ollamaInteractionsDisabled}
                        title={
                          regenBlockReason ??
                          (result.nextRegenerateAt > clockNow
                            ? `Available after ${formatDateTime(result.nextRegenerateAt)}`
                            : 'Regenerate')
                        }
                        onClick={() => requestDigest(true)}
                      >
                        <MenuIcon kind="regen" />
                        <CoinActionLabel action="regen" cost={quota?.regenerateCost} />
                      </button>
                      {shouldShowDeleteCachedDigestButton(!!result, loading) && (
                        <button
                          type="button"
                          style={{
                            ...styles.menuItem,
                            ...styles.menuDangerItem,
                            ...(ollamaInteractionsDisabled ? styles.disabled : undefined)
                          }}
                          disabled={ollamaInteractionsDisabled}
                          title="Delete cached result"
                          aria-label="Delete cached result"
                          onClick={() => {
                            setMenuOpen(false);
                            setCopyTarget(undefined);
                            setResultsByKey((current) =>
                              removeDigestResultFromCache(
                                current,
                                result.channelId,
                                result.digestMode
                              )
                            );
                          }}
                        >
                          <MenuIcon kind="delete" />
                          <span style={styles.menuText}>Delete</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                className="sharkord-digest-hover"
                style={styles.iconButton}
                title="Close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                <span className="sharkord-digest-close-icon" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div style={styles.headerDivider} />

          <div style={styles.controls}>
            <div style={styles.selectWrap}>
              <select
                className="sharkord-digest-select"
                style={styles.select}
                value={selectedChannelId ?? ''}
                disabled={loading || ollamaInteractionsDisabled || channels.length === 0}
                onChange={(event) => setSelectedChannelId(Number(event.target.value))}
                aria-label="Text channel"
              >
                {channels.length === 0 && <option value="">No text channels</option>}
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
              <span aria-hidden="true" style={styles.selectChevron} />
            </div>
            <div
              style={styles.modeSwitch}
              role="group"
              aria-label="Digest window"
              title="Choose the digest window"
            >
              {(['last24h', 'last24messages'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  style={{
                    ...styles.modeSwitchButton,
                    ...(digestMode === mode ? styles.modeSwitchButtonActive : undefined)
                  }}
                  disabled={loading || ollamaInteractionsDisabled}
                  aria-pressed={digestMode === mode}
                  title={
                    mode === 'last24h'
                      ? 'Summarize the selected 24-hour window'
                      : 'Summarize the last 24 messages, regardless of date'
                  }
                  onClick={() => setDigestMode(mode)}
                >
                  {getDigestModeLabel(mode)}
                </button>
              ))}
            </div>
            <button
              type="button"
              style={{
                ...styles.primaryButton,
                ...(disabled ? styles.disabled : undefined)
              }}
              disabled={disabled}
              title={startBlockReason}
              onClick={() => requestDigest(false)}
            >
              <CoinActionLabel action="start" cost={quota?.startCost} />
            </button>
          </div>

          {(startBlockReason || regenBlockReason) && (
            <div style={styles.quotaRow}>
              <div style={styles.quotaText} />
              <div style={styles.quotaWarning}>
                {startBlockReason || regenBlockReason}
              </div>
            </div>
          )}

          {loading && (
            <div style={styles.loading}>
              <span style={styles.spinner} />
              <span>{getDigestLoadingLabel(queuePosition)}</span>
            </div>
          )}

          {error && (
            <div style={styles.error}>
              <span aria-hidden="true" style={styles.statePrefix}>
                {'\u274c'}
              </span>
              {error}
            </div>
          )}

          {!loading && !error && !result && (
            <div style={styles.empty}>
              <span aria-hidden="true" style={styles.statePrefix}>
                {'\u2728'}
              </span>
              {getDigestModeEmptyLabel(digestMode)}
            </div>
          )}

          {result && (
            <>
              <div style={styles.metaRow}>
                <div style={styles.meta}>
                  #{result.channelName} - {getDigestModeLabel(result.digestMode)} -{' '}
                  {result.messageCount} messages - {result.model} - next digest after{' '}
                  {formatDateTime(result.nextAllowedAt)}
                  {result.regenerated ? ' - regenerated' : ''}
                </div>
              </div>
              <div style={styles.output}>
                <MarkdownView markdown={result.summary} />
              </div>
            </>
          )}
            </>
          ) : (
            <div style={styles.disabledPlaceholder}>
              {shouldShowDigestDisabledPlaceholder(pluginEnabled)
                ? DIGEST_PLUGIN_DISABLED_LABEL
                : 'Checking plugin...'}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const components: TPluginComponentsMapBySlotId = {
  topbar_right: [DigestTopbarButton]
};

export { components };
