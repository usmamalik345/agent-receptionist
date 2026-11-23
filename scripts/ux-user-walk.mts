import { greet, processGuestMessage } from "../src/lib/stateMachine.ts";
import { emptyBooking, type BookingFields, type ConversationStep, type Language } from "../src/lib/types.ts";

type Turn = { text: string };
type Scenario = { name: string; language?: Language; afterHours?: boolean; turns: Turn[] };

function run(scenario: Scenario) {
  const language = scenario.language ?? "en";
  const afterHours = scenario.afterHours ?? true;
  let booking = emptyBooking(language);
  let step: ConversationStep = "await_intent";
  const log: string[] = [];
  const g = greet(language, afterHours);
  step = g.nextStep as ConversationStep;
  booking = { ...booking, ...g.bookingUpdates };
  log.push("AI: " + g.reply);
  let last: any = g;
  for (const t of scenario.turns) {
    const r = processGuestMessage({
      text: t.text,
      step,
      booking,
      language: (booking.language as Language) || language,
      afterHours,
      humanTakeover: false,
    });
    booking = { ...booking, ...r.bookingUpdates };
    step = r.nextStep as ConversationStep;
    last = r;
    log.push("GUEST: " + t.text);
    log.push("AI: " + r.reply);
    if (r.escalate) log.push("[ESCALATE]");
    if (r.createNotification) log.push("[NOTIFY] " + r.createNotification.subject);
    if (r.outcome) log.push("[OUTCOME] " + r.outcome);
    if ((r as any).createTicket) log.push("[TICKET]");
  }
  return { name: scenario.name, step, booking, last, log };
}

const scenarios: Scenario[] = [
  { name: "Happy path one-shot", turns: [
    { text: "I need a room for 2 adults and 1 child, check-in 2026-10-10, check-out 2026-10-13, late check-in after 10pm. Name Ahmed Al Mansoori, phone +971 50 555 5555" },
    { text: "Yes" },
  ]},
  { name: "Messy multi-turn booking", turns: [
    { text: "hi I want a room" },
    { text: "maybe next Friday to Sunday" },
    { text: "2 people" },
    { text: "one room is fine" },
    { text: "Sara" },
    { text: "0501234567" },
    { text: "near quiet side if possible" },
    { text: "yes confirm" },
  ]},
  { name: "Price question", turns: [{ text: "How much is a deluxe room per night?" }] },
  { name: "FAQ interrupt mid-booking", turns: [
    { text: "book a room please" },
    { text: "what time is check-in?" },
    { text: "ok check-in 10 October check-out 13 October" },
  ]},
  { name: "Modify existing booking", turns: [
    { text: "I need to change my booking. Name Sara Khan, phone +971 50 111 2222, confirmation ERTH-88421, move check-in to 2026-11-05" },
  ]},
  { name: "Cancel request", turns: [{ text: "please cancel my reservation confirmation ERTH-100" }] },
  { name: "Talk to human", turns: [{ text: "agent please" }] },
  { name: "Complaint", turns: [
    { text: "I want to complain" },
    { text: "AC is broken in room 1204, name Omar, phone +971501234567" },
  ]},
  { name: "Dining booking", turns: [{ text: "table for 4 tomorrow at 8pm at Al Rimal, name Layla, +971509998887" }] },
  { name: "Vague hello", turns: [{ text: "hello?" }] },
  { name: "Arabic book room", language: "ar", turns: [{ text: "arido hajz ghurfa" }, { text: "I want to book a room" }] },
  { name: "Confirm availability pressure", turns: [{ text: "Do you have availability? Confirm my booking now for Oct 10-13 for 2 adults" }] },
  { name: "Bad phone number", turns: [
    { text: "book room 2 adults from 2026-12-01 to 2026-12-03" },
    { text: "John Smith" },
    { text: "123" },
  ]},
  { name: "Spa question then book", turns: [
    { text: "Is the spa open on Friday?" },
    { text: "ok book a room for 1 adult check-in 2026-10-20 check-out 2026-10-22 name Nora phone +971507777666" },
    { text: "yes" },
  ]},
];

for (const r of scenarios.map(run)) {
  console.log("\n==== " + r.name + " ====");
  console.log(["step="+r.step, "outcome="+(r.last.outcome||"-"), "name="+(r.booking.guestName||"-"), "phone="+(r.booking.phone||"-"), "in="+(r.booking.checkIn||"-"), "out="+(r.booking.checkOut||"-")].join(" | "));
  console.log(r.log.slice(-8).join("\n"));
}