import { concavityDepth } from "./concavityDepth"
import { cross } from "./cross"
import { getAvailableZFromMask, getMaskFromAvailableZ } from "./layer-utils"
import { stitchRings } from "./stitchRings"
import type { LayerMergeMode, Point, Triangle } from "./types"

const edgeKey = (a: number, b: number) =>
  a < b ? a * 100000 + b : b * 100000 + a

export const mergeCells = (params: {
  triangles: Triangle[]
  pts: Point[]
  concavityTolerance: number
  cellAvailableZ?: number[][]
  layerMergeMode?: LayerMergeMode
}): { cells: number[][]; depths: number[]; availableZ?: number[][] } => {
  const {
    triangles,
    pts,
    concavityTolerance,
    cellAvailableZ,
    layerMergeMode = "same",
  } = params
  if (!triangles.length) return { cells: [], depths: [] }

  const cells = triangles.map(([a, b, c]) => {
    const pa = pts[a]
    const pb = pts[b]
    const pc = pts[c]
    if (!pa || !pb || !pc) return [a, b, c]
    return cross({ o: pa, a: pb, b: pc }) < 0 ? [a, c, b] : [a, b, c]
  })
  const cellZMasks = cellAvailableZ?.map(getMaskFromAvailableZ)

  const getMergedMask = (i: number, j: number) => {
    if (!cellZMasks) return undefined
    const mergedMask = cellZMasks[i]! & cellZMasks[j]!
    if (mergedMask === 0) return 0
    if (layerMergeMode === "same" && cellZMasks[i] !== cellZMasks[j]) return 0
    return mergedMask
  }

  let changed = true
  let iterations = 0

  while (changed && iterations++ < 800) {
    changed = false

    const edgeMap = new Map<number, number>()
    const adjacency = cells.map(() => new Set<number>())

    for (let ci = 0; ci < cells.length; ci++) {
      const ring = cells[ci]
      if (!ring) continue

      for (let i = 0; i < ring.length; i++) {
        const current = ring[i]
        const next = ring[(i + 1) % ring.length]
        if (current === undefined || next === undefined) continue

        const key = edgeKey(current, next)
        if (edgeMap.has(key)) {
          const other = edgeMap.get(key)
          if (other !== undefined) {
            adjacency[ci]?.add(other)
            adjacency[other]?.add(ci)
          }
        } else {
          edgeMap.set(key, ci)
        }
      }
    }

    let bestI = -1
    let bestJ = -1
    let bestRing: number[] | null = null
    let bestDepth = Number.POSITIVE_INFINITY

    for (let i = 0; i < cells.length; i++) {
      const neighbors = adjacency[i]
      if (!neighbors) continue

      for (const j of neighbors) {
        if (j <= i) continue

        const merged = stitchRings(cells[i] ?? [], cells[j] ?? [])
        if (!merged) continue
        const mergedMask = getMergedMask(i, j)
        if (mergedMask === 0) continue

        const depth = concavityDepth(merged, pts)
        if (depth <= concavityTolerance + 1e-6 && depth < bestDepth) {
          bestDepth = depth
          bestI = i
          bestJ = j
          bestRing = merged
        }
      }
    }

    if (bestI < 0 || bestJ < 0 || !bestRing) break

    cells[bestI] = bestRing
    if (cellZMasks) {
      cellZMasks[bestI] = getMergedMask(bestI, bestJ)!
      cellZMasks.splice(bestJ, 1)
    }
    cells.splice(bestJ, 1)
    changed = true
  }

  const depths = cells.map((cell) => concavityDepth(cell, pts))
  return {
    cells,
    depths,
    ...(cellZMasks
      ? { availableZ: cellZMasks.map((mask) => getAvailableZFromMask(mask)) }
      : {}),
  }
}
