/**
 * @fileoverview Tests for the pure hash-chain math in `src/chain.ts`:
 * canonical JSON serialization, record hashes, Merkle roots, and the chain
 * fold covering the tamper classes (prevHash / hash / seq mismatch, legacy
 * unhashed prefix, epoch root mismatch).
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"

import { canonicalJson, foldChain, merkleRoot, recordHash } from "../src/chain.ts"
import type { ParsedRow } from "../src/chain.ts"

/** SHA-256 helper for expected-value construction. */
const sha = (s: string): string => createHash("sha256").update(s).digest("hex")

/** A chained row with concrete chain-field types (what the journaler appends). */
interface ChainedRow extends ParsedRow {
  seq: number
  prevHash: string
  hash: string
}

/** Builds a chained row the same way the journaler will append one. */
function chainedRow(prevHash: string, seq: number, data: Record<string, unknown>): ChainedRow {
  const ts = "2026-01-01T00:00:00.000Z"
  const payload = { ts, ...data }
  const hash: string = recordHash(prevHash, ts, payload)
  return { ts, payload, seq, prevHash, hash }
}

describe("canonicalJson", () => {
  it("sorts object keys and drops whitespace", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  })

  it("sorts keys recursively in nested objects", () => {
    assert.equal(canonicalJson({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}')
  })

  it("keeps array order and serializes elements", () => {
    assert.equal(canonicalJson([3, "a", true, null]), '[3,"a",true,null]')
  })

  it("renders undefined array elements as null", () => {
    assert.equal(canonicalJson([undefined, 1]), "[null,1]")
  })

  it("renders a top-level undefined as null", () => {
    assert.equal(canonicalJson(undefined), "null")
  })

  it("drops undefined object fields", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}')
  })

  it("rejects non-finite numbers", () => {
    assert.throws(() => canonicalJson(NaN), TypeError)
    assert.throws(() => canonicalJson(Infinity), TypeError)
  })

  it("rejects non-JSON typeof values", () => {
    assert.throws(() => canonicalJson(() => 1), TypeError)
    assert.throws(() => canonicalJson(Symbol("s")), TypeError)
    assert.throws(() => canonicalJson(1n), TypeError)
  })
})

describe("recordHash", () => {
  it("is deterministic for identical inputs", () => {
    const a = recordHash("", "t", { type: "x" })
    const b = recordHash("", "t", { type: "x" })
    assert.equal(a, b)
    assert.equal(a, sha(canonicalJson({ prevHash: "", ts: "t", payload: { type: "x" } })))
  })

  it("is insensitive to payload key order", () => {
    assert.equal(recordHash("", "t", { a: 1, b: 2 }), recordHash("", "t", { b: 2, a: 1 }))
  })

  it("flips when any input field changes", () => {
    const base = recordHash("", "t", { a: 1 })
    assert.notEqual(base, recordHash("p", "t", { a: 1 }))
    assert.notEqual(base, recordHash("", "u", { a: 1 }))
    assert.notEqual(base, recordHash("", "t", { a: 2 }))
  })
})

describe("merkleRoot", () => {
  it("hashes the empty string for an empty list", () => {
    assert.equal(merkleRoot([]), sha(""))
  })

  it("hashes a single node with itself", () => {
    assert.equal(merkleRoot(["aa"]), sha("aaaa"))
  })

  it("pairs two leaves and hashes the survivor with itself", () => {
    assert.equal(merkleRoot(["aa", "bb"]), sha(sha("aabb") + sha("aabb")))
  })

  it("promotes an odd trailing node by hashing it with itself", () => {
    const h01 = sha("aa" + "bb")
    const h22 = sha("cc" + "cc")
    const survivor = sha(h01 + h22)
    assert.equal(merkleRoot(["aa", "bb", "cc"]), sha(survivor + survivor))
  })
})

describe("foldChain", () => {
  it("returns ok with no epochs for a clean chain", () => {
    const rows = [
      chainedRow("", 0, { type: "a" }),
      chainedRow(chainedRow("", 0, { type: "a" }).hash, 1, { type: "b" }),
    ]
    const v = foldChain(rows, "shared")
    assert.deepEqual(v, { status: "ok", epochs: [] })
  })

  it("treats legacy rows without a hash as an inert prefix", () => {
    const legacy: ParsedRow = {
      ts: "t",
      payload: { type: "old" },
      seq: undefined,
      prevHash: undefined,
      hash: undefined,
    }
    const first = chainedRow("", 0, { type: "a" })
    const v = foldChain([legacy, first], "shared")
    assert.equal(v.status, "ok")
  })

  it("reports a prevHash mismatch at the first broken link", () => {
    const r0 = chainedRow("", 0, { type: "a" })
    const r1 = chainedRow(r0.hash, 1, { type: "b" })
    const tampered = { ...r1, prevHash: "deadbeef" }
    const v = foldChain([r0, tampered], "shared")
    assert.deepEqual(v, { status: "broken", detail: "shared:2: prevHash mismatch", index: 2 })
  })

  it("reports a recomputed-hash mismatch (edited payload)", () => {
    const r0 = chainedRow("", 0, { type: "a" })
    const r1 = chainedRow(r0.hash, 1, { type: "b" })
    const tampered = { ...r1, payload: { type: "b", edited: true } }
    const v = foldChain([r0, tampered], "shared")
    assert.deepEqual(v, { status: "broken", detail: "shared:2: hash mismatch", index: 2 })
  })

  it("reports a seq mismatch", () => {
    const r0 = chainedRow("", 0, { type: "a" })
    const r1 = chainedRow(r0.hash, 1, { type: "b" })
    const tampered = { ...r1, seq: 5 }
    const v = foldChain([r0, tampered], "shared")
    assert.deepEqual(v, { status: "broken", detail: "shared:2: seq mismatch", index: 2 })
  })

  it("reports a non-numeric seq as a mismatch", () => {
    const r0 = chainedRow("", 0, { type: "a" })
    const tampered = { ...r0, seq: "0" }
    const v = foldChain([tampered], "shared")
    assert.equal(v.status, "broken")
  })

  it("consumes a chain-epoch row and reports the epoch summary", () => {
    const r0 = chainedRow("", 0, { type: "a" })
    const r1 = chainedRow(r0.hash, 1, { type: "b" })
    const hashes = [r0.hash, r1.hash]
    const epoch = chainedRow(r1.hash, 2, {
      type: "chain-epoch",
      source: "shared",
      epoch: 0,
      count: 2,
      root: merkleRoot(hashes),
      head: r1.hash,
    })
    const v = foldChain([r0, r1, epoch], "shared")
    assert.deepEqual(v, {
      status: "ok",
      epochs: [
        {
          source: "shared",
          epoch: 0,
          count: 2,
          root: merkleRoot(hashes),
          head: r1.hash,
          ts: epoch.ts,
        },
      ],
    })
  })

  it("reports an epoch root mismatch", () => {
    const r0 = chainedRow("", 0, { type: "a" })
    const epoch = chainedRow(r0.hash, 1, {
      type: "chain-epoch",
      source: "shared",
      epoch: 0,
      count: 1,
      root: "not-the-root",
      head: r0.hash,
    })
    const v = foldChain([r0, epoch], "shared")
    assert.deepEqual(v, {
      status: "broken",
      detail: "shared: epoch root/head mismatch",
      index: 0,
    })
  })

  it("reports an epoch head mismatch", () => {
    const r0 = chainedRow("", 0, { type: "a" })
    const epoch = chainedRow(r0.hash, 1, {
      type: "chain-epoch",
      source: "shared",
      epoch: 0,
      count: 1,
      root: merkleRoot([r0.hash]),
      head: "not-the-head",
    })
    const v = foldChain([r0, epoch], "shared")
    assert.equal(v.status, "broken")
  })

  it("accepts an epoch row with no data rows (empty window)", () => {
    const epoch = chainedRow("", 0, {
      type: "chain-epoch",
      source: "shared",
      epoch: 0,
      count: 0,
      root: sha(""),
      head: "",
    })
    const v = foldChain([epoch], "shared")
    assert.deepEqual(v, {
      status: "ok",
      epochs: [{ source: "shared", epoch: 0, count: 0, root: sha(""), head: "", ts: epoch.ts }],
    })
  })

  it("reports a non-numeric epoch index as -1 in the summary", () => {
    const r0 = chainedRow("", 0, { type: "a" })
    const epoch = chainedRow(r0.hash, 1, {
      type: "chain-epoch",
      source: "shared",
      epoch: "zero",
      count: 1,
      root: merkleRoot([r0.hash]),
      head: r0.hash,
    })
    const v = foldChain([r0, epoch], "shared")
    assert.equal(v.status, "ok")
    assert.equal(v.status === "ok" && v.epochs[0]!.epoch, -1)
  })

  it("starts a fresh epoch window after a committed epoch row", () => {
    const r0 = chainedRow("", 0, { type: "a" })
    const epoch0 = chainedRow(r0.hash, 1, {
      type: "chain-epoch",
      source: "shared",
      epoch: 0,
      count: 1,
      root: merkleRoot([r0.hash]),
      head: r0.hash,
    })
    const r1 = chainedRow(epoch0.hash, 2, { type: "b" })
    const epoch1 = chainedRow(r1.hash, 3, {
      type: "chain-epoch",
      source: "shared",
      epoch: 1,
      count: 1,
      root: merkleRoot([r1.hash]),
      head: r1.hash,
    })
    const v = foldChain([r0, epoch0, r1, epoch1], "shared")
    assert.equal(v.status, "ok")
    assert.equal(v.status === "ok" && v.epochs.length, 2)
  })
})
