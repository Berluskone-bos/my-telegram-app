'use strict';
function parseCourierActivation(data) {
    if (typeof data !== 'string') return null;
    const match = /^activate_courier_(\d{1,10})_([a-f0-9]{32})$/.exec(data);
    if (!match) return null;
    const id = Number(match[1]);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return null;
    return { id, token: match[2] };
}
module.exports = { parseCourierActivation };
