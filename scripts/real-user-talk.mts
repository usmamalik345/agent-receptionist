import { greet, processGuestMessage } from "../src/lib/stateMachine.ts";
import { emptyBooking, type ConversationStep, type Language } from "../src/lib/types.ts";

function talk(label: string, turns: string[], language: Language = "en") {
  let booking = emptyBooking(language);
  let step: ConversationStep = "await_intent";
  const g = greet(language, true);
  step = g.nextStep as ConversationStep;
  booking = { ...booking, ...g.bookingUpdates };
  console.log("\n######## " + label + " ########");
  console.log("AI0:", g.text);
  for (const text of turns) {
    const r = processGuestMessage({
      text,
      step,
      booking,
      language: (booking.language as Language) || language,
      afterHours: true,
      humanTakeover: false,
    });
    booking = { ...booking, ...r.bookingUpdates };
    step = r.nextStep as ConversationStep;
    console.log("GUEST:", text);
    console.log("AI:", r.text);
    console.log("→", {
      step,
      outcome: r.outcome || null,
      name: booking.guestName || null,
      phone: booking.phone || null,
      in: booking.checkIn || null,
      out: booking.checkOut || null,
      rooms: booking.rooms,
      adults: booking.adults,
      children: booking.children,
      notify: r.createNotification?.subject || null,
      escalate: !!r.escalate,
    });
  }
}

talk("GREETING_LENGTH", []);
talk("REAL_PRICE", ["How much for a sea view room this weekend for 2?"]);
talk("REAL_AVAIL", ["Are you sold out on National Day? I need 2 nights for a family of 4."]);
talk("REAL_AIRPORT", ["How far from the airport and do you have a pickup?"]);
talk("REAL_CHECKIN", ["What time is check-in and can I arrive at 1am?"]);
talk("REAL_PARKING", ["Is parking free?"]);
talk("REAL_PETS", ["Can I bring my dog?"]);
talk("REAL_ARABIC_MIX", ["السلام عليكم", "I want a room tomorrow for 1 night, 1 adult, name Khalid, phone +971501234567", "yes"]);
talk("REAL_CHANGE_MIND", ["book a room", "actually wait what are spa hours?", "ok never mind book me check-in 2026-11-01 check-out 2026-11-03 2 adults name Maya phone +971509876543", "yes"]);
talk("REAL_HUMAN", ["this is urgent I need a manager now"]);
talk("REAL_WHATSAPP_STYLE", ["Hi", "Room pls", "15 oct to 18 oct", "2 adults 1 kid", "1 room", "Fatima Ali", "0509998877", "late check in", "yes"]);
talk("REAL_CONFIRM_PUSH", ["Just confirm the booking, I already paid on Booking.com"]);
talk("REAL_DINING_SIMPLE", ["Dinner for 2 tonight 7:30 at Ergon, name Sam, +971501111222"]);
talk("REAL_WRONG_INFO_TRAP", ["Is Erth in Dubai Marina?"]);
