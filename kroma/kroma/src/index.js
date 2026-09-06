/* =============================================================================
   KROMA — Cloudflare Worker
   -----------------------------------------------------------------------------
   Rotte:
     POST /api/generate         accetta il modulo, accoda la generazione
     GET  /api/preview/:id      stato + HTML in JSON (lo interroga il polling)
     POST /api/checkout         apre il pagamento di un pacchetto
     POST /api/webhooks/stripe  conferme di pagamento da Stripe
     GET  /api/health           controllo di stato

   ATTENZIONE — /api/preview/:id restituisce JSON, non una pagina. La pagina
   che un essere umano apre è /preview.html?id=<id>, ed è quella che finisce
   nell'email (vedi linkAnteprima in lib/storage.js).

   Tutto il resto lo serve la cartella public/ (vedi [assets] in wrangler.toml).

   NOTA DI ARCHITETTURA — perché la generazione non blocca la risposta
   -----------------------------------------------------------------------------
   Generare una pagina con un modello richiede decine di secondi. Il front-end
   però promette all'utente "controlla l'email tra 15 minuti": non deve restare
   appeso ad aspettare, e una connessione mobile che cade non deve buttare via
   una generazione già pagata.

   Quindi /api/generate fa solo le cose veloci — valida, crea l'id, scrive il
   record in KV — e risponde subito 202. Il lavoro lento prosegue dopo la
   risposta dentro ctx.waitUntil(), che tiene vivo il Worker fino alla fine.

   Quando i volumi cresceranno, il passo successivo è Cloudflare Queues: stessa
   struttura, ma con ritentativi automatici se Anthropic o Resend sono giù.
   ========================================================================== */

import { HttpError, json, corsHeaders, preflight } from './lib/http.js';
import { validaPayload } from './lib/validate.js';
import { verificaRateLimit } from './lib/ratelimit.js';
import { callAnthropicAPI } from './lib/anthropic.js';
import {
  generaId,
  creaAnteprima,
  salvaHtmlAnteprima,
  segnaErroreAnteprima,
  leggiAnteprima,
  linkAnteprima,
  creaOrdine,
  leggiOrdine,
  aggiornaOrdine,
  eventoGiaProcessato,
  segnaEventoProcessato
} from './lib/storage.js';
import { PACCHETTI, pacchettoValido, creaSessioneCheckout, verificaFirmaWebhook } from './lib/stripe.js';
import { sendEmailToClient } from './lib/email.js';
import { notifyAdminOnFailure, notifyAdminOnSuccess } from './lib/notify.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight(request, env);

    try {
      if (url.pathname === '/api/generate' && request.method === 'POST') {
        return await gestisciGenerate(request, env, ctx);
      }

      if (url.pathname.startsWith('/api/preview/') && request.method === 'GET') {
        return await gestisciPreview(url, request, env);
      }

      if (url.pathname === '/api/checkout' && request.method === 'POST') {
        return await gestisciCheckout(request, env);
      }

      if (url.pathname === '/api/webhooks/stripe' && request.method === 'POST') {
        return await gestisciWebhookStripe(request, env, ctx);
      }

      if (url.pathname === '/api/health') {
        return json({ ok: true, ora: new Date().toISOString() }, 200, corsHeaders(request, env));
      }

      if (url.pathname.startsWith('/api/')) {
        return json({ ok: false, errore: 'Endpoint non trovato.' }, 404, corsHeaders(request, env));
      }

      // Non è una rotta API: lo gestiscono gli asset statici.
      return new Response('Not found', { status: 404 });

    } catch (errore) {
      const cors = corsHeaders(request, env);

      if (errore instanceof HttpError) {
        return json(
          { ok: false, errore: errore.message, codice: errore.code },
          errore.status,
          cors
        );
      }

      // Errore imprevisto: nel log il dettaglio, al client una frase generica.
      console.error('[worker] errore non gestito:', errore && errore.stack);
      return json(
        { ok: false, errore: 'Errore interno. Riprova tra poco.', codice: 'errore_interno' },
        500,
        cors
      );
    }
  }
};

/* =============================================================================
   POST /api/generate
   ========================================================================== */

async function gestisciGenerate(request, env, ctx) {
  const cors = corsHeaders(request, env);

  if (!env.PREVIEWS) {
    throw new HttpError(500, 'Archivio non configurato.', 'kv_mancante');
  }

  const tipo = request.headers.get('Content-Type') || '';
  if (!tipo.includes('application/json')) {
    throw new HttpError(415, 'Il corpo deve essere JSON.', 'tipo_non_supportato');
  }

  const corpo = await request.json().catch(() => null);

  // I dati del modulo, ricontrollati da zero (la validazione del browser non
  // conta: chiunque può chiamare questo endpoint con curl).
  const { stile, prompt, email } = validaPayload(corpo);

  await verificaRateLimit(request, env);

  const id = generaId();
  await creaAnteprima(env, { id, stile, prompt, email });

  // Il lavoro lento prosegue dopo che la risposta è già partita.
  ctx.waitUntil(generaEInvia(env, { id, stile, prompt, email }));

  return json(
    {
      ok: true,
      id,
      status: 'pending',
      messaggio: 'Richiesta accettata. Generazione in corso.'
    },
    202,
    cors
  );
}

/**
 * Catena completa, eseguita in sottofondo: genera → salva → avvisa il cliente.
 * Non lancia mai: un errore qui arriverebbe a nessuno, quindi lo registriamo
 * nel record KV, dove resta consultabile.
 */
async function generaEInvia(env, { id, stile, prompt, email }) {
  // Serve a dire al titolare DOVE si è rotto: una chiave scaduta e un dominio
  // email non verificato richiedono interventi diversi.
  let fase = 'generazione';

  try {
    const { html, simulato } = await callAnthropicAPI(prompt, stile, env);

    fase = 'salvataggio';
    await salvaHtmlAnteprima(env, id, html, { simulato });

    // Da qui l'anteprima è già consultabile: il polling la trova e la mostra.
    // L'email è la rete di sicurezza per chi ha chiuso la scheda, quindi se
    // fallisce solo l'invio NON marchiamo l'anteprima come errore: il sito
    // esiste, è solo l'avviso a non essere partito.
    fase = 'email';
    try {
      await sendEmailToClient(email, linkAnteprima(env, id), env);
    } catch (erroreEmail) {
      console.error('[worker] email non inviata per', id, erroreEmail && erroreEmail.message);
      await notifyAdminOnFailure(
        { id, stile, fase: 'email', motivo: erroreEmail && erroreEmail.message },
        email,
        env
      );
    }

    console.log('[worker] anteprima pronta', id, simulato ? '(simulata)' : '');

  } catch (errore) {
    const motivo = (errore && errore.message) || 'errore sconosciuto';
    console.error('[worker] generazione fallita per', id, motivo);

    await segnaErroreAnteprima(env, id, motivo).catch(() => {});

    // Unico punto in cui il titolare viene coinvolto prima del pagamento:
    // qui c'è un cliente che sta aspettando un sito che non arriverà.
    await notifyAdminOnFailure({ id, stile, fase, motivo }, email, env);
  }
}

/* =============================================================================
   POST /api/checkout
   -----------------------------------------------------------------------------
   Riceve { preview_id, package_type } e restituisce la URL a cui mandare il
   cliente per pagare.

   Dal browser arriva SOLO il tipo di pacchetto. Gli importi stanno in
   lib/stripe.js e non viaggiano mai nella richiesta: se il prezzo lo mandasse
   il client, chiunque potrebbe comprare il pacchetto da 290€ per un centesimo.
   ========================================================================== */

async function gestisciCheckout(request, env) {
  const cors = corsHeaders(request, env);

  if (!env.PREVIEWS) {
    throw new HttpError(500, 'Archivio non configurato.', 'kv_mancante');
  }

  const tipo = request.headers.get('Content-Type') || '';
  if (!tipo.includes('application/json')) {
    throw new HttpError(415, 'Il corpo deve essere JSON.', 'tipo_non_supportato');
  }

  const corpo = await request.json().catch(() => null);
  if (!corpo || typeof corpo !== 'object') {
    throw new HttpError(400, 'Corpo della richiesta non valido.', 'payload_non_valido');
  }

  const previewId = typeof corpo.preview_id === 'string' ? corpo.preview_id.trim() : '';
  const packageType = typeof corpo.package_type === 'string' ? corpo.package_type.trim() : '';

  if (!pacchettoValido(packageType)) {
    throw new HttpError(400, 'Pacchetto non riconosciuto.', 'pacchetto_non_valido');
  }

  // Non si vende un'anteprima che non esiste, che è ancora in lavorazione o
  // che è fallita: incasseremmo per qualcosa che non possiamo consegnare.
  const anteprima = await leggiAnteprima(env, previewId);

  if (!anteprima) {
    throw new HttpError(404, 'Anteprima non trovata: il link non è più valido.', 'anteprima_non_trovata');
  }

  if (anteprima.status !== 'success') {
    throw new HttpError(
      409,
      'Questa anteprima non è ancora pronta. Aspetta che finisca, poi riprova.',
      'anteprima_non_pronta'
    );
  }

  const ordineId = generaId();
  const pacchetto = PACCHETTI[packageType];

  // L'ordine nasce prima della sessione: se Stripe risponde male, resta
  // comunque traccia del tentativo.
  await creaOrdine(env, {
    id: ordineId,
    previewId,
    packageType,
    nomePacchetto: pacchetto.nome,
    importoTotaleCent: pacchetto.importoTotaleCent,
    importoRicorrenteCent: pacchetto.importoRicorrenteCent || null,
    email: anteprima.email || null
  });

  const sessione = await creaSessioneCheckout(env, {
    ordineId,
    previewId,
    packageType,
    email: anteprima.email
  });

  await aggiornaOrdine(env, ordineId, {
    stripeSessionId: sessione.sessionId,
    simulata: sessione.simulata
  });

  console.log('[checkout] ordine', ordineId, packageType, sessione.simulata ? '(simulato)' : '');

  return json(
    {
      ok: true,
      ordine_id: ordineId,
      url: sessione.url,
      simulata: sessione.simulata
    },
    200,
    cors
  );
}

/* =============================================================================
   POST /api/webhooks/stripe
   -----------------------------------------------------------------------------
   È l'unica fonte attendibile sul fatto che un pagamento sia andato a buon fine.
   Il ritorno del browser su success_url NON lo è: quella URL può aprirla
   chiunque, anche senza aver pagato.

   Per questo l'endpoint accetta solo chiamate firmate da Stripe. Senza la
   verifica, un POST fatto a mano con scritto "pagato" basterebbe ad attivare un
   abbonamento gratis.
   ========================================================================== */

async function gestisciWebhookStripe(request, env, ctx) {
  const segreto = env.STRIPE_WEBHOOK_SECRET;

  // Nessun segreto = nessun modo di distinguere Stripe da un estraneo.
  // In questo caso si rifiuta: accettare "in attesa di configurare" vorrebbe
  // dire tenere aperta una porta che regala pacchetti.
  if (!segreto) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET non impostato: chiamata rifiutata');
    return json(
      { ok: false, errore: 'Webhook non configurato.', codice: 'webhook_non_configurato' },
      503
    );
  }

  // Il corpo grezzo, esattamente com'è arrivato: la firma è calcolata su quei
  // byte lì. Fare JSON.parse e riserializzare cambia gli spazi e invalida tutto.
  const corpoGrezzo = await request.text();
  const firma = request.headers.get('Stripe-Signature');

  const valida = await verificaFirmaWebhook(corpoGrezzo, firma, segreto);
  if (!valida) {
    console.error('[webhook] firma non valida o scaduta: chiamata rifiutata');
    return json({ ok: false, errore: 'Firma non valida.', codice: 'firma_non_valida' }, 400);
  }

  let evento;
  try {
    evento = JSON.parse(corpoGrezzo);
  } catch {
    return json({ ok: false, errore: 'Corpo non leggibile.', codice: 'payload_non_valido' }, 400);
  }

  console.log('[webhook] ricevuto', evento.type, evento.id);

  /* ---------------------------------------------------------------------------
     IDEMPOTENZA
     ---------------------------------------------------------------------------
     Stripe rimanda lo stesso evento finché non riceve un 2xx, e a volte anche
     dopo. Senza questo controllo il titolare riceverebbe due avvisi di vendita
     per lo stesso incasso e aprirebbe due volte la stessa pratica.

     Difesa doppia, perché KV è a consistenza eventuale e due consegne
     ravvicinate potrebbero infilarsi entrambe nel controllo:
       1. il registro `evento:<id>` qui sotto;
       2. il controllo `ordine.stato !== 'pagato'`, che fa da rete anche se il
          primo lascia passare un doppione.
     -------------------------------------------------------------------------- */

  if (await eventoGiaProcessato(env, evento.id)) {
    console.log('[webhook] evento già processato, salto:', evento.id);
    return json({ ok: true, ricevuto: true, gia_processato: true }, 200);
  }

  if (evento.type === 'checkout.session.completed') {
    await gestisciPagamentoRiuscito(evento, env, ctx);
  } else {
    // ---------------------------------------------------------------------
    // TODO — eventi del ciclo di vita dell'abbonamento, non ancora gestiti:
    //   invoice.paid                   rinnovo mensile riuscito
    //   invoice.payment_failed         rinnovo fallito → sospendere il sito
    //   customer.subscription.deleted  disdetta → consegnare i file e chiudere
    // Servono solo quando il primo abbonamento arriva al secondo mese.
    // ---------------------------------------------------------------------
    console.log('[webhook] evento non gestito (per ora):', evento.type);
  }

  await segnaEventoProcessato(env, evento.id, { tipo: evento.type });

  // Stripe considera consegnato solo un 2xx, e riprova per giorni se non lo
  // riceve. Rispondiamo subito: l'eventuale lavoro lungo va in ctx.waitUntil().
  return json({ ok: true, ricevuto: true }, 200);
}

/**
 * Pagamento riuscito: si registra l'incasso e si chiama il titolare.
 *
 * Qui finisce l'automazione. Da questo punto in poi il modello di Kroma prevede
 * una persona: niente zip generati né domini comprati dal codice, solo l'avviso
 * che è il momento di mettersi al lavoro.
 */
async function gestisciPagamentoRiuscito(evento, env, ctx) {
  const sessione = evento.data?.object || {};
  const meta = sessione.metadata || {};
  const ordineId = meta.ordine_id;

  if (!ordineId) {
    // Sessione senza i nostri metadata: non sappiamo a quale anteprima si
    // riferisca. Il titolare va avvisato lo stesso — c'è un incasso reale che
    // altrimenti resterebbe senza nessuno che lo lavora.
    console.error('[webhook] pagamento senza ordine_id nei metadata:', evento.id);
    await notifyAdminOnSuccess({
      id: null,
      email: sessione.customer_details?.email || sessione.customer_email || null,
      stripeCustomerId: sessione.customer || null,
      nomePacchetto: 'DA VERIFICARE — metadata mancanti'
    }, env);
    return;
  }

  const ordine = await leggiOrdine(env, ordineId);

  if (!ordine) {
    console.error('[webhook] ordine non trovato in KV:', ordineId);
    await notifyAdminOnSuccess({
      id: ordineId,
      previewId: meta.preview_id || null,
      packageType: meta.package_type || null,
      email: sessione.customer_details?.email || sessione.customer_email || null,
      stripeCustomerId: sessione.customer || null,
      nomePacchetto: 'DA VERIFICARE — ordine assente in archivio'
    }, env);
    return;
  }

  // Seconda rete contro i doppioni (vedi nota sull'idempotenza sopra).
  if (ordine.stato === 'pagato') {
    console.log('[webhook] ordine già pagato, nessun nuovo avviso:', ordineId);
    return;
  }

  const aggiornato = await aggiornaOrdine(env, ordineId, {
    stato: 'pagato',
    stripeEventId: evento.id,
    stripeCustomerId: sessione.customer || null,
    stripeSubscriptionId: sessione.subscription || null,
    pagatoIl: new Date().toISOString()
  });

  console.log('[webhook] ordine segnato come pagato:', ordineId);

  // L'avviso non deve tenere in attesa la risposta a Stripe: se ci mettesse
  // troppo, Stripe considererebbe il webhook fallito e lo rimanderebbe.
  const avviso = notifyAdminOnSuccess(aggiornato || ordine, env)
    .catch((e) => console.error('[webhook] avviso al titolare fallito:', e && e.message));

  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(avviso);
  else await avviso;
}

/* =============================================================================
   GET /api/preview/:id
   ========================================================================== */

/**
 * Lo interrogano due client:
 *   - il polling di index.html, ogni 5 secondi, finché status resta "pending"
 *   - preview.html, una volta sola, per farsi dare l'HTML da mostrare
 *
 * L'HTML viaggia solo quando c'è (status "success"): mandarlo a vuoto a ogni
 * giro di polling significherebbe spedire decine di kB inutili per niente.
 */
async function gestisciPreview(url, request, env) {
  const cors = corsHeaders(request, env);
  const id = url.pathname.split('/').pop();
  const record = await leggiAnteprima(env, id);

  if (!record) {
    return json(
      {
        ok: false,
        status: 'not_found',
        errore: 'Anteprima non trovata: il link non è valido oppure è scaduto.'
      },
      404,
      cors
    );
  }

  if (record.status === 'error') {
    return json(
      {
        ok: false,
        id,
        status: 'error',
        errore: 'La generazione di questa anteprima non è andata a buon fine.'
        // `motivo` resta in KV per la diagnosi ma non esce di qui: al cliente
        // non serve, e potrebbe contenere dettagli interni dell'infrastruttura.
      },
      200,   // 200: la richiesta è andata bene, è l'anteprima ad essere fallita
      cors
    );
  }

  if (record.status !== 'success' || !record.html) {
    return json({ ok: true, id, status: 'pending' }, 200, cors);
  }

  return json(
    {
      ok: true,
      id,
      status: 'success',
      html: record.html,
      simulato: record.simulato === true,
      creataIl: record.creataIl
    },
    200,
    { ...cors, 'X-Robots-Tag': 'noindex, nofollow' }
  );
}
