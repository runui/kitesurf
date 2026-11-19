// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Materialize only runtime dependencies from the lockfile-resolved Bazel npm tree. Internal
// relative links preserve multiple versions and cycles without depending on Bazel's runfiles.
function copyRuntime(engineDir, out) {
  const copied = new Map();
  const link = (name, from, targetModules, optional = false) => {
    const req = createRequire(join(from, "package.json"));
    const manifest = req.resolve
      .paths(name)
      .map((path) => join(path, name, "package.json"))
      .find((path) => existsSync(path));
    if (!manifest) {
      if (optional) return;
      throw new Error(`Missing runtime dependency ${name} from ${from}`);
    }
    const source = dirname(realpathSync(manifest));
    let target = copied.get(source);
    if (!target) {
      target = join(out, "node_modules/.store", String(copied.size), "package");
      copied.set(source, target);
      cpSync(source, target, {
        recursive: true,
        dereference: true,
        filter: (path) => path !== join(source, "node_modules"),
      });
      chmodSync(target, 0o755);
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      for (const dependency of Object.keys(pkg.dependencies ?? {}))
        link(dependency, source, join(target, "node_modules"));
      for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
        if (!pkg.dependencies?.[dependency])
          link(dependency, source, join(target, "node_modules"), true);
      }
    }
    const destination = join(targetModules, name);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(relative(dirname(destination), target), destination, "dir");
  };
  link("miniflare", engineDir, join(out, "node_modules"));
  return copied.size;
}

function copyAssets(source, target) {
  if (statSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyAssets(join(source, name), join(target, name));
  } else {
    copyFileSync(source, target);
    chmodSync(target, 0o644);
  }
}

/** @param {string} engineDir @param {string} out @returns {number} */
export function stageLocal(engineDir, out) {
  if (existsSync(out) && readdirSync(out).length > 0)
    throw new Error(`Output directory must be empty: ${out}`);
  mkdirSync(out, { recursive: true });
  copyAssets(join(engineDir, "dist"), join(out, "worker"));
  copyAssets(join(engineDir, "public"), join(out, "assets"));
  const configPath = join(out, "worker/engine-mf.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.bindings.KITESURF_ENV = "production";
  config.bindings.KITESURF_INSPECTOR_FALLBACK_URL = "";
  if (existsSync(join(out, "assets/inspector/inspector.html")))
    config.bindings.KITESURF_INSPECTOR_BASE_URL = "/inspector/inspector.html";
  config.assets.directory = "../assets";
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  copyFileSync(join(import.meta.dirname, "local-serve.mjs"), join(out, "start.mjs"));
  copyFileSync(join(import.meta.dirname, "kitesurf.service"), join(out, "kitesurf.service"));
  copyFileSync(join(engineDir, "../../LICENSE"), join(out, "LICENSE"));
  copyFileSync(join(engineDir, "../../NOTICE"), join(out, "NOTICE"));
  copyAssets(join(engineDir, "../../licenses"), join(out, "licenses"));
  writeFileSync(
    join(out, "package.json"),
    JSON.stringify(
      {
        name: "kitesurf-local",
        private: true,
        type: "module",
        engines: { node: ">=22" },
        scripts: { start: "node start.mjs" },
        os: [process.platform],
        cpu: [process.arch],
      },
      null,
      2,
    ) + "\n",
  );
  return copyRuntime(engineDir, out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out")
    throw new Error("usage: bazel run //packages/engine:local_build -- --out <empty-directory>");
  const workspace = process.env.BUILD_WORKSPACE_DIRECTORY ?? process.cwd();
  const out = resolve(workspace, args[1]);
  const count = stageLocal(resolve(import.meta.dirname, "../packages/engine"), out);
  console.log(
    `[local-build] staged ${out} with ${count} runtime packages (${process.platform}/${process.arch})`,
  );
  console.log(`[local-build] start with: node ${join(out, "start.mjs")}`);
}
