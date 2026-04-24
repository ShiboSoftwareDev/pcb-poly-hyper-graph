import { BasePipelineSolver, definePipelineStep } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { BuildRegionsSolver } from "./BuildRegionsSolver"
import { GeneratePointsSolver } from "./GeneratePointsSolver"
import { MergeCellsSolver } from "./MergeCellsSolver"
import { TriangulateSolver } from "./TriangulateSolver"
import type {
  ConvexRegionsComputeInput,
  ConvexRegionsComputeResult,
  GeneratePointsStageOutput,
  MergeCellsStageOutput,
  TriangulateStageOutput,
} from "./types"

export class ConvexRegionsSolver extends BasePipelineSolver<ConvexRegionsComputeInput> {
  pipelineDef = [
    definePipelineStep("generatePoints", GeneratePointsSolver, (instance) => [
      instance.inputProblem,
    ]),
    definePipelineStep("triangulate", TriangulateSolver, (instance) => {
      const generated =
        instance.getStageOutput<GeneratePointsStageOutput>("generatePoints")
      if (!generated) throw new Error("generatePoints output missing")
      return [
        {
          pts: generated.pts,
          bounds: instance.inputProblem.bounds,
          vias: instance.inputProblem.vias,
          rects: instance.inputProblem.rects,
          polygons: instance.inputProblem.polygons,
          clearance: instance.inputProblem.clearance,
          layerCount: instance.inputProblem.layerCount,
          useConstrainedDelaunay: instance.inputProblem.useConstrainedDelaunay,
          constraintEdges: generated.constraintEdges,
          hadCrossings: generated.hadCrossings,
        },
      ]
    }),
    definePipelineStep("mergeCells", MergeCellsSolver, (instance) => {
      const triangulated =
        instance.getStageOutput<TriangulateStageOutput>("triangulate")
      if (!triangulated) throw new Error("triangulate output missing")
      return [
        {
          pts: triangulated.pts,
          bounds: triangulated.bounds,
          validTris: triangulated.validTris,
          triangleAvailableZ: triangulated.triangleAvailableZ,
          concavityTolerance: instance.inputProblem.concavityTolerance,
          layerMergeMode: instance.inputProblem.layerMergeMode,
          usePolyanyaMerge: instance.inputProblem.usePolyanyaMerge,
        },
      ]
    }),
    definePipelineStep("buildRegions", BuildRegionsSolver, (instance) => {
      const merged =
        instance.getStageOutput<MergeCellsStageOutput>("mergeCells")
      if (!merged) throw new Error("mergeCells output missing")
      return [merged]
    }),
  ]

  override getConstructorParams(): [ConvexRegionsComputeInput] {
    return [this.inputProblem]
  }

  override getOutput(): ConvexRegionsComputeResult | null {
    return (
      this.getStageOutput<ConvexRegionsComputeResult>("buildRegions") ?? null
    )
  }

  override visualize(): GraphicsObject {
    const result = this.getOutput()
    if (!result) {
      return { points: [], lines: [], rects: [], circles: [], texts: [] }
    }

    const boundsWidth =
      this.inputProblem.bounds.maxX - this.inputProblem.bounds.minX
    const boundsHeight =
      this.inputProblem.bounds.maxY - this.inputProblem.bounds.minY
    const maxDim = Math.max(boundsWidth, boundsHeight, Number.EPSILON)

    // Normalize tiny coordinate domains (e.g. [-1, 1]) so visualization stays
    // readable and consistent with larger board-scale snapshots.
    const targetVisualSize = 400
    const displayScale = Math.max(1, targetVisualSize / maxDim)
    const displayOffsetX = -this.inputProblem.bounds.minX * displayScale
    const displayOffsetY = -this.inputProblem.bounds.minY * displayScale

    const toDisplayPoint = (point: { x: number; y: number }) => ({
      x: point.x * displayScale + displayOffsetX,
      y: point.y * displayScale + displayOffsetY,
    })

    // Generate polygon obstacle lines
    const polygonLines = (this.inputProblem.polygons ?? []).flatMap(
      (polygon) => {
        const pts = polygon.points
        return pts.map((p, i) => {
          const next = pts[(i + 1) % pts.length]!
          return {
            points: [toDisplayPoint(p), toDisplayPoint(next)],
            strokeColor: "#ff9f43",
            strokeWidth: 2,
          }
        })
      },
    )

    // Generate rect obstacle lines
    const rectLines = (this.inputProblem.rects ?? []).flatMap((rect) => {
      const halfW = rect.width / 2
      const halfH = rect.height / 2
      const cos = Math.cos(rect.ccwRotation)
      const sin = Math.sin(rect.ccwRotation)

      const corners = [
        { lx: -halfW, ly: -halfH },
        { lx: halfW, ly: -halfH },
        { lx: halfW, ly: halfH },
        { lx: -halfW, ly: halfH },
      ].map(({ lx, ly }) => ({
        x: rect.center.x + lx * cos - ly * sin,
        y: rect.center.y + lx * sin + ly * cos,
      }))

      return corners.map((p, i) => {
        const next = corners[(i + 1) % corners.length]!
        return {
          points: [toDisplayPoint(p), toDisplayPoint(next)],
          strokeColor: "#ff6b6b",
          strokeWidth: 2,
        }
      })
    })

    return {
      points: result.pts.map((pt) => ({
        ...toDisplayPoint(pt),
        color: "#38b6ff",
      })),
      lines: [
        ...result.regions.flatMap((region) =>
          region.map((p, i) => {
            const next = region[(i + 1) % region.length] ?? p
            return {
              points: [toDisplayPoint(p), toDisplayPoint(next)],
              strokeColor: "#4ecb82",
            }
          }),
        ),
        ...polygonLines,
        ...rectLines,
      ],
      rects: [],
      circles: (this.inputProblem.vias ?? []).map((via) => ({
        center: toDisplayPoint(via.center),
        radius: (via.diameter / 2) * displayScale,
        stroke: "#ff6b6b",
      })),
      texts: [
        {
          x: 8,
          y: 16,
          text: `regions=${result.regions.length}`,
          color: "#ffffff",
        },
      ],
    }
  }
}
