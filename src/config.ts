/**
 * @fileoverview Config boundary: layered configuration for the plugin.
 * Precedence: code defaults ⊕ JSON config file ⊕ environment variables ⊕
 * injected overrides (tests). Config is read once at setup; restart
 * sessions to apply. Invalid keys are ignored and journaled to the
 * env-resolved metrics directory (the journaler does not exist until
 * config resolves): config errors never crash the host, per the fail-open
 * contract.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { appendLine, defaultMetricsDir } from "./journal.ts"
import { GATE_RE, VERDICT_RE } from "./markers.ts"
import type { TurnstileConfig } from "./types.ts"

/** Default config file location. */
export const CONFIG_PATH: string = path.join(os.homedir(), ".config", "opencode", "turnstile.json")

/** Environment variable names honored by the env layer. */
export const ENV_KEYS = {
  trace: "TURNSTILE_TRACE",
  metricsDir: "TURNSTILE_METRICS_DIR",
  config: "TURNSTILE_CONFIG",
} as const

/**
 * Builds the code defaults for every config key.
 * @param env Environment consulted for XDG_DATA_HOME only.
 * @returns The default TurnstileConfig (byte-equivalent to the historical
 *     hardcoded constants).
 */
export function defaultConfig(
  env: Record<string, string | undefined> = process.env,
): TurnstileConfig {
  return {
    metricsDir: defaultMetricsDir(env),
    journalMaxBytes: 5 * 1024 * 1024,
    journalMaxGenerations: 5,
    maxReviewerRounds: 2,
    maxSessions: 64,
    readWarn: 8,
    readBlock: 15,
    waiverMarker: "USER WAIVER:",
    plansDir: path.join(".opencode", "plans"),
    trace: true,
    agents: {
      reviewer: "reviewer",
      planReviewer: "plan-reviewer",
      executor: "executor",
      testRunner: "test-runner",
      debugger: "debugger",
      bareOutput: ["test-runner", "reviewer", "plan-reviewer"],
    },
    gateMarker: GATE_RE.source,
    verdictMarker: VERDICT_RE.source,
  }
}

/**
 * Validates a patch value for a scalar key.
 * @param key Config key being set.
 * @param value Candidate value.
 * @returns true when the value has the right type for the key.
 */
function isValidScalar(key: keyof TurnstileConfig, value: unknown): boolean {
  if (key === "trace") return typeof value === "boolean"
  if (key === "metricsDir" || key === "waiverMarker" || key === "plansDir") {
    return typeof value === "string" && value.trim().length > 0
  }
  if (key === "gateMarker" || key === "verdictMarker") return typeof value === "string"
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/** Scalar config keys whose valid values are finite positive numbers. */
type NumericConfigKey = Extract<
  keyof TurnstileConfig,
  | "journalMaxBytes"
  | "journalMaxGenerations"
  | "maxReviewerRounds"
  | "maxSessions"
  | "readWarn"
  | "readBlock"
>

/**
 * Assigns a validated scalar into the config without erasing the key→type
 * correlation the validator just established.
 * @param config The config to mutate.
 * @param key The validated config key.
 * @param value The validated value.
 */
function assignScalar(config: TurnstileConfig, key: keyof TurnstileConfig, value: unknown): void {
  if (key === "trace") config.trace = value as boolean
  else if (key === "metricsDir") config.metricsDir = value as string
  else if (key === "waiverMarker") config.waiverMarker = value as string
  else if (key === "plansDir") config.plansDir = value as string
  else if (key === "gateMarker") config.gateMarker = value as string
  else if (key === "verdictMarker") config.verdictMarker = value as string
  else config[key as NumericConfigKey] = value as number
}

/**
 * Merges a patch into a base config with per-key validation. Unknown keys
 * and wrongly-typed values are skipped and reported as warnings; the
 * `agents` sub-object merges one level deep.
 * @param base The config to merge into.
 * @param patch Candidate overrides (typically parsed JSON or injected opts).
 * @returns The merged config plus one warning string per skipped key.
 */
export function mergeConfig(
  base: TurnstileConfig,
  patch: unknown,
): { config: TurnstileConfig; warnings: string[] } {
  const warnings: string[] = []
  const config: TurnstileConfig = { ...base, agents: { ...base.agents } }
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    if (patch !== undefined) {
      warnings.push(
        `config: expected an object, got ${Array.isArray(patch) ? "array" : typeof patch}`,
      )
    }
    return { config, warnings }
  }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === "agents") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        warnings.push(`config: agents must be an object; keeping defaults`)
        continue
      }
      for (const [agentKey, agentValue] of Object.entries(value as Record<string, unknown>)) {
        if (agentKey === "bareOutput") {
          if (
            Array.isArray(agentValue) &&
            agentValue.every((v) => typeof v === "string" && v.trim().length > 0)
          ) {
            // Copy: a mutated injected options object must not retro-mutate
            // the live config.
            config.agents.bareOutput = [...(agentValue as string[])]
          } else {
            warnings.push(
              `config: agents.bareOutput must be an array of non-empty strings; keeping default`,
            )
          }
          continue
        }
        if (!(agentKey in config.agents)) {
          warnings.push(`config: unknown agents key "${agentKey}" ignored`)
          continue
        }
        if (typeof agentValue === "string" && agentValue.trim().length > 0) {
          const name = agentKey as
            "reviewer" | "planReviewer" | "executor" | "testRunner" | "debugger"
          config.agents[name] = agentValue
        } else {
          warnings.push(`config: agents.${agentKey} must be a non-empty string; keeping default`)
        }
      }
      continue
    }
    if (!(key in config)) {
      warnings.push(`config: unknown key "${key}" ignored`)
      continue
    }
    if (isValidScalar(key as keyof TurnstileConfig, value)) {
      assignScalar(config, key as keyof TurnstileConfig, value)
    } else {
      warnings.push(`config: invalid value for "${key}"; keeping default`)
    }
  }
  return { config, warnings }
}

/**
 * Journals a config warning to the env-resolved metrics directory. Used
 * only for problems detected before the real journaler exists, so the
 * sink honors the caller's injected env (tests stay off the user journal).
 * @param error The warning/error text.
 * @param env Environment providing TURNSTILE_METRICS_DIR / XDG_DATA_HOME.
 */
function journalConfigError(error: string, env: Record<string, string | undefined>): void {
  const metricsDir =
    env[ENV_KEYS.metricsDir] ??
    process.env[ENV_KEYS.metricsDir] ??
    defaultMetricsDir({ ...process.env, ...env })
  appendLine(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), type: "error", error }),
  )
}

/**
 * Reads and parses the JSON config file, returning a patch object.
 * @param env Environment providing the config path override.
 * @returns The parsed patch (or undefined) plus any warning.
 */
function readFileLayer(env: Record<string, string | undefined>): {
  patch: unknown
  warnings: string[]
} {
  const configPath = env[ENV_KEYS.config] ?? CONFIG_PATH
  try {
    return { patch: JSON.parse(fs.readFileSync(configPath, "utf8")), warnings: [] }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { patch: undefined, warnings: [] }
    const warning =
      code === "EISDIR"
        ? `config file ${configPath} is a directory; ignored`
        : `config file ${configPath} unreadable/malformed: ${e}`
    journalConfigError(warning, env)
    return { patch: undefined, warnings: [warning] }
  }
}

/**
 * Applies the env layer on top of a merged config.
 * @param config The config to mutate.
 * @param env The environment to read.
 * @returns One warning string per invalid env value.
 */
function applyEnvLayer(config: TurnstileConfig, env: Record<string, string | undefined>): string[] {
  const warnings: string[] = []
  const trace = env[ENV_KEYS.trace]
  if (trace !== undefined) {
    if (trace === "0" || trace === "false") config.trace = false
    else if (trace === "1" || trace === "true") config.trace = true
    else
      warnings.push(
        `env ${ENV_KEYS.trace}=${trace} invalid (use 0/1/true/false); keeping current value`,
      )
  }
  const metricsDir = env[ENV_KEYS.metricsDir]
  if (metricsDir !== undefined) {
    if (metricsDir.trim().length > 0) config.metricsDir = metricsDir
    else warnings.push(`env ${ENV_KEYS.metricsDir} empty; keeping current value`)
  }
  return warnings
}

/**
 * Resolves the full layered configuration: defaults ⊕ config file ⊕ env ⊕
 * injected overrides. Config-file and validation problems are journaled to
 * the default metrics directory and returned as warnings, never thrown.
 * @param env Environment providing XDG_DATA_HOME, TURNSTILE_* variables.
 * @param overrides Final-layer overrides (injected options; tests).
 * @returns The resolved config plus one warning string per skipped/invalid
 *     key or file problem.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides?: Partial<TurnstileConfig>,
): { config: TurnstileConfig; warnings: string[] } {
  const warnings: string[] = []
  const fileLayer = readFileLayer(env)
  const fileMerge = mergeConfig(defaultConfig(env), fileLayer.patch)
  const config = fileMerge.config
  warnings.push(...fileLayer.warnings, ...fileMerge.warnings)
  warnings.push(...applyEnvLayer(config, env))
  let resolved = config
  if (overrides !== undefined) {
    const merged = mergeConfig(config, overrides)
    resolved = merged.config
    warnings.push(...merged.warnings)
  }
  for (const warning of warnings) {
    if (!warning.startsWith("config file")) journalConfigError(warning, env)
  }
  return { config: resolved, warnings }
}
