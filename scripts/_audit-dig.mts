import { greet, processGuestMessage } from "../src/lib/stateMachine.ts";
import { emptyBooking } from "../src/lib/types.ts";

function run(label: string, msgs: string[]) {
  console.log("\n=== " + label + " ===");
  let booking = emptyBooking("en");
  let step = greet("en", true).nextStep as any;
  for (const text of msgs) {
    const r = processGuestMessage({
      text,
      step,
      booking,
      language: "en",
      afterHours: true,
      humanTakeover: false,
    });
    booking = { ...booking, ...r.bookingUpdates };
    step = r.nextStep;
    console.log("G:", text);
    console.log("A:", r.text.slice(0, 240));
    console.log(
      "M:",
      JSON.stringify({
        step,
        outcome: r.outcome || null,
        in: booking.checkIn || null,
        out: booking.checkOut || null,
        rooms: booking.rooms,
        conf: booking.confirmationNumber || null,
        name: booking.guestName || null,
        notify: r.createNotification?.subject || null,
        ticket: r.createTicket?.reason || null,
        intent: r.intent || null,
      }),
    );
  }
}

run("S30 15/10 range", ["I want to book from 15/10 to 18/10"]);
run("S30 slash only", ["15/10 to 18/10"]);
run("S30 15/10/2026", ["I want to book from 15/10/2026 to 18/10/2026"]);
run("S34 with ERTH", [
  "Please modify my reservation ERTH-12345, name Noor Ali, phone +971501234000, change checkout to 20 Nov",
]);
run("S34 classic change", [
  "I need to change my booking. Name Noor Ali, phone +971501234000, confirmation ERTH-12345, move check-in to 2026-11-05",
]);
run("S34 without conf", [
  "I need to change my booking, name Noor Ali, phone +971501234000, change checkout date",
]);

{
  console.log("\n=== NOTIFY SHAPE ===");
  let booking = emptyBooking("en");
  let step = greet("en", true).nextStep as any;
  let r = processGuestMessage({
    text: "Book a room for 2 adults, check-in 12 October 2026, check-out 14 October 2026, name Ahmed Al Mansoori, phone +971505555555",
    step,
    booking,
    language: "en",
    afterHours: true,
    humanTakeover: false,
  });
  booking = { ...booking, ...r.bookingUpdates };
  step = r.nextStep;
  r = processGuestMessage({
    text: "yes",
    step,
    booking,
    language: "en",
    afterHours: true,
    humanTakeover: false,
  });
  console.log("OUTCOME", r.outcome);
  console.log("SUBJ", r.createNotification?.subject);
  console.log("BODY", r.createNotification?.body);
  console.log("AI", r.text);
}

run("pets", ["Can I bring my dog / pet?"]);
run("rates", ["What are your room rates?"]);
