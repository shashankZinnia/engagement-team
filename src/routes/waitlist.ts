import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../db";
import { admin, requireUser } from "../middleware/auth";
import { HttpError, wrap } from "../middleware/errors";
import { validate } from "../middleware/validate";
import { idParam } from "./common";

export const waitlist = Router();

// POST /events/:id/waitlist | tables: events, payments, event_waitlist_entries
// One transaction: the payment and the waitlist entry are saved together or not at all.
waitlist.post(
  "/events/:id/waitlist",
  requireUser,
  validate("params", idParam),
  wrap(async (req, res) => {
    const eventId = req.params.id;
    const userId = req.user!.id;

    const entry = await withTransaction(async (db) => {
      const ev = await db.query("SELECT waitlist_fee, currency, status FROM events WHERE id = $1", [eventId]);
      if (ev.rows.length === 0) throw new HttpError(404, "Event not found");
      if (ev.rows[0].status !== "published") throw new HttpError(409, "Event is not open for the waitlist");

      // Check first so a repeat call does not create a second payment.
      const dup = await db.query(
        "SELECT 1 FROM event_waitlist_entries WHERE event_id = $1 AND user_id = $2",
        [eventId, userId]
      );
      if (dup.rows.length > 0) throw new HttpError(409, "Already on the waitlist for this event");

      // TODO integrate Stripe/Razorpay: create a real charge here. Never store card data.
      const pay = await db.query(
        `INSERT INTO payments (user_id, amount, currency, provider, provider_ref, status)
         VALUES ($1, $2, $3, 'mock', $4, 'succeeded') RETURNING id, amount, currency, provider, status`,
        [userId, ev.rows[0].waitlist_fee, ev.rows[0].currency, randomUUID()]
      );
      const w = await db.query(
        `INSERT INTO event_waitlist_entries (event_id, user_id, payment_id, status)
         VALUES ($1, $2, $3, 'pending') RETURNING *`,
        [eventId, userId, pay.rows[0].id]
      );
      return { ...w.rows[0], payment: pay.rows[0] };
    });
    res.status(201).json(entry);
  })
);

const listQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).default("pending"),
});

// GET /admin/events/:id/waitlist?status= (admin)
// tables: event_waitlist_entries, users, user_profiles, payments
waitlist.get(
  "/admin/events/:id/waitlist",
  ...admin,
  validate("params", idParam),
  validate("query", listQuery),
  wrap(async (req, res) => {
    const { status } = req.query as z.infer<typeof listQuery>;
    const { rows } = await pool.query(
      `SELECT w.id AS entry_id, w.status, w.created_at, w.reviewed_at, w.review_note,
              u.id AS user_id, u.email, p.full_name, p.bio, p.city, p.date_of_birth, p.instagram_handle,
              pay.amount, pay.currency, pay.provider, pay.status AS payment_status
       FROM event_waitlist_entries w
       JOIN users u              ON u.id = w.user_id
       JOIN user_profiles p      ON p.user_id = u.id
       LEFT JOIN payments pay    ON pay.id = w.payment_id
       WHERE w.event_id = $1 AND w.status = $2
       ORDER BY w.created_at`,
      [req.params.id, status]
    );
    res.json(rows);
  })
);

const review = z.object({
  status: z.enum(["approved", "rejected"]),
  note: z.string().optional(),
});

// PATCH /admin/waitlist/:id (admin) | tables: event_waitlist_entries, events, audit_log
// (the brief calls the route param :entryId; it is named :id here to share idParam)
waitlist.patch(
  "/admin/waitlist/:id",
  ...admin,
  validate("params", idParam),
  validate("body", review),
  wrap(async (req, res) => {
    const { status, note } = req.body as z.infer<typeof review>;
    const updated = await withTransaction(async (db) => {
      const found = await db.query("SELECT id, event_id, status FROM event_waitlist_entries WHERE id = $1", [
        req.params.id,
      ]);
      if (found.rows.length === 0) throw new HttpError(404, "Waitlist entry not found");
      const entry = found.rows[0];
      if (entry.status !== "pending") throw new HttpError(409, `Entry is already ${entry.status}`);

      if (status === "approved") {
        // Lock the event row so two admins approving at once cannot both take the last seat.
        const ev = await db.query("SELECT capacity FROM events WHERE id = $1 FOR UPDATE", [entry.event_id]);
        const capacity: number | null = ev.rows[0].capacity;
        if (capacity !== null) {
          const c = await db.query(
            "SELECT count(*)::int AS n FROM event_waitlist_entries WHERE event_id = $1 AND status = 'approved'",
            [entry.event_id]
          );
          if (c.rows[0].n + 1 > capacity) throw new HttpError(409, `Event is full (capacity ${capacity})`);
        }
      }

      const u = await db.query(
        `UPDATE event_waitlist_entries
         SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
         WHERE id = $1 RETURNING *`,
        [entry.id, status, req.user!.id, note ?? null]
      );
      await db.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'event_waitlist_entry', $3, $4)`,
        [req.user!.id, `waitlist.${status}`, entry.id, JSON.stringify({ event_id: entry.event_id, note: note ?? null })]
      );
      // NOTE (known gap): rejecting does not refund the payment yet.
      return u.rows[0];
    });
    res.json(updated);
  })
);
