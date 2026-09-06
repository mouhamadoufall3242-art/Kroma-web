/* =============================================================================
   email.js — invio del link al cliente
   -----------------------------------------------------------------------------
   STATO: la struttura della chiamata a Resend è completa. Finché
   env.RESEND_API_KEY non è impostata la funzione non invia nulla e si limita a
   scrivere nel log cosa avrebbe spedito.
       npx wrangler secret put RESEND_API_KEY

   Prima di attivarla serve un dominio verificato su Resend, altrimenti le email
   partono ma finiscono nello spam. La verifica è una voce DNS da aggiungere.
   ========================================================================== */

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Manda al cliente il link della sua anteprima.
 *
 * @param {string} email        destinatario
 * @param {string} previewLink  URL completo dell'anteprima
 * @param {object} env          ambiente del Worker
 * @returns {Promise<{inviata: boolean, simulata: boolean}>}
 */
export async function sendEmailToClient(email, previewLink, env) {
  const apiKey = env.RESEND_API_KEY;

  const messaggio = {
    from: env.EMAIL_FROM || 'Kroma <onboarding@resend.dev>',
    to: [email],
    reply_to: env.EMAIL_REPLY_TO || 'kroma.site@gmail.com',
    subject: 'La tua anteprima Kroma è pronta',
    html: corpoHtml(previewLink),
    text: corpoTesto(previewLink)
  };

  if (!apiKey) {
    console.log('[email] nessuna RESEND_API_KEY: invio simulato a', email, '→', previewLink);
    return { inviata: false, simulata: true };
  }

  const risposta = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(messaggio)
  });

  if (!risposta.ok) {
    const dettaglio = await risposta.text().catch(() => '');
    console.error('[email] invio fallito', risposta.status, dettaglio.slice(0, 200));
    throw new Error(`Resend ha risposto ${risposta.status}`);
  }

  return { inviata: true, simulata: false };
}

/* -----------------------------------------------------------------------------
   Corpo del messaggio
   -----------------------------------------------------------------------------
   Tabelle e stili inline: è ancora il modo più affidabile di far rendere una
   email allo stesso modo su Gmail, Outlook e client mobili.
   -------------------------------------------------------------------------- */

function corpoHtml(link) {
  return `<!DOCTYPE html>
<html lang="it">
<body style="margin:0;padding:0;background:#f4f4f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:12px;padding:36px;font-family:Arial,Helvetica,sans-serif;">
        <tr><td>
          <p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:#1a1a1a;">Kroma</p>

          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1a1a1a;">
            La tua anteprima è pronta.
          </h1>

          <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#555;">
            Abbiamo costruito la home page della tua attività a partire da quello che
            ci hai raccontato. Guardala con calma: non c'è nessun impegno.
          </p>

          <p style="margin:0 0 28px;">
            <a href="${link}"
               style="display:inline-block;background:#FFB020;color:#040613;text-decoration:none;
                      font-weight:bold;font-size:15px;padding:14px 28px;border-radius:999px;">
              Guarda la tua anteprima
            </a>
          </p>

          <p style="margin:0 0 8px;font-size:13px;color:#888;">
            Se il pulsante non funziona, copia questo indirizzo nel browser:
          </p>
          <p style="margin:0 0 28px;font-size:13px;color:#888;word-break:break-all;">${link}</p>

          <hr style="border:none;border-top:1px solid #eee;margin:0 0 20px;">

          <p style="margin:0;font-size:12px;line-height:1.6;color:#999;">
            Hai ricevuto questa email perché hai richiesto un'anteprima su kroma.it.
            Se non sei stato tu, ignorala pure: il link scade da solo.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function corpoTesto(link) {
  return [
    'La tua anteprima Kroma è pronta.',
    '',
    'Abbiamo costruito la home page della tua attività a partire da quello che ci hai',
    "raccontato. Guardala con calma: non c'è nessun impegno.",
    '',
    link,
    '',
    "Hai ricevuto questa email perché hai richiesto un'anteprima su kroma.it.",
    'Se non sei stato tu, ignorala pure: il link scade da solo.'
  ].join('\n');
}
