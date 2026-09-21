/**
 * The affected endpoint. It does nothing but import the renderer.
 *
 * SvelteKit loads this module BEFORE it runs the `handle` hook, so when the import deadlocks the
 * request never reaches `handle` — no log line, no error, no response. The socket simply stays
 * open until the client or the reverse proxy gives up.
 */
import { json } from '@sveltejs/kit';
import { render } from '$lib/render.js';

export function GET() {
	return json({ ok: true, html: render('E = mc^2') });
}
