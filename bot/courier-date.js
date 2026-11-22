'use strict';

// Даты маршрутов хранятся как календарные даты Москвы.
// Источник текущего дня — PostgreSQL, а не часовой пояс процесса Node.js.
async function getTodayRoutes(db, courierId) {
    const today = await db.getMoscowToday();
    return db.getRoutesByDateAndCourier(today, courierId);
}

module.exports = { getTodayRoutes };
