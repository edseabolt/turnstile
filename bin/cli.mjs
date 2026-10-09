#!/usr/bin/env node
// Thin argv router for the opencode-turnstile package. Maps the four
// subcommands onto the installer script (spawned, not imported, so it keeps
// its own process.exit and stdio) or prints the package version. Paths are
// resolved against this file, not cwd, so `npx opencode-turnstile` works
// from any directory.
//
//   opencode-turnstile init       Install/sync artifacts into ~/.config/opencode
//   opencode-turnstile check      Verify artifacts against the manifest
//   opencode-turnstile uninstall  Remove installed artifacts (not yet implemented)
//   opencode-turnstile version    Print the installed package version
//
// Unknown subcommand or no args prints usage and exits 2.

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const installScript = join(repoRoot, "scripts/install.mjs")

const USAGE = `Usage: opencode-turnstile <command>

Commands:
  init      Install or sync artifacts into ~/.config/opencode
  check     Verify installed artifacts against the manifest
  uninstall Remove installed artifacts (not yet implemented)
  version   Print the installed package version

A git checkout installs by linking (live edits); a package install copies.`

/**
 * Spawns the installer script with inherited stdio and resolves with its
 * exit code so this router returns the child's status verbatim.
 * @param {string[]} passthrough Arguments forwarded to the installer.
 * @returns {Promise<number>} The child's exit code.
 */
function runInstaller(passthrough) {
  return new Promise((resolveChild) => {
    const child = spawn(process.execPath, [installScript, ...passthrough], {
      stdio: "inherit",
    })
    child.on("error", () => resolveChild(1))
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal)
      resolveChild(code ?? 0)
    })
  })
}

async function main() {
  const [command, ...passthrough] = process.argv.slice(2)

  switch (command) {
    case "init":
      return runInstaller(passthrough)
    case "check":
      return runInstaller(["--check", ...passthrough])
    case "uninstall":
      console.log("uninstall: not yet implemented (chunk-3)")
      return process.exit(1)
    case "version":
      console.log(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version)
      return
    default:
      console.log(USAGE)
      process.exit(2)
  }
}

await main().then((code) => process.exit(code ?? 0))
