// Layered graph layout for the service map — Sugiyama without the Sugiyama.
//
// The web app lays its map out with ELK in a worker. That is a 700 kB
// dependency buying crossing minimisation for graphs with namespace groups,
// ports and orthogonal routing; local mode draws a plain SVG of a developer's
// handful of services and needs none of it. So: three passes, no dependency,
// and it runs synchronously in render.
//
//  1. **Break cycles.** A depth-first walk marks an edge back to a node still
//     on the stack as a back edge and takes it out of the graph being layered.
//     Without this, step 2 has no topological order at all — a call graph with
//     a retry loop or a pair of services that call each other is not a DAG, and
//     that is normal, not corrupt data.
//  2. **Layer by longest path.** A node sits one column right of its deepest
//     remaining predecessor. Longest path rather than shortest so an edge never
//     points backwards: with `a→b`, `a→c`, `c→b`, shortest-path would put `b`
//     in column 1 and draw `c→b` right-to-left.
//  3. **Order within a layer by barycentre.** Sweep down then up a few times,
//     each node taking the mean position of its neighbours in the adjacent
//     layer. This is the cheap classic, and on graphs this size it removes the
//     crossings a reader would otherwise notice.
//
// Coordinates come out in CSS pixels with the origin at the top left, one unit
// per pixel, so the renderer can place an HTML tooltip at a node's `x`/`y`
// without a transform. Nodes are positioned by their CENTRE.

export interface LayoutEdge {
	readonly source: string
	readonly target: string
}

export interface LayoutOptions {
	/** Horizontal distance between layer centres. */
	readonly columnWidth?: number
	/** Vertical distance between node centres in a layer. */
	readonly rowHeight?: number
	readonly nodeWidth?: number
	readonly nodeHeight?: number
	/** Down+up barycentre sweeps. Four is past the point of further change here. */
	readonly sweeps?: number
}

export interface LayoutNode {
	readonly id: string
	/** Column, counted from the sources. */
	readonly layer: number
	/** Row within the column, after ordering. */
	readonly order: number
	/** Centre, in px. */
	readonly x: number
	readonly y: number
}

export interface ServiceMapLayout {
	readonly nodes: readonly LayoutNode[]
	readonly byId: ReadonlyMap<string, LayoutNode>
	/**
	 * Edges removed to make the graph acyclic. They are still real edges and the
	 * renderer still draws them — they just point leftwards, which is how a cycle
	 * reads on a layered drawing.
	 */
	readonly backEdges: readonly LayoutEdge[]
	readonly width: number
	readonly height: number
}

const DEFAULTS = {
	columnWidth: 232,
	rowHeight: 78,
	nodeWidth: 168,
	nodeHeight: 46,
	sweeps: 4,
} satisfies Required<LayoutOptions>

/**
 * Lay out `nodeIds` and `edges`. Node order is the tie-break at every step, so
 * the same input always produces the same drawing — a map that reshuffled on
 * refetch would be unreadable even when nothing changed.
 *
 * Edges naming an id that is not in `nodeIds` are dropped: the node list is
 * what the renderer will draw, and an edge to nothing has no second endpoint to
 * be laid out against.
 */
export function layoutServiceMap(
	nodeIds: readonly string[],
	edges: readonly LayoutEdge[],
	options: LayoutOptions = {},
): ServiceMapLayout {
	const opts = { ...DEFAULTS, ...options }

	const ids = [...new Set(nodeIds)]
	const index = new Map(ids.map((id, i) => [id, i]))
	const known = (edge: LayoutEdge) => index.has(edge.source) && index.has(edge.target)
	const graphEdges = edges.filter(known)

	const { acyclic, backEdges } = breakCycles(ids, graphEdges)
	const layers = assignLayers(ids, acyclic)
	const rows = orderWithinLayers(ids, acyclic, layers, opts.sweeps)

	const layerCount = ids.length === 0 ? 0 : Math.max(...ids.map((id) => layers.get(id) ?? 0)) + 1
	const tallest = Math.max(0, ...rows.map((row) => row.length))

	const nodes = ids.map((id): LayoutNode => {
		const layer = layers.get(id) ?? 0
		const order = rows[layer].indexOf(id)
		// Centre each column against the tallest one, so a two-node layer sits
		// beside the middle of a six-node layer rather than at its top.
		const offset = ((tallest - rows[layer].length) * opts.rowHeight) / 2
		return {
			id,
			layer,
			order,
			x: opts.nodeWidth / 2 + layer * opts.columnWidth,
			y: opts.nodeHeight / 2 + offset + order * opts.rowHeight,
		}
	})

	return {
		nodes,
		byId: new Map(nodes.map((node) => [node.id, node])),
		backEdges,
		width: layerCount === 0 ? 0 : opts.nodeWidth + (layerCount - 1) * opts.columnWidth,
		height: tallest === 0 ? 0 : opts.nodeHeight + (tallest - 1) * opts.rowHeight,
	}
}

/**
 * Depth-first walk, iterative because a deep chain of services should not be
 * able to blow the JS stack. An edge into a node still open on the stack closes
 * a cycle, so it is the one taken out; a self-edge is the degenerate case of
 * the same thing.
 */
function breakCycles(
	ids: readonly string[],
	edges: readonly LayoutEdge[],
): { acyclic: readonly LayoutEdge[]; backEdges: readonly LayoutEdge[] } {
	const outgoing = new Map<string, LayoutEdge[]>(ids.map((id) => [id, []]))
	for (const edge of edges) outgoing.get(edge.source)!.push(edge)

	const backEdges = new Set<LayoutEdge>()
	const open = new Set<string>()
	const done = new Set<string>()

	for (const root of ids) {
		if (done.has(root)) continue
		const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }]
		open.add(root)
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]
			const siblings = outgoing.get(frame.id)!
			if (frame.next >= siblings.length) {
				stack.pop()
				open.delete(frame.id)
				done.add(frame.id)
				continue
			}
			const edge = siblings[frame.next++]
			if (open.has(edge.target)) {
				backEdges.add(edge)
				continue
			}
			if (done.has(edge.target)) continue
			open.add(edge.target)
			stack.push({ id: edge.target, next: 0 })
		}
	}

	return {
		acyclic: edges.filter((edge) => !backEdges.has(edge)),
		backEdges: edges.filter((edge) => backEdges.has(edge)),
	}
}

/** Longest-path layering over a DAG, in topological (Kahn) order. */
function assignLayers(ids: readonly string[], edges: readonly LayoutEdge[]): Map<string, number> {
	const successors = new Map<string, string[]>(ids.map((id) => [id, []]))
	const indegree = new Map<string, number>(ids.map((id) => [id, 0]))
	for (const edge of edges) {
		successors.get(edge.source)!.push(edge.target)
		indegree.set(edge.target, indegree.get(edge.target)! + 1)
	}

	const layers = new Map<string, number>(ids.map((id) => [id, 0]))
	const queue = ids.filter((id) => indegree.get(id) === 0)
	for (let head = 0; head < queue.length; head++) {
		const id = queue[head]
		for (const next of successors.get(id)!) {
			layers.set(next, Math.max(layers.get(next)!, layers.get(id)! + 1))
			const remaining = indegree.get(next)! - 1
			indegree.set(next, remaining)
			if (remaining === 0) queue.push(next)
		}
	}

	return layers
}

/**
 * Barycentre ordering. Each sweep re-sorts one layer by the mean row of its
 * neighbours in the layer the sweep came from; a node with no neighbour there
 * keeps its current row, which is what holds the drawing still between sweeps.
 */
function orderWithinLayers(
	ids: readonly string[],
	edges: readonly LayoutEdge[],
	layers: Map<string, number>,
	sweeps: number,
): string[][] {
	const layerCount = ids.length === 0 ? 0 : Math.max(...ids.map((id) => layers.get(id) ?? 0)) + 1
	const rows: string[][] = Array.from({ length: layerCount }, () => [])
	for (const id of ids) rows[layers.get(id)!].push(id)

	const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]))
	const successors = new Map<string, string[]>(ids.map((id) => [id, []]))
	for (const edge of edges) {
		predecessors.get(edge.target)!.push(edge.source)
		successors.get(edge.source)!.push(edge.target)
	}

	const sweep = (layer: number, neighbours: Map<string, string[]>, from: number) => {
		const positions = new Map(rows[from].map((id, row) => [id, row]))
		const current = new Map(rows[layer].map((id, row) => [id, row]))
		const barycentre = new Map(
			rows[layer].map((id) => {
				const rowsOfNeighbours = neighbours
					.get(id)!
					.map((other) => positions.get(other))
					.filter((row): row is number => row !== undefined)
				const mean =
					rowsOfNeighbours.length === 0
						? current.get(id)!
						: rowsOfNeighbours.reduce((sum, row) => sum + row, 0) / rowsOfNeighbours.length
				return [id, mean]
			}),
		)
		rows[layer].sort(
			(a, b) => barycentre.get(a)! - barycentre.get(b)! || current.get(a)! - current.get(b)!,
		)
	}

	for (let pass = 0; pass < sweeps; pass++) {
		for (let layer = 1; layer < layerCount; layer++) sweep(layer, predecessors, layer - 1)
		for (let layer = layerCount - 2; layer >= 0; layer--) sweep(layer, successors, layer + 1)
	}

	return rows
}
