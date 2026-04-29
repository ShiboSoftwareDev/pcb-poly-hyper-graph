import { existsSync } from "node:fs"
import { AutoroutingPipelineSolver4_TinyHypergraph } from "@tscircuit/capacity-autorouter"
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

type Scenario = {
  name: string
  srj: SimpleRouteJson
}

type SolverMetrics = {
  solverName: string
  scenarioName: string
  success: boolean
  timeMs: number
  regionCount: number
  routeCount: number
  maxRegionCost: number
  avgRegionCost: number
  error?: string
}

const datasetModuleName = "@tscircuit/autorouting-dataset-01"
const tinyHypergraphModuleName = "tiny-hypergraph/lib/index"
const dataset01 = (await import(datasetModuleName)) as Record<string, unknown>
const { PolyHyperGraphSolver, loadSerializedHyperGraphAsPoly } = (await import(
  tinyHypergraphModuleName
)) as any

const scenarioLimit = Number(process.env.SCENARIO_LIMIT ?? 20)
const effort = Number(process.env.EFFORT ?? 1)
const maxNodeDimension = Number(process.env.MAX_NODE_DIMENSION ?? 12)
const concavityTolerance = Number(process.env.CONCAVITY_TOLERANCE ?? 0)
const layerMergeMode = (process.env.LAYER_MERGE_MODE ??
  "same") as LayerMergeMode
const usePolyanyaMerge = process.env.USE_POLYANYA_MERGE === "true"
const tscircuitAutorouterIndexUrl = process.env.TSCIRCUIT_AUTOROUTER_INDEX
  ? new URL(`file://${process.env.TSCIRCUIT_AUTOROUTER_INDEX}`)
  : new URL("../../tscircuit-autorouter/lib/index.ts", import.meta.url)
let tscircuitAutorouterPcbPolyResolution = getLocalPcbPolyIndexPath()

type TscircuitPolyPipelineSolver = {
  solved?: boolean
  failed?: boolean
  error?: unknown
  solve: () => void
  polyGraphSolver?: {
    polySolver?: {
      topology: { regionCount: number }
      problem: { routeCount: number }
      state: {
        regionIntersectionCaches: Array<{ existingRegionCost: number }>
      }
    }
  }
}

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

const getScenarios = (): Scenario[] =>
  Object.entries(dataset01)
    .filter((entry): entry is [string, SimpleRouteJson] => {
      const value = entry[1] as Partial<SimpleRouteJson>
      return (
        typeof value === "object" &&
        value !== null &&
        Array.isArray(value.connections) &&
        Array.isArray(value.obstacles) &&
        value.bounds !== undefined
      )
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, scenarioLimit)
    .map(([name, srj]) => ({ name, srj }))

const getRegionMetrics = (
  solverName: string,
  scenarioName: string,
  timeMs: number,
  solver: {
    topology: { regionCount: number }
    problem: { routeCount: number }
    state: {
      regionIntersectionCaches: Array<{ existingRegionCost: number }>
    }
  },
): SolverMetrics => {
  const costs = solver.state.regionIntersectionCaches.map(
    (cache) => cache.existingRegionCost,
  )
  const totalRegionCost = costs.reduce((sum, cost) => sum + cost, 0)
  return {
    solverName,
    scenarioName,
    success: true,
    timeMs,
    regionCount: solver.topology.regionCount,
    routeCount: solver.problem.routeCount,
    maxRegionCost: costs.length > 0 ? Math.max(...costs) : 0,
    avgRegionCost: costs.length > 0 ? totalRegionCost / costs.length : 0,
  }
}

const failMetrics = (
  solverName: string,
  scenarioName: string,
  startMs: number,
  error: unknown,
): SolverMetrics => ({
  solverName,
  scenarioName,
  success: false,
  timeMs: performance.now() - startMs,
  regionCount: 0,
  routeCount: 0,
  maxRegionCost: Number.POSITIVE_INFINITY,
  avgRegionCost: Number.POSITIVE_INFINITY,
  error: error instanceof Error ? error.message : String(error),
})

const stepUntil = (params: {
  solver: { step: () => void; failed: boolean; error: unknown }
  done: () => boolean
  maxSteps: number
}) => {
  let steps = 0
  while (!params.done() && !params.solver.failed && steps++ < params.maxSteps) {
    params.solver.step()
  }
  if (params.solver.failed) {
    throw new Error(String(params.solver.error ?? "solver failed"))
  }
  if (steps >= params.maxSteps) {
    throw new Error(`step limit exceeded (${params.maxSteps})`)
  }
}

const runBaseline = (scenario: Scenario): SolverMetrics => {
  const startedAt = performance.now()
  try {
    const pipeline = new AutoroutingPipelineSolver4_TinyHypergraph(
      scenario.srj as any,
      {
        effort,
        maxNodeDimension,
      },
    )
    stepUntil({
      solver: pipeline,
      done: () => pipeline.getCurrentPhase() === "portPointPathingSolver",
      maxSteps: 2_000_000,
    })

    pipeline.step()
    const portPointPathingSolver = pipeline.portPointPathingSolver
    if (!portPointPathingSolver) {
      throw new Error("portPointPathingSolver was not created")
    }

    stepUntil({
      solver: portPointPathingSolver,
      done: () => portPointPathingSolver.solved,
      maxSteps: 5_000_000,
    })

    const tinySolver = (
      portPointPathingSolver as any
    ).tinyPipelineSolver?.getSolvedTinySolver()
    if (!tinySolver) {
      throw new Error("baseline tiny solver did not produce a solved graph")
    }

    return getRegionMetrics(
      "capacity-autorouter",
      scenario.name,
      performance.now() - startedAt,
      tinySolver,
    )
  } catch (error) {
    return failMetrics("capacity-autorouter", scenario.name, startedAt, error)
  }
}

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

    let polygon: { x: number; y: number }[]
    if (obstacle.type === "rect") {
      polygon = getRectPoints(obstacle, clearance)
    } else {
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

const runFindConvexRegionsPoly = (scenario: Scenario): SolverMetrics => {
  const startedAt = performance.now()
  try {
    const srj = scenario.srj
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
    if (solver.failed) {
      throw new Error(String(solver.error ?? "poly solver failed"))
    }

    return getRegionMetrics(
      "pcb-poly-hyper-graph-poly",
      scenario.name,
      performance.now() - startedAt,
      solver,
    )
  } catch (error) {
    return failMetrics(
      "pcb-poly-hyper-graph-poly",
      scenario.name,
      startedAt,
      error,
    )
  }
}

const runTscircuitPolyPipeline = (scenario: Scenario): SolverMetrics => {
  const startedAt = performance.now()
  if (!TscircuitPolyPipelineSolverCtor) {
    return failMetrics(
      "tscircuit-poly-pipeline",
      scenario.name,
      startedAt,
      `AutoroutingPipelineSolver6_PolyHypergraph not found at ${tscircuitAutorouterIndexUrl.href}`,
    )
  }

  try {
    const pipeline = new TscircuitPolyPipelineSolverCtor(
      scenario.srj as SimpleRouteJson,
      {
        effort,
      },
    )
    pipeline.solve()

    const tinySolver = pipeline.polyGraphSolver?.polySolver
    if (!tinySolver) {
      throw new Error("tscircuit poly pipeline did not create a poly solver")
    }

    const metrics = getRegionMetrics(
      "tscircuit-poly-pipeline",
      scenario.name,
      performance.now() - startedAt,
      tinySolver,
    )

    if (!pipeline.solved) {
      return {
        ...metrics,
        success: false,
        error: String(pipeline.error ?? "tscircuit poly pipeline failed"),
      }
    }

    return metrics
  } catch (error) {
    return failMetrics(
      "tscircuit-poly-pipeline",
      scenario.name,
      startedAt,
      error,
    )
  }
}

const formatNumber = (value: number) =>
  Number.isFinite(value) ? value.toFixed(4) : "fail"

const printScenarioRow = (
  baseline: SolverMetrics,
  poly: SolverMetrics,
  tscircuit: SolverMetrics,
) => {
  console.log(
    [
      baseline.scenarioName.padEnd(12),
      `baseline max=${formatNumber(baseline.maxRegionCost)}`,
      `avg=${formatNumber(baseline.avgRegionCost)}`,
      `routes=${baseline.routeCount}`,
      `time=${baseline.timeMs.toFixed(0)}ms`,
      `graph max=${formatNumber(poly.maxRegionCost)}`,
      `avg=${formatNumber(poly.avgRegionCost)}`,
      `routes=${poly.routeCount}`,
      `time=${poly.timeMs.toFixed(0)}ms`,
      `tscircuit=${tscircuit.success ? "ok" : "fail"}`,
      `routes=${tscircuit.routeCount}`,
      `time=${tscircuit.timeMs.toFixed(0)}ms`,
    ].join("  "),
  )
  if (baseline.error) {
    console.log(`  baseline error: ${baseline.error}`)
  }
  if (poly.error) {
    console.log(`  graph error: ${poly.error}`)
  }
  if (tscircuit.error) {
    console.log(`  tscircuit error: ${tscircuit.error}`)
  }
}

const summarize = (solverName: string, metrics: SolverMetrics[]) => {
  const successful = metrics.filter((metric) => metric.success)
  const totalTimeMs = metrics.reduce((sum, metric) => sum + metric.timeMs, 0)
  const avgMaxRegionCost =
    successful.reduce((sum, metric) => sum + metric.maxRegionCost, 0) /
    Math.max(1, successful.length)
  const avgAvgRegionCost =
    successful.reduce((sum, metric) => sum + metric.avgRegionCost, 0) /
    Math.max(1, successful.length)
  const worstMaxRegionCost = successful.reduce(
    (maxCost, metric) => Math.max(maxCost, metric.maxRegionCost),
    0,
  )

  return {
    solverName,
    success: `${successful.length}/${metrics.length}`,
    avgMaxRegionCost,
    avgAvgRegionCost,
    worstMaxRegionCost,
    totalTimeMs,
  }
}

const scenarios = getScenarios()
const baselineMetrics: SolverMetrics[] = []
const polyMetrics: SolverMetrics[] = []
const tscircuitMetrics: SolverMetrics[] = []

console.log(
  [
    `dataset01 scenarios=${scenarios.length}`,
    `effort=${effort}`,
    `maxNodeDimension=${maxNodeDimension}`,
    `concavityTolerance=${concavityTolerance}`,
    `layerMergeMode=${layerMergeMode}`,
    `usePolyanyaMerge=${usePolyanyaMerge}`,
    `tscircuitAutorouter=${TscircuitPolyPipelineSolverCtor ? `${tscircuitAutorouterIndexUrl.href} bundled` : "unavailable"}`,
    `tscircuitAutorouterPcbPoly=${TscircuitPolyPipelineSolverCtor ? tscircuitAutorouterPcbPolyResolution : "unavailable"}`,
  ].join(" "),
)

for (const scenario of scenarios) {
  const baseline = runBaseline(scenario)
  const poly = runFindConvexRegionsPoly(scenario)
  const tscircuit = runTscircuitPolyPipeline(scenario)
  baselineMetrics.push(baseline)
  polyMetrics.push(poly)
  tscircuitMetrics.push(tscircuit)
  printScenarioRow(baseline, poly, tscircuit)
}

console.log("\nsummary")
for (const summary of [
  summarize("capacity-autorouter", baselineMetrics),
  summarize("pcb-poly-hyper-graph-graph", polyMetrics),
  summarize("tscircuit-poly-pipeline", tscircuitMetrics),
]) {
  console.log(
    [
      summary.solverName.padEnd(26),
      `success=${summary.success}`,
      `avgMax=${formatNumber(summary.avgMaxRegionCost)}`,
      `avgAvg=${formatNumber(summary.avgAvgRegionCost)}`,
      `worstMax=${formatNumber(summary.worstMaxRegionCost)}`,
      `time=${summary.totalTimeMs.toFixed(0)}ms`,
    ].join("  "),
  )
}
