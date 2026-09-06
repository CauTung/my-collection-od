/** Start the single React Router server bundle produced by standard or Vercel builds. */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDirectory = join(projectDirectory, "build", "server");
const serverBuilds = findServerBuilds(serverDirectory);

if (serverBuilds.length !== 1) {
  throw new Error(`Expected exactly one React Router server build, found ${serverBuilds.length}`);
}

const servePackage = fileURLToPath(import.meta.resolve("@react-router/serve/package.json"));
const serveCli = join(dirname(servePackage), "bin.js");
const child = spawn(process.execPath, [serveCli, serverBuilds[0]], {
  cwd: projectDirectory,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

function findServerBuilds(directory) {
  if (!existsSync(directory)) return [];
  const builds = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) builds.push(...findServerBuilds(entryPath));
    else if (entry.isFile() && entry.name === "index.js") builds.push(entryPath);
  }
  return builds;
}
