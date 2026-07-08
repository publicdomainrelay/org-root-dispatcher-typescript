// epds-agent.js — wraps ephemeral PDS in an Agent-compatible interface
// so polyrepo market-atproto functions (createRecord, createSignedRecord)
// can write records to localStorage instead of bsky.social.
export function createEpdsAgent(epds, did, proxyRef) {
  return {
    assertDid: did,
    did,
    com: {
      atproto: {
        repo: {
          async createRecord({ collection, record }) {
            const result = await epds.createRecord(collection, record);
            return { success: true, data: { uri: result.uri, cid: result.cid } };
          },
          async getRecord({ collection, rkey }) {
            const result = await epds.getRecord(collection, rkey);
            if (result) {
              return { success: true, data: { uri: result.uri, cid: result.cid, value: result.value } };
            }
            return { success: false, data: null, error: "RecordNotFound" };
          },
        },
        server: {
          async getServiceAuth({ aud, lxm }) {
            // Self-sign service-auth JWTs (no bsky.social needed)
            const { createServiceAuthJWT } = await import("../lib/service-auth.js");
            const { loadRelayKeypair } = await import("../main.js");
            const kp = loadRelayKeypair();
            const token = createServiceAuthJWT({
              privateKeyHex: kp.privateKeyHex,
              iss: proxyRef || kp.did,
              aud,
              lxm,
            });
            return { success: true, data: { token } };
          },
        },
      },
    },
  };
}
