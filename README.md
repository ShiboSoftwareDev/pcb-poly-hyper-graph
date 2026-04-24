# @tscircuit/find-convex-regions

Decompose a 2D rectangular area into convex regions around obstacles (vias, rectangles, and arbitrary polygons). Useful for PCB autorouting and spatial partitioning where convex sub-regions simplify pathfinding.

## Installation

```bash
npm install @tscircuit/find-convex-regions
```

## Usage

### Basic (vias only)

```ts
import { ConvexRegionsSolver } from "@tscircuit/find-convex-regions"

const solver = new ConvexRegionsSolver({
  bounds: { minX: 0, maxX: 450, minY: 0, maxY: 450 },
  vias: [
    { center: { x: 120, y: 150 }, diameter: 30 },
    { center: { x: 250, y: 100 }, diameter: 25 },
    { center: { x: 200, y: 280 }, diameter: 35 },
  ],
  clearance: 8,
  concavityTolerance: 0,
})

solver.solve()

const output = solver.getOutput()
console.log(output.regions)  // Point[][] — each region is a convex polygon
console.log(output.hulls)    // Point[][] — convex hull of each region
console.log(output.depths)   // number[]  — concavity depth per region
```

### Layer-aware PCB nav meshes

Pass `layerCount` and per-obstacle `layers` or `zLayers` to compute
`availableZ` for each output region. Layer-specific obstacles remain in the
triangulation instead of becoming 2D holes, so a copper pour on `inner1` of a
4-layer board can produce regions with `availableZ: [0, 2, 3]`.

```ts
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
  layerMergeMode: "same",
})

console.log(result.availableZ)
```

`layerMergeMode: "same"` only merges adjacent cells with identical layer masks.
`"intersection"` allows merges when cells share at least one layer and assigns
the merged region the layer intersection.

### PolyHyperGraph export

Use `buildPolyHyperGraphFromRegions` to turn generated convex polygons into the
serialized graph shape consumed by tiny-hypergraph's `loadSerializedHyperGraphAsPoly`.

```ts
import {
  buildPolyHyperGraphFromRegions,
  computeConvexRegions,
} from "@tscircuit/find-convex-regions"

const regions = computeConvexRegions({ /* ... layer-aware input ... */ })
const graph = buildPolyHyperGraphFromRegions({
  regions: regions.regions,
  availableZ: regions.availableZ,
  layerCount: 4,
  connections: [
    {
      connectionId: "net-1",
      start: { x: 1, y: 1, layer: "top" },
      end: { x: 9, y: 9, layer: "bottom" },
    },
  ],
})
```

### Rectangular obstacles

```ts
const solver = new ConvexRegionsSolver({
  bounds: { minX: 0, maxX: 450, minY: 0, maxY: 450 },
  rects: [
    { center: { x: 200, y: 200 }, width: 50, height: 25, ccwRotation: 0 },
    { center: { x: 300, y: 150 }, width: 34, height: 18, ccwRotation: Math.PI / 6 },
  ],
  clearance: 8,
  concavityTolerance: 0,
})
```

### Polygon obstacles

```ts
const solver = new ConvexRegionsSolver({
  bounds: { minX: 0, maxX: 400, minY: 0, maxY: 400 },
  polygons: [
    {
      points: [
        { x: 100, y: 60 },
        { x: 134.6, y: 120 },
        { x: 65.4, y: 120 },
      ],
    },
  ],
  clearance: 8,
  concavityTolerance: 0,
})
```

### Mixed obstacles

All three obstacle types can be combined in a single input.

```ts
const solver = new ConvexRegionsSolver({
  bounds: { minX: 0, maxX: 400, minY: 0, maxY: 400 },
  vias: [{ center: { x: 200, y: 200 }, diameter: 30 }],
  rects: [{ center: { x: 200, y: 100 }, width: 50, height: 25, ccwRotation: 0 }],
  polygons: [{ points: [{ x: 100, y: 265 }, { x: 130.3, y: 335 }, { x: 69.7, y: 335 }] }],
  clearance: 8,
  concavityTolerance: 0,
})
```

### Constrained Delaunay Triangulation (CDT)

CDT is enabled by default. It forces obstacle boundary edges into the triangulation, preventing triangle edges from crossing through obstacles — a structural guarantee the unconstrained approach can only approximate via centroid filtering. To disable CDT and use the legacy unconstrained Bowyer-Watson approach:

```ts
const solver = new ConvexRegionsSolver({
  bounds: { minX: 0, maxX: 450, minY: 0, maxY: 450 },
  vias: [
    { center: { x: 120, y: 150 }, diameter: 30 },
    { center: { x: 250, y: 100 }, diameter: 25 },
  ],
  clearance: 8,
  concavityTolerance: 0,
  useConstrainedDelaunay: false,  // use legacy unconstrained approach
})
```

CDT mode uses minimal sampling — octagon vias (8 points vs 24), corner-only rects (4 points vs ~20), and vertex-only polygon offsets. Constraint edges enforce the boundaries structurally, so intermediate edge samples are redundant. When obstacles are present, overlapping boundaries are automatically unioned (via `@flatten-js/core`) before constraint edges are generated, and `filterTris` runs to remove any invalid triangles. Crossing constraint edges are resolved as a safety net for any remaining overlaps.

The `viaSegments` option controls how many points approximate each circular via boundary. It defaults to **8** (octagon) in CDT mode and **24** in unconstrained mode. Override with any value:

```ts
const solver = new ConvexRegionsSolver({
  // ...
  useConstrainedDelaunay: true,
  viaSegments: 12,  // 12-gon instead of default octagon
})
```

### Functional API

A standalone function is also available if you don't need the solver pipeline:

```ts
import { computeConvexRegions } from "@tscircuit/find-convex-regions"

const result = computeConvexRegions({
  bounds: { minX: 0, maxX: 450, minY: 0, maxY: 450 },
  vias: [{ center: { x: 120, y: 150 }, diameter: 30 }],
  clearance: 8,
  concavityTolerance: 0,
})
```

### Region ports

Compute entry/exit points along shared edges between regions:

```ts
import { computeRegionPorts } from "@tscircuit/find-convex-regions"

const ports = computeRegionPorts({
  regions: result.regions,
  bounds: { minX: 0, maxX: 450, minY: 0, maxY: 450 },
  vias: [],
  clearance: 8,
})
// RegionPort[] — { x, y, region } for each port point
```

## Input Types

```ts
type Point   = { x: number; y: number }
type Via     = { center: Point; diameter: number }
type Rect    = { center: Point; width: number; height: number; ccwRotation: number }
type Polygon = { points: Point[] }
type Bounds  = { minX: number; maxX: number; minY: number; maxY: number }
```

| Parameter | Description |
|---|---|
| `bounds` | Rectangular area to partition. |
| `vias` | Circular obstacles. Each gets `clearance` added to its radius. |
| `rects` | Rotated rectangular obstacles. Supports arbitrary `ccwRotation`. |
| `polygons` | Arbitrary closed polygon obstacles (3+ vertices). |
| `clearance` | Buffer distance added around every obstacle boundary. |
| `concavityTolerance` | `0` for strictly convex regions. Higher values allow shallow concavity when merging adjacent cells, producing fewer, larger regions. Ignored when `usePolyanyaMerge` is `true`. |
| `layerCount` | Number of PCB routing layers. Enables layer-aware filtering and `availableZ` output. |
| `layerMergeMode` | `"same"` (default) preserves exact layer masks while merging. `"intersection"` permits merges across different layer masks and keeps only shared layers. |
| `useConstrainedDelaunay` | Use CDT instead of unconstrained Bowyer-Watson. Prevents edge crossings through obstacles. Uses minimal sampling (corner-only rects, octagon vias). Default `true`. Set to `false` to use the legacy unconstrained approach. |
| `usePolyanyaMerge` | Use Polyanya-style two-phase merge (dead-end elimination + max-area priority queue) instead of greedy concavity-bounded merge. Produces strictly convex regions, 3-10x faster at scale. Default `true`. Set to `false` to use the legacy greedy merge. |
| `viaSegments` | Number of points per via boundary ring. Default `8` with CDT, `24` without. |

## Output

```ts
type ConvexRegionsComputeResult = {
  pts: Point[]         // All sample points used in triangulation
  validTris: Triangle[] // Delaunay triangles that lie in free space
  regions: Point[][]   // Final merged convex regions (ordered vertex rings)
  hulls: Point[][]     // Convex hull of each region
  depths: number[]     // Max concavity depth of each region (0 = perfectly convex)
  availableZ?: number[][] // Available routing layers per region when layerCount is set
}
```

## Benchmark

Run the dataset01 comparison with:

```bash
./benchmark.sh
```

The benchmark partially runs `@tscircuit/capacity-autorouter` pipeline 4 to the
tiny-hypergraph port-point graph, measures baseline max/average region cost,
then builds a find-convex-regions PolyHyperGraph for the same SRJ and measures
`PolyHyperGraphSolver` region costs. Useful knobs:

```bash
SCENARIO_LIMIT=20 EFFORT=0.1 LAYER_MERGE_MODE=same ./benchmark.sh
```

## How It Works

The algorithm runs as a four-stage pipeline:

### 1. Generate Boundary Points

Sample points along all obstacle boundaries and the bounding rectangle edges:

- **Bounds**: 4 corners + 10 interpolated points per edge (40 boundary points total).
- **Vias**: `viaSegments` points evenly spaced around each circle at `radius + clearance` (default 8 with CDT, 24 without).
- **Rects**: In unconstrained mode, points along each edge of the clearance-expanded rotated rectangle. In CDT mode, corners only (4 points per rect).
- **Polygons**: Offset each edge outward by `clearance` (using `@flatten-js/core` for line intersection). In unconstrained mode, sample along offset edges. In CDT mode, offset vertices only.

A tiny per-point jitter (~1e-6) prevents degenerate collinear inputs for Delaunay.

In CDT mode, points are generated in perimeter-walk order per obstacle, and consecutive constraint edges are recorded alongside the point array. If obstacle boundaries overlap (crossing constraint edges), intersection points are inserted and edges are split automatically.

### 2. Triangulation

**Unconstrained mode** (`useConstrainedDelaunay: false`): Run Bowyer-Watson incremental Delaunay triangulation on the point set, then filter out any triangle whose centroid (or edge midpoints, for polygon obstacles) falls inside an obstacle or outside the bounds.

**CDT mode (default)** (`useConstrainedDelaunay: true`): Run constrained Delaunay triangulation via `cdt2d`, which forces obstacle boundary edges into the triangulation mesh. With `exterior: false`, triangles outside bounds are excluded structurally. When obstacles are present, `filterTris` runs to remove any triangles inside obstacle boundaries (necessary even without edge crossings, e.g., when one obstacle is fully contained inside another).

Both modes produce a triangle mesh covering only the free space.

### 3. Greedy Cell Merging

Starting from individual triangles as cells, iteratively merge adjacent cell pairs:

- Build an edge-adjacency map across all cells.
- For each pair of adjacent cells, stitch their boundary rings by removing shared edges and walking the remaining edges to form a merged ring.
- Compute the **concavity depth** of the merged ring: the maximum distance from any interior vertex to the convex hull boundary.
- Greedily pick the merge with the lowest concavity depth, accepting it only if `depth <= concavityTolerance`.
- Repeat until no more valid merges remain (up to 800 iterations).

### 4. Build Regions

Convert the final merged cells (index arrays) into concrete `Point[][]` regions and compute their convex hulls.

## Solver Pipeline

`ConvexRegionsSolver` extends `BasePipelineSolver` from `@tscircuit/solver-utils` and chains four sub-solvers:

| Stage | Solver | Output |
|---|---|---|
| `generatePoints` | `GeneratePointsSolver` | `{ pts }` |
| `triangulate` | `TriangulateSolver` | `{ pts, validTris }` |
| `mergeCells` | `MergeCellsSolver` | `{ pts, validTris, cells, depths }` |
| `buildRegions` | `BuildRegionsSolver` | `{ pts, validTris, regions, hulls, depths }` |

Each solver has a `visualize()` method returning a `GraphicsObject` for debug rendering.

## Utilities

The library also exports these lower-level functions:

| Function | Description |
|---|---|
| `delaunay(pts)` | Bowyer-Watson Delaunay triangulation. |
| `constrainedDelaunay(pts, edges)` | Constrained Delaunay triangulation via `cdt2d`. |
| `filterTris(...)` | Remove triangles that overlap obstacles or lie outside bounds. |
| `mergeCells(...)` | Greedy concavity-bounded cell merging. |
| `mergeCellsPolyanya(...)` | Polyanya-style two-phase merge (dead-end elimination + max-area priority queue). |
| `stitchRings(a, b)` | Merge two adjacent cell boundary rings by removing shared edges. |
| `concavityDepth(ring, pts)` | Max distance from any ring vertex to its convex hull boundary. |
| `hullIdx(indices, pts)` | Andrew's monotone chain convex hull (returns indices). |
| `inFreeSpace(...)` | Test whether a point is in unobstructed space. |
| `isPointInOrNearPolygon(...)` | Point-in-polygon + clearance distance test (uses `@flatten-js/core`). |
| `getOffsetPolygonPoints(...)` | Offset a polygon outward by clearance and sample along edges. |
| `computeRegionPorts(...)` | Generate entry/exit port points along region boundaries. |
| `generateBoundaryPoints(...)` | Sample points around all obstacle boundaries. |
| `generateBoundaryPointsWithEdges(...)` | Same as above, but returns constraint edges alongside points (for CDT). |
| `unionObstacleBoundaries(rings)` | Union overlapping obstacle boundary rings into non-overlapping polygons (via `@flatten-js/core`). |
| `resolveConstraintCrossings(...)` | Detect and split crossing constraint edges by inserting intersection points. |
| `cross({ o, a, b })` | 2D cross product (orientation test). |
| `circumcircle({ a, b, c })` | Circumscribed circle of a triangle. |
| `dist2(a, b)` | Squared distance between two points. |
| `ptSegDist({ p, a, b })` | Point-to-segment distance. |
| `polyArea(ring)` | Shoelace formula polygon area. |
| `regionPath(region)` | Convert a region to an SVG path string. |
| `rotatePoint(...)` | Rotate a local-space point by a `Rect`'s rotation. |
