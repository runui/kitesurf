// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { stageLocal } from "./local-build.mjs";

test(
  "local releases run through a symlink after relocation with the pinned runtime",
  { timeout: 120_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "kitesurf-release-test-"));
    const engine = join(root, "source/packages/engine");
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(engine, "dist"), { recursive: true });
    mkdirSync(join(engine, "public"));
    mkdirSync(join(engine, "node_modules"));
    writeFileSync(join(engine, "package.json"), "{}");
    writeFileSync(join(root, "source/LICENSE"), "release license");
    writeFileSync(join(root, "source/NOTICE"), "release notice");
    mkdirSync(join(root, "source/licenses"));
    const require = createRequire(resolve(import.meta.dirname, "../packages/engine/package.json"));
    symlinkSync(
      dirname(require.resolve("miniflare/package.json")),
      join(engine, "node_modules/miniflare"),
      "dir",
    );
    writeFileSync(
      join(engine, "dist/engine-mf.json"),
      JSON.stringify({
        compatibilityDate: "2026-09-11",
        bindings: {
          KITESURF_ENV: "local",
          KITESURF_VERSION: "test",
          KITESURF_INSPECTOR_FALLBACK_URL: "",
        },
        workerLoaders: { LOADER: {} },
        assets: {
          directory: "../public",
          binding: "FONT_ASSETS",
          routerConfig: { has_user_worker: true },
        },
      }),
    );
    writeFileSync(
      join(engine, "dist/index.js"),
      `export default {
    async fetch(request, env) {
      const child = env.LOADER.load({ compatibilityDate: "2026-09-11", mainModule: "main.js",
        modules: { "main.js": { js: 'export default { fetch() { return new Response("loaded") } }' } } });
      const response = await child.getEntrypoint().fetch(request);
      return new Response(JSON.stringify({ env: env.KITESURF_ENV, version: env.KITESURF_VERSION,
        gc: typeof globalThis.gc, child: await response.text() }));
    }
  };`,
    );
    const staged = join(root, "release");
    assert.ok(stageLocal(engine, staged) > 1);
    assert.throws(() => stageLocal(engine, staged), /must be empty/);
    const moved = join(root, "relocated");
    renameSync(staged, moved);
    const current = join(root, "current");
    symlinkSync("relocated", current, "dir");
    rmSync(join(root, "source"), { recursive: true });
    assert.equal(readFileSync(join(moved, "LICENSE"), "utf8"), "release license");
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    server.close();
    await once(server, "close");
    child = spawn(process.execPath, [join(current, "start.mjs")], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        KITESURF_PORT: String(port),
        KITESURF_ENV: "local",
        KITESURF_VERSION: "override",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((ready, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`release exited ${code}: ${output}`)));
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("production engine ready on")) ready();
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      env: "production",
      version: "override",
      gc: "function",
      child: "loaded",
    });
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
  },
);
