/* =============================================================================
   validate.js — controllo del payload in arrivo dal modulo
   -----------------------------------------------------------------------------
   La validazione del front-end è comodità per l'utente, non una difesa: chiunque
   può chiamare l'endpoint con curl. Qui si ricontrolla tutto da zero.
   ========================================================================== */

import { HttpError } from './http.js';

// Devono corrispondere ai value dei radio in index.html.
export const STILI_AMMESSI = ['futuro', 'fiducia', 'bottega', 'vetrina'];

const PROMPT_MIN = 25;
const PROMPT_MAX = 600;   // stesso maxlength della textarea
const EMAIL_MAX = 254;    // limite pratico di un indirizzo email

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function testo(valore) {
  return typeof valore === 'string' ? valore.trim() : '';
}

/**
 * Restituisce un oggetto pulito, oppure lancia HttpError 400.
 * Non si fida di nulla: tipi, lunghezze e valori ammessi sono tutti ricontrollati.
 */
export function validaPayload(corpo) {
  if (!corpo || typeof corpo !== 'object') {
    throw new HttpError(400, 'Corpo della richiesta non valido.', 'payload_non_valido');
  }

  const stile = testo(corpo.stile).toLowerCase();
  const prompt = testo(corpo.prompt);
  const email = testo(corpo.email).toLowerCase();

  if (!STILI_AMMESSI.includes(stile)) {
    throw new HttpError(400, 'Stile non riconosciuto.', 'stile_non_valido');
  }

  if (prompt.length < PROMPT_MIN) {
    throw new HttpError(
      400,
      `La descrizione è troppo corta: servono almeno ${PROMPT_MIN} caratteri.`,
      'prompt_troppo_corto'
    );
  }

  if (prompt.length > PROMPT_MAX) {
    throw new HttpError(
      400,
      `La descrizione supera i ${PROMPT_MAX} caratteri.`,
      'prompt_troppo_lungo'
    );
  }

  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    throw new HttpError(400, 'Indirizzo email non valido.', 'email_non_valida');
  }

  return { stile, prompt, email };
}
