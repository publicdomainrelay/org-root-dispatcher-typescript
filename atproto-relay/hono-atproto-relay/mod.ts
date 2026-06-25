import { Command } from "@publicdomainrelay/cli-args-env";
import { createLogger } from "@publicdomainrelay/logger";
import { createServe } from "@publicdomainrelay/serve";
import { createRelayFactory } from "@publicdomainrelay/hono-factory-atproto-relay-xrpc";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

if (import.meta.main) {
  let runtimeConfig = null;
  try {
    const mod = await import("./config.json", { with: { type: "json" } });
    runtimeConfig = mod.default;
  } catch { /* optional */ }

  const { options } = await new Command(
    "CONFIG_PATH_HONO_ATPROTO_RELAY",
    cliArgsEnv,
    runtimeConfig,
  ).resolve();

  // ── local-dev: patch fetch + WebSocket so *.localhost resolves through ──
  // the did-key-relay dispatcher (needed when crawling local bidder PDSes).
  const localDevRelayPort = (options.localDevRelayPort as number | undefined) ?? 0;
  if (localDevRelayPort > 0) {
    const realFetch = globalThis.fetch;
    const downgradeLocal = (u: string): string => {
      if (u.includes(".localhost")) {
        return u
          .replace(/^https:\/\/([^/]+)\.localhost/, `http://$1.localhost:${localDevRelayPort}`)
          .replace(/^wss:\/\/([^/]+)\.localhost/, `ws://$1.localhost:${localDevRelayPort}`);
      }
      // Direct 127.0.0.1: downgrade HTTPS→HTTP (local PDS serves plain HTTP).
      return u
        .replace(/^https:\/\/(127\.0\.0\.1:\d+)/, "http://$1")
        .replace(/^wss:\/\/(127\.0\.0\.1:\d+)/, "ws://$1");
    };

    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      url = downgradeLocal(url);
      if (url !== (typeof input === "string" ? input : input instanceof URL ? input.href : input.url)) {
        return realFetch(new Request(url, input instanceof Request ? input : init));
      }
      return realFetch(input as string | URL | Request, init);
    }) as typeof fetch;

    const RealWS = globalThis.WebSocket;
    globalThis.WebSocket = class extends RealWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        let u = typeof url === "string" ? url : url.href;
        u = downgradeLocal(u);
        super(u, protocols);
      }
    } as typeof WebSocket;
  }

  const logger = createLogger({ serviceName: "hono-atproto-relay" });
  const factory = createRelayFactory({ hostname: options.hostname as string, log: logger });

  const port = options.port as number;
  const hostname = (options.hostname as string) || "127.0.0.1";
  const serve = createServe({
    logger,
    tcp: { addr: hostname, port },
  });
  serve.app.route("/", factory.app as never);

  function shutdown() {
    serve.shutdown();
    Deno.exit();
  }
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  await serve.beginServe();
}
