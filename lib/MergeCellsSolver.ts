import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { mergeCells } from "./mergeCells"
import { mergeCellsPolyanya } from "./mergeCellsPolyanya"
import type { MergeCellsStageInput, MergeCellsStageOutput } from "./types"

export class MergeCellsSolver extends BaseSolver {
  private readonly input: MergeCellsStageInput
  private output: MergeCellsStageOutput | null = null

  constructor(input: MergeCellsStageInput) {
    super()
    this.input = input
  }

  override _step(): void {
    const merged =
      this.input.usePolyanyaMerge !== false
        ? mergeCellsPolyanya({
            triangles: this.input.validTris,
            pts: this.input.pts,
            cellAvailableZ: this.input.triangleAvailableZ,
            layerMergeMode: this.input.layerMergeMode,
          })
        : mergeCells({
            triangles: this.input.validTris,
            pts: this.input.pts,
            concavityTolerance: this.input.concavityTolerance,
            cellAvailableZ: this.input.triangleAvailableZ,
            layerMergeMode: this.input.layerMergeMode,
          })

    this.output = {
      pts: this.input.pts,
      bounds: this.input.bounds,
      validTris: this.input.validTris,
      triangleAvailableZ: this.input.triangleAvailableZ,
      cells: merged.cells,
      depths: merged.depths,
      ...(merged.availableZ ? { availableZ: merged.availableZ } : {}),
    }

    this.stats = {
      mergedCells: merged.cells.length,
      maxDepth: merged.depths.length ? Math.max(...merged.depths) : 0,
    }
    this.solved = true
  }

  override getConstructorParams(): [MergeCellsStageInput] {
    return [this.input]
  }

  override getOutput(): MergeCellsStageOutput | null {
    return this.output
  }

  override visualize(): GraphicsObject {
    const cells = this.output?.cells ?? []

    return {
      points: this.input.pts.map((pt) => ({
        x: pt.x,
        y: pt.y,
        color: "#3b82f6",
      })),
      lines: cells.flatMap((cell) =>
        cell.flatMap((index, i) => {
          const from = this.input.pts[index]
          const nextIndex = cell[(i + 1) % cell.length]
          const to =
            nextIndex === undefined ? undefined : this.input.pts[nextIndex]
          if (!from || !to) return []
          return [{ points: [from, to], strokeColor: "#10b981" }]
        }),
      ),
      rects: [],
      circles: [],
      texts: [
        {
          x: 4,
          y: 12,
          text: `merged cells: ${cells.length}`,
          color: "#1f2937",
        },
      ],
    }
  }
}
