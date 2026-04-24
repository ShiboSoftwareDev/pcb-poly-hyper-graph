import { mapLayerNameToZ } from "./layer-utils"
import type { Point } from "./types"

export type PolyHyperGraphConnectionPoint = Point & {
  layer?: string
  layers?: string[]
  z?: number
  zLayers?: number[]
  pointId?: string
  pcb_port_id?: string
}

export type PolyHyperGraphConnection = {
  connectionId: string
  mutuallyConnectedNetworkId?: string
  start: PolyHyperGraphConnectionPoint
  end: PolyHyperGraphConnectionPoint
  simpleRouteConnection?: unknown
}

export type SerializedPolyHyperGraph = {
  regions: Array<{
    regionId: string
    pointIds: string[]
    d: Record<string, unknown> & {
      polygon: Point[]
      availableZ: number[]
    }
  }>
  ports: Array<{
    portId: string
    region1Id: string
    region2Id: string
    d: Record<string, unknown> & {
      portId: string
      x: number
      y: number
      z: number
    }
  }>
  connections: Array<{
    connectionId: string
    mutuallyConnectedNetworkId?: string
    startRegionId: string
    endRegionId: string
    simpleRouteConnection?: unknown
  }>
}

const roundPointCoord = (value: number) => Math.round(value * 1e6) / 1e6

const pointKey = (point: Point) =>
  `${roundPointCoord(point.x)},${roundPointCoord(point.y)}`

const segmentKey = (a: Point, b: Point) => {
  const aKey = pointKey(a)
  const bKey = pointKey(b)
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`
}

const getBounds = (polygon: Point[]) => {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of polygon) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, maxX, minY, maxY }
}

const distanceToBoundsSq = (
  point: Point,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
) => {
  const dx =
    point.x < bounds.minX
      ? bounds.minX - point.x
      : point.x > bounds.maxX
        ? point.x - bounds.maxX
        : 0
  const dy =
    point.y < bounds.minY
      ? bounds.minY - point.y
      : point.y > bounds.maxY
        ? point.y - bounds.maxY
        : 0
  return dx * dx + dy * dy
}

const pointOnSegment = (point: Point, a: Point, b: Point) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq < 1e-18) return false
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  if (t < -1e-9 || t > 1 + 1e-9) return false
  const closest = { x: a.x + t * dx, y: a.y + t * dy }
  const distSq = (point.x - closest.x) ** 2 + (point.y - closest.y) ** 2
  return distSq < 1e-12
}

const pointInPolygon = (point: Point, polygon: Point[]) => {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!
    const pj = polygon[j]!
    if (pointOnSegment(point, pi, pj)) return true
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x <
        ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y + 1e-12) + pi.x
    if (intersects) inside = !inside
  }
  return inside
}

const getPointCandidateZ = (
  point: PolyHyperGraphConnectionPoint,
  layerCount: number,
) => {
  if (Number.isInteger(point.z) && point.z! >= 0 && point.z! < layerCount) {
    return [point.z!]
  }
  if (Array.isArray(point.zLayers) && point.zLayers.length > 0) {
    return point.zLayers.filter(
      (z) => Number.isInteger(z) && z >= 0 && z < layerCount,
    )
  }
  if (typeof point.layer === "string") {
    const z = mapLayerNameToZ(point.layer, layerCount)
    return z === undefined ? [] : [z]
  }
  if (Array.isArray(point.layers) && point.layers.length > 0) {
    return point.layers
      .map((layer) => mapLayerNameToZ(layer, layerCount))
      .filter((z): z is number => z !== undefined)
  }
  return [0]
}

const createTerminalPolygon = (point: Point, size = 1e-6): Point[] => [
  { x: point.x - size, y: point.y - size },
  { x: point.x + size, y: point.y - size },
  { x: point.x, y: point.y + size },
]

export const buildPolyHyperGraphFromRegions = (params: {
  regions: Point[][]
  availableZ?: number[][]
  layerCount: number
  connections?: PolyHyperGraphConnection[]
  regionIdPrefix?: string
  portIdPrefix?: string
}): SerializedPolyHyperGraph => {
  const {
    regions,
    availableZ,
    layerCount,
    connections = [],
    regionIdPrefix = "free",
    portIdPrefix = "shared-port",
  } = params
  const fallbackAvailableZ = Array.from({ length: layerCount }, (_, z) => z)
  const serializedRegions: SerializedPolyHyperGraph["regions"] = regions.map(
    (polygon, regionIndex) => {
      const bounds = getBounds(polygon)
      const regionAvailableZ = availableZ?.[regionIndex] ?? fallbackAvailableZ
      return {
        regionId: `${regionIdPrefix}-${regionIndex}`,
        pointIds: [],
        d: {
          polygon,
          availableZ: regionAvailableZ,
          center: {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
          },
          width: bounds.maxX - bounds.minX,
          height: bounds.maxY - bounds.minY,
        },
      }
    },
  )
  const ports: SerializedPolyHyperGraph["ports"] = []
  const edgeEntries = new Map<
    string,
    Array<{ regionIndex: number; a: Point; b: Point }>
  >()

  for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
    const polygon = regions[regionIndex]!
    for (let pointIndex = 0; pointIndex < polygon.length; pointIndex++) {
      const a = polygon[pointIndex]!
      const b = polygon[(pointIndex + 1) % polygon.length]!
      const key = segmentKey(a, b)
      const entries = edgeEntries.get(key) ?? []
      entries.push({ regionIndex, a, b })
      edgeEntries.set(key, entries)
    }
  }

  let portIndex = 0
  for (const entries of edgeEntries.values()) {
    if (entries.length !== 2) continue
    const [first, second] = entries
    const firstRegionAvailableZ =
      availableZ?.[first!.regionIndex] ?? fallbackAvailableZ
    const secondRegionAvailableZ =
      availableZ?.[second!.regionIndex] ?? fallbackAvailableZ
    const sharedZ = firstRegionAvailableZ.filter((z) =>
      secondRegionAvailableZ.includes(z),
    )
    if (sharedZ.length === 0) continue

    const x = (first!.a.x + first!.b.x) / 2
    const y = (first!.a.y + first!.b.y) / 2

    for (const z of sharedZ) {
      const portId = `${portIdPrefix}-${String(portIndex).padStart(5, "0")}::${z}`
      ports.push({
        portId,
        region1Id: `${regionIdPrefix}-${first!.regionIndex}`,
        region2Id: `${regionIdPrefix}-${second!.regionIndex}`,
        d: {
          portId,
          x,
          y,
          z,
          distToCentermostPortOnZ: 0,
        },
      })
      serializedRegions[first!.regionIndex]!.pointIds.push(portId)
      serializedRegions[second!.regionIndex]!.pointIds.push(portId)
      portIndex += 1
    }
  }

  const findEndpointRegion = (point: PolyHyperGraphConnectionPoint) => {
    const candidateZ = getPointCandidateZ(point, layerCount)
    let nearest:
      | { regionIndex: number; z: number; distanceSq: number }
      | undefined
    for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
      const polygon = regions[regionIndex]!
      const regionAvailableZ = availableZ?.[regionIndex] ?? fallbackAvailableZ
      const z =
        candidateZ.find((candidate) => regionAvailableZ.includes(candidate)) ??
        regionAvailableZ[0]
      if (z === undefined) continue
      if (pointInPolygon(point, polygon)) {
        return { regionIndex, z }
      }
      const distanceSq = distanceToBoundsSq(point, getBounds(polygon))
      if (!nearest || distanceSq < nearest.distanceSq) {
        nearest = { regionIndex, z, distanceSq }
      }
    }
    return nearest
  }

  const serializedConnections: SerializedPolyHyperGraph["connections"] = []

  for (const connection of connections) {
    const start = findEndpointRegion(connection.start)
    const end = findEndpointRegion(connection.end)
    if (!start || !end) {
      throw new Error(
        `Could not map connection "${connection.connectionId}" endpoint into a generated region`,
      )
    }

    const startRegionId = `terminal-start-${connection.connectionId}`
    const endRegionId = `terminal-end-${connection.connectionId}`
    const startPortId = `terminal-start-port-${connection.connectionId}`
    const endPortId = `terminal-end-port-${connection.connectionId}`

    serializedRegions.push({
      regionId: startRegionId,
      pointIds: [startPortId],
      d: {
        polygon: createTerminalPolygon(connection.start),
        availableZ: [start.z],
        center: { x: connection.start.x, y: connection.start.y },
        width: 1e-6,
        height: 1e-6,
        _containsTarget: true,
      },
    })
    serializedRegions.push({
      regionId: endRegionId,
      pointIds: [endPortId],
      d: {
        polygon: createTerminalPolygon(connection.end),
        availableZ: [end.z],
        center: { x: connection.end.x, y: connection.end.y },
        width: 1e-6,
        height: 1e-6,
        _containsTarget: true,
      },
    })

    const startFreeRegionId = `${regionIdPrefix}-${start.regionIndex}`
    const endFreeRegionId = `${regionIdPrefix}-${end.regionIndex}`
    ports.push({
      portId: startPortId,
      region1Id: startFreeRegionId,
      region2Id: startRegionId,
      d: {
        portId: startPortId,
        x: connection.start.x,
        y: connection.start.y,
        z: start.z,
        distToCentermostPortOnZ: 0,
      },
    })
    ports.push({
      portId: endPortId,
      region1Id: endFreeRegionId,
      region2Id: endRegionId,
      d: {
        portId: endPortId,
        x: connection.end.x,
        y: connection.end.y,
        z: end.z,
        distToCentermostPortOnZ: 0,
      },
    })
    serializedRegions[start.regionIndex]!.pointIds.push(startPortId)
    serializedRegions[end.regionIndex]!.pointIds.push(endPortId)

    serializedConnections.push({
      connectionId: connection.connectionId,
      mutuallyConnectedNetworkId: connection.mutuallyConnectedNetworkId,
      startRegionId,
      endRegionId,
      simpleRouteConnection: connection.simpleRouteConnection,
    })
  }

  return {
    regions: serializedRegions,
    ports,
    connections: serializedConnections,
  }
}
