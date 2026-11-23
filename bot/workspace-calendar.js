'use strict';

const { requirePermission, hasPermission } = require('./admin-permissions');

const KINDS = new Set(['task', 'meeting', 'contract', 'logistics', 'kpi', 'note']);
const STATUSES = new Set(['planned', 'in_progress', 'done', 'cancelled']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

function validDate(value) {
    if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validMonth(value) {
    if (typeof value !== 'string' || !ISO_MONTH.test(value)) return false;
    const [year, month] = value.split('-').map(Number);
    return year >= 2020 && year <= 2100 && month >= 1 && month <= 12;
}
function validTimestamp(value) {
    if (typeof value !== 'string' || value.length > 40) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && /T/.test(value);
}
function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function cleanText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function normalizeItem(body, { partial = false } = {}) {
    const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const result = {};
    const fields = ['kind', 'title', 'description', 'startsAt', 'dueAt', 'allDay', 'status',
        'priority', 'assignedTo', 'companyVisible', 'location', 'counterparty',
        'amount', 'metricName', 'metricValue', 'metricTarget'];
    for (const key of fields) {
        if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
    }
    if (!partial || Object.prototype.hasOwnProperty.call(result, 'kind')) {
        if (!KINDS.has(result.kind)) return { error: 'Выберите тип события.' };
    }
    if (!partial || Object.prototype.hasOwnProperty.call(result, 'title')) {
        result.title = cleanText(result.title, 200);
        if (result.title.length < 2) return { error: 'Название должно содержать не менее двух символов.' };
    }
    if (Object.prototype.hasOwnProperty.call(result, 'description')) result.description = cleanText(result.description, 5000);
    if (Object.prototype.hasOwnProperty.call(result, 'startsAt')) {
        if (result.startsAt !== null && !validTimestamp(result.startsAt)) return { error: 'Некорректные дата и время начала.' };
    } else if (!partial && result.kind !== 'task') return { error: 'Укажите дату и время события.' };
    if (Object.prototype.hasOwnProperty.call(result, 'dueAt')) {
        if (result.dueAt !== null && !validTimestamp(result.dueAt)) return { error: 'Некорректный срок.' };
    } else if (!partial && result.kind === 'task') return { error: 'Для задачи укажите срок выполнения.' };
    if (Object.prototype.hasOwnProperty.call(result, 'status')) {
        if (!STATUSES.has(result.status)) return { error: 'Недопустимый статус.' };
    } else if (!partial) result.status = 'planned';
    if (Object.prototype.hasOwnProperty.call(result, 'priority')) {
        if (!PRIORITIES.has(result.priority)) return { error: 'Недопустимый приоритет.' };
    } else if (!partial) result.priority = 'normal';
    if (Object.prototype.hasOwnProperty.call(result, 'assignedTo')) {
        if (result.assignedTo === null || result.assignedTo === '') result.assignedTo = null;
        else {
            result.assignedTo = positiveId(result.assignedTo);
            if (!result.assignedTo) return { error: 'Некорректный исполнитель.' };
        }
    } else if (!partial) result.assignedTo = null;
    if (!partial && result.kind === 'task' && !result.assignedTo) return { error: 'Для задачи выберите сотрудника.' };
    if (Object.prototype.hasOwnProperty.call(result, 'allDay')) result.allDay = result.allDay === true;
    else if (!partial) result.allDay = false;
    if (Object.prototype.hasOwnProperty.call(result, 'companyVisible')) result.companyVisible = result.companyVisible === true;
    else if (!partial) result.companyVisible = true;
    for (const key of ['location', 'counterparty', 'metricName']) {
        if (Object.prototype.hasOwnProperty.call(result, key)) result[key] = cleanText(result[key], key === 'metricName' ? 120 : 250);
    }
    for (const key of ['amount', 'metricValue', 'metricTarget']) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            if (result[key] === '' || result[key] === null) result[key] = null;
            else {
                const value = Number(result[key]);
                if (!Number.isFinite(value) || Math.abs(value) > 1000000000000) return { error: 'Некорректное числовое значение.' };
                result[key] = value;
            }
        }
    }
    return { value: result };
}

function registerWorkspaceCalendarRoutes(app, { pool, verifyAdmin }) {
    if (!app || !pool || typeof pool.query !== 'function' || typeof verifyAdmin !== 'function') {
        throw new TypeError('registerWorkspaceCalendarRoutes requires app, pool and verifyAdmin');
    }

    app.get('/api/admin/workspace/staff', verifyAdmin, requirePermission('workspace.manage'), async (_req, res) => {
        try {
            const result = await pool.query(
                'SELECT id, display_name AS "displayName", role FROM admin_users WHERE is_active = TRUE ORDER BY display_name, id'
            );
            res.set('Cache-Control', 'no-store');
            return res.json(result.rows);
        } catch (error) {
            console.error('[WORKSPACE STAFF]', String(error.code || error.name || 'unknown').slice(0, 40));
            return res.status(500).json({ error: 'Не удалось загрузить список сотрудников.' });
        }
    });

    app.get('/api/admin/workspace/calendar', verifyAdmin, requirePermission('workspace.view'), async (req, res) => {
        const month = req.query.month;
        if (!validMonth(month)) return res.status(400).json({ error: 'Укажите месяц в формате YYYY-MM.' });
        const [year, monthNumber] = month.split('-').map(Number);
        const from = year + '-' + String(monthNumber).padStart(2, '0') + '-01';
        const toDate = new Date(Date.UTC(year, monthNumber, 0));
        const to = toDate.toISOString().slice(0, 10);
        const canManage = hasPermission(req.admin && req.admin.role, 'workspace.manage');
        const canSeeSales = hasPermission(req.admin && req.admin.role, 'sales.view');
        try {
            const [orders, stock, items] = await Promise.all([
                pool.query(
                    `SELECT TO_CHAR((o.created_at AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS day,
                            COUNT(*)::int AS orders,
                            COUNT(*) FILTER (WHERE o.status = 'NEW')::int AS new_orders,
                            COUNT(*) FILTER (WHERE o.status = 'SHIPPING')::int AS shipping,
                            COUNT(*) FILTER (WHERE o.status IN ('DELIVERED','COMPLETED'))::int AS delivered,
                            COUNT(*) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled,
                            COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'CANCELLED'), 0)::float8 AS revenue
                       FROM orders o
                      WHERE (o.created_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date
                      GROUP BY 1 ORDER BY 1`,
                    [from, to]
                ),
                pool.query(
                    `SELECT TO_CHAR((created_at AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS day,
                            COUNT(*)::int AS movements,
                            COUNT(*) FILTER (WHERE qty_delta < 0)::int AS "outMovements",
                            COUNT(*) FILTER (WHERE qty_delta > 0)::int AS "inMovements",
                            COALESCE(SUM(-qty_delta) FILTER (WHERE qty_delta < 0), 0)::int AS "qtyOut",
                            COALESCE(SUM(qty_delta) FILTER (WHERE qty_delta > 0), 0)::int AS "qtyIn"
                       FROM stock_movements
                      WHERE (created_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date
                      GROUP BY 1 ORDER BY 1`,
                    [from, to]
                ),
                pool.query(
                    `SELECT w.id, w.kind, w.title, w.description, w.starts_at AS "startsAt",
                            w.due_at AS "dueAt", w.all_day AS "allDay", w.status, w.priority,
                            w.assigned_to AS "assignedTo", u.display_name AS "assigneeName",
                            w.created_by AS "createdBy", w.company_visible AS "companyVisible",
                            w.location, w.counterparty, CASE WHEN $5::boolean THEN w.amount ELSE NULL END AS amount, w.metric_name AS "metricName",
                            w.metric_value AS "metricValue", w.metric_target AS "metricTarget",
                            w.created_at AS "createdAt", w.updated_at AS "updatedAt"
                       FROM workspace_items w
                       LEFT JOIN admin_users u ON u.id = w.assigned_to
                      WHERE COALESCE(w.due_at, w.starts_at) IS NOT NULL
                        AND (COALESCE(w.due_at, w.starts_at) AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date
                        AND ($3::boolean OR w.assigned_to = $4 OR (w.kind <> 'task' AND w.company_visible = TRUE))
                      ORDER BY COALESCE(w.due_at, w.starts_at), w.priority DESC, w.id`,
                    [from, to, canManage, req.admin.userId || null, canSeeSales]
                )
            ]);
            const dayMap = new Map();
            for (const row of orders.rows) dayMap.set(row.day, {
                date: row.day, orders: row.orders, newOrders: row.new_orders,
                shipping: row.shipping, delivered: row.delivered, cancelled: row.cancelled,
                revenue: canSeeSales ? (Number(row.revenue) || 0) : null, tasks: 0, tasksDone: 0,
                meetings: 0, contracts: 0, logistics: 0, kpi: 0,
                stockMovements: 0, outMovements: 0, inMovements: 0, qtyOut: 0, qtyIn: 0
            });
            for (const row of stock.rows) {
                if (!dayMap.has(row.day)) dayMap.set(row.day, {
                    date: row.day, orders: 0, newOrders: 0, shipping: 0, delivered: 0,
                    cancelled: 0, revenue: canSeeSales ? 0 : null, tasks: 0, tasksDone: 0,
                    meetings: 0, contracts: 0, logistics: 0, kpi: 0,
                    stockMovements: 0, outMovements: 0, inMovements: 0, qtyOut: 0, qtyIn: 0
                });
                Object.assign(dayMap.get(row.day), {
                    stockMovements: row.movements, outMovements: row.outMovements,
                    inMovements: row.inMovements, qtyOut: row.qtyOut, qtyIn: row.qtyIn
                });
            }
            for (const item of items.rows) {
                const rawDate = item.dueAt || item.startsAt;
                const day = new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
                }).format(new Date(rawDate));
                if (!dayMap.has(day)) dayMap.set(day, {
                    date: day, orders: 0, newOrders: 0, shipping: 0, delivered: 0,
                    cancelled: 0, revenue: canSeeSales ? 0 : null, tasks: 0, tasksDone: 0,
                    meetings: 0, contracts: 0, logistics: 0, kpi: 0,
                    stockMovements: 0, outMovements: 0, inMovements: 0, qtyOut: 0, qtyIn: 0
                });
                const summary = dayMap.get(day);
                if (item.kind === 'task') {
                    summary.tasks++;
                    if (item.status === 'done') summary.tasksDone++;
                } else {
                    const summaryKey = ({ meeting: 'meetings', contract: 'contracts', logistics: 'logistics', kpi: 'kpi' })[item.kind];
                    if (summaryKey) summary[summaryKey]++;
                }
            }
            res.set('Cache-Control', 'no-store');
            return res.json({ month, from, to, days: [...dayMap.values()], items: items.rows });
        } catch (error) {
            console.error('[WORKSPACE CALENDAR]', String(error.code || error.name || 'unknown').slice(0, 40));
            return res.status(500).json({ error: 'Не удалось загрузить рабочий календарь.' });
        }
    });

    app.post('/api/admin/workspace/items', verifyAdmin, requirePermission('workspace.manage'), async (req, res) => {
        const parsed = normalizeItem(req.body);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const item = parsed.value;
        if (item.kind === 'task' && !item.assignedTo) return res.status(400).json({ error: 'Для задачи выберите сотрудника.' });
        if (item.kind === 'task' && !item.dueAt) return res.status(400).json({ error: 'Для задачи укажите срок выполнения.' });
        if (item.kind !== 'task' && !item.startsAt) return res.status(400).json({ error: 'Для события укажите дату и время.' });
        if (item.startsAt && item.dueAt && Date.parse(item.dueAt) < Date.parse(item.startsAt)) {
            return res.status(400).json({ error: 'Срок не может быть раньше начала события.' });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (item.assignedTo) {
                const employee = await client.query('SELECT id FROM admin_users WHERE id = $1 AND is_active = TRUE FOR KEY SHARE', [item.assignedTo]);
                if (!employee.rowCount) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Выбранный сотрудник не найден или отключён.' });
                }
            }
            const result = await client.query(
                `INSERT INTO workspace_items
                    (kind, title, description, starts_at, due_at, all_day, status, priority,
                     assigned_to, created_by, company_visible, location, counterparty, amount,
                     metric_name, metric_value, metric_target)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                 RETURNING id, kind, title, description, starts_at AS "startsAt", due_at AS "dueAt",
                           all_day AS "allDay", status, priority, assigned_to AS "assignedTo",
                           company_visible AS "companyVisible", location, counterparty, amount,
                           metric_name AS "metricName", metric_value AS "metricValue", metric_target AS "metricTarget"`,
                [item.kind, item.title, item.description || null, item.startsAt || null, item.dueAt || null,
                    item.allDay, item.status, item.priority, item.assignedTo, req.admin.userId || null,
                    item.companyVisible, item.location || null, item.counterparty || null, item.amount,
                    item.metricName || null, item.metricValue, item.metricTarget]
            );
            await client.query('COMMIT');
            return res.status(201).json(result.rows[0]);
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            console.error('[WORKSPACE CREATE]', String(error.code || error.name || 'unknown').slice(0, 40));
            return res.status(500).json({ error: 'Не удалось сохранить запись календаря.' });
        } finally {
            client.release();
        }
    });

    app.patch('/api/admin/workspace/items/:id', verifyAdmin, async (req, res) => {
        const id = positiveId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Некорректный номер записи.' });
        const canManage = hasPermission(req.admin && req.admin.role, 'workspace.manage');
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        if (!canManage) {
            if (!hasPermission(req.admin && req.admin.role, 'workspace.update_self') ||
                Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, 'status') ||
                !STATUSES.has(body.status) || !req.admin.userId) {
                return res.status(403).json({ error: 'Можно менять только статус собственных задач.' });
            }
            try {
                const result = await pool.query(
                    `UPDATE workspace_items SET status = $1, updated_at = NOW()
                      WHERE id = $2 AND kind = 'task' AND assigned_to = $3
                      RETURNING id, status`,
                    [body.status, id, req.admin.userId]
                );
                if (!result.rowCount) return res.status(404).json({ error: 'Задача не найдена или недоступна.' });
                return res.json(result.rows[0]);
            } catch (error) {
                console.error('[WORKSPACE SELF UPDATE]', String(error.code || error.name || 'unknown').slice(0, 40));
                return res.status(500).json({ error: 'Не удалось обновить задачу.' });
            }
        }
        const parsed = normalizeItem(body, { partial: true });
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const fields = parsed.value;
        const allowed = Object.keys(fields);
        if (!allowed.length) return res.status(400).json({ error: 'Нет полей для изменения.' });
        const columns = {
            kind: 'kind', title: 'title', description: 'description', startsAt: 'starts_at',
            dueAt: 'due_at', allDay: 'all_day', status: 'status', priority: 'priority',
            assignedTo: 'assigned_to', companyVisible: 'company_visible', location: 'location',
            counterparty: 'counterparty', amount: 'amount', metricName: 'metric_name',
            metricValue: 'metric_value', metricTarget: 'metric_target'
        };
        const values = [];
        const sets = allowed.map(key => {
            values.push(fields[key]);
            return columns[key] + ' = $' + values.length;
        });
        values.push(id);
        try {
            const result = await pool.query(
                'UPDATE workspace_items SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $' + values.length + ' RETURNING id, kind, title, status, assigned_to AS "assignedTo"',
                values
            );
            if (!result.rowCount) return res.status(404).json({ error: 'Запись не найдена.' });
            return res.json(result.rows[0]);
        } catch (error) {
            console.error('[WORKSPACE UPDATE]', String(error.code || error.name || 'unknown').slice(0, 40));
            return res.status(500).json({ error: 'Не удалось изменить запись.' });
        }
    });

    app.delete('/api/admin/workspace/items/:id', verifyAdmin, requirePermission('workspace.manage'), async (req, res) => {
        const id = positiveId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Некорректный номер записи.' });
        try {
            const result = await pool.query(
                "UPDATE workspace_items SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING id, status", [id]
            );
            if (!result.rowCount) return res.status(404).json({ error: 'Запись не найдена.' });
            return res.json(result.rows[0]);
        } catch (error) {
            console.error('[WORKSPACE DELETE]', String(error.code || error.name || 'unknown').slice(0, 40));
            return res.status(500).json({ error: 'Не удалось отменить запись.' });
        }
    });
}

module.exports = {
    registerWorkspaceCalendarRoutes, validDate, validMonth, validTimestamp,
    positiveId, normalizeItem, KINDS, STATUSES, PRIORITIES
};
