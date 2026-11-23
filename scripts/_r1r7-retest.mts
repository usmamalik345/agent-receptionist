import { greet, processGuestMessage } from "../src/lib/stateMachine.ts";
import { emptyBooking, type ConversationStep, type Language } from "../src/lib/types.ts";

type Session = { id: string; label: string; turns: string[]; expect: string };

function runSession(s: Session) {
  let booking = emptyBooking("en");
  let step: ConversationStep = "await_intent";
  const g = greet("en", true);
  step = g.nextStep as ConversationStep;
  booking = { ...booking, ...g.bookingUpdates };
  console.log("\n========== " + s.id + ": " + s.label + " ==========");
  console.log("EXPECT:", s.expect);
  for (const text of s.turns) {
    const r = processGuestMessage({
      text,
      step,
      booking,
      language: (booking.language as Language) || "en",
      afterHours: true,
      humanTakeover: false,
    });
    booking = { ...booking, ...r.bookingUpdates };
    step = r.nextStep as ConversationStep;
    console.log("GUEST:", JSON.stringify(text));
    console.log("AI:", r.text);
    console.log("META:", JSON.stringify({
      step,
      outcome: r.outcome || null,
      name: booking.guestName || null,
      phone: booking.phone || null,
      in: booking.checkIn || null,
      out: booking.checkOut || null,
      rooms: booking.rooms,
      adults: booking.adults,
      children: booking.children,
      special: (booking as any).specialRequests ?? (booking as any).special ?? null,
      escalate: !!r.escalate,
      notify: r.createNotification?.subject || null,
      intent: (r as any).intent || null,
    }));
  }
  console.log("FINAL:", JSON.stringify({
    step,
    rooms: booking.rooms,
    adults: booking.adults,
    children: booking.children,
    name: booking.guestName || null,
    phone: booking.phone || null,
    in: booking.checkIn || null,
    out: booking.checkOut || null,
    special: (booking as any).specialRequests ?? (booking as any).special ?? null,
  }));
}

const sessions: Session[] = [
  {
    id: "R1",
    label: "Fresh I want to book",
    turns: ["I want to book"],
    expect: "rooms=1 immediately or after first turn; next ask dates/guests — NOT stuck on collect_rooms",
  },
  {
    id: "R2",
    label: "Fresh Book room please",
    turns: ["Book room please"],
    expect: "rooms=1, progresses past collect_rooms",
  },
  {
    id: "R3a",
    label: "Fresh I'd like to book",
    turns: ["I'd like to book"],
    expect: "rooms=1 if covered by fix",
  },
  {
    id: "R3b",
    label: "Fresh book please",
    turns: ["book please"],
    expect: "rooms=1 if covered by fix",
  },
  {
    id: "R4",
    label: "Room pls then dates — no re-ask rooms",
    turns: ["Room pls", "15 oct to 18 oct"],
    expect: "does NOT re-ask rooms; asks guests; rooms stay 1",
  },
  {
    id: "R5",
    label: "Vague book then explicit 2 rooms override",
    turns: ["I want to book", "2 rooms"],
    expect: "after vague book rooms=1; then rooms=2 on explicit override",
  },
  {
    id: "R6a",
    label: "OTA paid Booking.com — NOT new book rooms=1",
    turns: ["Confirm booking, I already paid on Booking.com"],
    expect: "modify/OTA path, not new reservation with rooms=1 forced",
  },
  {
    id: "R6b",
    label: "Spa hours FAQ alone",
    turns: ["What are spa hours?"],
    expect: "FAQ answer; rooms NOT set to 1",
  },
  {
    id: "R6c",
    label: "Airport FAQ alone",
    turns: ["How far from the airport?"],
    expect: "FAQ answer; rooms NOT set to 1",
  },
  {
    id: "R6d",
    label: "Parking FAQ alone",
    turns: ["Is parking free?"],
    expect: "FAQ answer; rooms NOT set to 1",
  },
  {
    id: "R7a",
    label: "Unlabeled dump after spa",
    turns: [
      "I want to book a room",
      "what are spa hours?",
      "15 oct to 18 oct, 2 adults, Maya Khan, +971501234567",
    ],
    expect: "name Maya Khan set; dates/guests/phone extracted",
  },
  {
    id: "R7b",
    label: "Arabic hello",
    turns: ["مرحبا عليكم"],
    expect: "Arabic greeting reply, not rates FAQ",
  },
  {
    id: "R7c",
    label: "Marina correction",
    turns: ["Is Erth in Dubai Marina?"],
    expect: "corrects to Abu Dhabi / Khor Al Maqta",
  },
  {
    id: "R7d",
    label: "Late check-in as special",
    turns: [
      "I want to book a room",
      "15 oct to 18 oct",
      "2 adults",
      "Maya Khan",
      "+971501234567",
      "late check-in please",
    ],
    expect: "saves as special request, not general check-in FAQ",
  },
  {
    id: "R7e",
    label: "Yes on special",
    turns: [
      "I want to book",
      "15 oct to 18 oct",
      "2 adults",
      "Sara Ahmed",
      "+971502222222",
      "yes",
    ],
    expect: "special is NOT the string yes; empty/proceed",
  },
  {
    id: "R7f",
    label: "None on special",
    turns: [
      "Book room please",
      "20 oct to 22 oct",
      "1 adult",
      "Layla Noor",
      "+971503333333",
      "none",
    ],
    expect: "special is NOT the string none; empty/proceed",
  },
];

for (const s of sessions) runSession(s);
console.log("\n========== R1-R7 PERSON PROBE COMPLETE ==========");
