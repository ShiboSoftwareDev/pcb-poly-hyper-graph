import cdt2d from "cdt2d"
import type { Point, Triangle } from "./types"

export const constrainedDelaunay = (
  pts: Point[],
  constraintEdges: [number, number][],
  options: { includeConstraintInteriors?: boolean } = {},
): Triangle[] => {
  const coords: [number, number][] = pts.map((p) => [p.x, p.y])
  return cdt2d(coords, constraintEdges, {
    exterior: options.includeConstraintInteriors ? true : false,
  })
}
