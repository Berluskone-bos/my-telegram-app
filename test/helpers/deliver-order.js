'use strict';

// Создаёт доставленный заказ через тот же серверный workflow, что и production:
// CONFIRMED → ASSEMBLING → READY_FOR_SHIPMENT → assigned → accepted → in_progress → COMPLETED.
// Используется в тестах бонусов/истории/склада, которым нужна готовая запись о доставке.
let courierSequence = 0;

async function deliverOrder(db, pool, order) {
    const courier = await db.createCourier({
        name: 'Тестовый курьер',
        phone: '1',
        telegram_id: 800000000 + (process.pid % 100000) * 100 + (++courierSequence % 100),
        telegram_user: 'test-delivery',
        vehicle_type: 'авто'
    });
    let route;
    try {
        for (const status of ['CONFIRMED', 'ASSEMBLING', 'READY_FOR_SHIPMENT']) {
            const changed = await db.updateOrderStatus(order.id, status);
            if (changed !== true) throw new Error('Не удалось перевести заказ в ' + status + ': ' + changed);
        }
        route = await db.createRoute({
            route_number: 'TEST-' + order.id + '-' + courier.id,
            route_date: new Date().toISOString().slice(0, 10),
            courier_id: courier.id,
            status: 'assigned',
            total_orders: 1,
            enforceReadyOrders: true,
            stops: [{
                order_id: String(order.id),
                order_number: order.order_number,
                address: order.address || 'Тестовый адрес',
                phone: order.phone || '1',
                client_name: order.user_name || 'Тест',
                client_chat_id: order.user_id,
                amount_to_pay: 0,
                payment_status: 'paid',
                status: 'pending',
                comment: ''
            }]
        });
        const accepted = await db.acceptRouteStop(route.id, route.stops[0].id);
        if (!['accepted', 'already'].includes(accepted.status)) throw new Error('Не удалось принять остановку: ' + accepted.status);
        const started = await db.startRouteIfAllAccepted(route.id);
        if (!['started', 'already'].includes(started.status)) throw new Error('Не удалось начать маршрут: ' + started.status);
        const completed = await db.completeDeliveryStop(route.stops[0].id);
        if (!['completed', 'already'].includes(completed.status)) throw new Error('Не удалось завершить доставку: ' + completed.status);
        return completed;
    } finally {
        if (route?.id) {
            await pool.query('DELETE FROM route_stops WHERE route_id = $1', [route.id]);
            await pool.query('DELETE FROM delivery_routes WHERE id = $1', [route.id]);
        }
        await pool.query('DELETE FROM couriers WHERE id = $1', [courier.id]);
    }
}

module.exports = { deliverOrder };
