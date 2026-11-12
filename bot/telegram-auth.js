'use strict';
// Проверка подписи Telegram Mini App (initData).
// Формула по документации Telegram — менять её нельзя, её закрепляет тест test/telegram-auth.test.js:
//   secret_key = HMAC_SHA256(ключ = "WebAppData", сообщение = токен бота)
//   hash       = HMAC_SHA256(ключ = secret_key,   сообщение = data-check-string)
// В data-check-string входят все поля, кроме hash (поле signature остаётся), по алфавиту, через \n.
const crypto = require('crypto');

function verifyInitData(initData, botToken, opts = {}) {
    const ttlSec = opts.ttlSec ?? 3600;
    const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
    if (!initData || typeof initData !== 'string' || !botToken) return null;
    let params;
    try { params = new URLSearchParams(initData); } catch { return null; }

    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed  = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate) return null;
    if (authDate > nowSec + 60) return null;
    if (nowSec - authDate > ttlSec) return null;

    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch {}
    return { user, authDate };
}

module.exports = { verifyInitData };
