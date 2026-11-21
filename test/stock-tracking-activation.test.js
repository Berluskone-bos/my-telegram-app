'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = require('./test-db').testDatabaseUrl();
const skip = DB ? false : 'нет TEST_DATABASE_URL';

test('production stock tracking activation requires the explicit startup flag', { skip }, async (t) => {
    Object.assign(process.env, {
        DATABASE_URL: DB,
        WEBHOOK_SECRET: 's'.repeat(32),
        BOT_TOKEN: '1:x',
        WEB_APP_URL: 'https://x.y',
        WEBHOOK_URL: 'https://x.y',
        ADMIN_CHAT_ID: '1',
        ADMIN_BOT_TOKEN: '1:y'
    });
    const previousActivation = process.env.ENABLE_STOCK_TRACKING_ON_STARTUP;
    process.env.ENABLE_STOCK_TRACKING_ON_STARTUP = 'false';

    const { pool, initDB } = require('../bot/db');
    await initDB();
    const before = (await pool.query(
        "SELECT EXISTS(SELECT 1 FROM app_flags WHERE flag = 'stock_tracking_enabled') AS enabled"
    )).rows[0].enabled;

    t.after(async () => {
        if (before) {
            await pool.query("INSERT INTO app_flags (flag) VALUES ('stock_tracking_enabled') ON CONFLICT (flag) DO NOTHING");
        } else {
            await pool.query("DELETE FROM app_flags WHERE flag = 'stock_tracking_enabled'");
        }
        if (previousActivation === undefined) delete process.env.ENABLE_STOCK_TRACKING_ON_STARTUP;
        else process.env.ENABLE_STOCK_TRACKING_ON_STARTUP = previousActivation;
        await pool.end();
    });

    await pool.query("DELETE FROM app_flags WHERE flag = 'stock_tracking_enabled'");
    await initDB();
    assert.equal((await pool.query(
        "SELECT EXISTS(SELECT 1 FROM app_flags WHERE flag = 'stock_tracking_enabled') AS enabled"
    )).rows[0].enabled, false, 'without explicit approval flag, tracking remains unchanged');

    process.env.ENABLE_STOCK_TRACKING_ON_STARTUP = 'true';
    await initDB();
    assert.equal((await pool.query(
        "SELECT EXISTS(SELECT 1 FROM app_flags WHERE flag = 'stock_tracking_enabled') AS enabled"
    )).rows[0].enabled, true, 'explicit one-time activation persists in app_flags');

    await initDB();
    assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM app_flags WHERE flag = 'stock_tracking_enabled'"
    )).rows[0].count, 1, 'repeated startup is idempotent');
});
