import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../db";
import { admin } from "../middleware/auth";
import { wrap } from "../middleware/errors";
import { validate } from "../middleware/validate";

export const products = Router();

const createProduct = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  variants: z
    .array(
      z.object({
        sku: z.string().min(1),
        size: z.string().optional(),
        color: z.string().optional(),
        price: z.number().min(0),
        currency: z.string().length(3).default("INR"),
        stock: z.number().int().min(0).default(0),
      })
    )
    .min(1),
});

// POST /products (admin) | tables: products, product_variants
// A duplicate sku violates UNIQUE(sku) and returns 409; the whole transaction rolls back.
products.post(
  "/products",
  ...admin,
  validate("body", createProduct),
  wrap(async (req, res) => {
    const b = req.body as z.infer<typeof createProduct>;
    const created = await withTransaction(async (db) => {
      const p = await db.query(`INSERT INTO products (name, description) VALUES ($1, $2) RETURNING *`, [
        b.name,
        b.description ?? null,
      ]);
      const variants = [];
      for (const v of b.variants) {
        const r = await db.query(
          `INSERT INTO product_variants (product_id, sku, size, color, price, currency, stock)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [p.rows[0].id, v.sku, v.size ?? null, v.color ?? null, v.price, v.currency.toUpperCase(), v.stock]
        );
        variants.push(r.rows[0]);
      }
      return { ...p.rows[0], variants };
    });
    res.status(201).json(created);
  })
);

// GET /products | tables: products, product_variants, product_media
// Two correlated subqueries with json_agg. (Joining both child tables at once would multiply rows.)
products.get(
  "/products",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.description,
              COALESCE((SELECT json_agg(json_build_object(
                          'id', v.id, 'sku', v.sku, 'size', v.size, 'color', v.color,
                          'price', v.price, 'currency', v.currency, 'stock', v.stock) ORDER BY v.sku)
                        FROM product_variants v WHERE v.product_id = p.id), '[]'::json) AS variants,
              COALESCE((SELECT json_agg(pm.media_id ORDER BY pm.sort_order)
                        FROM product_media pm WHERE pm.product_id = p.id), '[]'::json) AS media_ids
       FROM products p
       WHERE p.is_active
       ORDER BY p.created_at`
    );
    res.json(rows);
  })
);
