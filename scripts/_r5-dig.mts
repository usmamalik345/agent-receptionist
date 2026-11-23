import { greet, processGuestMessage, parseRooms } from "../src/lib/stateMachine.ts";
import { emptyBooking, type ConversationStep, type Language } from "../src/lib/types.ts";

function turn(text: string, step: ConversationStep, booking: ReturnType<typeof emptyBooking>) {
  return processGuestMessage({
    text, step, booking,
    language: (booking.language as Language) || "en",
    afterHours: true, humanTakeover: false,
  });
}

console.log("parseRooms('2 rooms')=", parseRooms("2 rooms"));
console.log("parseRooms('I need 2 rooms')=", parseRooms("I need 2 rooms"));

// Fresh explicit
{
  const r = turn("I need 2 rooms", "await_intent", emptyBooking("en"));
  const b = { ...emptyBooking("en"), ...r.bookingUpdates };
  console.log("FRESH I need 2 rooms =>", { rooms: b.rooms, step: r.nextStep, ai: r.text.slice(0,80) });
}

// After vague then "2 rooms"
{
  let booking = emptyBooking("en");
  let step: ConversationStep = "await_intent";
  const g = greet("en", true);
  step = g.nextStep as ConversationStep;
  booking = { ...booking, ...g.bookingUpdates };
  let r = turn("I want to book", step, booking);
  booking = { ...booking, ...r.bookingUpdates };
  step = r.nextStep as ConversationStep;
  console.log("AFTER vague =>", { rooms: booking.rooms, step });
  r = turn("2 rooms", step, booking);
  booking = { ...booking, ...r.bookingUpdates };
  step = r.nextStep as ConversationStep;
  console.log("THEN '2 rooms' =>", { rooms: booking.rooms, step, updates: r.bookingUpdates, ai: r.text.slice(0,100) });
}

// After vague then "I need 2 rooms"
{
  let booking = emptyBooking("en");
  let step: ConversationStep = "await_intent";
  const g = greet("en", true);
  step = g.nextStep as ConversationStep;
  booking = { ...booking, ...g.bookingUpdates };
  let r = turn("I want to book", step, booking);
  booking = { ...booking, ...r.bookingUpdates };
  step = r.nextStep as ConversationStep;
  r = turn("I need 2 rooms", step, booking);
  booking = { ...booking, ...r.bookingUpdates };
  step = r.nextStep as ConversationStep;
  console.log("THEN 'I need 2 rooms' =>", { rooms: booking.rooms, step, updates: r.bookingUpdates, ai: r.text.slice(0,100) });
}

// After vague then "2 rooms please" with date in same message
{
  let booking = emptyBooking("en");
  let step: ConversationStep = "await_intent";
  const g = greet("en", true);
  step = g.nextStep as ConversationStep;
  booking = { ...booking, ...g.bookingUpdates };
  let r = turn("I want to book", step, booking);
  booking = { ...booking, ...r.bookingUpdates };
  step = r.nextStep as ConversationStep;
  r = turn("2 rooms, 15 oct to 18 oct", step, booking);
  booking = { ...booking, ...r.bookingUpdates };
  step = r.nextStep as ConversationStep;
  console.log("THEN '2 rooms, 15 oct to 18 oct' =>", { rooms: booking.rooms, step, in: booking.checkIn, out: booking.checkOut, ai: r.text.slice(0,100) });
}
