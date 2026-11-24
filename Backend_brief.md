Events Platform Backend: Starter Build Brief
Hand this file and schema.sql (same folder) to Claude Code in an empty VS Code project folder. Prompt to use:

Read BACKEND_BRIEF.md and schema.sql. Build exactly what the brief describes, step by step, running and testing each step before moving on. Ask me before deviating from the brief.

1. Goal
A small, working backend that (a) connects to PostgreSQL, (b) exposes basic REST endpoints for every feature, and (c) makes it easy to see how the tables join together. This is a learning and foundation build. We will add features on top afterwards, so keep the code simple and readable, not clever.

The product: a platform where people discover and attend hosted events.

Anyone can pay a fee to join an event's waitlist; an admin reviews each person's profile and approves or rejects.
Events can need a host. People apply to host; the UI shows how many applied; an admin picks.
An event feed with swipe: right swipe = interested (count goes up), left swipe = skip (count unchanged, but remember it so the event isn't shown again). A top events list is ordered by a ranking score.
Partners (cafes, house-party spaces, screening venues) provide the venues for events.
Merchandise is listed (display-only for now).
Events, partners and products have photos, stored in the database for now (S3 later).
2. Stack and conventions
Node.js 20+, TypeScript, Express, pg (node-postgres) with plain SQL (no ORM, so the joins are visible), zod for request validation, multer for uploads, sharp optional for resizing.
PostgreSQL 16 in Docker via docker-compose.yml. Mount schema.sql into /docker-entrypoint-initdb.d/ so the DB initializes on first start. Use port 5432 (or 5433 if taken) and put credentials in .env (commit .env.example only).
Windows + VS Code. Give all shell commands in PowerShell.
Structure:
src/
  index.ts            # server bootstrap
  db.ts               # pg Pool + helper `withTransaction(fn)`
  middleware/         # auth stub, error handler, validate
  routes/             # one file per area: users, partners, events, waitlist, hosts, swipes, media, products, admin
  sql/                # (optional) SQL kept in named constants with comments
requests.http         # REST Client file covering every endpoint, in test order
BACKEND_README.md     # setup, run, join map (section 6)
Every route handler: validate input with zod, parameterized SQL only ($1, $2; never string concatenation), consistent JSON errors ({ "error": "..." }) with correct status codes (400/401/403/404/409).
Auth is a stub for now: read the caller from an x-user-id header, load that user, attach req.user. requireAdmin checks users.role = 'admin'. Add a clear // TODO real auth comment. No passwords or JWT yet.
Payments are a stub: creating a waitlist entry inserts a payments row with provider='mock', provider_ref = random uuid, status='succeeded'. Add a // TODO integrate Stripe/Razorpay comment. Never store card data.
3. Endpoints to build
Annotate each handler with a comment listing which tables it touches.

Area	Endpoint	What it does	Tables involved
Health	GET /health	SELECT 1, returns db ok	none
Users	POST /users	create user + profile in one transaction	users, user_profiles
GET /users/:id	user joined with profile	users, user_profiles
Partners	POST /partners (admin), GET /partners?type=&city=	create/list venues	partners
Events	POST /events (admin)	create event (status draft), trigger creates its stats row	events, event_stats
PATCH /events/:id/publish (admin)	set status published	events
GET /events	published events with partner name/city, cover media id, and stats	events, partners, event_media, event_stats
GET /events/:id	detail: event + partner + media list + approved hosts + stats	events, partners, event_media, event_hosts, users, user_profiles, event_stats
Waitlist	POST /events/:id/waitlist	in ONE transaction: insert mock payment (amount = events.waitlist_fee) and waitlist entry (pending); 409 if already on the waitlist	payments, event_waitlist_entries
GET /admin/events/:id/waitlist?status= (admin)	pending people with profile and payment, for review	event_waitlist_entries, users, user_profiles, payments
PATCH /admin/waitlist/:entryId (admin)	body {status: approved or rejected, note}; set reviewed_by/at; on approve, in a transaction, lock the event row (SELECT ... FOR UPDATE) and return 409 if approved count would exceed capacity; write an audit_log row	event_waitlist_entries, events, audit_log
Hosts	GET /hosts/events	published future events with needs_host = true plus host_applicant_count	events, event_stats, partners
POST /events/:id/host-applications	apply to host (pitch); 409 on duplicate	host_applications
GET /admin/events/:id/host-applications (admin)	applicants with profile	host_applications, users, user_profiles
PATCH /admin/host-applications/:id (admin)	approve or reject; on approve insert into event_hosts; audit log	host_applications, event_hosts, audit_log
Swipes	PUT /events/:id/swipe	body {direction: left or right}; upsert into event_swipes; trigger updates counters	event_swipes, event_stats
GET /events/feed	published upcoming events the caller has NOT swiped on yet (LEFT JOIN event_swipes ... WHERE s.event_id IS NULL)	events, event_swipes, partners, event_media
GET /events/top?limit=10	published events ordered by event_stats.rank_score DESC	events, event_stats
POST /admin/jobs/refresh-rank (admin)	runs SELECT refresh_event_rank_scores()	event_stats
Media	POST /events/:id/media (admin)	multipart image (jpeg/png/webp, max 5 MB); insert media_assets + media_blobs + event_media in a transaction; first image becomes cover	media_assets, media_blobs, event_media
GET /media/:id	stream bytes with Content-Type and Cache-Control: public, max-age=31536000, immutable; 404 if missing	media_assets, media_blobs
Merch	POST /products (admin) with variants array	create product + variants in one transaction	products, product_variants
GET /products	products with their variants and media ids (aggregate with json_agg)	products, product_variants, product_media
Notes:

The media_assets design keeps bytes in media_blobs. Never select data in list queries. Only GET /media/:id reads it. Put a MediaStorage interface (put, get) in front of it (PostgresStorage now) so S3 can be swapped in later.
Stats counters and event_stats creation are done by DB triggers in schema.sql. Do not duplicate that logic in the app.
4. Seed data
Add npm run seed (idempotent): 1 admin, 4 normal users with profiles, 2 partners (a cafe and a screening venue), 3 published events (one with needs_host = true, one with capacity = 2), 1 product with 2 variants. Print the seeded user ids so they can be used in the x-user-id header.

5. Test walkthrough (put this in requests.http, in this order)
GET /health returns ok.
Create partner, create event, publish it, list events, see the partner joined in.
User A and B call POST /events/:id/waitlist. Repeating for A returns 409.
Admin lists the waitlist (sees profiles and payments joined), approves A, rejects B. Approving beyond capacity returns 409.
User C and D apply to host. GET /hosts/events shows host_applicant_count = 2. Admin approves C. GET /events/:id now shows C as host.
User A swipes right, B swipes left. GET /events/top shows interest_count +1 for A only. GET /events/feed for A and B no longer shows that event. Run the rank refresh and confirm ordering.
Upload an image to an event, open GET /media/:id in the browser, confirm it displays and that GET /events returns the cover media id only (no bytes).
Create a product with variants, GET /products shows variants nested.
Show the audit_log rows created by the admin actions.
Also add a small automated smoke test (npm test, Vitest or Jest with supertest) that runs steps 2 to 6 against a test database and asserts the counters.

6. README must include a "How the tables join" section
A Mermaid ER diagram, plus a short table mapping each endpoint to its SQL join, so it is easy to learn from. Core relationships:

users 1:1 user_profiles
partners 1:N events
events 1:1 event_stats
users M:N events via three tables: event_waitlist_entries, host_applications, event_swipes (each has its own status and lifecycle)
event_waitlist_entries 1:1 payments
events M:N media_assets via event_media; the same pattern for partner_media and product_media
media_assets 1:1 media_blobs
products 1:N product_variants
host_applications 1:1 event_hosts (approved only)
7. Out of scope (do NOT build yet)
Real authentication (JWT/OAuth), real payment gateway and refunds, merchandise orders/cart, S3 uploads, notifications, rate limiting, deployment/CI. Keep hooks (TODO comments) where these will plug in.

8. Known gaps to keep in mind (document, don't fix yet)
Rejecting a waitlisted person does not trigger a refund.
The schema doesn't enforce that reviewed_by is an admin; the API does.
rank_score formula in refresh_event_rank_scores() is a placeholder to tune.
Personal data (profiles, phone, DOB) is stored; add privacy and retention handling before production.
9. Definition of done
docker compose up -d starts Postgres with the schema loaded, npm run seed seeds it, npm run dev starts the API, every request in requests.http returns the expected result in order, and npm test passes.