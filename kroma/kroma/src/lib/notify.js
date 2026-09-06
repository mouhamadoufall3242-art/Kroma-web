/* =============================================================================
   notify.js — avvisi al titolare
   -----------------------------------------------------------------------------
   Due soli momenti in cui il titolare viene chiamato in causa:

     notifyAdminOnSuccess   qualcuno ha pagato → si mette in produzione a mano
     notifyAdminOnFailure   una generazione è fallita → un cliente aspetta invano

   Il primo è il fulcro del modello: tutto è automatico fino all'incasso, poi
   subentra una persona. Il secondo è l'eccezione necessaria — senza, un cliente
   resterebbe ad aspettare un sito che non arriverà mai, e lo perderemmo senza
   nemmeno saperlo.

   Entrambi mandano una email vera a kroma.site@gmail.com tramite Resend, e in
   più lasciano sempre il messaggio nei log: se l'invio salta, l'informazione
   non va persa.

   NESSUNA DELLE DUE LANCIA MAI.
   notifyAdminOnFailure vive dentro un catch: se esplodesse, nasconderebbe
   l'errore originale invece di segnalarlo. notifyAdminOnSuccess è chiamata dal
   webhook: se esplodesse, Stripe non riceverebbe il 200 e rimanderebbe l'evento
   all'infinito.
   ========================================================================== */

const DESTINATARIO_SOS = 'kroma.site@gmail.com';
const RESEND_URL = 'https://api.resend.com/emails';

/* =============================================================================
   INVIO — un solo punto per entrambi gli avvisi
   ========================================================================== */

/**
 * Manda una email al titolare. Non lancia: restituisce solo se è partita.
 *
 * Il mittente deve stare su un dominio verificato in Resend (voci DNS),
 * altrimenti l'API accetta la chiamata ma il messaggio finisce nello spam.
 *
 * @returns {Promise<boolean>} true se Resend l'ha accettata
 */
async function inviaAvvisoAlTitolare(env, { oggetto, testo }) {
  const apiKey = env && env.RESEND_API_KEY;

  if (!apiKey) {
    console.warn('[notify] nessuna RESEND_API_KEY: avviso solo nei log');
    return false;
  }

  try {
    const risposta = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'Kroma <onboarding@resend.dev>',
        to: [DESTINATARIO_SOS],
        subject: oggetto,
        text: testo
      })
    });

    if (!risposta.ok) {
      const dettaglio = await risposta.text().catch(() => '');
      console.error('[notify] Resend ha rifiutato:', risposta.status, dettaglio.slice(0, 200));
      return false;
    }

    return true;

  } catch (errore) {
    // Rete o API giù. Il blocco già stampato nei log resta l'unica copia:
    // per questo viene scritto PRIMA di tentare l'invio, non dopo.
    console.error('[notify] invio avviso fallito:', errore && errore.message);
    return false;
  }
}

/* =============================================================================
   VENDITA ANDATA A BUON FINE
   ========================================================================== */

/**
 * Avvisa il titolare che un ordine è stato pagato e va lavorato.
 *
 * @param {object} orderData  l'ordine letto da KV
 * @param {object} [env]      chiavi e variabili del Worker
 */
export async function notifyAdminOnSuccess(orderData, env) {
  const o = orderData || {};

  const avviso = {
    evento: 'PAGAMENTO RICEVUTO',
    destinatario: DESTINATARIO_SOS,
    ordine: o.id || 'sconosciuto',
    cliente: o.email || 'email non disponibile',
    pacchetto: o.nomePacchetto || o.packageType || 'sconosciuto',
    tipo: o.packageType || '-',
    importo: formattaEuro(o.importoTotaleCent),
    ricorrente: o.importoRicorrenteCent ? formattaEuro(o.importoRicorrenteCent) + '/mese' : null,
    anteprima: o.previewId || 'sconosciuta',
    linkAnteprima: linkPubblico(env, o.previewId),
    clienteStripe: o.stripeCustomerId || null,
    quando: new Date().toISOString(),
    azione: 'AVVIARE LA MESSA IN PRODUZIONE. Contattare il cliente per dominio, ' +
            'contenuti definitivi e messa online.'
  };

  const importoCompleto = avviso.importo + (avviso.ricorrente ? ' + ' + avviso.ricorrente : '');

  // I log si scrivono PRIMA dell'invio: se l'email non parte, l'informazione
  // è comunque salva da qualche parte.
  console.log(
    '\n' +
    '═══════════════════════════════════════════════════════════\n' +
    '  💰 KROMA-VENDITA — PAGAMENTO RICEVUTO\n' +
    '═══════════════════════════════════════════════════════════\n' +
    `  Cliente     ${avviso.cliente}\n` +
    `  Pacchetto   ${avviso.pacchetto} (${avviso.tipo})\n` +
    `  Importo     ${importoCompleto}\n` +
    `  Anteprima   ${avviso.anteprima}\n` +
    `  Link        ${avviso.linkAnteprima}\n` +
    `  Ordine      ${avviso.ordine}\n` +
    '───────────────────────────────────────────────────────────\n' +
    '  ▶ ' + avviso.azione + '\n' +
    '═══════════════════════════════════════════════════════════\n'
  );

  console.log('KROMA-VENDITA ' + JSON.stringify(avviso));

  avviso.emailInviata = await inviaAvvisoAlTitolare(env, {
    oggetto: `💰 Nuovo ordine Kroma — ${avviso.pacchetto} (${importoCompleto})`,
    testo: [
      'Un cliente ha pagato. Il sito va messo in produzione a mano.',
      '',
      '─────────────────────────────────────────',
      `Cliente      ${avviso.cliente}`,
      `Pacchetto    ${avviso.pacchetto}`,
      `Importo      ${importoCompleto}`,
      `Anteprima    ${avviso.linkAnteprima}`,
      `Ordine       ${avviso.ordine}`,
      avviso.clienteStripe ? `Stripe       ${avviso.clienteStripe}` : null,
      `Quando       ${avviso.quando}`,
      '─────────────────────────────────────────',
      '',
      avviso.azione,
      '',
      'Prossimi passi con il cliente:',
      '  1. Scrivergli entro poche ore — la pagina di conferma glielo promette.',
      '  2. Raccogliere dominio, testi definitivi, foto e contatti.',
      '  3. Mettere il sito online e consegnare.'
    ].filter(Boolean).join('\n')
  });

  return avviso;
}

function formattaEuro(centesimi) {
  if (typeof centesimi !== 'number') return '-';
  return (centesimi / 100).toFixed(2).replace('.', ',') + ' €';
}

function linkPubblico(env, previewId) {
  if (!previewId) return '-';
  const base = ((env && env.SITE_URL) || 'https://kroma.it').replace(/\/+$/, '');
  return `${base}/preview.html?id=${previewId}`;
}

/* =============================================================================
   GENERAZIONE FALLITA
   ========================================================================== */

/**
 * Segnala al titolare che una generazione è fallita.
 *
 * @param {object} errorDetails  { id, motivo, fase, stile }
 * @param {string} clientEmail   il cliente rimasto in attesa
 * @param {object} [env]         chiavi e variabili del Worker
 */
export async function notifyAdminOnFailure(errorDetails, clientEmail, env) {
  const dettagli = errorDetails || {};

  const sos = {
    allerta: 'GENERAZIONE FALLITA',
    destinatario: DESTINATARIO_SOS,
    anteprima: dettagli.id || 'sconosciuta',
    cliente: clientEmail || 'sconosciuto',
    fase: dettagli.fase || 'sconosciuta',
    stile: dettagli.stile || '-',
    motivo: String(dettagli.motivo || 'nessun dettaglio').slice(0, 500),
    quando: new Date().toISOString(),
    azione: 'Un cliente sta aspettando un\'anteprima che non arriverà. Ricontattarlo a mano.'
  };

  // Riga singola: nel pannello Cloudflare i log si filtrano per testo, e
  // "KROMA-SOS" è la stringa da cercare (o su cui costruire un alert).
  console.error('🚨 KROMA-SOS ' + JSON.stringify(sos));

  // Se a fallire è stato proprio l'invio dell'email al cliente (fase "email"),
  // è probabile che Resend sia giù e che anche questo avviso non parta. Ci
  // proviamo lo stesso: la riga di log sopra è già al sicuro.
  sos.emailInviata = await inviaAvvisoAlTitolare(env, {
    oggetto: `🚨 SOS Kroma — generazione fallita (${sos.anteprima})`,
    testo: [
      'Una generazione è fallita e il cliente sta aspettando.',
      '',
      '─────────────────────────────────────────',
      `Anteprima    ${sos.anteprima}`,
      `Cliente      ${sos.cliente}`,
      `Fase         ${sos.fase}`,
      `Stile        ${sos.stile}`,
      `Motivo       ${sos.motivo}`,
      `Quando       ${sos.quando}`,
      '─────────────────────────────────────────',
      '',
      sos.azione,
      '',
      'Cosa significano le fasi:',
      '  generazione   Anthropic non ha risposto o ha risposto male',
      '  salvataggio   il sito è stato generato ma non si è scritto in KV',
      '  email         il sito c\'è ed è consultabile: non è partito l\'avviso'
    ].join('\n')
  });

  return sos;
}
