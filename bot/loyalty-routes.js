'use strict';
// Скидка клиента по обороту. Считает только сервер; приложение лишь показывает.
function registerLoyaltyRoutes(app, { db, rateLimit, authenticatedTelegramUser, sanitizeLog = String }) {
    app.get('/api/loyalty', rateLimit(60, 60_000), async (req, res) => {
        try {
            const user = authenticatedTelegramUser(req);
            if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
            const l = await db.getLoyalty(user.id);
            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, loyalty: l });
        } catch (e) {
            console.error('[API /loyalty]:', sanitizeLog(e.message));
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });
}
module.exports = { registerLoyaltyRoutes };
