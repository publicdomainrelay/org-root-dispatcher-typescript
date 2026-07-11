// local-pds.js — in-browser atproto PDS with did:plc identity.
// Imports real polyrepo packages. Signs its own service-auth tokens
// (no bsky.social needed for relay registration).
import { Secp256k1Keypair } from '@atproto/crypto';
import { createRepoFactory } from '@publicdomainrelay/hono-factory-atproto-repo-deno';
import { MemoryStorage, signServiceAuth } from '@publicdomainrelay/atproto-repo-deno';
import { nextTid } from '@publicdomainrelay/atproto-repo-common';
import { createGenesisOp, PlcClient } from '@publicdomainrelay/did-plc';
import { log, getXrpcDispatcherHost } from '../main.js';

const KEYPAIR_STORAGE_KEY = 'relay:keypair'; // shared with relay
const PLC_DIRECTORY_URL = 'https://plc.directory';

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function loadOrGenerateK256Keypair() {
  const stored = localStorage.getItem(KEYPAIR_STORAGE_KEY);
  if (stored) {
    try {
      const st = JSON.parse(stored);
      const kp = Secp256k1Keypair.import(hexToBytes(st.privateKeyHex));
      log('info', 'local-pds', 'keypair:loaded', { did: kp.did() });
      return kp;
    } catch { /* corrupt */ }
  }
  const kp = await Secp256k1Keypair.create({ exportable: true });
  const privateKeyHex = bytesToHex(await kp.export());
  localStorage.setItem(KEYPAIR_STORAGE_KEY, JSON.stringify({ privateKeyHex, did: kp.did(), createdAt: new Date().toISOString() }));
  log('info', 'local-pds', 'keypair:generated', { did: kp.did() });
  return kp;
}

/**
 * Boot an in-browser PDS: generates did:plc, registers with plc.directory,
 * sets up a repo factory, and returns an agent-compatible interface.
 */
export async function startLocalPds() {
  log('info', 'local-pds', 'booting');
  const plc = new PlcClient({ baseUrl: PLC_DIRECTORY_URL });

  const keypair = await loadOrGenerateK256Keypair();
  const kpDid = keypair.did(); // did:key:z...

  // Build a Signer from the keypair for the repo factory
  const signer = {
    did: () => plcDid,
    sign: (bytes) => keypair.sign(bytes),
  };

  // Generate did:plc genesis
  const genesis = await createGenesisOp({
    rotationKeys: [kpDid],
    verificationMethods: [{ type: 'Multikey', publicKeyMultibase: kpDid.replace(/^did:key:/, ''), relationship: ['assertionMethod', 'authentication'] }],
    services: {}, // filled below after we know the did
    sign: (bytes) => keypair.sign(bytes),
  });
  const plcDid = genesis.did;

  // Recompute with services using the now-known did
  const genesisWithServices = await createGenesisOp({
    rotationKeys: [kpDid],
    verificationMethods: [{ type: 'Multikey', publicKeyMultibase: kpDid.replace(/^did:key:/, ''), relationship: ['assertionMethod', 'authentication'] }],
    services: {},
    sign: (bytes) => keypair.sign(bytes),
  });

  // Register with PLC directory
  try {
    await plc.submitOp(plcDid, genesisWithServices.op);
    log('info', 'local-pds', 'did:plc:registered', { did: plcDid });
  } catch (err) {
    log('warn', 'local-pds', 'did:plc:register:failed', { error: String(err), did: plcDid });
  }

  // Set up repo factory with memory storage
  const storage = new MemoryStorage();
  const factory = createRepoFactory({ storage, signer });
  const repoApi = factory.api;

  // Service auth: sign any lxm ourselves (we ARE the PDS)
  async function getServiceAuth(lxm) {
    const jwt = await signServiceAuth(signer, {
      aud: `did:web:${getXrpcDispatcherHost() || 'xrpc.fedproxy.com'}`,
      iss: plcDid,
      exp: Math.floor(Date.now() / 1000) + 300,
      lxm,
    });
    return jwt;
  }

  // Create record in the local repo
  async function createRecord(collection, record) {
    const tid = nextTid();
    const writes = [{ action: 'create', collection, rkey: tid, value: { $type: collection, ...record } }];
    const commit = await repoApi.applyWrites(plcDid, writes);
    const uri = `at://${plcDid}/${collection}/${tid}`;
    return { uri, cid: String(commit.cid) };
  }

  // Agent-compatible interface for createMarketClient / XrpcClient
  const agent = {
    did: plcDid,
    assertDid: plcDid,
    service: `http://local-pds`,
    com: {
      atproto: {
        repo: {
          async createRecord(args) {
            const r = await createRecord(args.collection, args.record);
            return { success: true, data: r };
          },
          async getRecord(args) {
            const rec = await repoApi.getRecord(plcDid, args.collection, args.rkey);
            return { success: true, data: rec };
          },
          async listRecords(args) {
            const records = await repoApi.listRecords(plcDid, args.collection);
            return { success: true, data: { records, cursor: undefined } };
          },
          async deleteRecord(args) {
            const writes = [{ action: 'delete', collection: args.collection, rkey: args.rkey }];
            await repoApi.applyWrites(plcDid, writes);
            return { success: true };
          },
        },
        server: {
          async getServiceAuth(args) {
            const token = await signServiceAuth(signer, {
              aud: args.aud,
              iss: plcDid,
              exp: Math.floor(Date.now() / 1000) + 300,
              lxm: args.lxm,
            });
            return { success: true, data: { token } };
          },
        },
      },
    },
  };

  log('info', 'local-pds', 'ready', { did: plcDid });
  return { did: plcDid, agent, getServiceAuth, createRecord, keypair };
}
