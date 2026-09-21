# adapter-node ≥ 5.5.5: server endpoints hang forever (top-level-await chunk deadlock)

A SvelteKit server built with `@sveltejs/adapter-node` 5.5.7 stops answering *some* endpoints.
Not slow — **permanently unresponsive**. No error, no log line, no timeout, no rejected promise.
The connection stays open until the client or the reverse proxy gives up. The rest of the site
keeps working normally, which makes it look like a database or network problem.

The application source contains no cycle. The deadlock is created by **chunking**.

---

## TL;DR

`@mdit/plugin-katex-slim`'s published `lib/index.js` opens with a top-level await:

```js
let p=!0,n;try{n=await import("katex")}catch{p=!1}
```

Harmless on its own. It becomes fatal once the bundler puts `katex` in a chunk that statically
imports back into the chunk doing the awaiting:

```
render.js ──(top-level await import)──▶ MarkdownEditor.js ──(static import)──▶ render.js
```

`render.js` suspends on the await. `MarkdownEditor.js` cannot finish, because its static
dependency `render.js` is still evaluating. `render.js` cannot finish, because it is waiting for
`MarkdownEditor.js`. Neither ever completes and the import promise never settles.

Every request for a route that imports the renderer then hangs — **before the `handle` hook
runs**, because SvelteKit loads the endpoint module first.

`@sveltejs/adapter-node` 5.5.5 changed how the server is chunked
([sveltejs/kit#16069](https://github.com/sveltejs/kit/pull/16069), *"bundle entrypoints alongside
app code"*). That reshuffle is what produced the fatal layout. Nothing in the adapter's
request-handling code changed — 5.5.4 and 5.5.7 are functionally identical there.

---

## Reproducing

```bash
npm install
npm run build
npm run repro
```

Expected output:

```
=== 1. clean build (chunks as Rollup emitted them) ===
  endpoint       status          time   handle ran?
  /api/ok        200             50ms   yes
  /api/hang      200             31ms   yes
  /api/editor    200             17ms   yes

2. applying the chunk merge adapter-node >= 5.5.5 produced...

DEADLOCK  top-level "await import()" into a chunk that imports back
  awaiting chunk : chunks/render-<hash>.js
  awaited chunk  : chunks/katex-<hash>.js
  static path back to the awaiting chunk:
      chunks/katex-<hash>.js
      chunks/editor-<hash>.js
      chunks/render-<hash>.js

=== 3. after the merge ===
  endpoint       status          time   handle ran?
  /api/ok        200             18ms   yes
  /api/hang      NO RESPONSE   6006ms   NO   <-- DEADLOCK
  /api/editor    NO RESPONSE   6011ms   yes  <-- DEADLOCK

================ RESULT ================
REPRODUCED.
```

The application source is byte-identical between runs 1 and 3. Only the chunk layout differs.

### The `handle ran?` column

`src/hooks.server.js` logs every invocation, which separates two variants of the same deadlock:

- **`/api/hang`** imports the renderer **statically**. SvelteKit loads a route's module before it
  invokes `handle`, so the deadlock happens first and the hook never runs at all. No
  application-level logging, metric, error hook or timeout wrapper can see it — no application
  code has executed.
- **`/api/editor`** reaches `handle`, then deadlocks on a dynamic `import()` inside the handler.

The first is the one that makes this so hard to diagnose in production.

### An honest note about `scripts/mergeChunks.mjs`

This repro does **not** coax Rollup into emitting the fatal layout by itself — it adds the single
import edge that layout implies, after the build.

That is a deliberate trade-off. Whether `katex` is merged into the editor's chunk or given one of
its own is a chunker *heuristic*. It fires reliably in a real application (1183 chunks); it does
not fire in a four-module toy, where Rollup keeps `katex` separate. Rather than pad this repro
with enough modules to bully the heuristic into firing — which would make it fragile against any
Rollup or Vite bump — the merge is applied explicitly and reversibly.

The failure mode is identical either way, and `scripts/chunkgraph.mjs` finds the real one in the
real build (see below). What this repro proves precisely is: **given that layout, the server
deadlocks, and the source is not at fault.**

---

## Finding it in your own build

```bash
node scripts/chunkgraph.mjs path/to/build/server
```

It parses every emitted chunk (with Rollup's own parser, not regex) and reports any chunk that
awaits a dynamic import at top level whose target can statically reach back. Exit code 1 on a
find, so it works as a CI guard.

Two details matter, and a naive regex gets both wrong:

- The awaits that deadlock are usually inside `try { … } catch { … }`, so "brace depth 0" is the
  wrong test for top-level. Only *"not inside any function"* is correct.
- Post-bundling the call is often chained — `await import('katex').then(n => n.k)` — so the
  `AwaitExpression`'s argument is a `CallExpression`, not an `ImportExpression`. The whole awaited
  subtree has to be searched.

Run against the builds from the real application this was found in:

| build | chunks | top-level awaited dynamic imports | deadlocks |
| --- | --- | --- | --- |
| adapter-node 5.5.4 (working) | 986 | 1 | **0** |
| adapter-node 5.5.7, built on Windows (working) | 974 | 1 | **0** |
| adapter-node 5.5.7, built in Docker (hangs) | 1183 | 1 | **1** |
| this repro, clean | 15 | 1 | **0** |
| this repro, after merge | 15 | 1 | **1** |

The top-level await is present in *every* build. It is latent. Only the chunk layout decides
whether it deadlocks — which is why the bug is so slippery: the same source, same dependency
versions and same adapter version can produce a working build on one machine and a wedged one on
another.

---

## How the failure presents

From outside, the affected routes never send a single response header — `time_starttransfer` is
**0**, not merely slow. Unaffected routes on the same server answer in milliseconds, so uptime
checks and load balancers see a healthy process.

Two contrasts are diagnostic, and both point away from application code:

- A URL matching **no route at all** returns 404 instantly, proving routing and the hook chain are
  fine.
- A URL matching a parameterised route whose *parameter value does not exist* still hangs — the
  handler would have returned 404, but the module is loaded before dispatch, so it never gets the
  chance.

### Why it is so hard to diagnose

- **`handle` never runs**, so every application-level log, metric and error hook is silent.
- **Nothing throws.** The `try/catch` around the await looks like the error path is covered; it
  never executes, because the promise does not reject — it never settles.
- **Pages can keep working.** If page loads return promises for streaming, the shell still
  renders in 200 ms and the failure hides in the stream.
- **Dev never shows it.** `vite dev` does not bundle, so there are no chunks and no cycle.
- **`npm run preview` may not show it either** — it depends on the chunk layout that particular
  build produced.

### How it was localised

Instrumenting a production build at three layers — raw Node `request`, the adapter's `ssr`
middleware, and the `handle` hook — showed the request dying between the adapter and the hook: the
endpoint module's dynamic import **starts and never completes**. No resolution, no rejection, and
the hook is never entered.

Logging entry and exit of every emitted chunk during one hanging request then isolated it to a
single module: **41 chunks started, 40 finished, 1 pending** — the renderer's chunk.

The giveaway that it is a top-level await specifically: after that chunk starts, *sibling* chunks
continue to start and finish around it. That only happens when a module suspends. A module blocked
on an ordinary dependency would never have started.

Deleting just that one `await` from the built output, changing nothing else, made every affected
endpoint respond normally and immediately.

---

## Fixes

**1. Remove the top-level await (recommended).** `@mdit/plugin-katex-slim` provides no way to
inject a katex instance, but it is a thin wrapper over `@mdit/plugin-tex` (already a transitive
dependency, zero top-level awaits). Import katex statically and supply the renderer yourself:

```js
import MarkdownIt from 'markdown-it';
import katex from 'katex';
import { tex } from '@mdit/plugin-tex';

const escape = MarkdownIt().utils.escapeHtml;

const renderKatex = (content, displayMode) => {
	try {
		const html = katex.renderToString(content, {
			strict: 'ignore',
			throwOnError: false,
			displayMode
		});
		return displayMode ? `<p class='katex-block'>${html}</p>\n` : html;
	} catch (e) {
		if (!(e instanceof katex.ParseError)) throw e;
		const title = escape(String(e));
		return displayMode
			? `<p class='katex-block katex-error' title='${title}'>${escape(content)}</p>\n`
			: `<span class='katex-error' title='${title}'>${escape(content)}</span>`;
	}
};

export const md = MarkdownIt({ html: true }).use(tex, { render: renderKatex });
```

This removes the failure mode rather than rearranging around it.

**2. Pin `@sveltejs/adapter-node` to 5.5.4.** Immediate unblock; leaves the landmine in place for
any future chunk reshuffle.

**3. Break the cycle in the source.** Stop the client editor from statically importing the
server-side renderer. Correct architecturally, but larger, and it only removes *this* instance.

**4. Force `katex` into its own chunk** via `manualChunks`. Works, but it is a guess against a
heuristic — the next dependency bump can move it back.

Options 2–4 all leave a latent top-level await that a future chunk layout can re-arm. Only option
1 removes it.

### Suggested upstream mitigation

The adapter could fail the build instead of shipping a server that hangs. The check in
`scripts/chunkgraph.mjs` is ~150 lines, runs on the emitted chunks, and has no false positives on
any of the five builds in the table above. A build-time error naming both chunks would have turned
a multi-day production outage into a failed build.

---

## What is in here

| path | role |
| --- | --- |
| `src/lib/render.js` | server-side markdown renderer; pulls in `@mdit/plugin-katex-slim` and therefore the top-level await |
| `src/lib/editor.js` | lazily-loaded editor; statically imports **both** `katex` and the renderer — the back-edge |
| `src/routes/api/hang/+server.js` | imports the renderer → deadlocks |
| `src/routes/api/ok/+server.js` | control; does not import the renderer → always answers |
| `src/routes/api/editor/+server.js` | dynamically imports the editor, so it becomes its own chunk |
| `scripts/repro.mjs` | end-to-end: probe clean → merge → probe → restore |
| `scripts/mergeChunks.mjs` | applies/reverts the chunk merge (`--undo`) |
| `scripts/chunkgraph.mjs` | static detector; run it against any build output |

Nothing in `src/` is cyclic. Confirm with `node scripts/chunkgraph.mjs` on the clean build: zero
deadlocks.

## Environment

Reproduced on Node 24.19.0 (Linux container and Windows), `@sveltejs/kit` 2.70.3, Svelte 5.56.10,
Vite 8.3.0, `@sveltejs/adapter-node` 5.5.7 (latest stable at time of writing),
`@mdit/plugin-katex-slim` 0.24.0, `katex` 0.16.25.

## References

- [sveltejs/kit#16069](https://github.com/sveltejs/kit/pull/16069) — adapter-node 5.5.5, "bundle entrypoints alongside app code"; the change that reshuffled server chunks
- [sveltejs/kit#16115](https://github.com/sveltejs/kit/pull/16115) — adapter-node 5.5.6, *"avoid circular dependency between server initialisation and hook retrieval that causes the app to crash on start"*; a different instance of the same class, fixed with `manualChunks`
- [adapter-node CHANGELOG](https://github.com/sveltejs/kit/blob/main/packages/adapter-node/CHANGELOG.md)
