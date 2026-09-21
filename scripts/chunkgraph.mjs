/**
 * Detects the deadlock statically, in any adapter-node build output.
 *
 * It looks for the one shape that wedges a server forever with no error and no timeout:
 *
 *   chunk A contains a TOP-LEVEL `await import('./B.js')`
 *   chunk B can reach chunk A again through STATIC imports
 *
 * The first import of A then suspends on the await; B cannot finish because its static dependency
 * A is still evaluating; A cannot finish because it is waiting for B. Neither ever completes, the
 * promise never settles, and the request that triggered the import hangs forever.
 *
 * "Top-level" is decided with a real parser (Rollup's), not a regex. It matters: the awaits that
 * hang are frequently wrapped in `try { ... } catch { ... }` (that is exactly what
 * @mdit/plugin-katex-slim does), while the harmless ones sit inside async functions — SvelteKit's
 * own route loaders are full of those. Only "not inside any function" is the right test.
 *
 * Usage:  node scripts/chunkgraph.mjs [buildServerDir]
 * Exits 1 when a deadlock is found, so it works as a CI guard on your own builds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseAst } from 'rollup/parseAst';

const root = path.resolve(process.argv[2] ?? 'build/server');

if (!fs.existsSync(root)) {
	console.error(`No such directory: ${root}\nRun \`npm run build\` first.`);
	process.exit(2);
}

const files = [];
(function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(p);
		else if (entry.name.endsWith('.js')) files.push(p);
	}
})(root);

const FUNCTION_NODES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression'
]);

/** Collect every string-literal `import()` specifier anywhere in a subtree. */
function importSpecifiersIn(node, out = []) {
	if (node === null || typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const n of node) importSpecifiersIn(n, out);
		return out;
	}
	if (typeof node.type !== 'string') return out;
	if (
		node.type === 'ImportExpression' &&
		node.source?.type === 'Literal' &&
		typeof node.source.value === 'string'
	) {
		out.push(node.source.value);
	}
	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
		importSpecifiersIn(node[key], out);
	}
	return out;
}

/**
 * Specifiers of dynamic imports whose promise is awaited at module top level.
 *
 * Deliberately looks at the whole awaited subtree rather than only `await import(x)`. The awaits
 * that actually deadlock in the wild are usually chained or combined, e.g.
 *
 *     await import('katex').then((n) => n.k)      <- @mdit/plugin-katex-slim, post-bundling
 *     await Promise.all([import('a'), import('b')])
 *
 * all of which suspend the module exactly the same way.
 */
function topLevelAwaitedImports(ast) {
	const out = [];
	(function visit(node, insideFunction) {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const n of node) visit(n, insideFunction);
			return;
		}
		if (typeof node.type !== 'string') return;

		if (!insideFunction && node.type === 'AwaitExpression') {
			out.push(...importSpecifiersIn(node.argument));
		}

		const nowInside = insideFunction || FUNCTION_NODES.has(node.type);
		for (const key of Object.keys(node)) {
			if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
			visit(node[key], nowInside);
		}
	})(ast, false);
	return out;
}

/** Static import specifiers of a module, from the same AST. */
function staticImportSpecifiers(ast) {
	const out = [];
	for (const node of ast.body ?? []) {
		if (
			(node.type === 'ImportDeclaration' ||
				node.type === 'ExportNamedDeclaration' ||
				node.type === 'ExportAllDeclaration') &&
			node.source?.value
		) {
			out.push(node.source.value);
		}
	}
	return out;
}

const parsed = new Map();
for (const file of files) {
	try {
		parsed.set(file, parseAst(fs.readFileSync(file, 'utf8')));
	} catch (e) {
		console.warn(`  (skipped unparseable ${path.relative(root, file)}: ${e.message})`);
	}
}

const resolveFrom = (file, spec) => {
	if (!spec.startsWith('.')) return null;
	const r = path.resolve(path.dirname(file), spec);
	return fs.existsSync(r) ? r : null;
};

const staticDeps = new Map();
for (const [file, ast] of parsed) {
	const deps = new Set();
	for (const spec of staticImportSpecifiers(ast)) {
		const r = resolveFrom(file, spec);
		if (r) deps.add(r);
	}
	staticDeps.set(file, deps);
}

/** shortest static-import path from `start` back to `goal`, or null */
function staticPathBack(start, goal) {
	const parent = new Map();
	const seen = new Set([start]);
	const queue = [start];
	while (queue.length) {
		const cur = queue.shift();
		for (const dep of staticDeps.get(cur) ?? []) {
			if (seen.has(dep)) continue;
			seen.add(dep);
			parent.set(dep, cur);
			if (dep === goal) {
				const chain = [dep];
				let c = cur;
				while (c) {
					chain.push(c);
					if (c === start) break;
					c = parent.get(c);
				}
				return chain.reverse();
			}
			queue.push(dep);
		}
	}
	return null;
}

const rel = (p) => path.relative(root, p).split(path.sep).join('/');

let deadlocks = 0;
let topLevelAwaits = 0;

for (const [file, ast] of parsed) {
	for (const spec of topLevelAwaitedImports(ast)) {
		topLevelAwaits++;
		const target = resolveFrom(file, spec);
		if (!target) continue;
		const chain = target === file ? [file] : staticPathBack(target, file);
		if (!chain) continue;
		deadlocks++;
		console.log(`\nDEADLOCK  top-level "await import()" into a chunk that imports back`);
		console.log(`  awaiting chunk : ${rel(file)}`);
		console.log(`  awaited chunk  : ${rel(target)}`);
		console.log(`  static path back to the awaiting chunk:`);
		for (const c of chain) console.log(`      ${rel(c)}`);
		console.log(`      -> ${rel(file)}   (still evaluating - never resolves)`);
	}
}

console.log(
	`\nscanned ${parsed.size} chunks, ${topLevelAwaits} top-level awaited dynamic import(s), ${deadlocks} deadlock(s)`
);
process.exit(deadlocks > 0 ? 1 : 0);
