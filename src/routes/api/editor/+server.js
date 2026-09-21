/**
 * Exists only to make `editor.js` a DYNAMIC entry in the server build.
 *
 * That is what gives `editor.js` its own chunk and lets Rollup fold `mathlib.js` into it. Without
 * a dynamic import somewhere, `editor.js` would be merged into the caller's chunk and the cycle
 * would not form. In the real application this role is played by the lazily-loaded markdown
 * editor component.
 */
import { json } from '@sveltejs/kit';

export async function GET() {
	const { editorPreview } = await import('$lib/editor.js');
	return json({ ok: true, html: editorPreview('E = mc^2') });
}
