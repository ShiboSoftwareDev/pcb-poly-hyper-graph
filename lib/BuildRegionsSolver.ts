import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { buildRegionsFromCells } from "./buildRegionsFromCells"
import { clampPointToBounds } from "./clampPointToBounds"
import type { ConvexRegionsComputeResult, MergeCellsStageOutput } from "./types"

export class BuildRegionsSolver extends BaseSolver {
  private readonly input: MergeCellsStageOutput
  private output: ConvexRegionsComputeResult | null = null

  constructor(input: MergeCellsStageOutput) {
    super()
    this.input = input
  }

  override _step(): void {
    const boundedPts = this.input.pts.map((pt) =>
      clampPointToBounds(pt, this.input.bounds),
    )
    const { regions, hulls } = buildRegionsFromCells({
      ...this.input,
      pts: boundedPts,
    })
    this.output = {
      pts: boundedPts,
      validTris: this.input.validTris,
      regions,
      hulls,
      depths: this.input.depths,
      ...(this.input.availableZ ? { availableZ: this.input.availableZ } : {}),
    }
    this.stats = { regions: regions.length }
    this.solved = true
  }

  override getConstructorParams(): [MergeCellsStageOutput] {
    return [this.input]
  }

  override getOutput(): ConvexRegionsComputeResult | null {
    return this.output
  }

  override visualize(): GraphicsObject {
    const output = this.output
    if (!output) {
      return { points: [], lines: [], rects: [], circles: [], texts: [] }
    }

    return {
      points: output.pts.map((pt) => ({ x: pt.x, y: pt.y, color: "#3b82f6" })),
      lines: output.regions.flatMap((region) =>
        region.flatMap((point, i) => {
          const next = region[(i + 1) % region.length]
          if (!next) return []
          return [{ points: [point, next], strokeColor: "#0f766e" }]
        }),
      ),
      rects: [],
      circles: [],
      texts: [
        {
          x: 4,
          y: 12,
          text: `regions: ${output.regions.length}`,
          color: "#1f2937",
        },
      ],
    }
  }
}
