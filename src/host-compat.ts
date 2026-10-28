/**
 * @fileoverview Host-compatibility boundary: decides whether the running
 * OpenCode host is one turnstile enforces on. Pure semver parse/compare plus
 * a shipped compat-range constant and a verdict evaluator producing the
 * toast/journal message. Nothing else lives here; only `src/setup.ts` and the
 * tests import from this module, and it depends on nothing but its own types.
 */

/** Shipped compatibility range — the single source of truth; the README
 * matrix mirrors it and is updated in the same change set when this changes. */
export const HOST_COMPAT = {
  /** Verified-against floor (the host version the plugin contract is checked against). */
  minInclusive: "2.0.22",
  /** Next major assumed breaking. */
  maxExclusive: "3.0.0",
  /** Host versions turnstile has been explicitly tested against. */
  tested: ["2.0.22", "2.0.27", "2.0.29"],
} as const

/** Outcome of the host-compat evaluation at setup. */
export type CompatVerdict = "compatible" | "incompatible" | "unknown"

/** The verdict plus the host version it was derived from and the user-facing
 * message (toast text for incompatible/unknown hosts; "" when compatible). */
export interface CompatResult {
  verdict: CompatVerdict
  /** The host version string as evaluated; "" when unreadable. */
  hostVersion: string
  /** Toast text for incompatible/unknown hosts; "" when compatible. */
  message: string
}

/** A parsed strict `major.minor.patch` version with optional pre-release identifiers. */
export interface ParsedSemver {
  major: number
  minor: number
  patch: number
  /** Pre-release identifiers (empty when none). */
  pre: string[]
}

/**
 * Parses a strict `major.minor.patch` version string with an optional
 * `-pre` suffix; a leading `v` is tolerated. Anything else (junk, missing
 * parts, non-numeric fields, empty) returns null.
 * @param s The version string to parse.
 * @returns The parsed fields, or null when not a parseable version.
 */
export function parseSemver(s: string): ParsedSemver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(s)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  }
}

/**
 * Compares two semver strings field-by-field (numeric major/minor/patch);
 * when the core fields are equal, a version carrying a pre-release suffix
 * sorts before one without (standard semver).
 * @param a First version string.
 * @param b Second version string.
 * @returns Negative when a < b, zero when equal, positive when a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  if (pa.pre.length > 0 && pb.pre.length === 0) return -1
  if (pa.pre.length === 0 && pb.pre.length > 0) return 1
  return 0
}

/**
 * Builds the user-facing toast text for an unreadable host version.
 * @param plugin The plugin version display string (never empty).
 * @returns The unknown-version warning message.
 */
function unknownMessage(plugin: string): string {
  return `${plugin} could not read the OpenCode version; enforcing as usual. If gates misbehave, report your \`opencode --version\`.`
}

/**
 * Builds the user-facing toast text for an out-of-range host version.
 * @param plugin The plugin version display string.
 * @param hostVersion The raw host version string.
 * @param range The shipped compat range.
 * @returns The incompatible-host upgrade message.
 */
function incompatibleMessage(
  plugin: string,
  hostVersion: string,
  range: typeof HOST_COMPAT,
): string {
  return `${plugin} expects opencode >=${range.minInclusive},<${range.maxExclusive}; you're on ${hostVersion} — upgrade turnstile (npm i opencode-turnstile@latest) or pin opencode`
}

/**
 * Evaluates whether a host version falls inside the shipped compat range.
 * Pure and total: never throws for any input value.
 * @param hostVersion The host-reported version (any shape; non-strings or
 *     unparseable strings yield the `unknown` verdict).
 * @param pluginVersion The plugin's own version, or null when unreadable.
 * @param range The shipped compat range.
 * @returns The verdict, the evaluated host version ("" when unreadable), and
 *     a message for the incompatible/unknown verdicts.
 */
export function evaluateHostCompat(
  hostVersion: unknown,
  pluginVersion: string | null,
  range: typeof HOST_COMPAT = HOST_COMPAT,
): CompatResult {
  const plugin = `turnstile ${pluginVersion ?? "(unknown)"}`
  if (typeof hostVersion !== "string") {
    return { verdict: "unknown", hostVersion: "", message: unknownMessage(plugin) }
  }
  const parsed = parseSemver(hostVersion)
  if (!parsed) {
    return {
      verdict: "unknown",
      hostVersion: hostVersion,
      message: unknownMessage(plugin),
    }
  }
  if (
    compareSemver(hostVersion, range.minInclusive) < 0 ||
    compareSemver(hostVersion, range.maxExclusive) >= 0
  ) {
    return {
      verdict: "incompatible",
      hostVersion,
      message: incompatibleMessage(plugin, hostVersion, range),
    }
  }
  return { verdict: "compatible", hostVersion, message: "" }
}
