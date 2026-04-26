const modulePath = "../../node_modules/tiny-hypergraph/lib/index.ts"
const tinyHypergraph = (await import(modulePath)) as any

export const PolyHyperGraphSolver = tinyHypergraph.PolyHyperGraphSolver
export const loadSerializedHyperGraphAsPoly =
  tinyHypergraph.loadSerializedHyperGraphAsPoly
