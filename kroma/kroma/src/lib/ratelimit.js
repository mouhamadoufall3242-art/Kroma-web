/* =============================================================================
   ratelimit.js — freno per IP
   -----------------------------------------------------------------------------
   /api/generate fa partire una chiamata a pagamento verso Anthropic e un invio
   email: lasciarlo aperto senza freno significa che chiunque, con uno script da
   dieci righe, può far salire la bolletta. Questo è il minimo indispensabile.

   ATTENZIONE — KV è a consistenza eventuale: le scritture impiegano qualche
   secondo a propagarsi tra i data center, quindi un attacco distribuito e
   veloce può passare oltre il tetto. Va bene contro l'abuso casuale, non contro
   un attacco mirato. Per quello servono il binding Rate Limiting di Cloudflare
   o un Durable Object: vedi le note in README.md.
   ========================================================================== */

import { HttpError } from './http.js';

const PREFISSO = 'rl:';
const FINESTRA_SECONDI = 60 * 60;

/**
 * Incrementa il contatore dell'IP e lancia HttpError 429 se ha esaurito il
 * budget dell'ora corrente.
 */
export async function verificaRateLimit(request, env) {
  const tetto = Number(env.RATE_LIMIT_PER_HOUR) || 5;
  if (tetto <= 0) return;

  // Header impostato da Cloudflare: non è falsificabile dal client.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return;

  const oraCorrente = Math.floor(Date.now() / 1000 / FINESTRA_SECONDI);
  const chiave = `${PREFISSO}${ip}:${oraCorrente}`;

  const attuale = Number(await env.PREVIEWS.get(chiave)) || 0;

  if (attuale >= tetto) {
    throw new HttpError(
      429,
      'Hai già richiesto diverse anteprime nell\'ultima ora. Riprova più tardi, ' +
      'oppure scrivici a kroma.site@gmail.com.',
      'troppe_richieste'
    );
  }

  await env.PREVIEWS.put(chiave, String(attuale + 1), {
    expirationTtl: FINESTRA_SECONDI * 2
  });
}
