import { expect, test } from "bun:test"
import { buildPolyHyperGraphFromRegions } from "../lib/build-poly-hyper-graph"
import { computeConvexRegions } from "../lib/computeConvexRegions"
import type { Point } from "../lib/types"

const centroid = (polygon: Point[]) =>
  polygon.reduce(
    (sum, point) => ({
      x: sum.x + point.x / polygon.length,
      y: sum.y + point.y / polygon.length,
    }),
    { x: 0, y: 0 },
  )

test("availableZ skips only the copper-pour layer for regions inside the pour", () => {
  const result = computeConvexRegions({
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    rects: [
      {
        center: { x: 5, y: 5 },
        width: 4,
        height: 4,
        ccwRotation: 0,
        layers: ["inner1"],
        isCopperPour: true,
      },
    ],
    clearance: 0,
    concavityTolerance: 0,
    layerCount: 4,
    useConstrainedDelaunay: true,
    usePolyanyaMerge: true,
  })

  const regionIndexInsidePour = result.regions.findIndex((region) => {
    const c = centroid(region)
    return c.x > 3 && c.x < 7 && c.y > 3 && c.y < 7
  })

  expect(regionIndexInsidePour).toBeGreaterThanOrEqual(0)
  expect(result.availableZ?.[regionIndexInsidePour]).toEqual([0, 2, 3])
})

test("availableZ removes fully blocked all-layer obstacle interiors", () => {
  const result = computeConvexRegions({
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    rects: [
      {
        center: { x: 5, y: 5 },
        width: 4,
        height: 4,
        ccwRotation: 0,
      },
    ],
    clearance: 0,
    concavityTolerance: 0,
    layerCount: 4,
    useConstrainedDelaunay: true,
    usePolyanyaMerge: true,
  })

  const hasRegionInsideObstacle = result.regions.some((region) => {
    const c = centroid(region)
    return c.x > 3 && c.x < 7 && c.y > 3 && c.y < 7
  })

  expect(hasRegionInsideObstacle).toBe(false)
})

test("buildPolyHyperGraphFromRegions emits z-specific shared ports", () => {
  const graph = buildPolyHyperGraphFromRegions({
    regions: [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
      ],
    ],
    availableZ: [
      [0, 2, 3],
      [0, 1, 2, 3],
    ],
    layerCount: 4,
  })

  expect(graph.regions).toHaveLength(2)
  expect(graph.ports.map((port) => port.d.z).sort()).toEqual([0, 2, 3])
  expect(graph.regions[0]?.pointIds).toHaveLength(3)
  expect(graph.regions[1]?.pointIds).toHaveLength(3)
})
