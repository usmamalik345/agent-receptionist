import { greet, processGuestMessage } from "../src/lib/stateMachine.ts";
import { emptyBooking, type BookingFields, type ConversationStep, type Language } from "../src/lib/types.ts";
import type { AgentReply } from "../src/lib/stateMachine.ts";

type Severity = "blocker" | "should-fix" | "cosmetic" | "none";
type Result = "PASS" | "FAIL" | "PARTIAL";

interface TurnOut {
  text: string;
  ai: string;
  step: ConversationStep;
  booking: BookingFields;
  reply: AgentReply;
}

interface ScenarioResult {
  id: number;
  name: string;
  result: Result;
  severity: Severity;
  why: string;
  quote: string;
  fields: Record<string, unknown>;
}

function start(lang: Language = "en"): { booking: BookingFields; step: ConversationStep } {
  let booking = emptyBooking(lang);
  const g = greet(lang, true);
  booking = { ...booking, ...g.bookingUpdates };
  return { booking, step: g.nextStep as ConversationStep };
}

function turn(
  text: string,
  step: ConversationStep,
  booking: BookingFields,
  language: Language = "en",
): TurnOut {
  const reply = processGuestMessage({
    text,
    step,
    booking,
    language,
    afterHours: true,
    humanTakeover: false,
  });
  const nextBooking = { ...booking, ...reply.bookingUpdates };
  return {
    text,
    ai: reply.text,
    step: reply.nextStep as ConversationStep,
    booking: nextBooking,
    reply,
  };
}

function runTurns(messages: string[], lang: Language = "en"): TurnOut[] {
  let { booking, step } = start(lang);
  const outs: TurnOut[] = [];
  let language = lang;
  for (const msg of messages) {
    const o = turn(msg, step, booking, language);
    outs.push(o);
    booking = o.booking;
    step = o.step;
    language = (o.booking.language as Language) || language;
  }
  return outs;
}

function last(outs: TurnOut[]): TurnOut {
  return outs[outs.length - 1];
}

function quote(outs: TurnOut[], max = 140): string {
  const t = last(outs).ai.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function hasFakeRate(text: string): boolean {
  return /\b(AED|USD|\$|dirhams?)\s*\d|\b\d+\s*(AED|USD|dirhams?)\b|rate\s*(is|of)\s*\d|from\s*AED\s*\d/i.test(text);
}

function claimsSoldOut(text: string): boolean {
  return /\b(sold\s*out|no\s*availability|fully\s*booked|we\s*(do\s*not|don't)\s*have\s*(rooms?|availability))\b/i.test(text);
}

function claimsPmsWrite(text: string): boolean {
  return /\b(confirmed\s*(your|the)\s*(booking|reservation)|booking\s*(is|has been)\s*confirmed|reserved\s*(for|your)|i\s*have\s*(booked|reserved|confirmed))\b/i.test(text);
}

function claimsFakeConfirm(text: string): boolean {
  return /\b(your\s*(room|booking|reservation)\s*is\s*(confirmed|booked)|confirmation\s*(number|code)\s*(is|:)|ERTH-\d{4,})\b/i.test(text)
    && !/call\s*you\s*back|verify|inquiry|after[\s-]?hours|desk\s*will|team\s*will/i.test(text);
}

const results: ScenarioResult[] = [];

function record(
  id: number,
  name: string,
  result: Result,
  severity: Severity,
  why: string,
  outs: TurnOut[],
  extraFields?: Record<string, unknown>,
) {
  const L = last(outs);
  const fields: Record<string, unknown> = {
    step: L.step,
    outcome: L.reply.outcome || null,
    name: L.booking.guestName || null,
    phone: L.booking.phone || null,
    in: L.booking.checkIn || null,
    out: L.booking.checkOut || null,
    rooms: L.booking.rooms,
    adults: L.booking.adults,
    children: L.booking.children,
    special: L.booking.specialRequests || null,
    escalate: !!L.reply.escalate,
    notifySubj: L.reply.createNotification?.subject || null,
    ticket: L.reply.createTicket?.reason || null,
    ...extraFields,
  };
  results.push({ id, name, result, severity, why, quote: quote(outs), fields });
  console.log(`\n=== S${id}: ${name} → ${result} (${severity}) ===`);
  console.log("WHY:", why);
  console.log("QUOTE:", quote(outs));
  console.log("FIELDS:", JSON.stringify(fields));
  for (const o of outs) {
    console.log(`  GUEST: ${o.text}`);
    console.log(`  AI: ${o.ai.replace(/\s+/g, " ").slice(0, 180)}`);
  }
}

// ========== HAPPY PATHS ==========

// 1 Full clean EN booking one-shot
{
  const outs = runTurns([
    "I need a room for 2 adults, 1 room, check-in 15 October 2026, check-out 18 October 2026. Name Fatima Hassan, phone +971501234567",
    "Yes please confirm",
  ]);
  const L = last(outs);
  const b = L.booking;
  const ok =
    /Fatima/i.test(b.guestName) &&
    b.checkIn === "2026-10-15" &&
    b.checkOut === "2026-10-18" &&
    b.adults === 2 &&
    (b.rooms === 1 || b.rooms === null) &&
    /\+971/.test(b.phone) &&
    (L.reply.outcome === "after_hours_saved" || L.reply.outcome === "booked_inquiry") &&
    !!L.reply.createNotification?.body &&
    !claimsFakeConfirm(L.ai) &&
    !hasFakeRate(L.ai);
  record(
    1,
    "Full clean EN booking one-shot → confirm → desk notify",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "Parsed all fields, after_hours_saved, desk notify, honest callback framing"
      : `Missing pieces: name=${b.guestName} dates=${b.checkIn}/${b.checkOut} adults=${b.adults} rooms=${b.rooms} phone=${b.phone} outcome=${L.reply.outcome} notify=${!!L.reply.createNotification}`,
    outs,
  );
}

// 2 WhatsApp-style short turns
{
  const outs = runTurns([
    "Room pls",
    "15 oct to 18 oct",
    "2 adults 1 kid",
    "Maya Khan",
    "+971501234567",
    "none",
    "yes",
  ]);
  const L = last(outs);
  const b = L.booking;
  const roomsOk = b.rooms === 1;
  const guestsOk = b.adults === 2 && b.children === 1;
  const datesOk = b.checkIn?.includes("2026-10-15") && b.checkOut?.includes("2026-10-18");
  const nameOk = /Maya/i.test(b.guestName);
  const phoneOk = /\+971/.test(b.phone);
  const specialOk = !(b.specialRequests || "").trim() || /none/i.test(b.specialRequests) === false
    ? !(/(^|\b)(yes|none)(\b|$)/i.test(b.specialRequests || ""))
    : true;
  // special should be empty after "none"
  const specialEmpty = !(b.specialRequests || "").trim();
  const outcomeOk = L.reply.outcome === "after_hours_saved" || L.reply.outcome === "booked_inquiry";
  const notifyOk = !!L.reply.createNotification;
  const ok = roomsOk && guestsOk && datesOk && nameOk && phoneOk && specialEmpty && outcomeOk && notifyOk;
  const partial = roomsOk && guestsOk && datesOk && nameOk && phoneOk && (outcomeOk || notifyOk);
  record(
    2,
    "WhatsApp short turns Room pls → … → confirm",
    ok ? "PASS" : partial ? "PARTIAL" : "FAIL",
    ok ? "none" : partial ? "should-fix" : "blocker",
    ok
      ? "Multi-turn collected rooms=1, guests 2+1, dates, name, phone, empty special, notify"
      : `rooms=${b.rooms} adults=${b.adults} kids=${b.children} dates=${b.checkIn}/${b.checkOut} name=${b.guestName} phone=${b.phone} special="${b.specialRequests}" outcome=${L.reply.outcome}`,
    outs,
  );
}

// 3 Vague book
{
  const outs = runTurns([
    "I want to book",
    "20 oct to 22 oct",
    "2 adults",
    "Omar Said",
    "+971509998877",
    "none",
    "yes",
  ]);
  const L = last(outs);
  const b = L.booking;
  const stuckRooms = outs.some((o, i) => i > 0 && /how many rooms/i.test(o.ai) && b.rooms === 1);
  // check if after "I want to book" it asked for rooms when rooms already implied
  const afterBook = outs[0];
  const askedRoomsUnnecessarily =
    afterBook.booking.rooms === 1 && /how many rooms/i.test(afterBook.ai);
  const ok =
    /Omar/i.test(b.guestName) &&
    b.adults === 2 &&
    b.checkIn &&
    b.checkOut &&
    (L.reply.outcome === "after_hours_saved" || L.reply.outcome === "booked_inquiry") &&
    !!L.reply.createNotification &&
    !askedRoomsUnnecessarily;
  record(
    3,
    "Vague book → dates → guests → name → phone → done",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "Vague start completed to notify without rooms re-ask loop"
      : `askedRoomsUnnec=${askedRoomsUnnecessarily} name=${b.guestName} outcome=${L.reply.outcome} rooms=${b.rooms}`,
    outs,
  );
}

// 4 Dining one-shot Ergon
{
  const outs = runTurns([
    "I'd like to reserve a table at Ergon for dinner tomorrow for 4 people, name Layla Noor, phone +971504444444",
  ]);
  const L = last(outs);
  const diningOk =
    !!L.reply.createNotification ||
    L.reply.outcome === "after_hours_saved" ||
    L.reply.outcome === "booked_inquiry" ||
    L.reply.outcome === "callback_requested" ||
    L.step === "dining_details";
  const nameOk = /Layla/i.test(L.booking.guestName) || /Layla/i.test(L.reply.createNotification?.body || "");
  const partyOk =
    L.booking.diningParty === 4 ||
    /party\s*(of\s*)?4|4\s*(people|guests|pax)/i.test(L.reply.createNotification?.body || L.ai);
  // One-shot ideally creates notify; if still collecting that's PARTIAL
  const finalized = !!L.reply.createNotification || !!L.reply.outcome;
  const ok = finalized && nameOk && (partyOk || /Ergon/i.test(L.ai + (L.reply.createNotification?.body || "")));
  const partial = L.step === "dining_details" && (/Ergon|dinner|party|name|phone|time/i.test(L.ai));
  record(
    4,
    "Dining one-shot (Ergon / dinner)",
    ok ? "PASS" : partial ? "PARTIAL" : "FAIL",
    ok ? "none" : partial ? "should-fix" : "blocker",
    ok
      ? "Dining path captured guest + party, notify or inquiry saved"
      : `step=${L.step} outcome=${L.reply.outcome} name=${L.booking.guestName} party=${L.booking.diningParty} notify=${!!L.reply.createNotification}`,
    outs,
  );
}

// 5 Rates honesty
{
  const outs = runTurns(["What are your room rates?"]);
  const L = last(outs);
  const fake = hasFakeRate(L.ai);
  const invents = claimsSoldOut(L.ai) || claimsPmsWrite(L.ai);
  const jumpsBooking = L.step === "collect_check_in" || L.step === "collect_rooms";
  const honest =
    /rate|price|reservations|quote|availability|call|team|depend/i.test(L.ai) && !fake && !invents;
  const ok = honest && !jumpsBooking && !fake;
  record(
    5,
    "Rates honesty (no fake AED)",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "Honest rates framing, no invented AED, no jump to booking collect"
      : `fakeAED=${fake} invents=${invents} jump=${jumpsBooking} step=${L.step}`,
    outs,
  );
}

// 6 Pets not permitted
{
  const outs = runTurns(["Can I bring my dog / pet?"]);
  const L = last(outs);
  const ok =
    /not\s*(permitted|allowed)|no\s*pets|pets?\s*(are\s*)?(not|aren't)|unfortunately.*(pet|dog)|do\s*not\s*allow\s*pets/i.test(
      L.ai,
    );
  record(
    6,
    "Pets not permitted",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "should-fix",
    ok ? "Correctly states pets not permitted" : "Did not clearly refuse pets",
    outs,
  );
}

// 7 Urgent manager / escalate
{
  const outs = runTurns(["I need to speak to a manager urgently, transfer me now"]);
  const L = last(outs);
  const ok =
    L.reply.escalate === true &&
    (L.reply.outcome === "transferred" || L.step === "escalated") &&
    !!L.reply.createTicket;
  record(
    7,
    "Urgent manager / escalate",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "Escalate+ticket+transferred"
      : `escalate=${L.reply.escalate} outcome=${L.reply.outcome} ticket=${!!L.reply.createTicket}`,
    outs,
  );
}

// 8 Modify existing booking → callback only
{
  const outs = runTurns([
    "I need to change my booking. Name Sara Khan, phone +971501112222, confirmation ERTH-88421, move check-in to 5 November 2026",
  ]);
  const L = last(outs);
  const claimsChange = /i (have )?changed|cancelled your|updated your booking|confirmed the change|booking has been (changed|updated|cancelled)/i.test(L.ai);
  const ok =
    L.reply.outcome === "callback_requested" &&
    !!L.reply.createNotification &&
    !!L.reply.createTicket &&
    !claimsChange &&
    /call|verify|won.?t change|no live/i.test(L.ai);
  record(
    8,
    "Modify existing booking → callback only",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "callback_requested + ticket, no fake live change claim"
      : `outcome=${L.reply.outcome} claimsChange=${claimsChange} notify=${!!L.reply.createNotification}`,
    outs,
  );
}

// 9 Booking.com / already paid OTA
{
  const outs = runTurns(["Confirm booking, I already paid on Booking.com"]);
  const L = last(outs);
  const newBook = L.step === "collect_check_in" || L.step === "collect_rooms" || L.step === "collect_guests";
  const ok =
    !newBook &&
    (L.reply.outcome === "callback_requested" ||
      L.step === "modify_collect" ||
      /booking\.com|already|ota|existing|paid|verify|call/i.test(L.ai));
  record(
    9,
    "Booking.com / already paid OTA → not new reservation",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "OTA treated as existing/modify, not new booking collect"
      : `step=${L.step} outcome=${L.reply.outcome} newBook=${newBook}`,
    outs,
  );
}

// 10 Arabic greeting + simple Arabic FAQ
{
  const greetOuts = runTurns(["السلام عليكم"], "en");
  const G = last(greetOuts);
  const greetOk =
    /[\u0600-\u06FF]/.test(G.ai) || /welcome|مرحبا|أهلا|وعليكم/i.test(G.ai);
  const notRates = !/rate|AED|price|سعر/i.test(G.ai) || /[\u0600-\u06FF]{10,}/.test(G.ai);

  const faqOuts = runTurns(["أين يقع الفندق؟"], "ar");
  const F = last(faqOuts);
  const faqOk =
    /[\u0600-\u06FF]/.test(F.ai) ||
    /Abu Dhabi|Maqta|موقع|أبوظبي|دبي/i.test(F.ai);

  const ok = greetOk && notRates && faqOk;
  const partial = greetOk || faqOk;
  record(
    10,
    "Arabic greeting + simple Arabic FAQ",
    ok ? "PASS" : partial ? "PARTIAL" : "FAIL",
    ok ? "none" : "should-fix",
    ok
      ? "Arabic greeting + location FAQ respond appropriately"
      : `greetOk=${greetOk} notRates=${notRates} faqOk=${faqOk}`,
    [...greetOuts, ...faqOuts],
    { greetQuote: quote(greetOuts), faqQuote: quote(faqOuts) },
  );
}

// 11 Staff/desk ticket on confirm — field shape
{
  const outs = runTurns([
    "Book a room for 2 adults, check-in 12 October 2026, check-out 14 October 2026, name Ahmed Al Mansoori, phone +971505555555",
    "yes",
  ]);
  const L = last(outs);
  const n = L.reply.createNotification;
  const body = n?.body || "";
  const subj = n?.subject || "";
  const hasName = /Ahmed/i.test(body) || /Ahmed/i.test(subj);
  const hasPhone = /971|555/.test(body);
  const hasDates = /10|12|13|14|Oct/i.test(body);
  const hasGuests = /2\s*adult/i.test(body);
  const honest =
    /call back|verify|availability|inquiry|after[\s-]?hours|confirm availability/i.test(body + " " + subj + " " + L.ai);
  const ok =
    !!n &&
    hasName &&
    hasPhone &&
    hasDates &&
    hasGuests &&
    (L.reply.outcome === "after_hours_saved" || L.reply.outcome === "booked_inquiry") &&
    honest;
  record(
    11,
    "Staff/desk ticket fields on confirm",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? `Notify subject="${subj}" has name/phone/dates/guests + callback language`
      : `subj=${subj} hasName=${hasName} hasPhone=${hasPhone} hasDates=${hasDates} hasGuests=${hasGuests} honest=${honest}`,
    outs,
    { notifyBody: body.slice(0, 220) },
  );
}

// ========== PREVIOUSLY FIXED ==========

// 12 Airport / pickup FAQ
{
  const outs = runTurns(["How far from the airport? Do you have airport pickup?"]);
  const L = last(outs);
  const campus = /campus|university|student|dorm/i.test(L.ai);
  const airportOk = /airport|15\s*min|Zayed|pickup|transfer|shuttle|AUH/i.test(L.ai);
  const ok = airportOk && !campus;
  record(
    12,
    "Airport / pickup FAQ (not campus)",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok ? "Airport transfer answer, no campus dump" : `airportOk=${airportOk} campus=${campus}`,
    outs,
  );
}

// 13 Parking free
{
  const outs = runTurns(["Is parking free?"]);
  const L = last(outs);
  const villa = /villa\b|villas\b|residential compound/i.test(L.ai);
  const parkingOk = /park/i.test(L.ai) && (/free|complimentary|no charge|included/i.test(L.ai) || /parking/i.test(L.ai));
  const ok = parkingOk && !villa;
  record(
    13,
    "Parking free (not villa dump)",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok ? "Parking fact without villa dump" : `parkingOk=${parkingOk} villa=${villa}`,
    outs,
  );
}

// 14 Dubai Marina → Abu Dhabi
{
  const outs = runTurns(["Is Erth in Dubai Marina?"]);
  const L = last(outs);
  const corrects =
    /Abu Dhabi|Khor Al Maqta|Maqta|not\s*(in\s*)?Dubai/i.test(L.ai) &&
    !/^Yes[,.]?\s*(we|Erth)\s*(are|is)\s*in\s*Dubai Marina/i.test(L.ai);
  record(
    14,
    "Dubai Marina → Abu Dhabi / Khor Al Maqta",
    corrects ? "PASS" : "FAIL",
    corrects ? "none" : "blocker",
    corrects ? "Corrects to Abu Dhabi / Khor Al Maqta" : "Failed to correct Dubai Marina",
    outs,
  );
}

// 15 Spa mid-booking interrupt
{
  const outs = runTurns(["Book room", "what are spa hours?"]);
  const L = last(outs);
  const answersSpa = /spa|wellness|massage|hours|am|pm|:\d{2}/i.test(L.ai);
  const resumes =
    L.step === "collect_check_in" ||
    L.step === "collect_rooms" ||
    L.step === "collect_guests" ||
    /check[\s-]?in|dates|when|arrive/i.test(L.ai);
  const ok = answersSpa && resumes;
  record(
    15,
    "Spa mid-booking interrupt → answer + resume",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok ? "Answered spa and resumed booking collect" : `spa=${answersSpa} resume=${resumes} step=${L.step}`,
    outs,
  );
}

// 16 Unlabeled dump after spa
{
  const outs = runTurns([
    "I want to book a room",
    "what are spa hours?",
    "15 oct to 18 oct, 2 adults, Maya Khan, +971501234567",
  ]);
  const L = last(outs);
  const b = L.booking;
  const ok =
    !!b.checkIn &&
    !!b.checkOut &&
    b.adults === 2 &&
    /Maya/i.test(b.guestName) &&
    /\+971/.test(b.phone) &&
    L.step !== "collect_name" &&
    L.step !== "collect_check_in";
  record(
    16,
    "Unlabeled dump after spa extracts all fields",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "Extracted dates+guests+name+phone after spa interrupt"
      : `in=${b.checkIn} out=${b.checkOut} adults=${b.adults} name=${b.guestName} phone=${b.phone} step=${L.step}`,
    outs,
  );
}

// 17 Late check-in as special
{
  const outs = runTurns([
    "I want to book a room",
    "15 oct to 18 oct",
    "2 adults",
    "Maya Khan",
    "+971501234567",
    "late check-in please",
  ]);
  const L = last(outs);
  const specialHas = /late/i.test(L.booking.specialRequests || "");
  const faqDump = /Check-in from|typically until midnight|photo ID/i.test(L.ai) && L.step !== "confirm_summary";
  const ok = specialHas && (L.step === "confirm_summary" || /confirm|summary|shall I|correct/i.test(L.ai)) && !faqDump;
  record(
    17,
    "Late check-in as special (not FAQ)",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? `specialRequests="${L.booking.specialRequests}", advanced to confirm`
      : `special="${L.booking.specialRequests}" step=${L.step} faqDump=${faqDump}`,
    outs,
  );
}

// 18 yes/none on special ≠ special="yes"
{
  const yesOuts = runTurns([
    "I want to book",
    "15 oct to 18 oct",
    "2 adults",
    "Sara Ahmed",
    "+971502222222",
    "yes",
  ]);
  const noneOuts = runTurns([
    "Book room please",
    "20 oct to 22 oct",
    "1 adult",
    "Layla Noor",
    "+971503333333",
    "none",
  ]);
  const yesBad = /^(yes|none)$/i.test((last(yesOuts).booking.specialRequests || "").trim());
  const noneBad = /^(yes|none)$/i.test((last(noneOuts).booking.specialRequests || "").trim());
  // Also "yes" shouldn't stay stuck forever on special if they meant confirm — but at collect_special "yes" means no special
  const yesEmpty = !(last(yesOuts).booking.specialRequests || "").trim();
  const noneEmpty = !(last(noneOuts).booking.specialRequests || "").trim();
  const ok = yesEmpty && noneEmpty && !yesBad && !noneBad;
  record(
    18,
    'yes/none on special ≠ special="yes"',
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "yes and none both clear specialRequests"
      : `yesSpecial="${last(yesOuts).booking.specialRequests}" noneSpecial="${last(noneOuts).booking.specialRequests}"`,
    [...yesOuts, ...noneOuts],
  );
}

// 19 Room pls → dates skips rooms re-ask
{
  const outs = runTurns(["Room pls", "15 oct to 18 oct"]);
  const L = last(outs);
  const reaskRooms = /how many rooms/i.test(L.ai);
  const roomsOne = L.booking.rooms === 1;
  const datesSet = !!L.booking.checkIn && !!L.booking.checkOut;
  const ok = roomsOne && datesSet && !reaskRooms;
  record(
    19,
    "Room pls → dates skips rooms re-ask",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "rooms=1 retained, dates set, next ask is guests/name not rooms"
      : `rooms=${L.booking.rooms} dates=${L.booking.checkIn}/${L.booking.checkOut} reask=${reaskRooms} step=${L.step}`,
    outs,
  );
}

// ========== ADVERSARIAL ==========

// 20 Mid-flow "2 rooms" alone after rooms already 1
{
  const outs = runTurns(["Room pls", "15 oct to 18 oct", "2 rooms"]);
  const L = last(outs);
  // Known gap: may ignore rooms change. Document actual status.
  const updated = L.booking.rooms === 2;
  const acknowledged = /2\s*rooms?|two rooms/i.test(L.ai);
  const result: Result = updated ? "PASS" : acknowledged ? "PARTIAL" : "FAIL";
  // This is a known gap — should-fix not blocker for demo if other paths work
  record(
    20,
    'Mid-flow "2 rooms" alone after rooms=1 (known gap)',
    result,
    updated ? "none" : "should-fix",
    updated
      ? "Rooms updated to 2"
      : acknowledged
        ? "Mentioned 2 rooms but field not updated"
        : `rooms stayed ${L.booking.rooms}; change ignored (known gap confirmed)`,
    outs,
  );
}

// 21 Change mind mid-booking
{
  const outs = runTurns([
    "Book a spa appointment",
    "Actually I want to book a room instead",
    "15 oct to 18 oct",
  ]);
  const L = last(outs);
  const switched =
    !!L.booking.checkIn ||
    L.step === "collect_check_in" ||
    L.step === "collect_guests" ||
    L.step === "collect_rooms" ||
    L.step === "collect_name" ||
    /check[\s-]?in|dates|room|guest/i.test(L.ai);
  const stuckSpa = L.step === "dining_details" && /spa/i.test(L.ai) && !L.booking.checkIn;
  const ok = switched && !stuckSpa;
  record(
    21,
    "Change mind mid-booking (spa → book room)",
    ok ? "PASS" : "PARTIAL",
    ok ? "none" : "should-fix",
    ok
      ? "Switched from spa to room booking path"
      : `step=${L.step} checkIn=${L.booking.checkIn} stuckSpa=${stuckSpa}`,
    outs,
  );
}

// 22 Interrupt with airport FAQ mid-collect dates
{
  const outs = runTurns(["I want to book a room", "How far from the airport?"]);
  const L = last(outs);
  const answers = /airport|15\s*min|Zayed|transfer/i.test(L.ai);
  const resumes =
    L.step === "collect_check_in" ||
    L.step === "collect_rooms" ||
    L.step === "collect_guests" ||
    /check[\s-]?in|dates|when would you like/i.test(L.ai);
  const ok = answers && resumes;
  record(
    22,
    "Airport FAQ interrupt mid-collect dates",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "should-fix",
    ok ? "Answered airport + resumed date collect" : `answers=${answers} resume=${resumes} step=${L.step}`,
    outs,
  );
}

// 23 Kids club OUTSIDE booking vs INSIDE collect_guests
{
  const outside = runTurns(["Do you have a kids club?"]);
  const O = last(outside);
  const outsideOk = /kid|club|children|family|activit/i.test(O.ai) || /not|don't|do not|unfortunately|concierge|ask/i.test(O.ai);
  // Inside collect_guests "2 adults 1 kid" should NOT dump kids club
  const inside = runTurns(["Room pls", "15 oct to 18 oct", "2 adults 1 kid"]);
  const I = last(inside);
  const trapped = /kids\s*club|children'?s\s*club/i.test(I.ai) && I.booking.adults !== 2;
  const guestsOk = I.booking.adults === 2 && I.booking.children === 1;
  const ok = outsideOk && guestsOk && !trapped;
  record(
    23,
    "Kids club outside vs inside collect_guests",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "should-fix",
    ok
      ? "Outside FAQ ok; inside 2 adults 1 kid parsed without kids-club trap"
      : `outsideOk=${outsideOk} guestsOk=${guestsOk} trapped=${trapped}`,
    [...outside, ...inside],
  );
}

// 24 family of 4 / National Day
{
  const outs = runTurns(["I want a room for National Day, family of 4"]);
  const L = last(outs);
  const guests =
    (L.booking.adults === 2 && L.booking.children === 2) ||
    L.booking.adults === 4 ||
    (L.booking.adults != null && (L.booking.adults + (L.booking.children || 0)) === 4);
  const noFakeAvail = !claimsSoldOut(L.ai) && !claimsFakeConfirm(L.ai);
  const ok = guests && noFakeAvail;
  const partial = noFakeAvail && (L.step.startsWith("collect") || !!L.booking.checkIn || L.booking.adults != null);
  record(
    24,
    '"family of 4" / National Day phrasing',
    ok ? "PASS" : partial ? "PARTIAL" : "FAIL",
    ok ? "none" : "should-fix",
    ok
      ? `Guests mapped (adults=${L.booking.adults} children=${L.booking.children}), no fake avail`
      : `adults=${L.booking.adults} children=${L.booking.children} dates=${L.booking.checkIn} step=${L.step}`,
    outs,
  );
}

// 25 Late arrival 1am during booking vs FAQ alone
{
  const during = runTurns([
    "Book a room",
    "10 oct to 13 oct",
    "2 adults",
    "Omar Ali",
    "+971501111111",
    "arriving late, check in at 1am",
  ]);
  const D = last(during);
  const duringSpecial = /late|1\s*am|01:00|arrival/i.test(D.booking.specialRequests || "");
  const duringFaq = /Check-in from \d|typically until midnight|photo ID and a credit card/i.test(D.ai) && D.step !== "confirm_summary";

  const alone = runTurns(["What are check-in hours? Can I arrive at 1am?"]);
  const A = last(alone);
  const aloneFaq = /check[\s-]?in|midnight|late|arrival|welcome/i.test(A.ai);

  const ok = duringSpecial && !duringFaq && aloneFaq;
  record(
    25,
    "Late arrival 1am during booking vs FAQ alone",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? "During booking → special; alone → FAQ"
      : `duringSpecial=${duringSpecial} duringFaq=${duringFaq} aloneFaq=${aloneFaq} special="${D.booking.specialRequests}"`,
    [...during, ...alone],
  );
}

// 26 Complaint / angry guest
{
  const outs = runTurns([
    "This is unacceptable! My room was dirty and nobody answered the phone. Name Omar Hassan phone +971507777777. I want this escalated!",
  ]);
  const L = last(outs);
  const ok =
    (!!L.reply.createTicket || !!L.reply.createNotification || L.reply.escalate === true || L.step === "complaint_details") &&
    (/Omar|sorry|apolog|escalat|manager|ticket|note|complaint/i.test(L.ai + (L.reply.createTicket?.summary || "") + (L.reply.createNotification?.body || "")));
  record(
    26,
    "Complaint / angry guest",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "should-fix",
    ok
      ? "Complaint path creates ticket/notify or collects details"
      : `step=${L.step} ticket=${!!L.reply.createTicket} notify=${!!L.reply.createNotification} escalate=${L.reply.escalate}`,
    outs,
  );
}

// 27 Empty / garbage / emoji only
{
  const empty = runTurns([""]);
  const garbage = runTurns(["asdfqwerzxcv"]);
  const emoji = runTurns(["😂😂🔥"]);
  const safe = (o: TurnOut) =>
    !claimsFakeConfirm(o.ai) &&
    !hasFakeRate(o.ai) &&
    !claimsPmsWrite(o.ai) &&
    o.ai.trim().length > 0 &&
    o.reply.outcome !== "after_hours_saved";
  const ok = safe(last(empty)) && safe(last(garbage)) && safe(last(emoji));
  record(
    27,
    "Empty / garbage / emoji only",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "should-fix",
    ok
      ? "Graceful handling, no fake booking/rate"
      : "Unsafe or empty reply on garbage input",
    [...empty, ...garbage, ...emoji],
  );
}

// 28 Mixed EN+AR
{
  const outs = runTurns(["Hello مرحبا, is parking free؟"]);
  const L = last(outs);
  const answers = /park/i.test(L.ai) || /مواقف|موقف|مجاني/i.test(L.ai);
  const ok = answers && L.ai.trim().length > 10;
  record(
    28,
    "Mixed EN+AR in one message",
    ok ? "PASS" : "PARTIAL",
    ok ? "none" : "cosmetic",
    ok ? "Handled mixed message with parking answer" : `step=${L.step} — may pick one language only`,
    outs,
  );
}

// 29 Phone formats
{
  const cases = [
    { label: "+971", phone: "+971501234567", msg: "Book room 15 oct to 18 oct 2 adults name Ali Hassan phone +971501234567" },
    { label: "00971", phone: "00971501234567", msg: "Book room 16 oct to 19 oct 2 adults name Bilal Ahmad phone 00971501234567" },
    { label: "05x", phone: "0501234567", msg: "Book room 17 oct to 20 oct 2 adults name Karim Nasser phone 0501234567" },
  ];
  const details: string[] = [];
  let pass = 0;
  const allOuts: TurnOut[] = [];
  for (const c of cases) {
    const outs = runTurns([c.msg]);
    allOuts.push(...outs);
    const p = last(outs).booking.phone || "";
    const ok = /971|050|501234567|51234567/.test(p.replace(/\s/g, ""));
    if (ok) pass++;
    details.push(`${c.label}→"${p}"${ok ? "✓" : "✗"}`);
  }
  const result: Result = pass === 3 ? "PASS" : pass >= 1 ? "PARTIAL" : "FAIL";
  record(
    29,
    "Phone formats +971 / 00971 / local 05x",
    result,
    pass === 3 ? "none" : pass >= 2 ? "cosmetic" : "should-fix",
    details.join("; "),
    allOuts,
  );
}

// 30 Date formats
{
  const cases = [
    { label: "15/10", msg: "I want to book from 15/10 to 18/10" },
    { label: "15 oct", msg: "I want to book 15 oct to 18 oct" },
    { label: "tomorrow", msg: "I want to book from tomorrow to next Monday" },
    { label: "next Friday", msg: "Book a room next Friday to next Sunday" },
  ];
  const details: string[] = [];
  let pass = 0;
  const allOuts: TurnOut[] = [];
  for (const c of cases) {
    const outs = runTurns([c.msg]);
    allOuts.push(...outs);
    const b = last(outs).booking;
    const ok = !!b.checkIn || !!b.checkOut || last(outs).step === "collect_check_in" || last(outs).step === "collect_check_out";
    // For relative dates, accepting collect prompt OR parsed dates is ok; fail only if confused invents
    const parsed = !!b.checkIn && !!b.checkOut;
    if (parsed) pass++;
    else if (ok && (c.label === "tomorrow" || c.label === "next Friday")) {
      // relative may or may not parse — PARTIAL credit if at least in booking flow
      details.push(`${c.label}→in=${b.checkIn || "-"} out=${b.checkOut || "-"} step=${last(outs).step} (relative)`);
      continue;
    }
    details.push(`${c.label}→in=${b.checkIn || "-"} out=${b.checkOut || "-"} step=${last(outs).step}${parsed ? "✓" : "✗"}`);
  }
  // 15/10 and 15 oct should parse; relative is bonus
  const slash = details.find((d) => d.startsWith("15/10"))?.includes("✓");
  const oct = details.find((d) => d.startsWith("15 oct"))?.includes("✓");
  const result: Result = slash && oct ? (pass >= 3 ? "PASS" : "PARTIAL") : pass >= 1 ? "PARTIAL" : "FAIL";
  record(
    30,
    "Date formats 15/10, 15 oct, tomorrow, next Friday",
    result,
    slash && oct ? "none" : "should-fix",
    details.join("; "),
    allOuts,
  );
}

// 31 Confirm then cancel / start over
{
  const outs = runTurns([
    "Book a room for 2 adults check-in 15 oct check-out 18 oct name Zaid Malik phone +971508888888",
    "yes",
    "actually cancel that, start over",
  ]);
  const L = last(outs);
  // After confirm, cancel/start over — demo may not support; document honestly
  const supported =
    L.step === "await_intent" ||
    L.step === "greeted" ||
    L.step === "collect_check_in" ||
    /cancel|start over|new|wipe|clear|noted|call/i.test(L.ai);
  const lied = /cancelled your (confirmed|live)|booking has been cancelled|i have cancelled/i.test(L.ai) &&
    !/cannot|can't|won't|unable|call you|desk/i.test(L.ai);
  const result: Result = supported && !lied ? "PASS" : lied ? "FAIL" : "PARTIAL";
  record(
    31,
    "Confirm then cancel / start over",
    result,
    lied ? "blocker" : result === "PASS" ? "none" : "cosmetic",
    lied
      ? "Falsely claimed live cancel"
      : supported
        ? "Handles cancel/start-over without fake PMS cancel"
        : `Post-confirm cancel weakly supported; step=${L.step} outcome=${L.reply.outcome}`,
    outs,
  );
}

// 32 Double confirm / spam yes
{
  const outs = runTurns([
    "Book room 2 adults 15 oct to 18 oct name Hana Saleh phone +971506666666 none",
    "yes",
    "yes",
    "yes",
  ]);
  const notifies = outs.filter((o) => o.reply.createNotification).length;
  const outcomes = outs.filter((o) => o.reply.outcome === "after_hours_saved" || o.reply.outcome === "booked_inquiry").length;
  // Prefer single notify; multiple spam notifies is PARTIAL/should-fix
  const firstConfirm = outs.find((o) => o.reply.outcome === "after_hours_saved" || o.reply.outcome === "booked_inquiry");
  const ok = !!firstConfirm && notifies <= 1 && !claimsFakeConfirm(last(outs).ai);
  const partial = !!firstConfirm && notifies <= 3;
  record(
    32,
    "Double confirm / spam yes",
    ok ? "PASS" : partial ? "PARTIAL" : "FAIL",
    ok ? "none" : "cosmetic",
    ok
      ? "Single notify on first yes; spam yes harmless"
      : `notifies=${notifies} outcomes=${outcomes} lastStep=${last(outs).step}`,
    outs,
  );
}

// 33 Ask rates WHILE mid-booking
{
  const outs = runTurns(["I want to book a room", "what are your rates?"]);
  const L = last(outs);
  const answersRates = /rate|price|reservations|quote|depend|availability/i.test(L.ai);
  const fake = hasFakeRate(L.ai);
  const resumes =
    L.step === "collect_check_in" ||
    L.step === "collect_rooms" ||
    L.step === "collect_guests" ||
    /check[\s-]?in|dates|when|continue|room/i.test(L.ai);
  const ok = answersRates && !fake && resumes;
  record(
    33,
    "Ask rates WHILE mid-booking",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "should-fix",
    ok
      ? "Honest rates + resume booking"
      : `rates=${answersRates} fake=${fake} resume=${resumes} step=${L.step}`,
    outs,
  );
}

// 34 Modify with confirmation number vs without
{
  const withNum = runTurns([
    "Please modify my reservation ERTH-12345, name Noor Ali, phone +971501234000, change checkout to 20 Nov",
  ]);
  const without = runTurns([
    "I need to change my booking, name Noor Ali, phone +971501234000, change checkout date",
  ]);
  const W = last(withNum);
  const O = last(without);
  const withOk =
    W.reply.outcome === "callback_requested" ||
    W.step === "modify_collect" ||
    !!W.reply.createNotification;
  const withoutOk =
    O.reply.outcome === "callback_requested" ||
    O.step === "modify_collect" ||
    !!O.reply.createNotification ||
    /confirm|reference|booking|change|call/i.test(O.ai);
  const noFake =
    !/i (have )?changed|updated your booking|cancelled your reservation/i.test(W.ai + O.ai);
  const ok = withOk && withoutOk && noFake;
  record(
    34,
    "Modify with confirmation number vs without",
    ok ? "PASS" : "PARTIAL",
    ok ? "none" : "should-fix",
    ok
      ? "Both paths → callback/modify collect, no fake change"
      : `withOk=${withOk} withoutOk=${withoutOk} noFake=${noFake}`,
    [...withNum, ...without],
  );
}

// 35 Is Erth in Dubai? (broader)
{
  const outs = runTurns(["Is Erth in Dubai?"]);
  const L = last(outs);
  const ok =
    /Abu Dhabi|Khor Al Maqta|Maqta|not\s*(in\s*)?Dubai/i.test(L.ai) &&
    !/\byes\b.*\bin Dubai\b/i.test(L.ai);
  record(
    35,
    '"Is Erth in Dubai?" (broader than Marina)',
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok ? "Corrects to Abu Dhabi" : "Did not clearly correct Dubai location",
    outs,
  );
}

// ========== PRODUCT HONESTY ==========

// 36 Invent rates / sold-out / PMS write?
{
  const probes = [
    "Confirm my booking right now for Oct 10, I need a confirmation number",
    "Are you sold out on National Day?",
    "What's the exact price in AED for a deluxe room tonight?",
    "Book it and charge my card ending 4242",
  ];
  const flags: string[] = [];
  const allOuts: TurnOut[] = [];
  for (const p of probes) {
    const outs = runTurns([p]);
    allOuts.push(...outs);
    const ai = last(outs).ai;
    if (hasFakeRate(ai)) flags.push(`FAKE_RATE on "${p.slice(0, 40)}": ${ai.slice(0, 80)}`);
    if (claimsSoldOut(ai) && !/check|reservations|team|call|depend|subject to/i.test(ai))
      flags.push(`SOLD_OUT_AS_FACT on "${p.slice(0, 40)}"`);
    if (claimsPmsWrite(ai) || claimsFakeConfirm(ai))
      flags.push(`PMS/FAKE_CONFIRM on "${p.slice(0, 40)}": ${ai.slice(0, 80)}`);
    if (/charge(d)?\s*(your|my)?\s*card|payment\s*(processed|taken)/i.test(ai))
      flags.push(`CARD_CHARGE on "${p.slice(0, 40)}"`);
  }
  const ok = flags.length === 0;
  record(
    36,
    "Product honesty: no invented rates / sold-out / PMS write",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok ? "No invented rates, sold-out-as-fact, or PMS write across probes" : flags.join(" | "),
    allOuts,
  );
}

// 37 After-hours / desk notify language
{
  const outs = runTurns([
    "I need a room for 2 adults, check-in 2026-10-10, check-out 2026-10-13. Name Ahmed Al Mansoori, phone +971505555555",
    "Yes please",
  ]);
  const L = last(outs);
  const body = (L.reply.createNotification?.body || "") + " " + (L.reply.createNotification?.subject || "") + " " + L.ai;
  const callbackLang = /call back|call you|verify|availability|inquiry|after[\s-]?hours|team will|desk/i.test(body);
  const fakeConf = claimsFakeConfirm(L.ai) && !/call|verify|inquiry/i.test(L.ai);
  const ok =
    (L.reply.outcome === "after_hours_saved" || L.reply.outcome === "booked_inquiry") &&
    !!L.reply.createNotification &&
    callbackLang &&
    !fakeConf;
  record(
    37,
    "After-hours desk notify = callback not fake confirmation",
    ok ? "PASS" : "FAIL",
    ok ? "none" : "blocker",
    ok
      ? `outcome=${L.reply.outcome}; notify uses callback/verify language`
      : `outcome=${L.reply.outcome} callbackLang=${callbackLang} fakeConf=${fakeConf}`,
    outs,
  );
}

// ========== SUMMARY ==========
console.log("\n\n========== FULL AUDIT SUMMARY ==========");
const pass = results.filter((r) => r.result === "PASS").length;
const fail = results.filter((r) => r.result === "FAIL").length;
const partial = results.filter((r) => r.result === "PARTIAL").length;
console.log(`TOTAL: ${results.length}  PASS: ${pass}  PARTIAL: ${partial}  FAIL: ${fail}`);

const blockers = results.filter((r) => r.severity === "blocker" && r.result !== "PASS");
const shouldFix = results.filter((r) => r.severity === "should-fix" && r.result !== "PASS");
const cosmetic = results.filter((r) => r.severity === "cosmetic" && r.result !== "PASS");

console.log("\n--- TABLE ---");
for (const r of results) {
  console.log(`S${String(r.id).padStart(2, "0")}\t${r.result}\t${r.severity}\t${r.name}\t|\t${r.why}`);
}

console.log("\n--- BLOCKERS ---");
if (blockers.length === 0) console.log("(none)");
else for (const r of blockers) console.log(`S${r.id} ${r.name}: ${r.why}`);

console.log("\n--- SHOULD-FIX ---");
if (shouldFix.length === 0) console.log("(none)");
else for (const r of shouldFix) console.log(`S${r.id} ${r.name}: ${r.why}`);

console.log("\n--- COSMETIC ---");
if (cosmetic.length === 0) console.log("(none)");
else for (const r of cosmetic) console.log(`S${r.id} ${r.name}: ${r.why}`);

// Write JSON for parent report
import { writeFileSync } from "node:fs";
writeFileSync(
  "scripts/_full-audit-results.json",
  JSON.stringify({ pass, fail, partial, results, blockers, shouldFix, cosmetic }, null, 2),
  "utf8",
);
console.log("\nWrote scripts/_full-audit-results.json");
