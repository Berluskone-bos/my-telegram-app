'use strict';

// Разбирает только новый формат; старые кнопки без ID остановки не принимаются.
function parseDeliveryRatingCallback(data) {
    if (typeof data !== 'string') return null;
    const match = /^rate_([0-9]+)_([0-9]+)_([1-5])$/.exec(data);
    if (!match) return null;
    const courierId = Number(match[1]);
    const stopId = Number(match[2]);
    const rating = Number(match[3]);
    if (!Number.isSafeInteger(courierId) || courierId <= 0 ||
        !Number.isSafeInteger(stopId) || stopId <= 0) return null;
    return { courierId, stopId, rating };
}

module.exports = { parseDeliveryRatingCallback };
