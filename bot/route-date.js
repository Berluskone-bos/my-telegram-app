'use strict';

// Дата маршрута — календарный день Москвы, независимо от часового пояса Node.js.
async function getMoscowRouteDate(db) {
    if (!db || typeof db.getMoscowToday !== 'function') {
        throw new TypeError('db.getMoscowToday is required to create a route');
    }
    return db.getMoscowToday();
}

module.exports = { getMoscowRouteDate };
