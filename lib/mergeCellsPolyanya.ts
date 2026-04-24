import { cross } from "./cross"
import { getAvailableZFromMask, getMaskFromAvailableZ } from "./layer-utils"
import type { LayerMergeMode, Point, Triangle } from "./types"

/**
 * Polyanya-style two-phase merge for CDT triangles:
 *
 *   Phase 1 — Dead-end elimination: polygons with exactly one traversable
 *             neighbor are unconditionally merged (they can never help
 *             pathfinding).
 *
 *   Phase 2 — Max-area priority queue: greedily merge the largest pair of
 *             adjacent convex polygons, producing the fewest, largest
 *             strictly-convex cells.
 *
 * Both phases enforce strict convexity (cross product > -eps at junction
 * vertices) and use O(1) convexity checks instead of full convex-hull
 * computation.
 */

const edgeKey = (a: number, b: number): number =>
  a < b ? a * 100000 + b : b * 100000 + a

export const mergeCellsPolyanya = (params: {
  triangles: Triangle[]
  pts: Point[]
  cellAvailableZ?: number[][]
  layerMergeMode?: LayerMergeMode
}): { cells: number[][]; depths: number[]; availableZ?: number[][] } => {
  const { triangles, pts, cellAvailableZ, layerMergeMode = "same" } = params
  if (!triangles.length) return { cells: [], depths: [] }

  // --- Initialise cells (ensure CCW) ---
  const n = triangles.length
  const cells: (number[] | null)[] = triangles.map(([a, b, c]) => {
    const pa = pts[a]
    const pb = pts[b]
    const pc = pts[c]
    if (!pa || !pb || !pc) return [a, b, c]
    return cross({ o: pa, a: pb, b: pc }) < 0 ? [a, c, b] : [a, b, c]
  })
  const cellZMasks = cellAvailableZ?.map(getMaskFromAvailableZ)

  // --- Build and maintain adjacency via edge map ---
  // Edge at position k in a cell goes from ring[k] → ring[(k+1)%len].
  // adj[ci].get(k) = { neighbor, neighborEdge } means the edge at position k
  // in cell ci is shared with cell `neighbor` at its edge `neighborEdge`.

  type AdjEntry = { neighbor: number; neighborEdge: number }
  const adj: (Map<number, AdjEntry> | null)[] = new Array(n).fill(null)
  for (let i = 0; i < n; i++) adj[i] = new Map()

  function rebuildAdj(): void {
    for (let i = 0; i < adj.length; i++) {
      if (adj[i]) adj[i]!.clear()
    }
    const edgeMap = new Map<number, { cellIdx: number; edgePos: number }>()
    for (let ci = 0; ci < cells.length; ci++) {
      const ring = cells[ci]
      if (!ring) continue
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k]!
        const b = ring[(k + 1) % ring.length]!
        const key = edgeKey(a, b)
        const existing = edgeMap.get(key)
        if (existing) {
          adj[ci]!.set(k, {
            neighbor: existing.cellIdx,
            neighborEdge: existing.edgePos,
          })
          adj[existing.cellIdx]!.set(existing.edgePos, {
            neighbor: ci,
            neighborEdge: k,
          })
        } else {
          edgeMap.set(key, { cellIdx: ci, edgePos: k })
        }
      }
    }
  }

  rebuildAdj()

  // --- Geometry helpers ---

  function cellArea(ring: number[]): number {
    let a = 0
    for (let i = 0; i < ring.length; i++) {
      const p = pts[ring[i]!]!
      const q = pts[ring[(i + 1) % ring.length]!]!
      a += p.x * q.y - q.x * p.y
    }
    return Math.abs(a) / 2
  }

  // Find the full shared boundary between cells X and Y.
  // Edge convention: edge k goes from ring[k] to ring[(k+1)%N].
  // Returns [firstK..lastK] = range of consecutive edge positions in X pointing to Y.
  // Shared boundary vertices in X: ring[firstK], ..., ring[(lastK+1)%N]
  //   A = ring[firstK]         (first shared vertex)
  //   B = ring[(lastK+1)%N]    (last shared vertex)
  function findBoundary(
    xIdx: number,
    yIdx: number,
  ): { firstK: number; lastK: number; sharedCount: number } | null {
    const xRing = cells[xIdx]!
    const xAdj = adj[xIdx]!
    const L = xRing.length

    // Find any edge pointing to Y
    let seedK = -1
    for (const [k, entry] of xAdj) {
      if (entry.neighbor === yIdx) {
        seedK = k
        break
      }
    }
    if (seedK === -1) return null

    // Expand backwards
    let firstK = seedK
    while (true) {
      const prev = (firstK - 1 + L) % L
      if (prev === seedK) break
      const prevEntry = xAdj.get(prev)
      if (!prevEntry || prevEntry.neighbor !== yIdx) break
      firstK = prev
    }

    // Expand forwards
    let lastK = seedK
    while (true) {
      const next = (lastK + 1) % L
      if (next === firstK) break
      const nextEntry = xAdj.get(next)
      if (!nextEntry || nextEntry.neighbor !== yIdx) break
      lastK = next
    }

    const sharedCount = ((lastK - firstK + L) % L) + 1
    return { firstK, lastK, sharedCount }
  }

  // Check if merging X with Y across their shared boundary produces a convex
  // polygon. Only needs to test the two junction vertices A and B.
  function canMerge(xIdx: number, yIdx: number): boolean {
    const xRing = cells[xIdx]!
    const yRing = cells[yIdx]!
    const boundary = findBoundary(xIdx, yIdx)
    if (!boundary) return false

    const { firstK, lastK, sharedCount } = boundary
    const N = xRing.length
    const M = yRing.length

    // A = first shared vertex, B = last shared vertex
    const A = xRing[firstK]!
    const B = xRing[(lastK + 1) % N]!

    // Find A in Y
    let mA = -1
    for (let i = 0; i < M; i++) {
      if (yRing[i] === A) {
        mA = i
        break
      }
    }
    if (mA === -1) return false

    // B should be at Y[(mA - sharedCount + M) % M]
    const mB = (mA - sharedCount + M) % M
    if (yRing[mB] !== B) return false

    // Check convexity at A: prevX → A → nextY must be a left turn
    // prevX = vertex before A in X's non-shared portion
    const prevX = pts[xRing[(firstK - 1 + N) % N]!]!
    const pA = pts[A]!
    const nextY = pts[yRing[(mA + 1) % M]!]!
    if (cross({ o: prevX, a: pA, b: nextY }) < -1e-8) return false

    // Check convexity at B: prevY → B → nextX must be a left turn
    // prevY = last vertex of Y's non-shared portion
    const prevY = pts[yRing[(mB - 1 + M) % M]!]!
    const pB = pts[B]!
    const nextX = pts[xRing[(lastK + 2) % N]!]!
    if (cross({ o: prevY, a: pB, b: nextX }) < -1e-8) return false

    if (cellZMasks) {
      const mergedMask = cellZMasks[xIdx]! & cellZMasks[yIdx]!
      if (mergedMask === 0) return false
      if (layerMergeMode === "same" && cellZMasks[xIdx] !== cellZMasks[yIdx]) {
        return false
      }
    }

    return true
  }

  // Merge Y into X across their shared boundary.
  // Merged ring = A + Y's non-shared interior + B + X's non-shared interior
  function doMerge(xIdx: number, yIdx: number): void {
    const xRing = cells[xIdx]!
    const yRing = cells[yIdx]!
    const boundary = findBoundary(xIdx, yIdx)!
    const { firstK, lastK, sharedCount } = boundary
    const N = xRing.length
    const M = yRing.length

    const A = xRing[firstK]!
    const B = xRing[(lastK + 1) % N]!

    let mA = -1
    for (let i = 0; i < M; i++) {
      if (yRing[i] === A) {
        mA = i
        break
      }
    }

    const newRing: number[] = []

    // A
    newRing.push(A)

    // Y's non-shared interior: Y[(mA+1)%M], ..., (M - sharedCount - 1 vertices)
    const yNonShared = M - sharedCount - 1
    for (let j = 1; j <= yNonShared; j++) {
      newRing.push(yRing[(mA + j) % M]!)
    }

    // B
    newRing.push(B)

    // X's non-shared interior: X[(lastK+2)%N], ..., (N - sharedCount - 1 vertices)
    const xNonShared = N - sharedCount - 1
    for (let j = 2; j <= xNonShared + 1; j++) {
      newRing.push(xRing[(lastK + j) % N]!)
    }

    cells[xIdx] = newRing
    cells[yIdx] = null
    if (cellZMasks) {
      cellZMasks[xIdx] = cellZMasks[xIdx]! & cellZMasks[yIdx]!
      cellZMasks[yIdx] = 0
    }
  }

  // --- Phase 1: Dead-end elimination ---
  // A dead-end is a cell with exactly one distinct live neighbor.
  let changed = true
  while (changed) {
    changed = false
    rebuildAdj()
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i]) continue
      const iAdj = adj[i]!
      const neighbors = new Set<number>()
      for (const [, entry] of iAdj) {
        if (cells[entry.neighbor]) neighbors.add(entry.neighbor)
      }
      if (neighbors.size === 1) {
        const nIdx = neighbors.values().next().value!
        if (canMerge(i, nIdx)) {
          doMerge(i, nIdx)
          changed = true
        }
      }
    }
  }

  // --- Phase 2: Max-area priority queue ---
  rebuildAdj()

  const areas: number[] = new Array(cells.length).fill(0)
  for (let i = 0; i < cells.length; i++) {
    if (cells[i]) areas[i] = cellArea(cells[i]!)
  }

  interface HeapEntry {
    area: number
    xIdx: number
    yIdx: number
  }
  const heap: HeapEntry[] = []

  function heapPush(e: HeapEntry): void {
    heap.push(e)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p]!.area >= heap[i]!.area) break
      const t = heap[p]!
      heap[p] = heap[i]!
      heap[i] = t
      i = p
    }
  }

  function heapPop(): HeapEntry | undefined {
    if (heap.length === 0) return undefined
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      let i = 0
      while (true) {
        let big = i
        const l = 2 * i + 1
        const r = 2 * i + 2
        if (l < heap.length && heap[l]!.area > heap[big]!.area) big = l
        if (r < heap.length && heap[r]!.area > heap[big]!.area) big = r
        if (big === i) break
        const t = heap[i]!
        heap[i] = heap[big]!
        heap[big] = t
        i = big
      }
    }
    return top
  }

  // Seed the heap with all valid merge pairs
  const seenPairs = new Set<number>()
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue
    const iAdj = adj[i]!
    const neighbors = new Set<number>()
    for (const [, entry] of iAdj) {
      if (cells[entry.neighbor]) neighbors.add(entry.neighbor)
    }
    for (const nIdx of neighbors) {
      const pairKey = i < nIdx ? i * 100000 + nIdx : nIdx * 100000 + i
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)
      if (canMerge(i, nIdx)) {
        heapPush({ area: areas[i]! + areas[nIdx]!, xIdx: i, yIdx: nIdx })
      }
    }
  }

  while (heap.length > 0) {
    const entry = heapPop()!
    const { xIdx, yIdx } = entry

    // Stale check: both cells must still be alive
    if (!cells[xIdx] || !cells[yIdx]) continue

    // Revalidate: areas might have changed since this entry was pushed
    const currentArea = areas[xIdx]! + areas[yIdx]!
    if (Math.abs(currentArea - entry.area) > 1e-10) {
      if (canMerge(xIdx, yIdx)) {
        heapPush({ area: currentArea, xIdx, yIdx })
      }
      continue
    }

    // Re-verify convexity (neighbors may have changed)
    if (!canMerge(xIdx, yIdx)) continue

    doMerge(xIdx, yIdx)
    areas[xIdx] = cellArea(cells[xIdx]!)

    // Rebuild adjacency and push new pairs involving the merged cell
    rebuildAdj()
    const xAdj = adj[xIdx]!
    const neighbors = new Set<number>()
    for (const [, e] of xAdj) {
      if (cells[e.neighbor]) neighbors.add(e.neighbor)
    }
    for (const nIdx of neighbors) {
      if (canMerge(xIdx, nIdx)) {
        heapPush({ area: areas[xIdx]! + areas[nIdx]!, xIdx, yIdx: nIdx })
      }
    }
  }

  // --- Compact and return ---
  const liveCells = cells.filter((c): c is number[] => c !== null)
  const liveAvailableZ = cellZMasks
    ? cells.flatMap((cell, index) =>
        cell === null ? [] : [getAvailableZFromMask(cellZMasks[index]!)],
      )
    : undefined

  // Depths are all 0 since Polyanya merge enforces strict convexity
  const depths = liveCells.map(() => 0)

  return {
    cells: liveCells,
    depths,
    ...(liveAvailableZ ? { availableZ: liveAvailableZ } : {}),
  }
}
