'use strict';
// Подключается через `node -r`: вместо node-telegram-bot-api — заглушка, ничего не отправляющая в сеть.
const Module = require('node:module');
class FakeBot {
    constructor() {
        return new Proxy(this, { get: (t, k) => (k in t ? t[k] : (k === 'then' ? undefined : () => Promise.resolve(true))) });
    }
    on() {} once() {} onText() {}
}
const orig = Module._load;
Module._load = function (req, ...rest) { return req === 'node-telegram-bot-api' ? FakeBot : orig.call(this, req, ...rest); };
