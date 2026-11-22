'use strict';

// Callback data is untrusted input. Accept only the exact button format and a safe positive DB ID.
function parseCourierActivationId(data) {
    if (typeof data !== 'string') return null;
    const match = /^activate_courier_(\\d{1,15})$/.exec(data);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = { parseCourierActivationId };
