// constants.js — NSID constants, hostnames, and pure helper functions.
// Zero dependencies. Works in browsers and Deno. Importable by compute-spa
// and social-web-computer (via import map).

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

export const CRUD_SCOPE_NSIDS = [
  COMPUTE_VM_NSID,
  RBAC_NSID,
  SSH_KEY_NSID,
  BADGE_BLUE_KEYS_NSID,
];

/* ── XRPC procedure NSIDs ── */
export const SUBSCRIBE_NSID = 'com.fedproxy.temp.xrpc.subscribe';
export const GET_NONCE_NSID = 'com.fedproxy.temp.xrpc.getRegistrationNonce';
export const TTYD_CREDS_NSID = 'com.fedproxy.ttydCredentials';

/* ── Host constants ── */
export const FEDPROXY_HOST = 'fedproxy.com';
export const XRPC_DISPATCHER_HOST = 'xrpc.fedproxy.com';
export const MARKET_RELAY_URL = 'https://reg.market.fedfork.com';

/* ── Hex conversion ── */
export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

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

/* ── Password generator ── */

/** Generate a 24-char password from 18 random bytes (base64, stripped). */
export function generatePassword() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/[+\/=]/g, '').slice(0, 24);
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
  const idx = list.findIndex((v) => v.uri === vm.uri);
  if (idx >= 0) list[idx] = { ...list[idx], ...vm };
  else list.push(vm);
  localStorage.setItem(SAVED_VMS_KEY, JSON.stringify(list));
  return list;
}

export function removeVM(uri) {
  const list = getSavedVMs();
  const filtered = list.filter((v) => v.uri !== uri);
  localStorage.setItem(SAVED_VMS_KEY, JSON.stringify(filtered));
  return filtered;
}
