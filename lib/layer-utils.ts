import type { Polygon, Rect, Via } from "./types"

export type LayeredObstacle = Via | Rect | Polygon

export const getAllLayerMask = (layerCount: number): number => {
  const safeLayerCount = Math.max(0, Math.min(30, Math.floor(layerCount)))
  return safeLayerCount === 0 ? 0 : (1 << safeLayerCount) - 1
}

export const getAvailableZFromMask = (mask: number, layerCount = 31) => {
  const availableZ: number[] = []
  const safeLayerCount = Math.max(0, Math.min(31, Math.floor(layerCount)))
  for (let z = 0; z < safeLayerCount; z++) {
    if ((mask & (1 << z)) !== 0) {
      availableZ.push(z)
    }
  }
  return availableZ
}

export const getMaskFromAvailableZ = (availableZ: readonly number[]) => {
  let mask = 0
  for (const z of availableZ) {
    if (Number.isInteger(z) && z >= 0 && z < 31) {
      mask |= 1 << z
    }
  }
  return mask
}

export const mapLayerNameToZ = (
  layerName: string,
  layerCount: number,
): number | undefined => {
  const normalized = layerName.trim().toLowerCase()
  if (normalized === "top") return 0
  if (normalized === "bottom") return Math.max(0, layerCount - 1)

  const innerMatch = normalized.match(/^inner(\d+)$/)
  if (innerMatch?.[1]) {
    const z = Number(innerMatch[1])
    return z >= 0 && z < layerCount ? z : undefined
  }

  const layerMatch = normalized.match(/^layer(\d+)$/)
  if (layerMatch?.[1]) {
    const oneBasedLayer = Number(layerMatch[1])
    const z = oneBasedLayer - 1
    return z >= 0 && z < layerCount ? z : undefined
  }

  const zMatch = normalized.match(/^z(\d+)$/)
  if (zMatch?.[1]) {
    const z = Number(zMatch[1])
    return z >= 0 && z < layerCount ? z : undefined
  }

  return undefined
}

export const getObstacleLayerMask = (
  obstacle: LayeredObstacle,
  layerCount: number,
): number => {
  const allLayerMask = getAllLayerMask(layerCount)
  const zLayers = obstacle.zLayers
  if (Array.isArray(zLayers) && zLayers.length > 0) {
    return getMaskFromAvailableZ(zLayers) & allLayerMask
  }

  const layerNames = obstacle.layers
  if (Array.isArray(layerNames) && layerNames.length > 0) {
    let mask = 0
    for (const layerName of layerNames) {
      const z = mapLayerNameToZ(layerName, layerCount)
      if (z !== undefined) {
        mask |= 1 << z
      }
    }
    return mask & allLayerMask
  }

  return allLayerMask
}

export const hasLayerMetadata = (obstacle: LayeredObstacle): boolean =>
  (Array.isArray(obstacle.zLayers) && obstacle.zLayers.length > 0) ||
  (Array.isArray(obstacle.layers) && obstacle.layers.length > 0)
