import { AutoroutingPipelineSolver4_TinyHypergraph } from "@tscircuit/capacity-autorouter"
import {
  buildPolyHyperGraphFromRegions,
  computeConvexRegions,
  type LayerMergeMode,
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
    type: "rect"
    center: { x: number; y: number }
    width: number
    height: number
    layers?: string[]
    zLayers?: number[]
    ccwRotationDegrees?: number
    isCopperPour?: boolean
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
const effort = Number(process.env.EFFORT ?? 0.1)
const maxNodeDimension = Number(process.env.MAX_NODE_DIMENSION ?? 12)
const concavityTolerance = Number(process.env.CONCAVITY_TOLERANCE ?? 0)
const layerMergeMode = (process.env.LAYER_MERGE_MODE ??
  "same") as LayerMergeMode

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

const runFindConvexRegionsPoly = (scenario: Scenario): SolverMetrics => {
  const startedAt = performance.now()
  try {
    const srj = scenario.srj
    const convexRegions = computeConvexRegions({
      bounds: srj.bounds,
      rects: getRectsFromSrj(srj),
      clearance: srj.defaultObstacleMargin ?? srj.minTraceWidth,
      concavityTolerance,
      layerCount: srj.layerCount,
      layerMergeMode,
      useConstrainedDelaunay: true,
      usePolyanyaMerge: true,
    })
    const graph = buildPolyHyperGraphFromRegions({
      regions: convexRegions.regions,
      availableZ: convexRegions.availableZ,
      layerCount: srj.layerCount,
      connections: srj.connections
        .filter((connection) => connection.pointsToConnect.length >= 2)
        .map((connection) => ({
          connectionId: connection.name,
          mutuallyConnectedNetworkId:
            connection.rootConnectionName ?? connection.name,
          start: connection.pointsToConnect[0]!,
          end: connection.pointsToConnect[1]!,
          simpleRouteConnection: connection,
        })),
    })
    const loaded = loadSerializedHyperGraphAsPoly(graph as any)
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
      "find-convex-regions-poly",
      scenario.name,
      performance.now() - startedAt,
      solver,
    )
  } catch (error) {
    return failMetrics(
      "find-convex-regions-poly",
      scenario.name,
      startedAt,
      error,
    )
  }
}

const formatNumber = (value: number) =>
  Number.isFinite(value) ? value.toFixed(4) : "fail"

const printScenarioRow = (baseline: SolverMetrics, poly: SolverMetrics) => {
  console.log(
    [
      baseline.scenarioName.padEnd(12),
      `baseline max=${formatNumber(baseline.maxRegionCost)}`,
      `avg=${formatNumber(baseline.avgRegionCost)}`,
      `time=${baseline.timeMs.toFixed(0)}ms`,
      `poly max=${formatNumber(poly.maxRegionCost)}`,
      `avg=${formatNumber(poly.avgRegionCost)}`,
      `time=${poly.timeMs.toFixed(0)}ms`,
    ].join("  "),
  )
  if (baseline.error) {
    console.log(`  baseline error: ${baseline.error}`)
  }
  if (poly.error) {
    console.log(`  poly error: ${poly.error}`)
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

console.log(
  [
    `dataset01 scenarios=${scenarios.length}`,
    `effort=${effort}`,
    `maxNodeDimension=${maxNodeDimension}`,
    `concavityTolerance=${concavityTolerance}`,
    `layerMergeMode=${layerMergeMode}`,
  ].join(" "),
)

for (const scenario of scenarios) {
  const baseline = runBaseline(scenario)
  const poly = runFindConvexRegionsPoly(scenario)
  baselineMetrics.push(baseline)
  polyMetrics.push(poly)
  printScenarioRow(baseline, poly)
}

console.log("\nsummary")
for (const summary of [
  summarize("capacity-autorouter", baselineMetrics),
  summarize("find-convex-regions-poly", polyMetrics),
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
