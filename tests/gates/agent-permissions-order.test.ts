/**
 * @fileoverview Structural tests over the shipped agent definitions
 * (agents/*.md): any scoped edit allow must come after the blanket
 * `edit *` deny, because OpenCode permission rules are last-match-wins
 * and a trailing deny would silently override the allow.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const agentsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agents")

/** One parsed edit permission rule from an agent frontmatter block. */
interface EditRule {
  resource: string
  effect: string
}

/** Parses the `{ action: edit, ... }` rules from an agent definition's
 *  frontmatter permissions block, in file order. */
function editRules(text: string): EditRule[] {
  const frontmatter = text.split(/^---$/m)[1] ?? ""
  const rules: EditRule[] = []
  for (const line of frontmatter.split("\n")) {
    const match = line.match(
      /^\s*-\s*\{\s*action:\s*edit,\s*resource:\s*"([^"]*)",\s*effect:\s*(\w+)\s*\}/,
    )
    if (match?.[1] && match[2]) rules.push({ resource: match[1], effect: match[2] })
  }
  return rules
}

/** Every agent definition carrying a scoped edit allow orders it after the
 *  blanket `edit *` deny, so last-match-wins resolves to the allow. */
test("agent definitions: scoped edit allows follow the blanket edit deny", () => {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"))
  assert.ok(files.length > 0, "agent definitions are present")
  for (const file of files) {
    const rules = editRules(readFileSync(join(agentsDir, file), "utf8"))
    const scopedAllows = rules.filter((r) => r.effect === "allow" && r.resource !== "*")
    if (scopedAllows.length === 0) continue
    const last = rules.at(-1)
    if (!last) continue
    assert.equal(
      last.effect,
      "allow",
      `${file}: the last edit rule must be the scoped allow (last-match-wins), got deny for "${last.resource}"`,
    )
    const denyIndex = rules.findIndex((r) => r.effect === "deny" && r.resource === "*")
    assert.ok(
      denyIndex !== -1 && denyIndex < rules.length - 1,
      `${file}: a blanket edit deny must precede the scoped allow`,
    )
  }
})

/** The requirements agent specifically: the `.opencode/requirements/**`
 *  allow is the final edit rule, after the blanket deny. */
test("requirements agent: the .opencode/requirements allow is the last edit rule", () => {
  const rules = editRules(readFileSync(join(agentsDir, "requirements.md"), "utf8"))
  const last = rules.at(-1)
  assert.deepEqual(last, { resource: ".opencode/requirements/**", effect: "allow" })
  assert.equal(rules[0]?.resource, "*")
  assert.equal(rules[0]?.effect, "deny")
})
