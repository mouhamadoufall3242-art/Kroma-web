# Kroma

Sito e backend dell'agenzia. Un solo Cloudflare Worker serve sia le pagine
statiche sia le API.

```
kroma/
├─ wrangler.toml          config del Worker: assets, binding KV, variabili
├─ package.json
├─ .env.example           tutte le chiavi necessarie (copia in .dev.vars)
├─ public/                sito statico
│  ├─ index.html          home + generatore a wizard
│  ├─ preview.html        anteprima con blur + paywall
│  ├─ grazie.html         conferma dopo il pagamento
│  ├─ billing.html        area clienti → portale Stripe
│  ├─ style.css
│  ├─ main.js             wizard + polling
│  └─ preview.js          carica e mostra il sito generato
└─ src/
   ├─ index.js            router e orchestrazione
   └─ lib/
      ├─ http.js          risposte JSON, CORS, HttpError
      ├─ validate.js      controllo del payload
      ├─ ratelimit.js     freno per IP
      ├─ anthropic.js     callAnthropicAPI()
      ├─ storage.js       anteprime su KV
      ├─ email.js         sendEmailToClient()
      ├─ notify.js        notifyAdminOnFailure()
      └─ stripe.js        pacchetti, sessione di checkout, firma webhook
```

## Avvio

```bash
npm install

# 1. Crea i namespace KV e incolla gli id stampati in wrangler.toml
npm run kv:create

# 2. Segreti in locale
cp .env.example .dev.vars   # poi riempi i valori

# 3. Sviluppo su http://localhost:8787
npm run dev
```

Le chiavi necessarie sono documentate una per una in **`.env.example`**.

Senza chiavi API il flusso gira lo stesso: `callAnthropicAPI` restituisce una
pagina segnaposto e `sendEmailToClient` scrive nel log invece di spedire. Serve
proprio per provare tutto il percorso a costo zero.

## Pubblicazione

```bash
npm run secrets         # carica le quattro chiavi (una alla volta, cifrate)
npm run deploy:worker   # pubblica il Worker
npm run tail:vendite    # resta in ascolto degli incassi
```

### Un Worker solo, non Pages + Worker

Oggi **un unico Worker** serve sia le pagine (`public/`, tramite `[assets]`) sia
le API. Il front-end chiama `/api/...` con percorsi relativi, quindi sito e API
sono sulla stessa origine: niente CORS, niente URL assolute, un solo deploy.

Se invece si mettesse il front-end su Cloudflare Pages e le API su un Worker
separato, le due parti finirebbero su origini diverse (`kroma.pages.dev` e
`kroma.workers.dev`) e **`fetch('/api/generate')` smetterebbe di funzionare**:
su Pages quell'indirizzo non esiste.

Per il deploy automatico da GitHub non serve Pages: i Worker hanno la stessa
funzione (**Workers Builds**), si collega il repository dal pannello e ogni push
su `main` ripubblica tutto — pagine comprese.

### Se proprio serve dividerli

Due modi, in ordine di preferenza:

1. **Stesso dominio, due servizi.** Pages su `kroma.it`, Worker su una route
   `kroma.it/api/*`. Resta tutto sulla stessa origine e il codice non cambia.
   Richiede il dominio su Cloudflare.
2. **Origini diverse.** Va tolto `[assets]` da `wrangler.toml` e va detto al
   front-end dove sono le API, aggiungendo questa riga negli `<head>` delle tre
   pagine **prima** degli script:

   ```html
   <script>window.KROMA_API_BASE = 'https://kroma.tuo-account.workers.dev';</script>
   ```

   `main.js` e `preview.js` la leggono già; il CORS del Worker accetta già
   `*.pages.dev`. Costa una richiesta preflight in più per ogni chiamata.

## API

| Metodo | Rotta | Cosa fa |
|---|---|---|
| POST | `/api/generate` | Accetta `{stile, prompt, email}`, risponde **202** con un `id` e accoda la generazione |
| GET | `/api/preview/:id` | **JSON**: `{status, html?}` — lo interrogano il polling e `preview.html` |
| POST | `/api/checkout` | Riceve `{preview_id, package_type}`, apre il pagamento, risponde `{url}` |
| POST | `/api/webhooks/stripe` | Conferme di pagamento. **Accetta solo chiamate firmate** |
| GET | `/api/health` | Controllo di stato |

> `/api/preview/:id` restituisce JSON, non una pagina. L'indirizzo per un essere
> umano — quello che finisce nell'email — è **`/preview.html?id=<id>`**.

### Il ciclo completo

```
index.html   POST /api/generate ──▶ 202 {id}
     │
     │  polling GET /api/preview/:id  ogni 5s (max 5 min)
     │       status pending ──▶ continua
     │       status success ──▶ redirect a preview.html?id=
     │       status error   ──▶ schermata di errore
     │       oltre 5 min    ──▶ "ti arriva via email", si chiude la pagina
     ▼
preview.html?id=  GET /api/preview/:id  ──▶ srcdoc dell'iframe
```

L'email resta la rete di sicurezza per chi chiude la scheda: la generazione va
avanti sul server comunque.

### Perché 202 e non 200

Generare una pagina richiede decine di secondi. Il front-end però promette
"email tra 15 minuti": non deve restare appeso, e una connessione mobile che
cade non deve buttare via una generazione già pagata.

`/api/generate` fa solo le cose veloci — valida, crea l'id, scrive il record in
KV — e risponde subito. Il lavoro lento prosegue in `ctx.waitUntil()`, che tiene
vivo il Worker dopo che la risposta è partita.

### Stati di un'anteprima

`pending` → `success` oppure `error`. Sono un contratto pubblico: il polling li
legge così come sono. Il record nasce prima della risposta, così il link è valido
da subito e chi lo apre troppo presto non trova un 404.

### Il sito generato gira in un iframe isolato

`preview.js` non inietta l'HTML del modello nella pagina: lo passa a un iframe
con `srcdoc` e `sandbox="allow-popups"` (senza `allow-same-origin`). Due motivi:

1. È un documento completo — dentro un `div` il browser scarta `html`, `head` e
   `body` e restano i contenuti spaiati.
2. Con `innerHTML` quel codice girerebbe sull'origine di kroma.it. Un `<script>`
   finito lì dentro avrebbe accesso a tutto il resto della pagina.

Verificato con un test: uno script dentro l'anteprima che prova a scrivere su
`window.parent` non ci riesce.

Conseguenza: l'altezza reale del documento nell'iframe non è leggibile, quindi
quanto sito resta a fuoco lo decidiamo noi (`--fascia-a-fuoco` in `style.css`,
620px su desktop, 420px su mobile). Per una pagina a pagamento è comunque la
scelta giusta.

## Checkout — due regole da non violare

**1. Gli importi stanno sul server.** Il browser manda solo `package_type`
(`codice` o `abbonamento`); i prezzi sono in `PACCHETTI` dentro
`src/lib/stripe.js`. Se il prezzo arrivasse dalla richiesta, chiunque potrebbe
aprire la console e comprare il pacchetto da 290€ per un centesimo. Un test
verifica che un `prezzo: 1` iniettato nel payload venga ignorato.

**2. Il webhook accetta solo chiamate firmate.** `/api/webhooks/stripe` è
pubblico: senza verifica della firma, un POST fatto a mano con scritto "pagato"
attiverebbe un abbonamento gratis. La verifica è HMAC-SHA256 su
`timestamp.corpo_grezzo`, con finestra di 5 minuti contro il replay e confronto
a tempo costante.

Senza `STRIPE_WEBHOOK_SECRET` l'endpoint **rifiuta tutto con 503**. È voluto:
accettare "in attesa di configurare" significa tenere aperta una porta che regala
pacchetti.

Il ritorno del browser su `success_url` non è una prova di pagamento — quella URL
può aprirla chiunque. Solo il webhook lo è.

### Dopo il pagamento: si ferma l'automazione, parte una persona

Il webhook **non** genera zip né compra domini. Registra l'incasso e chiama il
titolare — è il modello di Kroma: tutto automatico fino all'incasso, poi
interviene una persona.

`notifyAdminOnSuccess` (in `src/lib/notify.js`) manda una **email a
kroma.site@gmail.com** con email cliente, pacchetto, importi, link diretto
all'anteprima, id ordine e i tre passi successivi. L'oggetto porta già pacchetto
e importo, così si capisce cosa è successo dalla lista dei messaggi:

```
💰 Nuovo ordine Kroma — Pacchetto All-Inclusive (90,00 € + 29,00 €/mese)
🚨 SOS Kroma — generazione fallita (j3mq8vzt5lkc)
```

**Il log resta comunque**, e viene scritto *prima* di tentare l'invio: se Resend
è giù o il dominio non è ancora verificato, l'informazione non si perde
(`npm run tail:vendite`, `npm run tail:errori`).

Nessuna delle due funzioni lancia mai. `notifyAdminOnFailure` vive dentro un
`catch` e nasconderebbe l'errore originale; `notifyAdminOnSuccess` è chiamata dal
webhook, e un'eccezione lì impedirebbe il 200 a Stripe, che rimanderebbe
l'evento all'infinito.

> Perché le email arrivino davvero serve il **dominio verificato in Resend**
> (voci DNS). Senza, l'API accetta la chiamata ma i messaggi finiscono nello
> spam — o non partono affatto se `EMAIL_FROM` è su un dominio non tuo.

**Idempotenza, doppia rete.** Stripe rimanda lo stesso evento finché non riceve
un 2xx, e a volte anche dopo:

1. `evento:<id>` in KV (30 giorni) — l'evento già visto viene saltato;
2. `ordine.stato !== 'pagato'` — copre anche il caso di due consegne
   ravvicinate che si infilano entrambe nel primo controllo, visto che KV è a
   consistenza eventuale.

Senza, riceveresti due avvisi per lo stesso incasso e apriresti due volte la
stessa pratica.

**Incassi orfani.** Se un pagamento arriva senza i nostri metadata, o con un
ordine assente in KV, il titolare viene avvisato lo stesso, con la dicitura
`DA VERIFICARE`. Un incasso reale che resta senza nessuno che lo lavora è
peggio di un avviso incompleto.

### Cosa manca prima di incassare davvero

1. Creare i tre prezzi nel pannello Stripe e incollare gli id in `wrangler.toml`
   (`STRIPE_PRICE_CODICE`, `STRIPE_PRICE_ABBONAMENTO`, `STRIPE_PRICE_ATTIVAZIONE`).
2. `npx wrangler secret put STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET`.
3. Registrare l'endpoint webhook nel pannello Stripe.
4. Eventi del ciclo di vita dell'abbonamento, non ancora gestiti (servono dal
   secondo mese in poi): `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.deleted`.
5. Verificare il dominio in Resend: senza, gli avvisi di vendita non arrivano in
   casella e restano solo nei log.
6. **Attivare il Portale clienti Stripe** e incollare il link in `billing.html`
   (cerca `TODO STRIPE`). Serve il *link di accesso* statico, quello valido per
   tutti i clienti — Stripe → Impostazioni → Fatturazione → Portale clienti →
   "Condividi il link", nella forma `https://billing.stripe.com/p/login/…`.
   Non il link di una singola sessione, che scade e vale per un cliente solo.

   Nelle impostazioni del portale vanno abilitate le voci che la pagina promette:
   fatture, metodo di pagamento e **disdetta**. Se la disdetta resta disattivata,
   `billing.html` promette una cosa che il portale non permette di fare.

## Da sistemare prima di andare in produzione

- **Il rate limit su KV è approssimativo.** KV è a consistenza eventuale: un
  attacco distribuito passa oltre il tetto. Per fare sul serio serve il binding
  Rate Limiting di Cloudflare o un Durable Object.
- **Nessun ritentativo.** Se Anthropic risponde 529 (sovraccarico), la richiesta
  è persa. Cloudflare Queues risolve il problema mantenendo questa struttura.
- **L'SOS al titolare è ancora solo un log.** `notifyAdminOnFailure` scrive una
  riga `KROMA-SOS` (si trova con `npx wrangler tail`). Per riceverlo in casella
  basta togliere il commento in fondo a `src/lib/notify.js` — ma finché resta
  così, qualcuno deve guardare i log.
- **Il dominio Resend va verificato** con una voce DNS, altrimenti le email
  partono ma finiscono nello spam.
- **Il polling non regge una scheda in sottofondo.** I browser rallentano i timer
  nelle schede non attive: chi cambia scheda vedrà il redirect in ritardo.
  L'email copre il caso, ma `visibilitychange` lo risolverebbe meglio.
- Manca il checkout dei due pacchetti (`#acquisto-codice`, `#acquisto-abbonamento`).
- Manca la P.IVA nel footer e la pagina privacy.
