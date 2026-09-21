/**
 * Reproduces, deterministically, the chunk layout that @sveltejs/adapter-node >= 5.5.5 produced
 * in the real application.
 *
 * WHAT THE BUNDLER DID THERE
 * --------------------------
 * `katex` is pulled in two ways: dynamically, by @mdit/plugin-katex-slim's top-level
 * `await import("katex")`, and statically, by the lazily-loaded markdown editor. Rollup merged
 * those two into ONE chunk, and that chunk statically imports the renderer:
 *
 *     render-<hash>.js
 *        --(top-level await import)--> editor-<hash>.js   (katex merged in here)
 *        --(static import)-----------> render-<hash>.js
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * That merge is a chunker heuristic. It reliably happens in a large app; it does NOT happen in a
 * four-module toy, where Rollup keeps `katex` in a chunk of its own. Rather than bloat this repro
 * with enough modules to coax the heuristic into firing, we add the single edge the merge implies:
 * a static import from the katex chunk to the editor chunk.
 *
 * The result is byte-for-byte the same failure mode. Nothing in src/ is cyclic either way — which
 * is the whole point: the deadlock is created by CHUNKING, not by the application's source.
 *
 * Usage: node scripts/mergeChunks.mjs [--undo]
 */
import fs from 'node:fs';
import path from 'node:path';

const CHUNKS = path.resolve('build/server/chunks');
const MARKER = '// REPRO-MERGE';
const undo = process.argv.includes('--undo');

if (!fs.existsSync(CHUNKS)) {
	console.error('No build/server/chunks — run `npm run build` first.');
	process.exit(2);
}

const names = fs.readdirSync(CHUNKS).filter((f) => f.endsWith('.js'));
const pick = (prefix) => {
	const hit = names.find((f) => f.startsWith(prefix));
	if (!hit) {
		console.error(`Could not find a "${prefix}*" chunk in ${CHUNKS}.`);
		console.error(`Present: ${names.join(', ')}`);
		process.exit(2);
	}
	return hit;
};

const katexChunk = pick('katex-');
const editorChunk = pick('editor-');
const katexPath = path.join(CHUNKS, katexChunk);
const source = fs.readFileSync(katexPath, 'utf8');

if (undo) {
	if (!source.includes(MARKER)) {
		console.log('Nothing to undo.');
		process.exit(0);
	}
	fs.writeFileSync(
		katexPath,
		source
			.split('\n')
			.filter((l) => !l.includes(MARKER))
			.join('\n')
	);
	console.log(`Removed the merge edge from ${katexChunk}.`);
	process.exit(0);
}

if (source.includes(MARKER)) {
	console.log('Merge edge already present.');
	process.exit(0);
}

// Sanity-check that the editor chunk really does import the renderer back; without that edge
// there is no cycle and the repro would silently prove nothing.
const editorSource = fs.readFileSync(path.join(CHUNKS, editorChunk), 'utf8');
if (!/from\s+'\.\/render-[^']+'/.test(editorSource)) {
	console.error(`${editorChunk} does not statically import the render chunk — repro invalid.`);
	process.exit(2);
}

fs.writeFileSync(katexPath, `import './${editorChunk}'; ${MARKER}\n${source}`);
console.log(`Merged: ${katexChunk} now statically imports ${editorChunk}`);
console.log(`(models Rollup placing katex and the editor in one chunk)`);
