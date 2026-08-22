const { pool, initDB } = require('./db');

class DBAdapter {
    constructor() {
        this.initialized = false;
    }

    async init() {
        if (!this.initialized) {
            await initDB();
            this.initialized = true;
        }
    }

    // Курьеры
    async getCouriers() {
        const res = await pool.query('SELECT * FROM couriers ORDER BY id');
        return res.rows;
    }

    async getCourierByTelegramId(telegramId) {
        const res = await pool.query('SELECT * FROM couriers WHERE telegram_id = $1', [telegramId]);
        return res.rows[0] || null;
    }

    async createCourier(courier) {
        const res = await pool.query(
            `INSERT INTO couriers (name, phone, telegram_id, telegram_user, vehicle_type, zones, is_active, max_orders, rating, rating_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [courier.name, courier.phone, courier.telegram_id, courier.telegram_user,
             courier.vehicle_type, courier.zones || ['spb'], courier.is_active !== false,
             courier.max_orders || 10, courier.rating || 0, courier.rating_count || 0]
        );
        return res.rows[0];
    }

    async updateCourierRating(courierId, rating) {
        const res = await pool.query(
            `UPDATE couriers SET rating = (rating * rating_count + $1) / (rating_count + 1), rating_count = rating_count + 1 WHERE id = $2 RETURNING *`,
            [rating, courierId]
        );
        return res.rows[0];
    }

    // Маршруты
    async getRoutes() {
        const res = await pool.query(`
            SELECT dr.*, json_agg(rs.* ORDER BY rs.stop_number) as stops
            FROM delivery_routes dr
            LEFT JOIN route_stops rs ON rs.route_id = dr.id
            GROUP BY dr.id
            ORDER BY dr.id DESC
        `);
        return res.rows.map(r => ({ ...r, stops: r.stops[0] ? r.stops : [] }));
    }

    async getRoutesByDateAndCourier(date, courierId) {
        const res = await pool.query(`
            SELECT dr.*, json_agg(rs.* ORDER BY rs.stop_number) as stops
            FROM delivery_routes dr
            LEFT JOIN route_stops rs ON rs.route_id = dr.id
            WHERE dr.route_date = $1 AND dr.courier_id = $2
            GROUP BY dr.id
            ORDER BY dr.id
        `, [date, courierId]);
        return res.rows.map(r => ({ ...r, stops: r.stops[0] ? r.stops : [] }));
    }

    async getRouteById(routeId) {
        const res = await pool.query(`
            SELECT dr.*, json_agg(rs.* ORDER BY rs.stop_number) as stops
            FROM delivery_routes dr
            LEFT JOIN route_stops rs ON rs.route_id = dr.id
            WHERE dr.id = $1
            GROUP BY dr.id
        `, [routeId]);
        if (!res.rows[0]) return null;
        return { ...res.rows[0], stops: res.rows[0].stops[0] ? res.rows[0].stops : [] };
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
                        [newRoute.id, stop.order_id, stop.order_number, stop.stop_number || stops.length + 1,
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
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async updateRouteStatus(routeId, status, completed, failed) {
        const res = await pool.query(
            `UPDATE delivery_routes SET status = $1, completed = $2, failed = $3,
             started_at = CASE WHEN $1 = 'in_progress' AND started_at IS NULL THEN NOW() ELSE started_at END,
             completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END
             WHERE id = $4 RETURNING *`,
            [status, completed, failed, routeId]
        );
        return res.rows[0];
    }

    async updateStopStatus(stopId, status, reason) {
        const res = await pool.query(
            `UPDATE route_stops SET status = $1, fail_reason = $2, delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END WHERE id = $3 RETURNING *`,
            [status, reason, stopId]
        );
        return res.rows[0];
    }

    async updateStopPhoto(stopId, photoFileId) {
        await pool.query('UPDATE route_stops SET photo_file_id = $1 WHERE id = $2', [photoFileId, stopId]);
    }

    // Заказы
    async getOrders() {
        const res = await pool.query('SELECT * FROM orders ORDER BY id DESC');
        return res.rows;
    }

    async createOrder(order) {
        const res = await pool.query(
            `INSERT INTO orders (order_number, user_id, user_name, phone, address, zone, city, street, house, entrance, apartment, items, total, discount, delivery_type, payment, comment, status, payment_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
            [order.order_number, order.user_id, order.user_name, order.phone, order.address,
             order.zone, order.city, order.street, order.house, order.entrance, order.apartment,
             JSON.stringify(order.items || []), order.total, order.discount || 0,
             order.delivery_type || 'delivery', order.payment || 'cash', order.comment,
             order.status || 'NEW', order.payment_status || 'PENDING']
        );
        return res.rows[0];
    }

    // Зоны
    async getZones() {
        const res = await pool.query('SELECT * FROM delivery_zones WHERE is_active = true ORDER BY id');
        return res.rows;
    }

    // Статистика
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
            WHERE route_date = $1
        `, [date]);
        return { date, ...res.rows[0] };
    }

    // Аналитика
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
            WHERE route_date BETWEEN $1 AND $2
        `, [dateFrom, dateTo]);

        const avgTimeRes = await pool.query(`
            SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60), 0) as avg_time
            FROM delivery_routes
            WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
            AND route_date BETWEEN $1 AND $2
        `, [dateFrom, dateTo]);

        const couriersRes = await pool.query(`
            SELECT c.id, c.name, c.rating, c.rating_count,
                COUNT(dr.id) as routes,
                COALESCE(SUM(dr.completed), 0) as delivered,
                COALESCE(SUM(dr.failed), 0) as failed
            FROM couriers c
            LEFT JOIN delivery_routes dr ON dr.courier_id = c.id AND dr.route_date BETWEEN $1 AND $2
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
}

module.exports = new DBAdapter();
