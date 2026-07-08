import { initSession, doLogin, log, RelayClient, generateRelayKeypair, loadRelayKeypair, createRelayKeypairAdapter, XRPC_DISPATCHER_HOST, BADGE_BLUE_KEYS_NSID } from '../main.js';
import { createServiceAuthJWT } from '../lib/service-auth.js';
import './request-vm-page.js';
import './saved-vms-page.js';

export class ComputeApp extends HTMLElement {
  connectedCallback() {
    this._oac = null;
    this._agent = null;
    this._sessionHandle = null;
    this._state = 'loading'; // 'loading' | 'login' | 'main'
    this._boundHashChange = this._onHashChange.bind(this);
    window.addEventListener('hashchange', this._boundHashChange);
    window.addEventListener('popstate', this._boundHashChange);
    this.renderLoading();
    this._init();
  }

  disconnectedCallback() {
    window.removeEventListener('hashchange', this._boundHashChange);
    window.removeEventListener('popstate', this._boundHashChange);
  }

  _onHashChange() {
    if (this._state === 'main') {
      this._switchPage();
    }
  }

  _switchPage() {
    const hash = window.location.hash || '#/request-vm';
    const requestPage = this.querySelector('#page-request-vm');
    const savedPage = this.querySelector('#page-saved-vms');
    const tabs = this.querySelectorAll('.tab-nav a');

    if (hash.startsWith('#/saved-vms')) {
      requestPage.style.display = 'none';
      savedPage.style.display = '';
      tabs[0].classList.remove('active');
      tabs[1].classList.add('active');
      if (savedPage.refresh) savedPage.refresh();
    } else {
      requestPage.style.display = '';
      savedPage.style.display = 'none';
      tabs[0].classList.add('active');
      tabs[1].classList.remove('active');
    }
  }

  renderLoading() {
    this.innerHTML = `
      <main class="app-shell">
        <div class="card text-center" style="padding:40px;">
          <h2 aria-busy="true">Loading session…</h2>
          <p id="load-error" class="text-danger hidden mt-3"></p>
        </div>
      </main>
    `;
  }

  async _init() {
    try {
      log('debug', 'app', '_init:start');
      const { oac, agent, sessionHandle } = await initSession();
      this._oac = oac;
      this._agent = agent;
      this._sessionHandle = sessionHandle;

      if (agent && sessionHandle) {
        log('info', 'app', '_init:loggedIn', { handle: sessionHandle });
        this.renderMain();
      } else {
        log('info', 'app', '_init:loggedOut');
        this.renderLogin();
      }
    } catch (err) {
      log('error', 'app', '_init:error', { error: String(err) });
      const loadError = this.querySelector('#load-error');
      if (loadError) {
        loadError.classList.remove('hidden');
        loadError.textContent = `An error occurred: ${err}`;
      }
    }
  }

  renderLogin() {
    this._state = 'login';
    this.innerHTML = `
      <main class="app-shell">
        <header style="margin-bottom:24px;">
          <h1 style="font-size:18px;white-space:nowrap;">Compute</h1>
          <p class="text-muted" style="font-size:14px;margin-top:4px;">Request VMs and access terminals</p>
        </header>
        <div class="card">
          <h2>Login with the Atmosphere</h2>
          <form id="login-form" style="margin-top:12px;">
            <p class="text-muted" style="font-size:14px;margin-bottom:12px;">Enter your handle to continue</p>
            <input type="text" name="username" id="login-handle"
              placeholder="alice.example.com"
              style="margin-bottom:12px;" required>
            <button type="submit" class="btn btn-primary btn-block" id="login-submit">Login</button>
          </form>
          <p class="text-muted mt-3" style="font-size:13px;">If you're a Bluesky user, you already have an Atmosphere account.</p>
          <button id="bsky-btn" class="btn btn-secondary btn-block mt-3">Login with Bluesky Social</button>
          <p id="login-error" class="text-danger mt-3" style="font-size:13px;"></p>
        </div>
        <nav style="margin-top:20px;text-align:center;font-size:13px;">
          <a href="https://github.com/publicdomainrelay" target="_blank" class="text-muted">publicdomainrelay</a>
        </nav>
      </main>
    `;

    this.querySelector('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = this.querySelector('#login-submit');
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = 'Logging in…';
      this.querySelector('#login-error').textContent = '';
      try {
        await doLogin(this._oac, e.target.username.value);
      } catch (err) {
        this.querySelector('#login-error').textContent = `Login error: ${err}`;
      }
      btn.removeAttribute('aria-busy');
      btn.textContent = 'Login';
    });

    this.querySelector('#bsky-btn').addEventListener('click', () => {
      doLogin(this._oac, 'https://bsky.social');
    });
  }

  async renderMain() {
    this._state = 'main';
    this.innerHTML = `
      <main class="app-shell">
        <header style="margin-bottom:20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <h1 style="font-size:18px;white-space:nowrap;">Compute</h1>
            <button class="btn btn-outline btn-sm" id="logout-btn" style="padding:4px 10px;font-size:11px;">Logout</button>
          </div>
          <div class="text-muted" style="font-size:12px;margin-top:4px;">@${this._sessionHandle}</div>
        </header>

        <nav class="tab-nav">
          <a href="#/request-vm" class="active">Request VM</a>
          <a href="#/saved-vms">Saved VMs</a>
        </nav>

        <request-vm-page id="page-request-vm" style="display:block;"></request-vm-page>
        <saved-vms-page id="page-saved-vms" style="display:none;"></saved-vms-page>
      </main>
    `;

    const requestPage = this.querySelector('#page-request-vm');
    requestPage._agent = this._agent;
    requestPage._sessionHandle = this._sessionHandle;

    const savedPage = this.querySelector('#page-saved-vms');
    savedPage._agent = this._agent;

    this._switchPage();

    // Auto-start relay (generates keypair if needed, connects to xrpc.fedproxy.com)
    this._startRelay(requestPage);

    // Logout
    this.querySelector('#logout-btn').addEventListener('click', () => {
      this._oac.revoke(this._agent.did);
      window.location.reload();
    });
  }

  async _startRelay(requestPage) {
    const agent = this._agent;
    if (!agent) return;

    // Load or generate the relay keypair
    let kp = loadRelayKeypair();
    if (!kp) {
      kp = await generateRelayKeypair();
      log('info', 'relay', 'keypair:generated', { did: kp.did });
    } else {
      log('info', 'relay', 'keypair:loaded', { did: kp.did });
    }

    // Self-sign service-auth JWTs using the relay keypair's did:key.
    // The did:key encodes the public key — the dispatcher verifies the
    // ES256K signature directly from the did:key, no PDS needed.
    const serviceAuthMinter = async (lxm) => {
      try {
        return createServiceAuthJWT({
          privateKeyHex: kp.privateKeyHex,
          iss: kp.did, // did:key:z... (key encoded directly)
          aud: `did:web:${XRPC_DISPATCHER_HOST}`,
          lxm,
        });
      } catch (err) {
        log('error', 'relay', 'serviceAuth:failed', { lxm, error: String(err) });
        throw err;
      }
    };

    const adapter = createRelayKeypairAdapter(kp);
    const relay = new RelayClient({ keypair: adapter, serviceAuthMinter });

    relay.onStateChange = (status) => {
      log('info', 'relay', 'stateChange', { status, subdomain: relay.subdomain });
      requestPage._setRelay(relay);
    };

    relay.onBid = (bid) => {
      log('info', 'relay', 'bid:received', { rfpUri: bid.rfpUri });
      requestPage._onBid?.(bid);
    };

    try {
      await relay.start();
      log('info', 'relay', 'started', { subdomain: relay.subdomain, proxyRef: relay.proxyRef });

      // badgeBlueKeys association: prove the relay keypair belongs to the ATProto user
      try {
        await agent.com.atproto.repo.createRecord({
          repo: agent.did,
          collection: BADGE_BLUE_KEYS_NSID,
          record: {
            $type: BADGE_BLUE_KEYS_NSID,
            keyId: kp.did,
            challenge: agent.did,
            service: 'bidder_service',
            createdAt: new Date().toISOString(),
          },
        });
        log('info', 'relay', 'badgeBlueKeys:created', { keyId: kp.did, challenge: agent.did });
      } catch (err) {
        log('error', 'relay', 'badgeBlueKeys:failed', { error: String(err) });
      }
    } catch (err) {
      log('error', 'relay', 'start:failed', { error: String(err) });
    }

    requestPage._setRelay(relay);
  }
}

if (!customElements.get('compute-app')) {
  customElements.define('compute-app', ComputeApp);
}
