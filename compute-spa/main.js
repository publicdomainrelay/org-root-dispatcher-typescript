import { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import { Agent } from '@atproto/api';
import { fromHex } from './lib/constants.js';
import { loadRelayKeypair } from './lib/relay.js';

// Re-export library modules so existing imports from main.js continue to work.
export {
  COMPUTE_VM_NSID, RFP_NSID, ACCEPT_NSID, BID_NSID, RECEIPT_NSID,
  EVENT_NSID, OFFERING_NSID, RBAC_NSID, SSH_KEY_NSID,
  SUBMIT_RFP_NSID, SUBMIT_ACCEPT_NSID, SUBMIT_BID_NSID, SUBMIT_EVENT_NSID,
  COMPUTE_VM_DELETE_NSID, REQUEST_COMPUTE_VM_NSID, DELETE_COMPUTE_NSID,
  VOUCH_NSID, BADGE_BLUE_KEYS_NSID, CRUD_SCOPE_NSIDS,
  FEDPROXY_HOST, XRPC_DISPATCHER_HOST, MARKET_RELAY_URL,
  didPlcKey, handleToLabel, vmServiceName, terminalUrl,
  toHex, fromHex, generatePassword,
  getSavedVMs, saveVM, removeVM,
} from './lib/constants.js';

export {
  Secp256k1Keypair, loadRelayKeypair, generateRelayKeypair,
  loadOrGenerateKeypair, createRelayKeypairAdapter, registerDidPlc,
  RelayClient, createRelayClient,
} from './lib/relay.js';

/* ── Structured JSON logger ── */
export function log(level, component, event, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, component, event, ...data });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/* ── Badge.blue attestation signing ── */
export async function signAttestation(kp, record, repositoryDid) {
  const { Attestation } = await import("@atiproto/atproto-attestation");
  const priv = fromHex(kp.privateKeyHex);
  const privateKey = { type: "k256", bytes: priv, toBytes: () => priv };
  const att = new Attestation({ privateKey });
  const entry = await att.sign({ record, repository: repositoryDid || kp.did });
  const sig = entry.signature instanceof Uint8Array ? entry.signature : entry.signature;
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
  return { $type: entry.$type, key: entry.key, cid: entry.cid, signature: { $bytes: btoa(bin) } };
}

/** Returns an attestation-compatible keypair object, or null. */
export function getAttestationKeypair() {
  const kp = loadRelayKeypair();
  if (!kp) return null;
  const priv = fromHex(kp.privateKeyHex);
  return { did: () => kp.did, privateKey: { type: 'k256', bytes: priv, toBytes: () => priv } };
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

/* ── OAuth client id ── */
export function buildClientID() {
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocal) {
    const repoScope = CRUD_SCOPE_NSIDS.map(n => `repo:${n}?action=create,update,delete`).join(' ');
    const rpcScope = [
      `${SUBMIT_RFP_NSID}?aud=*`, `${SUBMIT_ACCEPT_NSID}?aud=*`,
      `${SUBMIT_BID_NSID}?aud=*`, `${SUBMIT_EVENT_NSID}?aud=*`,
      `com.fedproxy.temp.xrpc.getRegistrationNonce?aud=did:web:${XRPC_DISPATCHER_HOST}`,
      `com.fedproxy.temp.xrpc.subscribe?aud=did:web:${XRPC_DISPATCHER_HOST}`,
    ].map(n => `rpc:${n}`).join(' ');
    return `http://localhost?${new URLSearchParams({ scope: `atproto ${repoScope} ${rpcScope}`, redirect_uri: Object.assign(new URL(window.location.origin), { hostname: '127.0.0.1' }).href })}`;
  }
  return `https://${window.location.host}/oauth-client-metadata.json`;
}

/* ── OAuth session init ── */
export async function initSession() {
  const clientId = buildClientID();
  const oac = await BrowserOAuthClient.load({
    clientId, handleResolver: 'https://bsky.social',
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
    if (!res.success) { log('error', 'oauth', 'initSession:getSessionFailed', { error: JSON.stringify(res) }); throw new Error(JSON.stringify(res)); }
    log('info', 'oauth', 'initSession:ok', { handle: res.data.handle });
    return { oac, agent, sessionHandle: res.data.handle };
  }
  log('info', 'oauth', 'initSession:noSession');
  return { oac, agent: null, sessionHandle: null };
}

export async function doLogin(oac, identifier) {
  log('info', 'oauth', 'doLogin:start', { identifier });
  await oac.signIn(identifier, { signal: new AbortController().signal });
}

/* ── ATProto CRUD ── */
export async function fetchRecords(agent, collection) {
  let records = [], cursor = undefined;
  while (cursor === undefined || cursor != null) {
    const res = await agent.com.atproto.repo.listRecords({ repo: agent.did, collection, cursor });
    if (!res.success) throw new Error(JSON.stringify(res));
    records.push(...res.data.records);
    cursor = typeof res.data.cursor === "string" ? res.data.cursor : null;
  }
  return records;
}

export async function createRecord(agent, collection, record) {
  const res = await agent.com.atproto.repo.createRecord({ repo: agent.did, collection, record: { $type: collection, ...record, createdAt: new Date().toISOString() } });
  if (!res.success) throw new Error(JSON.stringify(res));
  return res;
}

export async function deleteRecord(agent, collection, rkey) {
  const res = await agent.com.atproto.repo.deleteRecord({ repo: agent.did, collection, rkey });
  if (!res.success) throw new Error(JSON.stringify(res));
  return res;
}
