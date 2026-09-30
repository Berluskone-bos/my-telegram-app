const { pool, initDB } = require('./db');

// ───────────────────────────────────────────
// Сериализация значений для node-pg
// ───────────────────────────────────────────
// typeof null === 'object' — JSON.stringify(null) даёт строку 'null',
// массивы (zones: text[]) должны уходить в PG как массив, а не как JSON-строка.
function toDbValue(val) {
    if (val === null || val === undefined) return null;
    if (Array.isArray(val)) return val;                    // node-pg сериализует сам
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
}

class DBAdapter {
    constructor() {
        this.initialized = false;
        this._initPromise = null;
        this.promoEnabled = null;   // null = не проверяли, true/false = результат detect
    }

    async init() {
        if (!this._initPromise) {
            this._initPromise = (async () => {
                await initDB();
                await this._detectPromoTable();
                this.initialized = true;
            })();
        }
        return this._initPromise;
    }

    async _detectPromoTable() {
        try {
            await pool.query('SELECT 1 FROM promo_codes LIMIT 1');
            this.promoEnabled = true;
            console.log('[db] promo_codes: доступна, промокоды включены');
        } catch (e) {
            if (e.code === '42P01') {
                this.promoEnabled = false;
                console.warn('[db] promo_codes не найдена — промокоды отключены');
            } else {
                throw e;
            }
        }
    }

    // ───────────────────────────────────────────
    // Курьеры
    // ───────────────────────────────────────────

    async getCouriers() {
        const res = await pool.query('SELECT * FROM couriers ORDER BY id');
        return res.rows;
    }

    async updateCourier(courierId, updates) {
        const allowed = ['name', 'phone', 'telegram_user', 'vehicle_type', 'license_plate', 'zones', 'is_active', 'max_orders'];
        const setFields = [];
        const values = [];
        let idx = 1;
        for (const [key, val] of Object.entries(updates)) {
            if (allowed.includes(key) && val !== undefined) {
                setFields.push(`${key} = $${idx}`);
                values.push(toDbValue(val));
                idx++;
            }
        }
        if (setFields.length === 0) return null;
        values.push(courierId);
        const res = await pool.query(
            `UPDATE couriers SET ${setFields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );
        return res.rows[0] || null;
    }

    async getCourierByTelegramId(telegramId) {
        const res = await pool.query('SELECT * FROM couriers WHERE telegram_id = $1', [telegramId]);
        return res.rows[0] || null;
    }

    async createCourier(courier) {
        const res = await pool.query(
            `INSERT INTO couriers (name, phone, telegram_id, telegram_user, vehicle_type, license_plate, zones, is_active, max_orders, rating, rating_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [courier.name, courier.phone, courier.telegram_id, courier.telegram_user,
             courier.vehicle_type, courier.license_plate || null,
             toDbValue(courier.zones || ['spb']),        // массив, не JSON
             courier.is_active !== false,
             courier.max_orders || 10, courier.rating || 0, courier.rating_count || 0]
        );
        return res.rows[0];
    }

    async updateCourierRating(courierId, rating) {
        const id = Number(courierId);
        const r = Number(rating);
        if (!Number.isInteger(id) || !Number.isInteger(r) || r < 1 || r > 5) return false;

        const res = await pool.query(
            `UPDATE couriers
                SET rating = (rating::numeric * rating_count + $1) / (rating_count + 1),
                    rating_count = rating_count + 1
              WHERE id = $2 RETURNING *`,
            [r, id]
        );
        // Контракт с bot.js: false = промах, объект = успех.
        return res.rows[0] || false;
    }

    // ───────────────────────────────────────────
    // Маршруты
    // ───────────────────────────────────────────

    async getRoutes() {
        const res = await pool.query(`
            SELECT dr.*,
                   COALESCE(
                       json_agg(rs.* ORDER BY rs.stop_number)
                       FILTER (WHERE rs.id IS NOT NULL),
                       '[]'::json
                   ) AS stops
            FROM delivery_routes dr
            LEFT JOIN route_stops rs ON rs.route_id = dr.id
            GROUP BY dr.id
            ORDER BY dr.id DESC
        `);
        return res.rows;
    }

    async getRoutesByDateAndCourier(date, courierId) {
        const res = await pool.query(`
            SELECT dr.*,
                   COALESCE(
                       json_agg(rs.* ORDER BY rs.stop_number)
                       FILTER (WHERE rs.id IS NOT NULL),
                       '[]'::json
                   ) AS stops
            FROM delivery_routes dr
            LEFT JOIN route_stops rs ON rs.route_id = dr.id
            WHERE dr.route_date::date = $1::date AND dr.courier_id = $2
            GROUP BY dr.id
            ORDER BY dr.id
        `, [date, courierId]);
        return res.rows;
    }

    async getRouteById(routeId) {
        const res = await pool.query(`
            SELECT dr.*,
                   COALESCE(
                       json_agg(rs.* ORDER BY rs.stop_number)
                       FILTER (WHERE rs.id IS NOT NULL),
                       '[]'::json
                   ) AS stops
            FROM delivery_routes dr
            LEFT JOIN route_stops rs ON rs.route_id = dr.id
            WHERE dr.id = $1
            GROUP BY dr.id
        `, [routeId]);
        return res.rows[0] || null;
    }

    async createRoute(route) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const routeRes = await client.query(
                `INSERT INTO delivery_routes (route_number, route_date, courier_id, status, total_orders, completed, failed, cash_to_collect, cash_collected, total_distance)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [route.route_number, route.route_date, route.courier_id, route.status || 'draft',
                 route.total_orders || 0, route.completed || 0, route.failed || 0,
                 route.cash_to_collect || 0, route.cash_collected || 0, route.total_distance]
            );

            const newRoute = routeRes.rows[0];
            const stops = [];

            if (route.stops && route.stops.length > 0) {
                for (const stop of route.stops) {
                    const stopRes = await client.query(
                        `INSERT INTO route_stops (route_id, order_id, order_number, stop_number, address, city, street, house, lat, lon, time_window, status, payment_status, amount_to_pay, phone, client_name, client_chat_id, items_count, comment)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
                        [newRoute.id, stop.order_id, stop.order_number,
                         stop.stop_number || stops.length + 1,
                         stop.address, stop.city, stop.street, stop.house, stop.lat, stop.lon,
                         stop.time_window, stop.status || 'pending', stop.payment_status,
                         stop.amount_to_pay || 0, stop.phone, stop.client_name, stop.client_chat_id,
                         stop.items_count, stop.comment]
                    );
                    stops.push(stopRes.rows[0]);
                }
            }

            await client.query('COMMIT');
            return { ...newRoute, stops };
        } catch (e) {
            // ROLLBACK может упасть сам — не должен маскировать исходную ошибку
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }

    async updateRouteStatus(routeId, status, completed, failed) {
        const id = Number(routeId);
        if (!Number.isInteger(id)) return null;
        const res = await pool.query(
            `UPDATE delivery_routes SET status = $1::text, completed = $2::int, failed = $3::int,
             started_at = CASE WHEN $1::text = 'in_progress' AND started_at IS NULL THEN NOW() ELSE started_at END,
             completed_at = CASE WHEN $1::text = 'completed' THEN NOW() ELSE completed_at END
             WHERE id = $4::int RETURNING *`,
            [String(status), parseInt(completed) || 0, parseInt(failed) || 0, id]
        );
        return res.rows[0] || null;
    }

    async updateStopStatus(stopId, status, reason) {
        const id = Number(stopId);
        if (!Number.isInteger(id)) return null;
        const res = await pool.query(
            `UPDATE route_stops
                SET status = $1::text,
                    fail_reason = $2::text,
                    delivered_at = CASE WHEN $1::text = 'delivered' THEN NOW() ELSE delivered_at END
              WHERE id = $3::int RETURNING *`,
            [String(status), reason ? String(reason) : null, id]
        );
        return res.rows[0] || null;
    }

    async updateStopPhoto(stopId, photoFileId) {
        const id = Number(stopId);
        if (!Number.isInteger(id)) return;
        await pool.query('UPDATE route_stops SET photo_file_id = $1 WHERE id = $2', [photoFileId, id]);
    }

    // ───────────────────────────────────────────
    // Заказы
    // ───────────────────────────────────────────

    async getOrders() {
        const res = await pool.query('SELECT * FROM orders ORDER BY id DESC');
        return res.rows;
    }

    async createOrder(order) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const res = await client.query(
                `INSERT INTO orders (order_number, user_id, user_name, phone, address, zone, city, street, house,
                                     entrance, apartment, items, subtotal, total, discount, discount_code,
                                     delivery_type, payment, comment, status, payment_status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
                [order.order_number, order.user_id, order.user_name, order.phone, order.address,
                 order.zone, order.city, order.street, order.house, order.entrance, order.apartment,
                 JSON.stringify(order.items || []),
                 order.subtotal || 0,
                 order.total,
                 order.discount || 0,
                 order.discount_code || null,
                 order.delivery_type || 'delivery',
                 order.payment || 'cash',
                 order.comment,
                 order.status || 'NEW',
                 order.payment_status || 'PENDING']
            );

            // Инкремент использований промокода — в той же транзакции,
            // чтобы «списанный» промокод не остался на откатившемся заказе.
            if (order.discount_code && this.promoEnabled === true) {
                await client.query(
                    `UPDATE promo_codes
                        SET uses_count = uses_count + 1
                      WHERE UPPER(TRIM(code)) = UPPER(TRIM($1))
                        AND (max_uses IS NULL OR uses_count < max_uses)`,
                    [String(order.discount_code)]
                );
            }

            await client.query('COMMIT');
            return res.rows[0];
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }

    // ───────────────────────────────────────────
    // Отмена / смена статуса
    // ───────────────────────────────────────────

    async updateOrderStatus(orderId, status) {
        // 'AP-…' — не PK, отвечаем «не найдено» вместо 22P02 от Postgres.
        const id = Number(orderId);
        if (!Number.isInteger(id) || id <= 0) return false;
        const res = await pool.query(
            'UPDATE orders SET status = $1 WHERE id = $2 RETURNING id',
            [status, id]
        );
        return res.rowCount > 0;
    }

    async cancelOrderByNumber(orderNumber) {
        if (!orderNumber || typeof orderNumber !== 'string') return false;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const res = await client.query(
                `UPDATE orders
                    SET status = 'CANCELLED'
                  WHERE order_number = $1
                    AND status NOT IN ('CANCELLED', 'DELIVERED', 'COMPLETED')
                 RETURNING id`,
                [orderNumber]
            );

            if (res.rowCount === 0) {
                await client.query('ROLLBACK').catch(() => {});
                return false;
            }

            // Убираем из активных остановок маршрута, чтобы курьер
            // не приехал по отменённому адресу.
            await client.query(
                `UPDATE route_stops
                    SET status = 'cancelled'
                  WHERE order_number = $1
                    AND status IN ('pending', 'in_progress')`,
                [orderNumber]
            );

            await client.query('COMMIT');
            return true;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }

    async getOrderByOrderNumber(orderNumber) {
        const res = await pool.query(
            'SELECT * FROM orders WHERE order_number = $1',
            [orderNumber]
        );
        return res.rows[0] || null;
    }

    async getOrderById(id) {
        const numId = Number(id);
        if (!Number.isInteger(numId)) return null;
        const res = await pool.query('SELECT * FROM orders WHERE id = $1', [numId]);
        return res.rows[0] || null;
    }

    // Устаревшее имя: ищет по PK, а не по order_number. Оставлено для совместимости.
    // Используйте getOrderById / getOrderByOrderNumber.
    async getOrderByNumber(orderId) {
        return this.getOrderById(orderId);
    }

    async deleteAllOrders() {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM route_stops');
            await client.query('DELETE FROM delivery_routes');
            await client.query('DELETE FROM orders');
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }

    // ───────────────────────────────────────────
    // Промокоды
    // ───────────────────────────────────────────

    async getDiscountByCode(code) {
        if (this.promoEnabled === false) return null;
        if (!code || typeof code !== 'string') return null;
        const trimmed = code.trim();
        if (!trimmed || trimmed.length > 50) return null;

        try {
            const res = await pool.query(
                `SELECT code, percent, max_uses, uses_count
                   FROM promo_codes
                  WHERE UPPER(TRIM(code)) = UPPER(TRIM($1))
                    AND active = true
                    AND percent BETWEEN 1 AND 100
                    AND (valid_from  IS NULL OR valid_from  <= NOW())
                    AND (valid_until IS NULL OR valid_until >= NOW())
                    AND (max_uses    IS NULL OR uses_count < max_uses)
                  LIMIT 1`,
                [trimmed]
            );
            return res.rows[0] || null;
        } catch (e) {
            if (e.code === '42P01') {
                // таблицы нет — один раз фиксируем и больше не шумим
                this.promoEnabled = false;
                console.warn('[db] promo_codes не найдена — промокоды отключены');
                return null;
            }
            throw e;
        }
    }

    // ───────────────────────────────────────────
    // Зоны
    // ───────────────────────────────────────────

    async getZones() {
        const res = await pool.query('SELECT * FROM delivery_zones WHERE is_active = true ORDER BY id');
        return res.rows;
    }

    // ───────────────────────────────────────────
    // Статистика / аналитика
    // ───────────────────────────────────────────

    async getDayStats(date) {
        const res = await pool.query(`
            SELECT
                COUNT(*) as total_routes,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_routes,
                COALESCE(SUM(total_orders), 0) as total_orders,
                COALESCE(SUM(completed), 0) as delivered,
                COALESCE(SUM(failed), 0) as failed,
                COALESCE(SUM(total_orders) - SUM(completed) - SUM(failed), 0) as pending,
                COALESCE(SUM(cash_to_collect), 0) as cash_to_collect,
                COALESCE(SUM(cash_collected), 0) as cash_collected
            FROM delivery_routes
            WHERE route_date::date = $1::date
        `, [date]);
        return { date, ...res.rows[0] };
    }

    async getAnalytics(dateFrom, dateTo) {
        const summaryRes = await pool.query(`
            SELECT
                COUNT(*) as total_routes,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_routes,
                COALESCE(SUM(total_orders), 0) as total_stops,
                COALESCE(SUM(completed), 0) as delivered,
                COALESCE(SUM(failed), 0) as failed,
                COALESCE(SUM(total_distance), 0) as total_distance_km,
                COALESCE(SUM(cash_to_collect), 0) as cash_to_collect,
                COALESCE(SUM(cash_collected), 0) as cash_collected
            FROM delivery_routes
            WHERE route_date::date BETWEEN $1::date AND $2::date
        `, [dateFrom, dateTo]);

        const avgTimeRes = await pool.query(`
            SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60), 0) as avg_time
            FROM delivery_routes
            WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
            AND route_date::date BETWEEN $1::date AND $2::date
        `, [dateFrom, dateTo]);

        const couriersRes = await pool.query(`
            SELECT c.id, c.name, c.rating, c.rating_count,
                COUNT(dr.id) as routes,
                COALESCE(SUM(dr.completed), 0) as delivered,
                COALESCE(SUM(dr.failed), 0) as failed
            FROM couriers c
            LEFT JOIN delivery_routes dr ON dr.courier_id = c.id AND dr.route_date::date BETWEEN $1::date AND $2::date
            GROUP BY c.id
            ORDER BY c.name
        `, [dateFrom, dateTo]);

        const s = summaryRes.rows[0];
        const totalStops = parseInt(s.total_stops) || 0;
        const delivered = parseInt(s.delivered) || 0;

        return {
            period: { from: dateFrom, to: dateTo },
            summary: {
                total_routes: parseInt(s.total_routes) || 0,
                completed_routes: parseInt(s.completed_routes) || 0,
                total_stops: totalStops,
                delivered,
                failed: parseInt(s.failed) || 0,
                pending: totalStops - delivered - parseInt(s.failed || 0),
                success_rate: totalStops > 0 ? Math.round(delivered / totalStops * 100) : 0,
                total_distance_km: parseFloat(s.total_distance_km) || 0,
                avg_delivery_time_min: Math.round(parseFloat(avgTimeRes.rows[0].avg_time) || 0),
                cash_to_collect: parseFloat(s.cash_to_collect) || 0,
                cash_collected: parseFloat(s.cash_collected) || 0
            },
            couriers: couriersRes.rows.map(c => ({
                id: c.id,
                name: c.name,
                rating: parseFloat(c.rating) || 0,
                rating_count: parseInt(c.rating_count) || 0,
                routes: parseInt(c.routes) || 0,
                delivered: parseInt(c.delivered) || 0,
                failed: parseInt(c.failed) || 0,
                success_rate: (parseInt(c.delivered) + parseInt(c.failed)) > 0
                    ? Math.round(parseInt(c.delivered) / (parseInt(c.delivered) + parseInt(c.failed)) * 100)
                    : 0
            }))
        };
    }

    // ───────────────────────────────────────────
    // Товары
    // ───────────────────────────────────────────

    async getProducts() {
        const res = await pool.query('SELECT * FROM products WHERE active = true ORDER BY id');
        return res.rows;
    }

    async getProductById(id) {
        const numId = Number(id);
        if (!Number.isInteger(numId)) return null;
        const res = await pool.query('SELECT * FROM products WHERE id = $1 AND active = true', [numId]);
        return res.rows[0] || null;
    }

    async getAllProducts() {
        const res = await pool.query('SELECT * FROM products ORDER BY id');
        return res.rows;
    }

    async createProduct(p) {
        const res = await pool.query(
            `INSERT INTO products (brand, category, name, full_name, series, sku, viscosity, oil_type, volume, api_std, acea, ilsac, price, old_price, stock, min_stock, image, description, specs, active, is_new, is_popular)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING *`,
            [p.brand, p.category, p.name, p.full_name || p.name, p.series, p.sku,
             p.viscosity, p.oil_type, p.volume, p.api_std || p.api, p.acea, p.ilsac,
             p.price, p.old_price ?? null, p.stock || 0, p.min_stock || 3,
             p.image || p.main_image, p.description ?? null,
             toDbValue(p.specs || {}),        // если уже строка — не двойное кодирование
             p.active !== false, p.is_new || false, p.is_popular || false]
        );
        return res.rows[0];
    }

    async updateProduct(id, p) {
        const allowed = [
            'brand', 'category', 'name', 'full_name', 'series', 'sku', 'viscosity', 'oil_type',
            'volume', 'api_std', 'acea', 'ilsac', 'price', 'old_price', 'stock', 'min_stock',
            'image', 'description', 'specs', 'active', 'is_new', 'is_popular'
        ];
        const fields = [];
        const values = [];
        let idx = 1;
        for (const [key, val] of Object.entries(p)) {
            if (!allowed.includes(key)) continue;
            if (val === undefined) continue;
            fields.push(`${key} = $${idx}`);
            values.push(toDbValue(val));
            idx++;
        }
        if (fields.length === 0) return null;
        values.push(id);
        const res = await pool.query(
            `UPDATE products SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );
        return res.rows[0] || null;
    }

    async seedProductsFromCatalog() {
        const count = await pool.query('SELECT COUNT(*) FROM products');
        if (parseInt(count.rows[0].count) > 0) return;

        const fs = require('fs');
        const path = require('path');
        const catalogPath = path.join(__dirname, '..', 'data', 'catalog.json');
        if (!fs.existsSync(catalogPath)) return;

        try {
            const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
            const products = catalog.products || [];
            for (const p of products) {
                await this.createProduct({
                    brand: (catalog.brands || []).find(b => b.id === p.brand_id)?.name || '',
                    category: p.category_id,
                    name: p.name,
                    full_name: p.full_name,
                    series: p.series,
                    sku: p.sku,
                    viscosity: p.viscosity,
                    oil_type: p.oil_type,
                    volume: p.volume,
                    api_std: p.api,
                    acea: p.acea,
                    ilsac: p.ilsac,
                    price: p.price,
                    old_price: p.old_price || null,
                    stock: p.stock || 0,
                    min_stock: p.min_stock || 3,
                    image: p.main_image,
                    description: p.description,
                    specs: p.specs || {},
                    active: p.active !== false,
                    is_new: p.is_new || false,
                    is_popular: p.is_popular || false
                });
            }
            console.log(`[OK] Засеяно ${products.length} товаров из catalog.json`);
        } catch (e) {
            console.error('[ОШИБКА] Сидирование товаров:', e.message);
        }
    }
}

module.exports = new DBAdapter();