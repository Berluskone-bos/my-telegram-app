'use strict';
// Надёжный long-polling админ-бота.
//  1) Замок в PostgreSQL (advisory lock): опрашивает Telegram только ОДИН экземпляр приложения на всю базу.
//     Второй экземпляр (перекрытие при деплое на Railway, случайный второй сервис) ждёт и начнёт опрос, когда первый остановится.
//     Если соединение с замком оборвалось — опрос останавливается, пока замок не получен заново (два опроса одновременно невозможны).
//  2) Наблюдатель: считает успешные и неудачные запросы getUpdates, пишет в лог ошибки не чаще раза в минуту (с числом повторов),
//     и сообщает о восстановлении.

function hashKey(name) {
    let h = 0;
    for (const ch of String(name)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    return 7_300_000_000 + (h >>> 0) % 1_000_000;   // стабильный bigint-ключ для имени бота
}

function createPollLock({ pool, name, onAcquire, onLose, retryMs = 5000, heartbeatMs = 15000, log = console }) {
    const key = hashKey(name);
    let client = null, holder = false, stopped = false, retryTimer = null, hbTimer = null, waitingLogged = false;

    const schedule = () => { if (!stopped && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; attempt(); }, retryMs); };

    function lose(err) {
        if (!holder) return;
        holder = false; clearInterval(hbTimer);
        const c = client; client = null;
        try { c.release(true); } catch { /* уже освобождён */ }
        log.warn(`[${name}] замок опроса потерян (${err && err.message ? err.message : 'соединение закрыто'}) — опрос остановлен до повторного получения`);
        try { onLose(err); } catch (e) { log.error(`[${name}] onLose:`, e.message); }
        schedule();
    }

    async function attempt() {
        if (stopped) return;
        let c;
        try {
            c = await pool.connect();
            c.on('error', (e) => { if (client === c) lose(e); });
            const r = await c.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [key]);
            if (!r.rows[0].ok) {
                c.release();
                if (!waitingLogged) { waitingLogged = true; log.warn(`[${name}] опрос Telegram уже ведёт другой экземпляр приложения — жду освобождения`); }
                return schedule();
            }
        } catch (e) {
            if (c) { try { c.release(true); } catch { /* ignore */ } }
            if (!stopped) log.warn(`[${name}] не удалось проверить замок опроса: ${e.message}`);
            return schedule();
        }
        if (stopped) { try { c.release(true); } catch { /* ignore */ } return; }
        client = c; holder = true; waitingLogged = false;
        hbTimer = setInterval(() => { c.query('SELECT 1').catch(lose); }, heartbeatMs);
        hbTimer.unref();
        try { onAcquire(); } catch (e) { log.error(`[${name}] onAcquire:`, e.message); }
    }

    return {
        start() { stopped = false; attempt(); },
        async stop() {
            stopped = true; clearTimeout(retryTimer); retryTimer = null; clearInterval(hbTimer);
            if (client) {
                const c = client; client = null; holder = false;
                try { await c.query('SELECT pg_advisory_unlock($1::bigint)', [key]); } catch { /* закрытие соединения тоже снимает замок */ }
                try { c.release(true); } catch { /* ignore */ }
            }
        },
        isHolder: () => holder
    };
}

// Наблюдение за getUpdates. Зависший запрос закрывает тайм-аут запроса (request.timeout в настройках бота).
function watchPolling(bot, { name, logEveryMs = 60_000, log = console }) {
    const st = { okAt: 0, errorsInRow: 0, errorsTotal: 0, okTotal: 0, lastError: '' };
    let lastLogAt = 0, suppressed = 0;
    const orig = bot.getUpdates.bind(bot);

    bot.getUpdates = async (...args) => {
        try {
            const r = await orig(...args);
            if (st.errorsInRow > 0) log.log(`[${name}] опрос Telegram восстановлен после ${st.errorsInRow} ошибок подряд`);
            st.okAt = Date.now(); st.okTotal++; st.errorsInRow = 0; suppressed = 0;
            return r;
        } catch (e) {
            st.errorsInRow++; st.errorsTotal++;
            st.lastError = describe(e);
            const now = Date.now();
            if (now - lastLogAt >= logEveryMs) {
                log.error(`[${name}] ошибка опроса: ${st.lastError}${suppressed ? ` (ещё ${suppressed} таких же с прошлой записи)` : ''}`);
                lastLogAt = now; suppressed = 0;
            } else suppressed++;
            throw e;
        }
    };
    return { st, stop() { bot.getUpdates = orig; } };
}

function describe(e) {
    const code = e && e.code ? e.code : 'ERR';
    let msg = (e && e.message) || String(e);
    if (e && e.response && e.response.statusCode === 409) msg = '409 Conflict — этого бота одновременно опрашивает другой экземпляр или у бота включён webhook';
    else if (e && e.cause && e.cause.code) msg += ` [${e.cause.code}]`;
    else if (e && e.errors && e.errors[0] && e.errors[0].code) msg += ` [${e.errors.map(x => x.code + (x.address ? ' ' + x.address : '')).join(', ')}]`;
    return `${code}: ${msg}`.slice(0, 300);
}

// Остановка опроса без отмены текущего запроса: отмена в этой версии библиотеки не останавливает цикл.
const stopQuietly = (bot, ms = 3000) => Promise.race([bot.stopPolling().catch(() => {}), new Promise(r => setTimeout(r, ms).unref())]);

// Запуск опроса под замком. Бот создаётся с polling:false.
function startGuardedPolling(bot, { name, pool, log = console, retryMs, heartbeatMs, logEveryMs }) {
    const watch = watchPolling(bot, { name, logEveryMs, log });
    const lock = createPollLock({
        pool, name, log, retryMs, heartbeatMs,
        onAcquire: () => { log.log(`[${name}] замок получен — начинаю опрос Telegram`); bot.startPolling({ restart: false }).catch(e => log.error(`[${name}] старт опроса:`, e.message)); },
        onLose: () => { stopQuietly(bot, 12_000); }
    });
    lock.start();
    return {
        status: () => ({ name, holder: lock.isHolder(), polling: bot.isPolling(), lastOkAt: watch.st.okAt ? new Date(watch.st.okAt).toISOString() : null,
            errorsInRow: watch.st.errorsInRow, errorsTotal: watch.st.errorsTotal, okTotal: watch.st.okTotal, lastError: watch.st.lastError }),
        async stop() { await lock.stop(); await stopQuietly(bot); watch.stop(); }
    };
}

module.exports = { createPollLock, watchPolling, startGuardedPolling, hashKey };
