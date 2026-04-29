import { mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const getLocalPcbPolyIndexPath = () =>
  realpathSync(new URL("../lib/index.ts", import.meta.url))

export const getLocalTscircuitAutorouterBundle = async (
  tscircuitAutorouterIndexUrl: URL,
) => {
  const outdir = join(tmpdir(), "pcb-poly-hyper-graph-tscircuit-autorouter")
  mkdirSync(outdir, { recursive: true })

  const localPcbPolyIndexPath = getLocalPcbPolyIndexPath()
  const result = await Bun.build({
    entrypoints: [tscircuitAutorouterIndexUrl.pathname],
    outdir,
    target: "bun",
    format: "esm",
    packages: "bundle",
    plugins: [
      {
        name: "local-pcb-poly-hyper-graph",
        setup(build) {
          build.onResolve({ filter: /^pcb-poly-hyper-graph$/ }, () => ({
            path: localPcbPolyIndexPath,
          }))
        },
      },
    ],
  })

  if (!result.success) {
    throw new Error(
      [
        "Failed to bundle tscircuit-autorouter with local pcb-poly-hyper-graph.",
        ...result.logs.map((log) => String(log)),
      ].join("\n"),
    )
  }

  return {
    moduleUrl: pathToFileURL(join(outdir, "index.js")),
    localPcbPolyIndexPath,
  }
}
