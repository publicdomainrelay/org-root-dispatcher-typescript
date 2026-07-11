// relay.js — Browser-native WebSocket relay client + keypair management.
// Uses @publicdomainrelay/compute-spa-keypair-noble (pure JS, no Deno APIs)
// for secp256k1 keypair generation and signing. Works in browsers and Deno.

import { Secp256k1Keypair } from '@publicdomainrelay/compute-spa-keypair-noble';
import {
  XRPC_DISPATCHER_HOST, SUBSCRIBE_NSID, GET_NONCE_NSID,
  SUBMIT_BID_NSID, TTYD_CREDS_NSID, SSH_KEY_NSID,
} from './constants.js';

export { Secp256k1Keypair };

/* ── localStorage persistence ── */
const RELAY_KEYPAIR_KEY = 'relay:keypair';
const DID_PLC_KEY = 'relay:did-plc';

/* ── Base64 helpers ── */
function b64encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── Keypair management ── */

/** Load relay keypair from localStorage, or null. */
export function loadRelayKeypair() {
  try {
    const raw = localStorage.getItem(RELAY_KEYPAIR_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Generate a new secp256k1 keypair and persist to localStorage.
 *  Returns { privateKeyHex, did } where did is a did:key. */
export async function generateRelayKeypair() {
  const kp = Secp256k1Keypair.create();
  const privateKeyHex = kp.exportHex();
  const did = kp.did();
  const pair = { privateKeyHex, did };
  localStorage.setItem(RELAY_KEYPAIR_KEY, JSON.stringify(pair));
  return pair;
}

/** Load from localStorage or generate a fresh keypair. */
export async function loadOrGenerateKeypair() {
  const existing = loadRelayKeypair();
  if (existing) return existing;
  return generateRelayKeypair();
}

/** Wrap a persisted keypair into the { did(), sign() } interface. */
export function createRelayKeypairAdapter(kp) {
  if (!kp) return null;
  const keypair = Secp256k1Keypair.import(kp.privateKeyHex);
  return {
    did: () => keypair.did(),
    sign: async (bytes) => keypair.sign(bytes),
  };
}

/* ── did:plc registration ── */

/** Register (or load cached) did:plc identity for the relay keypair.
 *  Keeps DNS labels under 63 chars for SSH service names. */
export async function registerDidPlc(kp, proxyRef) {
  const cached = localStorage.getItem(DID_PLC_KEY);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (parsed.proxyRef === proxyRef) return parsed.did;
  }
  // Dynamic import — only loaded when needed, avoids bundling for non-registration paths
  const { createGenesisOp, PlcClient, PlcNotFoundError } = await import('@publicdomainrelay/did-plc');
  const keypair = Secp256k1Keypair.import(kp.privateKeyHex);
  const sign = async (bytes) => keypair.sign(bytes);
  const endpoint = `https://${proxyRef.replace(/^did:web:/, '')}`;
  const { did, op } = await createGenesisOp({
    rotationKeys: [kp.did],
    verificationMethods: { atproto: kp.did },
    alsoKnownAs: [`at://${proxyRef.replace(/^did:web:/, '')}`],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint } },
    sign,
  });
  const plc = new PlcClient({ baseUrl: 'https://plc.directory' });
  try { await plc.resolve(did); }
  catch (err) {
    if (err instanceof PlcNotFoundError) await plc.submitOp(did, op);
    else throw err;
  }
  localStorage.setItem(DID_PLC_KEY, JSON.stringify({ did, proxyRef }));
  return did;
}

/* ── RelayClient ── */

/**
 * Browser-native WebSocket relay client connecting to the xrpc relay
 * dispatcher. Handles nonce/registration, request/response frames, TTYD
 * credential registration, ephemeral PDS record serving, SSH key tracking,
 * and bid collection.
 */
export class RelayClient {
  #host;
  #keypair;
  #serviceAuthMinter;

  #ws = null;
  #status = "disconnected";
  #subdomain = null;
  #proxyRef = null;
  #requestIdCounter = 0;
  #pendingRequests = new Map();
  #closed = false;
  #connectTimer = null;
  #reconnectAttempts = 0;
  #sshReady = [];
  #ttydRequests = new Map();

  onBid = null;
  onStateChange = null;

  constructor({ host = XRPC_DISPATCHER_HOST, keypair, serviceAuthMinter }) {
    this.#host = host;
    this.#keypair = keypair;
    this.#serviceAuthMinter = serviceAuthMinter;
  }

  get status() { return this.#status; }
  get subdomain() { return this.#subdomain; }
  get proxyRef() { return this.#proxyRef; }
  get sshReadyServices() { return [...this.#sshReady]; }

  isSshReady(serviceName) { return this.#sshReady.includes(serviceName); }

  #setStatus(s) { this.#status = s; this.onStateChange?.(s); }

  async start() {
    if (this.#closed || this.#status !== "disconnected") return;
    this.#setStatus("connecting");
    try {
      const registration = await this.#buildRegistration();
      const subscribeToken = await this.#serviceAuthMinter(SUBSCRIBE_NSID);
      const did = this.#keypair.did();
      const url = `wss://${this.#host}/xrpc/${SUBSCRIBE_NSID}?registration=${encodeURIComponent(registration)}&did=${encodeURIComponent(did)}&service_auth=${encodeURIComponent(subscribeToken)}`;
      const ws = new WebSocket(url);
      this.#ws = ws;
      await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error("registration timeout")); } }, 30_000);
        ws.onopen = () => { this.#setStatus("connected"); this.#reconnectAttempts = 0; };
        ws.onmessage = (evt) => {
          let msg;
          try { msg = JSON.parse(evt.data); } catch { return; }
          const $type = msg.$type;
          if (!$type) return;
          if ($type === `${SUBSCRIBE_NSID}#registered`) {
            clearTimeout(timeout);
            this.#subdomain = msg.subdomain;
            this.#proxyRef = msg.proxyRef || msg.ingressRef;
            this.#setStatus("registered");
            if (!settled) { settled = true; resolve(); }
            return;
          }
          if ($type === `${SUBSCRIBE_NSID}#response`) {
            const pending = this.#pendingRequests.get(msg.requestId);
            if (pending) { this.#pendingRequests.delete(msg.requestId); pending.resolve({ status: msg.status, body: msg.body }); }
            return;
          }
          if ($type === `${SUBSCRIBE_NSID}#request`) {
            this.#handleIncomingRequest(msg);
            return;
          }
        };
        ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error("WebSocket error")); } };
        ws.onclose = () => {
          this.#subdomain = null; this.#proxyRef = null; this.#setStatus("disconnected");
          for (const [id, p] of this.#pendingRequests) { p.reject(new Error("closed")); this.#pendingRequests.delete(id); }
          if (!settled) { settled = true; clearTimeout(timeout); reject(new Error("closed before registration")); }
          this.#scheduleReconnect();
        };
      });
    } catch (err) { this.#ws = null; this.#setStatus("disconnected"); throw err; }
  }

  #scheduleReconnect() {
    if (this.#closed) return;
    const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, 30_000);
    this.#reconnectAttempts++;
    this.#connectTimer = setTimeout(() => { this.#connectTimer = null; if (this.#closed) return; this.#setStatus("connecting"); this.start().catch(() => this.#scheduleReconnect()); }, delay);
  }

  async #buildRegistration() {
    const token = await this.#serviceAuthMinter(GET_NONCE_NSID);
    const did = this.#keypair.did();
    const res = await fetch(`https://${this.#host}/xrpc/${GET_NONCE_NSID}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key: did, signatures: [] }),
    });
    if (!res.ok) throw new Error(`nonce request failed: ${res.status} ${await res.text()}`);
    const { nonce } = await res.json();
    const sig = await this.#keypair.sign(b64decode(nonce));
    return JSON.stringify({
      $type: "com.fedproxy.temp.xrpc.registration",
      key: did, nonce,
      signatures: [{ key: did, signature: b64encode(sig) }],
    });
  }

  #handleIncomingRequest(frame) {
    // DID document serving
    if (frame.path === '/.well-known/did.json') {
      const kpDid = this.#keypair.did();
      this.#respond(frame.requestId, 200, {
        '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
        id: this.#proxyRef,
        verificationMethod: [{ id: `${this.#proxyRef}#atproto`, type: 'Multikey', controller: this.#proxyRef, publicKeyMultibase: kpDid.replace(/^did:key:/, '') }],
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: `https://${this.#subdomain}.xrpc.fedproxy.com` }],
      });
      return;
    }
    // submitBid
    if (frame.path === `/xrpc/${SUBMIT_BID_NSID}`) {
      const body = frame.body || {};
      const record = body.record || {};
      const bidderDid = typeof body.uri === 'string' ? body.uri.replace(/^at:\/\//, '').split('/')[0] : undefined;
      this.onBid?.({ rfpUri: record.rfp?.uri, did: bidderDid, aud: bidderDid, submitAccept: record.submitAccept, bidRef: { uri: body.uri, cid: body.cid }, uri: body.uri, cid: body.cid, record });
      this.#respond(frame.requestId, 200, { ok: true });
      return;
    }
    // getRecord
    if (frame.path === '/xrpc/com.atproto.repo.getRecord') {
      const rkey = frame.params?.rkey || '';
      const collection = frame.params?.collection || '';
      const ttydReq = this.#ttydRequests.get(rkey);
      if (ttydReq && (collection === TTYD_CREDS_NSID || !collection)) {
        this.#respond(frame.requestId, 200, { uri: `at://${ttydReq.didPlc}/${TTYD_CREDS_NSID}/${rkey}`, value: { $type: TTYD_CREDS_NSID, username: 'agent', password: ttydReq.password } });
        return;
      }
      const rec = this.#epdsLookup(collection, rkey);
      if (rec) { this.#respond(frame.requestId, 200, { uri: rec.uri, cid: rec.cid, value: rec.value }); return; }
    }
    // listRecords
    if (frame.path === '/xrpc/com.atproto.repo.listRecords') {
      const collection = frame.params?.collection || '';
      const limit = Number(frame.params?.limit) || 50;
      let records = [];
      try {
        const raw = localStorage.getItem('ephemeral-pds:' + collection);
        if (raw) records = JSON.parse(raw).slice(-limit).map(r => ({ uri: r.uri, cid: r.cid, value: r.value }));
      } catch {}
      this.#respond(frame.requestId, 200, { records });
      return;
    }
    // createRecord (SSH key)
    if (frame.path === '/xrpc/com.atproto.repo.createRecord') {
      const body = frame.body;
      if (body?.collection === SSH_KEY_NSID && body?.record?.service) {
        const serviceName = body.record.service;
        if (!this.#sshReady.includes(serviceName)) this.#sshReady.push(serviceName);
        const rkey = 'rec-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        const uri = `at://${this.#proxyRef}/${SSH_KEY_NSID}/${rkey}`;
        const value = { $type: SSH_KEY_NSID, ...body.record };
        try {
          const raw = localStorage.getItem('ephemeral-pds:' + SSH_KEY_NSID);
          const arr = raw ? JSON.parse(raw) : [];
          arr.push({ uri, cid: 'local', value, rkey });
          localStorage.setItem('ephemeral-pds:' + SSH_KEY_NSID, JSON.stringify(arr));
        } catch {}
        this.#respond(frame.requestId, 200, { uri, cid: 'local' });
        return;
      }
    }
    // fallback
    this.#respond(frame.requestId, 501, { error: "NotImplemented", message: `no handler for ${frame.path}` });
  }

  #epdsLookup(collection, rkey) {
    try {
      const raw = localStorage.getItem('ephemeral-pds:' + collection);
      if (!raw) return null;
      const records = JSON.parse(raw);
      if (rkey) { const exact = records.find(r => r.rkey === rkey); if (exact) return exact; }
      return records.length > 0 ? records[records.length - 1] : null;
    } catch { return null; }
  }

  #respond(requestId, status, body) {
    this.#sendFrame({ $type: `${SUBSCRIBE_NSID}#response`, requestId, status, body, contentType: 'application/json' });
  }

  #sendFrame(frame) { if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame)); }

  async sendRequest(method, path, body) {
    const requestId = String(++this.#requestIdCounter);
    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(requestId, { resolve, reject });
      this.#sendFrame({ $type: `${SUBSCRIBE_NSID}#request`, requestId, method, path, body, params: {}, headers: {} });
      setTimeout(() => { const p = this.#pendingRequests.get(requestId); if (p) { this.#pendingRequests.delete(requestId); reject(new Error("request timeout")); } }, 30_000);
    });
  }

  registerTtydRequest(req) { this.#ttydRequests.set(req.vmName, req); return Promise.resolve({ status: 200 }); }

  close() {
    this.#closed = true;
    if (this.#connectTimer) { clearTimeout(this.#connectTimer); this.#connectTimer = null; }
    if (this.#ws) { this.#ws.close(); this.#ws = null; }
    this.#subdomain = null; this.#proxyRef = null; this.#setStatus("disconnected");
    for (const [id, p] of this.#pendingRequests) { p.reject(new Error("client closed")); this.#pendingRequests.delete(id); }
  }
}

/** Convenience: create a fully wired relay client from a persisted keypair. */
export function createRelayClient({ host = XRPC_DISPATCHER_HOST, keypair, serviceAuthMinter, onBid, onStateChange }) {
  const adapter = createRelayKeypairAdapter(keypair);
  const client = new RelayClient({ host, keypair: adapter, serviceAuthMinter });
  if (onBid) client.onBid = onBid;
  if (onStateChange) client.onStateChange = onStateChange;
  return client;
}
