import { log, getSavedVMs, removeVM, COMPUTE_VM_DELETE_NSID, deleteRecord } from '../main.js';

/*
 * TODO: Add market event record creation and terminal integration when
 * browser-safe packages are complete.
 */

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

  async _handleDelete(vm) {
    if (!vm.uri) {
      removeVM(vm.uri);
      this.refresh();
      return;
    }

    log('info', 'saved-vms', 'delete', { uri: vm.uri });

    try {
      // TODO: Create a delete event record in the compute events collection
      // when the market event NSIDs are finalized.
      // e.g. createRecord(agent, COMPUTE_EVENT_NSID, { type: 'vm.delete', ref: vm.uri })
      log('info', 'saved-vms', 'delete:eventRecord', { note: 'TODO: create market event record' });
    } catch (err) {
      log('error', 'saved-vms', 'delete:eventError', { error: String(err) });
    }

    removeVM(vm.uri);
    this.refresh();
  }
}

if (!customElements.get('saved-vms-page')) {
  customElements.define('saved-vms-page', SavedVmsPage);
}
