export type Point = {
  x: number
  y: number
}

export type Via = {
  center: Point
  diameter: number
  layers?: string[]
  zLayers?: number[]
  isCopperPour?: boolean
}

export type Rect = {
  center: Point
  width: number
  height: number
  ccwRotation: number
  layers?: string[]
  zLayers?: number[]
  isCopperPour?: boolean
}

export type Polygon = {
  points: Point[]
  layers?: string[]
  zLayers?: number[]
  isCopperPour?: boolean
}

export type Bounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export type Triangle = [number, number, number]

export type ConvexRegionsComputeInput = {
  bounds: Bounds
  vias?: Via[]
  rects?: Rect[]
  polygons?: Polygon[]
  clearance: number
  concavityTolerance: number
  layerCount?: number
  layerMergeMode?: LayerMergeMode
  useConstrainedDelaunay?: boolean
  usePolyanyaMerge?: boolean
  viaSegments?: number
}

export type ConvexRegionsComputeResult = {
  pts: Point[]
  validTris: Triangle[]
  regions: Point[][]
  hulls: Point[][]
  depths: number[]
  availableZ?: number[][]
}

export type RegionPort = {
  x: number
  y: number
  region: number
}

export type GeneratePointsStageOutput = {
  pts: Point[]
  constraintEdges?: [number, number][]
  hadCrossings?: boolean
}

export type TriangulateStageInput = GeneratePointsStageOutput & {
  bounds: Bounds
  vias?: Via[]
  rects?: Rect[]
  polygons?: Polygon[]
  clearance: number
  layerCount?: number
  useConstrainedDelaunay?: boolean
}

export type TriangulateStageOutput = GeneratePointsStageOutput & {
  bounds: Bounds
  validTris: Triangle[]
  triangleAvailableZ?: number[][]
}

export type MergeCellsStageInput = TriangulateStageOutput & {
  concavityTolerance: number
  layerMergeMode?: LayerMergeMode
  usePolyanyaMerge?: boolean
}

export type MergeCellsStageOutput = TriangulateStageOutput & {
  cells: number[][]
  depths: number[]
  availableZ?: number[][]
}

export type LayerMergeMode = "same" | "intersection"
