// bot.js — v4 (патчи применены)
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const db = require('./db-adapter');

// ═══════════════════════════════════════════
// КОНФИГ
// ═══════════════════════════════════════════

const app = express();
app.set('trust proxy', 1);

let server = null;   // заполняется в db.init().then(...)

const token           = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID   = process.env.ADMIN_CHAT_ID;
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const PORT            = process.env.PORT || 3000;
const WEB_APP_URL     = process.env.WEB_APP_URL;
const WEBHOOK_BASE    = process.env.WEBHOOK_URL;
const WEBHOOK_PATH    = '/webhook/main';
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const ADMIN_API_KEY   = process.env.ADMIN_API_KEY;
const STATIC_DIR      = process.env.STATIC_DIR || path.join(__dirname, '..', 'public');
const REQUIRE_INIT_DATA = process.env.REQUIRE_INIT_DATA !== 'false';
const TRUST_CLIENT_PRICES = process.env.TRUST_CLIENT_PRICES === 'true';
const INIT_DATA_TTL_SEC  = Number(process.env.INIT_DATA_TTL_SEC || 3600);
const TZ = 'Europe/Moscow';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || [
    'https://berluskone-bos.github.io',
    'https://gulf-western-shop.github.io',
    'https://avtopromoyl.vercel.app',
    'https://web.telegram.org',
    'https://gulf-bot-production.up.railway.app',
    'http://localhost:3000',
    'http://localhost:5173'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

// ═══════════════════════════════════════════
// ПРОВЕРКА КОНФИГА
// ═══════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════');
console.log('  АВТОПРОМОЙЛ — ЗАПУСК БОТА (v4)');
console.log('═══════════════════════════════════════════');
console.log('');

function requireEnv(name, value) {
    if (!value) {
        console.error(`[ОШИБКА] ${name} не задан!`);
        process.exit(1);
    }
    console.log(`[OK] ${name}: задан`);
}

requireEnv('BOT_TOKEN', token);
requireEnv('WEB_APP_URL', WEB_APP_URL);
requireEnv('WEBHOOK_URL', WEBHOOK_BASE);
requireEnv('WEBHOOK_SECRET', WEBHOOK_SECRET);

if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
    console.error('[ОШИБКА] WEBHOOK_SECRET: допустимы только A-Z a-z 0-9 _ - (1–256 символов)');
    process.exit(1);
}

if (!ADMIN_CHAT_ID) console.warn('[ВНИМАНИЕ] ADMIN_CHAT_ID не задан — уведомления о заказах не будут отправляться');
else                console.log('[OK] ADMIN_CHAT_ID: задан');

if (!ADMIN_BOT_TOKEN) console.warn('[ВНИМАНИЕ] ADMIN_BOT_TOKEN не задан — уведомления пойдут через основной бот');
else                  console.log('[OK] ADMIN_BOT_TOKEN: задан');

if (!ADMIN_API_KEY) console.warn('[ВНИМАНИЕ] ADMIN_API_KEY не задан — /api/webhook-info недоступен');

// ─── Проверка контракта db-adapter ───
const hasGetProduct   = typeof db.getProductById === 'function';
const hasGetDiscount  = typeof db.getDiscountByCode === 'function';
const hasCancelByNum  = typeof db.cancelOrderByNumber === 'function';
const hasUpdateStatus = typeof db.updateOrderStatus === 'function';

if (!TRUST_CLIENT_PRICES && !hasGetProduct) {
    console.error('[ОШИБКА] db-adapter.getProductById отсутствует — нельзя безопасно валидировать цены.');
    console.error('        Либо реализуйте метод, либо запустите с TRUST_CLIENT_PRICES=true (НЕБЕЗОПАСНО).');
    process.exit(1);
}
if (!hasCancelByNum && !hasUpdateStatus) {
    console.error('[ОШИБКА] db-adapter должен иметь cancelOrderByNumber или updateOrderStatus.');
    process.exit(1);
}
if (!TRUST_CLIENT_PRICES) {
    console.log('[OK] Цены валидируются по БД (getProductById)');
} else {
    console.warn('[!!!] TRUST_CLIENT_PRICES=true — цены берутся от клиента. Только для отладки!');
}
if (!hasGetDiscount) {
    console.warn('[ВНИМАНИЕ] db.getDiscountByCode отсутствует — промокоды работать не будут');
}
if (hasCancelByNum) {
    console.log('[OK] Отмена заказа: cancelOrderByNumber(order_number)');
} else {
    console.warn('[ВНИМАНИЕ] Отмена через updateOrderStatus("AP-...", "CANCELLED") —');
    console.warn('           убедитесь, что адаптер принимает order_number, а не числовой PK');
}
console.log('');

// ═══════════════════════════════════════════
// ХЕЛПЕРЫ
// ═══════════════════════════════════════════

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeLog(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[\u0000-\u001F\u007F]/g, '?').slice(0, 500);
}

function safeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function formatDateTime(d = new Date()) {
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(d);
}

// ID заказа: YYMMDD + 8 случайных цифр ≈ 10^8/день.
// Коллизии при N заказах: N(N-1)/2 · 10⁻⁸.
//   500/сутки  → ~1.25·10⁻³ (0.13%)
//   5000/сутки → ~1.25·10⁻¹ (12.5%) — тогда нужен UNIQUE + перегенерация.
function generateOrderId() {
    const d = new Date();
    const datePart = String(d.getFullYear()).slice(-2)
        + String(d.getMonth() + 1).padStart(2, '0')
        + String(d.getDate()).padStart(2, '0');
    const randPart = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    return datePart + randPart; // 12 цифр
}
const ORDER_ID_RE = /^[0-9]{12}$/;

// ─── Telegram initData ───
function verifyInitData(initData, botToken) {
    if (!initData || typeof initData !== 'string') return null;
    let params;
    try { params = new URLSearchParams(initData); } catch { return null; }

    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;

    // Telegram требует исключить оба поля из data-check-string
    params.delete('hash');
    params.delete('signature');

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
    const now = Math.floor(Date.now() / 1000);
    if (!authDate) return null;
    if (authDate > now + 60) return null;
    if (now - authDate > INIT_DATA_TTL_SEC) return null;

    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch {}
    return { user, authDate };
}

// ─── Rate limit ───
const rateBuckets = new Map();
function rateLimit(max, windowMs) {
    return (req, res, next) => {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        const now = Date.now();
        let bucket = rateBuckets.get(ip);
        if (!bucket || now > bucket.resetAt) {
            bucket = { count: 0, resetAt: now + windowMs };
            rateBuckets.set(ip, bucket);
        }
        bucket.count++;
        if (bucket.count > max) {
            return res.status(429).json({ success: false, error: 'Too many requests' });
        }
        next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
}, 60_000).unref();

// ─── Дедупликация update_id ───
const processedUpdates = new Map();
const UPDATE_TTL = 10 * 60 * 1000;
function markUpdateProcessed(updateId) {
    if (processedUpdates.has(updateId)) return false;
    processedUpdates.set(updateId, Date.now());
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of processedUpdates) {
        if (now - ts > UPDATE_TTL) processedUpdates.delete(id);
    }
}, 60_000).unref();

// ═══════════════════════════════════════════
// ВАЛИДАЦИЯ ЗАКАЗА
// ═══════════════════════════════════════════

const PHONE_RE = /^(\+7|8|7)?[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-()]*\d{2}[\s\-()]*\d{2}$/;

async function validateOrder(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid body' };

    const items = Array.isArray(raw.items) ? raw.items : null;
    if (!items || items.length === 0 || items.length > 50) {
        return { ok: false, error: 'invalid items count' };
    }

    const cleanItems = [];
    let subtotal = 0;

    for (const it of items) {
        const productId = Number(it && (it.productId ?? it.id));
        const qty       = Number(it && it.qty);
        if (!Number.isInteger(productId) || productId <= 0) return { ok: false, error: 'bad productId' };
        if (!Number.isInteger(qty) || qty < 1 || qty > 100) return { ok: false, error: 'bad qty' };

        let name, volume, price;

        if (TRUST_CLIENT_PRICES) {
            // отладочная ветка — не для прода
            price = Number(it.price);
            if (!Number.isFinite(price) || price <= 0 || price > 10_000_000) {
                return { ok: false, error: 'bad price' };
            }
            name   = String(it.name   || '').trim().slice(0, 200);
            volume = String(it.volume || '').trim().slice(0, 50);
        } else {
            // цена — ТОЛЬКО из БД
            const prod = await db.getProductById(productId);
            if (!prod) return { ok: false, error: `unknown product ${productId}` };
            price = Number(prod.price);
            if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'bad product price in DB' };
            name   = String(prod.name   || prod.title || '').slice(0, 200);
            volume = String(prod.volume || '').slice(0, 50);
        }

        if (!name) return { ok: false, error: 'empty product name' };

        subtotal += price * qty;
        cleanItems.push({ productId, name, volume, price, qty });
    }

    // Скидка — только через промокод с серверной проверкой
    let discount = 0;
    let discountCode = null;
    const rawCode = String(raw.discountCode || raw.promoCode || '').trim().slice(0, 50);
    if (rawCode && hasGetDiscount) {
        const promo = await db.getDiscountByCode(rawCode);
        if (promo && typeof promo.percent === 'number'
            && promo.percent >= 0 && promo.percent <= 100) {
            discount = promo.percent;
            discountCode = rawCode;
        }
    }

    const total = Math.round(subtotal * (1 - discount / 100) * 100) / 100;

    // Телефон — сначала полная проверка, потом усечение
    const phoneRaw = String(raw.phone || '').trim();
    if (!PHONE_RE.test(phoneRaw)) return { ok: false, error: 'bad phone' };
    const phone = phoneRaw.slice(0, 30);

    const address = String(raw.address || '').trim().slice(0, 500);
    if (address.length < 5) return { ok: false, error: 'bad address' };

    const zone         = raw.zone === 'lo' ? 'lo' : 'spb';
    const deliveryType = raw.deliveryType === 'pickup' ? 'pickup' : 'delivery';
    const payment      = ['cash', 'card', 'online'].includes(raw.payment) ? raw.payment : 'cash';

    return {
        ok: true,
        data: {
            userName:     String(raw.userName || '').slice(0, 100),
            phone,
            address,
            zone,
            city:         String(raw.city      || '').slice(0, 100),
            street:       String(raw.street    || '').slice(0, 200),
            house:        String(raw.house     || '').slice(0, 20),
            entrance:     String(raw.entrance  || '').slice(0, 20),
            apartment:    String(raw.apartment || '').slice(0, 20),
            items:        cleanItems,
            total,
            subtotal,
            discount,
            discountCode,
            deliveryType,
            payment,
            comment:      String(raw.comment   || '').slice(0, 500),
            userId:       null   // заполняется из доверенного источника
        }
    };
}

// ═══════════════════════════════════════════
// БОТ
// ═══════════════════════════════════════════

const bot = new TelegramBot(token, { polling: false });
console.log('Бот запущен (webhook mode)...');

async function setupBotOnStart() {
    try {
        await bot.setMyCommands([
            { command: 'start',  description: 'Открыть магазин' },
            { command: 'shop',   description: 'Открыть магазин' },
            { command: 'orders', description: 'Мои заказы' },
            { command: 'help',   description: 'Помощь' }
        ]);
        await bot.setChatMenuButton({
            menu_button: { type: 'web_app', text: 'Открыть магазин', web_app: { url: WEB_APP_URL } }
        });
        await bot.setMyDescription(
            'Магазин автотоваров АВТОПРОМОЙЛ\n\n' +
            'Откройте магазин через кнопку меню или команду /shop\n\n' +
            '- Моторные масла\n- Трансмиссионные масла\n- Фильтры\n' +
            '- Присадки\n- Антифризы\n- Тормозные жидкости\n\n' +
            'Доставка по СПб и ЛО'
        );
        console.log('[OK] Настройки бота применены');
    } catch (err) {
        console.error('[ОШИБКА] Настройка бота:', sanitizeLog(err.message));
    }
}

// ═══════════════════════════════════════════
// КОМАНДЫ
// ═══════════════════════════════════════════

bot.onText(/^\/start(?:@[\w_]+)?(?:\s|$)/, (msg) => {
    const chatId = msg.chat.id;
    const userName = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Покупатель';
    bot.sendMessage(chatId,
        `<b>Добро пожаловать в АВТОПРОМОЙЛ, ${escapeHtml(userName)}!</b>\n\n` +
        `Мы предлагаем качественные автомасла и расходники с доставкой по Санкт-Петербургу и Ленинградской области.\n\n` +
        `<b>Наш ассортимент:</b>\n` +
        `- Моторные масла\n- Трансмиссионные масла\n- Фильтры\n` +
        `- Присадки и жидкости\n- Антифризы\n- Тормозные жидкости\n\n` +
        `Нажмите кнопку ниже, чтобы открыть магазин.`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: 'Открыть магазин', web_app: { url: WEB_APP_URL } }]] }
        }
    ).catch(e => console.error('[/start]', sanitizeLog(e.message)));
});

bot.onText(/^\/shop(?:@[\w_]+)?(?:\s|$)/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Нажмите кнопку, чтобы открыть магазин:', {
        reply_markup: { inline_keyboard: [[{ text: 'Открыть магазин АВТОПРОМОЙЛ', web_app: { url: WEB_APP_URL } }]] }
    }).catch(e => console.error('[/shop]', sanitizeLog(e.message)));
});

bot.onText(/^\/help(?:@[\w_]+)?(?:\s|$)/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `<b>Помощь</b>\n\n` +
        `<b>Команды:</b>\n/start — Приветствие и открытие магазина\n/shop — Открыть магазин\n/orders — Мои заказы\n/help — Эта справка\n\n` +
        `<b>Как сделать заказ:</b>\n1. Откройте магазин\n2. Выберите товары\n3. Добавьте в корзину\n4. Укажите адрес и телефон\n5. Подтвердите заказ\n\n` +
        `<b>Доставка:</b>\n- СПб (в пределах КАД) — бесплатно от 5000 руб.\n- ЛО — по тарифам ТК\n\n` +
        `<b>Оплата:</b>\n- Наличные при получении\n- Перевод на карту\n\n` +
        `<b>Документы:</b>\n<a href="https://berluskone-bos.github.io/my-telegram-app/privacy.html">Политика конфиденциальности</a>\n\n` +
        `<b>Контакты:</b>\n8-800-555-35-35\n@avtopromol_support`,
        { parse_mode: 'HTML' }
    ).catch(e => console.error('[/help]', sanitizeLog(e.message)));
});

bot.onText(/^\/orders(?:@[\w_]+)?(?:\s|$)/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `<b>Ваши заказы</b>\n\nОткройте магазин → "Профиль" → "История заказов".`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: 'Открыть историю заказов', web_app: { url: WEB_APP_URL } }]] }
        }
    ).catch(e => console.error('[/orders]', sanitizeLog(e.message)));
});

// ═══════════════════════════════════════════
// CALLBACK_QUERY
// ═══════════════════════════════════════════

bot.on('callback_query', async (query) => {
    try {
        const data = query.data;
        if (!data || typeof data !== 'string') return;

        // ─── rate_<courierId>_<rating> ───
        if (data.startsWith('rate_')) {
            const parts = data.split('_');
            const courierId = parseInt(parts[1], 10);
            const rating    = parseInt(parts[parts.length - 1], 10);
            if (!Number.isInteger(courierId) || courierId <= 0 ||
                !Number.isInteger(rating) || rating < 1 || rating > 5) {
                await bot.answerCallbackQuery(query.id, { text: 'Некорректная оценка' }).catch(() => {});
                return;
            }
            try {
                const saved = await db.updateCourierRating(courierId, rating);
                // === false — явный отказ; undefined считаем успехом
                if (saved === false) {
                    await bot.answerCallbackQuery(query.id, { text: 'Оценка не сохранена' }).catch(() => {});
                    return;
                }
            } catch (e) {
                console.error('[rate_] db:', sanitizeLog(e.message));
                await bot.answerCallbackQuery(query.id, { text: 'Ошибка сохранения' }).catch(() => {});
                return;
            }
            await bot.answerCallbackQuery(query.id, { text: `Спасибо за оценку ${rating}!` }).catch(() => {});
            if (query.message && query.message.chat) {
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                    chat_id: query.message.chat.id, message_id: query.message.message_id
                }).catch(() => {});
                await bot.sendMessage(query.message.chat.id, `Спасибо за оценку ${rating}/5!`).catch(() => {});
            }
            return;
        }

        // ─── cancel_<orderId12> — только админ ───
        if (data.startsWith('cancel_')) {
            if (!ADMIN_CHAT_ID || String(query.from.id) !== String(ADMIN_CHAT_ID)) {
                await bot.answerCallbackQuery(query.id, { text: 'Нет доступа' }).catch(() => {});
                return;
            }
            const id = data.slice('cancel_'.length);
            if (!ORDER_ID_RE.test(id)) {
                await bot.answerCallbackQuery(query.id, { text: 'Некорректный номер' }).catch(() => {});
                return;
            }
            const orderNumber = 'AP-' + id;

            let ok = false;
            try {
                if (hasCancelByNum) {
                    ok = await db.cancelOrderByNumber(orderNumber);
                } else {
                    ok = await db.updateOrderStatus(orderNumber, 'CANCELLED');
                }
                if (!ok) throw new Error('заказ не найден или уже отменён');
            } catch (e) {
                console.error('[cancel_] db:', sanitizeLog(e.message));
                await bot.answerCallbackQuery(query.id, { text: 'Ошибка отмены' }).catch(() => {});
                return;
            }

            await bot.answerCallbackQuery(query.id, { text: 'Заказ отменён' }).catch(() => {});
            if (query.message && query.message.chat) {
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                    chat_id: query.message.chat.id, message_id: query.message.message_id
                }).catch(() => {});
                // без parse_mode — экранирование не нужно
                await bot.sendMessage(query.message.chat.id, `Заказ #${orderNumber} отменён.`).catch(() => {});
            }
            return;
        }
    } catch (e) {
        console.error('[callback_query]', sanitizeLog(e.message));
    }
});

// ═══════════════════════════════════════════
// web_app_data
// ═══════════════════════════════════════════

bot.on('message', async (msg) => {
    if (!msg.web_app_data) return;
    const chatId = msg.chat.id;

    let payload;
    try {
        payload = JSON.parse(msg.web_app_data.data);
    } catch (e) {
        console.error('[web_app_data] parse:', sanitizeLog(e.message));
        await bot.sendMessage(chatId, 'Произошла ошибка при обработке заказа. Попробуйте ещё раз.').catch(() => {});
        return;
    }

    if (!payload || payload.type !== 'order') return;

    let v;
    try {
        v = await validateOrder(payload);
    } catch (e) {
        console.error('[web_app_data] validate:', sanitizeLog(e.message));
        await bot.sendMessage(chatId, 'Ошибка обработки заказа.').catch(() => {});
        return;
    }
    if (!v.ok) {
        console.warn('[web_app_data] отклонён:', v.error);
        await bot.sendMessage(chatId, 'Некорректные данные заказа. Оформите заново.').catch(() => {});
        return;
    }

    // №1 — userId из доверенного источника
    if (msg.from) {
        v.data.userId = msg.from.id;
        if (!v.data.userName) {
            v.data.userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
        }
    }

    await handleNewOrder(chatId, v.data).catch(e =>
        console.error('[handleNewOrder]', sanitizeLog(e.message)));
});

// ═══════════════════════════════════════════
// СОХРАНЕНИЕ И УВЕДОМЛЕНИЯ
// ═══════════════════════════════════════════

async function saveOrderToDb(orderId, order) {
    try {
        const result = await db.createOrder({
            order_number: 'AP-' + orderId,
            user_id:      order.userId || null,
            user_name:    order.userName || '',
            phone:        order.phone || '',
            address:      order.address || '',
            zone:         order.zone || 'spb',
            city:         order.city || '',
            street:       order.street || '',
            house:        order.house || '',
            entrance:     order.entrance || '',
            apartment:    order.apartment || '',
            items:        order.items || [],
            total:        order.total || 0,
            subtotal:     order.subtotal || 0,
            discount:     order.discount || 0,
            discount_code: order.discountCode || null,   // №2
            delivery_type: order.deliveryType || 'delivery',
            payment:      order.payment || 'cash',
            comment:      order.comment || '',
            status:         'NEW',
            payment_status: 'PENDING'
        });
        return result ? result.id : null;
    } catch (e) {
        console.error('[saveOrderToDb]', sanitizeLog(e.message));
        return null;
    }
}

function buildItemsList(items) {
    return items
        .map(i => `- ${escapeHtml(i.name)} (${escapeHtml(i.volume)}) x ${i.qty} = ` +
                  `${(i.price * i.qty).toLocaleString('ru-RU')} руб.`)
        .join('\n');
}

function paymentLabel(p) {
    return ({ cash: 'Наличные при получении', card: 'Перевод на карту', online: 'Онлайн' })[p] || 'Не указано';
}

function deliveryLabel(t) {
    return t === 'pickup' ? 'Самовывоз' : 'Доставка';
}

async function sendAdminNotification(orderId, order) {
    if (!ADMIN_CHAT_ID) {
        console.log('[ВНИМАНИЕ] ADMIN_CHAT_ID не задан — уведомление пропущено');
        return false;
    }
    const useAdminBot = !!ADMIN_BOT_TOKEN;
    const sendToken = useAdminBot ? ADMIN_BOT_TOKEN : token;

    const zoneName = order.zone === 'spb' ? 'Санкт-Петербург (КАД)' : 'Ленинградская область';

    const addressLines = [order.address];
    if (order.city || order.street || order.house) {
        addressLines.push([
            order.city && `г. ${order.city}`,
            order.street && `ул. ${order.street}`,
            order.house && `д. ${order.house}`,
            order.entrance && `подъезд ${order.entrance}`,
            order.apartment && `кв. ${order.apartment}`
        ].filter(Boolean).join(', '));
    }

    // №9 — единый формат номера с префиксом AP-
    let msg =
        `<b>НОВЫЙ ЗАКАЗ #${escapeHtml('AP-' + orderId)}</b>\n\n` +
        `<b>Клиент:</b> ${escapeHtml(order.userName || 'Не указано')}\n` +
        `<b>Телефон:</b> ${escapeHtml(order.phone)}\n` +
        `<b>Адрес:</b> ${addressLines.map(escapeHtml).join('\n')}\n` +
        `<b>Зона:</b> ${escapeHtml(zoneName)}\n` +
        `<b>Способ:</b> ${escapeHtml(deliveryLabel(order.deliveryType))}\n\n` +
        `<b>Товары:</b>\n${buildItemsList(order.items)}\n\n` +
        `<b>Подытог:</b> ${order.subtotal.toLocaleString('ru-RU')} руб.\n`;
    if (order.discount > 0) {
        msg += `<b>Скидка:</b> ${order.discount}%` +
               (order.discountCode ? ` (промокод ${escapeHtml(order.discountCode)})` : '') + `\n`;
    }
    msg += `<b>Итого:</b> ${order.total.toLocaleString('ru-RU')} руб.\n\n` +
           `<b>Оплата:</b> ${escapeHtml(paymentLabel(order.payment))}\n` +
           `<b>Дата:</b> ${escapeHtml(formatDateTime())}`;
    if (order.comment) {
        msg += `\n\n<b>Комментарий:</b> ${escapeHtml(order.comment)}`;
    }

    const payload = JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[{
                text: 'Отменить заказ',
                callback_data: `cancel_${orderId}`
            }]]
        }
    });

    const body = await new Promise((resolve, reject) => {
        const url = new URL(`https://api.telegram.org/bot${sendToken}/sendMessage`);
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 10_000
        }, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });

    let parsed;
    try { parsed = JSON.parse(body.body); } catch { parsed = null; }

    if (body.status !== 200 || !parsed || parsed.ok !== true) {
        const desc = parsed && parsed.description ? parsed.description : body.body.slice(0, 200);
        throw new Error(`Telegram API ${body.status}: ${sanitizeLog(desc)}`);
    }
    console.log('[OK] Уведомление отправлено админу');
    return true;
}

async function handleNewOrder(chatId, order) {
    const orderId = generateOrderId();
    const dbOrderId = await saveOrderToDb(orderId, order);

    if (dbOrderId === null) {
        console.error('[handleNewOrder] Не сохранён в БД — клиенту честный отказ');
        await bot.sendMessage(chatId,
            'Не удалось сохранить заказ. Попробуйте ещё раз или свяжитесь с нами.'
        ).catch(() => {});
        return;
    }

    const zoneName = order.zone === 'spb' ? 'Санкт-Петербург (КАД)' : 'Ленинградская область';

    console.log(`[ЗАКАЗ] #AP-${orderId} сохранён (dbId=${dbOrderId}), итого=${order.total}`);

    try {
        await bot.sendMessage(chatId,
            `<b>Заказ оформлен!</b>\n\n` +
            `<b>Номер заказа:</b> #${escapeHtml('AP-' + orderId)}\n` +
            `<b>Дата:</b> ${escapeHtml(formatDateTime())}\n\n` +
            `<b>Товары:</b>\n${buildItemsList(order.items)}\n\n` +
            `<b>Итого:</b> ${order.total.toLocaleString('ru-RU')} руб.` +
            (order.discount > 0 ? ` (скидка ${order.discount}%)` : '') + `\n` +
            `<b>Доставка:</b> ${escapeHtml(zoneName)}\n` +
            `<b>Адрес:</b> ${escapeHtml(order.address)}\n\n` +
            `Мы свяжемся с вами в ближайшее время для подтверждения заказа.`,
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error('[handleNewOrder] sendMessage:', sanitizeLog(err.message));
    }

    try {
        await sendAdminNotification(orderId, order);
    } catch (e) {
        console.error('[handleNewOrder] admin notify failed:', sanitizeLog(e.message));
        // клиенту не сообщаем, заказ в БД есть — админ увидит в списке
    }
}

// ═══════════════════════════════════════════
// EXPRESS MIDDLEWARE
// ═══════════════════════════════════════════

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // №3 — Telegram Web/Desktop грузят Mini App во фрейме.
    // DENY + frame-ancestors 'none' её заблокировали бы.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "img-src 'self' data: https:; " +
        // 'unsafe-inline' — пока не вынесены инлайн-скрипты STATIC_DIR
        "style-src 'self' 'unsafe-inline'; " +
        "script-src 'self' 'unsafe-inline' https://telegram.org; " +
        // connect-src сужен; если фронт ходит на сторонний хост — добавьте его явно
        "connect-src 'self' https://api.telegram.org https://*.telegram.org; " +
        "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
    );
    next();
});

// Статика
if (fs.existsSync(STATIC_DIR)) {
    app.use(express.static(STATIC_DIR, { dotfiles: 'deny', index: false }));
    console.log('[OK] Статика из:', STATIC_DIR);
} else {
    console.warn('[ВНИМАНИЕ] STATIC_DIR не найден:', STATIC_DIR);
}

// №5 — CORS ДО express.json, чтобы 400/413 дошли до браузера с заголовками
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, X-Admin-Key');
        res.header('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json({ limit: '256kb' }));
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ success: false, error: 'Invalid JSON' });
    }
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ success: false, error: 'Payload too large' });
    }
    next(err);
});

// ═══════════════════════════════════════════
// КУРЬЕР-БОТ
// ═══════════════════════════════════════════

try {
    const { registerCourierRoutes } = require('./courier-bot');
    registerCourierRoutes(app);
    console.log('[OK] Курьер-бот API подключён');
} catch (e) {
    console.warn('[ВНИМАНИЕ] Курьер-бот не загружен:', sanitizeLog(e.message));
}

// ═══════════════════════════════════════════
// API /api/order
// ═══════════════════════════════════════════

app.post('/api/order', rateLimit(20, 60_000), async (req, res) => {
    try {
        const initData = req.header('X-Telegram-Init-Data');
        const auth = verifyInitData(initData, token);

        if (REQUIRE_INIT_DATA && !auth) {
            console.warn('[API /order] 401: невалидный initData');
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        let v;
        try {
            v = await validateOrder(req.body);
        } catch (e) {
            // №14 — validateOrder бросает только при сбое БД, не при плохих данных
            console.error('[API /order] validate (инфраструктура):', sanitizeLog(e.message));
            return res.status(503).json({ success: false, error: 'Service temporarily unavailable' });
        }
        if (!v.ok) {
            return res.status(400).json({ success: false, error: 'Invalid order: ' + v.error });
        }

        if (auth && auth.user) {
            v.data.userId = auth.user.id;
            if (!v.data.userName) {
                v.data.userName = [auth.user.first_name, auth.user.last_name].filter(Boolean).join(' ');
            }
        }

        const orderId = generateOrderId();
        const dbOrderId = await saveOrderToDb(orderId, v.data);
        if (dbOrderId === null) {
            return res.status(500).json({ success: false, error: 'Failed to save order' });
        }

        sendAdminNotification(orderId, v.data).catch(e =>
            console.error('[API /order] admin notify:', sanitizeLog(e.message)));

        return res.json({ success: true, orderId: 'AP-' + orderId });
    } catch (e) {
        console.error('[API /order] fatal:', sanitizeLog(e.message));
        return res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// ═══════════════════════════════════════════
// WEBHOOK
// ═══════════════════════════════════════════

app.post(WEBHOOK_PATH, (req, res) => {
    const secret = req.header('X-Telegram-Bot-Api-Secret-Token');
    if (!secret || !safeEq(secret, WEBHOOK_SECRET)) {
        console.warn('[WEBHOOK] 403: неверный secret');
        return res.sendStatus(403);
    }

    const updateId = req.body && req.body.update_id;
    if (typeof updateId === 'number' && !markUpdateProcessed(updateId)) {
        console.log('[WEBHOOK] дубль update_id', updateId, '— пропущен');
        return res.sendStatus(200);
    }

    try {
        bot.processUpdate(req.body);
    } catch (e) {
        console.error('[WEBHOOK] processUpdate:', sanitizeLog(e.message));
    }
    res.sendStatus(200);
});

// ═══════════════════════════════════════════
// СЛУЖЕБНЫЕ
// ═══════════════════════════════════════════

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/webhook-info', rateLimit(5, 60_000), async (req, res) => {
    if (!ADMIN_API_KEY) return res.status(503).json({ error: 'Admin API disabled' });
    const key = req.header('X-Admin-Key');
    if (!key || !safeEq(key, ADMIN_API_KEY)) return res.sendStatus(403);
    try {
        const info = await bot.getWebHookInfo();
        res.json(info);
    } catch (e) {
        res.status(500).json({ error: sanitizeLog(e.message) });
    }
});

// Финальный обработчик ошибок Express
app.use((err, req, res, _next) => {
    console.error('[EXPRESS]', sanitizeLog(err.message));
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: 'Internal error' });
});

// ═══════════════════════════════════════════
// СТАРТ
// ═══════════════════════════════════════════

db.init().then(async () => {
    if (typeof db.seedProductsFromCatalog === 'function') {
        await db.seedProductsFromCatalog();
    }

    server = app.listen(PORT, async () => {
        console.log(`Веб-сервер: http://localhost:${PORT}`);

        const webhookUrl = WEBHOOK_BASE.replace(/\/+$/, '') + WEBHOOK_PATH;
        try {
            await bot.setWebHook(webhookUrl, { secret_token: WEBHOOK_SECRET });
            console.log(`[OK] Webhook установлен: ${webhookUrl}`);
        } catch (e) {
            console.error('[FATAL] setWebHook:', sanitizeLog(e.message));
            // без webhook бот слеп — пусть оркестратор перезапустит
            process.exit(1);
        }

        await setupBotOnStart();

        console.log('');
        console.log('═══════════════════════════════════════════');
        console.log('  БОТ ГОТОВ');
        console.log('═══════════════════════════════════════════');
        console.log('  initData: ' + (REQUIRE_INIT_DATA ? `обязателен (TTL ${INIT_DATA_TTL_SEC}s)` : 'не проверяется'));
        console.log('  Цены: ' + (TRUST_CLIENT_PRICES ? 'от клиента (!)' : 'из БД'));
        console.log('  Rate-limit /api/order: 20/min');
        console.log('  Дедуп update_id: 10 мин');
        console.log('');
    });
}).catch(e => {
    console.error('[FATAL] db.init:', sanitizeLog(e.message));
    process.exit(1);
});

// ═══════════════════════════════════════════
// КРИТИЧЕСКИЕ ОШИБКИ
// ═══════════════════════════════════════════

const fatalTimes = [];
function registerFatal() {
    const now = Date.now();
    fatalTimes.push(now);
    while (fatalTimes.length && now - fatalTimes[0] > 60_000) fatalTimes.shift();
    return fatalTimes.length;
}

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', sanitizeLog(String((reason && reason.message) || reason)));
    if (registerFatal() >= 5) {
        console.error('[FATAL] 5 unhandled rejection за минуту — выход');
        setTimeout(() => process.exit(1), 500).unref();
    }
});

process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', sanitizeLog(err.message), sanitizeLog(err.stack));
    console.error('[FATAL] Состояние процесса неопределено — выход');
    setTimeout(() => process.exit(1), 500).unref();
});

let shuttingDown = false;
function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (server) {
        server.close(() => process.exit(code));
        setTimeout(() => process.exit(code), 9000).unref();  // Railway drain ~10 с
    } else {
        process.exit(code);
    }
}

process.on('SIGINT',  () => { console.log('\nSIGINT — остановка');  shutdown(0); });
process.on('SIGTERM', () => { console.log('\nSIGTERM — остановка'); shutdown(0); });