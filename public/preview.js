/* =============================================================================
   KROMA — preview.js
   Mostra l'anteprima generata quando l'URL contiene ?id=<id>.
   Senza id la pagina resta com'è: la demo statica dello studio di architettura,
   che serve da vetrina per chi arriva da fuori.

   PERCHÉ UN IFRAME E NON innerHTML
   -----------------------------------------------------------------------------
   L'HTML che arriva da /api/preview/:id lo ha scritto un modello, non noi. Due
   motivi per tenerlo fuori dal nostro documento:

   1. È un documento completo (<!DOCTYPE html><html>…). Infilarlo dentro un div
      non funziona: il browser scarta html, head e body e resta il contenuto
      spaiato, senza i suoi stili.
   2. Iniettarlo con innerHTML lo eseguirebbe sulla nostra origine. Basterebbe
      un <script> finito lì dentro per avere codice arbitrario che gira su
      kroma.it, con accesso a tutto quello che ci sta sopra.

   L'iframe con srcdoc risolve entrambi: il documento resta completo, e con
   sandbox="allow-popups" (senza allow-same-origin) prende un'origine opaca —
   non può leggere né toccare nulla di questa pagina.
   ========================================================================== */

(function () {
  'use strict';

  // Vedi la nota in main.js: vuota = stesso dominio, altrimenti si imposta
  // window.KROMA_API_BASE prima di caricare questo file.
  var API_BASE = (window.KROMA_API_BASE || '').replace(/\/+$/, '');

  var ENDPOINT = API_BASE + '/api/preview/';
  var ENDPOINT_CHECKOUT = API_BASE + '/api/checkout';
  var RIPROVA_MS = 5000;          // se l'anteprima è ancora in lavorazione
  var RIPROVA_MAX_MS = 5 * 60000; // oltre, si smette di riprovare

  var params = new URLSearchParams(window.location.search);
  var id = (params.get('id') || '').trim();

  // I bottoni del paywall vivono anche nella demo statica, quindi si agganciano
  // sempre — prima dell'uscita anticipata qui sotto.
  agganciaPaywall();

  // Nessun id: la pagina resta la demo statica. Non tocchiamo altro.
  if (!id) return;

  var body = document.getElementById('preview-body');
  var frame = document.getElementById('preview-live');
  var demo = document.getElementById('preview-demo');
  var demoLocked = document.getElementById('locked-demo');
  var caricamento = document.getElementById('preview-loading');
  var boxErrore = document.getElementById('preview-error');
  var titoloErrore = document.getElementById('preview-error-title');
  var testoErrore = document.getElementById('preview-error-text');
  var urlFinta = document.getElementById('preview-url');
  var tag = document.getElementById('preview-tag');
  var titoloPagina = document.getElementById('preview-title');
  var introLead = document.querySelector('.preview-intro__lead');

  if (!body || !frame) return;

  var inizio = Date.now();
  var timer = null;

  /* -------------------------------------------------------------------------
     Modalità "sito generato": via la demo, dentro l'iframe.
     ---------------------------------------------------------------------- */
  body.classList.add('is-live');
  if (demo) demo.hidden = true;
  if (demoLocked) demoLocked.hidden = true;

  if (urlFinta) urlFinta.textContent = 'https://ilmiosito.it';
  if (tag) tag.textContent = 'La tua anteprima';

  // La versione statica vanta "costruito in 47 secondi": è un numero da
  // vetrina. Davanti al sito vero di un cliente non ha senso millantare un
  // tempo che non abbiamo misurato.
  if (titoloPagina) {
    titoloPagina.innerHTML = 'Ecco il tuo sito. <span class="text-accent">Costruito su misura.</span>';
  }
  if (introLead) {
    introLead.textContent = 'Questa è la proposta generata a partire dalla tua ' +
      'descrizione. Guarda con calma la parte in alto: è già il tuo sito.';
  }

  mostra('caricamento');
  chiediAnteprima();

  /* =========================================================================
     Richiesta e stati
     ====================================================================== */

  function chiediAnteprima() {
    fetch(ENDPOINT + encodeURIComponent(id), {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    })
      .then(function (risposta) {
        return risposta.json().catch(function () { return null; });
      })
      .then(function (dati) {
        if (!dati) return riprovaOppureErrore('risposta non leggibile');

        if (dati.status === 'success' && dati.html) {
          mostraSito(dati.html);
          return;
        }

        if (dati.status === 'pending') {
          riprovaOppureErrore(null, true);
          return;
        }

        if (dati.status === 'not_found') {
          mostraErrore(
            'Questo link non è valido.',
            'Il link potrebbe essere incompleto, oppure l\'anteprima è scaduta. ' +
            'Chiamaci e la rigeneriamo subito.'
          );
          return;
        }

        // status === 'error', o qualunque altra cosa
        mostraErrore(null, null);
      })
      .catch(function () {
        // Rete ballerina: riprovare ha senso, l'anteprima è probabilmente lì.
        riprovaOppureErrore('rete non raggiungibile', true);
      });
  }

  function riprovaOppureErrore(motivo, silenzioso) {
    if (Date.now() - inizio >= RIPROVA_MAX_MS) {
      mostraErrore(
        'Ci sta mettendo troppo.',
        'La tua anteprima è ancora in lavorazione. Puoi riprovare tra qualche ' +
        'minuto ricaricando la pagina, oppure chiamarci e la sblocchiamo noi.'
      );
      return;
    }

    if (!silenzioso && motivo) console.warn('[preview] riprovo:', motivo);
    timer = window.setTimeout(chiediAnteprima, RIPROVA_MS);
  }

  /* =========================================================================
     Rendering
     ====================================================================== */

  function mostraSito(html) {
    if (timer) window.clearTimeout(timer);

    // srcdoc: il documento entra completo nell'iframe, che essendo in sandbox
    // senza allow-same-origin non può raggiungere questa pagina.
    frame.setAttribute('srcdoc', html);
    mostra('sito');
    adattaAltezza();
  }

  /**
   * L'iframe deve essere alto quanto la fascia che vogliamo lasciare a fuoco
   * più tutto il paywall che ci va sopra.
   *
   * Senza questo calcolo l'altezza è fissa, il paywall cambia altezza al
   * variare del breakpoint (su mobile le card si impilano e diventa il doppio)
   * e la fascia a fuoco si mangia tutto lo spazio, fino a sparire: il cliente
   * si ritrova un dito di sito e un muro di prezzi.
   *
   * Nota: l'altezza reale del documento dentro l'iframe non è leggibile —
   * sandbox senza allow-same-origin, ed è giusto così. Decidiamo noi quanto
   * mostrarne, che per una pagina a pagamento è comunque la scelta corretta.
   */
  function adattaAltezza() {
    var locked = document.querySelector('.locked');
    if (!locked) return;

    var stile = window.getComputedStyle(body);
    var fascia = parseInt(stile.getPropertyValue('--fascia-a-fuoco'), 10) || 620;
    var altezzaPaywall = locked.offsetHeight || 900;

    frame.style.height = (fascia + altezzaPaywall) + 'px';
  }

  var attesaResize = null;
  window.addEventListener('resize', function () {
    if (frame.hidden) return;
    window.clearTimeout(attesaResize);
    attesaResize = window.setTimeout(adattaAltezza, 200);
  });

  function mostraErrore(titolo, testo) {
    if (timer) window.clearTimeout(timer);

    if (titolo && titoloErrore) titoloErrore.textContent = titolo;
    if (testo && testoErrore) testoErrore.textContent = testo;

    mostra('errore');

    if (titoloErrore) {
      titoloErrore.setAttribute('tabindex', '-1');
      titoloErrore.focus({ preventScroll: true });
    }
  }

  /**
   * Un solo stato visibile per volta.
   * Nota: la zona bloccata con il paywall resta visibile SOLO insieme al sito.
   * Mostrare un paywall sopra un messaggio d'errore sarebbe chiedere soldi per
   * qualcosa che non siamo riusciti a consegnare.
   */
  function mostra(stato) {
    frame.hidden = stato !== 'sito';
    if (caricamento) caricamento.hidden = stato !== 'caricamento';
    if (boxErrore) boxErrore.hidden = stato !== 'errore';

    body.classList.toggle('mostra-paywall', stato === 'sito');
  }

  /* =========================================================================
     CHECKOUT
     ====================================================================== */

  function agganciaPaywall() {
    var bottoni = document.querySelectorAll('.paywall [data-package]');
    if (!bottoni.length) return;

    Array.prototype.forEach.call(bottoni, function (bottone) {
      bottone.addEventListener('click', function () {
        avviaCheckout(bottone, bottone.getAttribute('data-package'));
      });
    });
  }

  var checkoutInCorso = false;

  function avviaCheckout(bottone, pacchetto) {
    // Doppio click, o click sull'altro pacchetto mentre il primo sta partendo:
    // due sessioni di pagamento aperte insieme confondono e basta.
    if (checkoutInCorso) return;

    // Senza id siamo nella demo: non c'è un sito da comprare. Invece di un
    // errore, si manda la persona a generarne uno — è quello che vuole fare.
    if (!id) {
      window.location.href = 'index.html#generatore';
      return;
    }

    checkoutInCorso = true;
    nascondiErroreCheckout();
    caricando(bottone, true);

    fetch(ENDPOINT_CHECKOUT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview_id: id, package_type: pacchetto })
    })
      .then(function (risposta) {
        return risposta.json()
          .catch(function () { return {}; })
          .then(function (dati) {
            if (!risposta.ok || dati.ok === false || !dati.url) {
              throw new Error(dati.errore || 'Non riusciamo ad aprire il pagamento.');
            }
            return dati;
          });
      })
      .then(function (dati) {
        // Il bottone resta in caricamento fino al cambio pagina: rimetterlo a
        // posto ora farebbe pensare che il click non abbia funzionato.
        window.location.href = dati.url;
      })
      .catch(function (errore) {
        checkoutInCorso = false;
        caricando(bottone, false);
        mostraErroreCheckout(errore.message);
      });
  }

  /** Stato di caricamento del bottone, senza perdere il testo originale. */
  function caricando(bottone, attivo) {
    var etichetta = bottone.querySelector('.btn__label');

    if (attivo) {
      if (etichetta) {
        bottone.setAttribute('data-testo-originale', etichetta.textContent);
        etichetta.textContent = 'Caricamento…';
      }
      bottone.classList.add('is-loading');
      bottone.setAttribute('aria-busy', 'true');
      bottone.disabled = true;
      return;
    }

    if (etichetta && bottone.hasAttribute('data-testo-originale')) {
      etichetta.textContent = bottone.getAttribute('data-testo-originale');
      bottone.removeAttribute('data-testo-originale');
    }
    bottone.classList.remove('is-loading');
    bottone.removeAttribute('aria-busy');
    bottone.disabled = false;
  }

  function mostraErroreCheckout(messaggio) {
    var box = document.getElementById('paywall-error');
    if (!box) return;
    box.textContent = messaggio + ' Puoi riprovare, oppure chiamarci al +39 371 760 8305.';
    box.hidden = false;
  }

  function nascondiErroreCheckout() {
    var box = document.getElementById('paywall-error');
    if (box) box.hidden = true;
  }

}());
