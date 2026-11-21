'use strict';
// Карточка маршрута курьера: ОДНО сообщение со всеми заказами маршрута, пронумерованными так же, как на маршруте
// (номер точки не меняется, когда соседние заказы доставлены или не доставлены), и кнопками для выбранного заказа.
// Чистые функции без обращения к Telegram и базе: их проверяет test/courier-card.test.js.
const MapLinks = require('./services/map-links');
const { escapeHtml } = require('./services/notifier');

const FINAL = ['cancelled', 'delivered', 'failed'];
const REASONS = {
    nohome: 'Клиента нет дома',
    nophone: 'Не отвечает на звонки',
    badaddr: 'Неверный адрес',
    refused: 'Клиент отказался'
};

const isActive = (s) => !FINAL.includes(s.status);
const byNumber = (a, b) => Number(a.stop_number) - Number(b.stop_number);
const hasCoords = (s) => s && s.lat !== null && s.lat !== undefined && s.lon !== null && s.lon !== undefined &&
    s.lat !== '' && s.lon !== '' && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon));

// Состояние остановки словами (без значков: в проекте сообщения ботов пишутся текстом)
function stopState(s) {
    if (s.status === 'delivered') return 'доставлен';
    if (s.status === 'failed') return 'НЕ ДОСТАВЛЕН' + (s.fail_reason ? ` (${s.fail_reason})` : '');
    if (s.status === 'cancelled') return 'отменён';
    if (s.status === 'in_progress' && s.stage === 'arrived') return 'курьер у клиента';
    if (s.status === 'in_progress' && s.stage === 'enroute') return 'в пути к клиенту';
    if (s.status === 'in_progress' || s.status === 'accepted') return 'принят, ждёт выезда';
    return 'ждёт приёма';
}

// Какой заказ показывать «текущим»: выбранный курьером (если ещё в работе), иначе тот, где курьер уже у клиента,
// иначе тот, к которому он едет, иначе первый по порядку точек.
function pickFocus(route, wantedStopId) {
    const active = (route.stops || []).filter(isActive).sort(byNumber);
    if (!active.length) return null;
    const wanted = active.find(s => Number(s.id) === Number(wantedStopId));
    if (wanted) return wanted;
    return active.find(s => s.status === 'in_progress' && s.stage === 'arrived')
        || active.find(s => s.status === 'in_progress' && s.stage === 'enroute')
        || active[0];
}

function counts(stops) {
    const live = stops.filter(s => s.status !== 'cancelled');
    return {
        total: live.length,
        delivered: live.filter(s => s.status === 'delivered').length,
        failed: live.filter(s => s.status === 'failed').length,
        left: live.filter(isActive).length
    };
}

function navRow(stop) {
    if (!hasCoords(stop)) return null;
    return [
        { text: `Навигатор: №${stop.stop_number}`, url: MapLinks.yandex(stop.address, Number(stop.lat), Number(stop.lon)) },
        { text: '2GIS', url: MapLinks.gis2(Number(stop.lat), Number(stop.lon)) }
    ];
}

// route — маршрут вместе с остановками (db.getRouteById); wantedStopId — какой заказ курьер выбрал.
function buildRouteCard(route, wantedStopId = null) {
    const stops = [...(route.stops || [])].sort(byNumber);
    const c = counts(stops);
    const focus = pickFocus(route, wantedStopId);
    const started = route.status === 'in_progress';

    let text = `<b>Маршрут ${escapeHtml(route.route_number)}</b>\n` +
        `Заказов: ${c.total} · доставлено: ${c.delivered} · не доставлено: ${c.failed} · осталось: ${c.left}\n\n`;
    text += stops.map(s => {
        const mark = focus && Number(s.id) === Number(focus.id) ? '▶ ' : '';
        return `${mark}${s.stop_number}. <b>${escapeHtml(s.order_number || 'Заказ')}</b> — ${escapeHtml(s.address || 'адрес не указан')}\n` +
            `      ${escapeHtml(stopState(s))}`;
    }).join('\n');

    const keyboard = [];
    if (!focus) {
        text += c.total
            ? `\n\n<b>Маршрут завершён.</b> Доставлено: ${c.delivered}, не доставлено: ${c.failed}.` +
              (c.failed ? '\nНедоставленные заказы вернутся к оператору: он решит, отправить их повторно или отменить.' : '')
            : '\n\nВ маршруте нет активных заказов.';
        return { text, keyboard, focusId: null };
    }

    text += `\n\n<b>Сейчас: заказ ${focus.stop_number} из ${stops.length} — ${escapeHtml(focus.order_number || '')}</b>`;
    text += `\nАдрес: ${escapeHtml(focus.address || '')}`;
    if (focus.phone) text += `\nТелефон: ${escapeHtml(focus.phone)}`;
    if (Number(focus.amount_to_pay) > 0) {
        text += `\nСумма: ${escapeHtml(focus.amount_to_pay)} руб. [${focus.payment_status === 'paid' ? 'ОПЛАЧЕНО' : 'ОПЛАТА НА МЕСТЕ'}]`;
    }
    if (focus.comment) text += `\nКомментарий: ${escapeHtml(focus.comment)}`;

    const nav = navRow(focus);
    if (nav) keyboard.push(nav);
    const located = stops.filter(isActive).filter(hasCoords).map(s => ({ lat: Number(s.lat), lon: Number(s.lon) }));
    if (located.length > 1) {
        const all = MapLinks.allRoute(located);
        keyboard.push([{ text: 'Весь маршрут: Яндекс', url: all.yandex }, { text: '2GIS', url: all.gis2 }]);
    }

    if (started) {
        const n = focus.stop_number, rid = route.id, sid = focus.id;
        const step = focus.stage === 'arrived' ? { label: 'Доставлен', action: 'done' }
            : focus.stage === 'enroute' ? { label: 'У клиента', action: 'arrived' }
            : { label: 'В пути', action: 'enroute' };
        keyboard.push([{ text: `${step.label}: №${n}`, callback_data: `deliver_${rid}_${sid}_${step.action}` }]);
        keyboard.push([{ text: `Не доставлено: №${n}`, callback_data: `failed_${rid}_${sid}` }]);
        // Курьер может сам выбрать другой заказ: кнопки с номерами точек, порядок не ломается.
        const others = stops.filter(isActive).filter(s => Number(s.id) !== Number(sid));
        for (let i = 0; i < others.length; i += 3) {
            keyboard.push(others.slice(i, i + 3).map(s => ({ text: `Выбрать №${s.stop_number}`, callback_data: `pickstop_${rid}_${s.id}` })));
        }
    } else {
        text += '\n\nМаршрут ещё не начат: примите все заказы и нажмите «Начать маршрут».';
    }
    return { text, keyboard, focusId: focus.id };
}

// Выбор причины недоставки: то же сообщение превращается в список причин, «Назад» возвращает карточку.
function buildReasonPicker(route, stopId) {
    const stops = [...(route.stops || [])];
    const stop = stops.find(s => Number(s.id) === Number(stopId));
    const label = stop ? `№${stop.stop_number} ${escapeHtml(stop.order_number || '')}` : '';
    const rid = route.id;
    const keyboard = [
        ...Object.entries(REASONS).map(([key, title]) => [{ text: title, callback_data: `failreason_${rid}_${stopId}_${key}` }]),
        [{ text: 'Другое (написать причину)', callback_data: `failreason_${rid}_${stopId}_other` }],
        [{ text: 'Назад, заказ не отмечать', callback_data: `pickstop_${rid}_${stopId}` }]
    ];
    return {
        text: `<b>Заказ ${label}: почему не доставлен?</b>\nВыберите причину. Заказ вернётся к оператору, клиент получит уведомление.`,
        keyboard
    };
}

module.exports = { buildRouteCard, buildReasonPicker, pickFocus, stopState, REASONS, FINAL };
