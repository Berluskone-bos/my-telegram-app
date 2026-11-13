'use strict';
// История заказов клиента. Сервер — источник правды; приложение только показывает.
// Клиент определяется по подписанному initData (authenticatedTelegramUser), чужие заказы недоступны.
function registerOrderHistoryRoutes(app, { db, rateLimit, authenticatedTelegramUser, sanitizeLog = String }) {
    app.get('/api/orders/my', rateLimit(30, 60_000), async (req, res) => {
        try {
            const user = authenticatedTelegramUser(req);
            if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
            const rows = await db.getOrdersByUser(user.id, 50);
            const orders = rows.map(o => {
                let items = o.items;
                if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
                return {
                    orderNumber: o.order_number,
                    status: o.status,
                    paymentStatus: o.payment_status,
                    deliveryType: o.delivery_type,
                    address: o.address,
                    items: (items || []).map(i => ({ id: i.productId, name: i.name, volume: i.volume || '', price: Number(i.price) || 0, qty: Number(i.qty) || 1 })),
                    subtotal: Number(o.subtotal) || 0,
                    total: Number(o.total) || 0,
                    discount: Number(o.discount) || 0,
                    deliveryCost: Number(o.delivery_cost) || 0,
                    createdAt: o.created_at
                };
            });
            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, orders });
        } catch (e) {
            console.error('[API /orders/my GET]:', sanitizeLog(e.message));
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // «Удаление» из истории только скрывает завершённые заказы у клиента; запись в учёте остаётся.
    app.post('/api/orders/my/hide', rateLimit(20, 60_000), async (req, res) => {
        try {
            const user = authenticatedTelegramUser(req);
            if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
            const nums = req.body && Array.isArray(req.body.orderNumbers) ? req.body.orderNumbers : null;
            if (!nums || nums.length === 0 || nums.length > 100 || !nums.every(n => typeof n === 'string' && n.length <= 40)) {
                return res.status(400).json({ success: false, error: 'Invalid order numbers' });
            }
            const hidden = await db.hideOrdersForUser(user.id, nums);
            return res.json({ success: true, hidden, skipped: nums.filter(n => !hidden.includes(n)) });
        } catch (e) {
            console.error('[API /orders/my/hide]:', sanitizeLog(e.message));
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });
}
module.exports = { registerOrderHistoryRoutes };
