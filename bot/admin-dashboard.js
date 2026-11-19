'use strict';

const MOSCOW_DAY = "(created_at AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'Europe/Moscow')::date";

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function registerAdminDashboardRoutes(app, { pool, verifyAdmin }) {
    if (!app || !pool || typeof pool.query !== 'function' || typeof verifyAdmin !== 'function') {
        throw new TypeError('registerAdminDashboardRoutes requires app, pool and verifyAdmin');
    }

    app.get('/api/admin/dashboard', verifyAdmin, async (req, res) => {
        const requestedDate = req.query.date;
        if (requestedDate !== undefined && !validDate(requestedDate)) {
            return res.status(400).json({ error: 'Некорректная дата. Ожидается YYYY-MM-DD.' });
        }

        try {
            const [summaryResult, productsResult, recentResult, lowStockResult] = await Promise.all([
                pool.query(
                    `WITH d AS (
                        SELECT COALESCE($1::date, (NOW() AT TIME ZONE 'Europe/Moscow')::date) AS day
                     )
                     SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS "businessDate",
                            COUNT(o.id)::int AS orders,
                            COUNT(o.id) FILTER (WHERE o.status = 'NEW')::int AS "newOrders",
                            COUNT(o.id) FILTER (WHERE o.status IN ('NEW','CONFIRMED','ASSEMBLING','SHIPPING'))::int AS "activeOrders",
                            COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'CANCELLED'), 0)::float8 AS revenue,
                            COUNT(o.id) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled,
                            COUNT(o.id) FILTER (WHERE o.status IN ('DELIVERED','COMPLETED'))::int AS delivered,
                            COUNT(o.id) FILTER (WHERE o.status = 'SHIPPING')::int AS shipping
                       FROM d LEFT JOIN orders o ON ${MOSCOW_DAY.replace(/created_at/g, 'o.created_at')} = d.day
                      GROUP BY d.day`,
                    [requestedDate || null]
                ),
                pool.query(
                    `SELECT COUNT(*) FILTER (WHERE active = TRUE)::int AS products,
                            COUNT(*) FILTER (
                                WHERE active = TRUE
                                  AND COALESCE(stock, 0) <= COALESCE(min_stock, 3)
                            )::int AS "lowStockCount"
                       FROM products`
                ),
                pool.query(
                    `WITH d AS (
                        SELECT COALESCE($1::date, (NOW() AT TIME ZONE 'Europe/Moscow')::date) AS day
                     )
                     SELECT o.id, o.order_number AS "orderNumber", o.user_name AS "customerName",
                            o.total::float8 AS total, o.status, o.delivery_type AS "deliveryType",
                            TO_CHAR(o.created_at AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'Europe/Moscow',
                                    'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt"
                       FROM orders o CROSS JOIN d
                      WHERE ${MOSCOW_DAY.replace(/created_at/g, 'o.created_at')} = d.day
                      ORDER BY o.id DESC LIMIT 8`,
                    [requestedDate || null]
                ),
                pool.query(
                    `SELECT id, brand, name, viscosity, volume, stock, min_stock AS "minStock", image
                       FROM products
                      WHERE active = TRUE
                        AND COALESCE(stock, 0) <= COALESCE(min_stock, 3)
                      ORDER BY COALESCE(stock, 0) ASC, name ASC
                      LIMIT 8`
                )
            ]);

            const summary = summaryResult.rows[0] || {};
            const products = productsResult.rows[0] || {};
            const customersResult = await pool.query(
                'SELECT COUNT(DISTINCT user_id)::int AS customers FROM orders WHERE user_id IS NOT NULL'
            );

            res.set('Cache-Control', 'no-store');
            return res.json({
                businessDate: summary.businessDate,
                summary: {
                    orders: Number(summary.orders || 0),
                    newOrders: Number(summary.newOrders || 0),
                    activeOrders: Number(summary.activeOrders || 0),
                    revenue: Number(summary.revenue || 0),
                    products: Number(products.products || 0),
                    customers: Number(customersResult.rows[0]?.customers || 0),
                    lowStockCount: Number(products.lowStockCount || 0),
                    cancelled: Number(summary.cancelled || 0),
                    delivered: Number(summary.delivered || 0),
                    shipping: Number(summary.shipping || 0)
                },
                recentOrders: recentResult.rows,
                lowStockProducts: lowStockResult.rows
            });
        } catch (error) {
            console.error('[ADMIN DASHBOARD]', error && error.message ? error.message : 'unknown error');
            return res.status(500).json({ error: 'Не удалось загрузить сводку' });
        }
    });
}

module.exports = { registerAdminDashboardRoutes, validDate };
