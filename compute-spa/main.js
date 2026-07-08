import { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import { Agent } from '@atproto/api';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

/* ── NSID constants ── */
export const COMPUTE_VM_NSID = 'com.publicdomainrelay.temp.compute.vm';
export const RFP_NSID = 'com.publicdomainrelay.temp.market.rfp';
export const ACCEPT_NSID = 'com.publicdomainrelay.temp.market.accept';
export const BID_NSID = 'com.publicdomainrelay.temp.market.bid';
export const RECEIPT_NSID = 'com.publicdomainrelay.temp.market.receipt';
export const EVENT_NSID = 'com.publicdomainrelay.temp.market.event';
export const OFFERING_NSID = 'com.publicdomainrelay.temp.market.offering';
export const RBAC_NSID = 'com.fedproxy.rbac';
export const SSH_KEY_NSID = 'com.fedproxy.sshPublicKey';
export const SUBMIT_RFP_NSID = 'com.publicdomainrelay.temp.market.submitRfp';
export const SUBMIT_ACCEPT_NSID = 'com.publicdomainrelay.temp.market.submitAccept';
export const SUBMIT_BID_NSID = 'com.publicdomainrelay.temp.market.submitBid';
export const SUBMIT_EVENT_NSID = 'com.publicdomainrelay.temp.market.submitEvent';
export const COMPUTE_VM_DELETE_NSID = 'com.publicdomainrelay.temp.compute.events.vm.delete';
export const REQUEST_COMPUTE_VM_NSID = 'com.publicdomainrelay.temp.gateway.requestComputeVM';
export const DELETE_COMPUTE_NSID = 'com.publicdomainrelay.temp.gateway.deleteCompute';
export const VOUCH_NSID = 'sh.tangled.graph.vouch';
export const BADGE_BLUE_KEYS_NSID = 'com.publicdomainrelay.temp.badgeBlueKeys';

const CRUD_SCOPE_NSIDS = [
  COMPUTE_VM_NSID,
  RBAC_NSID,
  SSH_KEY_NSID,
  BADGE_BLUE_KEYS_NSID,
];

/* ── fedproxy host constants ── */
export const FEDPROXY_HOST = 'fedproxy.com';
export const XRPC_DISPATCHER_HOST = 'xrpc.fedproxy.com';

/* ── Terminal helpers ── */

/** Strip the `did:plc:` prefix, yielding the bare PLC key. */
export function didPlcKey(did) {
  return did.replace(/^did:plc:/, '');
}

/** Sanitize an atproto handle/DID into a DNS label segment (colons/dots/slashes → dashes). */
export function handleToLabel(handle) {
  return handle.replace(/[:./]/g, '-').toLowerCase();
}

/** fedproxy SERVICE name / terminal subdomain for a VM: `<role>--<handle-label>`. */
export function vmServiceName(vmRole, handle) {
  return `${vmRole.trim()}--${handleToLabel(handle)}`;
}

/** URL the terminal button opens once the VM is ready. */
export function terminalUrl(vmRole, handle, token) {
  const base = `https://${vmServiceName(vmRole, handle)}.${FEDPROXY_HOST}`;
  return token ? `${base}/#token=${encodeURIComponent(token)}` : base;
}

/* ── Keypair helpers (pure secp256k1, @noble/curves, no Deno APIs) ── */

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const RELAY_KEYPAIR_KEY = 'relay:keypair';

/** Generate a secp256k1 relay keypair and persist to localStorage.
 * did:key derived via @atiproto/atproto-attestation's own codec so it
 * matches exactly what bidders resolve when verifying our signatures. */
export async function generateRelayKeypair() {
  const { Attestation } = await import('@atiproto/atproto-attestation');
  const priv = secp256k1.utils.randomPrivateKey();
  const privateKeyHex = toHex(priv);
  const privateKey = { type: 'k256', bytes: priv, toBytes: () => priv };
  const did = new Attestation({ privateKey }).publicKey;
  const pair = { privateKeyHex, did };
  localStorage.setItem(RELAY_KEYPAIR_KEY, JSON.stringify(pair));
  log('info', 'keypair', 'generateRelayKeypair:generated', { did });
  return pair;
}

/** Load relay keypair from localStorage, or null. */
export function loadRelayKeypair() {
  try {
    const raw = localStorage.getItem(RELAY_KEYPAIR_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Returns an attestation-compatible keypair object, or null. */
export function getAttestationKeypair() {
  const kp = loadRelayKeypair();
  if (!kp) return null;
  const priv = fromHex(kp.privateKeyHex);
  return {
    did: () => kp.did,
    privateKey: { type: 'k256', bytes: priv, toBytes: () => priv },
  };
}

const DID_PLC_KEY = 'relay:did-plc';

/**
 * Register (or load a cached) did:plc for the relay keypair, with services
 * pointing at the browser relay's did:web endpoint. Unlike did:web, a did:plc
 * identifier does NOT embed its hostname -- it's a short, fixed-length hash
 * (~32 chars total) regardless of how long the underlying relay subdomain is.
 * Used as the requester identity for anything that becomes a DNS label
 * (fedproxy SSH HANDLE, terminal service name) -- the did:web relay subdomain
 * (derived from a full compressed pubkey, ~57+ chars) blows past the ssh
 * relay's 63-char DNS label limit once combined with a service name.
 * Mirrors atproto-market/lib/requester-xrpc/mod.ts's did:plc registration.
 */
export async function registerDidPlc(kp, proxyRef) {
  const cached = localStorage.getItem(DID_PLC_KEY);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (parsed.proxyRef === proxyRef) return parsed.did;
  }
  const { createGenesisOp, PlcClient, PlcNotFoundError } = await import('@publicdomainrelay/did-plc');
  const priv = fromHex(kp.privateKeyHex);
  const sign = async (bytes) => {
    const hash = sha256(bytes);
    return secp256k1.sign(hash, priv, { lowS: true }).toCompactRawBytes();
  };
  const endpoint = `https://${proxyRef.replace(/^did:web:/, '')}`;
  const { did, op } = await createGenesisOp({
    rotationKeys: [kp.did],
    verificationMethods: { atproto: kp.did },
    alsoKnownAs: [`at://${proxyRef.replace(/^did:web:/, '')}`],
    services: {
      atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint },
    },
    sign,
  });
  const plc = new PlcClient({ baseUrl: 'https://plc.directory' });
  try {
    await plc.resolve(did);
    log('info', 'didPlc', 'alreadyRegistered', { did });
  } catch (err) {
    if (err instanceof PlcNotFoundError) {
      await plc.submitOp(did, op);
      log('info', 'didPlc', 'registered', { did });
    } else {
      throw err;
    }
  }
  localStorage.setItem(DID_PLC_KEY, JSON.stringify({ did, proxyRef }));
  return did;
}

/* ── Ttyd password generator ── */

/** Generate a 24-char password from 18 random bytes (base64, stripped). */
export function generatePassword() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/[+\/=]/g, '').slice(0, 24);
}

/* ── Relay client ── */

const SUBSCRIBE_NSID = 'com.fedproxy.temp.xrpc.subscribe';
const GET_NONCE_NSID = 'com.fedproxy.temp.xrpc.getRegistrationNonce';
const TTYD_CREDS_NSID = 'com.fedproxy.ttydCredentials';

function relayB64encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function relayB64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Browser-native WebSocket relay client connecting to the did-key-relay
 * dispatcher at xrpc.fedproxy.com. Handles nonce/registration, request/
 * response frames, and TTYD credential registration.
 */
export class RelayClient {
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

  constructor({ keypair, serviceAuthMinter }) {
    this.#keypair = keypair;
    this.#serviceAuthMinter = serviceAuthMinter;
  }

  get status() { return this.#status; }
  get subdomain() { return this.#subdomain; }
  get proxyRef() { return this.#proxyRef; }
  get sshReadyServices() { return [...this.#sshReady]; }

  isSshReady(serviceName) {
    return this.#sshReady.includes(serviceName);
  }

  #setStatus(s) {
    this.#status = s;
    this.onStateChange?.(s);
  }

  /** Open a WebSocket to the dispatcher, obtain a nonce, sign, and register. */
  async start() {
    if (this.#closed) return;
    if (this.#status !== "disconnected") return;
    this.#setStatus("connecting");

    try {
      const registration = await this.#buildRegistration();
      const subscribeToken = await this.#serviceAuthMinter(SUBSCRIBE_NSID);
      const did = this.#keypair.did();

      const url =
        `wss://${XRPC_DISPATCHER_HOST}/xrpc/${SUBSCRIBE_NSID}?registration=${
          encodeURIComponent(registration)
        }&did=${encodeURIComponent(did)}&service_auth=${
          encodeURIComponent(subscribeToken)
        }`;

      const ws = new WebSocket(url);
      this.#ws = ws;

      await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("registration timeout"));
          }
        }, 30_000);

        ws.onopen = () => {
          this.#setStatus("connected");
          this.#reconnectAttempts = 0;
        };

        ws.onmessage = (evt) => {
          let msg;
          try {
            msg = JSON.parse(evt.data);
          } catch {
            return;
          }

          const $type = msg.$type;
          if (!$type) return;

          if ($type === `${SUBSCRIBE_NSID}#registered`) {
            clearTimeout(timeout);
            this.#subdomain = msg.subdomain;
            this.#proxyRef = msg.proxyRef;
            this.#setStatus("registered");
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }

          if ($type === `${SUBSCRIBE_NSID}#response`) {
            const pending = this.#pendingRequests.get(msg.requestId);
            if (pending) {
              this.#pendingRequests.delete(msg.requestId);
              pending.resolve({ status: msg.status, body: msg.body });
            }
            return;
          }

          if ($type === `${SUBSCRIBE_NSID}#request`) {
            this.#handleIncomingRequest(msg);
            return;
          }
        };

        ws.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error("WebSocket error during registration"));
          }
        };

        ws.onclose = () => {
          this.#subdomain = null;
          this.#proxyRef = null;
          this.#setStatus("disconnected");

          for (const [id, p] of this.#pendingRequests) {
            p.reject(new Error("WebSocket closed"));
            this.#pendingRequests.delete(id);
          }

          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error("closed before registration"));
          }

          this.#scheduleReconnect();
        };
      });
    } catch (err) {
      this.#ws = null;
      this.#setStatus("disconnected");
      throw err;
    }
  }

  #scheduleReconnect() {
    if (this.#closed) return;
    const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, 30_000);
    this.#reconnectAttempts++;
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      if (this.#closed) return;
      this.#setStatus("connecting");
      this.start().catch(() => {
        this.#scheduleReconnect();
      });
    }, delay);
  }

  async #buildRegistration() {
    const token = await this.#serviceAuthMinter(GET_NONCE_NSID);
    const did = this.#keypair.did();

    const res = await fetch(
      `https://${XRPC_DISPATCHER_HOST}/xrpc/${GET_NONCE_NSID}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: did, signatures: [] }),
      },
    );

    if (!res.ok) {
      throw new Error(
        `nonce request failed: ${res.status} ${await res.text()}`,
      );
    }

    const { nonce } = await res.json();
    const sig = await this.#keypair.sign(relayB64decode(nonce));

    return JSON.stringify({
      $type: "com.fedproxy.temp.xrpc.registration",
      key: did,
      nonce,
      signatures: [{ key: did, signature: relayB64encode(sig) }],
    });
  }

  #handleIncomingRequest(frame) {
    // /.well-known/did.json — serve DID doc so bidders can resolve did:web
    if (frame.path === '/.well-known/did.json') {
      const kpDid = this.#keypair.did();
      this.#sendFrame({
        $type: `${SUBSCRIBE_NSID}#response`,
        requestId: frame.requestId,
        status: 200,
        body: {
          '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
          id: this.#proxyRef,
          verificationMethod: [{
            id: `${this.#proxyRef}#atproto`,
            type: 'Multikey',
            controller: this.#proxyRef,
            publicKeyMultibase: kpDid.replace(/^did:key:/, ''),
          }],
          service: [{
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: `https://${this.#subdomain}.xrpc.fedproxy.com`,
          }],
        },
        contentType: 'application/json',
      });
      return;
    }

    // submitBid: collect bids from bidders. POST body is { uri, cid, record }
    // (market-bidder-compute's callService payload) -- normalize into the
    // { rfpUri, did, submitAccept, bidRef } shape request-vm-page.js expects.
    if (frame.path === `/xrpc/${SUBMIT_BID_NSID}`) {
      const body = frame.body || {};
      const record = body.record || {};
      const bidderDid = typeof body.uri === 'string' ? body.uri.replace(/^at:\/\//, '').split('/')[0] : undefined;
      this.onBid?.({
        rfpUri: record.rfp?.uri,
        did: bidderDid,
        aud: bidderDid,
        submitAccept: record.submitAccept,
        bidRef: { uri: body.uri, cid: body.cid },
        uri: body.uri,
        cid: body.cid,
        record,
      });
      this.#sendFrame({
        $type: `${SUBSCRIBE_NSID}#response`,
        requestId: frame.requestId,
        status: 200,
        body: { ok: true },
      });
      return;
    }

    // getRecord: return first matching record for the collection
    if (frame.path === '/xrpc/com.atproto.repo.getRecord') {
      const rkey = frame.params?.rkey || '';
      const collection = frame.params?.collection || frame.params?.['collection'] || '';
      // Check ttyd credentials first
      const ttydReq = this.#ttydRequests.get(rkey);
      if (ttydReq && (collection === TTYD_CREDS_NSID || !collection)) {
        this.#sendFrame({
          $type: `${SUBSCRIBE_NSID}#response`,
          requestId: frame.requestId,
          status: 200,
          body: {
            uri: `at://${ttydReq.didPlc}/${TTYD_CREDS_NSID}/${rkey}`,
            value: { $type: TTYD_CREDS_NSID, username: 'agent', password: ttydReq.password },
          },
        });
        return;
      }
      // Look up from ephemeral PDS localStorage
      // Try specific rkey match first, then fall back to first record in collection
      const lookup = (coll) => {
        try {
          const raw = localStorage.getItem('ephemeral-pds:' + coll);
          if (!raw) return null;
          const records = JSON.parse(raw);
          if (rkey) {
            const exact = records.find(r => r.rkey === rkey);
            if (exact) return exact;
          }
          return records.length > 0 ? records[records.length - 1] : null;
        } catch { return null; }
      };

      if (collection) {
        const rec = lookup(collection);
        if (rec) {
          this.#sendFrame({
            $type: `${SUBSCRIBE_NSID}#response`,
            requestId: frame.requestId,
            status: 200,
            body: { uri: rec.uri, cid: rec.cid, value: rec.value },
          });
          return;
        }
      }
      // Try all collections
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('ephemeral-pds:')) continue;
        const coll = k.replace('ephemeral-pds:', '');
        const rec = lookup(coll);
        if (rec) {
          this.#sendFrame({
            $type: `${SUBSCRIBE_NSID}#response`,
            requestId: frame.requestId,
            status: 200,
            body: { uri: rec.uri, cid: rec.cid, value: rec.value },
          });
          return;
        }
      }
    }

    // listRecords: public read of a whole collection (e.g. bidders resolving
    // our requester_associate badgeBlueKeys records for the scope check).
    if (frame.path === '/xrpc/com.atproto.repo.listRecords') {
      const collection = frame.params?.collection || frame.params?.['collection'] || '';
      const limit = Number(frame.params?.limit) || 50;
      let records = [];
      try {
        const raw = localStorage.getItem('ephemeral-pds:' + collection);
        if (raw) {
          records = JSON.parse(raw)
            .slice(-limit)
            .map((r) => ({ uri: r.uri, cid: r.cid, value: r.value }));
        }
      } catch { /* ignore corrupt data */ }
      this.#sendFrame({
        $type: `${SUBSCRIBE_NSID}#response`,
        requestId: frame.requestId,
        status: 200,
        body: { records },
      });
      return;
    }

    // createRecord: VM publishes SSH host key at boot. Persisted into the
    // same ephemeral-pds localStorage store getRecord/listRecords read from,
    // so the atprp-ssh-relay's cachedGetSSHPublicKeys(pds, did) lookup (a
    // real XRPC listRecords call against our did:web repo) finds it.
    if (frame.path === '/xrpc/com.atproto.repo.createRecord') {
      const body = frame.body;
      if (body?.collection === SSH_KEY_NSID && body?.record?.service) {
        const serviceName = body.record.service;
        if (!this.#sshReady.includes(serviceName)) {
          this.#sshReady.push(serviceName);
        }
        const rkey = 'rec-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        const uri = `at://${this.#proxyRef}/${SSH_KEY_NSID}/${rkey}`;
        const value = { $type: SSH_KEY_NSID, ...body.record };
        try {
          const raw = localStorage.getItem('ephemeral-pds:' + SSH_KEY_NSID);
          const arr = raw ? JSON.parse(raw) : [];
          arr.push({ uri, cid: 'local', value, rkey });
          localStorage.setItem('ephemeral-pds:' + SSH_KEY_NSID, JSON.stringify(arr));
        } catch (err) {
          log('error', 'relay', 'sshKeyPersistFailed', { error: String(err) });
        }
        log('info', 'relay', 'sshReady', { serviceName, uri });
        this.#sendFrame({
          $type: `${SUBSCRIBE_NSID}#response`,
          requestId: frame.requestId,
          status: 200,
          body: { uri, cid: 'local' },
        });
        return;
      }
    }

    // Catch-all: log the frame so we can debug what paths actually arrive
    log('warn', 'relay', 'unhandledRequest', { path: frame.path, method: frame.method, params: frame.params });

    this.#sendFrame({
      $type: `${SUBSCRIBE_NSID}#response`,
      requestId: frame.requestId,
      status: 501,
      body: {
        error: "NotImplemented",
        message: `no handler for ${frame.path}`,
      },
    });
  }

  #sendFrame(frame) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
    }
  }

  /** Send a request frame over the WebSocket and await the response. */
  async sendRequest(method, path, body) {
    const requestId = String(++this.#requestIdCounter);

    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(requestId, { resolve, reject });

      this.#sendFrame({
        $type: `${SUBSCRIBE_NSID}#request`,
        requestId,
        method,
        path,
        body,
        params: {},
        headers: {},
      });

      setTimeout(() => {
        const pending = this.#pendingRequests.get(requestId);
        if (pending) {
          this.#pendingRequests.delete(requestId);
          reject(new Error("request timeout"));
        }
      }, 30_000);
    });
  }

  /** Register TTYD credentials locally. VM fetches them via OIDC-gated getRecord at boot. */
  registerTtydRequest(req) {
    this.#ttydRequests.set(req.vmName, req);
    log('info', 'relay', 'ttyd:registered', { vmName: req.vmName, serviceName: req.serviceName });
    return Promise.resolve({ status: 200 });
  }

  /** Close the WebSocket and cancel pending reconnect. */
  close() {
    this.#closed = true;
    if (this.#connectTimer) {
      clearTimeout(this.#connectTimer);
      this.#connectTimer = null;
    }
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
    this.#subdomain = null;
    this.#proxyRef = null;
    this.#setStatus("disconnected");

    for (const [id, p] of this.#pendingRequests) {
      p.reject(new Error("client closed"));
      this.#pendingRequests.delete(id);
    }
  }
}

/**
 * Wrap a persisted relay keypair ({ privateKeyHex, did }) into the
 * { did(), sign(bytes) } shape the RelayClient requires.
 */
export function createRelayKeypairAdapter(kp) {
  if (!kp) return null;
  const priv = fromHex(kp.privateKeyHex);
  return {
    did: () => kp.did,
    sign: async (bytes) => {
      const hash = sha256(bytes);
      const sig = secp256k1.sign(hash, priv, { lowS: true });
      return sig.toCompactRawBytes();
    },
  };
}

/**
 * Sign an attestation payload with the relay keypair.
 * Returns an inline network.attested.signature entry.
 */
/**
 * Create a valid badge.blue attestation signature entry using the real
 * @atiproto/atproto-attestation library (same one market-atproto's
 * createSignedRecord uses) so signing matches bidder-side verification
 * byte-for-byte.
 */
export async function signAttestation(kp, record, repositoryDid) {
  const { Attestation } = await import("@atiproto/atproto-attestation");
  const priv = fromHex(kp.privateKeyHex);
  const privateKey = { type: "k256", bytes: priv, toBytes: () => priv };
  const att = new Attestation({ privateKey });
  const entry = await att.sign({ record, repository: repositoryDid || kp.did });
  const sig = entry.signature instanceof Uint8Array ? entry.signature : entry.signature;
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
  return {
    $type: entry.$type,
    key: entry.key,
    cid: entry.cid,
    signature: { $bytes: btoa(bin) },
  };
}

/** Get a service auth JWT for proxied XRPC calls. */
export async function getServiceAuthToken(agent, aud, lxm) {
  try {
    const res = await agent.com.atproto.server.getServiceAuth({ aud, lxm });
    return res.data?.token ?? "";
  } catch (err) {
    log("warn", "auth", "getServiceAuthToken:failed", { aud, lxm, error: String(err) });
    return "";
  }
}
/* ── Structured JSON logger ── */
export function log(level, component, event, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, component, event, ...data });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/* ── OAuth client id ── */
export function buildClientID() {
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocal) {
    const repoScope = CRUD_SCOPE_NSIDS.map(n => `repo:${n}?action=create,update,delete`).join(' ');
    const rpcScope = [
      `${SUBMIT_RFP_NSID}?aud=*`,
      `${SUBMIT_ACCEPT_NSID}?aud=*`,
      `${SUBMIT_BID_NSID}?aud=*`,
      `${SUBMIT_EVENT_NSID}?aud=*`,
      `com.fedproxy.temp.xrpc.getRegistrationNonce?aud=did:web:${XRPC_DISPATCHER_HOST}`,
      `com.fedproxy.temp.xrpc.subscribe?aud=did:web:${XRPC_DISPATCHER_HOST}`,
    ].map(n => `rpc:${n}`).join(' ');
    return `http://localhost?${new URLSearchParams({
      scope: `atproto ${repoScope} ${rpcScope}`,
      redirect_uri: Object.assign(new URL(window.location.origin), { hostname: '127.0.0.1' }).href,
    })}`;
  }
  return `https://${window.location.host}/oauth-client-metadata.json`;
}

/* ── OAuth session init ── */
export async function initSession() {
  const clientId = buildClientID();
  const oac = await BrowserOAuthClient.load({
    clientId,
    handleResolver: 'https://bsky.social',
    sessionStore: {
      async get(key) { const v = localStorage.getItem(key); return v ? JSON.parse(v) : undefined; },
      async set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
      async del(key) { localStorage.removeItem(key); },
    },
  });
  const result = await oac.init();

  if (result) {
    const { session } = result;
    log('info', 'oauth', 'initSession:restored', { sub: session.sub });

    const agent = new Agent(session);
    const res = await agent.com.atproto.server.getSession();
    if (!res.success) {
      log('error', 'oauth', 'initSession:getSessionFailed', { error: JSON.stringify(res) });
      throw new Error(JSON.stringify(res));
    }

    log('info', 'oauth', 'initSession:ok', { handle: res.data.handle });
    return { oac, agent, sessionHandle: res.data.handle };
  }
  log('info', 'oauth', 'initSession:noSession');
  return { oac, agent: null, sessionHandle: null };
}

export async function doLogin(oac, identifier) {
  log('info', 'oauth', 'doLogin:start', { identifier });
  await oac.signIn(identifier, {
    signal: new AbortController().signal,
  });
}

/* ── ATProto CRUD ── */
export async function fetchRecords(agent, collection) {
  let records = [];
  let cursor = undefined;
  while (cursor === undefined || cursor != null) {
    const res = await agent.com.atproto.repo.listRecords({
      repo: agent.did,
      collection,
      cursor,
    });
    if (!res.success) throw new Error(JSON.stringify(res));
    records.push(...res.data.records);
    cursor = typeof res.data.cursor === "string" ? res.data.cursor : null;
  }
  return records;
}

export async function createRecord(agent, collection, record) {
  const res = await agent.com.atproto.repo.createRecord({
    repo: agent.did,
    collection,
    record: {
      $type: collection,
      ...record,
      createdAt: new Date().toISOString(),
    },
  });
  if (!res.success) throw new Error(JSON.stringify(res));
  return res;
}

export async function deleteRecord(agent, collection, rkey) {
  const res = await agent.com.atproto.repo.deleteRecord({
    repo: agent.did,
    collection,
    rkey,
  });
  if (!res.success) throw new Error(JSON.stringify(res));
  return res;
}

/* ── localStorage helpers for saved VMs ── */
const SAVED_VMS_KEY = 'compute-spa-saved-vms';

export function getSavedVMs() {
  try {
    const raw = localStorage.getItem(SAVED_VMS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveVM(vm) {
  const list = getSavedVMs();
  // Replace by URI if already saved
  const idx = list.findIndex((v) => v.uri === vm.uri);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...vm };
  } else {
    list.push(vm);
  }
  localStorage.setItem(SAVED_VMS_KEY, JSON.stringify(list));
  return list;
}

export function removeVM(uri) {
  const list = getSavedVMs();
  const filtered = list.filter((v) => v.uri !== uri);
  localStorage.setItem(SAVED_VMS_KEY, JSON.stringify(filtered));
  return filtered;
}
