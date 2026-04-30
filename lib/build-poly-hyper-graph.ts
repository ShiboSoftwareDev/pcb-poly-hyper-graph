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

export type PolyHyperGraphObstacleRegion = {
  regionId?: string
  polygon: Point[]
  availableZ?: number[]
  connectedTo?: string[]
  mutuallyConnectedNetworkId?: string
  netId?: number
  d?: Record<string, unknown>
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
      distToCentermostPortOnZ: number
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

export const DEFAULT_TRACE_WIDTH = 0.1
export const DEFAULT_OBSTACLE_MARGIN = 0.15
export const PORT_SPACING = DEFAULT_TRACE_WIDTH + DEFAULT_OBSTACLE_MARGIN
export const PORT_MARGIN_FROM_SEGMENT_ENDPOINT = (PORT_SPACING * 3) / 4
export const MAX_DENSE_PORTS_BEFORE_DECIMATION = 5

const EPSILON = 1e-9

const roundPointCoord = (value: number) => Math.round(value * 1e6) / 1e6

const pointKey = (point: Point) =>
  `${roundPointCoord(point.x)},${roundPointCoord(point.y)}`

const segmentKey = (a: Point, b: Point) => {
  const aKey = pointKey(a)
  const bKey = pointKey(b)
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`
}

const portPointKey = (point: Point, z: number) =>
  `${roundPointCoord(point.x)},${roundPointCoord(point.y)},${z}`

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

const pointToSegmentDistanceSq = (point: Point, a: Point, b: Point) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq < EPSILON) {
    return (point.x - a.x) ** 2 + (point.y - a.y) ** 2
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq),
  )
  const closest = { x: a.x + t * dx, y: a.y + t * dy }
  return (point.x - closest.x) ** 2 + (point.y - closest.y) ** 2
}

const distanceToPolygonBoundarySq = (point: Point, polygon: Point[]) => {
  let minDistanceSq = Number.POSITIVE_INFINITY
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    minDistanceSq = Math.min(
      minDistanceSq,
      pointToSegmentDistanceSq(point, a, b),
    )
  }
  return minDistanceSq
}

const segmentMidpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
})

const isBoundarySegmentOnPolygon = (
  a: Point,
  b: Point,
  polygon: Point[],
  tolerance = 1e-3,
) => {
  const toleranceSq = tolerance * tolerance
  return (
    distanceToPolygonBoundarySq(segmentMidpoint(a, b), polygon) <= toleranceSq
  )
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

const segmentIntersectionPoint = (a: Point, b: Point, c: Point, d: Point) => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const cdx = d.x - c.x
  const cdy = d.y - c.y
  const denominator = abx * cdy - aby * cdx

  if (Math.abs(denominator) < EPSILON) {
    for (const point of [a, b]) {
      if (pointOnSegment(point, c, d)) return point
    }
    for (const point of [c, d]) {
      if (pointOnSegment(point, a, b)) return point
    }
    return undefined
  }

  const t = ((c.x - a.x) * cdy - (c.y - a.y) * cdx) / denominator
  const u = ((c.x - a.x) * aby - (c.y - a.y) * abx) / denominator
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) {
    return undefined
  }

  return { x: a.x + t * abx, y: a.y + t * aby }
}

const findPolygonContactPoint = (first: Point[], second: Point[]) => {
  for (const point of first) {
    if (pointInPolygon(point, second)) return point
  }
  for (const point of second) {
    if (pointInPolygon(point, first)) return point
  }

  for (let firstIndex = 0; firstIndex < first.length; firstIndex++) {
    const firstA = first[firstIndex]!
    const firstB = first[(firstIndex + 1) % first.length]!
    for (let secondIndex = 0; secondIndex < second.length; secondIndex++) {
      const secondA = second[secondIndex]!
      const secondB = second[(secondIndex + 1) % second.length]!
      const intersection = segmentIntersectionPoint(
        firstA,
        firstB,
        secondA,
        secondB,
      )
      if (intersection) return intersection
    }
  }

  return undefined
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

const getPortPointsAlongSegment = (
  a: Point,
  b: Point,
  portSpacing: number,
  portMarginFromSegmentEndpoint: number,
  maxDensePortsBeforeDecimation: number,
) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length < EPSILON) return []

  const safeSpacing =
    Number.isFinite(portSpacing) && portSpacing > EPSILON
      ? portSpacing
      : PORT_SPACING
  const requestedMargin = Number.isFinite(portMarginFromSegmentEndpoint)
    ? Math.max(0, portMarginFromSegmentEndpoint)
    : PORT_MARGIN_FROM_SEGMENT_ENDPOINT
  const endpointMargin = Math.min(requestedMargin, length / 2)
  const usableLength = length - endpointMargin * 2

  if (usableLength <= safeSpacing * 0.75) {
    return [
      {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        distToCentermostPortOnZ: 0,
        cramped: true,
      },
    ]
  }

  const densePortCount = Math.max(1, Math.floor(usableLength / safeSpacing) + 1)
  const safeMaxDensePortsBeforeDecimation =
    Number.isFinite(maxDensePortsBeforeDecimation) &&
    maxDensePortsBeforeDecimation > 0
      ? Math.floor(maxDensePortsBeforeDecimation)
      : MAX_DENSE_PORTS_BEFORE_DECIMATION
  const portCount =
    densePortCount > safeMaxDensePortsBeforeDecimation
      ? safeMaxDensePortsBeforeDecimation + Math.floor(densePortCount / 4)
      : densePortCount

  if (portCount <= 1) {
    return [
      {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        distToCentermostPortOnZ: 0,
        cramped: false,
      },
    ]
  }

  const centerDistanceFromStart = length / 2
  const portPoints = Array.from({ length: portCount }, (_, index) => {
    const distanceFromStart =
      endpointMargin + (usableLength * index) / (portCount - 1)
    const t = distanceFromStart / length
    return {
      x: a.x + dx * t,
      y: a.y + dy * t,
      distanceFromStart,
    }
  })
  const centermostDistanceFromStart = portPoints.reduce(
    (best, portPoint) =>
      Math.abs(portPoint.distanceFromStart - centerDistanceFromStart) <
      Math.abs(best - centerDistanceFromStart)
        ? portPoint.distanceFromStart
        : best,
    portPoints[0]!.distanceFromStart,
  )

  return portPoints.map(({ x, y, distanceFromStart }) => ({
    x,
    y,
    distToCentermostPortOnZ: Math.abs(
      distanceFromStart - centermostDistanceFromStart,
    ),
    cramped: false,
  }))
}

const getNearestUnusedSinglePortPointOnSegment = (
  a: Point,
  b: Point,
  z: number,
  usedPortPointKeys: Set<string>,
) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length < EPSILON) return undefined

  const centerDistanceFromStart = length / 2
  const candidateCount = 33
  const candidateIndexes = Array.from({ length: candidateCount }, (_, index) =>
    index === 0
      ? Math.floor(candidateCount / 2)
      : Math.floor(candidateCount / 2) +
        (index % 2 === 1 ? -Math.ceil(index / 2) : Math.ceil(index / 2)),
  )

  for (const candidateIndex of candidateIndexes) {
    const t = candidateIndex / (candidateCount - 1)
    if (t <= 0 || t >= 1) continue

    const distanceFromStart = length * t
    const portPoint = {
      x: a.x + dx * t,
      y: a.y + dy * t,
      distToCentermostPortOnZ: Math.abs(
        distanceFromStart - centerDistanceFromStart,
      ),
      cramped: false,
    }

    if (!usedPortPointKeys.has(portPointKey(portPoint, z))) {
      return portPoint
    }
  }

  return undefined
}

const getStringProperty = (value: unknown, key: string) => {
  if (typeof value !== "object" || value === null) return undefined
  const property = (value as Record<string, unknown>)[key]
  return typeof property === "string" ? property : undefined
}

const getConnectionTokens = (connection: PolyHyperGraphConnection) => {
  const tokens = new Set<string>()
  const addToken = (token: unknown) => {
    if (typeof token === "string" && token.length > 0) {
      tokens.add(token)
    }
  }
  const addPointTokens = (point: PolyHyperGraphConnectionPoint) => {
    addToken(point.pointId)
    addToken(point.pcb_port_id)
  }

  addToken(connection.connectionId)
  addToken(connection.mutuallyConnectedNetworkId)
  addPointTokens(connection.start)
  addPointTokens(connection.end)

  const source = connection.simpleRouteConnection
  addToken(getStringProperty(source, "name"))
  addToken(getStringProperty(source, "source_trace_id"))
  addToken(getStringProperty(source, "rootConnectionName"))

  const sourcePoints =
    typeof source === "object" && source !== null
      ? (source as { pointsToConnect?: PolyHyperGraphConnectionPoint[] })
          .pointsToConnect
      : undefined
  if (Array.isArray(sourcePoints)) {
    for (const point of sourcePoints) {
      addPointTokens(point)
    }
  }

  return tokens
}

export const buildPolyHyperGraphFromRegions = (params: {
  regions: Point[][]
  availableZ?: number[][]
  layerCount: number
  connections?: PolyHyperGraphConnection[]
  obstacleRegions?: PolyHyperGraphObstacleRegion[]
  regionIdPrefix?: string
  portIdPrefix?: string
  portSpacing?: number
  portMarginFromSegmentEndpoint?: number
  traceWidth?: number
  obstacleMargin?: number
  maxDensePortsBeforeDecimation?: number
}): SerializedPolyHyperGraph => {
  const {
    regions,
    availableZ,
    layerCount,
    connections = [],
    obstacleRegions = [],
    regionIdPrefix = "free",
    portIdPrefix = "shared-port",
    traceWidth = DEFAULT_TRACE_WIDTH,
    obstacleMargin = DEFAULT_OBSTACLE_MARGIN,
    portSpacing = traceWidth + obstacleMargin,
    portMarginFromSegmentEndpoint = (portSpacing * 3) / 4,
    maxDensePortsBeforeDecimation = MAX_DENSE_PORTS_BEFORE_DECIMATION,
  } = params
  const fallbackAvailableZ = Array.from({ length: layerCount }, (_, z) => z)
  const netIndexByNetKey = new Map<string, number>()
  const netIndexByToken = new Map<string, number>()
  const getConnectionNetKey = (connection: PolyHyperGraphConnection) =>
    connection.mutuallyConnectedNetworkId ?? connection.connectionId

  for (const connection of connections) {
    const netKey = getConnectionNetKey(connection)
    let netIndex = netIndexByNetKey.get(netKey)
    if (netIndex === undefined) {
      netIndex = netIndexByNetKey.size
      netIndexByNetKey.set(netKey, netIndex)
    }
    for (const token of getConnectionTokens(connection)) {
      if (!netIndexByToken.has(token)) {
        netIndexByToken.set(token, netIndex)
      }
    }
  }

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
  const searchableRegions = serializedRegions.map((region, regionIndex) => ({
    regionId: region.regionId,
    serializedRegionIndex: regionIndex,
    polygon: region.d.polygon,
    availableZ: region.d.availableZ,
    bounds: getBounds(region.d.polygon),
    isObstacle: false,
    netId: undefined as number | undefined,
  }))

  const resolveObstacleRegionNetId = (
    obstacleRegion: PolyHyperGraphObstacleRegion,
  ) => {
    if (Number.isInteger(obstacleRegion.netId) && obstacleRegion.netId! >= 0) {
      return obstacleRegion.netId!
    }
    if (typeof obstacleRegion.mutuallyConnectedNetworkId === "string") {
      return netIndexByNetKey.get(obstacleRegion.mutuallyConnectedNetworkId)
    }
    for (const token of obstacleRegion.connectedTo ?? []) {
      const netIndex = netIndexByToken.get(token)
      if (netIndex !== undefined) return netIndex
    }
    return undefined
  }

  const obstacleRegionInfos = obstacleRegions.flatMap(
    (obstacleRegion, obstacleRegionIndex) => {
      if (obstacleRegion.polygon.length < 3) return []
      const netId = resolveObstacleRegionNetId(obstacleRegion)
      if (netId === undefined) return []
      const polygon = obstacleRegion.polygon
      const bounds = getBounds(polygon)
      const obstacleAvailableZ = obstacleRegion.availableZ ?? fallbackAvailableZ
      const regionId =
        obstacleRegion.regionId ?? `obstacle-${obstacleRegionIndex}`
      const serializedRegionIndex = serializedRegions.length

      serializedRegions.push({
        regionId,
        pointIds: [],
        d: {
          ...(obstacleRegion.d ?? {}),
          polygon,
          availableZ: obstacleAvailableZ,
          center: {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
          },
          width: bounds.maxX - bounds.minX,
          height: bounds.maxY - bounds.minY,
          _containsObstacle: true,
          _containsTarget: true,
          netId,
        },
      })

      const info = {
        regionId,
        serializedRegionIndex,
        polygon,
        availableZ: obstacleAvailableZ,
        bounds,
        isObstacle: true,
        netId,
      }
      searchableRegions.push(info)
      return [info]
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
  const usedPortPointKeys = new Set<string>()
  const pushPort = (params: {
    region1Id: string
    region2Id: string
    pointIndex: number
    portPoint: {
      x: number
      y: number
      distToCentermostPortOnZ: number
      cramped?: boolean
    }
    z: number
    portIdSuffix?: string
  }) => {
    const { region1Id, region2Id, pointIndex, portPoint, z, portIdSuffix } =
      params
    const portId = `${portIdPrefix}-${String(portIndex).padStart(
      5,
      "0",
    )}::p${pointIndex}::z${z}${portIdSuffix ?? ""}`
    ports.push({
      portId,
      region1Id,
      region2Id,
      d: {
        portId,
        x: portPoint.x,
        y: portPoint.y,
        z,
        distToCentermostPortOnZ: portPoint.distToCentermostPortOnZ,
        ...(portPoint.cramped ? { cramped: true } : {}),
      },
    })
    usedPortPointKeys.add(portPointKey(portPoint, z))
    portIndex += 1
    return portId
  }

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

    const portPoints = getPortPointsAlongSegment(
      first!.a,
      first!.b,
      portSpacing,
      portMarginFromSegmentEndpoint,
      maxDensePortsBeforeDecimation,
    )
    if (portPoints.length === 0) continue

    for (let pointIndex = 0; pointIndex < portPoints.length; pointIndex++) {
      const portPoint = portPoints[pointIndex]!
      for (const z of sharedZ) {
        const portId = pushPort({
          region1Id: `${regionIdPrefix}-${first!.regionIndex}`,
          region2Id: `${regionIdPrefix}-${second!.regionIndex}`,
          pointIndex,
          portPoint,
          z,
        })
        serializedRegions[first!.regionIndex]!.pointIds.push(portId)
        serializedRegions[second!.regionIndex]!.pointIds.push(portId)
      }
    }
  }

  for (const obstacleInfo of obstacleRegionInfos) {
    for (const entries of edgeEntries.values()) {
      for (const meshEdge of entries) {
        if (
          !isBoundarySegmentOnPolygon(
            meshEdge.a,
            meshEdge.b,
            obstacleInfo.polygon,
          )
        ) {
          continue
        }

        const meshRegionAvailableZ =
          availableZ?.[meshEdge.regionIndex] ?? fallbackAvailableZ
        const sharedZ = meshRegionAvailableZ.filter((z) =>
          obstacleInfo.availableZ.includes(z),
        )
        if (sharedZ.length === 0) continue

        for (const z of sharedZ) {
          const portPoint = getNearestUnusedSinglePortPointOnSegment(
            meshEdge.a,
            meshEdge.b,
            z,
            usedPortPointKeys,
          )
          if (!portPoint) continue

          const portId = pushPort({
            region1Id: `${regionIdPrefix}-${meshEdge.regionIndex}`,
            region2Id: obstacleInfo.regionId,
            pointIndex: 0,
            portPoint,
            z,
            portIdSuffix: "::obstacle",
          })
          serializedRegions[meshEdge.regionIndex]!.pointIds.push(portId)
          serializedRegions[obstacleInfo.serializedRegionIndex]!.pointIds.push(
            portId,
          )
        }
      }
    }
  }

  for (
    let firstIndex = 0;
    firstIndex < obstacleRegionInfos.length;
    firstIndex++
  ) {
    const first = obstacleRegionInfos[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < obstacleRegionInfos.length;
      secondIndex++
    ) {
      const second = obstacleRegionInfos[secondIndex]!
      if (first.netId !== second.netId) continue

      const sharedZ = first.availableZ.filter((z) =>
        second.availableZ.includes(z),
      )
      if (sharedZ.length === 0) continue

      const contactPoint = findPolygonContactPoint(
        first.polygon,
        second.polygon,
      )
      if (!contactPoint) continue

      for (const z of sharedZ) {
        const portId = pushPort({
          region1Id: first.regionId,
          region2Id: second.regionId,
          pointIndex: 0,
          portPoint: {
            x: contactPoint.x,
            y: contactPoint.y,
            distToCentermostPortOnZ: 0,
          },
          z,
          portIdSuffix: "::obstacle-contact",
        })
        serializedRegions[first.serializedRegionIndex]!.pointIds.push(portId)
        serializedRegions[second.serializedRegionIndex]!.pointIds.push(portId)
      }
    }
  }

  const findEndpointRegion = (
    point: PolyHyperGraphConnectionPoint,
    preferredNetId?: number,
  ) => {
    const candidateZ = getPointCandidateZ(point, layerCount)
    let nearest:
      | {
          regionId: string
          serializedRegionIndex: number
          z: number
          distanceSq: number
        }
      | undefined

    const obstacleMatches = searchableRegions.filter(
      (region) =>
        region.isObstacle &&
        (preferredNetId === undefined || region.netId === preferredNetId),
    )
    for (const region of obstacleMatches) {
      const z =
        candidateZ.find((candidate) => region.availableZ.includes(candidate)) ??
        region.availableZ[0]
      if (z === undefined) continue
      if (pointInPolygon(point, region.polygon)) {
        return {
          regionId: region.regionId,
          serializedRegionIndex: region.serializedRegionIndex,
          z,
        }
      }
    }

    for (const region of searchableRegions.filter(
      (searchableRegion) => !searchableRegion.isObstacle,
    )) {
      const z =
        candidateZ.find((candidate) => region.availableZ.includes(candidate)) ??
        region.availableZ[0]
      if (z === undefined) continue
      if (pointInPolygon(point, region.polygon)) {
        return {
          regionId: region.regionId,
          serializedRegionIndex: region.serializedRegionIndex,
          z,
        }
      }
      const distanceSq = distanceToBoundsSq(point, region.bounds)
      if (!nearest || distanceSq < nearest.distanceSq) {
        nearest = {
          regionId: region.regionId,
          serializedRegionIndex: region.serializedRegionIndex,
          z,
          distanceSq,
        }
      }
    }
    return nearest
  }

  const serializedConnections: SerializedPolyHyperGraph["connections"] = []

  for (const connection of connections) {
    const preferredNetId = netIndexByNetKey.get(getConnectionNetKey(connection))
    const start = findEndpointRegion(connection.start, preferredNetId)
    const end = findEndpointRegion(connection.end, preferredNetId)
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

    ports.push({
      portId: startPortId,
      region1Id: start.regionId,
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
      region1Id: end.regionId,
      region2Id: endRegionId,
      d: {
        portId: endPortId,
        x: connection.end.x,
        y: connection.end.y,
        z: end.z,
        distToCentermostPortOnZ: 0,
      },
    })
    serializedRegions[start.serializedRegionIndex]!.pointIds.push(startPortId)
    serializedRegions[end.serializedRegionIndex]!.pointIds.push(endPortId)

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

export const applySerializedRegionNetIdsToLoadedProblem = (
  loaded: {
    topology: { regionCount: number; regionMetadata?: unknown[] }
    problem: { regionNetId?: Int32Array }
  },
  graph: SerializedPolyHyperGraph,
) => {
  const regionNetId = loaded.problem.regionNetId
  if (!regionNetId) return 0

  const netIdByRegionId = new Map<string, number>()
  for (const region of graph.regions) {
    const netId =
      typeof region.d?.netId === "number"
        ? region.d.netId
        : typeof region.d?.NetId === "number"
          ? region.d.NetId
          : undefined
    if (Number.isInteger(netId) && netId! >= 0) {
      netIdByRegionId.set(region.regionId, netId!)
    }
  }

  let appliedCount = 0
  for (
    let regionIndex = 0;
    regionIndex < loaded.topology.regionCount;
    regionIndex++
  ) {
    const metadata = loaded.topology.regionMetadata?.[regionIndex]
    const serializedRegionId =
      typeof metadata === "object" && metadata !== null
        ? (metadata as { serializedRegionId?: unknown }).serializedRegionId
        : undefined
    if (typeof serializedRegionId !== "string") continue

    const netId = netIdByRegionId.get(serializedRegionId)
    if (netId === undefined) continue

    regionNetId[regionIndex] = netId
    appliedCount += 1
  }

  return appliedCount
}
