/* =============================================================================
   anthropic.js — generazione dell'anteprima
   -----------------------------------------------------------------------------
   STATO: la struttura della chiamata è completa e corretta, ma finché
   env.ANTHROPIC_API_KEY non è impostata la funzione NON chiama l'API e
   restituisce un HTML segnaposto. Basta aggiungere il segreto per farla
   partire davvero, senza toccare il codice:
       npx wrangler secret put ANTHROPIC_API_KEY
   ========================================================================== */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';   // header anthropic-version, non è la versione del modello
const MAX_TOKENS = 8000;

/**
 * Indicazioni di stile passate al modello. Le chiavi sono gli stessi value dei
 * radio del modulo, così il front-end e il backend restano allineati.
 */
const STILI = {
  futuro: {
    nome: 'Futuro',
    direzione: 'Tecnologico e scuro. Fondi profondi, accenti luminosi, tipografia ' +
               'geometrica, molto respiro. Adatto a chi vende innovazione.'
  },
  fiducia: {
    nome: 'Fiducia',
    direzione: 'Sobrio e professionale. Palette fredda e contenuta, griglia ordinata, ' +
               'niente effetti. Adatto a studi, consulenti e servizi alla persona.'
  },
  bottega: {
    nome: 'Bottega',
    direzione: 'Caldo e artigianale. Tonalità terrose, texture materiche, tipografia ' +
               'con grazie. Adatto ad attività locali e laboratori.'
  },
  vetrina: {
    nome: 'Vetrina',
    direzione: 'Immagini grandi e catalogo in evidenza. Griglia a card, poco testo, ' +
               'molto spazio visivo. Adatto a prodotti e portfolio.'
  }
};

function costruisciSystemPrompt(stile) {
  const scelto = STILI[stile] || STILI.fiducia;

  return [
    'Sei un web designer italiano. Generi la home page di un sito vetrina per una',
    'piccola impresa, a partire dalla descrizione che il titolare fa della propria',
    'attività.',
    '',
    `DIREZIONE VISIVA RICHIESTA — "${scelto.nome}": ${scelto.direzione}`,
    '',
    'REGOLE:',
    '- Restituisci un unico file HTML completo e autosufficiente, con il CSS in un',
    '  tag <style> nel <head>. Nessun file esterno, nessun JavaScript.',
    '- Nessuna immagine remota: usa gradienti, forme CSS o SVG inline.',
    '- Testi in italiano, concreti, tratti dalla descrizione fornita. Se un dato non',
    "  c'è (indirizzo, orari, anni di attività) NON inventarlo: ometti la sezione.",
    '- Struttura: intestazione, hero, servizi, un motivo per sceglierli, contatti.',
    '- Il sito deve essere responsive e leggibile da mobile.',
    '',
    'Rispondi SOLO con il codice HTML, senza spiegazioni e senza blocchi markdown.'
  ].join('\n');
}

/**
 * Genera l'HTML dell'anteprima.
 *
 * @param {string} prompt  descrizione dell'attività scritta dall'utente
 * @param {string} style   uno tra: futuro | fiducia | bottega | vetrina
 * @param {object} env     ambiente del Worker (segreti e variabili)
 * @returns {Promise<{html: string, simulato: boolean}>}
 */
export async function callAnthropicAPI(prompt, style, env) {
  // ---------------------------------------------------------------------------
  // La chiave arriva da qui. In produzione: `npx wrangler secret put
  // ANTHROPIC_API_KEY`. In locale: riga ANTHROPIC_API_KEY nel file .dev.vars.
  // Non scriverla mai in wrangler.toml, che finisce su git.
  // ---------------------------------------------------------------------------
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.log('[anthropic] nessuna ANTHROPIC_API_KEY: restituisco un segnaposto');
    return { html: htmlSegnaposto(prompt, style), simulato: true };
  }

  const risposta = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      max_tokens: MAX_TOKENS,
      system: costruisciSystemPrompt(style),
      messages: [
        {
          role: 'user',
          content: `Ecco la mia attività:\n\n${prompt}`
        }
      ]
    })
  });

  if (!risposta.ok) {
    // Il corpo dell'errore può contenere la chiave in chiaro in alcuni casi:
    // logghiamo solo status e codice, mai la risposta grezza.
    const dettaglio = await risposta.json().catch(() => ({}));
    console.error('[anthropic] errore', risposta.status, dettaglio?.error?.type || '');
    throw new Error(`Anthropic ha risposto ${risposta.status}`);
  }

  const dati = await risposta.json();

  // La risposta è un array di blocchi: teniamo solo quelli testuali.
  const html = (dati.content || [])
    .filter((blocco) => blocco.type === 'text')
    .map((blocco) => blocco.text)
    .join('')
    .trim();

  if (!html) throw new Error('Anthropic ha restituito una risposta vuota');

  return { html: ripulisciHtml(html), simulato: false };
}

/**
 * Il modello a volte incornicia il codice in un blocco markdown nonostante le
 * istruzioni. Se succede, togliamo la cornice invece di salvare in KV un file
 * che il browser mostrerebbe come testo.
 */
function ripulisciHtml(testo) {
  const conCornice = testo.match(/^```(?:html)?\s*\n([\s\S]*?)\n?```$/);
  return conCornice ? conCornice[1].trim() : testo;
}

/* -----------------------------------------------------------------------------
   Segnaposto usato finché manca la chiave: permette di provare tutto il flusso
   (KV, link, email) senza spendere un centesimo di API.
   -------------------------------------------------------------------------- */
function htmlSegnaposto(prompt, style) {
  const nome = (STILI[style] || STILI.fiducia).nome;
  const estratto = prompt.slice(0, 200).replace(/[<>&]/g, '');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anteprima simulata — Kroma</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#040613; color:#F2F4FF; text-align:center; padding:2rem;
         font-family:system-ui, sans-serif; }
  .box { max-width:34rem; }
  h1 { font-size:1.6rem; letter-spacing:-.02em; }
  p  { color:#A8B0D0; line-height:1.7; }
  code { color:#FFB020; }
</style>
</head>
<body>
  <div class="box">
    <h1>Anteprima simulata</h1>
    <p>Questa pagina è un segnaposto: manca la chiave <code>ANTHROPIC_API_KEY</code>,
       quindi l'anteprima non è stata generata davvero.</p>
    <p>Stile richiesto: <strong>${nome}</strong><br>Descrizione ricevuta: “${estratto}…”</p>
  </div>
</body>
</html>`;
}
