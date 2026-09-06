/* =============================================================================
   stripe.js — pacchetti, sessione di checkout, firma dei webhook
   -----------------------------------------------------------------------------
   STATO: la struttura della chiamata a Stripe è completa. Finché
   env.STRIPE_SECRET_KEY non è impostata, creaSessioneCheckout NON chiama Stripe
   e restituisce una URL finta, così tutto il percorso è provabile.
       npx wrangler secret put STRIPE_SECRET_KEY
       npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ========================================================================== */

import { HttpError } from './http.js';

const API_BASE = 'https://api.stripe.com/v1';
const URL_FINTA = 'https://checkout.stripe.com/pay/finto-id';

/* =============================================================================
   I PACCHETTI VIVONO QUI, SUL SERVER
   -----------------------------------------------------------------------------
   Il browser manda solo package_type: "codice" oppure "abbonamento". Gli importi
   non viaggiano MAI dal client.

   Se il prezzo arrivasse dalla richiesta, chiunque potrebbe aprire la console e
   comprare il pacchetto da 290€ per 1 centesimo. È l'errore più comune nei
   checkout fatti in casa, ed è anche il più costoso.
   ========================================================================== */

export const PACCHETTI = {
  codice: {
    nome: 'Pacchetto Codice',
    modalita: 'payment',              // pagamento unico
    importoTotaleCent: 29000,         // 290,00 € — solo per registrare l'ordine
    descrizione: 'File HTML/CSS del sito, una tantum',

    // Gli id dei prezzi si creano una volta sola nel pannello Stripe e si
    // mettono in [vars] dentro wrangler.toml: non sono segreti.
    prezzi: (env) => [
      { price: env.STRIPE_PRICE_CODICE, quantity: 1 }
    ]
  },

  abbonamento: {
    nome: 'Pacchetto All-Inclusive',
    modalita: 'subscription',         // ricorrente
    importoTotaleCent: 9000,          // 90,00 € di attivazione sulla prima fattura
    importoRicorrenteCent: 2900,      // 29,00 € al mese
    descrizione: 'Sito completo, dominio, hosting e supporto',

    // In modalità subscription Stripe accetta anche una voce una tantum:
    // finisce sulla prima fattura, che è esattamente l'attivazione.
    prezzi: (env) => [
      { price: env.STRIPE_PRICE_ABBONAMENTO, quantity: 1 },
      { price: env.STRIPE_PRICE_ATTIVAZIONE, quantity: 1 }
    ]
  }
};

export function pacchettoValido(tipo) {
  return Object.prototype.hasOwnProperty.call(PACCHETTI, tipo);
}

/* =============================================================================
   CREAZIONE DELLA SESSIONE
   ========================================================================== */

/**
 * @param {object} env
 * @param {object} dati  { ordineId, previewId, packageType, email }
 * @returns {Promise<{url: string, sessionId: string|null, simulata: boolean}>}
 */
export async function creaSessioneCheckout(env, dati) {
  const pacchetto = PACCHETTI[dati.packageType];
  if (!pacchetto) throw new HttpError(400, 'Pacchetto non riconosciuto.', 'pacchetto_non_valido');

  const base = (env.SITE_URL || '').replace(/\/+$/, '');

  // ---------------------------------------------------------------------------
  // LA CHIAVE SEGRETA VA QUI, e solo qui.
  //   produzione:  npx wrangler secret put STRIPE_SECRET_KEY
  //   locale:      riga STRIPE_SECRET_KEY nel file .dev.vars
  // Mai in wrangler.toml, mai nel front-end: è una chiave che può muovere
  // denaro sul tuo conto.
  // ---------------------------------------------------------------------------
  const apiKey = env.STRIPE_SECRET_KEY;

  if (!apiKey) {
    console.log('[stripe] nessuna STRIPE_SECRET_KEY: restituisco una URL finta per', dati.ordineId);
    return { url: URL_FINTA, sessionId: null, simulata: true };
  }

  // Stripe non accetta JSON: vuole application/x-www-form-urlencoded con le
  // chiavi annidate in stile PHP (line_items[0][price]).
  const corpo = new URLSearchParams();
  corpo.set('mode', pacchetto.modalita);
  corpo.set('success_url', `${base}/grazie.html?ordine=${dati.ordineId}&session_id={CHECKOUT_SESSION_ID}`);
  corpo.set('cancel_url', `${base}/preview.html?id=${dati.previewId}&annullato=1`);
  corpo.set('client_reference_id', dati.ordineId);
  corpo.set('locale', 'it');

  if (dati.email) corpo.set('customer_email', dati.email);

  pacchetto.prezzi(env).forEach((voce, i) => {
    if (!voce.price) {
      throw new HttpError(
        500,
        'Configurazione incompleta: manca un id prezzo Stripe.',
        'prezzo_non_configurato'
      );
    }
    corpo.set(`line_items[${i}][price]`, voce.price);
    corpo.set(`line_items[${i}][quantity]`, String(voce.quantity));
  });

  // I metadata tornano indietro nel webhook: sono il filo che lega il
  // pagamento all'anteprima da consegnare.
  corpo.set('metadata[ordine_id]', dati.ordineId);
  corpo.set('metadata[preview_id]', dati.previewId);
  corpo.set('metadata[package_type]', dati.packageType);

  const risposta = await fetch(`${API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Se il cliente clicca due volte, Stripe riusa la stessa sessione
      // invece di aprirne una seconda.
      'Idempotency-Key': dati.ordineId
    },
    body: corpo.toString()
  });

  if (!risposta.ok) {
    const dettaglio = await risposta.json().catch(() => ({}));
    console.error('[stripe] errore', risposta.status, dettaglio?.error?.code || '');
    throw new HttpError(502, 'Non riusciamo ad aprire il pagamento. Riprova tra poco.', 'stripe_ko');
  }

  const sessione = await risposta.json();
  return { url: sessione.url, sessionId: sessione.id, simulata: false };
}

/* =============================================================================
   VERIFICA DELLA FIRMA DEI WEBHOOK
   -----------------------------------------------------------------------------
   Questo è il punto più delicato dell'intero backend.

   L'endpoint dei webhook è pubblico. Senza verifica della firma, chiunque può
   mandargli un POST con scritto "pagamento riuscito" e ottenere gratis quello
   che gli altri pagano. Non è un rischio teorico: gli endpoint /webhook sono
   fra i primi indirizzi che gli scanner automatici provano.

   Stripe firma ogni chiamata con HMAC-SHA256 su "timestamp.corpo_grezzo",
   usando il segreto whsec_… che si trova nel pannello.
   ========================================================================== */

const TOLLERANZA_SECONDI = 300;   // oltre 5 minuti la chiamata è considerata vecchia

/**
 * @param {string} corpoGrezzo  il body ESATTO come è arrivato, non riserializzato
 * @param {string} header       contenuto di Stripe-Signature
 * @param {string} segreto      env.STRIPE_WEBHOOK_SECRET
 * @returns {Promise<boolean>}
 */
export async function verificaFirmaWebhook(corpoGrezzo, header, segreto) {
  if (!corpoGrezzo || !header || !segreto) return false;

  // Formato: t=1710000000,v1=abc...,v1=def...
  const parti = {};
  header.split(',').forEach((pezzo) => {
    const i = pezzo.indexOf('=');
    if (i === -1) return;
    const chiave = pezzo.slice(0, i).trim();
    const valore = pezzo.slice(i + 1).trim();
    if (chiave === 'v1') (parti.v1 = parti.v1 || []).push(valore);
    else parti[chiave] = valore;
  });

  if (!parti.t || !parti.v1 || parti.v1.length === 0) return false;

  // Finestra temporale: senza questo controllo una richiesta valida
  // intercettata oggi potrebbe essere rigiocata fra un mese.
  const eta = Math.abs(Math.floor(Date.now() / 1000) - Number(parti.t));
  if (!Number.isFinite(eta) || eta > TOLLERANZA_SECONDI) return false;

  const chiave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(segreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const firma = await crypto.subtle.sign(
    'HMAC',
    chiave,
    new TextEncoder().encode(`${parti.t}.${corpoGrezzo}`)
  );

  const atteso = [...new Uint8Array(firma)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return parti.v1.some((v) => confrontoCostante(v, atteso));
}

/**
 * Confronto a tempo costante. Un === normale esce al primo carattere diverso, e
 * quella differenza di tempo, misurata abbastanza volte, permette di ricostruire
 * la firma un carattere alla volta.
 */
function confrontoCostante(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
