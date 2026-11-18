# Служба резервного копирования (отдельный сервис Railway с Cron-расписанием). Клиент PostgreSQL 18 — той же версии, что база.
FROM postgres:18-alpine
RUN apk add --no-cache aws-cli openssl
COPY backup.sh restore.sh /app/
RUN chmod +x /app/*.sh
WORKDIR /app
USER postgres
CMD ["/app/backup.sh"]
