/**
 * Resolves which backend should handle serial/compile/upload requests.
 *
 * Two cases:
 *  - Full local install (start.bat): the page itself is served by the same
 *    backend that has USB access, so same-origin `/api` already works.
 *  - Cloud-hosted (e.g. Render): the page's own backend has no USB ports at
 *    all. A local companion agent, if the user has it running, exposes the
 *    same API on localhost - we check for it and prefer it when present.
 */

const LOCAL_AGENT_ORIGIN = 'http://localhost:8899';
const HEALTH_CHECK_TIMEOUT_MS = 800;

let cachedBase = null;
let cachedAt = 0;
const CACHE_MS = 5000;

const isLocalhost = () => (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
);

const probe = (origin) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    return fetch(origin + '/health', {signal: controller.signal})
        .then(r => r.ok)
        .catch(() => false)
        .finally(() => clearTimeout(timer));
};

/**
 * Returns the API base URL (no trailing slash) to use for hardware requests.
 * Same-origin page already on the app's own backend: use it directly, no
 * need to probe the agent (it would only ever be a fallback there anyway).
 * Otherwise (cloud-hosted): prefer a running local agent; fall back to
 * same-origin `/api`, which will honestly report "no ports" rather than hang.
 */
export async function getHwApiBase () {
    if (isLocalhost()) {
        return window.location.origin + '/api';
    }
    const now = Date.now();
    if (cachedBase && (now - cachedAt) < CACHE_MS) {
        return cachedBase;
    }
    const agentUp = await probe(LOCAL_AGENT_ORIGIN);
    cachedBase = agentUp ? (LOCAL_AGENT_ORIGIN + '/api') : (window.location.origin + '/api');
    cachedAt = now;
    return cachedBase;
}

export async function isUsingLocalAgent () {
    const base = await getHwApiBase();
    return base.indexOf(LOCAL_AGENT_ORIGIN) === 0;
}

export {LOCAL_AGENT_ORIGIN, isLocalhost};
