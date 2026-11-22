const { pool, initDB } = require('./db');
const { enqueue: enqueueNotice } = require('./outbox');
const { queueCancelNotices } = require('./cancel-flow');
const { DEFAULTS: REF_DEFAULTS, qualifiesForReferralBonus, phoneKey } = require('./referral');

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

// Допустимые смены статуса заказа. Конечные состояния защищены, чтобы нельзя было
// «вернуть» доставленный заказ в работу и потом отменить его с повторным возвратом товара на склад.
//   DELIVERY_FAILED — курьер не смог вручить заказ (ставит только курьерский бот): дальше только
//     «вернули на склад, отправить повторно» (READY_FOR_SHIPMENT) или отмена;
//   NEW, CONFIRMED, ASSEMBLING, SHIPPING — рабочие: между ними можно двигаться в любую сторону;
//   DELIVERED  -> только COMPLETED или CANCELLED (возврат денег; на склад товар не возвращается);
//   COMPLETED  -> только CANCELLED (поздний возврат; на склад товар не возвращается);
//   CANCELLED  -> никуда.
// Статус, которого нет в списке (старые данные), считаем рабочим.
function orderTransitionAllowed(from, to) {
    if (from === to) return true;
    const allowed = {
        NEW: ['CONFIRMED', 'CANCELLED'],
        CONFIRMED: ['ASSEMBLING', 'CANCELLED'],
        ASSEMBLING: ['READY_FOR_SHIPMENT', 'READY_FOR_PICKUP', 'CANCELLED'],
        READY_FOR_SHIPMENT: ['CANCELLED'],
        READY_FOR_PICKUP: ['PICKED_UP', 'CANCELLED'],
        PICKED_UP: [],
        SHIPPING: ['COMPLETED', 'CANCELLED', 'DELIVERY_FAILED'],
        DELIVERY_FAILED: ['READY_FOR_SHIPMENT', 'CANCELLED'],
        DELIVERED: ['COMPLETED', 'CANCELLED'],
        COMPLETED: ['CANCELLED'],
        CANCELLED: []
    };
    return Array.isArray(allowed[from]) && allowed[from].includes(to);
}

// Календарный день заказа по Москве (колонка created_at хранится без часового пояса в поясе сервера: в Neon это UTC)
const MSK_DAY = "(created_at AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'Europe/Moscow')::date";

// Временные сбои связи с PostgreSQL: перезапуск базы, обрыв сети/SSL, исчерпание соединений
const TRANSIENT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
    '57P01', '57P02', '57P03', '53300', '08000', '08001', '08003', '08004', '08006', '08007']);
function isTransientDbError(e) {
    if (!e) return false;
    if (e.code && TRANSIENT_CODES.has(e.code)) return true;
    return /Connection terminated|timeout exceeded when trying to connect|terminating connection|server closed the connection|SSL error|unexpected eof|ECONNRESET|Connection reset/i.test(String(e.message || ''));
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
    // Профили покупателей
    // ───────────────────────────────────────────

    // Профиль хранит только имя (из Telegram) и телефон. Адрес на сервере не хранится: вводится при каждом заказе.
    async getCustomerProfile(userId) {
        const id = String(userId || '');
        if (!/^\d{1,20}$/.test(id)) return null;
        const res = await pool.query('SELECT name, phone FROM customer_profiles WHERE user_id = $1', [id]);
        return res.rows[0] || null;
    }

    async upsertCustomerProfile(userId, profile) {
        const id = String(userId || '');
        if (!/^\d{1,20}$/.test(id)) throw new Error('invalid Telegram user ID');
        const res = await pool.query(
            `INSERT INTO customer_profiles (user_id, name, phone, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id) DO UPDATE SET
                name = EXCLUDED.name,
                phone = EXCLUDED.phone,
                city = '', street = '', house = '', building = '', letter = '', entrance = '', floor = '', apartment = '',
                updated_at = NOW()
             RETURNING name, phone`,
            [id, profile.name || '', profile.phone || '']
        );
        return res.rows[0];
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
        const idPlaceholder = '$' + idx;
        const query = 'UPDATE couriers SET ' + setFields.join(', ') + ' WHERE id = ' + idPlaceholder + ' AND archived_at IS NULL RETURNING *';
        const res = await pool.query(query, values);
        return res.rows[0] || null;
    }

    async setCourierActive(courierId, isActive) {
        const id = Number(courierId);
        if (!Number.isSafeInteger(id) || id <= 0 || typeof isActive !== 'boolean') return null;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const courier = await client.query('SELECT id FROM couriers WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [id]);
            if (!courier.rowCount) { await client.query('ROLLBACK'); return null; }
            if (!isActive) {
                const active = await client.query(`SELECT 1 FROM route_stops rs JOIN delivery_routes dr ON dr.id = rs.route_id JOIN orders o ON (o.id::text = rs.order_id OR o.order_number = rs.order_number) WHERE dr.courier_id = $1 AND rs.status IN ('pending', 'accepted', 'in_progress') AND o.status IN ('READY_FOR_SHIPMENT', 'SHIPPING') LIMIT 1`, [id]);
                if (active.rowCount) {
                    const error = new Error('Нельзя деактивировать курьера: у него есть незавершённые доставки');
                    error.code = 'COURIER_HAS_ACTIVE_ROUTE';
                    throw error;
                }
            }
            const updated = await client.query('UPDATE couriers SET is_active = $2 WHERE id = $1 AND archived_at IS NULL RETURNING *', [id, isActive]);
            await client.query('COMMIT');
            return updated.rows[0] || null;
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }
    async archiveCourier(courierId) {
        const id = Number(courierId);
        if (!Number.isSafeInteger(id) || id <= 0) return null;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const courier = await client.query('SELECT id, archived_at FROM couriers WHERE id = $1 FOR UPDATE', [id]);
            if (!courier.rowCount) { await client.query('ROLLBACK'); return null; }
            if (courier.rows[0].archived_at) { await client.query('COMMIT'); return courier.rows[0]; }
            const active = await client.query(`SELECT 1 FROM route_stops rs JOIN delivery_routes dr ON dr.id = rs.route_id JOIN orders o ON (o.id::text = rs.order_id OR o.order_number = rs.order_number) WHERE dr.courier_id = $1 AND rs.status IN ('pending', 'accepted', 'in_progress') AND o.status IN ('READY_FOR_SHIPMENT', 'SHIPPING') LIMIT 1`, [id]);
            if (active.rowCount) {
                const error = new Error('Нельзя удалить курьера: у него есть незавершённые доставки');
                error.code = 'COURIER_HAS_ACTIVE_ROUTE';
                throw error;
            }
            const updated = await client.query('UPDATE couriers SET is_active = false, archived_at = NOW() WHERE id = $1 RETURNING *', [id]);
            await client.query('COMMIT');
            return updated.rows[0] || null;
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }

    async getCourierByTelegramId(telegramId) {
        const res = await pool.query('SELECT * FROM couriers WHERE telegram_id = $1', [telegramId]);
        return res.rows[0] || null;
    }

    async createCourier(courier, { afterCreate } = {}) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(
                `INSERT INTO couriers (name, phone, telegram_id, telegram_user, vehicle_type, license_plate, zones, is_active, max_orders, rating, rating_count)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                [courier.name, courier.phone, courier.telegram_id, courier.telegram_user,
                 courier.vehicle_type, courier.license_plate || null,
                 toDbValue(courier.zones || ['spb']),        // массив, не JSON
                 courier.is_active !== false,
                 courier.max_orders || 10, courier.rating || 0, courier.rating_count || 0]
            );
            const created = res.rows[0];
            if (typeof afterCreate === 'function') await afterCreate({ client, courier: created });
            await client.query('COMMIT');
            return created;
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            throw e;
        } finally {
            client.release();
        }
    }

    // Оценка разрешена только владельцу заказа после доставки и только один раз.
    // Блокировка route_stops сериализует повторные/параллельные нажатия.
    async rateCourierForStop(stopId, courierId, telegramUserId, rating) {
        const stop = Number(stopId);
        const courier = Number(courierId);
        const value = Number(rating);
        const userId = String(telegramUserId == null ? '' : telegramUserId);
        if (!Number.isInteger(stop) || stop <= 0 ||
            !Number.isInteger(courier) || courier <= 0 ||
            !/^[0-9]+$/.test(userId) ||
            !Number.isInteger(value) || value < 1 || value > 5) {
            return { status: 'invalid' };
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const found = await client.query(
                `SELECT rs.id, rs.status, rs.client_rating, dr.courier_id, owner.order_status
                   FROM route_stops rs
                   JOIN delivery_routes dr ON dr.id = rs.route_id
                   JOIN LATERAL (
                       SELECT o.user_id, o.status AS order_status
                         FROM orders o
                        WHERE o.id = CASE
                            WHEN rs.order_id ~ '^[0-9]+$' THEN rs.order_id::bigint
                            ELSE NULL
                        END
                           OR (rs.order_number IS NOT NULL AND o.order_number = rs.order_number)
                        ORDER BY CASE
                            WHEN o.id = CASE
                                WHEN rs.order_id ~ '^[0-9]+$' THEN rs.order_id::bigint
                                ELSE NULL
                            END THEN 0 ELSE 1
                        END
                        LIMIT 1
                   ) owner ON TRUE
                  WHERE rs.id = $1 AND owner.user_id = $2::bigint
                  FOR UPDATE OF rs`,
                [stop, userId]
            );

            // Для чужого/несуществующего заказа одинаковый ответ: не раскрываем наличие заказа.
            if (!found.rowCount || Number(found.rows[0].courier_id) !== courier) {
                await client.query('ROLLBACK');
                return { status: 'not_allowed' };
            }
            const row = found.rows[0];
            if (row.status !== 'delivered') {
                await client.query('ROLLBACK');
                return { status: 'not_delivered' };
            }
            if (!['DELIVERED', 'COMPLETED'].includes(row.order_status)) {
                await client.query('ROLLBACK');
                return { status: 'not_delivered' };
            }
            if (row.client_rating != null) {
                await client.query('ROLLBACK');
                return { status: 'already_rated', rating: Number(row.client_rating) };
            }

            const saved = await client.query(
                'UPDATE route_stops SET client_rating = $1 WHERE id = $2 AND client_rating IS NULL RETURNING id',
                [value, stop]
            );
            if (!saved.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'already_rated' };
            }
            const updated = await client.query(
                `UPDATE couriers
                    SET rating = (rating::numeric * rating_count + $1) / (rating_count + 1),
                        rating_count = rating_count + 1
                  WHERE id = $2
                  RETURNING id, rating, rating_count`,
                [value, courier]
            );
            if (!updated.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'not_allowed' };
            }
            await client.query('COMMIT');
            return { status: 'rated', courier: updated.rows[0] };
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }
    // Оценка из карточки трекера: находим остановку по номеру заказа, затем используем ту же транзакционную проверку.
    async rateCourierForOrder(orderNumber, telegramUserId, rating) {
        const number = String(orderNumber == null ? '' : orderNumber).trim();
        const userId = String(telegramUserId == null ? '' : telegramUserId);
        const value = Number(rating);
        if (!number || number.length > 32 || !/^[0-9]+$/.test(userId) ||
            !Number.isInteger(value) || value < 1 || value > 5) return { status: 'invalid' };
        const target = await pool.query(
            `SELECT rs.id, dr.courier_id
               FROM orders o
               LEFT JOIN route_stops rs ON rs.order_number = o.order_number
               LEFT JOIN delivery_routes dr ON dr.id = rs.route_id
              WHERE o.order_number = $1 AND o.user_id = $2::bigint
              ORDER BY rs.id DESC NULLS LAST
              LIMIT 1`,
            [number, userId]
        );
        if (!target.rowCount) return { status: 'not_allowed' };
        const row = target.rows[0];
        if (!row.id || !row.courier_id) return { status: 'no_courier' };
        return this.rateCourierForStop(row.id, row.courier_id, userId, value);
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

            const courierLock = await client.query(
                'SELECT id FROM couriers WHERE id = $1 AND is_active = true AND archived_at IS NULL FOR UPDATE',
                [route.courier_id]);
            if (!courierLock.rowCount) {
                throw Object.assign(new Error('Курьер не активен или удалён'), { code: 'COURIER_INACTIVE' });
            }

            // Для построения маршрутного листа блокируем заказы до проверки активных остановок.
            // Это закрывает гонку: один заказ нельзя одновременно включить в два активных маршрута.
            if (route.enforceReadyOrders) {
                const ids = [...new Set((route.stops || []).map(s => String(s.order_id || '')).filter(x => /^\d+$/.test(x)))];
                if (!ids.length || ids.length !== (route.stops || []).length) {
                    throw Object.assign(new Error('В маршрут передан некорректный список заказов'), { code: 'BAD_REQUEST' });
                }
                const locked = await client.query(
                    'SELECT id, status, delivery_type FROM orders WHERE id::text = ANY($1::text[]) ORDER BY id FOR UPDATE', [ids]);
                if (locked.rowCount !== ids.length) {
                    throw Object.assign(new Error('Один из заказов не найден'), { code: 'NOT_FOUND' });
                }
                const notReady = locked.rows.find(o => o.status !== 'READY_FOR_SHIPMENT' || o.delivery_type === 'pickup');
                if (notReady) {
                    throw Object.assign(new Error('Заказ не готов к курьерской отправке'), { code: 'CONFLICT' });
                }
                const assigned = await client.query(
                    `SELECT order_id FROM route_stops
                      WHERE order_id = ANY($1::text[]) AND status IN ('pending', 'accepted', 'in_progress')
                      FOR UPDATE`, [ids]);
                if (assigned.rowCount) {
                    throw Object.assign(new Error('Один из заказов уже находится в активном маршруте'), { code: 'CONFLICT' });
                }
            }

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
                        `INSERT INTO route_stops (route_id, order_id, order_number, stop_number, address, city, street, house, lat, lon, time_window, status, payment_status, amount_to_pay, phone, client_name, client_chat_id, items_count, comment, eta_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
                        [newRoute.id, stop.order_id, stop.order_number,
                         stop.stop_number || stops.length + 1,
                         stop.address, stop.city, stop.street, stop.house, stop.lat, stop.lon,
                         stop.time_window, stop.status || 'pending', stop.payment_status,
                         stop.amount_to_pay || 0, stop.phone, stop.client_name, stop.client_chat_id,
                         stop.items_count, stop.comment, stop.eta_at || null]
                    );
                    stops.push(stopRes.rows[0]);
                }
            }

            if (typeof route.afterCreate === 'function') {
                await route.afterCreate({ route: { ...newRoute, stops }, client });
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

    // Индивидуальное принятие остановки курьером. Маршрут остаётся assigned.
    async acceptRouteStop(routeId, stopId, { afterAccept = null } = {}) {
        const rid = Number(routeId), sid = Number(stopId);
        if (!Number.isInteger(rid) || rid <= 0 || !Number.isInteger(sid) || sid <= 0) return { status: 'not_found' };
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const route = await client.query('SELECT id, status FROM delivery_routes WHERE id = $1 FOR UPDATE', [rid]);
            if (!route.rowCount) { await client.query('ROLLBACK'); return { status: 'not_found' }; }
            if (route.rows[0].status !== 'assigned') { await client.query('ROLLBACK'); return { status: 'route_started' }; }
            const stop = await client.query('SELECT * FROM route_stops WHERE id = $1 AND route_id = $2 FOR UPDATE', [sid, rid]);
            if (!stop.rowCount) { await client.query('ROLLBACK'); return { status: 'not_found' }; }
            if (stop.rows[0].status === 'accepted') { await client.query('COMMIT'); return { status: 'already' }; }
            if (stop.rows[0].status !== 'pending') { await client.query('ROLLBACK'); return { status: stop.rows[0].status === 'cancelled' ? 'cancelled' : 'forbidden' }; }
            const accepted = await client.query("UPDATE route_stops SET status = 'accepted' WHERE id = $1 RETURNING *", [sid]);
            if (typeof afterAccept === 'function') {
                const routeDetails = await client.query('SELECT * FROM delivery_routes WHERE id = $1', [rid]);
                const routeStops = await client.query('SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_number', [rid]);
                await afterAccept({
                    client, stop: accepted.rows[0], route: routeDetails.rows[0] || {}, stops: routeStops.rows
                });
            }
            await client.query('COMMIT');
            return { status: 'accepted' };
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally { client.release(); }
    }

    // Общий старт разрешён только когда каждая неотменённая остановка принята.
    // Блокировка маршрута сериализует одновременные нажатия и отмены/принятия.
    async startRouteIfAllAccepted(routeId, { afterStart = null } = {}) {
        const id = Number(routeId);
        if (!Number.isInteger(id) || id <= 0) return { status: 'not_found' };
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Сначала блокируем связанные заказы в том же порядке, что и отмена заказа
            // (orders -> route_stops), иначе параллельная отмена могла бы дать deadlock.
            const refs = await client.query('SELECT order_id FROM route_stops WHERE route_id = $1', [id]);
            const orderIds = [...new Set(refs.rows.map(x => String(x.order_id || '')).filter(x => /^\d+$/.test(x)))];
            if (orderIds.length) {
                await client.query('SELECT id FROM orders WHERE id::text = ANY($1::text[]) ORDER BY id FOR UPDATE', [orderIds]);
            }
            const route = await client.query('SELECT * FROM delivery_routes WHERE id = $1 FOR UPDATE', [id]);
            if (!route.rowCount) { await client.query('ROLLBACK'); return { status: 'not_found' }; }
            if (route.rows[0].status === 'in_progress') { await client.query('COMMIT'); return { status: 'already' }; }
            if (route.rows[0].status !== 'assigned') { await client.query('ROLLBACK'); return { status: 'forbidden' }; }
            await client.query(
                `UPDATE route_stops rs SET status = 'cancelled'
                   FROM orders o
                  WHERE rs.route_id = $1 AND rs.order_id::text = o.id::text
                    AND o.status = 'CANCELLED' AND rs.status IN ('pending', 'accepted')`, [id]);
            const stops = await client.query('SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_number FOR UPDATE', [id]);
            const active = stops.rows.filter(s => !['cancelled', 'delivered', 'failed'].includes(s.status));
            if (!active.length) { await client.query('ROLLBACK'); return { status: 'empty' }; }
            const waiting = active.filter(s => s.status !== 'accepted');
            if (waiting.length) { await client.query('ROLLBACK'); return { status: 'not_ready', waiting: waiting.length }; }
            await client.query("UPDATE route_stops SET status = 'in_progress' WHERE route_id = $1 AND status = 'accepted'", [id]);
            await client.query(
                `UPDATE orders o SET status = 'SHIPPING'
                   FROM route_stops rs
                  WHERE rs.route_id = $1 AND rs.order_id::text = o.id::text
                    AND rs.status = 'in_progress' AND o.status = 'READY_FOR_SHIPMENT'`, [id]);
            const updated = await client.query(
                "UPDATE delivery_routes SET status = 'in_progress', started_at = COALESCE(started_at, NOW()) WHERE id = $1 RETURNING *", [id]);
            if (typeof afterStart === 'function') {
                await afterStart({ client, route: updated.rows[0], stops: stops.rows });
            }
            await client.query('COMMIT');
            return { status: 'started', route: updated.rows[0], stops: stops.rows };
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally { client.release(); }
    }

    // Возвращает другую остановку маршрута, у которой курьер уже находится у клиента.
    // Отдельный запрос нужен для понятного предупреждения; окончательная защита — внутри setStopStage.
    async getRouteStopAtClient(routeId, exceptStopId) {
        const res = await pool.query(
            `SELECT * FROM route_stops
              WHERE route_id = $1 AND id <> $2
                AND status = 'in_progress' AND stage = 'arrived'
              ORDER BY stop_number
              LIMIT 1`,
            [Number(routeId), Number(exceptStopId)]);
        return res.rows[0] || null;
    }

    // Этапы остановки сериализуются блокировкой строки маршрута. Проверка другой остановки
    // и UPDATE выполняются в одной транзакции, поэтому параллельные callback не обходят guard.
    async setStopStage(stopId, stage, options = {}) {
        const id = Number(stopId);
        if (!Number.isInteger(id) || id <= 0 || !['enroute', 'arrived'].includes(stage)) return null;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const candidate = await client.query(
                'SELECT route_id FROM route_stops WHERE id = $1', [id]);
            if (!candidate.rowCount) {
                await client.query('ROLLBACK');
                return null;
            }
            const routeId = candidate.rows[0].route_id;
            await client.query(
                'SELECT id FROM delivery_routes WHERE id = $1 FOR UPDATE', [routeId]);
            const targetRes = await client.query(
                'SELECT * FROM route_stops WHERE id = $1 AND route_id = $2 FOR UPDATE', [id, routeId]);
            if (!targetRes.rowCount || targetRes.rows[0].status !== 'in_progress') {
                await client.query('COMMIT');
                return null;
            }
            const target = targetRes.rows[0];
            if (target.stage === stage || (target.stage === 'arrived' && stage === 'enroute')) {
                await client.query('COMMIT');
                return null;
            }
            const atClient = await client.query(
                `SELECT id FROM route_stops
                  WHERE route_id = $1 AND id <> $2
                    AND status = 'in_progress' AND stage = 'arrived'
                  LIMIT 1`,
                [routeId, id]);
            if (atClient.rowCount) {
                await client.query('COMMIT');
                return null;
            }
            const updated = await client.query(
                `UPDATE route_stops SET stage = $2::text, stage_at = NOW()
                  WHERE id = $1 AND route_id = $3 AND status = 'in_progress'
                  RETURNING *`,
                [id, stage, routeId]);
            const stop = updated.rows[0] || null;
            if (stop && typeof options.afterUpdate === 'function') {
                const routeRes = await client.query(
                    `SELECT route_number,
                            (SELECT COUNT(*)::int FROM route_stops WHERE route_id = $1) AS stop_count
                       FROM delivery_routes WHERE id = $1`, [routeId]);
                await options.afterUpdate({ client, stop, route: routeRes.rows[0] || {}, stage });
            }
            await client.query('COMMIT');
            return stop;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
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

    // Неудачная попытка доставки — отдельный терминальный результат остановки,
    // но не отмена заказа и не завершение всего маршрута. Заказ получает статус DELIVERY_FAILED
    // («Не доставлен»): он виден в админке отдельной колонкой, оператор решает — повторная отправка или отмена.
    async failDeliveryStop(stopId, reason, { afterFailure = null, expectedCourierId = null } = {}) {
        const id = Number(stopId);
        if (!Number.isInteger(id) || id <= 0) return { status: 'not_found' };
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const candidateRes = await client.query(
                'SELECT id, route_id, order_id, order_number FROM route_stops WHERE id = $1', [id]);
            if (!candidateRes.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'not_found' };
            }
            const candidate = candidateRes.rows[0];

            // Единый порядок блокировок: заказ → маршрут → остановка.
            if (candidate.order_id || candidate.order_number) {
                await client.query(
                    `SELECT id FROM orders
                      WHERE (NULLIF($1::text, '') IS NOT NULL AND id::text = NULLIF($1::text, ''))
                         OR (NULLIF($2::text, '') IS NOT NULL AND order_number = NULLIF($2::text, ''))
                      ORDER BY CASE WHEN id::text = NULLIF($1::text, '') THEN 0 ELSE 1 END
                      LIMIT 1 FOR UPDATE`,
                    [candidate.order_id == null ? '' : String(candidate.order_id), candidate.order_number || '']);
            }
            const routeRes = await client.query(
                'SELECT id, status, courier_id FROM delivery_routes WHERE id = $1 FOR UPDATE', [candidate.route_id]);
            if (!routeRes.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'not_found' };
            }
            if (expectedCourierId !== null) {
                if (String(routeRes.rows[0].courier_id) !== String(expectedCourierId)) {
                    await client.query('ROLLBACK');
                    return { status: 'not_assigned' };
                }
                const activeCourier = await client.query(
                    'SELECT id FROM couriers WHERE id = $1 AND is_active = TRUE AND archived_at IS NULL FOR SHARE',
                    [expectedCourierId]);
                if (!activeCourier.rowCount) {
                    await client.query('ROLLBACK');
                    return { status: 'courier_inactive' };
                }
            }
            const stopRes = await client.query(
                'SELECT * FROM route_stops WHERE id = $1 AND route_id = $2 FOR UPDATE', [id, candidate.route_id]);
            if (!stopRes.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'not_found' };
            }
            const stop = stopRes.rows[0];
            // Повторное нажатие «Не доставлено» — «уже отмечено», даже если маршрут успел завершиться
            if (stop.status === 'failed') {
                await client.query('COMMIT');
                return { status: 'already', stop };
            }
            if (routeRes.rows[0].status !== 'in_progress') {
                await client.query('ROLLBACK');
                return { status: 'route_not_started' };
            }
            if (stop.status === 'cancelled') {
                await client.query('ROLLBACK');
                return { status: 'cancelled' };
            }
            if (stop.status !== 'in_progress') {
                await client.query('ROLLBACK');
                return { status: 'forbidden' };
            }
            const updated = await client.query(
                `UPDATE route_stops
                    SET status = 'failed', fail_reason = $2::text
                  WHERE id = $1 RETURNING *`,
                [id, String(reason || 'Не указана').slice(0, 300)]);
            // Заказ тоже становится «Не доставлен» (раньше оставался «В пути» и в админке ничего не менялось).
            // Заказ уже заблокирован выше; отменённый и доставленный сюда не попадут (остановка не in_progress).
            await client.query(
                `UPDATE orders SET status = 'DELIVERY_FAILED'
                  WHERE status = 'SHIPPING'
                    AND ((NULLIF($1::text, '') IS NOT NULL AND id::text = NULLIF($1::text, ''))
                      OR (NULLIF($2::text, '') IS NOT NULL AND order_number = NULLIF($2::text, '')))`,
                [candidate.order_id == null ? '' : String(candidate.order_id), candidate.order_number || '']);
            await this._refreshRouteCompletion(client, candidate.route_id);
            const route = await client.query('SELECT * FROM delivery_routes WHERE id = $1', [candidate.route_id]);
            // Обязательные уведомления записываются до COMMIT: бизнес-статус и outbox либо фиксируются вместе, либо откатываются.
            if (typeof afterFailure === 'function') {
                await afterFailure({ client, stop: updated.rows[0], route: route.rows[0] });
            }
            await client.query('COMMIT');
            return { status: 'failed', stop: updated.rows[0], route: route.rows[0] };
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }

    // Завершение доставки — одна транзакция: блокировка остановки/заказа,
    // перевод заказа в COMPLETED, обновление маршрута и постановка уведомления в outbox.
    // Повторный callback получает already и не создаёт второе уведомление.
    async completeDeliveryStop(stopId, { afterComplete = null, expectedCourierId = null } = {}) {
        const id = Number(stopId);
        if (!Number.isInteger(id) || id <= 0) return { status: 'not_found' };
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Сначала читаем ссылку на заказ без блокировки, затем блокируем заказ и остановку
            // в том же порядке, что и отмена заказа (orders -> route_stops), чтобы не создавать deadlock.
            const candidateRes = await client.query('SELECT * FROM route_stops WHERE id = $1', [id]);
            if (!candidateRes.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'not_found' };
            }
            const candidate = candidateRes.rows[0];

            let order = null;
            if (candidate.order_id || candidate.order_number) {
                const orderRes = await client.query(
                    `SELECT * FROM orders
                      WHERE (NULLIF($1::text, '') IS NOT NULL AND id::text = NULLIF($1::text, ''))
                         OR (NULLIF($2::text, '') IS NOT NULL AND order_number = NULLIF($2::text, ''))
                      ORDER BY CASE WHEN id::text = NULLIF($1::text, '') THEN 0 ELSE 1 END
                      LIMIT 1 FOR UPDATE`,
                    [candidate.order_id == null ? '' : String(candidate.order_id), candidate.order_number || '']);
                order = orderRes.rows[0] || null;
            }

            // Единый порядок блокировок: заказ → маршрут → остановка.
            // setStopStage/failDeliveryStop уже блокируют маршрут до остановки;
            // здесь делаем то же самое, иначе параллельные callback могут deadlock.
            const routeRes = await client.query(
                'SELECT id, courier_id FROM delivery_routes WHERE id = $1 FOR UPDATE', [candidate.route_id]);
            if (!routeRes.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'not_found' };
            }
            if (expectedCourierId !== null) {
                if (String(routeRes.rows[0].courier_id) !== String(expectedCourierId)) {
                    await client.query('ROLLBACK');
                    return { status: 'not_assigned' };
                }
                const activeCourier = await client.query(
                    'SELECT id FROM couriers WHERE id = $1 AND is_active = TRUE AND archived_at IS NULL FOR SHARE',
                    [expectedCourierId]);
                if (!activeCourier.rowCount) {
                    await client.query('ROLLBACK');
                    return { status: 'courier_inactive' };
                }
            }

            const stopRes = await client.query(
                'SELECT * FROM route_stops WHERE id = $1 AND route_id = $2 FOR UPDATE', [id, candidate.route_id]);
            if (!stopRes.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'not_found' };
            }
            const stop = stopRes.rows[0];
            if (stop.status === 'cancelled') {
                await client.query('ROLLBACK');
                return { status: 'cancelled' };
            }

            if (order?.status === 'CANCELLED') {
                await client.query('ROLLBACK');
                return { status: 'cancelled' };
            }
            if (order && order.status !== 'COMPLETED') {
                if (!orderTransitionAllowed(order.status, 'COMPLETED')) {
                    await client.query('ROLLBACK');
                    return { status: 'forbidden' };
                }
                await client.query(
                    "UPDATE orders SET status = 'COMPLETED', stock_deducted = false WHERE id = $1",
                    [order.id]);
                await this._grantReferralBonus(client, order);
            }

            if (stop.status === 'delivered') {
                await this._refreshRouteCompletion(client, stop.route_id);
                await client.query('COMMIT');
                return { status: 'already', stop, orderId: order?.id || null };
            }
            if (!['pending', 'accepted', 'in_progress'].includes(stop.status)) {
                await client.query('ROLLBACK');
                return { status: 'forbidden' };
            }

            const updated = await client.query(
                `UPDATE route_stops
                    SET status = 'delivered',
                        fail_reason = NULL,
                        delivered_at = COALESCE(delivered_at, NOW())
                  WHERE id = $1
                  RETURNING *`, [id]);

            await this._refreshRouteCompletion(client, stop.route_id);
            const completedRouteRes = await client.query('SELECT * FROM delivery_routes WHERE id = $1', [stop.route_id]);
            if (typeof afterComplete === 'function') {
                await afterComplete({ client, stop: updated.rows[0], route: completedRouteRes.rows[0] || {}, order });
            }

            if (stop.client_chat_id) {
                const orderNumber = stop.order_number || order?.order_number || String(order?.id || id);
                await enqueueNotice(client, {
                    bot: 'client',
                    dedupKey: `stop-delivered:${id}`,
                    payload: {
                        chat_id: String(stop.client_chat_id),
                        text: `Заказ ${orderNumber}\\n\\nСтатус: Доставлен\\n\\nСпасибо за покупку!`
                    }
                });
            }

            await client.query('COMMIT');
            return { status: 'completed', stop: updated.rows[0], orderId: order?.id || null };
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }

    async _refreshRouteCompletion(client, routeId) {
        const id = Number(routeId);
        if (!Number.isInteger(id) || id <= 0) return;
        // Блокировка маршрута сериализует обновления разных остановок одного маршрута.
        await client.query('SELECT id FROM delivery_routes WHERE id = $1 FOR UPDATE', [id]);
        const r = await client.query(
            `SELECT
                 COUNT(*) FILTER (WHERE status = 'delivered')::int AS completed,
                 COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                 COUNT(*) FILTER (WHERE status IN ('pending', 'accepted', 'in_progress'))::int AS remaining
               FROM route_stops WHERE route_id = $1`, [id]);
        const stats = r.rows[0];
        const status = Number(stats.remaining) === 0 ? 'completed' : 'in_progress';
        await client.query(
            `UPDATE delivery_routes
                SET status = $1::varchar(32),
                    completed = $2,
                    failed = $3,
                    started_at = CASE WHEN $1::varchar(32) = 'in_progress' THEN COALESCE(started_at, NOW()) ELSE started_at END,
                    completed_at = CASE WHEN $1::varchar(32) = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END
              WHERE id = $4`,
            [status, stats.completed, stats.failed, id]);
    }

    // Расчётное время приезда на точку; told = true — это время только что сообщили клиенту
    async setStopEta(stopId, etaAt, told = false) {
        const id = Number(stopId);
        if (!Number.isInteger(id)) return;
        await pool.query(
            `UPDATE route_stops SET eta_at = $2::timestamptz,
                    eta_told_at = CASE WHEN $3::boolean THEN $2::timestamptz ELSE eta_told_at END WHERE id = $1`,
            [id, etaAt || null, !!told]);
    }

    // Номер маршрута, по которому заказ уже едет (точка ждёт или в работе), либо null
    async activeRouteNumberForOrder(orderNumber) {
        const r = await pool.query(
            `SELECT dr.route_number FROM route_stops rs JOIN delivery_routes dr ON dr.id = rs.route_id
              WHERE rs.order_number = $1 AND rs.status IN ('pending', 'in_progress') LIMIT 1`, [orderNumber]);
        return r.rows[0] ? r.rows[0].route_number : null;
    }

    // Курьер, который вёз заказ (последняя доставленная точка этого заказа) — для оценки доставки
    async courierIdForOrder(orderNumber) {
        const r = await pool.query(
            `SELECT dr.courier_id FROM route_stops rs JOIN delivery_routes dr ON dr.id = rs.route_id
              WHERE rs.order_number = $1 AND rs.status = 'delivered' ORDER BY rs.id DESC LIMIT 1`, [orderNumber]);
        return r.rows[0] ? r.rows[0].courier_id : null;
    }

    // Сводка за сегодняшний день по Москве / Санкт-Петербургу (для виджета админа)
    async getDaySummary() {
        const r = await pool.query(
            `SELECT COUNT(*)::int AS orders,
                    COALESCE(SUM(total) FILTER (WHERE status <> 'CANCELLED'), 0)::numeric AS revenue,
                    COUNT(*) FILTER (WHERE status IN ('NEW', 'CONFIRMED'))::int AS new_cnt,
                    COUNT(*) FILTER (WHERE status = 'ASSEMBLING')::int AS assembling,
                    COUNT(*) FILTER (WHERE status = 'SHIPPING')::int AS shipping,
                    COUNT(*) FILTER (WHERE status IN ('DELIVERED', 'COMPLETED'))::int AS delivered,
                    COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
                    TO_CHAR(NOW() AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY') AS date,
                    TO_CHAR(NOW() AT TIME ZONE 'Europe/Moscow', 'HH24:MI') AS clock
               FROM orders
              WHERE (created_at AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'Europe/Moscow')::date = (NOW() AT TIME ZONE 'Europe/Moscow')::date`);
        const x = r.rows[0];
        return { orders: x.orders, revenue: Number(x.revenue), new: x.new_cnt, assembling: x.assembling, shipping: x.shipping,
                 delivered: x.delivered, cancelled: x.cancelled, date: x.date, updated: 'обновлено ' + x.clock };
    }

    // ───────────────────────────────────────────
    // График заказов: по календарным дням Москвы (created_at — TIMESTAMP без пояса, см. getDaySummary)
    // ───────────────────────────────────────────

    // Даты 'YYYY-MM-DD' приходят строкой: тип date драйвер превращает в JS Date и сдвигает по часовому поясу сервера.
    async getFirstOrderDate() {
        const r = await pool.query(`SELECT TO_CHAR(MIN(${MSK_DAY}), 'YYYY-MM-DD') AS d FROM orders`);
        return r.rows[0].d || null;
    }

    // Каждый день периода, включая дни без заказов. Отменённые считаются отдельно и в выручку не входят.
    async getOrderSeries(from, to) {
        const r = await pool.query(
            `WITH days AS (SELECT d::date AS day FROM generate_series($1::date, $2::date, interval '1 day') d),
                  o AS (SELECT ${MSK_DAY} AS day, status, total FROM orders WHERE ${MSK_DAY} BETWEEN $1::date AND $2::date)
             SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
                    COUNT(o.day) FILTER (WHERE o.status <> 'CANCELLED')::int AS orders,
                    COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'CANCELLED'), 0)::float8 AS revenue,
                    COUNT(o.day) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled
               FROM days LEFT JOIN o ON o.day = days.day
              GROUP BY days.day ORDER BY days.day`, [from, to]);
        return r.rows;
    }

    // Карточки показателей «сегодня / неделя / месяц / год»: период с начала до ЭТОГО МОМЕНТА против такого же отрезка
    // прошлого периода (сегодня до 15:30 — против вчера до 15:30), чтобы утром не было ложного «минус 90 %».
    // nowOverride ('ГГГГ-ММ-ДД ЧЧ:ММ:СС' по Москве) нужен только тестам. Отменённые не считаются.
    // SQL-вставки ниже — только из этого списка констант, из запроса пользователя в них ничего не попадает.
    async getKpi(nowOverride) {
        const col = (c) => ({
            today: { start: "date_trunc('day', n.now_m)", iv: "interval '1 day'", bucket: `EXTRACT(HOUR FROM ${c})::int`, count: '24' },
            week: { start: "date_trunc('week', n.now_m)", iv: "interval '7 days'", bucket: `(${c}::date - date_trunc('week', n.now_m)::date)`, count: '7' },
            month: { start: "date_trunc('month', n.now_m)", iv: "interval '1 month'", bucket: `(EXTRACT(DAY FROM ${c})::int - 1)`,
                     count: "EXTRACT(DAY FROM (date_trunc('month', n.now_m) + interval '1 month' - interval '1 day'))::int" },
            year: { start: "date_trunc('year', n.now_m)", iv: "interval '1 year'", bucket: `(EXTRACT(MONTH FROM ${c})::int - 1)`, count: '12' }
        });
        const head = `WITH n AS (SELECT COALESCE($1::timestamp, NOW() AT TIME ZONE 'Europe/Moscow') AS now_m),
                o AS (SELECT created_at AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'Europe/Moscow' AS ts, total
                        FROM orders WHERE status <> 'CANCELLED')`;
        const one = async (key) => {
            const d = col('o.ts')[key];
            const idxExpr = col('n.now_m')[key].bucket;
            const totals = await pool.query(
                `${head}
                 SELECT (SELECT COUNT(*) FROM o, n WHERE o.ts >= ${d.start} AND o.ts <= n.now_m)::int AS orders,
                        (SELECT COALESCE(SUM(o.total), 0) FROM o, n WHERE o.ts >= ${d.start} AND o.ts <= n.now_m)::float8 AS revenue,
                        (SELECT COUNT(*) FROM o, n WHERE o.ts >= ${d.start} - ${d.iv} AND o.ts <= n.now_m - ${d.iv})::int AS prev_orders,
                        (SELECT COALESCE(SUM(o.total), 0) FROM o, n WHERE o.ts >= ${d.start} - ${d.iv} AND o.ts <= n.now_m - ${d.iv})::float8 AS prev_revenue,
                        (SELECT ${idxExpr} FROM n)::int AS idx`, [nowOverride || null]);
            const series = await pool.query(
                `${head},
                      b AS (SELECT g AS i FROM n, generate_series(0, ${d.count} - 1) g),
                      s AS (SELECT ${d.bucket} AS i, COUNT(*) AS c, SUM(o.total) AS r FROM o, n
                             WHERE o.ts >= ${d.start} AND o.ts <= n.now_m GROUP BY 1)
                 SELECT b.i, COALESCE(s.c, 0)::int AS orders, COALESCE(s.r, 0)::float8 AS revenue FROM b LEFT JOIN s ON s.i = b.i ORDER BY b.i`, [nowOverride || null]);
            const t = totals.rows[0];
            return { orders: t.orders, revenue: t.revenue, prev: { orders: t.prev_orders, revenue: t.prev_revenue }, idx: t.idx,
                     series: series.rows.map(r => ({ orders: r.orders, revenue: r.revenue })) };
        };
        const [today, week, month, year] = await Promise.all(['today', 'week', 'month', 'year'].map(one));
        return { today, week, month, year };
    }

    async getMoscowToday() {
        const r = await pool.query(`SELECT TO_CHAR((NOW() AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS d`);
        return r.rows[0].d;
    }

    // Отчёт по магазину за период (календарные дни Москвы, отменённые не считаются):
    // топ товаров (по выручке в ценах каталога — до скидок заказа), способы получения, итоги.
    // items — JSONB-массив {productId, name, volume, price, qty}; у старых заказов поля могут быть кривыми, поэтому разбор «мягкий».
    async getShopAnalytics(from, to) {
        const [prod, deliv, tot] = await Promise.all([
            pool.query(
                `SELECT COALESCE(it->>'productId', it->>'name') AS key,
                        MAX(it->>'name') AS name, MAX(it->>'volume') AS volume,
                        SUM(CASE WHEN it->>'qty' ~ '^[0-9]+$' THEN (it->>'qty')::int ELSE 1 END)::int AS qty,
                        SUM((CASE WHEN it->>'qty' ~ '^[0-9]+$' THEN (it->>'qty')::int ELSE 1 END)
                            * (CASE WHEN it->>'price' ~ '^[0-9]+(\.[0-9]+)?$' THEN (it->>'price')::numeric ELSE 0 END))::float8 AS revenue,
                        COUNT(DISTINCT o.id)::int AS orders
                   FROM orders o, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) it
                  WHERE o.status <> 'CANCELLED' AND ${MSK_DAY.replace(/created_at/g, 'o.created_at')} BETWEEN $1::date AND $2::date
                    AND COALESCE(it->>'productId', it->>'name') IS NOT NULL
                  GROUP BY 1 ORDER BY revenue DESC, qty DESC LIMIT 10`, [from, to]),
            pool.query(
                `SELECT COALESCE(delivery_type, 'delivery') AS type, COUNT(*)::int AS orders, COALESCE(SUM(total), 0)::float8 AS revenue
                   FROM orders WHERE status <> 'CANCELLED' AND ${MSK_DAY} BETWEEN $1::date AND $2::date
                  GROUP BY 1 ORDER BY orders DESC`, [from, to]),
            this.getOrderTotals(from, to)
        ]);
        return { products: prod.rows, delivery: deliv.rows, totals: tot };
    }

    async getOrderTotals(from, to) {
        const r = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS orders,
                    COALESCE(SUM(total) FILTER (WHERE status <> 'CANCELLED'), 0)::float8 AS revenue,
                    COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
               FROM orders WHERE ${MSK_DAY} BETWEEN $1::date AND $2::date`, [from, to]);
        return r.rows[0];
    }

    async updateStopPhoto(stopId, photoFileId) {
        const id = Number(stopId);
        if (!Number.isInteger(id)) return;
        await pool.query('UPDATE route_stops SET photo_file_id = $1 WHERE id = $2', [photoFileId, id]);
    }

    // ───────────────────────────────────────────
    // Заказы
    // ───────────────────────────────────────────

    async getOrdersPage(page = 1, limit = 50, sort = 'created_at', direction = 'desc') {
        const safePage = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
        const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
        const offset = (safePage - 1) * safeLimit;
        const orderColumn = sort === 'id' ? 'id' : 'created_at';
        const orderDirection = String(direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const [count, rows] = await Promise.all([
            pool.query('SELECT COUNT(*)::int AS total FROM orders'),
            pool.query(
                `SELECT o.id, o.order_number, o.user_name, o.phone, o.total, o.status, o.delivery_type, o.created_at,
                        CASE WHEN o.status IN ('DELIVERED', 'COMPLETED') THEN
                            (SELECT rs.delivered_at FROM route_stops rs WHERE rs.status = 'delivered' AND rs.order_id = o.id::text ORDER BY rs.id DESC LIMIT 1)
                        END AS delivery_completed_at,
                        CASE WHEN o.status IN ('DELIVERY_FAILED', 'CANCELLED') THEN
                            (SELECT rs.fail_reason FROM route_stops rs WHERE rs.status IN ('failed', 'cancelled') AND rs.order_id = o.id::text ORDER BY rs.id DESC LIMIT 1)
                        END AS fail_reason
                   FROM orders o
                  ORDER BY o.${orderColumn} ${orderDirection}, o.id DESC
                  LIMIT $1 OFFSET $2`,
                [safeLimit, offset]
            )
        ]);
        return { items: rows.rows, total: count.rows[0].total, page: safePage, limit: safeLimit, sort: orderColumn, direction: orderDirection.toLowerCase() };
    }
    async getOrderCustomers() {
        const res = await pool.query(
            `SELECT MAX(user_name) AS user_name, phone,
                    COUNT(*)::int AS orders, COALESCE(SUM(total), 0)::float8 AS total,
                    MAX(created_at) AS last_date
               FROM orders
              WHERE phone IS NOT NULL AND phone <> ''
              GROUP BY phone
              ORDER BY last_date DESC
              LIMIT 5000`
        );
        return res.rows;
    }

    async getOrders() {
        const res = await pool.query('SELECT * FROM orders ORDER BY id DESC');
        return res.rows;
    }

    // Заказ одной транзакцией + защита от сбоев связи и двойной отправки.
    //  • 23505 по ключу операции (параллельный повтор того же запроса) → возвращаем уже созданный заказ, флаг duplicate.
    //  • Обрыв связи: если до COMMIT — повторяем всю транзакцию заново (ничего не записано).
    //    Если COMMIT уже отправлен, а ответа нет, исход неизвестен: с ключом повторяем (индекс по ключу не даст дубля),
    //    без ключа — честно сообщаем, что заказ надо повторить (err.outcomeUnknown).
    async createOrder(order) {
        const attempts = 3;
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            const state = { commitSent: false };
            try {
                return await this._createOrderOnce(order, state);
            } catch (e) {
                // 23505 при повторе: сработал индекс по ключу операции или по номеру заказа (повтор после обрыва использует тот же номер)
                if (e && e.code === '23505' && order.idempotency_key && order.user_id
                    && /orders_idempotency_key_idx|orders_order_number_key/.test(String(e.constraint || e.message || ''))) {
                    const same = await pool.query('SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2', [order.user_id, order.idempotency_key]);
                    if (same.rows[0]) return Object.assign({}, same.rows[0], { duplicate: true });
                }
                if (!isTransientDbError(e)) throw e;
                lastErr = e;
                console.warn(`[db] createOrder: обрыв связи (попытка ${i + 1}/${attempts}${state.commitSent ? ', COMMIT уже отправлен' : ''}):`, String(e.message).slice(0, 120));
                if (state.commitSent && !order.idempotency_key) { e.outcomeUnknown = true; e.transient = true; throw e; }
                if (i < attempts - 1) await new Promise(r => setTimeout(r, 300 * (i + 1) ** 2));
            }
        }
        lastErr.transient = true;
        throw lastErr;
    }

    async _createOrderOnce(order, state) {
        const client = await pool.connect();
        // Пока клиент выдан из пула, обрыв связи приходит событием 'error' на нём самом. Без обработчика Node завершает процесс.
        let broken = null;
        const onClientError = (err) => { broken = err; console.warn('[db] соединение оборвано во время заказа:', String(err.message).slice(0, 120)); };
        client.on('error', onClientError);
        try {
            await client.query('BEGIN');

            const res = await client.query(
                `INSERT INTO orders (order_number, user_id, user_name, phone, address, zone, city, street, house,
                                     building, structure, letter, entrance, floor, apartment, items, subtotal, total, discount, discount_code,
                                     delivery_type, payment, comment, status, payment_status, delivery_cost, idempotency_key,
                                     referrer_id, referral_code, bonus_used)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30) RETURNING *`,
                [order.order_number, order.user_id, order.user_name, order.phone, order.address,
                 order.zone, order.city, order.street, order.house,
                 order.building || null, order.structure || null, order.letter || null, order.entrance, order.floor || null, order.apartment,
                 JSON.stringify(order.items || []),
                 order.subtotal || 0,
                 order.total,
                 order.discount || 0,
                 order.discount_code || null,
                 order.delivery_type || 'delivery',
                 order.payment || 'cash',
                 order.comment,
                 order.status || 'NEW',
                 order.payment_status || 'PENDING',
                 order.delivery_cost || 0,
                 order.idempotency_key || null,
                 order.referrer_id || null, order.referral_code || null, Math.max(0, Math.floor(Number(order.bonus_used) || 0))]
            );

            // Списание бонусов — в той же транзакции; блокировка по клиенту исключает двойное списание двумя заказами сразу
            const bonusUsed = Math.max(0, Math.floor(Number(order.bonus_used) || 0));
            if (bonusUsed > 0) {
                if (!order.user_id) { const err = new Error('BONUS_INSUFFICIENT'); err.code = 'BONUS_INSUFFICIENT'; throw err; }
                await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [String(order.user_id)]);
                const bal = Number((await client.query('SELECT COALESCE(SUM(delta), 0)::int AS b FROM bonus_ledger WHERE user_id = $1', [order.user_id])).rows[0].b);
                if (bal < bonusUsed) { const err = new Error('BONUS_INSUFFICIENT'); err.code = 'BONUS_INSUFFICIENT'; throw err; }
                await client.query("INSERT INTO bonus_ledger (user_id, delta, reason, order_id, note) VALUES ($1, $2, 'spend', $3, 'оплата бонусами')", [order.user_id, -bonusUsed, res.rows[0].id]);
            }

            // Уведомления о новом заказе — в очередь в той же транзакции: заказ без уведомлений не останется
            if (typeof order.buildNotifications === 'function') {
                for (const n of order.buildNotifications(res.rows[0]) || []) await enqueueNotice(client, n);
            }

            // Инкремент использований промокода — в той же транзакции,
            // чтобы «списанный» промокод не остался на откатившемся заказе.
            if (order.discount_code && this.promoEnabled === true) {
                const up = await client.query(
                    `UPDATE promo_codes
                        SET uses_count = uses_count + 1
                      WHERE UPPER(TRIM(code)) = UPPER(TRIM($1))
                        AND (max_uses IS NULL OR uses_count < max_uses)`,
                    [String(order.discount_code)]
                );
                // Параллельный заказ мог исчерпать лимит: не даём скидку, откатываем заказ
                if (up.rowCount === 0) { const err = new Error('PROMO_EXHAUSTED'); err.code = 'PROMO_EXHAUSTED'; throw err; }
            }

            // Первый положительный остаток включает складской учёт постоянно: нулевой остаток после продаж
            // не должен отключать проверку и снова разрешать заказы отсутствующего товара.
            await client.query(`
                INSERT INTO app_flags (flag)
                SELECT 'stock_tracking_enabled'
                 WHERE EXISTS (SELECT 1 FROM products WHERE active AND stock > 0)
                ON CONFLICT (flag) DO NOTHING
            `);
            const tracking = (await client.query(
                `SELECT EXISTS(SELECT 1 FROM app_flags WHERE flag = 'stock_tracking_enabled') AS on`
            )).rows[0].on;
            if (tracking) {
                const list = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
                for (let itemIndex = 0; itemIndex < list.length; itemIndex++) {
                    const it = list[itemIndex];
                    const q = await client.query(
                        'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING id, stock + $1 AS stock_before, stock AS stock_after',
                        [it.qty, it.productId]
                    );
                    if (q.rowCount === 0) {
                        const err = new Error('OUT_OF_STOCK'); err.code = 'OUT_OF_STOCK'; err.product = it.name; throw err;
                    }
                    const movement = q.rows[0];
                    await client.query(
                        `INSERT INTO stock_movements
                            (product_id, movement_type, qty_delta, stock_before, stock_after, order_id, reason, operation_key)
                         VALUES ($1, 'order_deduction', $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (operation_key) DO NOTHING`,
                        [movement.id, -Number(it.qty), Number(movement.stock_before), Number(movement.stock_after),
                         res.rows[0].id, 'Списание по заказу ' + String(order.order_number || res.rows[0].id),
                         'order:' + res.rows[0].id + ':deduction:' + itemIndex]
                    );
                }
                await client.query('UPDATE orders SET stock_deducted = true WHERE id = $1', [res.rows[0].id]);
            }

            state.commitSent = true;
            await client.query('COMMIT');
            return res.rows[0];
        } catch (e) {
            if (isTransientDbError(e) || broken) broken = broken || e;
            else await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.removeListener('error', onClientError);
            client.release(broken ? true : undefined);   // оборванное соединение не возвращаем в пул
        }
    }

    // ───────────────────────────────────────────
    // Отмена / смена статуса
    // ───────────────────────────────────────────

    // Возврат списанного остатка на склад. Вызывать только внутри транзакции, после блокировки строки заказа.
    // Флаг stock_deducted сбрасывается, чтобы повторная отмена или удаление не вернули товар второй раз.
    async _restoreStock(client, order) {
        if (!order.stock_deducted) return;
        const raw = order.items;
        const list = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
        for (let itemIndex = 0; itemIndex < list.length; itemIndex++) {
            const it = list[itemIndex];
            const restored = await client.query(
                'UPDATE products SET stock = stock + $1 WHERE id = $2 RETURNING id, stock - $1 AS stock_before, stock AS stock_after',
                [it.qty, it.productId]
            );
            if (restored.rowCount > 0) {
                const movement = restored.rows[0];
                await client.query(
                    `INSERT INTO stock_movements
                        (product_id, movement_type, qty_delta, stock_before, stock_after, order_id, reason, operation_key)
                     VALUES ($1, 'order_return', $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (operation_key) DO NOTHING`,
                    [movement.id, Number(it.qty), Number(movement.stock_before), Number(movement.stock_after),
                     order.id, 'Возврат по отмене заказа ' + String(order.order_number || order.id),
                     'order:' + order.id + ':return:' + itemIndex]
                );
            }
        }
        await client.query('UPDATE orders SET stock_deducted = false WHERE id = $1', [order.id]);
    }

    // Единая точка смены статуса из админки и курьерского бота.
    // CANCELLED возвращает остаток (если заказ не доставлен) и снимает остановки маршрута.
    // Отменённый заказ в работу вернуть нельзя: остаток уже отдан другим покупателям (вернёт 'CANCELLED_LOCKED').
    // Результат: true — статус изменён; 'ALREADY' — уже был таким, ничего не менялось; false — заказ не найден;
    // 'CANCELLED_LOCKED' — заказ отменён, статус не изменён; 'TRANSITION_FORBIDDEN' — такая смена статуса запрещена.
    async updateOrderStatus(orderId, status, { afterUpdate = null } = {}) {
        // 'AP-…' — не PK, отвечаем «не найдено» вместо 22P02 от Postgres.
        const id = Number(orderId);
        if (!Number.isInteger(id) || id <= 0) return false;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const cur = await client.query(
                'SELECT id, status, items, stock_deducted, order_number, user_id, user_name, phone, address, referrer_id, bonus_used, total, delivery_cost, delivery_type FROM orders WHERE id = $1 FOR UPDATE', [id]);
            if (cur.rowCount === 0) { await client.query('ROLLBACK').catch(() => {}); return false; }
            const o = cur.rows[0];
            if (o.status === status) { await client.query('COMMIT'); return 'ALREADY'; }
            if (o.status === 'CANCELLED') { await client.query('ROLLBACK').catch(() => {}); return 'CANCELLED_LOCKED'; }
            if (!orderTransitionAllowed(o.status, status)) { await client.query('ROLLBACK').catch(() => {}); return 'TRANSITION_FORBIDDEN'; }
            if ((status === 'READY_FOR_SHIPMENT' && o.delivery_type === 'pickup') ||
                (['READY_FOR_PICKUP', 'PICKED_UP'].includes(status) && o.delivery_type !== 'pickup')) {
                await client.query('ROLLBACK').catch(() => {});
                return 'TRANSITION_FORBIDDEN';
            }
            // Товар доставлен: остаток больше не «наш», флаг снимаем — повторного возврата быть не может.
            await client.query(
                `UPDATE orders SET status = $1::text,
                        stock_deducted = CASE WHEN $1::text IN ('DELIVERED', 'COMPLETED', 'PICKED_UP') THEN false ELSE stock_deducted END
                  WHERE id = $2`, [status, id]);
            if (status === 'CANCELLED') {
                if (!['DELIVERED', 'COMPLETED'].includes(o.status)) await this._restoreStock(client, o);
                await client.query(
                    `UPDATE route_stops SET status = 'cancelled'
                      WHERE order_number = $1 AND status IN ('pending', 'in_progress')`, [o.order_number]);
                // сообщения курьеру и клиенту — в той же транзакции: отмена и уведомления либо есть вместе, либо нет
                await queueCancelNotices(client, o);
                await this._undoBonuses(client, o);
            }
            if (status === 'DELIVERED' || status === 'COMPLETED' || status === 'PICKED_UP') await this._grantReferralBonus(client, o);
            if (typeof afterUpdate === 'function') await afterUpdate({ order: o, client, status });
            await client.query('COMMIT');
            return true;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }

    // ───────────────────────────────────────────
    // Бонусы и рефералы (правила — в referral.js)
    // ───────────────────────────────────────────

    async getSettings() {
        if (this._settings && Date.now() - this._settings.at < 60_000) return this._settings.v;
        const v = { ...REF_DEFAULTS };
        try {
            const r = await pool.query("SELECT key, value FROM app_settings WHERE key IN ('referral_bonus', 'referral_min_order', 'bonus_max_share_pct')");
            for (const row of r.rows) { const n = Number(row.value); if (Number.isFinite(n) && n >= 0) v[row.key] = n; }
        } catch (e) { /* таблицы нет — используем значения по умолчанию */ }
        this._settings = { at: Date.now(), v };
        return v;
    }

    async getBonusBalance(userId, client = pool) {
        if (!userId) return 0;
        const r = await client.query('SELECT COALESCE(SUM(delta), 0)::int AS b FROM bonus_ledger WHERE user_id = $1', [userId]);
        return r.rows[0].b;
    }

    async getBonusSummary(userId) {
        const [balance, earned, invited, history] = await Promise.all([
            this.getBonusBalance(userId),
            pool.query("SELECT COALESCE(SUM(delta), 0)::int AS s FROM bonus_ledger WHERE user_id = $1 AND reason = 'referral'", [userId]),
            pool.query("SELECT COUNT(*)::int AS n FROM bonus_ledger WHERE user_id = $1 AND reason = 'referral'", [userId]),
            pool.query('SELECT delta, reason, created_at FROM bonus_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [userId])
        ]);
        return { balance, earned: earned.rows[0].s, invitedOrders: invited.rows[0].n, history: history.rows };
    }

    // Код друга годится, если это не сам покупатель, такой клиент у нас есть и телефон заказа не совпадает с его телефонами
    // (защита от «приглашения» самого себя со второго аккаунта). Возвращает { ok, referrerId } или { ok: false, reason }.
    async resolveReferrer(referrerId, buyerId, phone) {
        const id = String(referrerId || '');
        if (!/^\d{5,15}$/.test(id)) return { ok: false, reason: 'bad_code' };
        if (buyerId && String(buyerId) === id) return { ok: false, reason: 'own_code' };
        const known = await pool.query(
            `SELECT 1 FROM orders WHERE user_id = $1 UNION ALL SELECT 1 FROM customer_profiles WHERE user_id = $1 LIMIT 1`, [id]);
        if (!known.rowCount) return { ok: false, reason: 'unknown_code' };
        if (phone) {
            const phones = await pool.query(
                `SELECT phone FROM orders WHERE user_id = $1 UNION SELECT phone FROM customer_profiles WHERE user_id = $1`, [id]);
            const mine = phoneKey(phone);
            if (mine && phones.rows.some(r => phoneKey(r.phone) === mine)) return { ok: false, reason: 'own_phone' };
        }
        return { ok: true, referrerId: id };
    }

    // Заказ друга доставлен: приглашающему +бонус (один раз на заказ — защищает уникальный индекс)
    async _grantReferralBonus(client, o) {
        if (!o.referrer_id) return;
        const s = await this.getSettings();
        const paidGoods = Number(o.total) - Number(o.delivery_cost || 0);
        if (!qualifiesForReferralBonus(paidGoods, s.referral_min_order)) return;
        await client.query(
            `INSERT INTO bonus_ledger (user_id, delta, reason, order_id, note)
             VALUES ($1, $2, 'referral', $3, $4) ON CONFLICT DO NOTHING`,
            [o.referrer_id, Math.floor(s.referral_bonus), o.id, `заказ друга ${o.order_number}`]);
    }

    // Заказ отменён или возвращён: списанные бонусы возвращаются покупателю, бонус приглашающему аннулируется
    async _undoBonuses(client, o) {
        const used = Math.floor(Number(o.bonus_used) || 0);
        if (used > 0 && o.user_id) {
            await client.query(
                `INSERT INTO bonus_ledger (user_id, delta, reason, order_id, note)
                 VALUES ($1, $2, 'spend_refund', $3, 'возврат бонусов: заказ отменён') ON CONFLICT DO NOTHING`, [o.user_id, used, o.id]);
        }
        if (o.referrer_id) {
            const g = await client.query("SELECT delta FROM bonus_ledger WHERE order_id = $1 AND reason = 'referral'", [o.id]);
            if (g.rowCount) {
                await client.query(
                    `INSERT INTO bonus_ledger (user_id, delta, reason, order_id, note)
                     VALUES ($1, $2, 'referral_revoked', $3, 'аннулировано: заказ друга отменён') ON CONFLICT DO NOTHING`,
                    [o.referrer_id, -g.rows[0].delta, o.id]);
            }
        }
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
                    AND status NOT IN ('CANCELLED', 'DELIVERED', 'COMPLETED', 'PICKED_UP')
                 RETURNING id, items, stock_deducted, order_number, user_id, referrer_id, bonus_used, total, delivery_cost`,
                [orderNumber]
            );

            if (res.rowCount === 0) {
                await client.query('ROLLBACK').catch(() => {});
                return false;
            }

            // Возвращаем товар на склад, если при заказе остаток списывался
            await this._restoreStock(client, res.rows[0]);

            // Убираем из активных остановок маршрута, чтобы курьер
            // не приехал по отменённому адресу.
            await client.query(
                `UPDATE route_stops
                    SET status = 'cancelled'
                  WHERE order_number = $1
                    AND status IN ('pending', 'in_progress')`,
                [orderNumber]
            );
            await queueCancelNotices(client, res.rows[0]);
            await this._undoBonuses(client, res.rows[0]);

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
    // ───────────────────────────────────────────
    // Скидки по обороту (loyalty_tiers)
    // ───────────────────────────────────────────

    async getLoyaltyTiers() {
        const now = Date.now();
        if (this._tiers && now - this._tiersAt < 60_000) return this._tiers;
        const res = await pool.query('SELECT min_turnover, percent, name FROM loyalty_tiers ORDER BY min_turnover');
        this._tiers = res.rows.map(r => ({ at: Number(r.min_turnover), percent: Number(r.percent), name: r.name }));
        this._tiersAt = now;
        return this._tiers;
    }

    // Оборот клиента: сумма товаров (без доставки) по доставленным и завершённым заказам.
    async getCustomerTurnover(userId) {
        const res = await pool.query(
            `SELECT COALESCE(SUM(GREATEST(total - COALESCE(delivery_cost, 0), 0)), 0) AS t
               FROM orders WHERE user_id = $1::bigint AND status IN ('DELIVERED', 'COMPLETED')`, [String(userId)]);
        return Number(res.rows[0].t) || 0;
    }

    // Текущая скидка клиента и ближайший уровень. Считает только сервер.
    async getLoyalty(userId) {
        const [tiers, turnover] = await Promise.all([this.getLoyaltyTiers(), this.getCustomerTurnover(userId)]);
        let cur = null, next = null;
        for (const t of tiers) { if (t.at <= turnover) cur = t; else { next = t; break; } }
        return {
            turnover,
            percent: cur ? cur.percent : 0,
            name: cur ? cur.name : '',
            from: cur ? cur.at : 0,
            next: next ? { at: next.at, percent: next.percent, name: next.name } : null,
            tiers
        };
    }

    // История заказов клиента (только его заказы, без телефона и комментария).
    async getOrdersByUser(userId, limit = 50) {
        const res = await pool.query(
            `SELECT order_number, status, payment_status, delivery_type, address, items,
                    subtotal, total, discount, delivery_cost, created_at
               FROM orders
              WHERE user_id = $1::bigint AND NOT customer_hidden
              ORDER BY id DESC LIMIT $2::int`, [String(userId), Math.min(Math.max(parseInt(limit) || 50, 1), 100)]);
        return res.rows;
    }

    // «Удаление» из истории: скрываем только завершённые заказы клиента; активные остаются видимыми.
    // Возвращает номера скрытых заказов.
    async hideOrdersForUser(userId, orderNumbers) {
        const list = (Array.isArray(orderNumbers) ? orderNumbers : []).map(String).slice(0, 100);
        if (!list.length) return [];
        const res = await pool.query(
            `UPDATE orders SET customer_hidden = true
              WHERE user_id = $1::bigint AND order_number = ANY($2::text[])
                AND status IN ('DELIVERED', 'COMPLETED', 'CANCELLED')
          RETURNING order_number`, [String(userId), list]);
        return res.rows.map(r => r.order_number);
    }

    async getOrderByNumber(orderId) {
        return this.getOrderById(orderId);
    }

    // Внутренняя служебная очистка тестовых/временных данных.
    // Публичный API массового удаления заказов отключён.
    async deleteAllOrders() {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Незавершённые заказы с списанным остатком: возвращаем товар на склад до удаления.
            // Доставленные и завершённые не трогаем: товар у покупателя.
            const active = await client.query(
                `SELECT id, items, stock_deducted FROM orders
                  WHERE stock_deducted AND status NOT IN ('CANCELLED', 'DELIVERED', 'COMPLETED') FOR UPDATE`);
            for (const o of active.rows) await this._restoreStock(client, o);
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

    async getZoneByCode(code) {
        const res = await pool.query('SELECT * FROM delivery_zones WHERE zone_code = $1 AND is_active = true', [code]);
        return res.rows[0] || null;
    }

    async getOrderByIdempotencyKey(userId, key) {
        const res = await pool.query('SELECT order_number, total FROM orders WHERE user_id = $1 AND idempotency_key = $2', [userId, key]);
        return res.rows[0] || null;
    }

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

    // Публичный каталог для магазина: без закупочных и служебных полей
    async getPublicCatalog() {
        const res = await pool.query(
            `SELECT id, brand, category, name, full_name, series, sku, viscosity, oil_type, volume, api_std, acea, ilsac,
                    price, old_price, stock, image, gallery, description, specs, is_new, is_popular, coming_soon, rating, reviews_count
               FROM products WHERE active = true ORDER BY id`);
        const tracking = (await pool.query(
            `SELECT EXISTS(SELECT 1 FROM app_flags WHERE flag = 'stock_tracking_enabled')
                 OR EXISTS(SELECT 1 FROM products WHERE active AND stock > 0) AS enabled`
        )).rows[0].enabled;
        return res.rows.map(({ stock, ...r }) => ({
            ...r,
            in_stock: tracking ? stock > 0 : true,
            stock_left: tracking && stock > 0 && stock <= 5 ? stock : null
        }));
    }

    async getAllProducts() {
        const res = await pool.query('SELECT * FROM products ORDER BY id');
        return res.rows;
    }

    async getStockMovements(productId, limit = 100) {
        const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
        const res = await pool.query(
            `SELECT sm.id, sm.product_id, sm.movement_type, sm.qty_delta,
                    sm.stock_before, sm.stock_after, sm.order_id, o.order_number,
                    sm.actor_user_id, sm.actor_role, sm.reason, sm.created_at
               FROM stock_movements sm
               LEFT JOIN orders o ON o.id = sm.order_id
              WHERE sm.product_id = $1
              ORDER BY sm.created_at DESC, sm.id DESC
              LIMIT $2`,
            [productId, safeLimit]
        );
        return res.rows;
    }

    async createProduct(p, options = {}) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(
                `INSERT INTO products (brand, category, name, full_name, series, sku, viscosity, oil_type, volume, api_std, acea, ilsac, price, old_price, stock, min_stock, image, description, specs, active, is_new, is_popular)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING *`,
                [p.brand, p.category, p.name, p.full_name || p.name, p.series, p.sku,
                 p.viscosity, p.oil_type, p.volume, p.api_std || p.api, p.acea, p.ilsac,
                 p.price, p.old_price ?? null, p.stock ?? 0, p.min_stock ?? 3,
                 p.image || p.main_image, p.description ?? null,
                 toDbValue(p.specs || {}),
                 p.active !== false, p.is_new || false, p.is_popular || false]
            );
            const created = res.rows[0];
            const initialStock = Number(created.stock) || 0;
            if (initialStock > 0) {
                await client.query(
                    `INSERT INTO stock_movements
                        (product_id, movement_type, qty_delta, stock_before, stock_after,
                         actor_user_id, actor_role, reason, operation_key)
                     VALUES ($1, 'manual_adjustment', $2, 0, $2, $3, $4, $5, $6)`,
                    [created.id, initialStock, options.actorId || null, options.actorRole || null,
                     'Начальный остаток при создании товара',
                     'product:' + created.id + ':initial:' + require('crypto').randomUUID()]
                );
                await client.query(
                    "INSERT INTO app_flags (flag) VALUES ('stock_tracking_enabled') ON CONFLICT (flag) DO NOTHING"
                );
            }
            await client.query('COMMIT');
            return created;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    }

    async updateProduct(id, p, options = {}) {
        const expectedStock = options && options.expectedStock !== undefined ? options.expectedStock : undefined;
        const allowed = [
            'brand', 'category', 'name', 'full_name', 'series', 'sku', 'viscosity', 'oil_type',
            'volume', 'api_std', 'acea', 'ilsac', 'price', 'old_price', 'stock', 'min_stock',
            'image', 'description', 'specs', 'active', 'is_new', 'is_popular', 'coming_soon'
        ];
        const fields = [];
        const values = [];
        let idx = 1;
        for (const [key, val] of Object.entries(p)) {
            if (!allowed.includes(key) || val === undefined) continue;
            fields.push(`${key} = $${idx}`);
            values.push(toDbValue(val));
            idx++;
        }
        if (fields.length === 0) return null;
        const tracksStock = Object.prototype.hasOwnProperty.call(p, 'stock') && p.stock !== undefined;
        if (expectedStock !== undefined && !tracksStock) {
            const err = new Error('EXPECTED_STOCK_REQUIRES_STOCK_UPDATE'); err.code = 'INVALID_EXPECTED_STOCK'; throw err;
        }
        if (tracksStock) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                let stockBefore;
                if (expectedStock !== undefined) {
                    stockBefore = Number(expectedStock);
                } else {
                    const locked = await client.query('SELECT stock FROM products WHERE id = $1 FOR UPDATE', [id]);
                    if (!locked.rowCount) {
                        await client.query('COMMIT');
                        return null;
                    }
                    stockBefore = Number(locked.rows[0].stock);
                }
                const updateValues = [...values, id];
                let whereSql = ` WHERE id = $${idx}`;
                if (expectedStock !== undefined) {
                    updateValues.push(expectedStock);
                    whereSql += ` AND stock = $${idx + 1}`;
                }
                const res = await client.query(
                    'UPDATE products SET ' + fields.join(', ') + whereSql + ' RETURNING *',
                    updateValues
                );
                if (res.rowCount === 0 && expectedStock !== undefined) {
                    const exists = await client.query('SELECT 1 FROM products WHERE id = $1', [id]);
                    if (exists.rowCount > 0) {
                        const err = new Error('STOCK_CONFLICT'); err.code = 'STOCK_CONFLICT'; throw err;
                    }
                }
                if (res.rowCount > 0) {
                    const stockAfter = Number(res.rows[0].stock);
                    if (stockAfter !== stockBefore) {
                        const reason = String(options.reason || 'Ручная корректировка из админ-панели').trim().slice(0, 500);
                        await client.query(
                            `INSERT INTO stock_movements
                                (product_id, movement_type, qty_delta, stock_before, stock_after,
                                 actor_user_id, actor_role, reason, operation_key)
                             VALUES ($1, 'manual_adjustment', $2, $3, $4, $5, $6, $7, $8)`,
                            [id, stockAfter - stockBefore, stockBefore, stockAfter,
                             options.actorId || null, options.actorRole || null, reason || 'Ручная корректировка',
                             'manual:' + require('crypto').randomUUID()]
                        );
                    }
                    await client.query(
                        "INSERT INTO app_flags (flag) VALUES ('stock_tracking_enabled') ON CONFLICT (flag) DO NOTHING"
                    );
                }
                await client.query('COMMIT');
                return res.rows[0] || null;
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                throw e;
            } finally {
                client.release();
            }
        }
        const updateValues = [...values, id];
        const res = await pool.query(
            'UPDATE products SET ' + fields.join(', ') + ` WHERE id = $${idx} RETURNING *`,
            updateValues
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
module.exports.isTransientDbError = isTransientDbError;
