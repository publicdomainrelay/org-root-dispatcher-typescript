// Polyfill for node:path — enough to satisfy the @atproto/crypto import chain
// in the browser. Only the functions actually used by @atproto/crypto.

export const sep = "/";
export const delimiter = ":";

export function join(...args) {
  return args.filter(Boolean).join("/").replace(/\/+/g, "/");
}

export function dirname(p) {
  if (!p || p === ".") return ".";
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) || "/" : ".";
}

export function basename(p, ext) {
  if (!p) return "";
  const i = p.lastIndexOf("/");
  let b = i >= 0 ? p.slice(i + 1) : p;
  if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
  return b;
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
}

export function resolve(...args) {
  let p = join(...args);
  // Simple: just join and normalize
  const parts = p.split("/").filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return "/" + out.join("/");
}

export function normalize(p) {
  return resolve(p);
}

export function isAbsolute(p) {
  return p.startsWith("/");
}

export function relative(from, to) {
  // Minimal — not accurate but avoids crashes
  return to.replace(from, "").replace(/^\//, "");
}

export function parse(p) {
  const d = dirname(p);
  const b = basename(p);
  const e = extname(b);
  return { root: "/", dir: d, base: b, ext: e, name: b.slice(0, -e.length || undefined) };
}

export function format(po) {
  return join(po.dir || "", po.base || (po.name || "") + (po.ext || ""));
}

export default { sep, delimiter, join, dirname, basename, extname, resolve, normalize, isAbsolute, relative, parse, format };
