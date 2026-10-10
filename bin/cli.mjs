#!/usr/bin/env node
// Thin argv router for the opencode-turnstile package. Maps the four
// subcommands onto the installer scripts (spawned, not imported, so each
// keeps its own process.exit and stdio) or prints the package version. Paths
// are resolved against this file, not cwd, so `npx opencode-turnstile` works
// from any directory.
//
//   opencode-turnstile init       Install/sync artifacts into ~/.config/opencode
//   opencode-turnstile check      Verify artifacts against the manifest
//   opencode-turnstile uninstall  Remove installed artifacts (agents + block)
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
const agentsScript = join(repoRoot, "scripts/install-agents.mjs")

const USAGE = `Usage: opencode-turnstile <command>

Commands:
  init      Install or sync artifacts into ~/.config/opencode
  check     Verify installed artifacts against the manifest
  uninstall Remove installed artifacts (agents + block)
  version   Print the installed package version

A git checkout installs by linking (live edits); a package install copies.`

/**
 * Spawns an installer script with inherited stdio and resolves with its exit
 * code so this router returns the child's status verbatim.
 * @param {string} script Absolute path to the script to run.
 * @param {string[]} passthrough Arguments forwarded to the installer.
 * @returns {Promise<number>} The child's exit code.
 */
function spawnInstaller(script, passthrough) {
  return new Promise((resolveChild) => {
    const child = spawn(process.execPath, [script, ...passthrough], { stdio: "inherit" })
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
    case "init": {
      // Full install: manifest artifacts (plugin + agents), then the
      // managed contract block in ~/.config/opencode/AGENTS.md — mirrors
      // uninstall's two-step shape in reverse. Passthrough flags go to the
      // manifest installer; the agents installer needs none of them.
      const byInstall = await spawnInstaller(installScript, passthrough)
      const byAgents = await spawnInstaller(agentsScript, [])
      return process.exit(byInstall || byAgents ? 1 : 0)
    }
    case "check":
      return spawnInstaller(installScript, ["--check", ...passthrough])
    case "uninstall": {
      // Reverse the copy/symlink install, then unmerge the managed block.
      // Inherited stdio surfaces both scripts' reports verbatim; exit non-zero
      // only if either step failed. No restart note is printed here — each
      // child prints its own, gated on whether it changed anything.
      const byInstall = await spawnInstaller(installScript, ["--uninstall"])
      const byAgents = await spawnInstaller(agentsScript, ["--remove"])
      return process.exit(byInstall || byAgents ? 1 : 0)
    }
    case "version":
      console.log(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version)
      return
    default:
      console.log(USAGE)
      process.exit(2)
  }
}

await main().then((code) => process.exit(code ?? 0))
