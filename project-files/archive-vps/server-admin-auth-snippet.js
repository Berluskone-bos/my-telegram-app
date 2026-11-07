// ==============================================================
// АДМИН-АВТОРИЗАЦИЯ ПО SMS-КОДУ
// Добавить в server.js. Требует: npm install jsonwebtoken bcrypt
// А также переменные в .env: JWT_SECRET, SMS_API_KEY
// ==============================================================

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// Хранилище кодов в памяти (для простоты; при перезапуске сервера коды сбрасываются —
// это нормально, т.к. они живут всего 5 минут)
const otpStore = {}; // { phone: { codeHash, expiresAt, lastSentAt } }

// Отправка SMS через провайдера (пример для SMSC.ru — замените на своего провайдера)
async function sendSms(phone, text) {
  const params = new URLSearchParams({
    login: process.env.SMS_LOGIN,
    psw: process.env.SMS_PASSWORD,
    phones: phone,
    mes: text,
  });
  const res = await fetch(`https://smsc.ru/sys/send.php?${params}`);
  const data = await res.text();
  return data;
}

// Шаг 1: запрос кода
app.post('/api/admin/request-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Не указан номер телефона' });

  // Проверяем, что номер есть в списке администраторов
  const adminResult = await pool.query(
    'SELECT id FROM admin_users WHERE phone = $1 AND is_active = true',
    [phone]
  );
  if (adminResult.rows.length === 0) {
    return res.status(403).json({ error: 'Этот номер не имеет доступа к админ-панели' });
  }

  // Защита от спама: не чаще 1 раза в 60 секунд
  const existing = otpStore[phone];
  if (existing && Date.now() - existing.lastSentAt < 60000) {
    return res.status(429).json({ error: 'Код уже отправлен. Подождите минуту перед повторной отправкой.' });
  }

  // Генерируем 6-значный код
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);

  otpStore[phone] = {
    codeHash,
    expiresAt: Date.now() + 5 * 60 * 1000, // код живёт 5 минут
    lastSentAt: Date.now(),
    attempts: 0,
  };

  try {
    await sendSms(phone, `Автопромойл: код входа в админ-панель — ${code}`);
    res.json({ success: true, message: 'Код отправлен' });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось отправить SMS: ' + err.message });
  }
});

// Шаг 2: проверка кода
app.post('/api/admin/verify-code', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Не хватает данных' });

  const record = otpStore[phone];
  if (!record) {
    return res.status(400).json({ error: 'Сначала запросите код' });
  }
  if (Date.now() > record.expiresAt) {
    delete otpStore[phone];
    return res.status(400).json({ error: 'Код истёк, запросите новый' });
  }
  if (record.attempts >= 5) {
    delete otpStore[phone];
    return res.status(429).json({ error: 'Слишком много попыток, запросите новый код' });
  }

  const isValid = await bcrypt.compare(code, record.codeHash);
  if (!isValid) {
    record.attempts++;
    return res.status(400).json({ error: 'Неверный код' });
  }

  // Код верный — выдаём токен сессии на 8 часов
  delete otpStore[phone];
  const token = jwt.sign({ phone, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ success: true, token });
});

// Middleware для защиты остальных admin-маршрутов этим токеном
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  try {
    const token = authHeader.split(' ')[1];
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Сессия истекла, войдите заново' });
  }
}

// Пример использования: защищаем будущий маршрут списка заказов для админки
// app.get('/api/admin/orders', requireAdminAuth, async (req, res) => { ... });
