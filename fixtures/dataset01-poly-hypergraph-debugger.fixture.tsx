// @ts-nocheck
import * as dataset01 from "@tscircuit/autorouting-dataset-01"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { useEffect, useMemo, useState } from "react"
import {
  applySerializedRegionNetIdsToLoadedProblem,
  buildPolyHyperGraphFromRegions,
  computeConvexRegions,
  getAvailableZFromMask,
  getObstacleLayerMask,
  getOffsetPolygonPoints,
  PORT_MARGIN_FROM_SEGMENT_ENDPOINT,
  PORT_SPACING,
  type LayerMergeMode,
  type PolyHyperGraphObstacleRegion,
  type Polygon,
  type Rect,
  type SerializedPolyHyperGraph,
} from "../lib/index"

const tinyHypergraphModuleLoaders = import.meta.glob(
  "../node_modules/tiny-hypergraph/lib/index.ts",
) as Record<string, () => Promise<any>>

const loadTinyHypergraphModule =
  tinyHypergraphModuleLoaders["../node_modules/tiny-hypergraph/lib/index.ts"] ??
  (() => {
    throw new Error("Could not find tiny-hypergraph/lib/index.ts")
  })

type SimpleRouteConnectionPoint = {
  x: number
  y: number
  layer?: string
  layers?: string[]
  z?: number
  zLayers?: number[]
  pointId?: string
  pcb_port_id?: string
}

type SimpleRouteConnection = {
  name: string
  rootConnectionName?: string
  pointsToConnect: SimpleRouteConnectionPoint[]
}

type SimpleRouteObstacle = {
  type: string
  center: { x: number; y: number }
  width: number
  height: number
  layers?: string[]
  zLayers?: number[]
  ccwRotationDegrees?: number
  isCopperPour?: boolean
  connectedTo?: string[]
}

type SimpleRouteJson = {
  layerCount: number
  minTraceWidth: number
  defaultObstacleMargin?: number
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  obstacles?: SimpleRouteObstacle[]
  connections: SimpleRouteConnection[]
}

const sampleEntries = Object.entries(dataset01)
  .filter((entry): entry is [string, SimpleRouteJson] => {
    const value = entry[1] as Partial<SimpleRouteJson>
    return (
      typeof value === "object" &&
      value !== null &&
      value.bounds !== undefined &&
      Array.isArray(value.connections) &&
      Array.isArray(value.obstacles)
    )
  })
  .sort(([a], [b]) => a.localeCompare(b))

const sampleByName = new Map(sampleEntries)

const defaultSampleName =
  sampleEntries.find(([name]) => name === "circuit001")?.[0] ??
  sampleEntries[0]?.[0] ??
  ""

const DEFAULT_CONCAVITY_TOLERANCE = 0.2
const DEFAULT_EFFORT = 1

const getLayerName = (z: number, layerCount: number) => {
  if (z === 0) return "Top"
  if (z === layerCount - 1) return "Bottom"
  return `Z${z}`
}

const getRegionAvailabilityKind = (
  availableZ: readonly number[] | undefined,
  layerCount: number,
) => {
  const hasTop = availableZ?.includes(0) ?? false
  const hasBottom = availableZ?.includes(Math.max(0, layerCount - 1)) ?? false
  if (hasTop && hasBottom) return "shared"
  if (hasTop) return "top"
  if (hasBottom) return "bottom"
  return "blocked"
}

const getLayerRegionFill = (
  availableZ: readonly number[] | undefined,
  layerCount: number,
) => {
  const kind = getRegionAvailabilityKind(availableZ, layerCount)
  if (kind === "shared") return "rgba(124, 58, 237, 0.24)"
  if (kind === "top") return "rgba(220, 38, 38, 0.28)"
  if (kind === "bottom") return "rgba(37, 99, 235, 0.28)"
  return "rgba(148, 163, 184, 0.18)"
}

const getLayerRegionStroke = (
  availableZ: readonly number[] | undefined,
  layerCount: number,
) => {
  const kind = getRegionAvailabilityKind(availableZ, layerCount)
  if (kind === "shared") return "rgba(124, 58, 237, 0.75)"
  if (kind === "top") return "rgba(220, 38, 38, 0.85)"
  if (kind === "bottom") return "rgba(37, 99, 235, 0.85)"
  return "rgba(100, 116, 139, 0.5)"
}

const getAvailableZLabel = (
  availableZ: readonly number[] | undefined,
  layerCount: number,
) =>
  `available: ${
    availableZ?.map((z) => `${getLayerName(z, layerCount)} z${z}`).join(", ") ??
    "none"
  }`

const applyLayerRegionColors = (
  graphics: any,
  graph: SerializedPolyHyperGraph,
  layerCount: number,
) => {
  if (!Array.isArray(graphics?.polygons)) return graphics

  graphics.polygons = graphics.polygons.map((polygon: any, index: number) => {
    const availableZ = graph.regions[index]?.d.availableZ
    if (!availableZ) return polygon

    const availabilityLabel = getAvailableZLabel(availableZ, layerCount)
    return {
      ...polygon,
      fill: getLayerRegionFill(availableZ, layerCount),
      stroke: getLayerRegionStroke(availableZ, layerCount),
      label:
        typeof polygon.label === "string"
          ? `${polygon.label}\n${availabilityLabel}`
          : availabilityLabel,
    }
  })

  return graphics
}

const getRotationRadians = (obstacle: SimpleRouteObstacle) =>
  ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180

const getRectPoints = (obstacle: SimpleRouteObstacle, clearance = 0) => {
  const halfWidth = obstacle.width / 2 + clearance
  const halfHeight = obstacle.height / 2 + clearance
  const rotation = getRotationRadians(obstacle)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return [
    { localX: -halfWidth, localY: -halfHeight },
    { localX: halfWidth, localY: -halfHeight },
    { localX: halfWidth, localY: halfHeight },
    { localX: -halfWidth, localY: halfHeight },
  ].map(({ localX, localY }) => ({
    x: obstacle.center.x + localX * cos - localY * sin,
    y: obstacle.center.y + localX * sin + localY * cos,
  }))
}

const getOvalPoints = (obstacle: SimpleRouteObstacle) => {
  const rx = obstacle.width / 2
  const ry = obstacle.height / 2
  const rotation = getRotationRadians(obstacle)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const segmentCount = 8
  return Array.from({ length: segmentCount }, (_, index) => {
    const angle = (2 * Math.PI * index) / segmentCount
    const localX = rx * Math.cos(angle)
    const localY = ry * Math.sin(angle)
    return {
      x: obstacle.center.x + localX * cos - localY * sin,
      y: obstacle.center.y + localX * sin + localY * cos,
    }
  })
}

const getRectsFromSrj = (srj: SimpleRouteJson): Rect[] =>
  (srj.obstacles ?? [])
    .filter((obstacle) => obstacle.type === "rect")
    .map((obstacle) => ({
      center: obstacle.center,
      width: obstacle.width,
      height: obstacle.height,
      ccwRotation: getRotationRadians(obstacle),
      layers: obstacle.layers,
      zLayers: obstacle.zLayers,
      isCopperPour: obstacle.isCopperPour,
    }))

const getOvalPolygonsFromSrj = (srj: SimpleRouteJson): Polygon[] =>
  (srj.obstacles ?? [])
    .filter((obstacle) => obstacle.type === "oval")
    .map((obstacle) => {
      const points = getOvalPoints(obstacle)
      return {
        points,
        layers: obstacle.layers,
        zLayers: obstacle.zLayers,
        isCopperPour: obstacle.isCopperPour,
      }
    })

const getConnectedObstacleRegionsFromSrj = (
  srj: SimpleRouteJson,
  clearance: number,
): PolyHyperGraphObstacleRegion[] =>
  (srj.obstacles ?? []).flatMap((obstacle, obstacleIndex) => {
    if (
      !Array.isArray(obstacle.connectedTo) ||
      obstacle.connectedTo.length === 0
    ) {
      return []
    }

    const availableZ = getAvailableZFromMask(
      getObstacleLayerMask(obstacle as any, srj.layerCount),
      srj.layerCount,
    )
    if (availableZ.length === 0) return []

    let polygon: { x: number; y: number }[]
    if (obstacle.type === "rect") {
      polygon = getRectPoints(obstacle, clearance)
    } else if (obstacle.type === "oval") {
      polygon = getOffsetPolygonPoints({
        polygon: {
          points: getOvalPoints(obstacle),
          layers: obstacle.layers,
          zLayers: obstacle.zLayers,
          isCopperPour: obstacle.isCopperPour,
        },
        clearance,
        verticesOnly: true,
      })
    } else {
      return []
    }

    return [
      {
        regionId: `connected-obstacle-${obstacleIndex}`,
        polygon,
        availableZ,
        connectedTo: obstacle.connectedTo,
        d: {
          obstacleIndex,
          obstacleType: obstacle.type,
          connectedTo: obstacle.connectedTo,
        },
      },
    ]
  })

const getRoutePairsFromSrj = (srj: SimpleRouteJson) =>
  srj.connections.flatMap((connection) => {
    const points = connection.pointsToConnect ?? []
    if (points.length < 2) return []

    const start = points[0]!
    return points.slice(1).map((end, index) => ({
      connectionId: `${connection.name}::${index}`,
      mutuallyConnectedNetworkId:
        connection.rootConnectionName ?? connection.name,
      start,
      end,
      simpleRouteConnection: connection,
    }))
  })

const getRegionCostStats = (solver: any) => {
  const costs =
    solver.state?.regionIntersectionCaches?.map(
      (cache: { existingRegionCost?: number }) => cache.existingRegionCost ?? 0,
    ) ?? []
  const total = costs.reduce((sum: number, cost: number) => sum + cost, 0)
  return {
    max: costs.length > 0 ? Math.max(...costs) : 0,
    avg: costs.length > 0 ? total / costs.length : 0,
  }
}

const createPolySolverForSample = (params: {
  tinyHypergraph: any
  sampleName: string
  srj: SimpleRouteJson
  concavityTolerance: number
  layerMergeMode: LayerMergeMode
  effort: number
  portSpacing: number
  portMarginFromSegmentEndpoint: number
}) => {
  const {
    tinyHypergraph,
    sampleName,
    srj,
    concavityTolerance,
    layerMergeMode,
    effort,
    portSpacing,
    portMarginFromSegmentEndpoint,
  } = params
  const { PolyHyperGraphSolver, loadSerializedHyperGraphAsPoly } =
    tinyHypergraph
  const clearance = srj.defaultObstacleMargin ?? srj.minTraceWidth
  const convexRegions = computeConvexRegions({
    bounds: srj.bounds,
    rects: getRectsFromSrj(srj),
    polygons: getOvalPolygonsFromSrj(srj),
    clearance,
    concavityTolerance,
    layerCount: srj.layerCount,
    layerMergeMode,
    useConstrainedDelaunay: true,
    usePolyanyaMerge: false,
    viaSegments: 8,
  })
  const graph = buildPolyHyperGraphFromRegions({
    regions: convexRegions.regions,
    availableZ: convexRegions.availableZ,
    layerCount: srj.layerCount,
    connections: getRoutePairsFromSrj(srj),
    obstacleRegions: getConnectedObstacleRegionsFromSrj(srj, clearance),
    portSpacing,
    portMarginFromSegmentEndpoint,
  })
  const loaded = loadSerializedHyperGraphAsPoly(graph)
  const reservedRegionCount = applySerializedRegionNetIdsToLoadedProblem(
    loaded,
    graph,
  )
  const solverOptions = {
    DISTANCE_TO_COST: 0.05,
    RIP_THRESHOLD_START: 0.05,
    RIP_THRESHOLD_END: 0.8,
    RIP_CONGESTION_REGION_COST_FACTOR: 0.1,
    RIP_THRESHOLD_RAMP_ATTEMPTS: Math.max(1, Math.ceil(10 * effort)),
    MAX_ITERATIONS: Math.max(100_000, Math.ceil(10_000_000 * effort)),
    portSpacing,
    portMarginFromSegmentEndpoint,
  }
  const solver = new PolyHyperGraphSolver(
    loaded.topology,
    loaded.problem,
    solverOptions,
  )

  solver.getConstructorParams = () => [
    loaded.topology,
    loaded.problem,
    solverOptions,
  ]
  solver.getSolverName = () => `Dataset01PolyHyperGraphSolver(${sampleName})`
  const visualize = solver.visualize.bind(solver)
  solver.visualize = () =>
    applyLayerRegionColors(visualize(), graph, srj.layerCount)

  return {
    solver,
    graph,
    convexRegions,
    routePairCount: graph.connections.length,
    clearance,
    reservedRegionCount,
  }
}

export default function Dataset01PolyHyperGraphDebuggerFixture() {
  const [sampleName, setSampleName] = useState(defaultSampleName)
  const [concavityTolerance, setConcavityTolerance] = useState(
    DEFAULT_CONCAVITY_TOLERANCE,
  )
  const [layerMergeMode, setLayerMergeMode] = useState<LayerMergeMode>("same")
  const [effort, setEffort] = useState(DEFAULT_EFFORT)
  const [portSpacing, setPortSpacing] = useState(PORT_SPACING)
  const [portMarginFromSegmentEndpoint, setPortMarginFromSegmentEndpoint] =
    useState(PORT_MARGIN_FROM_SEGMENT_ENDPOINT)
  const [tinyHypergraph, setTinyHypergraph] = useState<any>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let canceled = false
    loadTinyHypergraphModule()
      .then((module) => {
        if (!canceled) setTinyHypergraph(module)
      })
      .catch((error) => {
        if (!canceled) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      canceled = true
    }
  }, [])

  const srj = sampleByName.get(sampleName) ?? sampleEntries[0]?.[1]

  const debugData = useMemo(() => {
    if (!srj || !sampleName || !tinyHypergraph) return null
    return createPolySolverForSample({
      tinyHypergraph,
      sampleName,
      srj,
      concavityTolerance,
      layerMergeMode,
      effort,
      portSpacing,
      portMarginFromSegmentEndpoint,
    })
  }, [
    srj,
    tinyHypergraph,
    sampleName,
    concavityTolerance,
    layerMergeMode,
    effort,
    portSpacing,
    portMarginFromSegmentEndpoint,
  ])

  const solverKey = JSON.stringify({
    sampleName,
    concavityTolerance,
    layerMergeMode,
    effort,
    portSpacing,
    portMarginFromSegmentEndpoint,
  })

  const regionCostStats = debugData
    ? getRegionCostStats(debugData.solver)
    : { max: 0, avg: 0 }

  if (loadError) {
    return <div style={{ padding: 16 }}>Failed to load solver: {loadError}</div>
  }

  if (!srj || !debugData) {
    return <div style={{ padding: 16 }}>Loading dataset01 solver...</div>
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f6f8fc",
        color: "#1d2430",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 14,
          padding: "12px 16px",
          borderBottom: "1px solid #d6dde8",
          background: "#ffffff",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>
          Dataset01 PolyHyperGraph
        </h1>

        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Sample
          <select
            data-testid="dataset01-sample-select"
            value={sampleName}
            onChange={(event) => setSampleName(event.target.value)}
          >
            {sampleEntries.map(([name, sample]) => (
              <option key={name} value={name}>
                {name} - {sample.connections.length} nets
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Concavity
          <input
            data-testid="concavity-input"
            type="number"
            min={0}
            step={0.1}
            value={concavityTolerance}
            onChange={(event) =>
              setConcavityTolerance(Number(event.target.value))
            }
            style={{ width: 76 }}
          />
        </label>

        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Merge
          <select
            value={layerMergeMode}
            onChange={(event) =>
              setLayerMergeMode(event.target.value as LayerMergeMode)
            }
          >
            <option value="same">same</option>
            <option value="intersection">intersection</option>
          </select>
        </label>

        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Effort
          <input
            type="number"
            min={0.01}
            max={1}
            step={0.01}
            value={effort}
            onChange={(event) => setEffort(Number(event.target.value))}
            style={{ width: 76 }}
          />
        </label>

        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Port spacing
          <input
            type="number"
            min={0.01}
            step={0.05}
            value={portSpacing}
            onChange={(event) => setPortSpacing(Number(event.target.value))}
            style={{ width: 76 }}
          />
        </label>

        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Port margin
          <input
            type="number"
            min={0}
            step={0.05}
            value={portMarginFromSegmentEndpoint}
            onChange={(event) =>
              setPortMarginFromSegmentEndpoint(Number(event.target.value))
            }
            style={{ width: 76 }}
          />
        </label>

        <div style={{ fontSize: 12, color: "#5d6878" }}>
          {debugData.convexRegions.regions.length} regions,{" "}
          {debugData.graph.ports.length} ports, {debugData.routePairCount}{" "}
          routes, {debugData.reservedRegionCount} reserved, clearance{" "}
          {debugData.clearance.toFixed(3)}, max cost{" "}
          {regionCostStats.max.toFixed(4)}, avg cost{" "}
          {regionCostStats.avg.toFixed(4)}
        </div>
      </div>

      <GenericSolverDebugger
        key={solverKey}
        solver={debugData.solver}
        animationSpeed={25}
      />
    </div>
  )
}
