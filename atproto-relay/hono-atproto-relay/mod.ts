import { Command } from "@publicdomainrelay/cli-args-env";
import { createLogger, type LoggerInterface } from "@publicdomainrelay/logger";
import { createRelayFactory } from "@publicdomainrelay/hono-factory-atproto-relay-xrpc";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

const defaultLog = createLogger("hono-atproto-relay");

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

  const lg = defaultLog;
  const factory = createRelayFactory({ hostname: options.hostname as string, log: lg });

  Deno.serve(
    {
      port: options.port as number,
      hostname: options.hostname as string,
      onListen: () => lg.info("listening", { port: options.port as number }),
    },
    factory.app.fetch,
  );
}
