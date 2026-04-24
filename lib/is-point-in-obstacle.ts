import { isPointInOrNearPolygon } from "./isPointInOrNearPolygon"
import type { Point, Polygon, Rect, Via } from "./types"

export const isPointInVia = (params: {
  point: Point
  via: Via
  clearance: number
}): boolean => {
  const { point, via, clearance } = params
  const dx = point.x - via.center.x
  const dy = point.y - via.center.y
  const radius = via.diameter / 2 + clearance
  return dx * dx + dy * dy <= radius * radius + 1e-9
}

export const isPointInRect = (params: {
  point: Point
  rect: Rect
  clearance: number
}): boolean => {
  const { point, rect, clearance } = params
  const cos = Math.cos(-rect.ccwRotation)
  const sin = Math.sin(-rect.ccwRotation)
  const dx = point.x - rect.center.x
  const dy = point.y - rect.center.y
  const localX = dx * cos - dy * sin
  const localY = dx * sin + dy * cos
  return (
    Math.abs(localX) <= rect.width / 2 + clearance + 1e-9 &&
    Math.abs(localY) <= rect.height / 2 + clearance + 1e-9
  )
}

export const isPointInPolygonObstacle = (params: {
  point: Point
  polygon: Polygon
  clearance: number
}): boolean =>
  isPointInOrNearPolygon({
    px: params.point.x,
    py: params.point.y,
    polygonPoints: params.polygon.points,
    clearance: params.clearance,
  })
