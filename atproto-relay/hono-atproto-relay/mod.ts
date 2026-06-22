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

  const logger = createLogger({ serviceName: "hono-atproto-relay" });
  const factory = createRelayFactory({ hostname: options.hostname as string, log: logger });

  const serve = createServe({
    logger,
    tcp: { addr: options.hostname as string, port: options.port as number },
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
