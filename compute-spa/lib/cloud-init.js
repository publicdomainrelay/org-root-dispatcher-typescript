// @ts-check

// Cloud-init preset adapter for the SPA. The default (WooTTY terminal) preset
// is composed by the canonical cloud-init-common buildUserData module registry
// (fedproxy-web + wootty modules), bundled for the browser in
// ./cloud-init-common.bundle.js (generated with `deno bundle`; rebuild when the
// canonical modules change). Static presets (minimal/docker/nginx/k3s) remain
// inline — they are trivial and have no canonical counterpart.

import { buildUserData } from './cloud-init-common.bundle.js';

/**
 * Origin that serves the SPA's `dist/` (and therefore the wootty-web tarball
 * dropped there by `wootty-web/build-wootty-web.sh`). Hardcoded here so the
 * download URL tracks wherever the SPA is deployed.
 * @type {string}
 */
const SPA_ORIGIN = 'https://ui.fedfork.com';

/**
 * @typedef {Object} CloudInitPreset
 * @property {string} id - Preset identifier
 * @property {string} label - Human-readable label
 * @property {string} description - Short description
 * @property {string} script - Static cloud-init YAML, or placeholder when built via `build`
 * @property {((ctx: DefaultUserDataContext) => string)=} build - When present, the preset is
 *   rendered from live context (the default preset).
 */

/**
 * @typedef {Object} DefaultUserDataContext
 * @property {string} vmName - VM name / RBAC role from the form
 * @property {string} serviceName - fedproxy SERVICE name / terminal subdomain (`<role>--<handle-label>`)
 * @property {string} didPlc - Logged-in user's full DID (`did:plc:...`)
 * @property {string} didPlcKey - Bare PLC key (DID without the `did:plc:` prefix)
 * @property {string} xrpcRelaySubdomain - Subdomain the browser relay registered on `xrpc.fedproxy.com`
 * @property {string} sshHandle - Short did:plc identity fedproxy-client uses as its SSH username
 * @property {string=} relaySubdomain - Legacy alias for xrpcRelaySubdomain used by some consumers
 */

/** @type {DefaultUserDataContext} */
const PLACEHOLDER = {
  vmName: '<vm-name>',
  serviceName: '<service-name>',
  didPlc: '<did:plc:...>',
  didPlcKey: '<plc-key>',
  xrpcRelaySubdomain: '<relay-subdomain>',
  sshHandle: '<did:plc:...>',
};

/**
 * Map the SPA's DefaultUserDataContext onto the canonical CloudInitContext.
 * Tolerates the historical `relaySubdomain` / `sshHandle`-omitted shapes used
 * by some consumers.
 * @param {DefaultUserDataContext} ctx
 * @returns {Record<string, unknown>}
 */
function toCloudInitContext(ctx) {
  return {
    vmName: ctx.vmName ?? '',
    didPlc: ctx.didPlc ?? '',
    didPlcKey: ctx.didPlcKey ?? '',
    relayHost: 'xrpc.fedproxy.com',
    xrpcRelaySubdomain: ctx.xrpcRelaySubdomain ?? ctx.relaySubdomain ?? '',
    sshHandle: ctx.sshHandle ?? ctx.didPlc ?? '',
    woottyDistUrl: SPA_ORIGIN,
  };
}

/**
 * Build the default cloud-config for a VM: WooTTY-over-tmux terminal fronted by
 * fedproxy-client, with the WooTTY auth token fetched from the browser relay over
 * an OIDC-authenticated `getRecord`. SSH host key publication is handled by
 * fedproxy-client directly (un-gates the "Terminal" button in the SPA).
 *
 * Composed from the canonical `fedproxy-web` + `wootty` cloud-init-common
 * modules. The signature is unchanged so existing callers (request-vm-page.js,
 * swc-request-compute.js) keep working.
 *
 * @param {DefaultUserDataContext} ctx - Live context from the SPA form
 * @returns {string} cloud-init YAML string
 */
export function buildDefaultUserData(ctx) {
  return buildUserData({
    ctx: toCloudInitContext(ctx),
    modules: ['fedproxy-web', 'wootty'],
  });
}

/**
 * @type {CloudInitPreset[]}
 */
export const CLOUD_INIT_PRESETS = [
  {
    id: 'default',
    label: 'Default (WooTTY terminal)',
    description: 'fedproxy-client + WooTTY-over-tmux browser terminal',
    script: buildDefaultUserData(PLACEHOLDER),
    build: buildDefaultUserData,
  },
  {
    id: 'minimal',
    label: 'Minimal (Ubuntu)',
    description: 'Bare Ubuntu install, SSH only',
    script: `#cloud-config
package_update: true
package_upgrade: true
`,
  },
  {
    id: 'docker',
    label: 'Docker Host',
    description: 'Ubuntu with Docker Engine + Compose plugin',
    script: `#cloud-config
package_update: true
package_upgrade: true
packages:
  - apt-transport-https
  - ca-certificates
  - curl
  - gnupg
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
`,
  },
  {
    id: 'nginx',
    label: 'Nginx Web Server',
    description: 'Ubuntu with Nginx serving a default page',
    script: `#cloud-config
package_update: true
packages:
  - nginx
runcmd:
  - systemctl enable --now nginx
write_files:
  - path: /var/www/html/index.html
    content: |
      <html><body><h1>Hello from cloud-init</h1></body></html>
`,
  },
  {
    id: 'k3s',
    label: 'K3s Single-Node',
    description: 'Lightweight Kubernetes (k3s) server node',
    script: `#cloud-config
package_update: true
packages:
  - curl
runcmd:
  - curl -sfL https://get.k3s.io | sh -
  - systemctl enable --now k3s
`,
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Write your own cloud-init script',
    script: `#cloud-config
`,
  },
];
