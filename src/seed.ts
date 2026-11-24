import { pool } from "./db";

// Idempotent: users/partners/events/products are looked up by a natural key before inserting.
// Run with: npm run seed

async function upsertUser(email: string, role: "user" | "admin", fullName: string, city: string, bio: string) {
  // tables: users, user_profiles
  const u = await pool.query(
    `INSERT INTO users (email, role) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role RETURNING id`,
    [email, role]
  );
  const id: string = u.rows[0].id;
  await pool.query(
    `INSERT INTO user_profiles (user_id, full_name, city, bio) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO NOTHING`,
    [id, fullName, city, bio]
  );
  return id;
}

async function upsertPartner(type: string, name: string, city: string, capacity: number) {
  const found = await pool.query("SELECT id FROM partners WHERE name = $1", [name]);
  if (found.rows.length > 0) return found.rows[0].id as string;
  const r = await pool.query(
    `INSERT INTO partners (type, name, city, capacity, address) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [type, name, city, capacity, `${name} street, ${city}`]
  );
  return r.rows[0].id as string;
}

async function upsertEvent(
  adminId: string,
  partnerId: string,
  title: string,
  daysAhead: number,
  opts: { capacity?: number; needsHost?: boolean; fee: number }
) {
  const found = await pool.query("SELECT id FROM events WHERE title = $1", [title]);
  if (found.rows.length > 0) return found.rows[0].id as string;
  const r = await pool.query(
    `INSERT INTO events (partner_id, title, description, starts_at, capacity, waitlist_fee, needs_host, status, created_by)
     VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6, $7, 'published', $8) RETURNING id`,
    [partnerId, title, `${title} (seed data)`, daysAhead, opts.capacity ?? null, opts.fee, opts.needsHost ?? false, adminId]
  );
  return r.rows[0].id as string;
}

async function main() {
  const adminId = await upsertUser("admin@example.com", "admin", "Admin One", "Mumbai", "Platform admin");
  const alice = await upsertUser("alice@example.com", "user", "Alice A", "Mumbai", "Loves board games");
  const bob = await upsertUser("bob@example.com", "user", "Bob B", "Mumbai", "Film buff");
  const carol = await upsertUser("carol@example.com", "user", "Carol C", "Pune", "Community organiser");
  const dave = await upsertUser("dave@example.com", "user", "Dave D", "Delhi", "Home chef");

  const cafe = await upsertPartner("cafe", "Seed Cafe", "Mumbai", 40);
  const venue = await upsertPartner("screening_venue", "Seed Screening Room", "Mumbai", 80);

  const e1 = await upsertEvent(adminId, cafe, "Seed: Board Game Night", 5, { fee: 500, needsHost: true });
  const e2 = await upsertEvent(adminId, venue, "Seed: Indie Film Screening", 10, { fee: 300 });
  const e3 = await upsertEvent(adminId, cafe, "Seed: Tiny Supper Club", 14, { fee: 800, capacity: 2 });

  // tables: products, product_variants
  const exists = await pool.query("SELECT id FROM products WHERE name = 'Seed T-Shirt'");
  if (exists.rows.length === 0) {
    const p = await pool.query(
      "INSERT INTO products (name, description) VALUES ('Seed T-Shirt', 'Cotton tee') RETURNING id"
    );
    await pool.query(
      `INSERT INTO product_variants (product_id, sku, size, color, price, stock) VALUES
         ($1, 'SEED-TEE-M-BLK', 'M', 'black', 799, 20),
         ($1, 'SEED-TEE-L-BLK', 'L', 'black', 799, 15)`,
      [p.rows[0].id]
    );
  }

  console.log("Seeded. Use these in the x-user-id header:");
  console.log(`  admin: ${adminId}`);
  console.log(`  alice: ${alice}`);
  console.log(`  bob:   ${bob}`);
  console.log(`  carol: ${carol}`);
  console.log(`  dave:  ${dave}`);
  console.log("Events:");
  console.log(`  Board Game Night (needs_host): ${e1}`);
  console.log(`  Indie Film Screening:          ${e2}`);
  console.log(`  Tiny Supper Club (capacity 2): ${e3}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
