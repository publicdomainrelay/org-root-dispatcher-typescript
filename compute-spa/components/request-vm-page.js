import {
  log, COMPUTE_VM_NSID, RFP_NSID, ACCEPT_NSID, BID_NSID, VOUCH_NSID,
  SSH_KEY_NSID, RBAC_NSID, SUBMIT_RFP_NSID, SUBMIT_ACCEPT_NSID,
  OFFERING_NSID, BADGE_BLUE_KEYS_NSID,
  createRecord, saveVM, generatePassword, vmServiceName, didPlcKey,
  terminalUrl, generateRelayKeypair, loadRelayKeypair, getAttestationKeypair, registerDidPlc,
  XRPC_DISPATCHER_HOST, FEDPROXY_HOST, RelayClient, createRelayKeypairAdapter,
  signAttestation,
} from "../main.js";
import { createEphemeralPds } from "../lib/ephemeral-pds.js";
import { createEpdsAgent } from "../lib/epds-agent.js";
import { createServiceAuthJWT } from "../lib/service-auth.js";
import { CLOUD_INIT_PRESETS, buildDefaultUserData } from "../lib/cloud-init.js";

/* ── Market relay for bidder discovery ── */
const MARKET_RELAY_URL = "https://reg.market.fedfork.com";

export class RequestVmPage extends HTMLElement {
  connectedCallback() {
    this._agent = null;
    this._sessionHandle = null;
    this._relay = null;
    this._relayStatus = "disconnected";
    this._bids = {}; // rfpUri -> array of bids
    this._flowResult = null;
    this.render();
  }

  /** Called by compute-app when relay connects/state changes. */
  _setRelay(relay) {
    this._relay = relay;
    this._relayStatus = relay.status;
    this._updateRelayUI();
    this._updateSubmitButton();
  }

  /** Called by compute-app when a bid arrives from the relay. */
  _onBid(bid) {
    const rfpUri = bid.rfpUri;
    if (!rfpUri) return;
    if (!this._bids[rfpUri]) this._bids[rfpUri] = [];
    this._bids[rfpUri].push(bid);
    this._addLog("info", `bid received from ${bid.did}`);
  }

  _updateRelayUI() {
    const dot = this.querySelector(".relay-dot");
    const text = this.querySelector(".relay-text");
    if (!dot || !text) return;
    const st = this._relayStatus;
    if (st === "registered") {
      dot.style.background = "var(--success)";
      text.textContent = `relay: connected — ${this._relay?.proxyRef || ""}`;
      text.style.color = "var(--success)";
    } else if (st === "connected" || st === "connecting") {
      dot.style.background = "var(--warning, #f59e0b)";
      text.textContent = `relay: ${st}`;
      text.style.color = "var(--warning, #f59e0b)";
    } else {
      dot.style.background = "var(--text-faint)";
      text.textContent = "relay: disconnected";
      text.style.color = "var(--text-muted)";
    }
  }

  _updateSubmitButton() {
    const btn = this.querySelector("#request-vm-submit");
    if (!btn) return;
    btn.disabled = this._relayStatus !== "registered";
  }

  disconnectedCallback() {
    if (this._relay) {
      this._relay.close();
      this._relay = null;
    }
  }

  /* ── Render ── */

  render() {
    const presetOptions = CLOUD_INIT_PRESETS.map((p) =>
      `<option value="${p.id}">${p.label} — ${p.description}</option>`
    ).join("");

    this.innerHTML = `
      <div class="card">
        <h2 style="margin-bottom:16px;">Request a Compute VM</h2>

        <!-- Relay status -->
        <div id="relay-status" style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:12px;font-family:var(--font-mono);">
          <span class="relay-dot" style="width:8px;height:8px;border-radius:50%;background:var(--text-faint);display:inline-block;"></span>
          <span class="relay-text" style="color:var(--text-muted);">relay: disconnected</span>
        </div>

        <!-- VM Name -->
        <div class="form-group">
          <label for="vm-name">VM Name</label>
          <input type="text" id="vm-name" placeholder="test-0000" required value="${this._randomVmName()}">
        </div>

        <!-- Bid Window -->
        <div class="form-group">
          <label for="bid-window">Bid Window (seconds)</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <input type="number" id="bid-window" min="5" max="300" value="5" style="flex:1;">
            <span style="font-size:12px;color:var(--text-muted);">min 5, max 300</span>
          </div>
        </div>

        <!-- Cloud-Init Preset -->
        <div class="form-group">
          <label for="preset-select">Cloud-Init Preset</label>
          <select id="preset-select">
            ${presetOptions}
          </select>
        </div>

        <!-- Cloud-Init Script -->
        <div class="form-group">
          <label for="vm-cloudinit">Cloud-Init Script <span id="cloudinit-mode-label" style="font-weight:400;color:var(--text-faint);">(auto-generated)</span></label>
          <textarea id="vm-cloudinit" rows="8" readonly style="font-size:11.5px;">${CLOUD_INIT_PRESETS[0].script}</textarea>
        </div>

        <!-- Market Discovery (collapsible) -->
        <div class="form-group" style="border:1px solid var(--accent-bg);border-radius:10px;padding:10px 14px;">
          <div id="market-toggle" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none;min-height:44px;">
            <span style="font-size:13px;font-weight:600;color:var(--text-muted);">Market Discovery</span>
            <span id="market-chevron" style="font-size:12px;color:var(--text-faint);">&#9654;</span>
          </div>
          <div id="market-body" class="hidden" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--accent-bg);font-size:12px;font-family:var(--font-mono);color:var(--text-faint);">
            <div style="margin-bottom:6px;"><strong style="color:var(--text-muted);">Market Relay:</strong> ${MARKET_RELAY_URL}</div>
            <div style="margin-bottom:6px;"><strong style="color:var(--text-muted);">Relay FQDN:</strong> <span id="market-relay-fqdn">—</span></div>
            <div style="margin-bottom:6px;"><strong style="color:var(--text-muted);">Proxy Ref:</strong> <span id="market-proxy-ref">—</span></div>
            <div><strong style="color:var(--text-muted);">Bidders:</strong></div>
            <ul id="market-bidders" style="margin:4px 0 0 16px;list-style:disc;">
              <li>(queried on submit via listReposByCollection)</li>
            </ul>
          </div>
        </div>

        <!-- Submit -->
        <button id="request-vm-submit" class="btn btn-primary btn-block" disabled>
          <span class="spinner" style="margin-right:6px;display:none;" id="submit-spinner"></span>
          <span id="submit-label">Request VM via Market</span>
        </button>

        <!-- Progress steps -->
        <div id="request-progress" class="hidden" style="margin-top:16px;">
          <div id="progress-steps" style="margin-bottom:12px;"></div>
          <div class="log-area" id="request-log" style="margin-top:0;"></div>
        </div>

        <!-- Result area -->
        <div id="result-area" class="hidden" style="margin-top:16px;padding:14px;background:var(--inset-bg);border-radius:10px;">
          <h3 style="margin-bottom:8px;font-size:15px;">VM Request Submitted</h3>
          <div style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);margin-bottom:10px;">
            <div id="result-vm-name" style="margin-bottom:4px;"></div>
            <div id="result-vm-uri" style="word-break:break-all;margin-bottom:4px;"></div>
            <div id="result-accept-uri" style="word-break:break-all;margin-bottom:8px;"></div>
          </div>
          <div style="margin-bottom:8px;">
            <span style="font-size:12px;color:var(--text-muted);">WooTTY Token:</span>
            <div class="key-code" style="margin-top:4px;">
              <code id="result-token" style="flex:1;font-size:11px;"></code>
              <button id="copy-token-btn" class="btn btn-sm btn-outline" style="font-size:10px;padding:4px 8px;">Copy</button>
            </div>
          </div>
          <a id="terminal-link" href="#" target="_blank" class="btn btn-primary btn-block" style="margin-top:10px;opacity:0.4;pointer-events:none;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;">
            Open Terminal <span style="font-size:14px;">&#8599;</span>
          </a>
        </div>
      </div>
    `;

    this._relayStatusEl = this.querySelector("#relay-status");
    this._relayDot = this.querySelector(".relay-dot");
    this._relayText = this.querySelector(".relay-text");
    this._vmName = this.querySelector("#vm-name");
    this._bidWindow = this.querySelector("#bid-window");
    this._presetSelect = this.querySelector("#preset-select");
    this._cloudInitModeLabel = this.querySelector("#cloudinit-mode-label");
    this._cloudInit = this.querySelector("#vm-cloudinit");
    this._marketToggle = this.querySelector("#market-toggle");
    this._marketBody = this.querySelector("#market-body");
    this._marketChevron = this.querySelector("#market-chevron");
    this._marketRelayFqdn = this.querySelector("#market-relay-fqdn");
    this._marketProxyRef = this.querySelector("#market-proxy-ref");
    this._submitBtn = this.querySelector("#request-vm-submit");
    this._submitSpinner = this.querySelector("#submit-spinner");
    this._submitLabel = this.querySelector("#submit-label");
    this._progress = this.querySelector("#request-progress");
    this._progressSteps = this.querySelector("#progress-steps");
    this._log = this.querySelector("#request-log");
    this._resultArea = this.querySelector("#result-area");
    this._resultVmName = this.querySelector("#result-vm-name");
    this._resultVmUri = this.querySelector("#result-vm-uri");
    this._resultAcceptUri = this.querySelector("#result-accept-uri");
    this._resultToken = this.querySelector("#result-token");
    this._copyBtn = this.querySelector("#copy-token-btn");
    this._terminalLink = this.querySelector("#terminal-link");

    this._wire();
  }

  _wire() {
    // Preset change
    this._presetSelect.addEventListener("change", () => this._onPresetChange());

    // Market toggle
    this._marketToggle.addEventListener("click", () => {
      const isHidden = this._marketBody.classList.contains("hidden");
      this._marketBody.classList.toggle("hidden");
      this._marketChevron.textContent = isHidden ? "▼" : "▶";
    });

    // Submit
    this._submitBtn.addEventListener("click", () => this._handleSubmit());

    // Copy token
    this._copyBtn.addEventListener("click", () => this._copyToken());
  }

  /* ── Relay status ── */

  _updateRelayStatus(status, subdomain, proxyRef) {
    this._relayStatus = status;

    if (status === "registered") {
      this._relayDot.style.background = "var(--accent)";
      this._relayText.textContent = `relay: connected — ${subdomain}.xrpc.fedproxy.com`;
      this._relayText.style.color = "var(--accent)";
      this._submitBtn.disabled = false;

      if (this._marketRelayFqdn) {
        this._marketRelayFqdn.textContent = `${subdomain}.xrpc.fedproxy.com`;
      }
      if (this._marketProxyRef) {
        this._marketProxyRef.textContent = proxyRef || "—";
      }
    } else if (status === "connected") {
      this._relayDot.style.background = "var(--info)";
      this._relayText.textContent = "relay: connected (registering...)";
      this._relayText.style.color = "var(--info)";
      this._submitBtn.disabled = true;
    } else if (status === "connecting") {
      this._relayDot.style.background = "var(--warning)";
      this._relayText.textContent = "relay: connecting...";
      this._relayText.style.color = "var(--warning)";
      this._submitBtn.disabled = true;
    } else {
      this._relayDot.style.background = "var(--text-faint)";
      this._relayText.textContent = "relay: disconnected";
      this._relayText.style.color = "var(--text-muted)";
      this._submitBtn.disabled = true;
    }
  }

  /* ── Preset change ── */

  _onPresetChange() {
    const presetId = this._presetSelect.value;
    const preset = CLOUD_INIT_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    if (preset.id === "default") {
      // Default preset: readonly, auto-generated at submit time
      this._cloudInit.readOnly = true;
      this._cloudInit.value = preset.script;
      this._cloudInitModeLabel.textContent = "(auto-generated)";
    } else if (preset.id === "custom") {
      // Custom: editable, empty
      this._cloudInit.readOnly = false;
      this._cloudInit.value = "";
      this._cloudInitModeLabel.textContent = "(editable)";
    } else {
      // Other presets: editable with preset script
      this._cloudInit.readOnly = false;
      this._cloudInit.value = preset.script;
      this._cloudInitModeLabel.textContent = "(editable)";
    }
  }

  /* ── Random VM name ── */

  _randomVmName() {
    return `test-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
  }

  /* ── Logging ── */

  _addLog(level, msg) {
    const entry = document.createElement("div");
    entry.className = `log-entry log-${level}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    this._log.appendChild(entry);
    this._log.scrollTop = this._log.scrollHeight;
  }

  /** Step indicators above the log area. */
  _stepLabels = [
    "Keypair",
    "Relay connect",
    "Cloud-init",
    "Register creds",
    "Compute VM",
    "Market RFP",
    "Discover",
    "Submit RFP",
    "Collect bids",
    "Accept",
    "RBAC / SSH",
    "Save VM",
  ];

  _setStep(idx, state) {
    const steps = this._progressSteps;
    const children = steps.children;
    if (children[idx]) {
      const indicator = children[idx].querySelector(".step-indicator");
      if (indicator) {
        indicator.className = `step-indicator ${state}`;
      }
    }
  }

  _renderStepIndicators(activeIdx) {
    this._progressSteps.innerHTML = this._stepLabels
      .map((label, i) => {
        const state =
          i < activeIdx ? "done" : i === activeIdx ? "active" : "pending";
        const icon =
          state === "done"
            ? "✓"
            : state === "active"
            ? "▶"
            : String(i + 1);
        return `<div class="progress-step">
          <div class="step-indicator ${state}">${icon}</div>
          <div class="step-label">${label}</div>
        </div>`;
      })
      .join("");
  }

  /* ── Market helpers ── */

  async _discoverBidders(agent) {
    const dids = [];
    const seen = new Set();

    // 1. Query market relay for repos with offering records
    this._addLog("info", `Querying market relay: ${MARKET_RELAY_URL}`);
    try {
      const relayUrl = `${MARKET_RELAY_URL}/xrpc/com.atproto.sync.listReposByCollection?collection=${OFFERING_NSID}`;
      const res = await fetch(relayUrl);
      if (res.ok) {
        const data = await res.json();
        const repos = data.repos || [];
        for (const repo of repos) {
          if (repo.did && !seen.has(repo.did)) {
            seen.add(repo.did);
            dids.push(repo.did);
          }
        }
        this._addLog("success", `Relay returned ${dids.length} repo(s) with offerings`);
      } else {
        this._addLog("warn", `Market relay returned ${res.status}`);
      }
    } catch (err) {
      this._addLog("warn", `Market relay query failed: ${err.message}`);
    }

    // 2. Vouch-based discovery from user's PDS
    try {
      const records = await agent.com.atproto.repo.listRecords({
        repo: agent.did,
        collection: VOUCH_NSID,
        limit: 50,
      });
      if (records.success && records.data?.records) {
        for (const r of records.data.records) {
          const rkey = (r.uri || "").split("/").pop() || "";
          if (rkey.startsWith("did:") && !seen.has(rkey)) {
            seen.add(rkey);
            dids.push(rkey);
          }
        }
      }
    } catch (err) {
      this._addLog("warn", `Vouch query failed (non-fatal): ${err.message}`);
    }

    return dids;
  }

  /**
   * Read a bidder's own repo for badgeBlueKeys "bidder_associate" records
   * (challenge === bidderDid) to discover the human operator DID(s) the
   * bidder trusts. The bidder's scope check binds our requester_associate
   * `keyId` to one of these operator DIDs, not the bidder DID itself.
   */
  async _discoverOperatorDids(bidderDid) {
    try {
      const didDocUrl = bidderDid.startsWith("did:web:")
        ? `https://${bidderDid.slice("did:web:".length)}/.well-known/did.json`
        : `https://plc.directory/${bidderDid}`;
      const docRes = await fetch(didDocUrl);
      if (!docRes.ok) return [];
      const doc = await docRes.json();
      const pdsSvc = (doc.service || []).find(s => s.id === "#atproto_pds");
      const pdsUrl = pdsSvc?.serviceEndpoint;
      if (!pdsUrl) return [];

      const url = `${pdsUrl}/xrpc/com.atproto.repo.listRecords?repo=${bidderDid}&collection=${BADGE_BLUE_KEYS_NSID}&limit=100`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      const operatorDids = [];
      for (const rec of data.records || []) {
        const v = rec.value || {};
        if (v.challenge === bidderDid && v.service === "bidder_associate" && typeof v.keyId === "string") {
          operatorDids.push(v.keyId);
        }
      }
      return operatorDids;
    } catch (err) {
      this._addLog("warn", `Operator DID discovery failed for ${bidderDid}: ${err.message}`);
      return [];
    }
  }

  async _submitRfpToBidder(bidderDid, rfpUri, rfpCid, kp, proxyRef) {
    try {
      // Resolve bidder DID doc to find PDS + market service endpoint
      const didDocUrl = bidderDid.startsWith("did:web:")
        ? `https://${bidderDid.slice("did:web:".length)}/.well-known/did.json`
        : `https://plc.directory/${bidderDid}`;
      const docRes = await fetch(didDocUrl);
      if (!docRes.ok) { this._addLog("warn", `Cannot resolve ${bidderDid}`); return; }
      const doc = await docRes.json();
      const pdsSvc = (doc.service || []).find(s => s.id === "#atproto_pds");
      const pdsUrl = pdsSvc?.serviceEndpoint;
      if (!pdsUrl) { this._addLog("warn", `No PDS for ${bidderDid}`); return; }

      // Query bidder's PDS for offering records applicable to compute.vm
      const offUrl = `${pdsUrl}/xrpc/com.atproto.repo.listRecords?repo=${bidderDid}&collection=${OFFERING_NSID}`;
      const offRes = await fetch(offUrl);
      if (!offRes.ok) { this._addLog("warn", `No offerings from ${bidderDid}`); return; }
      const offData = await offRes.json();
      const offerings = offData.records || [];

      for (const offering of offerings) {
        const appliesTo = offering.value?.appliesTo || [];
        if (!appliesTo.includes(COMPUTE_VM_NSID)) continue;
        const endpointUrl = offering.value?.endpointUrl;
        if (!endpointUrl) continue;

        // Submit RFP to offering's endpoint URL
        const kp = loadRelayKeypair();
        const submitUrl = endpointUrl.endsWith("/")
          ? `${endpointUrl}xrpc/${SUBMIT_RFP_NSID}`
          : `${endpointUrl}/xrpc/${SUBMIT_RFP_NSID}`;
        // aud must be a DID, not a URL. Derive did:web from endpoint hostname.
        let audDid = endpointUrl;
        try {
          const u = new URL(endpointUrl.startsWith("http") ? endpointUrl : `https://${endpointUrl}`);
          audDid = `did:web:${u.hostname}`;
        } catch { /* leave as-is */ }
        const jwt = createServiceAuthJWT({
          privateKeyHex: kp?.privateKeyHex || "",
          iss: proxyRef || kp?.did || "did:key:unknown",
          aud: audDid,
          lxm: SUBMIT_RFP_NSID,
        });
        const res = await fetch(submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${jwt}` },
          body: JSON.stringify({ rfpUri, rfpCid }),
        });
        const body = await res.json().catch(() => ({}));
        this._addLog(res.ok ? "success" : "warn", `${bidderDid}: ${res.ok ? "ok" : body.error || body.message || res.status}`);
        return;
      }
      this._addLog("warn", `No compute.vm offering from ${bidderDid}`);
    } catch (err) {
      this._addLog("warn", `submitRfp to ${bidderDid.slice(0, 20)}... failed: ${err.message}`);
    }
  }

  // Self-signed JWT (relay keypair did:key), same pattern as
  // _submitRfpToBidder -- the bidder's submitAccept endpoint is a plain URL
  // (bid.record.submitAccept === bidder's relay.proxyUrl), not an atproto
  // service-proxy target, so there is no OAuth agent/PDS in this path.
  async _submitAcceptToBidder(bidderDid, submitAcceptRef, acceptUri, acceptCid, kp, proxyRef) {
    if (!submitAcceptRef) {
      this._addLog("warn", `No submitAccept endpoint for ${bidderDid}`);
      return null;
    }
    try {
      const submitUrl = submitAcceptRef.endsWith("/")
        ? `${submitAcceptRef}xrpc/${SUBMIT_ACCEPT_NSID}`
        : `${submitAcceptRef}/xrpc/${SUBMIT_ACCEPT_NSID}`;
      let audDid = submitAcceptRef;
      try {
        const u = new URL(submitAcceptRef.startsWith("http") ? submitAcceptRef : `https://${submitAcceptRef}`);
        audDid = `did:web:${u.hostname}`;
      } catch { /* leave as-is */ }
      const jwt = createServiceAuthJWT({
        privateKeyHex: kp?.privateKeyHex || "",
        iss: proxyRef || kp?.did || "did:key:unknown",
        aud: audDid,
        lxm: SUBMIT_ACCEPT_NSID,
      });
      const res = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${jwt}` },
        body: JSON.stringify({ acceptUri, acceptCid }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        this._addLog("success", `Accept submitted to winner`);
        return body;
      }
      this._addLog("warn", `submitAccept to ${bidderDid}: ${body.error || body.message || res.status}`);
    } catch (err) {
      this._addLog("error", `submitAccept failed: ${err.message}`);
    }
    return null;
  }

  /* ── Copy token ── */

  _copyToken() {
    const token = this._resultToken?.textContent;
    if (!token) return;
    navigator.clipboard.writeText(token).catch(() => {
      // Fallback: select text
      const range = document.createRange();
      range.selectNodeContents(this._resultToken);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    this._copyBtn.textContent = "Copied!";
    setTimeout(() => { this._copyBtn.textContent = "Copy"; }, 2000);
  }

  /* ── Submit flow ── */

  async _handleSubmit() {
    const agent = this._agent;
    if (!agent) {
      this._addLog("error", "Not logged in");
      return;
    }

    const vmName = this._vmName.value.trim() || "my-vm";
    const bidWindow = Math.max(5, Math.min(300, parseInt(this._bidWindow.value) || 5));
    const didPlc = agent.did;
    const plcKey = didPlcKey(didPlc);
    const password = generatePassword();
    // serviceName/terminalHref are computed after proxyRef is known (below) --
    // they must flatten the same did:web identity cloud-init.js sets HANDLE
    // to, not the OAuth'd did:plc, or the terminal link 404s with
    // "no route configured for host".

    // Determine which preset is selected
    const presetId = this._presetSelect.value;
    const preset = CLOUD_INIT_PRESETS.find((p) => p.id === presetId);

    // Reset UI
    this._flowResult = null;
    this._bids = {};
    this._log.innerHTML = "";
    this._resultArea.classList.add("hidden");
    this._progress.classList.remove("hidden");
    this._renderStepIndicators(0);
    this._submitBtn.disabled = true;
    this._submitSpinner.style.display = "inline-block";
    this._submitLabel.textContent = "Requesting...";

    let relay = null;

    try {
      let relay, subdomain, proxyRef;

      /* ── Step 0: Keypair (always needed for ephemeral PDS + attestations) ── */
      this._setStep(0, "active");
      this._addLog("info", "Ensuring relay keypair...");
      let kp = loadRelayKeypair();
      if (!kp) {
        kp = await generateRelayKeypair();
        this._addLog("success", "Relay keypair generated: " + kp.did.slice(0, 16) + "...");
      } else {
        this._addLog("success", "Relay keypair loaded: " + kp.did.slice(0, 16) + "...");
      }
      this._setStep(0, "done");

      /* ── Step 1: Connect relay ── */
      this._setStep(1, "active");
      if (this._relay && this._relay.status === "registered") {
        relay = this._relay;
        subdomain = relay.subdomain;
        proxyRef = relay.proxyRef;
        this._addLog("success", "Relay already connected — " + subdomain + ".xrpc.fedproxy.com");
      } else {
        relay = this._relay;
        if (!relay || relay.status !== "registered") {
          throw new Error("Relay not connected. Please wait for relay to connect before submitting.");
        }
        subdomain = relay.subdomain;
        proxyRef = relay.proxyRef;
        this._addLog("success", "Relay registered — " + subdomain + ".xrpc.fedproxy.com");
      }
      this._setStep(1, "done");

      /* ── Register a did:plc for this ephemeral identity ──
       * did:web (proxyRef) embeds the relay subdomain (derived from a full
       * compressed pubkey, 57+ chars) directly in the identifier, which
       * overflows the ssh-relay's 63-char DNS label limit once combined
       * with a service name. did:plc is a short, fixed-length hash that
       * resolves via the PLC directory to the same relay endpoint -- so
       * it's used as the requester/record-author identity everywhere a
       * DNS label or short handle is needed, while proxyRef (did:web)
       * still fronts the actual XRPC/relay endpoint. */
      this._addLog("info", "Registering did:plc identity...");
      const requesterDid = await registerDidPlc(kp, proxyRef);
      this._addLog("success", "did:plc ready: " + requesterDid);

      /* ── Create ephemeral PDS keyed by the did:plc so bidders can resolve records ── */
      const epds = createEphemeralPds(requesterDid);
      this._addLog("success", "Ephemeral PDS ready");

      // HANDLE inside the VM's fedproxy-client.service is the did:plc --
      // short, so the flattened <service>--<handle> DNS label stays under 63 chars.
      const serviceName = vmServiceName(vmName, requesterDid);
      const terminalHref = terminalUrl(vmName, requesterDid, password);

      /* ── Step 2: Build cloud-init ── */
      this._setStep(2, "active");
      this._addLog("info", "Building cloud-init...");
      const ctx = { vmName, serviceName, didPlc, didPlcKey: plcKey, xrpcRelaySubdomain: subdomain, sshHandle: requesterDid };
      let cloudInit;
      if (preset?.build) {
        cloudInit = preset.build(ctx);
        this._addLog("success", "Default cloud-init built (" + cloudInit.length + " chars)");
      } else {
        cloudInit = this._cloudInit.value.trim() || preset?.script || "#cloud-config";
        this._addLog("success", "Using preset/editable cloud-init (" + cloudInit.length + " chars)");
      }
      this._setStep(2, "done");

      /* ── Step 3: Register ttyd credentials ── */
      this._setStep(3, "active");
      this._addLog("info", "Registering ttyd credentials with relay...");
      const credsRes = await relay.registerTtydRequest({
        vmName,
        serviceName,
        didPlc,
        didPlcKey: plcKey,
        password,
      });
      if (credsRes.status === 200) {
        this._addLog("success", "TTYD credentials registered");
      } else {
        this._addLog("warn", `TTYD registration returned ${credsRes.status}`);
      }
      this._setStep(3, "done");

      /* ── Step 4: Create compute.vm record (ephemeral PDS) ── */
      this._setStep(4, "active");
      this._addLog("info", "Creating compute.vm record...");
      const { uri: vmUri, cid: vmCid } = await epds.createRecord(COMPUTE_VM_NSID, {
        name: vmName,
        serviceName,
        user_data: cloudInit,
        cpus: 1,
        mem: "1G",
        disk: "10G",
        network: "500G",
        role: serviceName,
        relaySubdomain: subdomain,
        relayProxyRef: proxyRef,
        ttydPassword: password,
      });
      this._addLog("success", "compute.vm created: " + vmUri.split("/").pop());
      this._setStep(4, "done");

      /* ── Step 5: Create market.rfp record with badge.blue attestation ── */
      this._setStep(5, "active");
      this._addLog("info", "Creating market.rfp with attestation...");
      const rfpPayload = {
        $type: RFP_NSID,
        payload: { $type: "com.atproto.repo.strongRef", uri: vmUri, cid: vmCid },
        // Bidders POST their signed bid back here (market-bidder-compute
        // reads rfp.submitBid and calls it after creating the bid record).
        // Base URL only -- callService() appends /xrpc/{nsid} itself.
        submitBid: `https://${subdomain}.xrpc.fedproxy.com`,
      };
      // Proper badge.blue attestation: sign the DAG-CBOR CID
      const sig = await signAttestation(kp, rfpPayload, requesterDid);
      const { uri: rfpUri, cid: rfpCid } = await epds.createRecord(RFP_NSID, {
        ...rfpPayload,
        signatures: [sig],
      });
      this._addLog("success", "market.rfp created: " + rfpUri.split("/").pop());
      this._setStep(5, "done");

      /* ── Step 6: Discover bidders ── */
      this._setStep(6, "active");
      this._addLog("info", "Discovering bidders...");
      const bidderDids = await this._discoverBidders(agent);
      this._addLog("success", `Found ${bidderDids.length} bidder(s) via relay + vouch`);
      // Update the market UI
      const bidderList = this.querySelector("#market-bidders");
      if (bidderList) {
        bidderList.innerHTML = bidderDids.map((d) => `<li>${d}</li>`).join("");
      }
      this._setStep(6, "done");

      // Self-attested requester_associate badgeBlueKeys record, one per
      // bidder's discovered operator DID(s), on our own ephemeral repo.
      // Mirrors what a live associateConfirm handshake would write --
      // bidders resolve it via listRecords on our did:web repo to satisfy
      // the scope check (keyId must be a bidder-trusted OPERATOR did, not
      // the bidder's own did).
      for (const bidderDid of bidderDids) {
        const operatorDids = await this._discoverOperatorDids(bidderDid);
        for (const operatorDid of operatorDids) {
          await epds.createRecord(BADGE_BLUE_KEYS_NSID, {
            keyId: operatorDid,
            challenge: requesterDid,
            service: "requester_associate",
          });
        }
      }

      /* ── Step 7: Submit RFP to bidders ── */
      this._setStep(7, "active");
      this._addLog("info", `Submitting RFP to ${bidderDids.length} bidder(s)...`);
      let submittedCount = 0;
      for (const bidderDid of bidderDids) {
        await this._submitRfpToBidder(bidderDid, rfpUri, rfpCid, kp, requesterDid);
        submittedCount++;
      }
      this._addLog("success", `RFP submitted to ${submittedCount} bidder(s)`);
      this._setStep(7, "done");

      /* ── Step 8: Collect bids ── */
      this._setStep(8, "active");
      this._addLog("info", `Waiting ${bidWindow}s for bids...`);
      await new Promise((resolve) => setTimeout(resolve, bidWindow * 1000));
      const collectedBids = this._bids[rfpUri] || [];
      this._addLog("info", `Collected ${collectedBids.length} bid(s)`);
      this._setStep(8, "done");

      /* ── Step 9: Accept winner ── */
      this._setStep(9, "active");
      this._addLog("info", "Processing acceptance...");

      // Pick winner: cheapest bid or first bid
      let winnerBid = null;
      let winnerSubmitAccept = null;
      let winnerBidDid = null;
      if (collectedBids.length > 0) {
        // Sort by price if available, otherwise pick first
        const sorted = [...collectedBids].sort((a, b) => {
          const pa = a.price || a.amount || 0;
          const pb = b.price || b.amount || 0;
          return pa - pb;
        });
        winnerBid = sorted[0];
        winnerSubmitAccept = winnerBid.submitAccept || winnerBid.aud;
        winnerBidDid = winnerBid.did || winnerBid.aud;
        this._addLog("success", "Winner: " + (winnerBidDid?.slice(0, 20) || "first bidder"));
      }

      // Create market.accept record
      let acceptUri = null;
      let acceptCid = null;
      let receiptUri = null;
      let receiptCid = null;
      let submitEventRef = null;

      if (winnerBid) {
        const bidRef = winnerBid.bidRef || winnerBid;
        const acceptPayload = {
          $type: ACCEPT_NSID,
          rfp: { $type: "com.atproto.repo.strongRef", uri: rfpUri, cid: rfpCid },
          bid: { $type: "com.atproto.repo.strongRef", uri: bidRef.uri || rfpUri, cid: bidRef.cid || rfpCid },
        };
        const result = await epds.createRecord(ACCEPT_NSID, {
          ...acceptPayload,
          signatures: [await signAttestation(kp, acceptPayload, requesterDid)],
        });
        acceptUri = result.uri;
        acceptCid = result.cid;
        this._addLog("success", "market.accept created: " + acceptUri.split("/").pop());

        // Submit accept to winner
        if (winnerSubmitAccept) {
          this._addLog("info", "Submitting accept to winner...");
          const receipt = await this._submitAcceptToBidder(
            winnerBidDid || winnerSubmitAccept,
            winnerSubmitAccept,
            acceptUri,
            acceptCid,
            kp,
            requesterDid,
          );
          if (receipt) {
            this._addLog("success", "Provisioning receipt received");
            receiptUri = receipt.uri || null;
            receiptCid = receipt.cid || null;
            submitEventRef = receipt.submitEvent || null;
          }
        }
      } else {
        this._addLog("warn", "No bids collected — creating accept placeholder");
        const acceptPayload = {
          $type: ACCEPT_NSID,
          rfp: { $type: "com.atproto.repo.strongRef", uri: rfpUri, cid: rfpCid },
          bid: { $type: "com.atproto.repo.strongRef", uri: rfpUri, cid: rfpCid },
        };
        const result = await epds.createRecord(ACCEPT_NSID, {
          ...acceptPayload,
          signatures: [await signAttestation(kp, acceptPayload, requesterDid)],
        });
        acceptUri = result.uri;
        acceptCid = result.cid;
        this._addLog("warn", "market.accept created (no winner bid)");
      }
      this._setStep(9, "done");

      /* ── Step 10: RBAC / SSH key records ── */
      this._setStep(10, "active");
      this._addLog("info", "Creating RBAC and SSH key records...");
      try {
        const rbacRecord = await createRecord(agent, RBAC_NSID, {
          roles: {
            [serviceName]: {
              role_name: serviceName,
              definition: {
                aud: `api://ATProto?actx=${didPlc}`,
                iss: `did:web:${FEDPROXY_HOST}`,
                sub: `actx:default:plc:${plcKey}:role:${serviceName}`,
                policies: [`${serviceName}-ssh-key-register`],
              },
            },
          },
          policies: {
            [`${serviceName}-ssh-key-register`]: {
              meta: { policy: "ssh-key-register" },
              schemas: {
                "/xrpc/com.atproto.repo.createRecord": {
                  type: "object",
                  $schema: "http://json-schema.org/draft-07/schema#",
                  required: ["capability", "body"],
                  properties: {
                    capability: { enum: ["create"] },
                    body: {
                      type: "object",
                      additionalProperties: false,
                      required: ["collection", "record"],
                      properties: {
                        collection: { type: "string", const: SSH_KEY_NSID },
                        record: {
                          type: "object",
                          properties: { service: { type: "string", const: serviceName } },
                          required: ["service"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          custom_claims_roles_index: {},
        });
        this._addLog("success", "RBAC record created");
      } catch (err) {
        this._addLog("warn", "RBAC creation (non-fatal): " + err.message);
      }
      this._setStep(10, "done");

      /* ── Step 11: Save VM ── */
      this._setStep(11, "active");
      this._addLog("info", "Saving VM to localStorage...");
      saveVM({
        uri: vmUri,
        cid: vmCid,
        name: vmName,
        serviceName,
        status: "provisioning",
        password,
        acceptUri,
        receiptUri,
        receiptCid,
        submitEventRef,
        relaySubdomain: subdomain,
        relayProxyRef: proxyRef,
        createdAt: new Date().toISOString(),
      });
      this._addLog("success", "VM saved locally.");
      this._setStep(11, "done");

      /* ── Show result ── */
      this._flowResult = { vmName, serviceName, password, terminalHref, vmUri, acceptUri };
      this._showResult(this._flowResult);
    } catch (err) {
      this._addLog("error", "Flow error: " + (err.message || err));
    } finally {
      this._submitBtn.disabled = false;
      this._submitSpinner.style.display = "none";
      this._submitLabel.textContent = "Request VM via Market";
    }
  }

  _showResult(result) {
    this._resultVmName.textContent = "VM: " + result.vmName;
    this._resultVmUri.textContent = "URI: " + (result.vmUri || "—");
    this._resultAcceptUri.textContent = "Accept: " + (result.acceptUri || "—");
    this._resultToken.textContent = result.password;

    // Terminal link: starts grey, becomes green when relay reports SSH ready
    this._terminalLink.href = result.terminalHref;

    // Poll for SSH readiness (relay reports SSH key publication)
    const pollSsh = () => {
      if (this._relay && this._relay.isSshReady(result.serviceName)) {
        this._terminalLink.style.opacity = "1";
        this._terminalLink.style.pointerEvents = "auto";
        this._addLog("success", "SSH key published — terminal available");
      } else {
        // Re-check after a delay
        setTimeout(pollSsh, 3000);
      }
    };
    setTimeout(pollSsh, 5000);

    this._resultArea.classList.remove("hidden");

    // Reset VM name for next request
    this._vmName.value = this._randomVmName();
  }
}

if (!customElements.get("request-vm-page")) {
  customElements.define("request-vm-page", RequestVmPage);
}
