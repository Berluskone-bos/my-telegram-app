'use strict';
// Защита интеграционных тестов: они стирают заказы, сессии и журнал, поэтому работают
// ТОЛЬКО с заведомо тестовой базой. Рабочие базы (Neon, Railway) блокируются всегда.
function testDatabaseUrl(raw = process.env.TEST_DATABASE_URL) {
    if (!raw) return null;
    let u;
    try { u = new URL(raw); } catch { throw new Error('TEST_DATABASE_URL: некорректный адрес базы'); }
    const host = u.hostname.toLowerCase();
    const db = decodeURIComponent(u.pathname.replace(/^\//, '')).toLowerCase();
    if (/(neon\.tech|rlwy\.net|railway\.(app|internal)|supabase\.co|amazonaws\.com|azure\.com|digitalocean)/.test(host)) {
        throw new Error(`TEST_DATABASE_URL указывает на облачную базу (${host}). Тесты стирают данные — запуск запрещён.`);
    }
    if (!['localhost', '127.0.0.1', '::1', '[::1]', 'postgres'].includes(host)) {
        throw new Error(`TEST_DATABASE_URL: хост «${host}» не локальный. Разрешены localhost, 127.0.0.1 и контейнер postgres.`);
    }
    if (!/^(t|test|testdb|.*_test|test_.*)$/.test(db)) {
        throw new Error(`TEST_DATABASE_URL: база «${db}» не похожа на тестовую. Имя должно быть t, test или оканчиваться на _test.`);
    }
    return raw;
}
module.exports = { testDatabaseUrl };
