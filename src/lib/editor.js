/**
 * The lazily-loaded markdown editor, and its LaTeX feature.
 *
 * Two imports, both entirely reasonable in isolation, are what close the cycle:
 *
 *   - `katex`, STATICALLY, because the editor renders LaTeX live while you type;
 *   - the shared renderer, so the preview matches what the server will publish.
 *
 * Nothing here is cyclic at the source level. The cycle only exists after the bundler merges
 * `katex` into this module's chunk.
 */
import katex from 'katex';
import { render } from './render.js';

export function renderInlineLatex(source) {
	return katex.renderToString(source, { throwOnError: false });
}

export function editorPreview(source) {
	return render(source);
}
