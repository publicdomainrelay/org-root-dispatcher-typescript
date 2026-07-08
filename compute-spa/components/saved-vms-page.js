import {
  log, getSavedVMs, removeVM, COMPUTE_VM_DELETE_NSID, EVENT_NSID, SUBMIT_EVENT_NSID,
  loadRelayKeypair, signAttestation,
} from '../main.js';
import { createEphemeralPds } from '../lib/ephemeral-pds.js';
import { createServiceAuthJWT } from '../lib/service-auth.js';

/** Authority segment of an at:// URI (`at://<authority>/collection/rkey`). */
function atUriAuthority(uri) {
  return uri.replace(/^at:\/\//, '').split('/')[0];
}

export class SavedVmsPage extends HTMLElement {
  connectedCallback() {
    this._agent = null;
    this.render();
  }

  render() {
    this.innerHTML = `
      <div id="saved-vms-list">
        <h2 style="margin-bottom:16px;">Saved VMs</h2>
        <div id="vms-container"></div>
      </div>
    `;
    this._container = this.querySelector('#vms-container');
    this.refresh();
  }

  refresh() {
    const vms = getSavedVMs();
    this._container.innerHTML = '';

    if (vms.length === 0) {
      this._container.innerHTML = `
        <div class="empty-state">
          <p>No saved VMs yet.</p>
          <span class="text-muted" style="font-size:13px;">Go to "Request VM" to create one.</span>
        </div>
      `;
      return;
    }

    for (const vm of vms) {
      const card = document.createElement('div');
      card.className = 'card-sm';

      const statusPill = vm.status === 'active'
        ? '<span class="pill pill-accent">active</span>'
        : vm.status === 'provisioning'
        ? '<span class="pill pill-info">provisioning</span>'
        : '<span class="pill pill-danger">pending</span>';

      const terminalLink = vm.serviceName
        ? `<a href="https://${vm.serviceName}.fedproxy.com" target="_blank" class="text-accent" style="font-size:12px;">Terminal</a>`
        : '<span class="text-faint" style="font-size:12px;">No terminal assigned</span>';

      card.innerHTML = `
        <div class="vm-card">
          <div class="vm-info">
            <div class="vm-name">${vm.name}</div>
            <div class="vm-meta">
              ${statusPill}
              <span style="margin-left:8px;">${vm.uri ? vm.uri.split('/').pop() : 'no uri'}</span>
            </div>
            <div class="vm-meta" style="margin-top:4px;">
              ${terminalLink}
            </div>
          </div>
          <div class="vm-actions">
            <button class="btn btn-danger btn-sm vm-delete-btn" data-uri="${vm.uri}">Delete</button>
          </div>
        </div>
      `;

      const deleteBtn = card.querySelector('.vm-delete-btn');
      deleteBtn.addEventListener('click', () => this._handleDelete(vm));

      this._container.appendChild(card);
    }
  }

  /**
   * POST a signed market.event(vm.delete) record to the bidder's submitEvent
   * endpoint. Mirrors request-vm-page.js's _submitAcceptToBidder (self-signed
   * JWT, no OAuth agent) and atproto-market/lib/requester-xrpc/mod.ts's
   * teardown step (compute.events.vm.delete wrapped in a market.event,
   * bound to the original accept via a receipt strongRef).
   */
  async _submitDeleteEvent(vm) {
    const kp = loadRelayKeypair();
    if (!kp) {
      log('warn', 'saved-vms', 'delete:noKeypair', { uri: vm.uri });
      return false;
    }
    if (!vm.receiptUri || !vm.receiptCid || !vm.submitEventRef) {
      log('info', 'saved-vms', 'delete:skipped', {
        reason: 'missing receipt refs', uri: vm.uri,
        receiptUri: vm.receiptUri, receiptCid: vm.receiptCid, submitEventRef: vm.submitEventRef,
      });
      return false;
    }

    const requesterDid = atUriAuthority(vm.uri);
    const epds = createEphemeralPds(requesterDid);
    const nowIso = new Date().toISOString();

    const deletePayload = { $type: COMPUTE_VM_DELETE_NSID, reason: 'user_requested', createdAt: nowIso };
    const { uri: delUri, cid: delCid } = await epds.createRecord(COMPUTE_VM_DELETE_NSID, {
      ...deletePayload,
      signatures: [await signAttestation(kp, deletePayload, requesterDid)],
    });

    const eventPayload = {
      $type: EVENT_NSID,
      receipt: { $type: 'com.atproto.repo.strongRef', uri: vm.receiptUri, cid: vm.receiptCid },
      payload: { $type: 'com.atproto.repo.strongRef', uri: delUri, cid: delCid },
      createdAt: nowIso,
    };
    const { uri: eventUri, cid: eventCid } = await epds.createRecord(EVENT_NSID, {
      ...eventPayload,
      signatures: [await signAttestation(kp, eventPayload, requesterDid)],
    });

    try {
      const submitEventRef = vm.submitEventRef;
      const submitUrl = submitEventRef.endsWith('/')
        ? `${submitEventRef}xrpc/${SUBMIT_EVENT_NSID}`
        : `${submitEventRef}/xrpc/${SUBMIT_EVENT_NSID}`;
      let audDid = submitEventRef;
      try {
        const u = new URL(submitEventRef.startsWith('http') ? submitEventRef : `https://${submitEventRef}`);
        audDid = `did:web:${u.hostname}`;
      } catch { /* leave as-is */ }
      const jwt = createServiceAuthJWT({
        privateKeyHex: kp.privateKeyHex,
        iss: requesterDid,
        aud: audDid,
        lxm: SUBMIT_EVENT_NSID,
      });
      const res = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify({ uri: eventUri, cid: eventCid, record: eventPayload }),
      });
      const body = await res.json().catch(() => ({}));
      log(res.ok ? 'info' : 'warn', 'saved-vms', 'delete:eventResult', {
        uri: vm.uri, status: res.status, ok: res.ok, error: body.error || body.message,
      });
      return res.ok;
    } catch (err) {
      log('error', 'saved-vms', 'delete:eventError', { uri: vm.uri, error: String(err) });
      return false;
    }
  }

  async _handleDelete(vm) {
    if (!vm.uri) {
      removeVM(vm.uri);
      this.refresh();
      return;
    }

    log('info', 'saved-vms', 'delete', { uri: vm.uri });
    await this._submitDeleteEvent(vm);

    removeVM(vm.uri);
    this.refresh();
  }
}

if (!customElements.get('saved-vms-page')) {
  customElements.define('saved-vms-page', SavedVmsPage);
}
