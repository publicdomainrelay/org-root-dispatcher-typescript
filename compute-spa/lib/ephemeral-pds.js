/**
 * Lightweight in-memory record store for market records.
 * Records are stored in a Map and persisted to localStorage.
 * No Bluesky PDS needed -- the relay serves records to bidders/queries
 * via the WebSocket handlers already in main.js.
 */

const STORE_PREFIX = 'ephemeral-pds:';

/**
 * Create an ephemeral PDS instance linked to a relay keypair did:key.
 * @param {string} keypairDid - The relay keypair's did:key (e.g. `did:key:zQ3sh...`)
 * @returns {{ createRecord, getRecord, listRecords, deleteRecord }}
 */
export function createEphemeralPds(keypairDid) {
  /** In-memory store: Map<collection, Map<rkey, {uri, cid, value, rkey}>> */
  const store = new Map();

  /** Load records for a collection from localStorage. */
  function loadCollection(collection) {
    if (store.has(collection)) return;
    const records = new Map();
    try {
      const raw = localStorage.getItem(STORE_PREFIX + collection);
      if (raw) {
        const arr = JSON.parse(raw);
        for (const item of arr) {
          records.set(item.rkey, item);
        }
      }
    } catch {
      /* ignore corrupt data */
    }
    store.set(collection, records);
  }

  /** Persist a collection to localStorage. */
  function persistCollection(collection, records) {
    const arr = Array.from(records.values());
    localStorage.setItem(STORE_PREFIX + collection, JSON.stringify(arr));
  }

  /** Generate a timestamp-based rkey. */
  function generateRkey() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return 'rec-' + ts + '-' + rand;
  }

  /** Compute a fake CID from JSON content (first 16 bytes of SHA-256 as hex). */
  async function computeCid(value) {
    const json = JSON.stringify(value);
    const encoder = new TextEncoder();
    const data = encoder.encode(json);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hash);
    let hex = '';
    for (let i = 0; i < 16; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return 'bafy' + hex;
  }

  /**
   * Create a record with a fake AT-URI.
   * @param {string} collection - NSID of the collection
   * @param {object} record - Record body
   * @returns {Promise<{uri: string, cid: string}>}
   */
  async function createRecord(collection, record) {
    loadCollection(collection);
    const records = store.get(collection);
    const rkey = generateRkey();
    const uri = 'at://' + keypairDid + '/' + collection + '/' + rkey;
    // Stored exactly as given -- no field injection after the caller may
    // have already signed an attestation over this exact object, or the
    // recomputed CID on the verifier side won't match.
    const value = record.$type ? record : { $type: collection, ...record };
    const cid = await computeCid(value);
    records.set(rkey, { uri, cid, value, rkey });
    persistCollection(collection, records);
    return { uri, cid };
  }

  /**
   * Get a record by its AT-URI.
   * @param {string} uri - AT-URI like `at://did:key:z.../com.example.collection/rkey`
   * @returns {{uri: string, cid: string, value: object}|undefined}
   */
  function getRecord(uri) {
    const parts = uri.replace(/^at:\/\//, '').split('/');
    if (parts.length !== 3) return undefined;
    const collection = parts[1];
    const rkey = parts[2];
    loadCollection(collection);
    const records = store.get(collection);
    if (!records) return undefined;
    const entry = records.get(rkey);
    if (!entry) return undefined;
    return { uri: entry.uri, cid: entry.cid, value: entry.value };
  }

  /**
   * List all records in a collection.
   * @param {string} collection - NSID of the collection
   * @returns {Array<{uri: string, cid: string, value: object}>}
   */
  function listRecords(collection) {
    loadCollection(collection);
    const records = store.get(collection);
    if (!records) return [];
    return Array.from(records.values()).map(function (entry) {
      return { uri: entry.uri, cid: entry.cid, value: entry.value };
    });
  }

  /**
   * Delete a record by collection and rkey.
   * @param {string} collection - NSID of the collection
   * @param {string} rkey - Record key
   * @returns {boolean} - true if deleted, false if not found
   */
  function deleteRecord(collection, rkey) {
    loadCollection(collection);
    const records = store.get(collection);
    if (!records) return false;
    const deleted = records.delete(rkey);
    if (deleted) {
      persistCollection(collection, records);
    }
    return deleted;
  }

  return { createRecord, getRecord, listRecords, deleteRecord };
}
