/**
 * Control endpoint: identical in every way except that it does NOT import the renderer.
 * It keeps answering normally while /api/hang is wedged, which is what makes the failure look
 * like "only some endpoints time out".
 */
import { json } from '@sveltejs/kit';

export function GET() {
	return json({ ok: true });
}
