import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { admin } from "../middleware/auth";
import { wrap } from "../middleware/errors";
import { validate } from "../middleware/validate";

export const partners = Router();

const partnerType = z.enum(["cafe", "house_party_space", "screening_venue"]);

const createPartner = z.object({
  type: partnerType,
  name: z.string().min(1),
  description: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  contact_name: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_email: z.string().email().optional(),
  capacity: z.number().int().positive().optional(),
});

// POST /partners (admin) | tables: partners
partners.post(
  "/partners",
  ...admin,
  validate("body", createPartner),
  wrap(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO partners (type, name, description, address, city, lat, lng,
                             contact_name, contact_phone, contact_email, capacity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.type, b.name, b.description ?? null, b.address ?? null, b.city ?? null, b.lat ?? null, b.lng ?? null,
       b.contact_name ?? null, b.contact_phone ?? null, b.contact_email ?? null, b.capacity ?? null]
    );
    res.status(201).json(rows[0]);
  })
);

const listQuery = z.object({
  type: partnerType.optional(),
  city: z.string().optional(),
});

// GET /partners?type=&city= | tables: partners
// "$1 IS NULL OR col = $1" lets one fixed query handle optional filters (no string concatenation).
partners.get(
  "/partners",
  validate("query", listQuery),
  wrap(async (req, res) => {
    const { type, city } = req.query as z.infer<typeof listQuery>;
    const { rows } = await pool.query(
      `SELECT * FROM partners
       WHERE is_active
         AND ($1::partner_type IS NULL OR type = $1)
         AND ($2::text IS NULL OR city ILIKE $2)
       ORDER BY name`,
      [type ?? null, city ?? null]
    );
    res.json(rows);
  })
);
