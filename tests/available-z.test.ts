import { expect, test } from "bun:test"
import { loadSerializedHyperGraphAsPoly } from "tiny-hypergraph/lib/index"
import {
  DEFAULT_OBSTACLE_MARGIN,
  DEFAULT_TRACE_WIDTH,
  MAX_DENSE_PORTS_BEFORE_DECIMATION,
  PORT_MARGIN_FROM_SEGMENT_ENDPOINT,
  PORT_SPACING,
  applySerializedRegionNetIdsToLoadedProblem,
  buildPolyHyperGraphFromRegions,
} from "../lib/build-poly-hyper-graph"
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
    portSpacing: 10,
    portMarginFromSegmentEndpoint: 0.1,
  })

  expect(graph.regions).toHaveLength(2)
  expect(graph.ports.map((port) => port.d.z).sort()).toEqual([0, 2, 3])
  expect(graph.regions[0]?.pointIds).toHaveLength(3)
  expect(graph.regions[1]?.pointIds).toHaveLength(3)
})

test("buildPolyHyperGraphFromRegions spaces ports along long shared segments", () => {
  const graph = buildPolyHyperGraphFromRegions({
    regions: [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 10, y: 10 },
      ],
    ],
    availableZ: [[0], [0]],
    layerCount: 1,
    portSpacing: 2,
    portMarginFromSegmentEndpoint: 1,
  })

  const sharedPorts = graph.ports.filter(
    (port) => port.region1Id === "free-0" && port.region2Id === "free-1",
  )

  expect(sharedPorts).toHaveLength(5)
  expect(sharedPorts.map((port) => port.d.x)).toEqual([10, 10, 10, 10, 10])
  expect(sharedPorts.map((port) => port.d.y).sort((a, b) => a - b)).toEqual([
    1, 3, 5, 7, 9,
  ])
  expect(
    sharedPorts
      .map((port) => port.d.distToCentermostPortOnZ)
      .sort((a, b) => a - b),
  ).toEqual([0, 2, 2, 4, 4])
  expect(graph.regions[0]?.pointIds).toHaveLength(5)
  expect(graph.regions[1]?.pointIds).toHaveLength(5)
})

test("buildPolyHyperGraphFromRegions defaults to rectdiff-style side ports", () => {
  expect(DEFAULT_TRACE_WIDTH).toBe(0.1)
  expect(DEFAULT_OBSTACLE_MARGIN).toBe(0.15)
  expect(PORT_SPACING).toBe(0.25)
  expect(PORT_MARGIN_FROM_SEGMENT_ENDPOINT).toBe(0.1875)
  expect(MAX_DENSE_PORTS_BEFORE_DECIMATION).toBe(5)

  const graph = buildPolyHyperGraphFromRegions({
    regions: [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 1 },
        { x: 0, y: 1 },
      ],
      [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 1 },
        { x: 10, y: 1 },
      ],
    ],
    availableZ: [[0], [0]],
    layerCount: 1,
  })

  expect(graph.ports.map((port) => port.d.y).sort((a, b) => a - b)).toEqual([
    0.1875, 0.5, 0.8125,
  ])
})

test("buildPolyHyperGraphFromRegions decimates dense ports on long shared edges", () => {
  const graph = buildPolyHyperGraphFromRegions({
    regions: [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      [
        { x: 100, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 100 },
        { x: 100, y: 100 },
      ],
    ],
    availableZ: [[0], [0]],
    layerCount: 1,
    portSpacing: 2,
    portMarginFromSegmentEndpoint: 1,
  })

  const sharedPorts = graph.ports.filter(
    (port) => port.region1Id === "free-0" && port.region2Id === "free-1",
  )

  expect(sharedPorts).toHaveLength(17)
  expect(sharedPorts[0]?.d.y).toBe(1)
  expect(sharedPorts.at(-1)?.d.y).toBe(99)
  expect(sharedPorts.some((port) => port.d.distToCentermostPortOnZ === 0)).toBe(
    true,
  )
})

test("buildPolyHyperGraphFromRegions marks very short midpoint ports as cramped", () => {
  const graph = buildPolyHyperGraphFromRegions({
    regions: [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0.2 },
        { x: 0, y: 0.2 },
      ],
      [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 0.2 },
        { x: 10, y: 0.2 },
      ],
    ],
    availableZ: [[0], [0]],
    layerCount: 1,
    portSpacing: 1,
    portMarginFromSegmentEndpoint: 0,
  })

  expect(graph.ports).toHaveLength(1)
  expect(graph.ports[0]?.d.cramped).toBe(true)
})

test("buildPolyHyperGraphFromRegions emits net-reserved obstacle regions with boundary ports", () => {
  const result = computeConvexRegions({
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    rects: [
      {
        center: { x: 5, y: 5 },
        width: 2,
        height: 2,
        ccwRotation: 0,
        layers: ["top"],
      },
    ],
    clearance: 0,
    concavityTolerance: 0,
    layerCount: 1,
    useConstrainedDelaunay: true,
    usePolyanyaMerge: false,
  })

  const graph = buildPolyHyperGraphFromRegions({
    regions: result.regions,
    availableZ: result.availableZ,
    layerCount: 1,
    connections: [
      {
        connectionId: "source_trace_a",
        start: { x: 5, y: 5, z: 0, pointId: "pcb_port_a" },
        end: { x: 1, y: 1, z: 0, pointId: "pcb_port_b" },
      },
    ],
    obstacleRegions: [
      {
        regionId: "pad-a",
        polygon: [
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 6, y: 6 },
          { x: 4, y: 6 },
        ],
        availableZ: [0],
        connectedTo: ["source_trace_a", "pcb_port_a"],
      },
    ],
  })

  const obstacleRegion = graph.regions.find(
    (region) => region.regionId === "pad-a",
  )
  const terminalStartPort = graph.ports.find(
    (port) => port.portId === "terminal-start-port-source_trace_a",
  )
  const obstacleBoundaryPorts = graph.ports.filter(
    (port) =>
      (port.region1Id === "pad-a" || port.region2Id === "pad-a") &&
      !port.portId.startsWith("terminal-"),
  )

  expect(obstacleRegion?.d._containsObstacle).toBe(true)
  expect(obstacleRegion?.d._containsTarget).toBe(true)
  expect(obstacleRegion?.d.netId).toBe(0)
  expect(obstacleRegion?.pointIds.length).toBeGreaterThan(1)
  expect(terminalStartPort?.region1Id).toBe("pad-a")
  expect(obstacleBoundaryPorts.length).toBeGreaterThan(0)

  const loaded = loadSerializedHyperGraphAsPoly(graph as any)
  const appliedCount = applySerializedRegionNetIdsToLoadedProblem(loaded, graph)
  const obstacleRegionIndex =
    loaded.mapping.serializedRegionIdToRegionId.get("pad-a")

  expect(appliedCount).toBe(1)
  expect(obstacleRegionIndex).toBeDefined()
  expect(loaded.problem.regionNetId[obstacleRegionIndex!]).toBe(0)
})

test("buildPolyHyperGraphFromRegions connects overlapping same-net obstacle regions", () => {
  const graph = buildPolyHyperGraphFromRegions({
    regions: [],
    layerCount: 1,
    connections: [
      {
        connectionId: "source_trace_a",
        mutuallyConnectedNetworkId: "source_net_a",
        start: { x: 0, y: 0, z: 0, pointId: "pcb_port_a" },
        end: { x: 1.5, y: 0, z: 0, pointId: "pcb_port_b" },
      },
    ],
    obstacleRegions: [
      {
        regionId: "pad-a",
        polygon: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ],
        availableZ: [0],
        connectedTo: ["source_net_a", "pcb_port_a"],
      },
      {
        regionId: "pad-b",
        polygon: [
          { x: 0.5, y: -1 },
          { x: 2.5, y: -1 },
          { x: 2.5, y: 1 },
          { x: 0.5, y: 1 },
        ],
        availableZ: [0],
        connectedTo: ["source_net_a", "pcb_port_b"],
      },
    ],
  })

  const obstacleContactPorts = graph.ports.filter(
    (port) =>
      port.portId.includes("::obstacle-contact") &&
      ((port.region1Id === "pad-a" && port.region2Id === "pad-b") ||
        (port.region1Id === "pad-b" && port.region2Id === "pad-a")),
  )

  expect(obstacleContactPorts).toHaveLength(1)
  expect(
    graph.regions.find((region) => region.regionId === "pad-a")?.pointIds,
  ).toContain(obstacleContactPorts[0]!.portId)
  expect(
    graph.regions.find((region) => region.regionId === "pad-b")?.pointIds,
  ).toContain(obstacleContactPorts[0]!.portId)
})

test("buildPolyHyperGraphFromRegions connects obstacle ports across two-sided layered boundary edges", () => {
  const graph = buildPolyHyperGraphFromRegions({
    regions: [
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ],
      [
        { x: 2, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 2 },
        { x: 2, y: 2 },
      ],
    ],
    availableZ: [[1], [0, 1]],
    layerCount: 2,
    connections: [
      {
        connectionId: "source_trace_a",
        start: { x: 1, y: 1, z: 0, pointId: "pcb_port_a" },
        end: { x: 3, y: 1, z: 0, pointId: "pcb_port_b" },
      },
    ],
    obstacleRegions: [
      {
        regionId: "pad-a",
        polygon: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 2, y: 2 },
          { x: 0, y: 2 },
        ],
        availableZ: [0],
        connectedTo: ["source_trace_a", "pcb_port_a"],
      },
    ],
  })

  const topBoundaryPorts = graph.ports.filter(
    (port) =>
      port.region1Id === "free-1" &&
      port.region2Id === "pad-a" &&
      port.d.z === 0,
  )
  const blockedInteriorPorts = graph.ports.filter(
    (port) =>
      port.region1Id === "free-0" &&
      port.region2Id === "pad-a" &&
      port.d.z === 0,
  )

  expect(topBoundaryPorts.length).toBeGreaterThan(0)
  expect(topBoundaryPorts).toHaveLength(1)
  expect(topBoundaryPorts[0]?.d.x).toBe(2)
  expect(topBoundaryPorts[0]?.d.y).toBe(1)
  expect(blockedInteriorPorts).toHaveLength(0)
})

test("buildPolyHyperGraphFromRegions does not emit coincident same-layer ports across obstacle boundaries", () => {
  const graph = buildPolyHyperGraphFromRegions({
    regions: [
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ],
      [
        { x: 2, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 2 },
        { x: 2, y: 2 },
      ],
    ],
    availableZ: [[0], [0]],
    layerCount: 1,
    portSpacing: 10,
    portMarginFromSegmentEndpoint: 0,
    connections: [
      {
        connectionId: "source_trace_a",
        mutuallyConnectedNetworkId: "source_net_a",
        start: { x: 3, y: 1, z: 0, pointId: "pcb_port_a" },
        end: { x: 1, y: 1, z: 0, pointId: "pcb_port_b" },
      },
    ],
    obstacleRegions: [
      {
        regionId: "pad-a",
        polygon: [
          { x: 2, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 2 },
          { x: 2, y: 2 },
        ],
        availableZ: [0],
        connectedTo: ["source_net_a", "pcb_port_a"],
      },
    ],
  })

  const boundaryPorts = graph.ports.filter(
    (port) => !port.portId.startsWith("terminal-"),
  )
  const sharedObstacleEdgePorts = boundaryPorts.filter(
    (port) =>
      Math.abs(port.d.x - 2) < 1e-9 &&
      (port.region1Id === "pad-a" ||
        port.region2Id === "pad-a" ||
        (port.region1Id === "free-0" && port.region2Id === "free-1") ||
        (port.region1Id === "free-1" && port.region2Id === "free-0")),
  )
  const sharedObstacleBoundaryPorts = sharedObstacleEdgePorts.filter((port) =>
    port.portId.includes("::obstacle"),
  )
  const duplicatePortGroups = Object.values(
    Object.groupBy(
      boundaryPorts,
      (port) => `${port.d.x},${port.d.y},${port.d.z}`,
    ),
  ).filter((ports) => (ports?.length ?? 0) > 1)

  expect(sharedObstacleEdgePorts).toHaveLength(1)
  expect(sharedObstacleBoundaryPorts).toHaveLength(0)
  expect(duplicatePortGroups).toEqual([])
})
