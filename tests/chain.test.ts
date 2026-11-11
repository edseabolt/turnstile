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

  it("folds the first chained row as a trust root when chainRootAtStart is set", () => {
    // The row continues a pruned generation: its prevHash points outside
    // the surviving files and its seq is whatever the pruned chain reached.
    const root = chainedRow("pruned-hash", 7, { type: "a" })
    const next = chainedRow(root.hash, 8, { type: "b" })
    const v = foldChain([root, next], "shared", { chainRootAtStart: true })
    assert.deepEqual(v, { status: "ok", epochs: [] })
  })

  it("still rejects a trust-root row with an implausible seq", () => {
    const root = chainedRow("pruned-hash", 7, { type: "a" })
    const v = foldChain([{ ...root, seq: -1 }], "shared", { chainRootAtStart: true })
    assert.equal(v.status, "broken")
    assert.equal(v.status === "broken" && v.detail, "shared:1: seq mismatch")
  })

  it("still rejects a trust-root row whose self-hash does not match", () => {
    const root = chainedRow("pruned-hash", 7, { type: "a" })
    const v = foldChain([{ ...root, hash: "0".repeat(64) }], "shared", {
      chainRootAtStart: true,
    })
    assert.equal(v.status, "broken")
    assert.equal(v.status === "broken" && v.detail, "shared:1: hash mismatch")
  })

  it("rejects a trust-root row whose prevHash is not a string", () => {
    const root = chainedRow("pruned-hash", 7, { type: "a" })
    const v = foldChain([{ ...root, prevHash: 5 } as ParsedRow], "shared", {
      chainRootAtStart: true,
    })
    assert.equal(v.status, "broken")
    assert.equal(v.status === "broken" && v.detail, "shared:1: hash mismatch")
  })

  it("still detects a first-row prevHash mismatch without the trust-root option", () => {
    const root = chainedRow("deadbeef", 0, { type: "a" })
    const v = foldChain([root], "shared")
    assert.equal(v.status, "broken")
    assert.equal(v.status === "broken" && v.detail, "shared:1: prevHash mismatch")
  })

  it("waives the root check for an epoch window that includes the trust root", () => {
    // The window's earlier data rows were pruned, so the recomputed root
    // cannot match: the chain-hash-protected declared root is recorded.
    const root = chainedRow("pruned-hash", 7, { type: "a" })
    const epoch = chainedRow(root.hash, 8, {
      type: "chain-epoch",
      source: "shared",
      epoch: 0,
      count: 3,
      root: "declared-root",
      head: root.hash,
    })
    const v = foldChain([root, epoch], "shared", { chainRootAtStart: true })
    assert.equal(v.status, "ok")
    assert.equal(v.status === "ok" && v.epochs[0]!.root, "declared-root")
  })

  it("rejects an incomplete window whose declared root is not a string", () => {
    const root = chainedRow("pruned-hash", 7, { type: "a" })
    const epoch = chainedRow(root.hash, 8, {
      type: "chain-epoch",
      source: "shared",
      epoch: 0,
      count: 1,
      root: 5,
      head: root.hash,
    })
    const v = foldChain([root, epoch], "shared", { chainRootAtStart: true })
    assert.equal(v.status, "broken")
    assert.equal(v.status === "broken" && v.detail, "shared: epoch root/head mismatch")
  })

  it("still checks the root of a complete window after the trust root", () => {
    const root = chainedRow("pruned-hash", 7, { type: "a" })
    const epoch0 = chainedRow(root.hash, 8, {
      type: "chain-epoch",
      source: "shared",
      epoch: 0,
      count: 1,
      root: "declared-root",
      head: root.hash,
    })
    const r1 = chainedRow(epoch0.hash, 9, { type: "b" })
    const epoch1 = chainedRow(r1.hash, 10, {
      type: "chain-epoch",
      source: "shared",
      epoch: 1,
      count: 1,
      root: "wrong",
      head: r1.hash,
    })
    const v = foldChain([root, epoch0, r1, epoch1], "shared", { chainRootAtStart: true })
    assert.equal(v.status, "broken")
    assert.equal(v.status === "broken" && v.detail, "shared: epoch root/head mismatch")
  })

  it("still detects a tampered row inside a complete epoch of a multi-epoch journal", () => {
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
    const tampered = { ...r1, payload: { ...r1.payload, type: "edited" } }
    const v = foldChain([r0, epoch0, tampered], "shared")
    assert.equal(v.status, "broken")
    assert.equal(v.status === "broken" && v.detail, "shared:3: hash mismatch")
  })
})
