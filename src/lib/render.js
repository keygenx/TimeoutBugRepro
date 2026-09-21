/**
 * The shared server-side markdown renderer.
 *
 * The only thing that matters here is `@mdit/plugin-katex-slim`. Its published `lib/index.js`
 * opens with a TOP-LEVEL await on a dynamic import:
 *
 *     let p=!0,n;try{n=await import("katex")}catch{p=!1}
 *
 * The plugin offers no way to inject a katex instance, so importing it always evaluates that
 * await. On its own that is harmless. It only deadlocks once the bundler puts `katex` in a chunk
 * that imports back into this module's chunk — see editor.js and README.md.
 */
import MarkdownIt from 'markdown-it';
import { katex as mdKatex } from '@mdit/plugin-katex-slim';

export const md = MarkdownIt({ html: true }).use(mdKatex);

export function render(source) {
	return md.render(source);
}
