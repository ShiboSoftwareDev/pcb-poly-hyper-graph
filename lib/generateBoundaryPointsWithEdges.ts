import { getOffsetPolygonPoints } from "./getOffsetPolygonPoints"
import { resolveConstraintCrossings } from "./resolveConstraintCrossings"
import { rotatePoint } from "./rotatePoint"
import type { Bounds, Point, Polygon, Rect, Via } from "./types"
import { unionObstacleBoundaries } from "./unionObstacleBoundaries"

/**
 * Appends a closed ring of points and records consecutive constraint edges.
 */
const addRing = (
  ringPts: Point[],
  allPts: Point[],
  constraintEdges: [number, number][],
): void => {
  const startIdx = allPts.length
  allPts.push(...ringPts)
  const n = ringPts.length
  for (let i = 0; i < n; i++) {
    constraintEdges.push([startIdx + i, startIdx + ((i + 1) % n)])
  }
}

export const generateBoundaryPointsWithEdges = (params: {
  bounds: Bounds
  vias: Via[]
  clearance: number
  rects: Rect[]
  polygons?: Polygon[]
  viaSegments?: number
  preserveObstacleBoundaries?: boolean
}): {
  pts: Point[]
  constraintEdges: [number, number][]
  hadCrossings: boolean
} => {
  const {
    bounds,
    vias,
    clearance,
    rects,
    polygons = [],
    viaSegments = 8,
    preserveObstacleBoundaries = false,
  } = params
  const allPts: Point[] = []
  const constraintEdges: [number, number][] = []
  const ringBoundaries: number[] = []
  const { minX: x0, maxX: x1, minY: y0, maxY: y1 } = bounds

  // Bounds perimeter: 10 points per edge = 40 total
  const edgeSegments = 10
  const boundsPts: Point[] = []
  for (let i = 0; i < edgeSegments; i++) {
    const t = i / edgeSegments
    boundsPts.push({ x: x0 + t * (x1 - x0), y: y0 })
  }
  for (let i = 0; i < edgeSegments; i++) {
    const t = i / edgeSegments
    boundsPts.push({ x: x1, y: y0 + t * (y1 - y0) })
  }
  for (let i = 0; i < edgeSegments; i++) {
    const t = i / edgeSegments
    boundsPts.push({ x: x1 - t * (x1 - x0), y: y1 })
  }
  for (let i = 0; i < edgeSegments; i++) {
    const t = i / edgeSegments
    boundsPts.push({ x: x0, y: y1 - t * (y1 - y0) })
  }
  ringBoundaries.push(constraintEdges.length)
  addRing(boundsPts, allPts, constraintEdges)

  // Collect all obstacle rings, then union overlapping ones before adding
  const obstacleRings: Point[][] = []

  // Vias: viaSegments points per circle (default 8 = octagon)
  for (const via of vias) {
    const radius = via.diameter / 2 + clearance
    const viaPts: Point[] = []
    for (let i = 0; i < viaSegments; i++) {
      const angle = (2 * Math.PI * i) / viaSegments
      viaPts.push({
        x: via.center.x + radius * Math.cos(angle),
        y: via.center.y + radius * Math.sin(angle),
      })
    }
    obstacleRings.push(viaPts)
  }

  // Rects: corners only (4 points per rect)
  for (const rect of rects) {
    const halfWidth = rect.width / 2 + clearance
    const halfHeight = rect.height / 2 + clearance
    const rectPts: Point[] = [
      rotatePoint({ localX: -halfWidth, localY: -halfHeight, rect }),
      rotatePoint({ localX: halfWidth, localY: -halfHeight, rect }),
      rotatePoint({ localX: halfWidth, localY: halfHeight, rect }),
      rotatePoint({ localX: -halfWidth, localY: halfHeight, rect }),
    ]
    obstacleRings.push(rectPts)
  }

  // Polygons: offset vertices only
  for (const polygon of polygons) {
    if (polygon.points.length < 3) continue
    const offsetPoints = getOffsetPolygonPoints({
      polygon,
      clearance,
      verticesOnly: true,
    })
    obstacleRings.push(offsetPoints)
  }

  // In layered mode, distinct obstacle boundaries must remain present even
  // when their XY projections overlap, otherwise availability transitions
  // between layer masks disappear from the nav mesh.
  const mergedRings = preserveObstacleBoundaries
    ? obstacleRings
    : unionObstacleBoundaries(obstacleRings)

  for (const ring of mergedRings) {
    ringBoundaries.push(constraintEdges.length)
    addRing(ring, allPts, constraintEdges)
  }

  // Resolve crossing constraint edges from overlapping obstacle boundaries
  const resolved = resolveConstraintCrossings(
    allPts,
    constraintEdges,
    ringBoundaries,
  )

  // Tiny per-point jitter (~1e-6) prevents degenerate collinear inputs
  const jitteredPts = resolved.pts.map((pt, i) => ({
    x: pt.x + ((i % 7) - 3) * 1e-6,
    y: pt.y + ((i % 5) - 2) * 1e-6,
  }))

  return {
    pts: jitteredPts,
    constraintEdges: resolved.constraintEdges,
    hadCrossings: resolved.hadCrossings,
  }
}
