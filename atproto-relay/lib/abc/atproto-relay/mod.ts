export type HostState = "active" | "idle" | "connecting" | "takedown";

export interface HostInfo {
  hostname: string;
  did: string;
  state: HostState;
  lastSeen: number;
  cursor: number | null;
  connectedAt: number | null;
  retryCount: number;
}

export interface AccountInfo {
  did: string;
  hostHostname: string;
  rev: string | null;
  seq: number | null;
}

export interface PdsFirehoseFrame {
  $type?: string;
  seq: number;
  repo: string;
  commit: { $link: string };
  rev: string;
  since: string | null;
  blocks: Uint8Array;
  ops: Array<{ action: string; path: string; cid: { $link: string } | null; prev: null }>;
  time: string;
}

export interface RelayFrame {
  seq: number;
  origin: string;
  frame: PdsFirehoseFrame;
  time: string;
}

export interface HostStore {
  list(): Promise<HostInfo[]>;
  get(hostname: string): Promise<HostInfo | null>;
  upsert(hostname: string, info: Partial<HostInfo> & { did: string }): Promise<void>;
}

export interface AccountStore {
  list(): Promise<AccountInfo[]>;
  get(did: string): Promise<AccountInfo | null>;
  upsert(did: string, info: Partial<AccountInfo>): Promise<void>;
}

export interface PdsSubscriber {
  close(): void;
}

export interface RelaySequencer {
  append(origin: string, frame: PdsFirehoseFrame): RelayFrame;
  backfill(since?: number): AsyncIterable<RelayFrame>;
  live(): AsyncIterable<RelayFrame>;
}

export interface CollectionIndex {
  add(collection: string, did: string): Promise<void>;
  listRepos(collection: string, cursor?: string, limit?: number): Promise<{ repos: Array<{ did: string }>; cursor?: string }>;
}
