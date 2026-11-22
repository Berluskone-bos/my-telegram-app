const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('railway') || process.env.DATABASE_URL.includes('neon'))
        // Neon выдаёт сертификаты публичного центра: проверяем. Для Railway/прочих или аварийно: DB_SSL_STRICT=false
        ? { rejectUnauthorized: process.env.DB_SSL_STRICT === 'false' ? false : process.env.DATABASE_URL.includes('neon') }
        : false,
    max: 10,
    idleTimeoutMillis: 30_000,        // простаивающее соединение закрываем до того, как его оборвёт сеть/прокси
    connectionTimeoutMillis: 5_000,   // не ждём подключения дольше 5 с: лучше быстрый отказ и повтор, чем зависший заказ
    keepAlive: true,                  // TCP keep-alive: обрыв «тихого» соединения обнаруживается быстро
    keepAliveInitialDelayMillis: 10_000,
    application_name: process.env.PG_APP_NAME || 'gulf-bot'   // видно в pg_stat_activity, помогает при разборе обрывов
});

// Пока соединение выдано из пула, пул не слушает его события. Обрыв связи (перезапуск базы, сеть)
// приходит тогда событием 'error' на самом соединении, и без обработчика Node завершает процесс.
// Постоянный обработчик на каждое соединение: обрыв превращается в обычную ошибку запроса, которую ловят вызывающие.
pool.on('connect', (client) => {
    client.on('error', (err) => console.warn('[pg] соединение оборвано:', err.message));
});

// Критично: без этого падение idle-клиента эмитит 'error' на пуле,
// событие никто не ловит, EventEmitter кидает — Node падает.
pool.on('error', (err) => {
    console.error('[pg] idle client error:', err.message);
});

// Инициализация таблиц и миграции
async function initDB() {
    const client = await pool.connect();
    let initLockAcquired = false;
    try {
        // Multiple bot/test processes can call initDB() against the same database.
        // Serialize schema initialization to prevent DDL lock-order deadlocks.
        await client.query('SELECT pg_advisory_lock(73492184720311)');
        initLockAcquired = true;

        // ─── Базовые таблицы (как было) ───
        await client.query(`
            CREATE TABLE IF NOT EXISTS couriers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(128) NOT NULL,
                phone VARCHAR(20),
                telegram_id BIGINT UNIQUE,
                telegram_user VARCHAR(64),
                vehicle_type VARCHAR(32) DEFAULT 'легковая',
                zones TEXT[] DEFAULT '{"spb"}',
                is_active BOOLEAN DEFAULT TRUE,
                max_orders INT DEFAULT 10,
                rating DECIMAL(3,2) DEFAULT 0,
                rating_count INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS delivery_routes (
                id SERIAL PRIMARY KEY,
                route_number VARCHAR(16) UNIQUE NOT NULL,
                route_date DATE NOT NULL,
                courier_id INT REFERENCES couriers(id),
                status VARCHAR(32) DEFAULT 'draft',
                total_orders INT DEFAULT 0,
                completed INT DEFAULT 0,
                failed INT DEFAULT 0,
                cash_to_collect DECIMAL(10,2) DEFAULT 0,
                cash_collected DECIMAL(10,2) DEFAULT 0,
                total_distance DECIMAL(8,2),
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS route_stops (
                id SERIAL PRIMARY KEY,
                route_id INT REFERENCES delivery_routes(id),
                order_id VARCHAR(32),
                order_number VARCHAR(32),
                stop_number INT NOT NULL,
                address TEXT NOT NULL,
                city VARCHAR(128),
                street VARCHAR(256),
                house VARCHAR(32),
                lat DECIMAL(10,7),
                lon DECIMAL(10,7),
                time_window VARCHAR(32),
                status VARCHAR(32) DEFAULT 'pending',
                payment_status VARCHAR(32),
                amount_to_pay DECIMAL(10,2) DEFAULT 0,
                phone VARCHAR(20),
                client_name VARCHAR(128),
                client_chat_id BIGINT,
                items_count INT,
                comment TEXT,
                delivered_at TIMESTAMP,
                fail_reason TEXT,
                photo_file_id TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS delivery_zones (
                id SERIAL PRIMARY KEY,
                name VARCHAR(128),
                zone_code VARCHAR(32) UNIQUE,
                base_cost DECIMAL(10,2),
                free_threshold DECIMAL(10,2),
                is_active BOOLEAN DEFAULT TRUE
            );

            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                order_number VARCHAR(32),
                user_id BIGINT,
                user_name VARCHAR(128),
                phone VARCHAR(20),
                address TEXT,
                zone VARCHAR(32),
                city VARCHAR(128),
                street VARCHAR(256),
                house VARCHAR(32),
                entrance VARCHAR(32),
                apartment VARCHAR(32),
                items JSONB,
                total DECIMAL(10,2),
                discount INT DEFAULT 0,
                delivery_type VARCHAR(32) DEFAULT 'delivery',
                payment VARCHAR(32) DEFAULT 'cash',
                comment TEXT,
                status VARCHAR(32) DEFAULT 'NEW',
                payment_status VARCHAR(32) DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                brand VARCHAR(128),
                category VARCHAR(64),
                name VARCHAR(256) NOT NULL,
                full_name VARCHAR(512),
                series VARCHAR(128),
                sku VARCHAR(64),
                viscosity VARCHAR(32),
                oil_type VARCHAR(64),
                volume VARCHAR(32),
                api_std VARCHAR(16),
                acea VARCHAR(16),
                ilsac VARCHAR(16),
                price DECIMAL(10,2) NOT NULL DEFAULT 0,
                old_price DECIMAL(10,2),
                stock INT DEFAULT 0,
                min_stock INT DEFAULT 3,
                image TEXT,
                gallery JSONB DEFAULT '[]',
                description TEXT,
                specs JSONB DEFAULT '{}',
                active BOOLEAN DEFAULT TRUE,
                is_new BOOLEAN DEFAULT FALSE,
                is_popular BOOLEAN DEFAULT FALSE,
                rating DECIMAL(3,2) DEFAULT 0,
                reviews_count INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);


        // ─── Профили покупателей (ключ — проверенный Telegram user ID) ───
        await client.query(`
            CREATE TABLE IF NOT EXISTS customer_profiles (
                user_id BIGINT PRIMARY KEY,
                name VARCHAR(100) NOT NULL DEFAULT '',
                phone VARCHAR(30) NOT NULL DEFAULT '',
                city VARCHAR(100) NOT NULL DEFAULT '',
                street VARCHAR(200) NOT NULL DEFAULT '',
                house VARCHAR(20) NOT NULL DEFAULT '',
                building VARCHAR(20) NOT NULL DEFAULT '',
                letter VARCHAR(20) NOT NULL DEFAULT '',
                entrance VARCHAR(20) NOT NULL DEFAULT '',
                floor VARCHAR(20) NOT NULL DEFAULT '',
                apartment VARCHAR(20) NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        // ─── Миграции: добавляем то, что появилось в новых версиях ───

        // Профиль покупателя хранит только имя и телефон: один раз стираем адреса, сохранённые раньше
        await client.query(`CREATE TABLE IF NOT EXISTS app_flags (flag TEXT PRIMARY KEY, done_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        // Одноразовая активация складского учёта в production по явному флагу Railway.
        // После успешного запуска флаг окружения нужно выключить; запись в app_flags остаётся постоянной.
        if (process.env.ENABLE_STOCK_TRACKING_ON_STARTUP === 'true') {
            const activated = await client.query(
                "INSERT INTO app_flags (flag) VALUES ('stock_tracking_enabled') ON CONFLICT (flag) DO NOTHING RETURNING flag"
            );
            console.log(activated.rowCount
                ? '[MIGRATION] stock_tracking_enabled activated'
                : '[MIGRATION] stock_tracking_enabled already active');
        }
        const purged = await client.query(`INSERT INTO app_flags (flag) VALUES ('profile_address_purged') ON CONFLICT DO NOTHING RETURNING flag`);
        if (purged.rowCount) {
            await client.query(`UPDATE customer_profiles SET city = '', street = '', house = '', building = '', letter = '', entrance = '', floor = '', apartment = ''`);
        }

        // ─── Бонусы и рефералы (см. referral.js) ───
        await client.query(`
            CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
            INSERT INTO app_settings (key, value) VALUES ('referral_bonus', '200'), ('referral_min_order', '6000'), ('bonus_max_share_pct', '20')
                ON CONFLICT (key) DO NOTHING;
            CREATE TABLE IF NOT EXISTS bonus_ledger (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                delta INT NOT NULL,
                reason TEXT NOT NULL,
                order_id INT,
                note TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS bonus_ledger_user_idx ON bonus_ledger(user_id);
            CREATE UNIQUE INDEX IF NOT EXISTS bonus_ledger_order_reason_idx ON bonus_ledger(order_id, reason) WHERE order_id IS NOT NULL;
            ALTER TABLE orders
                ADD COLUMN IF NOT EXISTS referrer_id BIGINT,
                ADD COLUMN IF NOT EXISTS referral_code VARCHAR(40),
                ADD COLUMN IF NOT EXISTS bonus_used INT NOT NULL DEFAULT 0;
        `);

        // Госномер курьера: код его уже читает и пишет (регистрация курьера, команда в курьер-боте), а в схеме колонки не было
        await client.query(`ALTER TABLE couriers ADD COLUMN IF NOT EXISTS license_plate VARCHAR(20)`);
        await client.query(`ALTER TABLE couriers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);

        // ─── Очередь уведомлений (см. outbox.js) и ссылка на сообщение курьеру ───
        await client.query(`
            CREATE TABLE IF NOT EXISTS notification_outbox (
                id BIGSERIAL PRIMARY KEY,
                bot TEXT NOT NULL,
                method TEXT NOT NULL DEFAULT 'sendMessage',
                payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                dedup_key TEXT,
                depends_on TEXT,
                on_sent JSONB,
                edit_stop_id INT,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INT NOT NULL DEFAULT 0,
                next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                locked_until TIMESTAMPTZ,
                last_error TEXT,
                tg_message_id BIGINT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                sent_at TIMESTAMPTZ
            );
            CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedup_idx ON notification_outbox(dedup_key) WHERE dedup_key IS NOT NULL;
            CREATE INDEX IF NOT EXISTS notification_outbox_due_idx ON notification_outbox(status, next_attempt_at);
            ALTER TABLE route_stops
                ADD COLUMN IF NOT EXISTS courier_chat_id BIGINT,
                ADD COLUMN IF NOT EXISTS courier_message_id BIGINT;
            ALTER TABLE route_stops
                ADD COLUMN IF NOT EXISTS stage VARCHAR(16),
                ADD COLUMN IF NOT EXISTS stage_at TIMESTAMPTZ;
            ALTER TABLE route_stops
                ADD COLUMN IF NOT EXISTS eta_at TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS eta_told_at TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS client_rating SMALLINT CHECK (client_rating BETWEEN 1 AND 5);
        `);

        // ─── Интерактивные карточки Telegram (виджеты, см. widgets.js): где лежит сообщение и что на нём показано ───
        //   kind: tracker (ref = номер заказа) | route (ref = id маршрута) | summary (ref = chat_id админа)
        //   active = false — Telegram карточку не принял или она выключена: тогда работают обычные сообщения
        await client.query(`
            CREATE TABLE IF NOT EXISTS widget_messages (
                kind TEXT NOT NULL,
                ref TEXT NOT NULL,
                chat_id BIGINT,
                message_id BIGINT,
                state JSONB NOT NULL DEFAULT '{}'::jsonb,
                active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (kind, ref)
            );
            CREATE INDEX IF NOT EXISTS widget_messages_msg_idx ON widget_messages(kind, chat_id, message_id);
            ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS edit_ref TEXT;
        `);

        // Старый tracker-widget сохранял факт оценки в widget_messages.state, но не в route_stops.
        // Переносим только достоверные оценки доставленных заказов, чтобы после релиза их нельзя было выставить повторно.
        await client.query(`
            UPDATE route_stops rs
               SET client_rating = (wm.state->>'rating')::smallint
              FROM widget_messages wm
              JOIN orders o ON o.order_number = wm.ref
             WHERE wm.kind = 'tracker'
               AND rs.order_number = wm.ref
               AND rs.status = 'delivered'
               AND rs.client_rating IS NULL
               AND o.status IN ('DELIVERED', 'COMPLETED')
               AND wm.state ? 'rating'
               AND wm.state->>'rating' ~ '^[1-5]$';

            UPDATE widget_messages
               SET state = state || '{"canRate": false}'::jsonb,
                   updated_at = NOW()
             WHERE kind = 'tracker'
               AND state ? 'rating'
               AND state->>'rating' ~ '^[1-5]$'
               AND state->>'canRate' IS DISTINCT FROM 'false';
        `);
        await client.query(`
            ALTER TABLE customer_profiles
                ADD COLUMN IF NOT EXISTS building VARCHAR(20) NOT NULL DEFAULT '',
                ADD COLUMN IF NOT EXISTS letter   VARCHAR(20) NOT NULL DEFAULT '',
                ADD COLUMN IF NOT EXISTS floor    VARCHAR(20) NOT NULL DEFAULT '';
        `);

        // CREATE TABLE IF NOT EXISTS НЕ добавляет колонки к существующим таблицам.
        await client.query(`
            ALTER TABLE orders
                ADD COLUMN IF NOT EXISTS building      VARCHAR(32),
                ADD COLUMN IF NOT EXISTS structure     VARCHAR(32),
                ADD COLUMN IF NOT EXISTS letter        VARCHAR(32),
                ADD COLUMN IF NOT EXISTS floor         VARCHAR(32),
                ADD COLUMN IF NOT EXISTS subtotal      NUMERIC(12,2) NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS discount_code TEXT,
                ADD COLUMN IF NOT EXISTS delivery_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64),
                ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ DEFAULT NOW();
        `);

        // ─── Промокоды ───
        await client.query(`
            CREATE TABLE IF NOT EXISTS promo_codes (
                code        TEXT PRIMARY KEY,
                percent     NUMERIC(5,2) NOT NULL CHECK (percent BETWEEN 1 AND 100),
                max_uses    INTEGER,
                uses_count  INTEGER NOT NULL DEFAULT 0,
                valid_from  TIMESTAMPTZ,
                valid_until TIMESTAMPTZ,
                active      BOOLEAN NOT NULL DEFAULT TRUE
            );
        `);

        // ─── UNIQUE на orders.order_number ───
        // Логически нужен для cancelOrderByNumber. Если в базе уже есть
        // дубликаты (по историческим причинам) — сообщаем и НЕ падаем.
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_indexes WHERE indexname = 'orders_order_number_key'
                ) THEN
                    IF EXISTS (
                        SELECT 1 FROM orders
                         WHERE order_number IS NOT NULL
                         GROUP BY order_number
                        HAVING COUNT(*) > 1
                    ) THEN
                        RAISE WARNING 'orders.order_number содержит дубликаты — UNIQUE-индекс не создан. Устраните дубликаты и перезапустите.';
                    ELSE
                        CREATE UNIQUE INDEX orders_order_number_key ON orders(order_number);
                    END IF;
                END IF;
            END $$;
        `);

        // Подбор масла: кэш PartsAPI, автомобили, допуски
        await client.query(`CREATE TABLE IF NOT EXISTS api_cache (
  cache_key   TEXT PRIMARY KEY,          -- например: toDopusk|typeId=9318
  method      VARCHAR(50) NOT NULL,
  response    JSONB NOT NULL,
  is_empty    BOOLEAN NOT NULL DEFAULT false,   -- ответ без данных (кэшируется на короткий срок)
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_cache_method ON api_cache (method);
CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache (expires_at);



CREATE TABLE IF NOT EXISTS api_request_log (
  id          BIGSERIAL PRIMARY KEY,
  method      VARCHAR(50) NOT NULL,
  ok          BOOLEAN NOT NULL,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_log_created ON api_request_log (created_at);

-- Вход в админку: сессии (в БД только хэш токена) и журнал действий
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  role        TEXT NOT NULL DEFAULT 'admin',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session TEXT,
  ip      TEXT,
  action  TEXT NOT NULL,
  method  TEXT,
  path    TEXT,
  status  INT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at DESC);

-- Общий persistent rate limit для входа в админку. IP хранится только в виде SHA-256.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip_hash           CHAR(64) PRIMARY KEY,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until     TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_updated ON admin_login_attempts (updated_at);


CREATE TABLE IF NOT EXISTS to_vehicles (
  type_id         BIGINT PRIMARY KEY,       -- typeId из toTypes (каталог ТО PartsAPI)
  brand_id        INTEGER,
  brand_name      VARCHAR(100) NOT NULL DEFAULT '',
  model_id        INTEGER,
  model_name      VARCHAR(200) NOT NULL DEFAULT '',
  full_name       VARCHAR(250),
  engine_code     VARCHAR(50),
  engine_capacity NUMERIC(4,1),
  horse_power     INTEGER,
  fuel            VARCHAR(50),
  start_date      DATE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicles (
  car_id        BIGINT PRIMARY KEY,       -- CAR_ID из getCars / carId из VINdecode
  make_id       INTEGER,
  make_name     VARCHAR(100) NOT NULL,
  model_id      INTEGER,
  model_name    VARCHAR(200) NOT NULL,
  modification  VARCHAR(200),
  engine_type   VARCHAR(50),
  capacity      VARCHAR(30),
  power_ps      NUMERIC(7,1),
  year_from     DATE,
  year_to       DATE,                     -- NULL = выпускается до сих пор
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS vin_lookup (
  vin         VARCHAR(17) PRIMARY KEY,
  car_id      BIGINT REFERENCES vehicles(car_id),
  raw         JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS vehicle_fill_volumes (
  id          BIGSERIAL PRIMARY KEY,
  car_id      BIGINT NOT NULL REFERENCES vehicles(car_id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,      -- "Моторное масло с фильтром"
  info        VARCHAR(200),               -- "SAE 5W-30"
  unit        VARCHAR(10),                -- л / г / см³ / NULL (если это код спецификации)
  value_text  VARCHAR(100) NOT NULL,      -- "6,45" или "510 - 530" или код "WSS-M2C913-C"
  UNIQUE (car_id, title, info, unit, value_text)
);


CREATE TABLE IF NOT EXISTS vehicle_approvals (
  id          BIGSERIAL PRIMARY KEY,
  car_id      BIGINT NOT NULL REFERENCES vehicles(car_id) ON DELETE CASCADE,
  fluid       VARCHAR(100) NOT NULL,      -- "Масло моторное", "Тормозная жидкость"
  approval_type VARCHAR(100),             -- "Допуски OEM", "Спецификация FMVSS 116"
  approval    VARCHAR(100) NOT NULL,      -- "VW 504 00", "DOT 4"
  UNIQUE (car_id, fluid, approval)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_approvals_approval ON vehicle_approvals (approval);


CREATE TABLE IF NOT EXISTS vehicle_oil_items (
  id          BIGSERIAL PRIMARY KEY,
  car_id      BIGINT NOT NULL REFERENCES vehicles(car_id) ON DELETE CASCADE,
  fluid       VARCHAR(100) NOT NULL,
  spec_group  VARCHAR(200) NOT NULL,      -- "VAG LongLife III 0W-30"
  article     VARCHAR(50) NOT NULL,
  brand       VARCHAR(100),
  pack_liters NUMERIC(6,2),
  priority    INTEGER,
  UNIQUE (car_id, article)
);




CREATE TABLE IF NOT EXISTS product_approvals (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  approval    VARCHAR(100) NOT NULL,      -- "VW 504 00", "MB 229.5", "ACEA C3"
  UNIQUE (product_id, approval)
);
CREATE INDEX IF NOT EXISTS idx_product_approvals_approval ON product_approvals (approval);


CREATE TABLE IF NOT EXISTS user_garage (
  id          SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  car_id      BIGINT NOT NULL REFERENCES vehicles(car_id),
  vin         VARCHAR(17),
  nickname    VARCHAR(100),               -- "Моя Audi"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, car_id)
);
CREATE INDEX IF NOT EXISTS idx_user_garage_tg ON user_garage (telegram_id);`);
        // Каталог: признак «скоро в продаже» и отметка, что остаток по заказу уже списан
        await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS coming_soon BOOLEAN NOT NULL DEFAULT false`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_deducted BOOLEAN NOT NULL DEFAULT false`);

        // Неизменяемый журнал складских движений. Исторические остатки не backfill-им:
        // начальные балансы появятся только после отдельной инвентаризации.
        await client.query(`
            CREATE TABLE IF NOT EXISTS stock_movements (
                id BIGSERIAL PRIMARY KEY,
                product_id INTEGER, -- исторический ID товара; не FK, чтобы append-only журнал не переписывался при удалении товара
                movement_type TEXT NOT NULL CHECK (movement_type IN ('order_deduction', 'order_return', 'manual_adjustment')),
                qty_delta INTEGER NOT NULL CHECK (qty_delta <> 0),
                stock_before INTEGER NOT NULL CHECK (stock_before >= 0),
                stock_after INTEGER NOT NULL CHECK (stock_after >= 0),
                order_id INTEGER, -- исторический ID заказа; не FK, чтобы сохранять неизменность журнала
                actor_user_id BIGINT,
                actor_role VARCHAR(20),
                reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
                operation_key TEXT NOT NULL UNIQUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (stock_after - stock_before = qty_delta)
            );
            CREATE INDEX IF NOT EXISTS stock_movements_product_created_idx
                ON stock_movements(product_id, created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS stock_movements_order_idx
                ON stock_movements(order_id) WHERE order_id IS NOT NULL;
            CREATE OR REPLACE FUNCTION reject_stock_movement_mutation()
            RETURNS trigger LANGUAGE plpgsql AS 'BEGIN
                RAISE EXCEPTION ''stock_movements is append-only'' USING ERRCODE = ''55000'';
            END;';
            DROP TRIGGER IF EXISTS stock_movements_append_only ON stock_movements;
            CREATE TRIGGER stock_movements_append_only
                BEFORE UPDATE OR DELETE ON stock_movements
                FOR EACH ROW EXECUTE FUNCTION reject_stock_movement_mutation();
        `);
        // История заказов клиента: «удаление» из истории только скрывает заказ у клиента, запись остаётся в учёте
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_hidden BOOLEAN NOT NULL DEFAULT false`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders (user_id, id DESC)`);

        // Шкала скидок по накопленному обороту (PRD, решено 25.10.2026). Оборот — доставленные и завершённые заказы клиента.
        await client.query(`CREATE TABLE IF NOT EXISTS loyalty_tiers (
            min_turnover NUMERIC(12,2) PRIMARY KEY,
            percent      NUMERIC(5,2)  NOT NULL CHECK (percent >= 0 AND percent <= 100),
            name         TEXT          NOT NULL
        )`);
        await client.query(`INSERT INTO loyalty_tiers (min_turnover, percent, name)
            SELECT v.m, v.p, v.n FROM (VALUES (0, 3, 'Железный'), (15000, 5, 'Бронзовый'), (40000, 7, 'Серебряный'), (100000, 10, 'Золотой')) AS v(m, p, n)
             WHERE NOT EXISTS (SELECT 1 FROM loyalty_tiers)`);
        // Идемпотентность: один ключ операции = один заказ (защита на уровне БД)
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_idx
                            ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
        // Тариф СПб по решению владельца: 300 руб., бесплатно от 5000 руб.
        // Выполняется ОДИН раз (метка в app_flags), чтобы не затирать тарифы, изменённые позже в админке
        await client.query(`CREATE TABLE IF NOT EXISTS app_flags (flag TEXT PRIMARY KEY, done_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        const flag = await client.query(`INSERT INTO app_flags (flag) VALUES ('spb_tariff_300_5000') ON CONFLICT DO NOTHING RETURNING flag`);
        if (flag.rowCount) {
            await client.query(`UPDATE delivery_zones SET base_cost = 300, free_threshold = 5000 WHERE zone_code = 'spb'`);
        }

        // ─── Индексы для типовых запросов ───
        await client.query(`
            CREATE INDEX IF NOT EXISTS route_stops_order_number_idx ON route_stops(order_number);
            CREATE INDEX IF NOT EXISTS route_stops_route_id_idx     ON route_stops(route_id);
            CREATE INDEX IF NOT EXISTS route_stops_status_idx       ON route_stops(status);
            CREATE INDEX IF NOT EXISTS orders_status_idx            ON orders(status);
            CREATE INDEX IF NOT EXISTS orders_created_at_idx        ON orders(created_at DESC);
            CREATE INDEX IF NOT EXISTS orders_user_id_idx           ON orders(user_id);
        `);

        // ─── Зоны доставки по умолчанию ───
        await client.query(`
            INSERT INTO delivery_zones (name, zone_code, base_cost, free_threshold)
            VALUES
                ('Санкт-Петербург', 'spb', 300, 3000),
                ('ЛО — ближняя зона', 'lo_near', 500, 5000),
                ('ЛО — средняя зона', 'lo_mid', 800, 8000),
                ('ЛО — дальняя зона', 'lo_far', 0, 0),
                ('Самовывоз', 'pickup', 0, 0)
            ON CONFLICT (zone_code) DO NOTHING;
        `);


        // ─── Учётные записи сотрудников и привязка серверных сессий ───
        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id BIGSERIAL PRIMARY KEY,
                login VARCHAR(64) NOT NULL,
                display_name VARCHAR(100) NOT NULL,
                password_hash TEXT NOT NULL,
                role VARCHAR(20) NOT NULL CHECK (role IN ('admin','manager','operator','warehouse')),
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS admin_users_login_lower_uidx ON admin_users (LOWER(login));
            ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS staff_user_id BIGINT REFERENCES admin_users(id) ON DELETE CASCADE;
            CREATE INDEX IF NOT EXISTS admin_sessions_staff_user_idx ON admin_sessions(staff_user_id);
            ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS actor_user_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL;
            ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS actor_role VARCHAR(20);
        `);
        console.log('[OK] База данных инициализирована');
    } catch (e) {
        console.error('[ОШИБКА] Инициализация БД:', e.message);
        // Критично: без rethrow db.init() в bot.js резолвится «успешно»,
        // и дальнейшая работа идёт по битой схеме.
        throw e;
    } finally {
        if (initLockAcquired) {
            try {
                await client.query('SELECT pg_advisory_unlock(73492184720311)');
            } catch (unlockError) {
                console.error('[ОШИБКА] Не удалось снять блокировку initDB:', unlockError.message);
            }
        }
        client.release();
    }
}

module.exports = { pool, initDB };