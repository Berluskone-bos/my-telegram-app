// Диспетчер: бизнес-логика управления доставкой
// Создание маршрутов из заказов, назначение курьеров, расчёт стоимости

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function readJSON(filename) {
    try {
        const filePath = path.join(DATA_DIR, filename);
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        return [];
    }
}

function writeJSON(filename, data) {
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
}

class Dispatcher {
    // Создать маршрут из списка заказов
    static createRouteFromOrders(orderIds, courierId, routeDate) {
        const orders = readJSON('orders.json');
        const routes = readJSON('delivery-routes.json');

        const selectedOrders = orders.filter(o => orderIds.includes(o.id));
        if (selectedOrders.length === 0) return null;

        const maxId = routes.reduce((max, r) => Math.max(max, r.id || 0), 0);
        const maxNum = routes.reduce((max, r) => {
            const num = parseInt((r.route_number || '').replace('RL-', ''));
            return num > max ? num : max;
        }, 0);

        const stops = selectedOrders.map((order, idx) => ({
            id: idx + 1,
            stop_number: idx + 1,
            order_id: order.id,
            order_number: order.order_number || `AP-${order.id}`,
            client_chat_id: order.user_id || null,
            address: order.address || '',
            city: order.city || '',
            street: order.street || '',
            house: order.house || '',
            lat: null,
            lon: null,
            amount_to_pay: order.payment === 'cash' ? order.total : 0,
            payment_status: order.payment === 'cash' ? 'pending' : 'paid',
            status: 'pending',
            comment: order.comment || '',
            phone: order.phone || '',
            client_name: order.user_name || ''
        }));

        const cashToCollect = stops.reduce((sum, s) => sum + s.amount_to_pay, 0);

        const newRoute = {
            id: maxId + 1,
            route_number: 'RL-' + String(maxNum + 1).padStart(4, '0'),
            route_date: routeDate || new Date().toISOString().split('T')[0],
            courier_id: courierId,
            status: 'draft',
            total_orders: stops.length,
            completed: 0,
            failed: 0,
            cash_to_collect: cashToCollect,
            cash_collected: 0,
            stops: stops,
            started_at: null,
            completed_at: null,
            created_at: new Date().toISOString()
        };

        routes.push(newRoute);
        writeJSON('delivery-routes.json', routes);

        return newRoute;
    }

    // Получить доступных курьеров на дату
    static getAvailableCouriers(date) {
        const couriers = readJSON('couriers.json');
        const routes = readJSON('delivery-routes.json');

        return couriers.filter(c => {
            if (!c.is_active) return false;

            // Считаем маршруты на эту дату
            const dayRoutes = routes.filter(r =>
                r.courier_id === c.id &&
                r.route_date === date &&
                r.status !== 'cancelled'
            );

            const totalOrders = dayRoutes.reduce((sum, r) => sum + (r.total_orders || 0), 0);
            return totalOrders < (c.max_orders || 10);
        });
    }

    // Получить заказы без маршрута
    static getUnassignedOrders() {
        const orders = readJSON('orders.json');
        const routes = readJSON('delivery-routes.json');

        // Собираем все order_id из маршрутов
        const assignedOrderIds = new Set();
        routes.forEach(r => {
            (r.stops || []).forEach(s => {
                if (s.order_id) assignedOrderIds.add(s.order_id);
            });
        });

        return orders.filter(o =>
            !assignedOrderIds.has(o.id) &&
            o.status !== 'CANCELLED' &&
            o.delivery_type !== 'pickup'
        );
    }

    // Рассчитать стоимость доставки
    static calcDeliveryCost(zone, orderTotal) {
        const zones = readJSON('delivery-zones.json');
        const zoneData = zones.find(z => z.zone_code === zone);

        if (!zoneData) return 0;
        if (zoneData.free_threshold > 0 && orderTotal >= zoneData.free_threshold) return 0;
        return zoneData.base_cost;
    }

    // Статистика за день
    static getDayStats(date) {
        const routes = readJSON('delivery-routes.json');
        const dayRoutes = routes.filter(r => r.route_date === date);

        const totalRoutes = dayRoutes.length;
        const completedRoutes = dayRoutes.filter(r => r.status === 'completed').length;
        const totalOrders = dayRoutes.reduce((sum, r) => sum + (r.total_orders || 0), 0);
        const delivered = dayRoutes.reduce((sum, r) => sum + (r.completed || 0), 0);
        const failed = dayRoutes.reduce((sum, r) => sum + (r.failed || 0), 0);
        const cashToCollect = dayRoutes.reduce((sum, r) => sum + (r.cash_to_collect || 0), 0);
        const cashCollected = dayRoutes.reduce((sum, r) => sum + (r.cash_collected || 0), 0);

        return {
            date,
            total_routes: totalRoutes,
            completed_routes: completedRoutes,
            total_orders: totalOrders,
            delivered,
            failed,
            pending: totalOrders - delivered - failed,
            cash_to_collect: cashToCollect,
            cash_collected: cashCollected
        };
    }
}

module.exports = Dispatcher;
