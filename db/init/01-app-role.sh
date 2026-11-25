#!/bin/sh
# Runs once when the docker-compose Postgres volume is first created.
# The API connects as receptionist_app: a normal role (NOT superuser, NO BYPASSRLS), so the
# row-level security policies from migration 002 apply to it. It owns the tables it migrates.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" -v db="$POSTGRES_DB" <<'EOSQL'
CREATE ROLE receptionist_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
GRANT CONNECT, CREATE ON DATABASE :"db" TO receptionist_app;
GRANT USAGE, CREATE ON SCHEMA public TO receptionist_app;
EOSQL
