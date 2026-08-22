const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
});

// Инициализация таблиц
async function initDB() {
    const client = await pool.connect();
    try {
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
        `);

        // Зоны доставки по умолчанию
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
    } finally {
        client.release();
    }
}

module.exports = { pool, initDB };
