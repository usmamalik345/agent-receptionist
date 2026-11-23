import { greet, processGuestMessage } from "../src/lib/stateMachine.ts";
import { emptyBooking, type ConversationStep, type Language } from "../src/lib/types.ts";

function probe(label: string, turns: string[], language: Language = "en") {
  let booking = emptyBooking(language);
  let step: ConversationStep = "await_intent";
  const g = greet(language, true);
  step = g.nextStep as ConversationStep;
  booking = { ...booking, ...g.bookingUpdates };
  console.log("\n## " + label);
  console.log("GREET keys", Object.keys(g));
  console.log("GREET text", (g as any).reply ?? (g as any).message ?? (g as any).text ?? JSON.stringify(g).slice(0,200));
  for (const text of turns) {
    const r = processGuestMessage({ text, step, booking, language: (booking.language as Language) || language, afterHours: true, humanTakeover: false });
    booking = { ...booking, ...r.bookingUpdates };
    step = r.nextStep as ConversationStep;
    const ai = (r as any).reply ?? (r as any).message ?? (r as any).text ?? (r as any).assistantReply;
    console.log("GUEST:", text);
    console.log("AI:", ai);
    console.log("meta:", { step, outcome: r.outcome, name: booking.guestName, phone: booking.phone, in: booking.checkIn, out: booking.checkOut, rooms: booking.rooms, adults: booking.adults, intent: (r as any).intent, escalate: r.escalate, notify: r.createNotification?.subject });
  }
}

probe("PRICE", ["How much is a deluxe room per night?"]);
probe("AVAIL", ["Do you have availability? Confirm my booking now for Oct 10-13 for 2 adults"]);
probe("MODIFY", ["I need to change my booking. Name Sara Khan, phone +971 50 111 2222, confirmation ERTH-88421, move check-in to 2026-11-05"]);
probe("DINING", ["table for 4 tomorrow at 8pm at Al Rimal, name Layla, +971509998887"]);
probe("SPA_THEN_BOOK", ["Is the spa open on Friday?", "ok book a room for 1 adult check-in 2026-10-20 check-out 2026-10-22 name Nora phone +971507777666", "yes"]);
probe("FAQ_INTERRUPT", ["book a room please", "what time is check-in?", "ok check-in 10 October check-out 13 October", "2 adults 1 room", "Ali Hassan", "+971501112233", "none", "yes"]);
probe("RELATIVE_DATES", ["hi I want a room", "maybe next Friday to Sunday", "2 people", "one room", "Sara", "0501234567", "quiet", "yes"]);
