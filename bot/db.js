const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('railway') || process.env.DATABASE_URL.includes('neon'))
        // Neon выдаёт сертификаты публичного центра: проверяем. Для Railway/прочих или аварийно: DB_SSL_STRICT=false
        ? { rejectUnauthorized: process.env.DB_SSL_STRICT === 'false' ? false : process.env.DATABASE_URL.includes('neon') }
        : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
});

// Критично: без этого падение idle-клиента эмитит 'error' на пуле,
// событие никто не ловит, EventEmitter кидает — Node падает.
pool.on('error', (err) => {
    console.error('[pg] idle client error:', err.message);
});

// Инициализация таблиц и миграции
async function initDB() {
    const client = await pool.connect();
    try {
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

        console.log('[OK] База данных инициализирована');
    } catch (e) {
        console.error('[ОШИБКА] Инициализация БД:', e.message);
        // Критично: без rethrow db.init() в bot.js резолвится «успешно»,
        // и дальнейшая работа идёт по битой схеме.
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { pool, initDB };