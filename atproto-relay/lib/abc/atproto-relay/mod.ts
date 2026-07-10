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

import type { SubscribeReposFrame, SubscribeReposOp } from "@publicdomainrelay/firehose-common";
export type { SubscribeReposFrame, SubscribeReposOp };

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
  append(frame: SubscribeReposFrame): SubscribeReposFrame;
  backfill(since?: number): AsyncIterable<SubscribeReposFrame>;
  live(): AsyncIterable<SubscribeReposFrame>;
}

export interface CollectionIndex {
  add(collection: string, did: string): Promise<void>;
  listRepos(collection: string, cursor?: string, limit?: number): Promise<{ repos: Array<{ did: string }>; cursor?: string }>;
}
