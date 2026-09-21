# GitHub issue draft — sveltejs/kit

## Title

```
adapter-node ≥5.5.5: server chunking can create a top-level-await import cycle that hangs requests forever
```

---

## Body

### Describe the bug

Since `@sveltejs/adapter-node@5.5.5` ("bundle entrypoints alongside app code", #16069), the server
chunk layout can place a dynamically-imported module into a chunk that statically imports back
into the chunk performing the import. When that dynamic import is **awaited at module top level**,
the two chunks deadlock permanently:

```
chunkA ──(top-level await import)──▶ chunkB ──(static import)──▶ chunkA
```

`chunkA` suspends on the await. `chunkB` cannot finish evaluating, because its static dependency
`chunkA` is mid-evaluation. `chunkA` cannot finish, because it is waiting on `chunkB`. The import
promise never settles — it does not reject, so there is nothing to catch.

Any request for a route whose module graph includes `chunkA` then hangs **forever**: no error, no
log line, no timeout, not a single response header. The socket stays open until the client or the
reverse proxy gives up. Unaffected routes keep serving normally, so the server looks healthy.

**The application source contains no cycle.** It is created entirely by chunking.

The top-level await typically comes from a dependency. In our case it is
`@mdit/plugin-katex-slim`, whose published `lib/index.js` begins:

```js
let p=!0,n;try{n=await import("katex")}catch{p=!1}
```

That is harmless until the bundler merges `katex` into the chunk holding a lazily-loaded markdown
editor — and that editor statically imports the shared renderer that pulls in the plugin. Any
package doing top-level `await import(...)` can arm this; it is not specific to katex.

This is the same class of bug as #16115 (*"avoid circular dependency between server initialisation
and hook retrieval that causes the app to crash on start"*, fixed in 5.5.6 with `manualChunks`).
That instance crashed at startup and was therefore obvious. This one hangs silently at runtime, in
production, on a subset of routes.

To be clear about what did **not** change: I diffed the published 5.5.4 and 5.5.7 tarballs, and
the request-handling path (`polka`, `sirv`, the `ssr` middleware, `getRequest`, `setResponse`,
`index.js`) is functionally identical. `getRequest` in 5.5.4's vendored copy is byte-identical to
the one `@sveltejs/kit@2.70.3` exports and 5.5.5+ imports. The only relevant difference is the
chunk layout.

### Reproduction

https://github.com/<your-user>/adapter-node-tla-deadlock-repro

```bash
npm install
npm run build
npm run repro
```

```
=== 1. clean build (chunks as Rollup emitted them) ===
  endpoint       status          time   handle ran?
  /api/ok        200             50ms   yes
  /api/hang      200             31ms   yes
  /api/editor    200             17ms   yes

=== 3. after the merge ===
  endpoint       status          time   handle ran?
  /api/ok        200             18ms   yes
  /api/hang      NO RESPONSE   6006ms   NO   <-- DEADLOCK
  /api/editor    NO RESPONSE   6011ms   yes  <-- DEADLOCK
```

Identical source in both runs; only the chunk layout differs.

Note the `handle ran?` column — the repro ships a `hooks.server.js` that logs every invocation:

- `/api/hang` imports the renderer **statically**, so SvelteKit deadlocks while loading the route
  module, which happens *before* `handle` is invoked. The hook never runs at all.
- `/api/editor` reaches `handle`, then deadlocks on a dynamic `import()` inside the handler.

The first case is the nastier one: no application-level logging, metrics, error hook or timeout
wrapper can observe it, because no application code has run.

**One caveat, stated up front:** the repro does not coax Rollup into emitting the fatal layout by
itself — it adds, after the build, the single import edge that layout implies
(`scripts/mergeChunks.mjs`, reversible with `--undo`). Whether the awaited module is merged into
the editor's chunk or given one of its own is a chunker heuristic: it fires reliably in a large
real application, but not in a four-module toy, where Rollup keeps them separate.

I could not stage it through Vite config either — forcing the merge via
`build.rollupOptions.output.manualChunks` **hangs the build**, because SvelteKit's analyse step
evaluates the server output. That is itself informative: since the real build succeeds and only
the runtime wedges, the cycle must be created *after* analyse, in the adapter's own bundling pass.

So the repro proves the narrow claim precisely: *given that chunk layout, the server deadlocks,
and the source is not at fault.* The detector below finds the real, unstaged instance in a real
production build.

### Logs

`scripts/chunkgraph.mjs` parses the emitted chunks and reports the cycle:

```
DEADLOCK  top-level "await import()" into a chunk that imports back
  awaiting chunk : chunks/render-<hash>.js
  awaited chunk  : chunks/katex-<hash>.js
  static path back to the awaiting chunk:
      chunks/katex-<hash>.js
      chunks/editor-<hash>.js
      chunks/render-<hash>.js
      -> chunks/render-<hash>.js   (still evaluating - never resolves)

scanned 16 chunks, 1 top-level awaited dynamic import(s), 1 deadlock(s)
```

Run against the real application this was found in, it reports exactly one deadlock across a
build of well over a thousand chunks — between the markdown renderer's chunk and the
lazily-loaded editor's chunk — matching what runtime instrumentation independently showed.

How it was localised there: logging entry and exit of every emitted chunk during one hanging
request showed **41 chunks started, 40 finished, 1 pending**. The tell that it is a top-level
await specifically is that *sibling* chunks continue to start and finish around the pending one;
a module blocked on an ordinary dependency would never have started. Deleting that single `await`
from the built output, changing nothing else, made every affected endpoint respond normally.

### Why this is hard to catch

- The hook never runs (for statically-imported cases), so all application-level observability is
  silent.
- Nothing throws. The `try/catch` around the await looks like the error path is covered; it never
  executes, because the promise does not reject — it never settles.
- `vite dev` never bundles, so dev is always clean.
- `npm run preview` may or may not show it, depending on the layout that build produced.

That last point is the worst of it. Across builds of the same application:

| build | top-level awaited dynamic imports | deadlocks |
| --- | --- | --- |
| adapter-node 5.5.4 | 1 | **0** |
| adapter-node 5.5.7, built on machine A | 1 | **0** |
| adapter-node 5.5.7, built on machine B (CI/Docker) | 1 | **1** |

Same source, same dependency versions, same adapter version — only one of them is wedged. The
top-level await is present and latent in all of them; only the chunk layout decides whether it
fires. A developer cannot reasonably be expected to catch this before deploying.

### Suggested mitigation

Fail the build instead of shipping a server that hangs. `scripts/chunkgraph.mjs` in the repro is
~150 lines, runs over the emitted chunks, and reports zero false positives across every build I
tried it on. A build-time error naming both chunks would have turned a multi-day production
outage into a failed build.

Two implementation notes, since a naive check misses the real case (mine did, on both counts):

- The awaits that deadlock are typically inside `try { … } catch { … }`, so "brace depth 0" is the
  wrong test for top-level. The correct test is *"not inside any function"*.
- After bundling the call is often chained — `await import('x').then(m => m.default)` — so the
  `AwaitExpression`'s argument is a `CallExpression`, not an `ImportExpression`. The entire awaited
  subtree has to be searched.

A narrower alternative would be to extend the `manualChunks` approach from #16115 so that a module
reached by a top-level awaited dynamic import is never merged into a chunk that can statically
reach its importer.

### System Info

```
System:
  OS: Windows 11 (also reproduced in a Linux container)
Binaries:
  Node: 24.19.0
  npm: 12.0.2
npmPackages:
  @sveltejs/adapter-node: 5.5.7
  @sveltejs/kit: 2.70.3
  @sveltejs/vite-plugin-svelte: 7.3.0
  svelte: 5.56.10
  vite: 8.3.0
  @mdit/plugin-katex-slim: 0.24.0
  katex: 0.16.25
```

### Severity

blocking an upgrade

### Additional Information

`@sveltejs/adapter-node@5.5.7` is the latest stable release at time of writing. Pinning to 5.5.4
avoids it. Removing the top-level await from the dependency graph fixes it properly — in our case
that meant replacing `@mdit/plugin-katex-slim` with `@mdit/plugin-tex` plus a static
`import katex from 'katex'`, which is what the slim plugin does internally anyway, minus the
dynamic import.
