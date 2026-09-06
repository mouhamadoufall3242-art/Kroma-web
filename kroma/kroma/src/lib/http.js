/* =============================================================================
   http.js — risposte JSON, CORS e classe d'errore condivisa
   ========================================================================== */

/**
 * Errore con uno status HTTP attaccato. Il router lo trasforma in una risposta
 * JSON pulita; qualunque altra eccezione diventa un 500 generico, così un
 * dettaglio interno non finisce mai nel corpo della risposta.
 */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code || 'error';
  }
}

/**
 * Origini autorizzate a chiamare l'API dal browser.
 * Il sito e il Worker stanno sullo stesso dominio, quindi in produzione il CORS
 * non servirebbe: serve per `wrangler dev` e per eventuali anteprime su
 * *.workers.dev.
 */
function originConsentita(origin, env) {
  if (!origin) return null;

  const consentite = [
    env.SITE_URL,
    'http://localhost:8787',
    'http://127.0.0.1:8787'
  ].filter(Boolean);

  if (consentite.includes(origin)) return origin;

  // Anteprime di Cloudflare: *.workers.dev e *.pages.dev. Servono se il
  // front-end viene pubblicato separatamente dal Worker.
  if (/^https:\/\/[a-z0-9-]+\.(workers|pages)\.dev$/.test(origin)) return origin;

  // Deploy di anteprima di Pages: <commit>.<progetto>.pages.dev
  if (/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev$/.test(origin)) return origin;

  return null;
}

export function corsHeaders(request, env) {
  const origin = originConsentita(request.headers.get('Origin'), env);
  if (!origin) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

export function json(dati, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(dati), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

export function preflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}
