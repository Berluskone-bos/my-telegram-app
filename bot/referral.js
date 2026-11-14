'use strict';
// Реферальная программа и бонусы (решения владельца от 25.10 и 14.11.2026):
//   - у каждого клиента постоянный код REF-<Telegram ID>; друг вводит его в поле промокода при заказе;
//   - друг получает только свою обычную скидку по карте (код сам скидки не даёт);
//   - приглашающему начисляется 200 ₽ бонусами после доставки заказа друга, если товары в заказе стоят больше 6 000 ₽;
//     бонус начисляется за каждый заказ друга; на свои заказы код бонус не даёт;
//   - 1 бонус = 1 ₽; бонусами можно оплатить до 20 % стоимости товаров заказа;
//   - при отмене/возврате заказа списанные бонусы возвращаются, начисленный за него бонус аннулируется.
const DEFAULTS = { referral_bonus: 200, referral_min_order: 6000, bonus_max_share_pct: 20 };

const REF_RE = /^REF-(\d{5,15})$/i;

const referralCodeFor = (userId) => `REF-${userId}`;

// 'REF-123456789' -> '123456789', иначе null
function parseReferralCode(text) {
    const m = REF_RE.exec(String(text || '').trim());
    return m ? m[1] : null;
}

// Сколько бонусов можно списать в этом заказе (целые рубли).
function bonusToSpend({ goodsTotal, balance, maxSharePct = DEFAULTS.bonus_max_share_pct, wantUse }) {
    if (!wantUse) return 0;
    const cap = Math.floor(Math.max(Number(goodsTotal) || 0, 0) * maxSharePct / 100);
    return Math.max(0, Math.min(Math.floor(Number(balance) || 0), cap));
}

// Заказ друга даёт бонус, если товары (после скидки и бонусов, без доставки) строго дороже порога.
const qualifiesForReferralBonus = (paidGoods, minOrder = DEFAULTS.referral_min_order) => Number(paidGoods) > Number(minOrder);

// Последние 10 цифр телефона: +7 999… и 8 999… считаются одним номером
const phoneKey = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

module.exports = { DEFAULTS, parseReferralCode, referralCodeFor, bonusToSpend, qualifiesForReferralBonus, phoneKey };
