declare module "@tscircuit/autorouting-dataset-01" {
  const dataset: Record<string, unknown>
  export = dataset
}

declare module "tiny-hypergraph/lib/index" {
  export const PolyHyperGraphSolver: any
  export const loadSerializedHyperGraphAsPoly: any
}
