#!/usr/bin/env node
import path from "node:path";
import { createRegistryServer } from "./index.js";

function arg(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return dflt;
}

async function main(): Promise<void> {
  const port = Number(arg("--port", process.env.AGENTPACK_REGISTRY_PORT ?? "4873"));
  const dataDir = path.resolve(
    arg("--data", process.env.AGENTPACK_REGISTRY_DATA ?? path.join(process.cwd(), ".agentpack-data")),
  );
  const { port: bound } = await createRegistryServer({ port, dataDir });
  console.log(`agentpack registry listening on http://127.0.0.1:${bound} (data: ${dataDir})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
