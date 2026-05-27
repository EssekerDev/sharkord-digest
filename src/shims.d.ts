declare module '@sharkord/plugin-sdk' {
  import type React from 'react';

  export type TPluginSettingDefinition = {
    key: string;
    name: string;
    description?: string;
    type: 'string' | 'number' | 'boolean';
    defaultValue: string | number | boolean;
  };

  type SettingValueType<T extends TPluginSettingDefinition> =
    T['type'] extends 'string'
      ? string
      : T['type'] extends 'number'
        ? number
        : T['type'] extends 'boolean'
          ? boolean
          : unknown;

  export interface PluginSettings<
    T extends readonly TPluginSettingDefinition[] = TPluginSettingDefinition[]
  > {
    get<K extends T[number]['key']>(
      key: K
    ): SettingValueType<Extract<T[number], { key: K }>>;
    set<K extends T[number]['key']>(
      key: K,
      value: SettingValueType<Extract<T[number], { key: K }>>
    ): void;
  }

  export type TInvokerContext = {
    userId: number;
    currentVoiceChannelId?: number;
  };

  export type ActionDefinition<TPayload = void> = {
    name: string;
    description?: string;
    execute: (ctx: TInvokerContext, payload: TPayload) => Promise<unknown>;
  };

  export type ServerEvent =
    | 'message:created'
    | 'setting:set'
    | 'user:joined'
    | 'user:left'
    | 'user:joined_voice'
    | 'user:left_voice'
    | 'message:updated'
    | 'message:deleted'
    | 'voice:runtime_initialized'
    | 'voice:runtime_closed';

  export type EventPayloads = {
    'message:created': {
      messageId: number;
      channelId: number;
      userId: number | null;
      pluginId: string | null;
      content: string;
      textContent: string;
    };
    'setting:set': {
      key: string;
      value: unknown;
    };
    [key: string]: unknown;
  };

  export interface PluginContext {
    pluginId: string;
    path: string;
    logger: {
      log(...args: unknown[]): void;
      debug(...args: unknown[]): void;
      error(...args: unknown[]): void;
    };
    log(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
    events: {
      on<E extends ServerEvent>(
        event: E,
        handler: (payload: EventPayloads[E]) => void | Promise<void>
      ): () => void;
      off<E extends ServerEvent>(
        event: E,
        handler: (payload: EventPayloads[E]) => void | Promise<void>
      ): void;
    };
    actions: {
      register<TPayload = void>(action: ActionDefinition<TPayload>): void;
    };
    settings: {
      register<T extends readonly TPluginSettingDefinition[]>(
        definitions: T
      ): Promise<PluginSettings<T>>;
    };
    data: {
      getChannel(channelId: number): Promise<unknown | undefined>;
    };
    ui: {
      enable(): void;
      disable(): void;
    };
  }

  export type TPluginStoreState = {
    users: unknown[];
    channels: Array<{
      id: number;
      name: string;
      type: string;
      isDm?: boolean | null;
    }>;
    categories: unknown[];
    roles: unknown[];
    emojis: unknown[];
    plugins: unknown[];
    ownUserId: number | undefined;
    selectedChannelId: number | undefined;
    currentVoiceChannelId: number | undefined;
    publicSettings: unknown | undefined;
  };

  export type TPluginStore = {
    getState: () => TPluginStoreState;
    subscribe: (listener: () => void) => () => void;
    actions: {
      executePluginAction: <TResponse = unknown, TPayload = unknown>(
        actionName: string,
        payload?: TPayload
      ) => Promise<TResponse>;
    };
  };

  export type TPluginComponentsMapBySlotId = {
    connect_screen?: React.ComponentType[];
    home_screen?: React.ComponentType[];
    chat_actions?: React.ComponentType[];
    topbar_right?: React.ComponentType[];
    full_screen?: React.ComponentType[];
  };
}
