/**
 * @fileoverview Schema drift defenses: `schemas/turnstile.schema.json` is a
 * hand-written editor artifact outside the coverage gate, so these tests pin
 * it to the runtime source of truth — the draft URI, the exact key sets of
 * `defaultConfig()` (top-level and nested), the per-key JSON types against
 * `typeof` the runtime defaults (recursively), the enum unions, and a
 * structural subset check that every example-config key has a schema property.
 * A future key-add is a one-line schema fix, surfaced by the failure message.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { defaultConfig } from "../src/config.ts"

/** One node of the schema's `properties` object. */
interface SchemaNode {
  type: string
  enum?: string[]
  properties?: Record<string, SchemaNode>
}

const schema = JSON.parse(
  readFileSync(new URL("../schemas/turnstile.schema.json", import.meta.url), "utf8"),
) as {
  $schema: string
  additionalProperties: boolean
  properties: Record<string, SchemaNode>
}

/** Maps a JSON Schema type to the `typeof` a runtime value of that shape has. */
function jsType(schemaType: string): string {
  if (schemaType === "integer") return "number"
  if (schemaType === "array") return "object"
  return schemaType
}

/** Recursively asserts every schema property has a same-typed runtime value,
 *  descending into nested objects (agents, toolPolicy, gitGates). */
function assertTypesMatch(name: string, props: Record<string, SchemaNode>, runtime: unknown): void {
  assert.ok(
    runtime !== null && typeof runtime === "object" && !Array.isArray(runtime),
    `${name} runtime default must be an object`,
  )
  const rec = runtime as Record<string, unknown>
  for (const [key, node] of Object.entries(props)) {
    assert.ok(key in rec, `${name}.${key} exists at runtime`)
    assert.equal(
      jsType(node.type),
      typeof rec[key],
      `${name}.${key}: schema type ${node.type} matches runtime ${typeof rec[key]}`,
    )
    if (node.properties) assertTypesMatch(`${name}.${key}`, node.properties, rec[key])
  }
}

/** (8) The schema is draft 2020-12 and disables additionalProperties. */
test("schema is draft 2020-12 with additionalProperties disabled", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema")
  assert.equal(schema.additionalProperties, false)
})

/** (9) Top-level and nested property names are exactly the `defaultConfig()`
 *  key sets (sorted compare). */
test("schema property names match the defaultConfig key sets exactly", () => {
  const cfg = defaultConfig({})
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    Object.keys(cfg).sort(),
    "top-level key set",
  )
  assert.deepEqual(
    Object.keys(schema.properties.agents!.properties!).sort(),
    Object.keys(cfg.agents).sort(),
    "agents key set",
  )
  assert.deepEqual(
    Object.keys(schema.properties.toolPolicy!.properties!).sort(),
    Object.keys(cfg.toolPolicy).sort(),
    "toolPolicy key set",
  )
  assert.deepEqual(
    Object.keys(schema.properties.gitGates!.properties!).sort(),
    Object.keys(cfg.gitGates).sort(),
    "gitGates key set",
  )
})

/** (10) Each property's declared JSON type matches `typeof` the runtime
 *  default (recursively for the nested objects), and the enum lists match the
 *  literal unions. */
test("schema property types and enums match the runtime defaults recursively", () => {
  const cfg = defaultConfig({})
  assertTypesMatch("$", schema.properties, cfg)
  assert.deepEqual(
    schema.properties.gateEvidence!.enum,
    ["enforce", "flag", "off"],
    "gateEvidence enum",
  )
  assert.deepEqual(
    schema.properties.reviewEnsemble!.enum,
    ["enforce", "advise"],
    "reviewEnsemble enum",
  )
  assert.deepEqual(
    schema.properties.toolPolicy!.properties!.mode!.enum,
    ["enforce", "shadow", "off"],
    "toolPolicy.mode enum",
  )
  assert.deepEqual(
    schema.properties.gitGates!.properties!.mode!.enum,
    ["enforce", "shadow", "off"],
    "gitGates.mode enum",
  )
})

/** (11) Every key in the example config (top-level and nested) has a matching
 *  schema property — a structural subset check. */
test("every key in the example config exists in the schema properties", () => {
  const example = JSON.parse(
    readFileSync(new URL("../examples/turnstile.example.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>
  for (const [key, value] of Object.entries(example)) {
    assert.ok(key in schema.properties, `example key ${key} has a schema property`)
    // Descend into the three nested objects (agents, toolPolicy, gitGates).
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nestedSchema = schema.properties[key]?.properties
      assert.ok(nestedSchema, `nested example key ${key} has schema sub-properties`)
      for (const nestedKey of Object.keys(value as Record<string, unknown>)) {
        assert.ok(
          nestedKey in nestedSchema,
          `example key ${key}.${nestedKey} has a schema property`,
        )
      }
    }
  }
})
