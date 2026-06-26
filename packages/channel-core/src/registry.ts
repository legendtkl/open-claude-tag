import type { Channel, ChannelKind, ChannelRegistry } from './types.js';

/** In-memory channel registry. The gateway registers one adapter per kind. */
export function createChannelRegistry(): ChannelRegistry {
  const map = new Map<ChannelKind, Channel>();
  return {
    register(channel: Channel): void {
      map.set(channel.kind, channel);
    },
    get(kind: ChannelKind): Channel | undefined {
      return map.get(kind);
    },
    all(): Channel[] {
      return [...map.values()];
    },
  };
}
