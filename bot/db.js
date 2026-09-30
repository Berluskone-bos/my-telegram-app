const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('railway') || process.env.DATABASE_URL.includes('neon'))
        ? { rejectUnauthorized: false }
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

        // ─── Миграции: добавляем то, что появилось в новых версиях ───
        // CREATE TABLE IF NOT EXISTS НЕ добавляет колонки к существующим таблицам.
        await client.query(`
            ALTER TABLE orders
                ADD COLUMN IF NOT EXISTS subtotal      NUMERIC(12,2) NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS discount_code TEXT,
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