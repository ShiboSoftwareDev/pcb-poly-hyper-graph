import {
  getAvailableZFromMask,
  getAllLayerMask,
  getObstacleLayerMask,
} from "./layer-utils"
import {
  isPointInPolygonObstacle,
  isPointInRect,
  isPointInVia,
} from "./is-point-in-obstacle"
import type { Bounds, Point, Polygon, Rect, Triangle, Via } from "./types"

const pointInBounds = (point: Point, bounds: Bounds): boolean =>
  point.x >= bounds.minX - 1e-9 &&
  point.x <= bounds.maxX + 1e-9 &&
  point.y >= bounds.minY - 1e-9 &&
  point.y <= bounds.maxY + 1e-9

const getBlockedLayerMaskAtPoint = (params: {
  point: Point
  vias: Via[]
  rects: Rect[]
  polygons: Polygon[]
  clearance: number
  layerCount: number
}) => {
  const { point, vias, rects, polygons, clearance, layerCount } = params
  let blockedMask = 0

  for (const via of vias) {
    if (isPointInVia({ point, via, clearance })) {
      blockedMask |= getObstacleLayerMask(via, layerCount)
    }
  }

  for (const rect of rects) {
    if (isPointInRect({ point, rect, clearance })) {
      blockedMask |= getObstacleLayerMask(rect, layerCount)
    }
  }

  for (const polygon of polygons) {
    if (isPointInPolygonObstacle({ point, polygon, clearance })) {
      blockedMask |= getObstacleLayerMask(polygon, layerCount)
    }
  }

  return blockedMask
}

export const filterTrisByAvailableZ = (params: {
  triangles: Triangle[]
  pts: Point[]
  bounds: Bounds
  vias: Via[]
  clearance: number
  rects: Rect[]
  polygons: Polygon[]
  layerCount: number
}): { triangles: Triangle[]; triangleAvailableZ: number[][] } => {
  const {
    triangles,
    pts,
    bounds,
    vias,
    clearance,
    rects,
    polygons,
    layerCount,
  } = params
  const allLayerMask = getAllLayerMask(layerCount)
  const filteredTriangles: Triangle[] = []
  const triangleAvailableZ: number[][] = []

  for (const [a, b, c] of triangles) {
    const pa = pts[a]
    const pb = pts[b]
    const pc = pts[c]
    if (!pa || !pb || !pc) continue

    const centroid = {
      x: (pa.x + pb.x + pc.x) / 3,
      y: (pa.y + pb.y + pc.y) / 3,
    }
    if (!pointInBounds(centroid, bounds)) continue

    const blockedMask = getBlockedLayerMaskAtPoint({
      point: centroid,
      vias,
      rects,
      polygons,
      clearance,
      layerCount,
    })

    const availableMask = allLayerMask & ~blockedMask
    if (availableMask === 0) continue

    filteredTriangles.push([a, b, c])
    triangleAvailableZ.push(getAvailableZFromMask(availableMask, layerCount))
  }

  return { triangles: filteredTriangles, triangleAvailableZ }
}
