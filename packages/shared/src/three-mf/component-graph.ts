/**
 * The root model's `<component>` graph, and the one invariant the importer cannot survive breaking.
 *
 * OWNS the acyclicity check on the model entry a bake writes. BambuStudio resolves an object's
 * geometry by walking its components with a worklist and NO visited set
 * (`_generate_current_object_list`, `bbs_3mf.cpp:4992-5016`): every component it pops is pushed back
 * as its own children, so a cycle re-pushes forever and `id_list` grows until the process dies. It
 * is not a rejected file or a mangled model, it is a hang and then an out-of-memory kill, with no
 * error message naming the project.
 *
 * WHY THE CHECK IS HERE AND NOT AT THE SCHEMA. The schema can reject the obvious shape (a part whose
 * mesh import IS its host import), and it does. It cannot see a cycle assembled from two individually
 * valid edits: add import H as a part of import M, and M as a part of H, and every field validates.
 * Only the written graph shows it.
 *
 * SCOPE, deliberately the root entry alone. The importer keys objects by (entry path, object id) --
 * `typedef std::pair<std::string, int> Id`, `bbs_3mf.cpp:755` -- so a cycle can in principle cross
 * into `/3D/Objects/*.model`. The bake writes components into the ROOT model only and streams the
 * sub-models through untouched, so a cross-entry cycle is one a base file already had, not one we
 * introduce. Reading every sub-model to find it would materialise the bulk of the archive, which is
 * exactly what this module's callers avoid doing (see the transform note in `bake.ts`). Revisit if a
 * bake ever starts authoring components into a sub-model.
 */

/** An intra-entry edge: `<component objectid="…"/>` with no `p:path` sending it to another entry. */
const OBJECT_OR_COMPONENT =
  /<object\b[^>]*?\bid="(\d+)"[^>]*?>|<\/object\s*>|<component\b([^>]*?)\/?>/g

/**
 * The first component cycle in a root model entry, as `1 -> 4 -> 1`, or null when the graph is a DAG.
 *
 * Linear in the entry's length and allocates only the adjacency of objects that actually HAVE
 * components: a model whose objects all carry inline meshes builds an empty graph. That matters
 * because this runs over the root entry of every save, and that entry can be hundreds of megabytes.
 */
export function findComponentCycle(rootModelXml: string): string | null {
  const edges = new Map<number, number[]>()
  const stack: number[] = []
  OBJECT_OR_COMPONENT.lastIndex = 0
  for (let token = OBJECT_OR_COMPONENT.exec(rootModelXml); token; token = OBJECT_OR_COMPONENT.exec(rootModelXml)) {
    const [, openId, componentAttrs] = token
    if (openId != null) {
      stack.push(Number.parseInt(openId, 10))
      continue
    }
    if (componentAttrs != null) {
      const parent = stack[stack.length - 1]
      if (parent == null) continue
      // A `p:path` component addresses another entry's id space, so it cannot close a cycle inside
      // this one. Skipping it is what keeps the check honest rather than merely cheap.
      if (/\bp:path\s*=/.test(componentAttrs)) continue
      const child = Number.parseInt(componentAttrs.match(/\bobjectid="(\d+)"/)?.[1] ?? '', 10)
      if (!Number.isInteger(child)) continue
      const existing = edges.get(parent)
      if (existing) existing.push(child)
      else edges.set(parent, [child])
      continue
    }
    stack.pop()
  }
  if (edges.size === 0) return null

  // Iterative DFS with an explicit colour map: a model can nest components deeply enough that
  // recursion would blow the JS stack on exactly the pathological input this exists to catch.
  const VISITING = 1
  const DONE = 2
  const colour = new Map<number, number>()
  for (const root of edges.keys()) {
    if (colour.get(root) === DONE) continue
    const path: number[] = []
    const work: Array<{ node: number; childIndex: number }> = [{ node: root, childIndex: 0 }]
    colour.set(root, VISITING)
    path.push(root)
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const children = edges.get(frame.node) ?? []
      if (frame.childIndex >= children.length) {
        colour.set(frame.node, DONE)
        work.pop()
        path.pop()
        continue
      }
      const child = children[frame.childIndex++]!
      const seen = colour.get(child)
      if (seen === VISITING) return [...path.slice(path.indexOf(child)), child].join(' -> ')
      if (seen === DONE) continue
      colour.set(child, VISITING)
      path.push(child)
      work.push({ node: child, childIndex: 0 })
    }
  }
  return null
}

/**
 * Refuse to write a model whose components cycle.
 *
 * Throws rather than reporting, unlike the repairable-defect checks: those describe a file that
 * merely opens wrong and that the user can choose to fix, whereas this one wedges BambuStudio on
 * open with no diagnostic. A save that fails loudly is strictly better than an artifact that cannot
 * be opened to find out why.
 */
export function assertAcyclicComponentGraph(rootModelXml: string): void {
  const cycle = findComponentCycle(rootModelXml)
  if (cycle) {
    throw new Error(
      `Refusing to save: objects reference each other in a loop (${cycle}). ` +
        'Opening this project would hang the slicer.'
    )
  }
}
