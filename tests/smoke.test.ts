// Smoke test for steps 2-6 of the brief. Runs against a separate database (events_test)
// that is dropped and recreated from schema.sql on every run.
// Needs the Postgres container (or any Postgres) reachable using the credentials in .env.
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { Client } from "pg";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DB = "events_test";
const baseUrl = new URL(process.env.DATABASE_URL ?? "postgres://events:events_pw@localhost:5432/events");

let app: any;
let pool: any;
const ids: Record<string, string> = {};

const as = (userId: string) => ({ "x-user-id": userId });
const future = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();

async function makeUser(admin: boolean, name: string) {
  const email = `${name}@test.example`;
  const u = await pool.query("INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id", [
    email,
    admin ? "admin" : "user",
  ]);
  await pool.query("INSERT INTO user_profiles (user_id, full_name, city) VALUES ($1, $2, 'Mumbai')", [
    u.rows[0].id,
    name,
  ]);
  return u.rows[0].id as string;
}

beforeAll(async () => {
  // Recreate the test database from schema.sql
  const adminUrl = new URL(baseUrl.toString());
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(baseUrl.toString());
  testUrl.pathname = `/${TEST_DB}`;
  const schema = new Client({ connectionString: testUrl.toString() });
  await schema.connect();
  await schema.query(readFileSync(join(__dirname, "..", "schema.sql"), "utf8"));
  await schema.end();

  // Point the app at the test DB BEFORE importing it
  process.env.DATABASE_URL = testUrl.toString();
  ({ pool } = await import("../src/db"));
  const { createApp } = await import("../src/app");
  app = createApp();

  ids.admin = await makeUser(true, "admin");
  for (const n of ["a", "b", "c", "d"]) ids[n] = await makeUser(false, n);
});

afterAll(async () => {
  await pool?.end();
});

describe("events platform smoke test", () => {
  it("GET /health", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.db).toBe("ok");
  });

  it("rejects missing / non-admin callers", async () => {
    expect((await request(app).post("/partners").send({})).status).toBe(401);
    const r = await request(app).post("/partners").set(as(ids.a)).send({ type: "cafe", name: "x" });
    expect(r.status).toBe(403);
  });

  it("partner -> event -> publish -> list shows partner joined", async () => {
    const p = await request(app).post("/partners").set(as(ids.admin)).send({ type: "cafe", name: "Test Cafe", city: "Mumbai" });
    expect(p.status).toBe(201);
    ids.partner = p.body.id;

    const e = await request(app).post("/events").set(as(ids.admin)).send({
      partner_id: ids.partner, title: "Main event", starts_at: future(5), waitlist_fee: 500, needs_host: true,
    });
    expect(e.status).toBe(201);
    expect(e.body.status).toBe("draft");
    ids.event = e.body.id;

    // draft events are not listed
    expect((await request(app).get("/events")).body).toHaveLength(0);

    expect((await request(app).patch(`/events/${ids.event}/publish`).set(as(ids.admin))).status).toBe(200);
    const list = await request(app).get("/events");
    expect(list.body).toHaveLength(1);
    expect(list.body[0].partner_name).toBe("Test Cafe");
    expect(list.body[0].interest_count).toBe(0); // stats row created by trigger
  });

  it("waitlist: A and B join, repeat is 409, admin approves A / rejects B", async () => {
    const a = await request(app).post(`/events/${ids.event}/waitlist`).set(as(ids.a));
    expect(a.status).toBe(201);
    expect(a.body.payment.provider).toBe("mock");
    expect((await request(app).post(`/events/${ids.event}/waitlist`).set(as(ids.b))).status).toBe(201);
    expect((await request(app).post(`/events/${ids.event}/waitlist`).set(as(ids.a))).status).toBe(409);

    // the repeat must not have created a second payment
    const pays = await pool.query("SELECT count(*)::int AS n FROM payments WHERE user_id = $1", [ids.a]);
    expect(pays.rows[0].n).toBe(1);

    const list = await request(app).get(`/admin/events/${ids.event}/waitlist`).set(as(ids.admin));
    expect(list.body).toHaveLength(2);
    expect(list.body[0].full_name).toBeTruthy();
    expect(list.body[0].provider).toBe("mock");

    const entryA = list.body.find((x: any) => x.user_id === ids.a).entry_id;
    const entryB = list.body.find((x: any) => x.user_id === ids.b).entry_id;
    expect((await request(app).patch(`/admin/waitlist/${entryA}`).set(as(ids.admin)).send({ status: "approved" })).status).toBe(200);
    expect((await request(app).patch(`/admin/waitlist/${entryB}`).set(as(ids.admin)).send({ status: "rejected", note: "incomplete profile" })).status).toBe(200);

    const stats = await pool.query("SELECT waitlist_count FROM event_stats WHERE event_id = $1", [ids.event]);
    expect(stats.rows[0].waitlist_count).toBe(1); // pending + approved only
  });

  it("capacity: approving beyond capacity returns 409", async () => {
    const e = await request(app).post("/events").set(as(ids.admin)).send({
      partner_id: ids.partner, title: "Tiny event", starts_at: future(8), capacity: 1,
    });
    ids.tiny = e.body.id;
    await request(app).patch(`/events/${ids.tiny}/publish`).set(as(ids.admin));
    const a = await request(app).post(`/events/${ids.tiny}/waitlist`).set(as(ids.a));
    const b = await request(app).post(`/events/${ids.tiny}/waitlist`).set(as(ids.b));
    expect((await request(app).patch(`/admin/waitlist/${a.body.id}`).set(as(ids.admin)).send({ status: "approved" })).status).toBe(200);
    expect((await request(app).patch(`/admin/waitlist/${b.body.id}`).set(as(ids.admin)).send({ status: "approved" })).status).toBe(409);
  });

  it("hosts: C and D apply, count is 2, admin approves C, event detail shows C", async () => {
    const c = await request(app).post(`/events/${ids.event}/host-applications`).set(as(ids.c)).send({ pitch: "I host great nights" });
    expect(c.status).toBe(201);
    expect((await request(app).post(`/events/${ids.event}/host-applications`).set(as(ids.d)).send({ pitch: "me too" })).status).toBe(201);
    expect((await request(app).post(`/events/${ids.event}/host-applications`).set(as(ids.c)).send({})).status).toBe(409);

    const needing = await request(app).get("/hosts/events");
    const row = needing.body.find((x: any) => x.id === ids.event);
    expect(row.host_applicant_count).toBe(2);

    const apps = await request(app).get(`/admin/events/${ids.event}/host-applications`).set(as(ids.admin));
    expect(apps.body).toHaveLength(2);

    expect((await request(app).patch(`/admin/host-applications/${c.body.id}`).set(as(ids.admin)).send({ status: "approved" })).status).toBe(200);
    const detail = await request(app).get(`/events/${ids.event}`);
    expect(detail.body.hosts).toHaveLength(1);
    expect(detail.body.hosts[0].user_id).toBe(ids.c);
    expect(detail.body.partner.name).toBe("Test Cafe");
  });

  it("swipes: A right, B left -> interest +1 only, feed hides swiped event, rank refresh orders", async () => {
    expect((await request(app).put(`/events/${ids.event}/swipe`).set(as(ids.a)).send({ direction: "right" })).status).toBe(200);
    expect((await request(app).put(`/events/${ids.event}/swipe`).set(as(ids.b)).send({ direction: "left" })).status).toBe(200);

    const top = await request(app).get("/events/top?limit=10");
    expect(top.body.find((x: any) => x.id === ids.event).interest_count).toBe(1);

    for (const u of [ids.a, ids.b]) {
      const feed = await request(app).get("/events/feed").set(as(u));
      expect(feed.body.find((x: any) => x.id === ids.event)).toBeUndefined();
    }
    // C has not swiped, so still sees it
    const feedC = await request(app).get("/events/feed").set(as(ids.c));
    expect(feedC.body.find((x: any) => x.id === ids.event)).toBeDefined();

    expect((await request(app).post("/admin/jobs/refresh-rank").set(as(ids.admin))).status).toBe(200);
    const after = await request(app).get("/events/top");
    const scores = after.body.map((x: any) => x.rank_score);
    expect(scores).toEqual([...scores].sort((x: number, y: number) => y - x));
    expect(scores[0]).toBeGreaterThan(0);
  });

  it("media: upload, cover, GET /media/:id streams bytes, GET /events has no bytes", async () => {
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const up = await request(app).post(`/events/${ids.event}/media`).set(as(ids.admin)).attach("file", png, "x.png");
    expect(up.status).toBe(201);
    expect(up.body.is_cover).toBe(true);

    const up2 = await request(app).post(`/events/${ids.event}/media`).set(as(ids.admin)).attach("file", png, "y.png");
    expect(up2.body.is_cover).toBe(false);

    const bad = await request(app).post(`/events/${ids.event}/media`).set(as(ids.admin)).attach("file", Buffer.from("not an image"), "z.png");
    expect(bad.status).toBe(400);

    const m = await request(app).get(`/media/${up.body.media_id}`);
    expect(m.status).toBe(200);
    expect(m.headers["content-type"]).toBe("image/png");
    expect(m.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const list = await request(app).get("/events");
    const ev = list.body.find((x: any) => x.id === ids.event);
    expect(ev.cover_media_id).toBe(up.body.media_id);
    expect(JSON.stringify(list.body)).not.toContain("data");
    expect((await request(app).get("/media/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  it("products: create with variants, GET /products nests them", async () => {
    const p = await request(app).post("/products").set(as(ids.admin)).send({
      name: "Tee", variants: [{ sku: "T-M", size: "M", price: 799 }, { sku: "T-L", size: "L", price: 799 }],
    });
    expect(p.status).toBe(201);
    const list = await request(app).get("/products");
    expect(list.body[0].variants).toHaveLength(2);
  });

  it("audit_log has rows for the admin actions", async () => {
    const r = await pool.query("SELECT action, count(*)::int AS n FROM audit_log GROUP BY action");
    const by = Object.fromEntries(r.rows.map((x: any) => [x.action, x.n]));
    expect(by["waitlist.approved"]).toBeGreaterThanOrEqual(1);
    expect(by["waitlist.rejected"]).toBe(1);
    expect(by["host_application.approved"]).toBe(1);
  });
});
