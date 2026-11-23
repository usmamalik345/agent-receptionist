/**
 * One-off WhatsApp demo UI walk — Playwright, real /whatsapp-demo page.
 * Does NOT call processGuestMessage; drives the UI like a guest.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://[::1]:5173";
const WA_URL = `${BASE}/whatsapp-demo`;
const DASH_URL = `${BASE}/dashboard`;
const SHOTS = path.join(__dirname, "_wa-shots");
const DOCS_SHOTS = path.join(process.env.USERPROFILE || "", "Documents", "erth-wa-shots");
const OUT_JSON = path.join(__dirname, "_wa-ui-results.json");

type TurnResult = {
  session: string;
  guestText: string;
  botReply: string;
  pass: boolean;
  notes: string;
  screenshot: string;
  docsCopy?: string;
};

type SessionResult = {
  id: string;
  name: string;
  turns: TurnResult[];
  pass: boolean;
  notes: string;
  screenshots: string[];
};

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(DOCS_SHOTS, { recursive: true });

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^\w\u0600-\u06FF]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "shot";
}

async function getBotTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".flex.justify-start"));
    const out: string[] = [];
    for (const row of rows) {
      // Skip typing indicator (dots only)
      if (row.querySelector('[style*="typing-dot"], .w-1\\.5')) continue;
      const bubble = row.querySelector("div.rounded-lg, div[class*='rounded-lg']");
      if (!bubble) continue;
      // Clone and strip timestamp line
      const clone = bubble.cloneNode(true) as HTMLElement;
      const time = clone.querySelector(".text-\\[10px\\], [class*='text-[10px]']");
      // Prefer: take full text and drop last line if it looks like a time
      const raw = (bubble as HTMLElement).innerText || "";
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;
      // Drop trailing time like "5:47 PM"
      if (lines.length > 1 && /^\d{1,2}:\d{2}/.test(lines[lines.length - 1])) {
        lines.pop();
      }
      // Also skip pure typing / empty
      const text = lines.join("\n").trim();
      if (!text) continue;
      // Skip if only dots / no letters
      if (!/[A-Za-z\u0600-\u06FF]/.test(text)) continue;
      out.push(text);
    }
    return out;
  });
}

async function getGuestTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".flex.justify-end"));
    const out: string[] = [];
    for (const row of rows) {
      const bubble = row.querySelector("div.rounded-lg, div[class*='rounded-lg']");
      if (!bubble) continue;
      const raw = (bubble as HTMLElement).innerText || "";
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1 && /^\d{1,2}:\d{2}/.test(lines[lines.length - 1])) lines.pop();
      const text = lines.join("\n").trim();
      if (text) out.push(text);
    }
    return out;
  });
}

async function waitForNewBot(page: Page, prevCount: number, timeoutMs = 20000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Wait until typing indicator is gone AND bot count increased
    const typing = await page.locator(".flex.justify-start .w-1\\.5").count().catch(() => 0);
    const bots = await getBotTexts(page);
    if (bots.length > prevCount && typing === 0) {
      return bots[bots.length - 1] || "";
    }
    await page.waitForTimeout(200);
  }
  const bots = await getBotTexts(page);
  if (bots.length > prevCount) return bots[bots.length - 1] || "";
  return "";
}

async function screenshot(page: Page, name: string): Promise<{ local: string; docs: string }> {
  const file = `${name}.png`;
  const local = path.join(SHOTS, file);
  const docs = path.join(DOCS_SHOTS, file);
  await page.screenshot({ path: local, fullPage: true });
  try {
    fs.copyFileSync(local, docs);
  } catch (e) {
    // ignore copy failures
  }
  return { local, docs };
}

async function startChat(page: Page): Promise<{ greeting: string; notes: string }> {
  await page.goto(WA_URL, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(500);

  const cta = page.getByRole("button", { name: /Start chat with reservations AI/i });
  const ctaVisible = await cta.isVisible().catch(() => false);
  let notes = "";
  if (ctaVisible) {
    await cta.click();
    notes = "Clicked CTA Start chat with reservations AI";
  } else {
    notes = "CTA not visible — may already have messages or chips path";
  }

  const greeting = await waitForNewBot(page, 0, 15000);
  return { greeting, notes };
}

async function sendGuest(page: Page, text: string): Promise<string> {
  const prev = (await getBotTexts(page)).length;
  const input = page.locator('input[placeholder="Type a message"], input[placeholder*="message"], input.flex-1').first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.click();
  await input.fill(text);
  // Prefer Enter; also click Send if present
  const sendBtn = page.getByRole("button", { name: "Send" });
  const sendVisible = await sendBtn.isVisible().catch(() => false);
  if (sendVisible) {
    // After fill, send icon should appear (not mic)
    await sendBtn.click();
  } else {
    await input.press("Enter");
  }
  return waitForNewBot(page, prev, 20000);
}

async function runBookingSession(browser: Browser): Promise<{
  session: SessionResult;
  dashboardShot?: string;
  dashboardDocs?: string;
  notifyText?: string;
  ticketsText?: string;
}> {
  const context = await browser.newContext({
    viewport: { width: 420, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();
  const turns: TurnResult[] = [];
  const screenshots: string[] = [];
  let notes = "";

  const { greeting, notes: startNotes } = await startChat(page);
  notes += startNotes + "; ";
  const gShot = await screenshot(page, "01-booking-greeting");
  screenshots.push(gShot.local);
  turns.push({
    session: "booking",
    guestText: "(CTA start)",
    botReply: greeting || "(empty)",
    pass: !!greeting && greeting.length > 5,
    notes: greeting ? "Greeting received" : "FAIL: no greeting bubble",
    screenshot: gShot.local,
    docsCopy: gShot.docs,
  });

  const messages = [
    "Room pls",
    "15 oct to 18 oct",
    "2 adults 1 kid",
    "Maya Khan",
    "+971501234567",
    "none",
    "yes",
  ];

  let i = 2;
  for (const msg of messages) {
    const bot = await sendGuest(page, msg);
    const shot = await screenshot(page, `${String(i).padStart(2, "0")}-booking-${slug(msg)}`);
    screenshots.push(shot.local);
    const empty = !bot || bot.trim().length < 2;
    turns.push({
      session: "booking",
      guestText: msg,
      botReply: bot || "(empty)",
      pass: !empty,
      notes: empty ? "FAIL: empty or missing bot reply" : "ok",
      screenshot: shot.local,
      docsCopy: shot.docs,
    });
    i++;
  }

  // Optional dashboard check in same SPA (shared localStorage)
  let dashboardShot: string | undefined;
  let dashboardDocs: string | undefined;
  let notifyText: string | undefined;
  let ticketsText: string | undefined;
  try {
    await page.goto(DASH_URL, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(800);
    const dash = await screenshot(page, "09-dashboard-after-booking");
    dashboardShot = dash.local;
    dashboardDocs = dash.docs;
    screenshots.push(dash.local);

    notifyText = await page.evaluate(() => {
      const h = Array.from(document.querySelectorAll("h2")).find((el) =>
        /Notify desk/i.test(el.textContent || ""),
      );
      if (!h) return "";
      const card = h.parentElement;
      return (card?.innerText || "").slice(0, 800);
    });
    ticketsText = await page.evaluate(() => {
      const h = Array.from(document.querySelectorAll("h2, h3, div")).find((el) =>
        /Staff queue/i.test(el.textContent || ""),
      );
      if (!h) return "";
      // climb a bit
      let el: HTMLElement | null = h as HTMLElement;
      for (let k = 0; k < 4 && el; k++) el = el.parentElement;
      return (el?.innerText || "").slice(0, 800);
    });
    notes += `Dashboard opened; notifyLen=${(notifyText || "").length}; ticketsLen=${(ticketsText || "").length}; `;
  } catch (e) {
    notes += `Dashboard check error: ${String(e)}; `;
  }

  const allPass = turns.every((t) => t.pass);
  // Booking success heuristic: last bot mentions confirm / booked / reference / thank / reservation
  const lastBot = (turns[turns.length - 1]?.botReply || "").toLowerCase();
  const looksConfirmed = /confirm|booked|reservation|thank|reference|ref\.|saved|notified|desk/i.test(lastBot);
  const sessionPass = allPass && looksConfirmed;

  await context.close();
  return {
    session: {
      id: "booking",
      name: "Full booking walk (7 turns + greeting)",
      turns,
      pass: sessionPass,
      notes: notes + (looksConfirmed ? "Last reply looks like confirm." : "WARN: last reply may not confirm booking."),
      screenshots,
    },
    dashboardShot,
    dashboardDocs,
    notifyText,
    ticketsText,
  };
}

async function runShortSession(
  browser: Browser,
  id: string,
  name: string,
  message: string,
  shotPrefix: string,
): Promise<SessionResult> {
  const context = await browser.newContext({
    viewport: { width: 420, height: 900 },
    locale: "en-US",
  });
  // Fresh context = fresh localStorage
  const page = await context.newPage();
  const turns: TurnResult[] = [];
  const screenshots: string[] = [];

  const { greeting, notes: startNotes } = await startChat(page);
  const gShot = await screenshot(page, `${shotPrefix}-greeting`);
  screenshots.push(gShot.local);
  turns.push({
    session: id,
    guestText: "(CTA start)",
    botReply: greeting || "(empty)",
    pass: !!greeting && greeting.length > 5,
    notes: startNotes,
    screenshot: gShot.local,
    docsCopy: gShot.docs,
  });

  const bot = await sendGuest(page, message);
  const shot = await screenshot(page, `${shotPrefix}-reply`);
  screenshots.push(shot.local);
  const empty = !bot || bot.trim().length < 2;
  turns.push({
    session: id,
    guestText: message,
    botReply: bot || "(empty)",
    pass: !empty,
    notes: empty ? "FAIL: empty bot reply" : "ok",
    screenshot: shot.local,
    docsCopy: shot.docs,
  });

  await context.close();
  return {
    id,
    name,
    turns,
    pass: turns.every((t) => t.pass),
    notes: empty ? "Bot reply missing" : "Short Q&A ok",
    screenshots,
  };
}

async function main() {
  const result: {
    startedAt: string;
    url: string;
    uiOpened: boolean;
    chatWorked: boolean;
    bookingPass: boolean;
    sessions: SessionResult[];
    dashboard?: {
      screenshot?: string;
      docsCopy?: string;
      notifyText?: string;
      ticketsText?: string;
    };
    uiBugs: string[];
    absoluteShots: string[];
    docsShots: string[];
    error?: string;
  } = {
    startedAt: new Date().toISOString(),
    url: WA_URL,
    uiOpened: false,
    chatWorked: false,
    bookingPass: false,
    sessions: [],
    uiBugs: [],
    absoluteShots: [],
    docsShots: [],
  };

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    // Smoke: can we open the page?
    {
      const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
      const p = await ctx.newPage();
      const resp = await p.goto(WA_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      result.uiOpened = !!resp && resp.ok();
      const title = await p.title().catch(() => "");
      const body = await p.locator("body").innerText().catch(() => "");
      if (!/whatsapp|reservations|start chat|type a message/i.test(body + title)) {
        result.uiBugs.push("Page loaded but WhatsApp demo markers not found in body");
      }
      // Check input / CTA presence
      const hasCta = await p.getByRole("button", { name: /Start chat/i }).count();
      const hasInput = await p.locator("input").count();
      if (hasCta === 0 && hasInput === 0) result.uiBugs.push("Neither CTA nor input found on initial load");
      await ctx.close();
    }

    const booking = await runBookingSession(browser);
    result.sessions.push(booking.session);
    result.bookingPass = booking.session.pass;
    result.chatWorked = booking.session.turns.some((t) => t.guestText !== "(CTA start)" && t.pass);
    result.dashboard = {
      screenshot: booking.dashboardShot,
      docsCopy: booking.dashboardDocs,
      notifyText: booking.notifyText,
      ticketsText: booking.ticketsText,
    };

    // Session 2: parking
    result.sessions.push(
      await runShortSession(browser, "parking", "Is parking free?", "Is parking free?", "10-parking"),
    );
    // Session 3: airport pickup
    result.sessions.push(
      await runShortSession(
        browser,
        "airport",
        "Airport pickup question",
        "Do you offer airport pickup?",
        "11-airport",
      ),
    );
    // Session 4: Arabic greeting
    result.sessions.push(
      await runShortSession(browser, "arabic", "Arabic greeting", "السلام عليكم", "12-arabic"),
    );

    // Collect all shot paths
    for (const s of result.sessions) {
      for (const t of s.turns) {
        result.absoluteShots.push(t.screenshot);
        if (t.docsCopy) result.docsShots.push(t.docsCopy);
      }
    }
    if (booking.dashboardShot) result.absoluteShots.push(booking.dashboardShot);
    if (booking.dashboardDocs) result.docsShots.push(booking.dashboardDocs);

    // UI bug heuristics from booking turns
    for (const t of booking.session.turns) {
      if (!t.pass) result.uiBugs.push(`Empty/missing reply after: ${t.guestText}`);
    }
    if (!result.bookingPass) result.uiBugs.push("Full booking did not clearly confirm");
  } catch (e) {
    result.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
  } finally {
    if (browser) await browser.close();
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), "utf8");
  // Also copy JSON to Documents
  try {
    fs.copyFileSync(OUT_JSON, path.join(DOCS_SHOTS, "_wa-ui-results.json"));
  } catch {
    /* ignore */
  }

  console.log(JSON.stringify({
    uiOpened: result.uiOpened,
    chatWorked: result.chatWorked,
    bookingPass: result.bookingPass,
    sessions: result.sessions.map((s) => ({
      id: s.id,
      pass: s.pass,
      turns: s.turns.map((t) => ({
        guest: t.guestText,
        bot: (t.botReply || "").slice(0, 160),
        pass: t.pass,
      })),
    })),
    shots: result.absoluteShots,
    docs: result.docsShots,
    bugs: result.uiBugs,
    error: result.error,
    notifyPreview: (result.dashboard?.notifyText || "").slice(0, 200),
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
