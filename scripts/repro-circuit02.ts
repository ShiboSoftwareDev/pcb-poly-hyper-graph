import { existsSync } from "node:fs"
import {
  getLocalPcbPolyIndexPath,
  getLocalTscircuitAutorouterBundle,
} from "./load-tscircuit-autorouter-with-local-pcb-poly"
import {
  applySerializedRegionNetIdsToLoadedProblem,
  buildPolyHyperGraphFromRegions,
  computeConvexRegions,
  getAvailableZFromMask,
  getObstacleLayerMask,
  getOffsetPolygonPoints,
  type LayerMergeMode,
  type PolyHyperGraphObstacleRegion,
  type Polygon,
  type Rect,
} from "../lib/index"

type SimpleRouteConnection = {
  name: string
  rootConnectionName?: string
  pointsToConnect: Array<{
    x: number
    y: number
    layer?: string
    layers?: string[]
    z?: number
    zLayers?: number[]
    pointId?: string
    pcb_port_id?: string
  }>
}

type SimpleRouteJson = {
  layerCount: number
  minTraceWidth: number
  defaultObstacleMargin?: number
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  obstacles?: Array<{
    type: "rect" | "oval"
    center: { x: number; y: number }
    width: number
    height: number
    layers?: string[]
    zLayers?: number[]
    ccwRotationDegrees?: number
    isCopperPour?: boolean
    connectedTo?: string[]
  }>
  connections: SimpleRouteConnection[]
}

type TscircuitPolyPipelineSolver = {
  solved?: boolean
  failed?: boolean
  error?: unknown
  solve: () => void
  polyGraphSolver?: {
    polySolver?: {
      topology: { regionCount: number }
      problem: { routeCount: number }
    }
  }
  highDensityRouteSolver?: {
    failedSolvers?: Array<{
      error?: unknown
      params?: {
        nodeWithPortPoints?: {
          capacityMeshNodeId?: string
          center?: { x: number; y: number }
          width?: number
          height?: number
          availableZ?: number[]
          portPoints?: Array<{
            connectionName?: string
            x: number
            y: number
            z?: number
          }>
          polygon?: Array<{ x: number; y: number }>
          projectedRect?: {
            center: { x: number; y: number }
            width: number
            height: number
            ccwRotationDegrees?: number
          }
        }
      }
    }>
  }
}

const datasetModuleName = "@tscircuit/autorouting-dataset-01"
const tinyHypergraphModuleName = "tiny-hypergraph/lib/index"
const { circuit002 } = (await import(datasetModuleName)) as {
  circuit002: SimpleRouteJson
}
const { PolyHyperGraphSolver, loadSerializedHyperGraphAsPoly } = (await import(
  tinyHypergraphModuleName
)) as any

const effort = Number(process.env.EFFORT ?? 1)
const concavityTolerance = Number(process.env.CONCAVITY_TOLERANCE ?? 0)
const layerMergeMode = (process.env.LAYER_MERGE_MODE ??
  "same") as LayerMergeMode
const usePolyanyaMerge = process.env.USE_POLYANYA_MERGE === "true"
const tscircuitAutorouterIndexUrl = process.env.TSCIRCUIT_AUTOROUTER_INDEX
  ? new URL(`file://${process.env.TSCIRCUIT_AUTOROUTER_INDEX}`)
  : new URL("../../tscircuit-autorouter/lib/index.ts", import.meta.url)
let tscircuitAutorouterPcbPolyResolution = getLocalPcbPolyIndexPath()

const tscircuitAutorouterBundle = existsSync(tscircuitAutorouterIndexUrl)
  ? await getLocalTscircuitAutorouterBundle(tscircuitAutorouterIndexUrl)
  : null
tscircuitAutorouterPcbPolyResolution =
  tscircuitAutorouterBundle?.localPcbPolyIndexPath ??
  tscircuitAutorouterPcbPolyResolution
const tscircuitAutorouterModule = tscircuitAutorouterBundle
  ? ((await import(tscircuitAutorouterBundle.moduleUrl.href)) as Record<
      string,
      unknown
    >)
  : null
const TscircuitPolyPipelineSolverCtor =
  tscircuitAutorouterModule?.AutoroutingPipelineSolver6_PolyHypergraph as
    | (new (
        srj: SimpleRouteJson,
        opts?: Record<string, unknown>,
      ) => TscircuitPolyPipelineSolver)
    | undefined

const getRectsFromSrj = (srj: SimpleRouteJson): Rect[] =>
  (srj.obstacles ?? [])
    .filter((obstacle) => obstacle.type === "rect")
    .map((obstacle) => ({
      center: obstacle.center,
      width: obstacle.width,
      height: obstacle.height,
      ccwRotation: ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180,
      layers: obstacle.layers,
      zLayers: obstacle.zLayers,
      isCopperPour: obstacle.isCopperPour,
    }))

const getRotationRadians = (
  obstacle: NonNullable<SimpleRouteJson["obstacles"]>[number],
) => ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180

const getRectPoints = (
  obstacle: NonNullable<SimpleRouteJson["obstacles"]>[number],
  clearance = 0,
) => {
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

const getOvalPoints = (
  obstacle: NonNullable<SimpleRouteJson["obstacles"]>[number],
) => {
  const rx = obstacle.width / 2
  const ry = obstacle.height / 2
  const rotation = getRotationRadians(obstacle)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return Array.from({ length: 8 }, (_, index) => {
    const angle = (2 * Math.PI * index) / 8
    const localX = rx * Math.cos(angle)
    const localY = ry * Math.sin(angle)
    return {
      x: obstacle.center.x + localX * cos - localY * sin,
      y: obstacle.center.y + localX * sin + localY * cos,
    }
  })
}

const getOvalPolygonsFromSrj = (srj: SimpleRouteJson): Polygon[] =>
  (srj.obstacles ?? [])
    .filter((obstacle) => obstacle.type === "oval")
    .map((obstacle) => ({
      points: getOvalPoints(obstacle),
      layers: obstacle.layers,
      zLayers: obstacle.zLayers,
      isCopperPour: obstacle.isCopperPour,
    }))

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

    const polygon =
      obstacle.type === "rect"
        ? getRectPoints(obstacle, clearance)
        : getOffsetPolygonPoints({
            polygon: {
              points: getOvalPoints(obstacle),
              layers: obstacle.layers,
              zLayers: obstacle.zLayers,
              isCopperPour: obstacle.isCopperPour,
            },
            clearance,
            verticesOnly: true,
          })

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

const getCostSummary = (solver: {
  state: { regionIntersectionCaches: Array<{ existingRegionCost: number }> }
}) => {
  const costs = solver.state.regionIntersectionCaches.map(
    (cache) => cache.existingRegionCost,
  )
  const totalRegionCost = costs.reduce((sum, cost) => sum + cost, 0)
  return {
    maxRegionCost: costs.length > 0 ? Math.max(...costs) : 0,
    avgRegionCost: costs.length > 0 ? totalRegionCost / costs.length : 0,
  }
}

const runPolyGraphRepro = () => {
  const startedAt = performance.now()
  const srj = circuit002
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
    usePolyanyaMerge,
    viaSegments: 8,
  })
  const graph = buildPolyHyperGraphFromRegions({
    regions: convexRegions.regions,
    availableZ: convexRegions.availableZ,
    layerCount: srj.layerCount,
    connections: getRoutePairsFromSrj(srj),
    obstacleRegions: getConnectedObstacleRegionsFromSrj(srj, clearance),
  })
  const loaded = loadSerializedHyperGraphAsPoly(graph as any)
  applySerializedRegionNetIdsToLoadedProblem(loaded, graph)

  const solver = new PolyHyperGraphSolver(loaded.topology, loaded.problem, {
    DISTANCE_TO_COST: 0.05,
    RIP_THRESHOLD_START: 0.05,
    RIP_THRESHOLD_END: 0.8,
    RIP_CONGESTION_REGION_COST_FACTOR: 0.1,
    RIP_THRESHOLD_RAMP_ATTEMPTS: Math.max(1, Math.ceil(10 * effort)),
    MAX_ITERATIONS: Math.max(100_000, Math.ceil(10_000_000 * effort)),
  })
  solver.solve()

  const timeMs = performance.now() - startedAt
  if (solver.failed) {
    throw new Error(
      `PolyHyperGraphSolver failed after ${timeMs.toFixed(0)}ms: ${String(
        solver.error ?? "poly solver failed",
      )}`,
    )
  }

  return {
    timeMs,
    regionCount: solver.topology.regionCount,
    routeCount: solver.problem.routeCount,
    ...getCostSummary(solver),
  }
}

const runTscircuitPipelineRepro = () => {
  const startedAt = performance.now()
  if (!TscircuitPolyPipelineSolverCtor) {
    throw new Error(
      `AutoroutingPipelineSolver6_PolyHypergraph not found at ${tscircuitAutorouterIndexForMessage()}`,
    )
  }

  const pipeline = new TscircuitPolyPipelineSolverCtor(circuit002, { effort })
  pipeline.solve()

  const timeMs = performance.now() - startedAt
  const solver = pipeline.polyGraphSolver?.polySolver
  if (!solver) {
    throw new Error(
      `tscircuit poly pipeline did not create a poly solver after ${timeMs.toFixed(0)}ms`,
    )
  }
  if (!pipeline.solved) {
    const failedNodeSummaries =
      pipeline.highDensityRouteSolver?.failedSolvers
        ?.map((failedSolver) => {
          const node = failedSolver.params?.nodeWithPortPoints
          if (!node) return null
          const uniqueConnections = Array.from(
            new Set(
              (node.portPoints ?? []).map(
                (portPoint) => portPoint.connectionName ?? "unknown",
              ),
            ),
          )
          const polygonMinDimension =
            node.polygon && node.polygon.length > 0
              ? getPolygonMinDimension(node.polygon)
              : undefined
          return [
            node.capacityMeshNodeId ?? "unknown-node",
            `center=${formatPoint(node.center)}`,
            `size=${formatNumber(node.width ?? NaN)}x${formatNumber(
              node.height ?? NaN,
            )}`,
            polygonMinDimension !== undefined
              ? `polyMin=${formatNumber(polygonMinDimension)}`
              : null,
            node.projectedRect
              ? `projected=${formatNumber(
                  node.projectedRect.width,
                )}x${formatNumber(node.projectedRect.height)}`
              : null,
            `z=${JSON.stringify(node.availableZ ?? [])}`,
            `ports=${node.portPoints?.length ?? 0}`,
            `nets=${uniqueConnections.join(",")}`,
            `error=${String(failedSolver.error ?? "")}`,
          ]
            .filter(Boolean)
            .join(" ")
        })
        .filter((summary): summary is string => Boolean(summary)) ?? []
    throw new Error(
      `tscircuit poly pipeline failed after ${timeMs.toFixed(0)}ms: ${String(
        pipeline.error ?? "pipeline failed",
      )}${
        failedNodeSummaries.length > 0
          ? `\nfailed nodes:\n${failedNodeSummaries.join("\n")}`
          : ""
      }`,
    )
  }

  return {
    timeMs,
    regionCount: solver.topology.regionCount,
    routeCount: solver.problem.routeCount,
  }
}

const tscircuitAutorouterIndexForMessage = () =>
  existsSync(tscircuitAutorouterIndexUrl)
    ? tscircuitAutorouterIndexUrl.href
    : "unavailable"

const formatNumber = (value: number) =>
  Number.isFinite(value) ? value.toFixed(4) : "fail"

const formatPoint = (point: { x: number; y: number } | undefined) =>
  point ? `(${formatNumber(point.x)},${formatNumber(point.y)})` : "(fail,fail)"

const getPolygonMinDimension = (polygon: Array<{ x: number; y: number }>) => {
  const xs = polygon.map((point) => point.x)
  const ys = polygon.map((point) => point.y)
  return Math.min(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  )
}

console.log(
  [
    "repro=circuit002",
    `connections=${circuit002.connections.length}`,
    `obstacles=${circuit002.obstacles?.length ?? 0}`,
    `effort=${effort}`,
    `concavityTolerance=${concavityTolerance}`,
    `layerMergeMode=${layerMergeMode}`,
    `usePolyanyaMerge=${usePolyanyaMerge}`,
    `tscircuitAutorouter=${TscircuitPolyPipelineSolverCtor ? `${tscircuitAutorouterIndexForMessage()} bundled` : "unavailable"}`,
    `tscircuitAutorouterPcbPoly=${TscircuitPolyPipelineSolverCtor ? tscircuitAutorouterPcbPolyResolution : "unavailable"}`,
  ].join(" "),
)

let failed = false

try {
  const result = runPolyGraphRepro()
  console.log(
    [
      "pcb-poly-hyper-graph-poly ok",
      `regions=${result.regionCount}`,
      `routes=${result.routeCount}`,
      `max=${formatNumber(result.maxRegionCost)}`,
      `avg=${formatNumber(result.avgRegionCost)}`,
      `time=${result.timeMs.toFixed(0)}ms`,
    ].join(" "),
  )
} catch (error) {
  failed = true
  console.error(
    `pcb-poly-hyper-graph-poly repro failure: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
}

try {
  const result = runTscircuitPipelineRepro()
  console.log(
    [
      "tscircuit-poly-pipeline ok",
      `regions=${result.regionCount}`,
      `routes=${result.routeCount}`,
      `time=${result.timeMs.toFixed(0)}ms`,
    ].join(" "),
  )
} catch (error) {
  failed = true
  console.error(
    `tscircuit-poly-pipeline repro failure: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
}

if (failed) {
  process.exitCode = 1
}
