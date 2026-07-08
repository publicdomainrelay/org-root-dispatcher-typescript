// Stub polyfills for Node.js built-ins that @atproto/* packages import
// but don't actually use at runtime in a browser context.
// These are identity-transform / no-op / throw-unless-called stubs.

// node:fs — file system ops (unused at runtime by the crypto/attestation paths)
const stub = new Proxy({}, { get: (_, p) => typeof p === 'symbol' ? undefined : () => { throw new Error(`node polyfill: fs.${String(p)} not implemented`); } });
export default stub;
export const readFileSync = (f) => { throw new Error(`readFileSync(${f}) not in browser`); };
export const writeFileSync = () => { throw new Error('writeFileSync not in browser'); };
export const existsSync = () => false;
export const mkdirSync = () => {};
export const statSync = () => ({ isDirectory: () => false, isFile: () => true });
export const readdirSync = () => [];
