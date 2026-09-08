# Room reservation lifecycle

Room arrival and room reservation forms are shared by Rooms, Reservations and the order dashboard. Arrival loads the active booking covering the selected room/date, showing the existing guest and stay dates. Failed reads do not imply an available room. A newly created booking is retained before confirmation/arrival, and retries reload server status before advancing `pending → confirmed → seated`; an ambiguous create response is recovered by looking up the room's covering booking.

## Ownership and billing

- Without Guest Billing, arrival records occupancy only. The form explicitly states that no payment or stay charge is recorded. It does not manufacture a paid order or print a financial receipt.
- With Guest Billing, the existing `/api/pos/rooms/[roomId]/checkin` route owns the atomic folio/stay charge. A covering reservation ID, or a stable per-form request UUID, is reused for retries. Booked arrivals additionally send `expectedReservationId`; the explicit 15-argument `room_checkin` overload validates this booking under room/reservation locks before delegating to the established transaction. Cancelled, moved or edited bookings cannot fall through into a new walk-in charge. A successful replay must match the same booking key, branch, room and dates. Server module checks remain authoritative.
- `/api/pos/reservations/[reservationId]` uses `transition_room_reservation` for non-billing room status changes. The function locks the room then reservation, validates the existing transition rules and scopes reads/writes by organization and branch. Arrival sets occupied; departure sets cleaning. Active folios prevent status-only departure.
- Billed departure must be completed from Rooms through its checkout flow and balance checks. A reservation status request returns `ROOM_CHECKOUT_REQUIRED` and never invokes financial checkout: a delayed request for a previous guest must not close a newer guest's folio. Completed reservation retries only replay the reservation transaction. Reservation cancellation is offered before arrival; room/date edits are restricted to pending or confirmed bookings.

## Dates and display

Reservation date and time are canonical branch wall-clock fields. List, timeline and details all format the same wall datetime instead of converting it through the PC timezone. The Today query refreshes when the room/table kind changes; obsolete tab responses cannot replace the current results. Room date validation and night counts use calendar dates, including daylight-saving transitions. The server preserves the entered arrival time and validates the departure before creating or editing a booking.

## Rollout and verification

Apply `supabase/migrations/20260908110000_room_reservation_status_atomic.sql` through the normal database rollout, then deploy the admin API before distributing the updated POS. No migration was applied to a live database during implementation. Older API deployments cannot provide the new room occupancy transaction.

Regression tests cover tab changes and response races, stable 19:00 display, invalid dates, arrival retry without duplicate creation, booking prefill, stable folio request IDs, conditional edits after concurrent arrival, scoped API transitions and billing settlement gates. Disposable PGlite runs additionally execute the migration and the original financial check-in RPC, testing transaction rollback after an injected final-write failure, stale booking rejection, tenant/branch isolation, replay and role denial. That isolated schema is not a production-schema compatibility or multi-process concurrency test.
