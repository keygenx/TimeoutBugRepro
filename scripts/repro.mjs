/**
 * End-to-end reproduction.
 *
 *   1. probe the clean build            -> every endpoint answers
 *   2. apply the chunk merge            -> the layout adapter-node >= 5.5.5 produced
 *   3. probe again                      -> /api/hang and /api/editor never answer
 *   4. restore the clean build
 *
 * Each probe starts a fresh server, because the deadlock is per-process: once a module is wedged
 * it stays wedged for the life of the process, and every later request for it queues behind it.
 *
 * Usage: node scripts/repro.mjs
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

const PORT = 3111;
const ENDPOINTS = ['/api/ok', '/api/hang', '/api/editor'];
const TIMEOUT_MS = 6000;

function startServer() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['build/index.js'], {
			env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		// Collected so we can show which requests reached the `handle` hook (see src/hooks.server.js).
		child.handleLog = [];
		const fail = setTimeout(() => {
			child.kill();
			reject(new Error('server did not start within 60s'));
		}, 60_000);
		child.stdout.on('data', (d) => {
			const text = d.toString();
			for (const line of text.split('\n')) {
				if (line.startsWith('[handle] ')) child.handleLog.push(line.trim());
			}
			if (text.includes('Listening on')) {
				clearTimeout(fail);
				resolve(child);
			}
		});
		child.stderr.on('data', (d) => process.stderr.write(d));
		child.on('exit', (code) => {
			clearTimeout(fail);
			reject(new Error(`server exited early with code ${code}`));
		});
	});
}

async function probe(url) {
	const started = Date.now();
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { signal: ac.signal });
		await res.text();
		return { url, status: String(res.status), ms: Date.now() - started };
	} catch {
		return { url, status: 'NO RESPONSE', ms: Date.now() - started };
	} finally {
		clearTimeout(timer);
	}
}

async function run(label) {
	const server = await startServer();
	const rows = [];
	for (const e of ENDPOINTS) rows.push(await probe(e));
	const reachedHandle = new Set(server.handleLog.map((l) => l.split(' ').pop()));
	server.kill();
	await once(server, 'exit').catch(() => {});

	console.log(`\n=== ${label} ===`);
	console.log(`  ${'endpoint'.padEnd(14)} ${'status'.padEnd(12)} ${'time'.padStart(7)}   handle ran?`);
	for (const r of rows) {
		const flag = r.status === 'NO RESPONSE' ? '  <-- DEADLOCK' : '';
		const ran = reachedHandle.has(r.url) ? 'yes' : 'NO';
		console.log(
			`  ${r.url.padEnd(14)} ${r.status.padEnd(12)} ${String(r.ms).padStart(5)}ms   ${ran.padEnd(3)}${flag}`
		);
	}
	return rows;
}

function step(script, args = []) {
	return new Promise((resolve, reject) => {
		const c = spawn(process.execPath, [path.join('scripts', script), ...args], {
			stdio: 'inherit'
		});
		c.on('exit', (code) => (code === 0 || code === 1 ? resolve(code) : reject(new Error(script))));
	});
}

console.log('adapter-node top-level-await deadlock — reproduction');
console.log('(build first with `npm run build` if you have not)\n');

const before = await run('1. clean build (chunks as Rollup emitted them)');

console.log('\n2. applying the chunk merge adapter-node >= 5.5.5 produced...');
await step('mergeChunks.mjs');
console.log('\n   static analysis of the resulting build:');
await step('chunkgraph.mjs');

const after = await run('3. after the merge');

console.log('\n4. restoring the clean build...');
await step('mergeChunks.mjs', ['--undo']);

const hangedAfter = after.filter((r) => r.status === 'NO RESPONSE').map((r) => r.url);
const hangedBefore = before.filter((r) => r.status === 'NO RESPONSE').map((r) => r.url);

console.log('\n================ RESULT ================');
if (hangedBefore.length === 0 && hangedAfter.length > 0) {
	console.log('REPRODUCED.');
	console.log(`  clean build : all endpoints answered`);
	console.log(`  merged build: ${hangedAfter.join(', ')} never answered`);
	console.log('\nThe application source is identical in both runs and contains no cycle.');
	console.log('Only the chunk layout changed.');
} else if (hangedBefore.length > 0) {
	console.log('INCONCLUSIVE: the clean build already deadlocks.');
} else {
	console.log('NOT REPRODUCED: the merged build did not deadlock.');
}
