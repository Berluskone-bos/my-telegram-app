'use strict';

// couriers.id is PostgreSQL SERIAL (signed 32-bit). Callback data is untrusted input.
function parseCourierActivationId(data) {
    if (typeof data !== 'string') return null;
    const match = /^activate_courier_(\\d{1,10})$/.exec(data);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

module.exports = { parseCourierActivationId };
