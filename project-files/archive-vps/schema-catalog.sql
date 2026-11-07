-- Пункт 4: каталог Сан Трип, скидки, рефералы.
-- Запуск: sudo -u postgres psql -d avtopromoyl_shop -f schema-catalog.sql
-- Можно запускать повторно.
ALTER TABLE products ADD COLUMN IF NOT EXISTS article     VARCHAR(40);
ALTER TABLE products ADD COLUMN IF NOT EXISTS section     VARCHAR(80);
ALTER TABLE products ADD COLUMN IF NOT EXISTS viscosity   VARCHAR(60);
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_size   NUMERIC(8,2);   -- объём/вес одной единицы
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_unit   VARCHAR(5);     -- л / кг
ALTER TABLE products ADD COLUMN IF NOT EXISTS box_qty     INTEGER;        -- штук в коробке поставщика
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_label  VARCHAR(60);    -- фасовка как в прайсе
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price  NUMERIC(10,2);  -- закупка у Сан Трип (клиенту НЕ показывать)
ALTER TABLE products ADD COLUMN IF NOT EXISTS specs_text  TEXT;           -- описание и спецификации из прайса
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_article ON products (article);

-- Шкала скидок: по накопленному обороту выкупленных заказов
CREATE TABLE IF NOT EXISTS loyalty_tiers (
  min_turnover NUMERIC(12,2) PRIMARY KEY,
  percent      NUMERIC(4,1) NOT NULL
);
INSERT INTO loyalty_tiers (min_turnover, percent) VALUES (0,3),(15000,5),(40000,7),(100000,10)
ON CONFLICT (min_turnover) DO UPDATE SET percent = EXCLUDED.percent;

-- Настройки (меняются без перезапуска кода)
CREATE TABLE IF NOT EXISTS app_settings (
  key   VARCHAR(50) PRIMARY KEY,
  value VARCHAR(200) NOT NULL
);
INSERT INTO app_settings (key, value) VALUES
  ('referral_bonus', '200'),          -- ₽ приглашающему
  ('referral_min_order', '6000'),     -- заказ друга должен быть БОЛЬШЕ этой суммы
  ('retail_markup', '0.5')            -- наценка к закупке (как в прайсе)
ON CONFLICT (key) DO NOTHING;

\if :{?app_user}
\else
  \set app_user avtopromoyl_admin
\endif
GRANT ALL ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
