'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROLE_PERMISSIONS, ROLE_LABELS, isKnownRole, requirePermission } = require('./admin-permissions');

const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const safeEqual = (a, b) => crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
);
function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0 || part.slice(0, i).trim() !== name) continue;
        try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
    return null;
}
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    return new Promise((resolve, reject) => crypto.scrypt(
        password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (err, key) => err ? reject(err) : resolve('scrypt$32768$8$1$' + salt.toString('base64url') + '$' + key.toString('base64url'))
    ));
}
function verifyPassword(password, encoded) {
    if (typeof encoded !== 'string') return Promise.resolve(false);
    const p = encoded.split('$');
    if (p.length !== 6 || p[0] !== 'scrypt' || p[1] !== '32768' || p[2] !== '8' || p[3] !== '1') return Promise.resolve(false);
    const salt = Buffer.from(p[4], 'base64url');
    const expected = Buffer.from(p[5], 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return Promise.resolve(false);
    return new Promise(resolve => crypto.scrypt(
        password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (err, actual) => resolve(!err && crypto.timingSafeEqual(actual, expected))
    ));
}
const LOGIN_RE = /^[A-Za-z0-9._-]{3,64}$/;
const PASSWORD_MIN = 12;
const AUDIT_FIELDS = ['status', 'active', 'stock', 'price', 'name', 'courier_id', 'route_id'];

function createAdminAuth({ pool, getKey, absoluteMs = 12 * 3600e3, idleMs = 2 * 3600e3, maxFails = 5, blockMs = 15 * 60e3, failDelayMs = 400 }) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
    const fails = new Map();
    const secureReq = req => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
    const cookieName = req => secureReq(req) ? '__Host-admin_session' : 'admin_session';
    const anyCookie = req => readCookie(req, '__Host-admin_session') || readCookie(req, 'admin_session');

    function setCookie(req, res, token, maxAgeMs) {
        const parts = [cookieName(req) + '=' + encodeURIComponent(token), 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=' + Math.floor(maxAgeMs / 1000)];
        if (secureReq(req)) parts.push('Secure');
        res.append('Set-Cookie', parts.join('; '));
    }
    function clearCookies(req, res) {
        res.append('Set-Cookie', '__Host-admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
        res.append('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + (secureReq(req) ? '; Secure' : ''));
    }
    function sameOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return false;
        return origin === ((secureReq(req) ? 'https' : 'http') + '://' + req.get('host'));
    }
    async function audit(req, action, status, detail, sessionId) {
        try {
            await pool.query(
                'INSERT INTO admin_audit (session, ip, action, method, path, status, detail, actor_user_id, actor_role) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                [
                    sessionId || (req.admin && req.admin.session) || null,
                    String(req.ip || '').slice(0, 64), action, req.method,
                    String(req.path || '').slice(0, 200), status || null,
                    detail ? String(detail).slice(0, 300) : null,
                    req.admin && req.admin.userId || null,
                    req.admin && req.admin.role || null
                ]
            );
        } catch (e) {
            console.error('[AUDIT] не записано:', String(e.code || e.name || 'unknown').slice(0, 40));
        }
    }
    const blockedFor = ip => {
        const f = fails.get(ip);
        return f && f.until > Date.now() ? f.until - Date.now() : 0;
    };
    function noteFail(ip) {
        const now = Date.now();
        let f = fails.get(ip);
        if (!f && fails.size >= 10000) fails.delete(fails.keys().next().value);
        if (!f || now - f.first > blockMs) f = { n: 0, first: now, until: 0 };
        f.n++;
        if (f.n >= maxFails) f.until = now + blockMs;
        fails.set(ip, f);
    }
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [ip, f] of fails) if (now - f.first > blockMs && (!f.until || f.until < now)) fails.delete(ip);
    }, 60000);
    if (timer.unref) timer.unref();

    async function verifyAdmin(req, res, next) {
        try {
            const token = anyCookie(req);
            if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
                return res.status(401).json({ error: 'Требуется вход', code: 'AUTH_REQUIRED' });
            }
            const found = await pool.query(
                'SELECT s.role AS legacy_role, s.staff_user_id, s.expires_at, s.last_seen, ' +
                'u.id AS user_id, u.login, u.display_name, u.role AS user_role, u.is_active, ' +
                '(s.expires_at <= NOW() OR s.last_seen <= NOW() - ($2::text || \' milliseconds\')::interval) AS expired ' +
                'FROM admin_sessions s LEFT JOIN admin_users u ON u.id = s.staff_user_id ' +
                'WHERE s.token_hash = $1 LIMIT 1',
                [hashToken(token), String(idleMs)]
            );
            if (!found.rowCount) return res.status(401).json({ error: 'Требуется вход', code: 'AUTH_REQUIRED' });
            const row = found.rows[0];
            if (row.staff_user_id && (!row.user_id || row.is_active !== true)) {
                await pool.query('DELETE FROM admin_sessions WHERE staff_user_id = $1', [row.staff_user_id]);
                return res.status(401).json({ error: 'Учётная запись отключена', code: 'AUTH_REQUIRED' });
            }
            if (!row.staff_user_id && typeof getKey === 'function' && !getKey()) {
                return res.status(503).json({ error: 'Старый вход отключён: ADMIN_API_KEY не задан' });
            }
            if (row.expired) return res.status(401).json({ error: 'Сессия истекла', code: 'AUTH_REQUIRED' });
            await pool.query('UPDATE admin_sessions SET last_seen = NOW() WHERE token_hash = $1', [hashToken(token)]);
            req.admin = {
                session: hashToken(token).slice(0, 8),
                userId: row.user_id || null,
                login: row.login || null,
                displayName: row.display_name || 'Администратор',
                role: row.user_role || row.legacy_role || 'admin',
                legacy: !row.staff_user_id
            };
            const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
            if (unsafe && !sameOrigin(req)) {
                await audit(req, 'csrf_blocked', 403, null);
                return res.status(403).json({ error: 'Запрос отклонён: чужой источник' });
            }
            if (!isKnownRole(req.admin.role)) return res.status(403).json({ error: 'Недопустимая роль', code: 'FORBIDDEN' });
            if (unsafe) res.on('finish', () => {
                const detail = req.body && typeof req.body === 'object'
                    ? AUDIT_FIELDS.filter(k => req.body[k] !== undefined).map(k => k + '=' + String(req.body[k]).slice(0, 40)).join(' ')
                    : '';
                audit(req, req.method + ' ' + ((req.route && req.route.path) || req.path), res.statusCode, detail);
            });
            return next();
        } catch (e) {
            console.error('[ADMIN AUTH]', String(e.code || e.name || 'unknown').slice(0, 40));
            return res.status(500).json({ error: 'Internal error' });
        }
    }

    async function createSession(req, res, user) {
        const token = crypto.randomBytes(32).toString('base64url');
        await pool.query(
            'INSERT INTO admin_sessions (token_hash, role, staff_user_id, expires_at, ip, user_agent) ' +
            'VALUES ($1,$2,$3,NOW() + ($4::text || \' milliseconds\')::interval,$5,$6)',
            [hashToken(token), user.role, user.userId || null, String(absoluteMs),
             String(req.ip || '').slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 200)]
        );
        setCookie(req, res, token, absoluteMs);
        req.admin = {
            userId: user.userId || null, role: user.role, login: user.login || null,
            displayName: user.displayName || 'Администратор', legacy: !user.userId,
            session: hashToken(token).slice(0, 8)
        };
        await audit(req, 'login_ok', 200, null);
        return res.json({ ok: true });
    }

    function registerRoutes(app) {
        app.post('/api/admin/login', async (req, res) => {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const ip = String(req.ip || 'unknown');
            if (req.headers.origin && !sameOrigin(req)) return res.status(403).json({ error: 'Войти можно только на странице админки сервера' });
            const wait = blockedFor(ip);
            if (wait) {
                res.set('Retry-After', String(Math.ceil(wait / 1000)));
                return res.status(429).json({ error: 'Слишком много попыток. Повторите позже.' });
            }
            try {
                if (typeof body.login === 'string' || typeof body.password === 'string') {
                    const login = typeof body.login === 'string' ? body.login.trim() : '';
                    const password = typeof body.password === 'string' ? body.password : '';
                    const found = LOGIN_RE.test(login)
                        ? await pool.query('SELECT id, login, display_name, password_hash, role, is_active FROM admin_users WHERE LOWER(login) = LOWER($1) LIMIT 1', [login])
                        : { rowCount: 0, rows: [] };
                    const valid = password.length >= PASSWORD_MIN && password.length <= 128 && found.rowCount && found.rows[0].is_active === true
                        ? await verifyPassword(password, found.rows[0].password_hash) : false;
                    if (!valid) {
                        noteFail(ip);
                        await audit(req, 'login_fail', 401, 'staff_login');
                        await new Promise(resolve => setTimeout(resolve, failDelayMs));
                        return res.status(401).json({ error: 'Неверный логин или пароль' });
                    }
                    fails.delete(ip);
                    const user = found.rows[0];
                    return await createSession(req, res, {
                        role: user.role, userId: user.id, login: user.login, displayName: user.display_name
                    });
                }
                const key = typeof getKey === 'function' ? getKey() : '';
                if (!key) return res.status(503).json({ error: 'Вход по ключу отключён. Используйте логин и пароль.' });
                const given = typeof body.key === 'string' ? body.key : '';
                if (!given || !safeEqual(given, key)) {
                    noteFail(ip);
                    await audit(req, 'login_fail', 401, 'legacy_key');
                    await new Promise(resolve => setTimeout(resolve, failDelayMs));
                    return res.status(401).json({ error: 'Неверный ключ' });
                }
                fails.delete(ip);
                return await createSession(req, res, { role: 'admin' });
            } catch (e) {
                console.error('[ADMIN LOGIN]', String(e.code || e.name || 'unknown').slice(0, 40));
                return res.status(500).json({ error: 'Не удалось выполнить вход' });
            }
        });

        app.post('/api/admin/logout', async (req, res) => {
            if (req.headers.origin && !sameOrigin(req)) return res.status(403).json({ error: 'Запрос отклонён: чужой источник' });
            const token = anyCookie(req);
            if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
                const h = hashToken(token);
                const actor = await pool.query(
                    'SELECT s.staff_user_id, s.role AS legacy_role, u.login, u.display_name, u.role AS user_role ' +
                    'FROM admin_sessions s LEFT JOIN admin_users u ON u.id = s.staff_user_id WHERE s.token_hash = $1 LIMIT 1',
                    [h]
                );
                if (actor.rowCount) {
                    const a = actor.rows[0];
                    req.admin = {
                        session: h.slice(0, 8), userId: a.staff_user_id || null,
                        login: a.login || null, displayName: a.display_name || 'Администратор',
                        role: a.user_role || a.legacy_role || 'admin', legacy: !a.staff_user_id
                    };
                }
                const r = await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [h]);
                if (r.rowCount) await audit(req, 'logout', 200, null, h.slice(0, 8));
            }
            clearCookies(req, res);
            res.json({ ok: true });
        });

        app.get('/api/admin/me', verifyAdmin, (req, res) => {
            res.set('Cache-Control', 'no-store');
            res.json({
                ok: true, role: req.admin.role, roleLabel: ROLE_LABELS[req.admin.role],
                displayName: req.admin.displayName, login: req.admin.login,
                legacy: req.admin.legacy, permissions: ROLE_PERMISSIONS[req.admin.role] || []
            });
        });

        app.get('/api/admin/audit', verifyAdmin, requirePermission('staff.manage'), async (req, res) => {
            try {
                const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
                const r = await pool.query(
                    'SELECT id, at, session, ip, action, method, path, status, detail, actor_user_id, actor_role ' +
                    'FROM admin_audit ORDER BY id DESC LIMIT $1', [limit]
                );
                res.set('Cache-Control', 'no-store');
                return res.json(r.rows);
            } catch (e) {
                console.error('[ADMIN AUDIT]', String(e.code || e.name || 'unknown').slice(0, 40));
                return res.status(500).json({ error: 'Не удалось загрузить журнал.' });
            }
        });

        app.get('/api/admin/staff', verifyAdmin, requirePermission('staff.manage'), async (_req, res) => {
            try {
                const r = await pool.query(
                    'SELECT u.id, u.login, u.display_name AS "displayName", u.role, u.is_active AS "isActive", ' +
                    'u.created_at AS "createdAt", u.updated_at AS "updatedAt", MAX(s.last_seen) AS "lastSeen" ' +
                    'FROM admin_users u LEFT JOIN admin_sessions s ON s.staff_user_id = u.id ' +
                    'GROUP BY u.id ORDER BY u.created_at DESC, u.id DESC'
                );
                res.set('Cache-Control', 'no-store');
                return res.json(r.rows);
            } catch (e) {
                console.error('[ADMIN STAFF LIST]', String(e.code || e.name || 'unknown').slice(0, 40));
                return res.status(500).json({ error: 'Не удалось загрузить сотрудников.' });
            }
        });

        app.post('/api/admin/staff', verifyAdmin, requirePermission('staff.manage'), async (req, res) => {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const login = typeof body.login === 'string' ? body.login.trim() : '';
            const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
            const password = typeof body.password === 'string' ? body.password : '';
            const role = body.role;
            if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'Логин: 3–64 символа, латиница, цифры, точка, дефис или подчёркивание.' });
            if (!displayName || displayName.length > 100) return res.status(400).json({ error: 'Укажите имя сотрудника (до 100 символов).' });
            if (!isKnownRole(role)) return res.status(400).json({ error: 'Неизвестная роль.' });
            if (password.length < PASSWORD_MIN || password.length > 128) return res.status(400).json({ error: 'Пароль должен содержать от 12 до 128 символов.' });
            try {
                const passwordHash = await hashPassword(password);
                const r = await pool.query(
                    'INSERT INTO admin_users (login, display_name, password_hash, role) VALUES ($1,$2,$3,$4) ' +
                    'RETURNING id, login, display_name AS "displayName", role, is_active AS "isActive", created_at AS "createdAt"',
                    [login, displayName, passwordHash, role]
                );
                await audit(req, 'staff_created', 201, 'staff_id=' + r.rows[0].id);
                return res.status(201).json(r.rows[0]);
            } catch (e) {
                if (e.code === '23505') return res.status(409).json({ error: 'Такой логин уже существует.' });
                console.error('[ADMIN STAFF CREATE]', String(e.code || e.name || 'unknown').slice(0, 40));
                return res.status(500).json({ error: 'Не удалось создать сотрудника.' });
            }
        });

        app.patch('/api/admin/staff/:id', verifyAdmin, requirePermission('staff.manage'), async (req, res) => {
            const id = Number(req.params.id);
            if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Некорректный ID.' });
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const keys = Object.keys(body);
            if (!keys.length || keys.some(k => !['login', 'displayName', 'role', 'isActive'].includes(k))) {
                return res.status(400).json({ error: 'Допустимые поля: login, displayName, role, isActive.' });
            }
            if (body.login !== undefined && (typeof body.login !== 'string' || !LOGIN_RE.test(body.login.trim()))) return res.status(400).json({ error: 'Некорректный логин.' });
            if (body.displayName !== undefined && (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.trim().length > 100)) return res.status(400).json({ error: 'Некорректное имя.' });
            if (body.role !== undefined && !isKnownRole(body.role)) return res.status(400).json({ error: 'Неизвестная роль.' });
            if (body.isActive !== undefined && typeof body.isActive !== 'boolean') return res.status(400).json({ error: 'isActive должен быть boolean.' });
            if (req.admin.userId && Number(req.admin.userId) === id && ((body.role && body.role !== 'admin') || body.isActive === false)) {
                return res.status(409).json({ error: 'Нельзя отключить или понизить собственную учётную запись.' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('LOCK TABLE admin_users IN EXCLUSIVE MODE');
                const current = await client.query('SELECT id, role, is_active FROM admin_users WHERE id = $1 FOR UPDATE', [id]);
                if (!current.rowCount) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ error: 'Сотрудник не найден.' });
                }
                const nextRole = body.role === undefined ? current.rows[0].role : body.role;
                const nextActive = body.isActive === undefined ? current.rows[0].is_active : body.isActive;
                if (current.rows[0].role === 'admin' && current.rows[0].is_active && (nextRole !== 'admin' || !nextActive)) {
                    const admins = await client.query("SELECT COUNT(*)::int AS n FROM admin_users WHERE role = 'admin' AND is_active = TRUE");
                    if (admins.rows[0].n <= 1) {
                        await client.query('ROLLBACK');
                        return res.status(409).json({ error: 'Нельзя отключить последнего активного администратора.' });
                    }
                }
                const updated = await client.query(
                    'UPDATE admin_users SET login=COALESCE($2,login), display_name=COALESCE($3,display_name), ' +
                    'role=COALESCE($4,role), is_active=COALESCE($5,is_active), updated_at=NOW() WHERE id=$1 ' +
                    'RETURNING id, login, display_name AS "displayName", role, is_active AS "isActive", updated_at AS "updatedAt"',
                    [id, body.login === undefined ? null : body.login.trim(),
                     body.displayName === undefined ? null : body.displayName.trim(),
                     body.role === undefined ? null : body.role,
                     body.isActive === undefined ? null : body.isActive]
                );
                await client.query('DELETE FROM admin_sessions WHERE staff_user_id = $1', [id]);
                await client.query('COMMIT');
                await audit(req, 'staff_updated', 200, 'staff_id=' + id);
                return res.json(updated.rows[0]);
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                if (e.code === '23505') return res.status(409).json({ error: 'Такой логин уже существует.' });
                console.error('[ADMIN STAFF UPDATE]', String(e.code || e.name || 'unknown').slice(0, 40));
                return res.status(500).json({ error: 'Не удалось изменить сотрудника.' });
            } finally { client.release(); }
        });

        app.post('/api/admin/staff/:id/password', verifyAdmin, requirePermission('staff.manage'), async (req, res) => {
            const id = Number(req.params.id);
            const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
            if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Некорректный ID.' });
            if (password.length < PASSWORD_MIN || password.length > 128) return res.status(400).json({ error: 'Пароль должен содержать от 12 до 128 символов.' });
            try {
                const passwordHash = await hashPassword(password);
                const r = await pool.query(
                    'UPDATE admin_users SET password_hash=$2, password_changed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING id',
                    [id, passwordHash]
                );
                if (!r.rowCount) return res.status(404).json({ error: 'Сотрудник не найден.' });
                await pool.query('DELETE FROM admin_sessions WHERE staff_user_id = $1', [id]);
                await audit(req, 'staff_password_reset', 200, 'staff_id=' + id);
                return res.json({ ok: true, sessionsRevoked: true });
            } catch (e) {
                console.error('[ADMIN STAFF PASSWORD]', String(e.code || e.name || 'unknown').slice(0, 40));
                return res.status(500).json({ error: 'Не удалось изменить пароль.' });
            }
        });

        app.post('/api/admin/staff/:id/revoke-sessions', verifyAdmin, requirePermission('staff.manage'), async (req, res) => {
            const id = Number(req.params.id);
            if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Некорректный ID.' });
            const r = await pool.query('DELETE FROM admin_sessions WHERE staff_user_id = $1', [id]);
            await audit(req, 'staff_sessions_revoked', 200, 'staff_id=' + id);
            res.json({ ok: true, revoked: r.rowCount });
        });

        const page = path.join(__dirname, '..', 'admin.html');
        app.get(['/admin', '/admin/'], (req, res) => {
            if (!fs.existsSync(page)) return res.status(404).send('admin.html не найден на сервере');
            res.set({
                'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
                'X-Frame-Options': 'DENY',
                'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
            });
            res.type('html').sendFile(page);
        });
    }

    async function cleanup() {
        try {
            await pool.query("DELETE FROM admin_sessions WHERE expires_at < NOW() OR last_seen < NOW() - INTERVAL '1 day'");
            await pool.query("DELETE FROM admin_audit WHERE at < NOW() - INTERVAL '365 days'");
            await pool.query("DELETE FROM api_request_log WHERE created_at < NOW() - INTERVAL '30 days'").catch(() => {});
        } catch (e) {
            console.error('[ADMIN AUTH] очистка:', String(e.code || e.name || 'unknown').slice(0, 40));
        }
    }
    return { verifyAdmin, registerRoutes, cleanup, audit, safeEqual };
}

let _inst = null;
function instance() {
    if (!_inst) _inst = createAdminAuth({ pool: require('./db').pool, getKey: () => process.env.ADMIN_API_KEY });
    return _inst;
}
module.exports = { createAdminAuth, instance, safeEqual, hashToken, hashPassword, verifyPassword };
