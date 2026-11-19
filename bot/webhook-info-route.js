'use strict';

const { requirePermission } = require('./admin-permissions');

function registerWebhookInfoRoute(app, { bot, rateLimit, verifyAdmin, sanitizeLog }) {
    if (!app || !bot || typeof bot.getWebHookInfo !== 'function' ||
        typeof rateLimit !== 'function' || typeof verifyAdmin !== 'function') {
        throw new TypeError('registerWebhookInfoRoute requires app, bot, rateLimit and verifyAdmin');
    }

    app.get(
        '/api/webhook-info',
        rateLimit(5, 60_000),
        verifyAdmin,
        requirePermission('settings.manage'),
        async (_req, res) => {
            try {
                const info = await bot.getWebHookInfo();
                return res.json(info);
            } catch (e) {
                const message = typeof sanitizeLog === 'function' ? sanitizeLog(e && e.message) : 'Internal error';
                return res.status(500).json({ error: message });
            }
        }
    );
}

module.exports = { registerWebhookInfoRoute };
