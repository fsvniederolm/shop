import { chromium } from "playwright";

const required = ["DFBNET_USERNAME","DFBNET_PASSWORD","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY"];
for (const k of required) if (!process.env[k]) throw new Error(`GitHub Secret ${k} fehlt.`);

const USER = process.env.DFBNET_USERNAME;
const PASS = process.env.DFBNET_PASSWORD;
const LOGIN_URL = process.env.DFBNET_LOGIN_URL || "https://www.dfbnet.org/spielplus/login.do?submit=Anmelden";
const SB_URL = process.env.SUPABASE_URL.replace(/\/$/,"");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json"
};

const PLACES = [
  {name:"Nieder-Olm Kleinfeld KR", number:"4200110275"},
  {name:"Nieder-Olm KR",           number:"4200110274"},
  {name:"Nieder-Olm RA",           number:"4200110271"}
];

const norm = s => String(s ?? "").replace(/\s+/g," ").trim();
const deToIso = s => {
  const m = norm(s).match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const hhmm = s => {
  const m = norm(s).match(/\b(\d{1,2}):(\d{2})\b/);
  return m ? `${m[1].padStart(2,"0")}:${m[2]}:00` : null;
};

async function login(page) {
  const loginUrl = process.env.DFBNET_LOGIN_URL ||
    "https://www.dfbnet.org/spielplus/login.do?submit=Anmelden";

  console.log("DFBnet SpielPLUS öffnen …");
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // SpielPLUS-Startseite: der Button "ANMELDEN" leitet zum zentralen DFB-SSO weiter.
  const entryButton = page.getByRole("button", { name: /anmelden/i })
    .or(page.getByRole("link", { name: /anmelden/i }));
  if (await entryButton.count()) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      entryButton.first().click()
    ]);
  }

  // DFB SSO (auth.dfbnet.org / Keycloak)
  await page.waitForURL(/auth\.dfbnet\.org|dfbnet\.org/, { timeout: 30000 }).catch(() => {});

  const user = page.locator(
    'input[name="username"], input[id="username"], input[autocomplete="username"], input[placeholder*="Benutzer"], input[placeholder*="Kennung"]'
  ).first();
  const pass = page.locator(
    'input[name="password"], input[id="password"], input[type="password"], input[autocomplete="current-password"]'
  ).first();

  await user.waitFor({ state: "visible", timeout: 30000 });
  await pass.waitFor({ state: "visible", timeout: 30000 });
  await user.fill(process.env.DFBNET_USERNAME);
  await pass.fill(process.env.DFBNET_PASSWORD);

  const submit = page.getByRole("button", { name: /^anmelden$/i })
    .or(page.locator('button[type="submit"], input[type="submit"]'));
  await submit.first().click();

  // Nach erfolgreichem SSO zurück nach SpielPLUS warten.
  await page.waitForURL(url => !url.hostname.includes("auth.dfbnet.org"), { timeout: 60000 });
  await page.waitForLoadState("domcontentloaded");
  console.log("DFBnet-Anmeldung abgeschlossen:", page.url());
}

async function openVenues(page) {
  const link = page.getByText("Spielstätten", {exact:true}).first();
  await link.waitFor({state:"visible", timeout:30000});
  await link.click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);
}

async function openVenue(page, place) {
  // Falls wir aus einer Detailansicht kommen, zuerst zurück zur Spielstättenliste.
  const listLink = page.getByText(/spielstättenliste/i).first();
  if (await listLink.count() && await listLink.isVisible().catch(()=>false)) {
    await listLink.click();
    await page.waitForTimeout(1000);
  }

  const row = page.locator("tr").filter({hasText:place.number}).first();
  await row.waitFor({state:"visible", timeout:30000});

  // DFBnet nutzt vor der Spielstätte ein Stift-/Bearbeiten-Icon.
  const action = row.locator('a,button,[role="button"]').first();
  await action.click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(900);

  const tab = page.getByText("Spielstättenbelegung", {exact:true}).first();
  if (await tab.count() && await tab.isVisible().catch(()=>false)) {
    await tab.click();
    await page.waitForTimeout(900);
  }
}

async function extractRows(page, place) {
  // Wir suchen Tabellenzeilen, die wie DFBnet-Spiele aussehen:
  // Datum + zwei Uhrzeiten + Spielkennung (mind. 7 Ziffern).
  const rows = page.locator("tr");
  const n = await rows.count();
  const result = [];

  for (let i=0;i<n;i++) {
    const row = rows.nth(i);
    const cells = row.locator("td");
    const c = await cells.count();
    if (c < 7) continue;

    const vals = [];
    for (let j=0;j<c;j++) vals.push(norm(await cells.nth(j).innerText().catch(()=>'')));
    const joined = vals.join(" | ");
    const date = deToIso(joined);
    const times = [...joined.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m=>m[1]);
    const kennungMatch = joined.match(/\b(\d{7,10})\b/);
    if (!date || times.length < 1 || !kennungMatch) continue;

    // Aus dem Screenshot: nach WT folgen Kennung, Liga, Heim, Gast.
    // Statt feste td-Indizes zu erzwingen, suchen wir Kennung und nehmen die Folgefelder.
    const kIndex = vals.findIndex(v => v.includes(kennungMatch[1]));
    const liga = kIndex >= 0 ? vals[kIndex+1] || null : null;
    const heim = kIndex >= 0 ? vals[kIndex+2] || null : null;
    const gast = kIndex >= 0 ? vals[kIndex+3] || null : null;

    result.push({
      source:"dfbnet",
      spielstaette:place.name,
      spielstaette_nummer:place.number,
      datum:date,
      anstoss:hhmm(times[0]),
      ende_dfbnet:times[1] ? hhmm(times[1]) : null,
      kennung:kennungMatch[1],
      liga, heim, gast,
      status: vals.at(-1) || null,
      synced_at:new Date().toISOString()
    });
  }

  // Kennung pro Spiel eindeutig halten.
  return [...new Map(result.map(x=>[`${x.spielstaette_nummer}:${x.kennung}`,x])).values()];
}

async function syncPlace(place, games) {
  // Erst nach erfolgreichem Auslesen ersetzen. Bei Scraperfehlern bleiben alte Daten erhalten.
  const delUrl = `${SB_URL}/rest/v1/spielstaetten_belegung?source=eq.dfbnet&spielstaette_nummer=eq.${encodeURIComponent(place.number)}`;
  const del = await fetch(delUrl, {method:"DELETE", headers:sbHeaders});
  if (!del.ok) throw new Error(`Supabase DELETE ${del.status}: ${await del.text()}`);

  if (games.length) {
    const ins = await fetch(`${SB_URL}/rest/v1/spielstaetten_belegung`, {
      method:"POST",
      headers:{...sbHeaders, Prefer:"return=minimal"},
      body:JSON.stringify(games)
    });
    if (!ins.ok) throw new Error(`Supabase INSERT ${ins.status}: ${await ins.text()}`);
  }
  console.log(`${place.name}: ${games.length} Spiele synchronisiert`);
}

const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1100}});
try {
  await login(page);
  await openVenues(page);

  for (const place of PLACES) {
    await openVenue(page, place);
    const games = await extractRows(page, place);
    if (!games.length) {
      // Sicherheitsbremse: bei Layout-/Loginfehlern niemals vorhandene DB-Daten leeren.
      throw new Error(`${place.name}: Keine Spiele gefunden. Sync abgebrochen, bestehende DB-Daten bleiben erhalten.`);
    }
    await syncPlace(place, games);
  }
} catch (e) {
  console.error(e);
  await page.screenshot({path:"dfbnet-sync-error.png", fullPage:true}).catch(()=>{});
  process.exitCode = 1;
} finally {
  await browser.close();
}
