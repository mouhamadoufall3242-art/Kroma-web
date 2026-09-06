/* ==========================================================================
   KROMA — main.js
   Wizard multi-step del generatore + attesa e messaggio di successo.
   Nessuna dipendenza. Miglioramento progressivo: se questo file non viene
   caricato, il modulo resta un form unico e funzionante.
   ========================================================================== */

(function () {
  'use strict';

  /* --- Configurazione ---------------------------------------------------- */

  // Base delle API. Vuota = stesso dominio del sito, che è il caso normale
  // quando il Worker serve anche le pagine (vedi [assets] in wrangler.toml).
  //
  // Se un giorno il front-end finisse su un'origine diversa dal Worker — per
  // esempio Pages su kroma.pages.dev e API su kroma.workers.dev — basta
  // definire questa riga PRIMA di main.js, senza toccare il codice:
  //   <script>window.KROMA_API_BASE = 'https://kroma.tuo-account.workers.dev';</script>
  // Ricordandosi che in quel caso servono anche gli header CORS del Worker
  // (già previsti in src/lib/http.js).
  var API_BASE = (window.KROMA_API_BASE || '').replace(/\/+$/, '');

  var ENDPOINT = API_BASE + '/api/generate';
  var ENDPOINT_STATO = API_BASE + '/api/preview/';
  var PAGINA_ANTEPRIMA = 'preview.html';

  var ATTESA_MS = 3500;             // durata minima dello spinner
  var TIMEOUT_MS = 15000;           // oltre questo la POST viene annullata
  var POLLING_MS = 5000;            // ogni quanto si chiede "è pronta?"
  var POLLING_MAX_MS = 5 * 60000;   // dopo 5 minuti si smette e si punta all'email
  var PROMPT_MIN = 25;              // caratteri minimi della descrizione

  /* --- Elementi ---------------------------------------------------------- */

  var form = document.getElementById('generator-form');
  if (!form) return;

  var steps = Array.prototype.slice.call(form.querySelectorAll('.wizard__step'));
  if (steps.length === 0) return;

  var progressItems = Array.prototype.slice.call(form.querySelectorAll('.wizard__progress-item'));
  var statusLine = document.getElementById('wizard-status');
  var pendingBox = document.getElementById('wizard-pending');
  var successBox = document.getElementById('wizard-success');
  var failureBox = document.getElementById('wizard-failure');
  var failureText = document.getElementById('wizard-failure-text');
  var retryBtn = document.getElementById('wizard-retry');

  var indiceCorrente = 0;

  /* ======================================================================
     VALIDAZIONE — un controllo per step, eseguito solo su quello attivo
     ====================================================================== */

  var regoleStep = [
    // Step 1 — deve essere selezionato uno stile
    function () {
      var scelto = form.querySelector('input[name="stile"]:checked');
      if (!scelto) {
        return {
          messaggio: 'Scegli uno stile per continuare.',
          bersaglio: form.querySelector('.style-grid'),
          focus: form.querySelector('input[name="stile"]')
        };
      }
      return null;
    },

    // Step 2 — descrizione presente e non troppo corta
    function () {
      var campo = form.querySelector('#prompt');
      var testo = campo.value.trim();

      if (testo === '') {
        return {
          messaggio: 'Scrivi due righe sulla tua attività: senza non possiamo generare nulla.',
          bersaglio: campo,
          focus: campo
        };
      }
      if (testo.length < PROMPT_MIN) {
        return {
          messaggio: 'Ancora un po\' di dettaglio: servono almeno ' + PROMPT_MIN +
                     ' caratteri (ne hai scritti ' + testo.length + ').',
          bersaglio: campo,
          focus: campo
        };
      }
      return null;
    },

    // Step 3 — email presente e formalmente valida
    function () {
      var campo = form.querySelector('#email');

      if (campo.value.trim() === '') {
        return {
          messaggio: 'Serve un indirizzo email per ricevere il link dell\'anteprima.',
          bersaglio: campo,
          focus: campo
        };
      }
      // checkValidity() sfrutta type="email" del browser
      if (!campo.checkValidity()) {
        return {
          messaggio: 'Controlla l\'indirizzo: sembra manchi qualcosa (esempio: nome@tuaazienda.it).',
          bersaglio: campo,
          focus: campo
        };
      }
      return null;
    }
  ];

  function mostraErrore(indice, errore) {
    var box = form.querySelector('[data-error-for="' + (indice + 1) + '"]');
    if (box) {
      box.textContent = errore.messaggio;
      box.hidden = false;
    }
    if (errore.bersaglio) {
      errore.bersaglio.classList.add('is-invalid');
    }
    if (errore.focus && typeof errore.focus.focus === 'function') {
      errore.focus.focus();
    }
    annuncia(errore.messaggio);
  }

  function pulisciErrore(indice) {
    var box = form.querySelector('[data-error-for="' + (indice + 1) + '"]');
    if (box) {
      box.hidden = true;
      box.textContent = '';
    }
    var segnati = steps[indice].querySelectorAll('.is-invalid');
    Array.prototype.forEach.call(segnati, function (el) {
      el.classList.remove('is-invalid');
    });
  }

  function stepValido(indice) {
    pulisciErrore(indice);
    var errore = regoleStep[indice] ? regoleStep[indice]() : null;
    if (errore) {
      mostraErrore(indice, errore);
      return false;
    }
    return true;
  }

  /* ======================================================================
     NAVIGAZIONE
     ====================================================================== */

  function annuncia(testo) {
    if (statusLine) statusLine.textContent = testo;
  }

  function mostraStep(indice, opzioni) {
    opzioni = opzioni || {};
    indiceCorrente = indice;

    steps.forEach(function (step, i) {
      step.hidden = (i !== indice);
    });

    progressItems.forEach(function (item, i) {
      item.classList.toggle('is-current', i === indice);
      item.classList.toggle('is-done', i < indice);
    });

    if (opzioni.sposta !== false) {
      // Porta il focus sul titolo dello step: chi naviga da tastiera o con
      // screen reader riparte da lì invece che dall'inizio della pagina.
      var titolo = steps[indice].querySelector('.step__legend');
      if (titolo) titolo.focus({ preventScroll: true });

      annuncia('Passaggio ' + (indice + 1) + ' di ' + steps.length);
    }
  }

  function avanti() {
    if (!stepValido(indiceCorrente)) return;
    if (indiceCorrente < steps.length - 1) mostraStep(indiceCorrente + 1);
  }

  function indietro() {
    // Tornando indietro non si valida: l'utente deve poter correggere.
    pulisciErrore(indiceCorrente);
    if (indiceCorrente > 0) mostraStep(indiceCorrente - 1);
  }

  form.addEventListener('click', function (evento) {
    var pulsante = evento.target.closest('[data-action]');
    if (!pulsante || !form.contains(pulsante)) return;

    var azione = pulsante.getAttribute('data-action');
    if (azione === 'next') { evento.preventDefault(); avanti(); }
    if (azione === 'prev') { evento.preventDefault(); indietro(); }
  });

  // Se l'utente corregge il campo, l'errore sparisce senza aspettare "Avanti".
  form.addEventListener('input', function (evento) {
    if (evento.target.classList.contains('is-invalid')) {
      pulisciErrore(indiceCorrente);
    }
  });

  form.addEventListener('change', function (evento) {
    if (evento.target.name === 'stile') pulisciErrore(indiceCorrente);
  });

  /* ======================================================================
     INVIO — attesa di ATTESA_MS, poi messaggio di successo
     ====================================================================== */

  var attesaInCorso = false;

  form.addEventListener('submit', function (evento) {
    evento.preventDefault();
    if (attesaInCorso) return;

    // Invio implicito (Invio da tastiera) su uno step intermedio: avanza
    // invece di inviare tutto il modulo.
    if (indiceCorrente < steps.length - 1) {
      avanti();
      return;
    }

    // Ultimo controllo su tutti gli step, non solo sull'ultimo: se qualcosa
    // è stato svuotato tornando indietro, ci si ferma su quello step.
    for (var i = 0; i < steps.length; i++) {
      if (!stepValido(i)) {
        mostraStep(i);
        stepValido(i); // riporta il messaggio e il focus sul campo giusto
        return;
      }
    }

    avviaAttesa();
  });

  /**
   * Invia i dati al Worker. Risolve con la risposta JSON, oppure rigetta con un
   * Error il cui messaggio è già scritto per essere mostrato all'utente.
   */
  function inviaAlServer() {
    var dati = {
      stile: (form.querySelector('input[name="stile"]:checked') || {}).value,
      prompt: form.querySelector('#prompt').value.trim(),
      email: form.querySelector('#email').value.trim()
    };

    // Se la rete si pianta, la richiesta viene annullata invece di restare
    // appesa: meglio un errore onesto che uno spinner infinito.
    var controller = ('AbortController' in window) ? new AbortController() : null;
    var scadenza = controller && window.setTimeout(function () {
      controller.abort();
    }, TIMEOUT_MS);

    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dati),
      signal: controller ? controller.signal : undefined
    })
      .then(function (risposta) {
        if (scadenza) window.clearTimeout(scadenza);

        return risposta.json()
          .catch(function () { return {}; })
          .then(function (corpo) {
            if (!risposta.ok || corpo.ok === false) {
              // Il Worker manda messaggi già in italiano e già comprensibili:
              // se c'è, usiamo il suo invece di uno generico nostro.
              throw new Error(corpo.errore || 'Il server ha risposto ' + risposta.status + '.');
            }
            return corpo;
          });
      })
      .catch(function (errore) {
        if (scadenza) window.clearTimeout(scadenza);
        if (errore.name === 'AbortError') {
          throw new Error('La richiesta ha impiegato troppo tempo. Controlla la connessione e riprova.');
        }
        throw errore;
      });
  }

  function avviaAttesa() {
    attesaInCorso = true;

    form.hidden = true;
    if (failureBox) failureBox.hidden = true;
    if (pendingBox) pendingBox.hidden = false;
    annuncia('Generazione in corso.');

    // L'attesa dura sempre almeno ATTESA_MS anche se il server risponde in
    // 200ms: la richiesta viene accodata, non completata, e uno spinner che
    // sparisce all'istante farebbe sembrare che non sia successo nulla.
    var attesaMinima = new Promise(function (risolvi) {
      window.setTimeout(risolvi, ATTESA_MS);
    });

    var richiesta = inviaAlServer();

    // Il rigetto viene gestito sotto: qui serve solo che l'attesa minima non
    // venga saltata quando la richiesta fallisce subito.
    Promise.all([richiesta.catch(function (e) { return e; }), attesaMinima])
      .then(function (risultati) {
        var esito = risultati[0];
        if (esito instanceof Error) mostraFallimento(esito);
        else avviaPolling(esito.id);
      });
  }

  /* ======================================================================
     POLLING — si resta sulla pagina finché il sito non è pronto
     ----------------------------------------------------------------------
     La generazione parte sul server e prosegue anche se l'utente chiude la
     scheda: il polling è solo il modo di accorgersene subito, l'email resta
     la rete di sicurezza. Per questo un errore di rete qui non interrompe
     nulla — si riprova al giro dopo.
     ====================================================================== */

  var pollingTimer = null;
  var pollingInizio = 0;
  var elapsedTimer = null;

  function avviaPolling(id) {
    if (!id) {
      // Il server non ha restituito un id: non c'è nulla da interrogare,
      // ma la generazione è stata accettata. Ripieghiamo sull'email.
      mostraRipiegoEmail();
      return;
    }

    pollingInizio = Date.now();
    avviaCronometro();
    annuncia('Generazione in corso. Resta su questa pagina.');
    chiediStato(id);
  }

  function chiediStato(id) {
    fetch(ENDPOINT_STATO + encodeURIComponent(id), {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    })
      .then(function (r) { return r.json(); })
      .then(function (dati) {
        if (dati && dati.status === 'success') {
          fermaPolling();
          annuncia('Anteprima pronta. Ti stiamo portando alla pagina.');
          window.location.href = PAGINA_ANTEPRIMA + '?id=' + encodeURIComponent(id);
          return;
        }

        if (dati && (dati.status === 'error' || dati.status === 'not_found')) {
          fermaPolling();
          mostraFallimento(new Error(
            (dati && dati.errore) ||
            'La generazione non è andata a buon fine.'
          ));
          return;
        }

        riprova(id);
      })
      .catch(function () {
        // Rete instabile: non è un fallimento della generazione, che intanto
        // prosegue sul server. Si riprova e basta.
        riprova(id);
      });
  }

  function riprova(id) {
    if (Date.now() - pollingInizio >= POLLING_MAX_MS) {
      fermaPolling();
      mostraRipiegoEmail();
      return;
    }

    pollingTimer = window.setTimeout(function () { chiediStato(id); }, POLLING_MS);
  }

  function fermaPolling() {
    if (pollingTimer) window.clearTimeout(pollingTimer);
    if (elapsedTimer) window.clearInterval(elapsedTimer);
    pollingTimer = null;
    elapsedTimer = null;
  }

  /** Contatore discreto: senza, un'attesa di due minuti sembra un blocco. */
  function avviaCronometro() {
    var elapsed = document.getElementById('wizard-elapsed');
    if (!elapsed) return;

    var aggiorna = function () {
      var secondi = Math.floor((Date.now() - pollingInizio) / 1000);
      var min = Math.floor(secondi / 60);
      var sec = secondi % 60;
      elapsed.textContent = min > 0
        ? 'In lavorazione da ' + min + ' min ' + (sec < 10 ? '0' : '') + sec + ' s'
        : 'In lavorazione da ' + sec + ' s';
    };

    aggiorna();
    elapsedTimer = window.setInterval(aggiorna, 1000);
  }

  /**
   * Oltre il tempo massimo: la generazione può ancora andare a buon fine, ma
   * non ha senso tenere qualcuno davanti a uno spinner. Si passa la parola
   * all'email, che è esattamente il ruolo che le abbiamo dato.
   */
  function mostraRipiegoEmail() {
    if (pendingBox) pendingBox.hidden = true;

    if (successBox) {
      successBox.hidden = false;
      var titolo = successBox.querySelector('.wizard__success-title');
      if (titolo) {
        titolo.setAttribute('tabindex', '-1');
        titolo.focus({ preventScroll: true });
      }
    }

    annuncia('Ci sta mettendo più del previsto. Riceverai il link via email.');
    attesaInCorso = false;
  }

  function mostraFallimento(errore) {
    fermaPolling();
    if (pendingBox) pendingBox.hidden = true;

    if (failureText && errore && errore.message) {
      failureText.textContent = errore.message +
        ' I dati che hai inserito sono ancora qui.';
    }

    if (failureBox) {
      failureBox.hidden = false;
      var titolo = failureBox.querySelector('.wizard__failure-title');
      if (titolo) {
        titolo.setAttribute('tabindex', '-1');
        titolo.focus({ preventScroll: true });
      }
    }

    annuncia('Invio non riuscito.');
    attesaInCorso = false;
  }

  // "Riprova" rimette in piedi il modulo con i dati ancora dentro, all'ultimo
  // passaggio: l'utente deve solo ripremere il pulsante.
  if (retryBtn) {
    retryBtn.addEventListener('click', function () {
      if (failureBox) failureBox.hidden = true;
      form.hidden = false;
      mostraStep(steps.length - 1);
    });
  }

  /* ======================================================================
     AVVIO
     ====================================================================== */

  // Da qui in poi il CSS può nascondere gli step: prima di questa riga il
  // modulo era tutto visibile, quindi chi non ha JS non resta bloccato.
  form.classList.add('wizard--on');
  mostraStep(0, { sposta: false });

}());
