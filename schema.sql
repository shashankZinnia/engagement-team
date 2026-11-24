-- =====================================================================
-- Events platform: PostgreSQL schema (v1)
-- Requires PostgreSQL 13+ (gen_random_uuid is built in)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
CREATE TYPE user_role       AS ENUM ('user', 'admin');
CREATE TYPE event_status    AS ENUM ('draft', 'published', 'cancelled', 'completed');
CREATE TYPE review_status   AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
CREATE TYPE partner_type    AS ENUM ('cafe', 'house_party_space', 'screening_venue');
CREATE TYPE payment_status  AS ENUM ('initiated', 'succeeded', 'failed', 'refunded');
CREATE TYPE swipe_direction AS ENUM ('left', 'right');
CREATE TYPE media_storage   AS ENUM ('db', 's3');

-- ---------------------------------------------------------------------
-- Shared helper: keep updated_at fresh
-- ---------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext NOT NULL UNIQUE,
  phone       text UNIQUE,
  role        user_role NOT NULL DEFAULT 'user',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Profile data the admin reviews before approving waitlisted people
CREATE TABLE user_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name        text NOT NULL,
  bio              text,
  city             text,
  date_of_birth    date,
  instagram_handle text,
  avatar_media_id  uuid,  -- FK added after media_assets exists
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_user_profiles_updated BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Media (stored in DB now, move to S3 later by flipping `storage`)
-- Metadata and bytes are in separate tables so listings never load bytes.
-- ---------------------------------------------------------------------
CREATE TABLE media_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage      media_storage NOT NULL DEFAULT 'db',
  storage_key  text UNIQUE,                    -- S3 key once migrated
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes   int  NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5 * 1024 * 1024),
  width        int,
  height       int,
  alt_text     text,
  uploaded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((storage = 's3') = (storage_key IS NOT NULL))
);

CREATE TABLE media_blobs (
  media_id uuid PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
  data     bytea NOT NULL
);

ALTER TABLE user_profiles
  ADD CONSTRAINT fk_user_profiles_avatar
  FOREIGN KEY (avatar_media_id) REFERENCES media_assets(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Partners (cafes, house-party spaces, screening venues)
-- ---------------------------------------------------------------------
CREATE TABLE partners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          partner_type NOT NULL,
  name          text NOT NULL,
  description   text,
  address       text,
  city          text,
  lat           numeric(9,6) CHECK (lat BETWEEN -90 AND 90),
  lng           numeric(9,6) CHECK (lng BETWEEN -180 AND 180),
  contact_name  text,
  contact_phone text,
  contact_email citext,
  capacity      int CHECK (capacity > 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_partners_city_type ON partners (city, type) WHERE is_active;
CREATE TRIGGER trg_partners_updated BEFORE UPDATE ON partners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE partner_media (
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  sort_order int  NOT NULL DEFAULT 0,
  PRIMARY KEY (partner_id, media_id)
);

-- ---------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------
CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   uuid REFERENCES partners(id),
  title        text NOT NULL,
  description  text,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz,
  capacity     int CHECK (capacity > 0),
  waitlist_fee numeric(12,2) NOT NULL DEFAULT 0 CHECK (waitlist_fee >= 0),
  currency     char(3) NOT NULL DEFAULT 'INR',
  needs_host   boolean NOT NULL DEFAULT false,
  status       event_status NOT NULL DEFAULT 'draft',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX idx_events_status_start ON events (status, starts_at);
CREATE INDEX idx_events_partner ON events (partner_id);
CREATE INDEX idx_events_needs_host ON events (starts_at) WHERE needs_host AND status = 'published';
CREATE TRIGGER trg_events_updated BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE event_media (
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  is_cover   boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, media_id)
);
CREATE UNIQUE INDEX uq_event_one_cover ON event_media (event_id) WHERE is_cover;

-- ---------------------------------------------------------------------
-- Payments (never store card data; keep provider reference only)
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  amount       numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency     char(3) NOT NULL,
  provider     text NOT NULL,
  provider_ref text NOT NULL,
  status       payment_status NOT NULL DEFAULT 'initiated',
  refunded_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX idx_payments_user ON payments (user_id);
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Attendee waitlist: user pays, admin reviews profile, approves/rejects
-- ---------------------------------------------------------------------
CREATE TABLE event_waitlist_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  payment_id  uuid UNIQUE REFERENCES payments(id),
  status      review_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id),
  CHECK (status IN ('pending', 'cancelled') OR reviewed_by IS NOT NULL)
);
CREATE INDEX idx_waitlist_event_status ON event_waitlist_entries (event_id, status);
CREATE INDEX idx_waitlist_user ON event_waitlist_entries (user_id);
CREATE TRIGGER trg_waitlist_updated BEFORE UPDATE ON event_waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Host applications and approved hosts
-- ---------------------------------------------------------------------
CREATE TABLE host_applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  pitch       text,
  status      review_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id),
  CHECK (status IN ('pending', 'cancelled') OR reviewed_by IS NOT NULL)
);
CREATE INDEX idx_host_apps_event_status ON host_applications (event_id, status);
CREATE TRIGGER trg_host_apps_updated BEFORE UPDATE ON host_applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE event_hosts (
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id),
  application_id uuid UNIQUE REFERENCES host_applications(id),
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- ---------------------------------------------------------------------
-- Swipes (left swipes are kept so we never show the event again)
-- ---------------------------------------------------------------------
CREATE TABLE event_swipes (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  direction  swipe_direction NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX idx_swipes_event_dir ON event_swipes (event_id, direction);
CREATE TRIGGER trg_swipes_updated BEFORE UPDATE ON event_swipes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Derived counters + ranking, one row per event
-- ---------------------------------------------------------------------
CREATE TABLE event_stats (
  event_id             uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  interest_count       int NOT NULL DEFAULT 0,   -- right swipes
  waitlist_count       int NOT NULL DEFAULT 0,   -- pending + approved
  host_applicant_count int NOT NULL DEFAULT 0,   -- pending applications
  rank_score           numeric NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_stats_rank ON event_stats (rank_score DESC);

-- Recompute counters for one event (simple and always correct)
CREATE FUNCTION recompute_event_stats(p_event_id uuid) RETURNS void AS $$
BEGIN
  INSERT INTO event_stats AS s (event_id, interest_count, waitlist_count, host_applicant_count)
  VALUES (
    p_event_id,
    (SELECT count(*) FROM event_swipes WHERE event_id = p_event_id AND direction = 'right'),
    (SELECT count(*) FROM event_waitlist_entries WHERE event_id = p_event_id AND status IN ('pending','approved')),
    (SELECT count(*) FROM host_applications WHERE event_id = p_event_id AND status = 'pending')
  )
  ON CONFLICT (event_id) DO UPDATE SET
    interest_count       = EXCLUDED.interest_count,
    waitlist_count       = EXCLUDED.waitlist_count,
    host_applicant_count = EXCLUDED.host_applicant_count,
    updated_at           = now();
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION trg_recompute_event_stats() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM recompute_event_stats(NEW.event_id);
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.event_id <> NEW.event_id) THEN
    PERFORM recompute_event_stats(OLD.event_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_swipes_stats AFTER INSERT OR UPDATE OR DELETE ON event_swipes
  FOR EACH ROW EXECUTE FUNCTION trg_recompute_event_stats();
CREATE TRIGGER trg_waitlist_stats AFTER INSERT OR UPDATE OR DELETE ON event_waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION trg_recompute_event_stats();
CREATE TRIGGER trg_host_apps_stats AFTER INSERT OR UPDATE OR DELETE ON host_applications
  FOR EACH ROW EXECUTE FUNCTION trg_recompute_event_stats();

-- Create the stats row when an event is created
CREATE FUNCTION trg_event_create_stats() RETURNS trigger AS $$
BEGIN
  INSERT INTO event_stats (event_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_events_stats AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION trg_event_create_stats();

-- Ranking: run from a scheduled job (pg_cron / EventBridge) every few minutes.
-- score = (interest + 3 * waitlist) decayed as the event gets further away.
CREATE FUNCTION refresh_event_rank_scores() RETURNS void AS $$
  UPDATE event_stats s
  SET rank_score = (s.interest_count + 3 * s.waitlist_count)
                   / (1 + greatest(extract(epoch FROM (e.starts_at - now())) / 86400, 0) / 7.0),
      updated_at = now()
  FROM events e
  WHERE e.id = s.event_id AND e.status = 'published';
$$ LANGUAGE sql;

-- ---------------------------------------------------------------------
-- Merchandise (display-only for now; orders come later)
-- ---------------------------------------------------------------------
CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_variants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku        text NOT NULL UNIQUE,
  size       text,
  color      text,
  price      numeric(12,2) NOT NULL CHECK (price >= 0),
  currency   char(3) NOT NULL DEFAULT 'INR',
  stock      int NOT NULL DEFAULT 0 CHECK (stock >= 0)
);
CREATE INDEX idx_variants_product ON product_variants (product_id);

CREATE TABLE product_media (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  sort_order int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, media_id)
);

-- ---------------------------------------------------------------------
-- Audit log (append-only; admin approvals, status changes, etc.)
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_log (actor_id, created_at DESC);
