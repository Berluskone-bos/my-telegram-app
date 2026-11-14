'use strict';
// Бонусы и реферальная программа. Всё считает сервер; приложение лишь показывает.
//   GET /api/bonuses        — баланс, личный код REF-<Telegram ID>, правила, последние операции
//   GET /api/referral/check — проверить код друга до оформления заказа (скидки код не даёт)
const { parseReferralCode, referralCodeFor } = require('./referral');

function registerReferralRoutes(app, { db, rateLimit, authenticatedTelegramUser, sanitizeLog = String }) {
    app.get('/api/bonuses', rateLimit(60, 60_000), async (req, res) => {
        try {
            const user = authenticatedTelegramUser(req);
            if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
            const [s, sum] = await Promise.all([db.getSettings(), db.getBonusSummary(user.id)]);
            res.set('Cache-Control', 'no-store');
            return res.json({
                success: true,
                balance: sum.balance,
                earned: sum.earned,
                invitedOrders: sum.invitedOrders,
                history: sum.history,
                referralCode: referralCodeFor(user.id),
                bonusPerOrder: s.referral_bonus,
                minOrder: s.referral_min_order,
                maxSharePct: s.bonus_max_share_pct
            });
        } catch (e) {
            console.error('[API /bonuses]:', sanitizeLog(e.message));
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    app.get('/api/referral/check', rateLimit(30, 60_000), async (req, res) => {
        try {
            const user = authenticatedTelegramUser(req);
            if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
            const refId = parseReferralCode(String(req.query.code || '').trim().slice(0, 50));
            if (!refId) return res.json({ success: true, valid: false, reason: 'bad_code' });
            const phone = String(req.query.phone || '').slice(0, 30);
            const r = await db.resolveReferrer(refId, user.id, phone);
            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, valid: !!r.ok, reason: r.ok ? null : r.reason });
        } catch (e) {
            console.error('[API /referral/check]:', sanitizeLog(e.message));
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });
}

module.exports = { registerReferralRoutes };
