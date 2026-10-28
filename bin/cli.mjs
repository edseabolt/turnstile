#!/usr/bin/env node
// Thin argv router for the opencode-turnstile package. Maps the five
// subcommands onto the installer scripts (spawned, not imported, so each
// keeps its own process.exit and stdio) or prints the package version. Paths
// are resolved against this file, not cwd, so `npx opencode-turnstile` works
// from any directory.
//
//   opencode-turnstile init       Install/sync artifacts into ~/.config/opencode
//   opencode-turnstile check      Verify artifacts against the manifest
//   opencode-turnstile uninstall  Remove installed artifacts (manifest artifacts)
//   opencode-turnstile status     Report gate/plan state from the JSONL journal
//   opencode-turnstile evidence   Emit a shareable evidence summary for one task
//   opencode-turnstile version    Print the installed package version
//
// `init -- --print-model-config` writes nothing: the router runs install.mjs,
// which prints the snippet and short-circuits before any install work, so the
// router returns install.mjs's exit code verbatim.
//
// Unknown subcommand or no args prints usage and exits 2.

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const installScript = join(repoRoot, "scripts/install.mjs")
const statusScript = join(repoRoot, "scripts/status.mjs")
const evidenceScript = join(repoRoot, "scripts/evidence.mjs")

const USAGE = `Usage: opencode-turnstile <command>

Commands:
  init      Install or sync artifacts into ~/.config/opencode
            (with --print-model-config, prints a {"agents": {...}} snippet and writes nothing)
  check     Verify installed artifacts against the manifest
            (check --repair prints which targets would be auto-repaired,
             writing nothing — a dry run of the --repair apply mode)
  uninstall Remove installed artifacts (manifest artifacts)
  status    Report per-session gate/plan state from the journal
            (status --json prints machine-readable JSON; read-only; --check-updates
             writes a 24h cache file)
            (status --check-updates checks npm for a newer turnstile; network, cached)
  evidence  Emit a shareable evidence summary for one task (read-only, nothing is written)
             (evidence --task <session|latest> --format json|markdown [--out <path>]
              evidence --validate <path>   re-check a committed artifact, write nothing)
  version   Print the installed package version

init also accepts convenience flags (passthrough to scripts/install.mjs); separate them from the subcommand with a leading "--":
  init -- --print-model-config [--model [name=]provider/model[#variant]] [--validate]

  --print-model-config  Print a {"agents": {...}} model snippet, write nothing
  --model               Seed an agent (repeatable); ids may be multi-segment, e.g. oMLX/oQ/GLM-5.3-Flash-oQ4-mtp
  --validate            Check concrete specs against "opencode models"
                        (--model/--validate require --print-model-config, else exit 2)

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
      // Full install: manifest artifacts (plugin + agents) via a single
      // install.mjs spawn. This installer never writes to AGENTS.md — the
      // legacy contract-block installer was deleted (R1); any pre-existing
      // block is removed by hand by the user, not by npm/init.
      //
      // Printer-mode short-circuit: --print-model-config makes init write
      // completely free. install.mjs prints the snippet and short-circuits
      // before any manifest work, so the router returns install.mjs's exit
      // code verbatim. This is what makes "print mode writes nothing"
      // literally true.
      //
      // A leading "--" separates the subcommand from its flags
      // (`init -- --print-model-config`); install.mjs rejects a literal "--"
      // as an unknown argument, so drop it before forwarding.
      const initPassthrough = passthrough[0] === "--" ? passthrough.slice(1) : passthrough
      return process.exit(await spawnInstaller(installScript, initPassthrough))
    }
    case "check":
      return spawnInstaller(installScript, ["--check", ...passthrough])
    case "uninstall": {
      // Reverse the copy/symlink install via a single install.mjs spawn.
      // Inherited stdio surfaces the report verbatim; exit non-zero only if
      // it failed. No restart note is printed here; the child prints its own,
      // gated on whether it changed anything.
      const byInstall = await spawnInstaller(installScript, ["--uninstall"])
      return process.exit(byInstall ? 1 : 0)
    }
    case "version":
      console.log(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version)
      return
    case "status": {
      // Read-only status surface over the JSONL journal: spawn scripts/status.mjs
      // with passthrough args (mirrors the init case's leading-"--" stripping).
      const statusPassthrough = passthrough[0] === "--" ? passthrough.slice(1) : passthrough
      return process.exit(await spawnInstaller(statusScript, statusPassthrough))
    }
    case "evidence": {
      // Read-only evidence surface: a shareable summary of one task's journaled
      // evidence (spawn scripts/evidence.mjs with passthrough args, same
      // leading-"--" strip as the status case).
      const evidencePassthrough = passthrough[0] === "--" ? passthrough.slice(1) : passthrough
      return process.exit(await spawnInstaller(evidenceScript, evidencePassthrough))
    }
    default:
      console.log(USAGE)
      process.exit(2)
  }
}

await main().then((code) => process.exit(code ?? 0))
