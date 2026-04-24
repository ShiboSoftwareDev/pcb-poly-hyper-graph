import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { constrainedDelaunay } from "./constrainedDelaunay"
import { delaunay } from "./delaunay"
import { filterTrisByAvailableZ } from "./filter-tris-by-available-z"
import { filterTris } from "./filterTris"
import type { TriangulateStageInput, TriangulateStageOutput } from "./types"

export class TriangulateSolver extends BaseSolver {
  private readonly input: TriangulateStageInput
  private output: TriangulateStageOutput | null = null

  constructor(input: TriangulateStageInput) {
    super()
    this.input = input
  }

  override _step(): void {
    const vias = this.input.vias ?? []
    const rects = this.input.rects ?? []
    const polygons = this.input.polygons ?? []

    let validTris: import("./types").Triangle[]
    let triangleAvailableZ: number[][] | undefined

    if (
      this.input.useConstrainedDelaunay !== false &&
      this.input.constraintEdges
    ) {
      const cdtTris = constrainedDelaunay(
        this.input.pts,
        this.input.constraintEdges,
        {
          includeConstraintInteriors: this.input.layerCount !== undefined,
        },
      )
      if (this.input.layerCount !== undefined) {
        const filtered = filterTrisByAvailableZ({
          triangles: cdtTris,
          pts: this.input.pts,
          bounds: this.input.bounds,
          vias,
          clearance: this.input.clearance,
          rects,
          polygons,
          layerCount: this.input.layerCount,
        })
        validTris = filtered.triangles
        triangleAvailableZ = filtered.triangleAvailableZ
      } else {
        // Always filter when obstacles exist — even without edge crossings,
        // one obstacle fully contained inside another can produce invalid triangles
        const hasObstacles =
          vias.length > 0 || rects.length > 0 || polygons.length > 0
        validTris = hasObstacles
          ? filterTris({
              triangles: cdtTris,
              pts: this.input.pts,
              bounds: this.input.bounds,
              vias,
              clearance: this.input.clearance,
              rects,
              polygons,
            })
          : cdtTris
      }
    } else {
      const allTriangles = delaunay(this.input.pts)
      if (this.input.layerCount !== undefined) {
        const filtered = filterTrisByAvailableZ({
          triangles: allTriangles,
          pts: this.input.pts,
          bounds: this.input.bounds,
          vias,
          clearance: this.input.clearance,
          rects,
          polygons,
          layerCount: this.input.layerCount,
        })
        validTris = filtered.triangles
        triangleAvailableZ = filtered.triangleAvailableZ
      } else {
        validTris = filterTris({
          triangles: allTriangles,
          pts: this.input.pts,
          bounds: this.input.bounds,
          vias,
          clearance: this.input.clearance,
          rects,
          polygons,
        })
      }
    }

    this.output = {
      pts: this.input.pts,
      bounds: this.input.bounds,
      validTris,
      ...(triangleAvailableZ ? { triangleAvailableZ } : {}),
    }

    this.stats = {
      validTriangles: validTris.length,
    }
    this.solved = true
  }

  override getConstructorParams(): [TriangulateStageInput] {
    return [this.input]
  }

  override getOutput(): TriangulateStageOutput | null {
    return this.output
  }

  override visualize(): GraphicsObject {
    const triangles = this.output?.validTris ?? []

    return {
      points: this.input.pts.map((pt) => ({
        x: pt.x,
        y: pt.y,
        color: "#2563eb",
      })),
      lines: triangles.flatMap(([a, b, c]) => {
        const pa = this.input.pts[a]
        const pb = this.input.pts[b]
        const pc = this.input.pts[c]
        if (!pa || !pb || !pc) return []

        return [
          { points: [pa, pb], strokeColor: "#64748b" },
          { points: [pb, pc], strokeColor: "#64748b" },
          { points: [pc, pa], strokeColor: "#64748b" },
        ]
      }),
      rects: [],
      circles: [],
      texts: [
        {
          x: this.input.bounds.minX + 6,
          y: this.input.bounds.minY + 12,
          text: `valid triangles: ${triangles.length}`,
          color: "#1f2937",
        },
      ],
    }
  }
}
