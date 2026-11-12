'use strict';
// Вход в админку: серверные сессии в БД + HttpOnly-cookie, журнал действий.
// Ключ администратора (ADMIN_API_KEY) вводится один раз при входе и в браузере НЕ хранится:
// сервер выдаёт случайный токен сессии, в БД лежит только его хэш SHA-256.
//   cookie: HttpOnly; Secure (на https); SameSite=Strict; Path=/; префикс __Host- на https
//   срок: не более 12 часов с входа и не более 2 часов без действий
//   защита от подбора: 5 неверных ключей с одного IP за 15 минут -> блок на 15 минут
//   изменяющие запросы по cookie принимаются только с Origin того же сайта (защита от CSRF)
//   все изменяющие запросы и входы/выходы пишутся в admin_audit (без паролей и персональных данных)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
// Сравнение без утечки по времени: сравниваем хэши одинаковой длины.
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function readCookie(req, name) {
    const h = req.headers.cookie;
    if (!h) return null;
    for (const part of h.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
        }
    }
    return null;
}

const AUDIT_FIELDS = ['status', 'active', 'stock', 'price', 'name', 'courier_id', 'route_id'];

function createAdminAuth({ pool, getKey, absoluteMs = 12 * 3600e3, idleMs = 2 * 3600e3, maxFails = 5, blockMs = 15 * 60e3, failDelayMs = 400 }) {
    const fails = new Map(); // ip -> { n, first, until }

    const secureReq = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
    const cookieName = (req) => (secureReq(req) ? '__Host-admin_session' : 'admin_session');
    const anyCookie = (req) => readCookie(req, '__Host-admin_session') || readCookie(req, 'admin_session');

    function setCookie(req, res, token, maxAgeMs) {
        const parts = [`${cookieName(req)}=${encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
        if (secureReq(req)) parts.push('Secure');
        res.append('Set-Cookie', parts.join('; '));
    }
    const clearCookies = (req, res) => {
        res.append('Set-Cookie', `__Host-admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure`);
        res.append('Set-Cookie', `admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureReq(req) ? '; Secure' : ''}`);
    };

    async function audit(req, action, status, detail, sessionId) {
        try {
            await pool.query(
                'INSERT INTO admin_audit (session, ip, action, method, path, status, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                [sessionId || (req.admin && req.admin.session) || null, String(req.ip || '').slice(0, 64), action,
                 req.method, String(req.path || '').slice(0, 200), status || null, detail ? String(detail).slice(0, 300) : null]);
        } catch (e) { console.error('[AUDIT] не записано:', String(e.message).slice(0, 120)); }
    }

    const blockedFor = (ip) => { const f = fails.get(ip); return f && f.until && f.until > Date.now() ? f.until - Date.now() : 0; };
    function noteFail(ip) {
        const now = Date.now();
        let f = fails.get(ip);
        if (!f || now - f.first > blockMs) f = { n: 0, first: now, until: 0 };
        f.n++;
        if (f.n >= maxFails) f.until = now + blockMs;
        fails.set(ip, f);
    }
    const timer = setInterval(() => { const n = Date.now(); for (const [k, v] of fails) if (n - v.first > blockMs && (!v.until || v.until < n)) fails.delete(k); }, 60_000);
    if (timer.unref) timer.unref();

    // Тот же сайт? Origin должен совпадать с адресом, по которому открыта админка.
    function sameOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return false;
        const proto = secureReq(req) ? 'https' : 'http';
        return origin === `${proto}://${req.get('host')}`;
    }

    async function verifyAdmin(req, res, next) {
        try {
            if (!getKey()) return res.status(503).json({ error: 'Админка отключена: не задан ADMIN_API_KEY' });
            const token = anyCookie(req);
            if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
                const r = await pool.query(
                    `UPDATE admin_sessions SET last_seen = NOW()
                      WHERE token_hash = $1 AND expires_at > NOW() AND last_seen > NOW() - ($2::text || ' milliseconds')::interval
                  RETURNING role, expires_at`, [hashToken(token), String(idleMs)]);
                if (r.rowCount) {
                    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
                    if (unsafe && !sameOrigin(req)) {
                        await audit(req, 'csrf_blocked', 403, null, hashToken(token).slice(0, 8));
                        return res.status(403).json({ error: 'Запрос отклонён: чужой источник' });
                    }
                    req.admin = { session: hashToken(token).slice(0, 8), role: r.rows[0].role };
                    if (unsafe) res.on('finish', () => {
                        const d = req.body && typeof req.body === 'object'
                            ? AUDIT_FIELDS.filter(k => req.body[k] !== undefined).map(k => `${k}=${String(req.body[k]).slice(0, 40)}`).join(' ') : '';
                        audit(req, `${req.method} ${(req.route && req.route.path) || req.path}`, res.statusCode, d);
                    });
                    return next();
                }
            }
            return res.status(401).json({ error: 'Требуется вход', code: 'AUTH_REQUIRED' });
        } catch (e) {
            console.error('[ADMIN AUTH]', String(e.message).slice(0, 150));
            return res.status(500).json({ error: 'Internal error' });
        }
    }

    async function cleanup() {
        try {
            await pool.query('DELETE FROM admin_sessions WHERE expires_at < NOW() OR last_seen < NOW() - INTERVAL \'1 day\'');
            await pool.query('DELETE FROM admin_audit WHERE at < NOW() - INTERVAL \'365 days\'');
            await pool.query('DELETE FROM api_request_log WHERE created_at < NOW() - INTERVAL \'30 days\'').catch(() => {});
        } catch (e) { console.error('[ADMIN AUTH] очистка:', String(e.message).slice(0, 120)); }
    }

    function registerRoutes(app) {
        app.post('/api/admin/login', async (req, res) => {
            const key = getKey();
            if (!key) return res.status(503).json({ error: 'Админка отключена: не задан ADMIN_API_KEY' });
            if (req.headers.origin && !sameOrigin(req)) return res.status(403).json({ error: 'Войти можно только на странице админки сервера' });
            const wait = blockedFor(req.ip);
            if (wait) {
                res.set('Retry-After', String(Math.ceil(wait / 1000)));
                return res.status(429).json({ error: `Слишком много попыток. Повторите через ${Math.ceil(wait / 60000)} мин.` });
            }
            const given = req.body && typeof req.body.key === 'string' ? req.body.key : '';
            if (!given || !safeEqual(given, key)) {
                noteFail(req.ip);
                await audit(req, 'login_fail', 401, null, '-');
                await new Promise(r => setTimeout(r, failDelayMs));
                return res.status(401).json({ error: 'Неверный ключ' });
            }
            fails.delete(req.ip);
            const token = crypto.randomBytes(32).toString('base64url');
            await pool.query(
                'INSERT INTO admin_sessions (token_hash, expires_at, ip, user_agent) VALUES ($1, NOW() + ($2::text || \' milliseconds\')::interval, $3, $4)',
                [hashToken(token), String(absoluteMs), String(req.ip || '').slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 200)]);
            setCookie(req, res, token, absoluteMs);
            await audit(req, 'login_ok', 200, null, hashToken(token).slice(0, 8));
            cleanup();
            res.json({ ok: true });
        });

        app.post('/api/admin/logout', async (req, res) => {
            if (req.headers.origin && !sameOrigin(req)) return res.status(403).json({ error: 'Запрос отклонён: чужой источник' });
            const token = anyCookie(req);
            if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
                const h = hashToken(token);
                const r = await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [h]);
                if (r.rowCount) await audit(req, 'logout', 200, null, h.slice(0, 8));
            }
            clearCookies(req, res);
            res.json({ ok: true });
        });

        app.get('/api/admin/me', verifyAdmin, (req, res) => res.json({ ok: true, role: req.admin.role }));

        app.get('/api/admin/audit', verifyAdmin, async (req, res) => {
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
            const r = await pool.query('SELECT id, at, session, ip, action, status, detail FROM admin_audit ORDER BY id DESC LIMIT $1', [limit]);
            res.json(r.rows);
        });

        // Страница админки отдаётся самим сервером: тот же сайт, поэтому cookie SameSite=Strict работает во всех браузерах.
        const page = path.join(__dirname, '..', 'admin.html');
        app.get(['/admin', '/admin/'], (req, res) => {
            if (!fs.existsSync(page)) return res.status(404).send('admin.html не найден на сервере');
            res.set({
                'Cache-Control': 'no-store',
                'X-Robots-Tag': 'noindex, nofollow',
                'X-Frame-Options': 'DENY',
                'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                    "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
            });
            res.type('html').sendFile(page);
        });
    }

    return { verifyAdmin, registerRoutes, cleanup, audit, safeEqual };
}

// Один общий экземпляр на процесс (общий счётчик неудачных входов для всех маршрутов).
let _inst = null;
function instance() {
    if (!_inst) _inst = createAdminAuth({ pool: require('./db').pool, getKey: () => process.env.ADMIN_API_KEY });
    return _inst;
}

module.exports = { createAdminAuth, instance, safeEqual, hashToken };
