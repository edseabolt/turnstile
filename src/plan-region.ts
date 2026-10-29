/**
 * Plan spec-region extraction: the shared slice of a plan file that approval
 * keying hashes. The `# Progress` section is pipeline-maintained by design
 * (DONE bullets, chunk status), so it is excluded from the hashed bytes — a
 * progress-only edit keeps a bound plan approval live, while any edit to the
 * spec region (`# Objective` onward) invalidates it. One function, consumed
 * by the plan-gate's per-file hashing so capture, reconcile, and the durable
 * approval sidecar all compare the same key.
 */

/** The exact top-level header that opens a plan's progress section. */
export const PROGRESS_HEADER = "# Progress"

/**
 * Extracts the spec region of a plan file: everything from the first
 * top-level heading after the leading `# Progress` section to EOF. The
 * `# Progress` section is the leading block starting at line 1 and ending
 * just before the next `# `-heading (the `# Objective` section and onward).
 * Fail-closed fallbacks — each returns the whole file unchanged so an
 * unrecognized structure never silently shrinks the hashed region:
 * - the file does not start with the exact `# Progress` header at line 1
 *   (missing, misspelled, or merely whitespace-differing lines other than
 *   trailing whitespace on the header itself);
 * - the file starts with `# Progress` but carries no following top-level
 *   heading (a progress-only file has no spec region to key on).
 * A plan without a `# Progress` section therefore keys on its whole bytes —
 * today's whole-file behavior for spec-only plans.
 * @param bytes The plan file bytes.
 * @returns The spec-region bytes to hash, or the input bytes when unchanged.
 */
export function planSpecRegion(bytes: Buffer): Buffer {
  const lines = bytes.toString("utf8").split("\n")
  if (lines[0]?.trim() !== PROGRESS_HEADER) return bytes
  for (let i = 1; i < lines.length; i++) {
    if (/^# /.test(lines[i]!)) return Buffer.from(lines.slice(i).join("\n"), "utf8")
  }
  return bytes
}
