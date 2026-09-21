/**
 * Exists purely to demonstrate that the deadlock happens BEFORE any application code runs.
 *
 * SvelteKit loads a route's module before it invokes `handle`. When that module load deadlocks,
 * this hook is never called at all — so nothing an application can do (logging, metrics, an error
 * hook, a timeout wrapper inside `handle`) can observe or mitigate the failure.
 */
export async function handle({ event, resolve }) {
	console.log(`[handle] ${event.request.method} ${event.url.pathname}`);
	return resolve(event);
}
