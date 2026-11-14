'use strict';
// Какая скидка действует на заказ. Источники не суммируются: берётся большая.
// Промокод тратится (попадает в заказ), только если он дал больше, чем скидка по обороту.
function resolveDiscount({ promoPct = 0, promoCode = null, loyaltyPct = 0 } = {}) {
    const p = Number.isFinite(promoPct) && promoPct > 0 ? promoPct : 0;
    const l = Number.isFinite(loyaltyPct) && loyaltyPct > 0 ? loyaltyPct : 0;
    const usePromo = p > l;
    const discount = usePromo ? p : l;
    return {
        discount,
        discountCode: usePromo ? promoCode : null,
        discountSource: discount > 0 ? (usePromo ? 'promo' : 'loyalty') : null
    };
}
module.exports = { resolveDiscount };
