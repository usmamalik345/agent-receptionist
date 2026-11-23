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
    console.log("GUEST:", text);
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
      special: booking.specialRequests ?? booking.special ?? null,
      escalate: !!r.escalate,
      notify: r.createNotification?.subject || null,
    }));
  }
  console.log("FINAL_BOOKING:", JSON.stringify({
    step,
    name: booking.guestName || null,
    phone: booking.phone || null,
    in: booking.checkIn || null,
    out: booking.checkOut || null,
    rooms: booking.rooms,
    adults: booking.adults,
    children: booking.children,
    special: booking.specialRequests ?? booking.special ?? null,
  }));
}

const sessions: Session[] = [
  {
    id: "P1",
    label: "Skip rooms when already set",
    turns: ["Room pls", "15 oct to 18 oct"],
    expect: "does NOT re-ask how many rooms; next ask is guests or name; rooms stay 1",
  },
  {
    id: "P2",
    label: "Late check-in as special",
    turns: [
      "I want to book a room",
      "15 oct to 18 oct",
      "2 adults",
      "Maya Khan",
      "+971501234567",
      "late check-in please",
    ],
    expect: "saves as special request text, NOT general check-in hours FAQ; can proceed/confirm",
  },
  {
    id: "P2b",
    label: "Late check-in 1am variant",
    turns: [
      "Book a room",
      "10 oct to 13 oct",
      "2 adults",
      "Omar Ali",
      "+971501111111",
      "arriving late, check in at 1am",
    ],
    expect: "saves late arrival as special, not FAQ",
  },
  {
    id: "P3a",
    label: "Yes on special",
    turns: [
      "I want to book",
      "15 oct to 18 oct",
      "2 adults",
      "Sara Ahmed",
      "+971502222222",
      "yes",
    ],
    expect: "does NOT store special=yes; treat as no special / proceed",
  },
  {
    id: "P3b",
    label: "None on special",
    turns: [
      "Book room please",
      "20 oct to 22 oct",
      "1 adult",
      "Layla Noor",
      "+971503333333",
      "none",
    ],
    expect: "does NOT store special=none as request; empty special / proceed",
  },
  {
    id: "P4",
    label: "Multi-field dump mid-collect",
    turns: [
      "I want to book a room",
      "what are spa hours?",
      "15 oct to 18 oct, 2 adults, Maya Khan, +971501234567",
    ],
    expect: "extracts dates AND guests AND name AND phone; does not keep only dates",
  },
  {
    id: "P5",
    label: "Airport / pickup",
    turns: ["Hi", "How far from the airport? Do you have airport pickup?"],
    expect: "transfer answer not campus",
  },
  {
    id: "P6",
    label: "Parking free",
    turns: ["Is parking free?"],
    expect: "parking fact not villas",
  },
  {
    id: "P7",
    label: "Dubai Marina",
    turns: ["Is Erth in Dubai Marina?"],
    expect: "corrects to Abu Dhabi / Khor Al Maqta",
  },
  {
    id: "P8",
    label: "Room pls dates guests kids",
    turns: ["Room pls", "15 oct to 18 oct", "2 adults 1 kid"],
    expect: "saves guests, no kids-club trap",
  },
  {
    id: "P9",
    label: "Book room then spa hours",
    turns: ["Book room", "what are spa hours?"],
    expect: "answer spa + resume check-in",
  },
  {
    id: "P10",
    label: "Already paid Booking.com",
    turns: ["Confirm booking, I already paid on Booking.com"],
    expect: "OTA/modify not new book",
  },
  {
    id: "P11",
    label: "Arabic greeting",
    turns: ["السلام عليكم"],
    expect: "greeting not rates",
  },
];

for (const s of sessions) runSession(s);
console.log("\n========== PERSON RETEST COMPLETE ==========");
