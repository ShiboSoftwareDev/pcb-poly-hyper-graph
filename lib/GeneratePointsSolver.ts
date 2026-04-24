import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { generateBoundaryPoints } from "./generateBoundaryPoints"
import { generateBoundaryPointsWithEdges } from "./generateBoundaryPointsWithEdges"
import type {
  ConvexRegionsComputeInput,
  GeneratePointsStageOutput,
} from "./types"

export class GeneratePointsSolver extends BaseSolver {
  private readonly input: ConvexRegionsComputeInput
  private output: GeneratePointsStageOutput | null = null

  constructor(input: ConvexRegionsComputeInput) {
    super()
    this.input = input
  }

  override _step(): void {
    const vias = this.input.vias ?? []
    const rects = this.input.rects ?? []
    const polygons = this.input.polygons ?? []

    if (this.input.useConstrainedDelaunay !== false) {
      const result = generateBoundaryPointsWithEdges({
        bounds: this.input.bounds,
        vias,
        clearance: this.input.clearance,
        rects,
        polygons,
        viaSegments: this.input.viaSegments,
        preserveObstacleBoundaries: this.input.layerCount !== undefined,
      })
      this.output = {
        pts: result.pts,
        constraintEdges: result.constraintEdges,
        hadCrossings: result.hadCrossings,
      }
    } else {
      this.output = {
        pts: generateBoundaryPoints({
          bounds: this.input.bounds,
          vias,
          clearance: this.input.clearance,
          rects,
          polygons,
          viaSegments: this.input.viaSegments,
        }),
      }
    }
    this.stats = { points: this.output.pts.length }
    this.solved = true
  }

  override getConstructorParams(): [ConvexRegionsComputeInput] {
    return [this.input]
  }

  override getOutput(): GeneratePointsStageOutput | null {
    return this.output
  }

  override visualize(): GraphicsObject {
    const points = (this.output?.pts ?? []).map((pt) => ({
      x: pt.x,
      y: pt.y,
      color: "#2563eb",
    }))

    const vias = this.input.vias ?? []

    return {
      points,
      lines: [],
      rects: [],
      circles: vias.map((via) => ({
        center: { x: via.center.x, y: via.center.y },
        radius: via.diameter / 2 + this.input.clearance,
        stroke: "#ef4444",
      })),
      texts: [
        {
          x: this.input.bounds.minX + 6,
          y: this.input.bounds.minY + 12,
          text: `sample points: ${points.length}`,
          color: "#1f2937",
        },
      ],
    }
  }
}
