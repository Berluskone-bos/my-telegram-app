#!/bin/sh
# Восстановление из копии в НОВУЮ базу (существующую рабочую базу скрипт не трогает и не перезаписывает).
#   ./restore.sh <файл.dump.enc> <адрес_новой_пустой_базы>
# BACKUP_PASSPHRASE — тот же пароль, что при создании копии.
set -eu
FILE="${1:?укажите файл копии}"; TARGET="${2:?укажите адрес новой пустой базы}"
: "${BACKUP_PASSPHRASE:?нет BACKUP_PASSPHRASE}"
case "$TARGET" in *railway.internal*|*rlwy.net*) echo "Подтвердите вручную: целевая база — рабочая? Скрипт делает восстановление только в новую пустую базу."; [ "${I_KNOW_TARGET_IS_NEW:-}" = "yes" ] || exit 2;; esac
N="$(psql "$TARGET" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
[ "$N" = "0" ] || { echo "Целевая база не пуста (таблиц: $N). Восстановление отменено."; exit 3; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" \
  | pg_restore --dbname="$TARGET" --no-owner --no-privileges --exit-on-error
echo "Восстановлено. Таблиц: $(psql "$TARGET" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
