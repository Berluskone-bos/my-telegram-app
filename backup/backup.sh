#!/bin/sh
# Резервная копия PostgreSQL: pg_dump → шифрование (AES-256) → хранилище → удаление старых копий.
# Запускается по расписанию (Railway Cron). Все секреты — только в переменных окружения.
#   DATABASE_URL            адрес базы (внутренний адрес Railway)
#   BACKUP_PASSPHRASE       пароль шифрования копий (хранить ОТДЕЛЬНО от хранилища: в менеджере паролей владельца!)
#   BACKUP_S3_BUCKET        имя корзины S3-совместимого хранилища (Yandex Object Storage / Selectel / Backblaze B2 …)
#   BACKUP_S3_ENDPOINT      адрес API хранилища, например https://storage.yandexcloud.net
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   ключи доступа к хранилищу (права только на эту корзину)
#   BACKUP_DIR              вместо S3 — обычная папка (для проверки на тестовой копии)
#   KEEP_DAILY=14 KEEP_WEEKLY=8 KEEP_MONTHLY=12   сколько копий хранить
set -eu
umask 077
: "${DATABASE_URL:?нет DATABASE_URL}"
: "${BACKUP_PASSPHRASE:?нет BACKUP_PASSPHRASE}"
KEEP_DAILY="${KEEP_DAILY:-14}"; KEEP_WEEKLY="${KEEP_WEEKLY:-8}"; KEEP_MONTHLY="${KEEP_MONTHLY:-12}"
MIN_BYTES="${MIN_BYTES:-2000}"            # копия меньше этого размера — считаем сбоем (пустая база не бывает такой)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
FILE="gulf-$STAMP.dump.enc"
DUMP="$TMP/$FILE.dump"

echo "[backup] $(date -u +%FT%TZ) старт, pg_dump $(pg_dump --version)"
# Сначала создаём дамп отдельным файлом: set -e гарантированно ловит ошибку pg_dump.
# Не объединять pg_dump и openssl в pipeline без pipefail — иначе частичный дамп может выглядеть успешным.
pg_dump --dbname="$DATABASE_URL" -Fc --no-owner --no-privileges --file="$DUMP"
# Шифруем только после успешного завершения pg_dump. Временные файлы закрыты правами umask 077.
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -in "$DUMP" -out "$TMP/$FILE"
rm -f "$DUMP"
SIZE="$(wc -c < "$TMP/$FILE")"
[ "$SIZE" -ge "$MIN_BYTES" ] || { echo "[backup] ОШИБКА: копия подозрительно мала ($SIZE байт)"; exit 1; }
# Самопроверка: расшифровываем и читаем оглавление копии. Битая копия не должна считаться копией.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$TMP/$FILE" | pg_restore --list > "$TMP/list.txt" \
  || { echo "[backup] ОШИБКА: копия не читается после шифрования"; exit 1; }
TABLES="$(grep -c ' TABLE DATA ' "$TMP/list.txt" || true)"
echo "[backup] копия $FILE: $SIZE байт, таблиц с данными: $TABLES"

put() {   # put <файл> <папка>
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    aws s3 cp --only-show-errors --endpoint-url "${BACKUP_S3_ENDPOINT:?нет BACKUP_S3_ENDPOINT}" "$1" "s3://$BACKUP_S3_BUCKET/$2/$(basename "$1")"
  else
    mkdir -p "${BACKUP_DIR:?нужен BACKUP_S3_BUCKET или BACKUP_DIR}/$2"; cp "$1" "$BACKUP_DIR/$2/"
  fi
}
list() {  # list <папка> — имена файлов по возрастанию (старые первыми)
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    aws s3 ls --endpoint-url "$BACKUP_S3_ENDPOINT" "s3://$BACKUP_S3_BUCKET/$1/" | awk '{print $4}' | grep '\.enc$' | sort || true
  else
    ls "$BACKUP_DIR/$1" 2>/dev/null | grep '\.enc$' | sort || true
  fi
}
del() {   # del <папка> <имя>
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then aws s3 rm --only-show-errors --endpoint-url "$BACKUP_S3_ENDPOINT" "s3://$BACKUP_S3_BUCKET/$1/$2"; else rm -f "$BACKUP_DIR/$1/$2"; fi
}
prune() { # prune <папка> <сколько оставить>
  N="$(list "$1" | wc -l)"
  [ "$N" -gt "$2" ] || return 0
  list "$1" | head -n "$((N - $2))" | while read -r f; do echo "[backup] удаляю старую копию $1/$f"; del "$1" "$f"; done
}

put "$TMP/$FILE" daily
[ "$(date -u +%u)" = "7" ] && put "$TMP/$FILE" weekly      # воскресенье
[ "$(date -u +%d)" = "01" ] && put "$TMP/$FILE" monthly    # первое число
prune daily "$KEEP_DAILY"; prune weekly "$KEEP_WEEKLY"; prune monthly "$KEEP_MONTHLY"
echo "[backup] готово: $FILE (в хранилище daily: $(list daily | wc -l), weekly: $(list weekly | wc -l), monthly: $(list monthly | wc -l))"
