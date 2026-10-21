/**
 * @fileoverview Shared spawn-under-temp-HOME harness for the installer CLI
 * tests (install-mode, install-apply, install-uninstall). Every spawn pins
 * the child's `HOME` to a temp scratch dir, so the installer's ~-expansion
 * keeps every link/copy/ledger write inside that dir and a real
 * ~/.config/opencode is never touched. The harness never mutates
 * process.env in the parent process: only spawned children inherit the
 * temp HOME. The repo root is derived the same way install.mjs does, so
 * symlink-target comparisons in tests key off the same checkout.
 */

import { spawnSync } from "node:child_process"
import type { SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { TestContext } from "node:test"

/** The repo root, derived from this file's location like install.mjs does. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** One copy-mode ledger record, keyed by the expanded destination path. */
export interface LedgerRecord {
  src: string
  hash: string
  version: string | null
  mode: "link" | "copy"
}

/** A copy-mode ownership ledger keyed by expanded destination. */
export type Ledger = Record<string, LedgerRecord>

/**
 * Creates a fresh temp scratch dir, registers its removal on the test's
 * after hook, and returns its path. Use the returned dir for the temp HOME
 * and for every file the test needs (manifests, seeded ledgers, fixtures).
 * @param {TestContext} t The node:test context of the calling test.
 * @returns {string} Absolute path of the new scratch dir.
 */
export function freshScratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "turnstile-install-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Writes a manifest object as install.json inside the given dir and returns
 * its path. The manifest is passed through verbatim (`mode`, `links`,
 * `retired`, `ledger` overrides, etc.); src values are repo-relative and
 * dest values use ~, which the installer expands under the spawned child's
 * temp HOME.
 * @param {string} dir Scratch dir to write the manifest into.
 * @param {Record<string, unknown>} manifest The manifest content as an object.
 * @returns {string} Absolute path of the written manifest.
 */
export function writeManifest(dir: string, manifest: Record<string, unknown>): string {
  const file = join(dir, "install.json")
  writeFileSync(file, JSON.stringify(manifest, null, 2))
  return file
}

/**
 * Writes a single-entry manifest with the ledger pinned to a scratch path
 * directly under the temp HOME, and returns the manifest path.
 * @param {string} home The temp HOME (scratch dir) to write the manifest into.
 * @param {"link" | "copy"} mode The install mode for the manifest.
 * @param {string} src Repo-relative source path.
 * @param {string} dest ~-prefixed destination path.
 * @returns {string} Absolute path of the written manifest.
 */
export function singleEntryManifest(
  home: string,
  mode: "link" | "copy",
  src: string,
  dest: string,
): string {
  return writeManifest(home, { mode, ledger: "~/ledger.json", links: [{ src, dest }] })
}

/**
 * Spawns scripts/install.mjs with the given args and the child's HOME pinned
 * to a temp dir. The parent process env is never mutated.
 * @param {string[]} args CLI args for the installer (e.g. ["--manifest", path, "--check"]).
 * @param {{ home: string }} options The temp HOME to pin in the child env.
 * @returns {SpawnSyncReturns<string>} The spawn result with utf8 stdout/stderr.
 */
export function spawnInstaller(
  args: string[],
  { home }: { home: string },
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(repoRoot, "scripts/install.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  })
}

/**
 * Joins path segments onto a temp HOME, mirroring the installer's
 * ~-expansion so tests can recompute the paths a spawn wrote.
 * @param {string} home The temp HOME dir.
 * @param {string[]} segs Path segments below the HOME.
 * @returns {string} The joined absolute path.
 */
export function homePath(home: string, ...segs: string[]): string {
  return join(home, ...segs)
}

/**
 * Reads and parses the JSON ledger file at the given path.
 * @param {string} file Ledger path.
 * @returns {Ledger | null} The parsed ledger, or null when the file is absent.
 */
export function readLedger(file: string): Ledger | null {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, "utf8")) as Ledger
}
