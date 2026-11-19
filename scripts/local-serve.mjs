// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, compileModuleRules, convertV4MiniflareOptions, testRegExps } from "miniflare";

const RULES = [
  { type: "CompiledWasm", include: ["**/*.wasm"] },
  { type: "Text", include: ["**/*.glue.js", "*.css", "**/*.css", "**/*.dat"] },
  { type: "Data", include: ["**/*.woff2", "**/*.bin"] },
];

function modulesFrom(dist) {
  const modules = [{ type: "ESModule", path: resolve(dist, "index.js") }];
  const rules = compileModuleRules(RULES);
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (item.isDirectory()) walk(path);
      else {
        const name = relative(dist, path).replaceAll("\\", "/");
        const rule = rules.find((candidate) => testRegExps(candidate.include, name));
        if (rule) modules.push({ type: rule.type, path });
      }
    }
  };
  walk(dist);
  return modules;
}

/** @param {string} root @param {NodeJS.ProcessEnv} env @returns {Promise<Miniflare>} */
export async function startLocal(root = import.meta.dirname, env = process.env) {
  const port = Number(env.KITESURF_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("KITESURF_PORT must be an integer between 1 and 65535");
  const dist = resolve(root, "worker");
  const options = JSON.parse(readFileSync(resolve(dist, "engine-mf.json"), "utf8"));
  const bindings = { ...options.bindings };
  for (const key of Object.keys(bindings)) {
    if (env[key] !== undefined) bindings[key] = env[key];
  }
  bindings.KITESURF_ENV = "production";
  process.env.MINIFLARE_WORKERD_V8_FLAGS = env.MINIFLARE_WORKERD_V8_FLAGS ?? "--expose-gc";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: env.KITESURF_HOST ?? "127.0.0.1",
      port,
      inspectorPort: undefined,
      cf: false,
      liveReload: false,
      workers: [
        {
          ...options,
          name: "kitesurf",
          modulesRoot: dist,
          modules: modulesFrom(dist),
          bindings,
          assets: { ...options.assets, directory: resolve(root, "assets") },
        },
      ],
    }),
  );
  try {
    const url = await mf.ready;
    console.log(`[kitesurf] production engine ready on ${url.href}`);
  } catch (error) {
    await mf.dispose();
    throw error;
  }
  return mf;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const signals = ["SIGINT", "SIGTERM"];
  const previous = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
  const mf = await startLocal();
  // Miniflare's signal hooks exit synchronously. This entrypoint owns shutdown so disposal
  // finishes before Node exits; keep its exit hook as a fallback for other exits.
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!previous.get(signal).has(listener)) process.removeListener(signal, listener);
    }
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    try {
      await mf.dispose();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
