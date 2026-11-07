-- ============================================================
-- Кэш данных PartsAPI и справочник автомобилей / масел
-- Выполняется один раз:
--   sudo -u postgres psql -d avtopromoyl_shop -f schema-cache.sql
-- По умолчанию права выдаются пользователю avtopromoyl_admin. Если у вас другой:
--   sudo -u postgres psql -d ИМЯ_БАЗЫ -v app_user=ИМЯ_ПОЛЬЗОВАТЕЛЯ -f schema-cache.sql
-- Скрипт можно запускать повторно: везде IF NOT EXISTS.
-- ============================================================

-- 1. УНИВЕРСАЛЬНЫЙ КЭШ ОТВЕТОВ API
-- Любой ответ PartsAPI хранится целиком. Ключ API здесь НЕ хранится.
-- Один и тот же запрос второй раз уходит не в PartsAPI, а сюда.
CREATE TABLE IF NOT EXISTS api_cache (
  cache_key   TEXT PRIMARY KEY,          -- например: toDopusk|typeId=9318
  method      VARCHAR(50) NOT NULL,
  response    JSONB NOT NULL,
  is_empty    BOOLEAN NOT NULL DEFAULT false,   -- ответ без данных (кэшируется на короткий срок)
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_cache_method ON api_cache (method);
CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache (expires_at);

-- 2. ЖУРНАЛ РЕАЛЬНЫХ ОБРАЩЕНИЙ К PARTSAPI
-- Только настоящие запросы (не из кэша). Нужен, чтобы видеть расход лимита.
CREATE TABLE IF NOT EXISTS api_request_log (
  id          BIGSERIAL PRIMARY KEY,
  method      VARCHAR(50) NOT NULL,
  ok          BOOLEAN NOT NULL,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_log_created ON api_request_log (created_at);

-- 3. АВТОМОБИЛИ (справочник модификаций, которые уже запрашивали)
CREATE TABLE IF NOT EXISTS vehicles (
  car_id        BIGINT PRIMARY KEY,       -- CAR_ID из getCars / carId из VINdecode
  make_id       INTEGER,
  make_name     VARCHAR(100) NOT NULL,
  model_id      INTEGER,
  model_name    VARCHAR(200) NOT NULL,
  modification  VARCHAR(200),
  engine_type   VARCHAR(50),
  capacity      VARCHAR(30),
  power_ps      NUMERIC(7,1),
  year_from     DATE,
  year_to       DATE,                     -- NULL = выпускается до сих пор
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. VIN -> автомобиль (VIN не меняется, кэшируется надолго)
CREATE TABLE IF NOT EXISTS vin_lookup (
  vin         VARCHAR(17) PRIMARY KEY,
  car_id      BIGINT REFERENCES vehicles(car_id),
  raw         JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. ЗАПРАВОЧНЫЕ ОБЪЁМЫ (из GetFillVolumes), уже очищенные от дублей
CREATE TABLE IF NOT EXISTS vehicle_fill_volumes (
  id          BIGSERIAL PRIMARY KEY,
  car_id      BIGINT NOT NULL REFERENCES vehicles(car_id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,      -- "Моторное масло с фильтром"
  info        VARCHAR(200),               -- "SAE 5W-30"
  unit        VARCHAR(10),                -- л / г / см³ / NULL (если это код спецификации)
  value_text  VARCHAR(100) NOT NULL,      -- "6,45" или "510 - 530" или код "WSS-M2C913-C"
  UNIQUE (car_id, title, info, unit, value_text)
);

-- 6. ДОПУСКИ ПРОИЗВОДИТЕЛЯ (из toDopusk, блок specifications)
CREATE TABLE IF NOT EXISTS vehicle_approvals (
  id          BIGSERIAL PRIMARY KEY,
  car_id      BIGINT NOT NULL REFERENCES vehicles(car_id) ON DELETE CASCADE,
  fluid       VARCHAR(100) NOT NULL,      -- "Масло моторное", "Тормозная жидкость"
  approval_type VARCHAR(100),             -- "Допуски OEM", "Спецификация FMVSS 116"
  approval    VARCHAR(100) NOT NULL,      -- "VW 504 00", "DOT 4"
  UNIQUE (car_id, fluid, approval)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_approvals_approval ON vehicle_approvals (approval);

-- 7. РЕКОМЕНДОВАННЫЕ ПРОИЗВОДИТЕЛЕМ ПОЗИЦИИ (из toDopusk, блок oils)
CREATE TABLE IF NOT EXISTS vehicle_oil_items (
  id          BIGSERIAL PRIMARY KEY,
  car_id      BIGINT NOT NULL REFERENCES vehicles(car_id) ON DELETE CASCADE,
  fluid       VARCHAR(100) NOT NULL,
  spec_group  VARCHAR(200) NOT NULL,      -- "VAG LongLife III 0W-30"
  article     VARCHAR(50) NOT NULL,
  brand       VARCHAR(100),
  pack_liters NUMERIC(6,2),
  priority    INTEGER,
  UNIQUE (car_id, article)
);

-- 8. ДОПУСКИ ВАШИХ ТОВАРОВ (заполняется вручную по этикеткам Gulf Western Oil)
-- Связывает "допуск, который нужен машине" с "товаром из вашего каталога".
-- ВАЖНО: products.id - это таблица товаров из Шага 2 руководства.
CREATE TABLE IF NOT EXISTS product_approvals (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  approval    VARCHAR(100) NOT NULL,      -- "VW 504 00", "MB 229.5", "ACEA C3"
  UNIQUE (product_id, approval)
);
CREATE INDEX IF NOT EXISTS idx_product_approvals_approval ON product_approvals (approval);

-- 9. "МОИ АВТОМОБИЛИ" КЛИЕНТА (гараж в профиле)
CREATE TABLE IF NOT EXISTS user_garage (
  id          SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  car_id      BIGINT NOT NULL REFERENCES vehicles(car_id),
  vin         VARCHAR(17),
  nickname    VARCHAR(100),               -- "Моя Audi"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, car_id)
);
CREATE INDEX IF NOT EXISTS idx_user_garage_tg ON user_garage (telegram_id);

-- Права для пользователя приложения (имя берётся из -v app_user=..., по умолчанию avtopromoyl_admin)
\if :{?app_user}
\else
  \set app_user avtopromoyl_admin
\endif
GRANT ALL ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
