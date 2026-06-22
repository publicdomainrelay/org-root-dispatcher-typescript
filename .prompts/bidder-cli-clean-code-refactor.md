/*
/plan Make a plan to do development work given the following as input:

The following is generally what we want atproto-market/hono-bidder/mod.ts to
look like when we are done with a refactor of how CLIs across the org-repo/polyrepo
codebase. Other CLIs which share / use similar concepts should be made to look
like this.

Analyze it to find which the pattenrns you see, then read the current file
contents and contents of all files that are relavent to this refactor and see
what needs to be changed and update CLAUDE.md with the patterns
we want to adhear to and the patterns we want to avoid.

Do the refactor.

---
*/

// serviceName should default to "bidder", that way a server that runs multiple
// bidders when logs are aggrigated would see "bidder-compute-provider-local"
// and "bidder-compute-provider-deno-worker" in jouranctl (if they are run via
// systemd for example).
const logger await createLogger({ serviceName: opts.serviceName });

async function cliCreateXrpcRelay() {
  return await createXrpcRelay({
    logger,
    host: opts.relayDispatcherHost,
  });
}


let atprotoAgent = null;
if (opts.atprotoHandle && opts.atprotoPassword) {
  atprotoAgent = new Agent(...);
} else {
  atprotoAgent = new LocalPDSAgent({
    logger,
    serve: await createServe({
      relays: [xrpcRelay],
    }),
  });
  // If we are running a PDS then we need to serve it
  await atprotoAgent.beginServe();
}

const atproto = await createATProto({
  logger,
  badgeBlueSigner: createBadgeBlueSigner({ privateKeyHex }),
  plcDirectory: createPlcDirectoryClient({ plcDirectoryUrl }),
  agent: atprotoAgent,
});


const computeProviders = {};

if (opts.computeProviderDigitalOceanToken) {
  const relay = await cliCreateXrpcRelay();
  providers.push(
    await createComputeProviderMarketBidderHooks({
      provider: await createComputeProviderDigitalOcean({
        logger,
        serve: await createServe({
          relays: [relay],
        }),
        getIssuerUrl: () => didWebToHttps(relay.proxyRef),
        digitaloceanBaseUrl: opts.computeProviderDigitalOceanBaseUrl || "https://api.digitalocean.com",
        doToken: opts.computeProviderDigitalOceanToken,
        // TODO we shouldn't need to pass this, it should always default to this
        // unless overriden and most likely we don't want to override it
        acceptPathVm: "/root/secrets/publicdomainrelay.com/market/accept.json",
        // TODO Isn't parseAtUri a function that can just be imported? We shouldn't
        // have to pass it... get rid of passing it or if we really need to pass it
        // in have it just be a method on the atproto object so we can just pass
        // that
        parseAtUri,
        // TODO Probably just pass atproto instance directly instead of object
        // wrappoing it like this
        atproto: {
          getAgentDid: () => atproto.getAgentDid,
          createRecord: atproto.createRecord,
          deleteRecord: atproto.deleteRecord,
        },
      }),
    }),
  )
}

if (opts.computeProviderLocal) {
  const relay = await cliCreateXrpcRelay();
  // TODO oidcIssuer should be created and mounted within both DigitalOcean and
  // Local compute providers as they both require them. DigitalOcean upstream
  // doesn't provider workload ID so we're bolting it on (same for Local), so we
  // always need to serve a relay that can provide us with an issuerUrl we use.
  /*
   * const oidcIssuer = createHonoFactoryOidcIssuer({
   *   logger,
   *   getIssuerUrl: () => didWebToHttps(relay.proxyRef),
   *   serviceUrl: didWebToHttps(relay.proxyRef),
   * });
   * oidcIssuer.mount(app)
   *
   * relay.onServe(() => {
   *   log("info", "oidc issuer mounted", { didWebToHttps(relay.proxyRef) });
   * });
   */

  // NOTE I like this, this looks clean:
  providers.push(
    await createComputeProviderMarketBidderHooks({
      provider: await createComputeProviderLocal({
        logger,
        atproto,
        serve: await createServe({
          relays: [relay],
        }),
        getIssuerUrl: () => didWebToHttps(relay.proxyRef),
        containerMode: opts.computeProviderLocalContainerMode,
        vmImage: opts.computeProviderLocalVMImage,
        containerImage: opts.computeProviderLocalContainerImage,
        cacheDir: opts.computeProviderLocalCacheDir,
      }),
    }),
  )
}

if (opts.computeProviderDenoWorker) {
  providers.push(
    await createComputeProviderMarketBidderHooks({
      provider: await createComputeProviderDenoWoker({
        logger,
        atproto,
        serve: await createServe({
          relays: [relay],
        }),
        // NOTE the deno worker bundler is a seperate service from the runner and
        // the bidder should only be responsible for creating worker manifest
        // instances and registering them with the runner
        // TODO whatever other arguements are logical here given our new level of
        // abstraction
      }),
    }),
  )
}

let relays = [];

if (!opts.noXrpcRelay) {
  relays.push(await cliCreateXrpcRelay());
}

const bidder = await createMarketBidder({
  logger,
  serve: await createServe({
    logger,
    // if opts.servePort != -1 then this should trigger serving hono app on port
    addr: opts.serveAddr,
    port: opts.servePort,
    // if opts.serveUnix socket path is given then this should trigger serving hono app on port
    unixSocket: opts.serveUnix,
    // List of relays which serve the app.fetch without listen related syscalls
    // under the hood, ideal for use in browser
    relays,
  }),
  // TODO We should really just be able to pass `providers` and have all this
  // this just happen. make this happen, wire through write abstractions as
  // nessicary
  setup: async (deps) => {
    for (let provider of providers) {
      if (provider?.setup) {
        await provider.setup();
        log("info", "bidder provider setup done", { provider: provider, deps: deps });
      }
    }
  },
  teardown: async (deps) => {
    for (let provider of providers) {
      if (provider?.teardown) {
        await provider.teardown();
        log("info", "bidder provider teardown done", { provider: provider, deps: deps });
      }
    }
  },
  callbackFactory: async (deps) => {
    const callbacks: CallbackSet = {};

    for (let provider of providers) {
      // TODO Convert from psudocode
      callbacks.setdefault(provider.serviceId, {})
      callbacks[provider.serviceId].update(provider.callbacksByNSID)
    }

    return callbacks;
  },
});


// beginServe() should return from Promise after all relays have proxyRefs and
// started, setup() might need to know what the issuerUrls are based on the
// proxyRefs (pass via deps)
await bidder.beginServe();

// TODO Time await loop forever to let serves happen
