// service-auth.js — self-sign service-auth JWTs for the xrpc relay dispatcher.
// Uses @noble/curves for secp256k1 ES256K signing. No @atproto/crypto or
// hono-pds imports — those pull Node built-ins that break browser bundles.
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Sign a service-auth JWT for the xrpc relay dispatcher.
 * Uses ES256K (secp256k1) — the same algorithm @atproto/crypto uses.
 * The xrpc relay dispatcher verifies this JWT signature.
 */
export function createServiceAuthJWT({ privateKeyHex, iss, aud, lxm }) {
  const header = { alg: 'ES256K', typ: 'jwt' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss,
    aud,
    exp: now + 300,
    iat: now,
    jti: crypto.randomUUID(),
    lxm,
  };

  const enc = new TextEncoder();
  const headerB64 = btoaUrl(enc.encode(JSON.stringify(header)));
  const payloadB64 = btoaUrl(enc.encode(JSON.stringify(payload)));
  const toSign = enc.encode(`${headerB64}.${payloadB64}`);

  const privBytes = fromHex(privateKeyHex);
  const hash = sha256(toSign);
  const sig = secp256k1.sign(hash, privBytes, { lowS: true });
  const sigB64 = btoaUrl(sig.toCompactRawBytes());

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function btoaUrl(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
