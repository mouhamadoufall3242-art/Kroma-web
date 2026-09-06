/* =============================================================================
   storage.js — anteprime su Cloudflare KV
   -----------------------------------------------------------------------------
   Ogni anteprima è un record sotto la chiave `preview:<id>`.

   STATI — sono un contratto pubblico: il polling del front-end li legge così
   come sono, quindi restano in inglese e non vanno rinominati alla leggera.

     pending  richiesta accettata, generazione in corso
     success  HTML pronto in KV
     error    generazione fallita (il campo `motivo` dice perché)

   Il record nasce "pending" prima ancora che la risposta parta, così il link è
   valido da subito e chi lo apre troppo presto non trova un 404.
   ========================================================================== */

const PREFISSO = 'preview:';

/**
 * Id breve e leggibile, adatto a finire in un URL.
 * 12 caratteri da un alfabeto di 32 ≈ 60 bit: non indovinabile a forza bruta,
 * che è quello che serve visto che il link è l'unica protezione dell'anteprima.
 * Niente vocali: nessun rischio di generare parole sgradevoli.
 */
export function generaId() {
  const alfabeto = '0123456789bcdfghjklmnpqrstvwxyz';
  const byte = crypto.getRandomValues(new Uint8Array(12));
  let id = '';
  for (const b of byte) id += alfabeto[b % alfabeto.length];
  return id;
}

function ttlSecondi(env) {
  const giorni = Number(env.PREVIEW_TTL_DAYS) || 90;
  return giorni * 24 * 60 * 60;
}

/**
 * Crea il record iniziale. Da qui in poi l'id esiste e il link è già valido:
 * chi lo apre vede "generazione in corso" invece di un 404.
 */
export async function creaAnteprima(env, { id, stile, prompt, email }) {
  const record = {
    id,
    status: 'pending',
    stile,
    prompt,
    email,
    html: null,
    creataIl: new Date().toISOString(),
    aggiornataIl: new Date().toISOString()
  };

  await env.PREVIEWS.put(PREFISSO + id, JSON.stringify(record), {
    expirationTtl: ttlSecondi(env)
  });

  return record;
}

/**
 * Salva l'HTML generato e porta il record a "pronta".
 *
 * @returns {Promise<string>} l'id dell'anteprima
 */
export async function salvaHtmlAnteprima(env, id, html, extra = {}) {
  const record = (await leggiAnteprima(env, id)) || { id };

  const aggiornato = {
    ...record,
    ...extra,
    status: 'success',
    html,
    aggiornataIl: new Date().toISOString()
  };

  await env.PREVIEWS.put(PREFISSO + id, JSON.stringify(aggiornato), {
    expirationTtl: ttlSecondi(env)
  });

  return id;
}

/** Segna il record come fallito, conservando il motivo per la diagnosi. */
export async function segnaErroreAnteprima(env, id, motivo) {
  const record = await leggiAnteprima(env, id);
  if (!record) return;

  record.status = 'error';
  record.motivo = String(motivo).slice(0, 300);
  record.aggiornataIl = new Date().toISOString();

  await env.PREVIEWS.put(PREFISSO + id, JSON.stringify(record), {
    expirationTtl: ttlSecondi(env)
  });
}

export async function leggiAnteprima(env, id) {
  if (!id || !/^[0-9bcdfghjklmnpqrstvwxyz]{12}$/.test(id)) return null;
  return env.PREVIEWS.get(PREFISSO + id, { type: 'json' });
}

/**
 * Link che finisce nell'email del cliente.
 *
 * Punta alla PAGINA, non all'endpoint: da quando /api/preview/:id restituisce
 * JSON per il polling, mandare quell'indirizzo a un essere umano gli farebbe
 * vedere un blocco di JSON al posto del suo sito.
 */
/* =============================================================================
   ORDINI
   -----------------------------------------------------------------------------
   Chiave `ordine:<id>`. Nasce quando il cliente apre il checkout e viene
   aggiornato dal webhook a pagamento avvenuto. È il registro che dice quale
   anteprima è stata comprata, da chi e con quale pacchetto: senza, dopo il
   pagamento non sapremmo cosa consegnare.
   ========================================================================== */

const PREFISSO_ORDINE = 'ordine:';

export async function creaOrdine(env, ordine) {
  const record = {
    ...ordine,
    stato: 'creato',        // creato → pagato (lo cambia il webhook)
    creatoIl: new Date().toISOString()
  };

  await env.PREVIEWS.put(PREFISSO_ORDINE + ordine.id, JSON.stringify(record), {
    expirationTtl: ttlSecondi(env)
  });

  return record;
}

export async function leggiOrdine(env, id) {
  if (!id || !/^[0-9bcdfghjklmnpqrstvwxyz]{12}$/.test(id)) return null;
  return env.PREVIEWS.get(PREFISSO_ORDINE + id, { type: 'json' });
}

export async function aggiornaOrdine(env, id, campi) {
  const record = await leggiOrdine(env, id);
  if (!record) return null;

  const aggiornato = { ...record, ...campi, aggiornatoIl: new Date().toISOString() };

  await env.PREVIEWS.put(PREFISSO_ORDINE + id, JSON.stringify(aggiornato), {
    expirationTtl: ttlSecondi(env)
  });

  return aggiornato;
}

/* =============================================================================
   EVENTI STRIPE GIÀ PROCESSATI
   -----------------------------------------------------------------------------
   Stripe rimanda lo stesso evento finché non riceve un 2xx, e a volte anche
   quando lo ha ricevuto. Senza questo registro il titolare riceverebbe due
   avvisi di vendita per lo stesso incasso, e finirebbe per aprire due volte la
   stessa pratica.

   30 giorni di conservazione: Stripe ritenta per circa tre, il resto è margine.
   ========================================================================== */

const PREFISSO_EVENTO = 'evento:';
const TTL_EVENTO = 30 * 24 * 60 * 60;

export async function eventoGiaProcessato(env, eventoId) {
  if (!eventoId) return false;
  const visto = await env.PREVIEWS.get(PREFISSO_EVENTO + eventoId);
  return visto !== null;
}

export async function segnaEventoProcessato(env, eventoId, dettagli = {}) {
  if (!eventoId) return;
  await env.PREVIEWS.put(
    PREFISSO_EVENTO + eventoId,
    JSON.stringify({ ...dettagli, processatoIl: new Date().toISOString() }),
    { expirationTtl: TTL_EVENTO }
  );
}

export function linkAnteprima(env, id) {
  const base = (env.SITE_URL || '').replace(/\/+$/, '');
  return `${base}/preview.html?id=${id}`;
}
