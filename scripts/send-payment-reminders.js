// Automatische Zahlungserinnerung für FSV Shop System v2.18
// Läuft über GitHub Actions täglich und sendet für unbezahlte Bestellungen nach 3 Tagen eine Erinnerung.

const SUPABASE_URL = "https://ibhtvjaawinpcwvbwzct.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_omPVDjNvHQ5SULxKhJQqUA_-rCJ0PL3";

const EMAILJS_PUBLIC_KEY = "4gRqrmu7JPDzAYBFo";
const EMAILJS_SERVICE_ID = "service_wpky3om";
const EMAILJS_TEMPLATE_ID = "template_vsim3m6";

const REPLY_TO_EMAIL = "kassierer@fsv-nieder-olm.de";

function euro(n) {
  return Number(n || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
}

function orderNo(o) {
  return o.order_id || o.bestellnummer || String(o.id || "");
}

function customerName(o) {
  return `${o.vorname || ""} ${o.nachname || ""}`.trim();
}

async function supabaseFetch(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function sendEmail(order) {
  const nr = orderNo(order);
  const name = customerName(order);
  const message = `Zahlungserinnerung zu deiner Bestellung ${nr}

Hallo ${name || "liebes Vereinsmitglied"},

zu deiner Bestellung im digitalen Bestellformular des FSV Nieder-Olm ist bisher noch kein Zahlungseingang vermerkt.

Bitte überweise den offenen Betrag oder zahle per PayPal, damit die Bestellung weiterbearbeitet werden kann.

Bestellnummer: ${nr}
Gesamtbetrag: ${euro(order.gesamtbetrag)}

PayPal: @FSVNO
Banküberweisung:
Volksbank Darmstadt Mainz
IBAN: DE37 5519 0000 0037 6010 10

Verwendungszweck: ${nr} / ${name}

Bestelldetails:
${order.bestellung || ""}

Viele Grüße
FSV Nieder-Olm`;

  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: {
        to_email: order.email,
        reply_to: REPLY_TO_EMAIL,
        subject: `Zahlungserinnerung - Bestellung ${nr}`,
        order_id: nr,
        bestellnummer: nr,
        customer_name: name,
        customer_email: order.email,
        vorname: order.vorname || "",
        nachname: order.nachname || "",
        email: order.email || "",
        telefon: order.telefon || "",
        message
      }
    })
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`EmailJS ${response.status}: ${body}`);
}

async function main() {
  const threshold = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const select = "id,created_at,verein,order_id,bestellnummer,mannschaft,vorname,nachname,email,telefon,bezahlt,gesamtbetrag,bestellung,zahlungserinnerung_gesendet";
  const query = `/rest/v1/orders?select=${select}&bezahlt=neq.ja&created_at=lte.${encodeURIComponent(threshold)}&or=(zahlungserinnerung_gesendet.is.null,zahlungserinnerung_gesendet.eq.false)&order=created_at.asc`;
  const orders = await supabaseFetch(query);

  console.log(`Gefundene offene Bestellungen für Zahlungserinnerung: ${orders.length}`);

  for (const order of orders) {
    if (!order.email) {
      console.log(`Übersprungen ohne E-Mail: ${orderNo(order)}`);
      continue;
    }

    console.log(`Sende Zahlungserinnerung: ${orderNo(order)} -> ${order.email}`);
    await sendEmail(order);

    await supabaseFetch(`/rest/v1/orders?id=eq.${order.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        zahlungserinnerung_gesendet: true,
        zahlungserinnerung_gesendet_am: new Date().toISOString()
      })
    });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
