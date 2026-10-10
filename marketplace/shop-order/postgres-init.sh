#!/usr/bin/env bash
# First start of the shop-order Postgres: the Lock Server, marketplace service and Shop BFF databases, and the two refusal-audit
# logins the service requires besides its own (it refuses to start when an audit URL reuses the domain login). Each login is made
# with the exact attributes the service's migration 0032 checks, so the migration accepts it instead of creating it without a
# password. The passwords come from the keys step: the container's entrypoint exports /state/order/postgres.env as root, and this
# script, which the image runs as the postgres user, inherits them. The database is disposable: no backup or replica.
set -euo pipefail
: "${AUDIT_WRITER_PASSWORD:?}" "${AUDIT_RETENTION_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE locks;
CREATE DATABASE marketplace;
CREATE DATABASE bff;
CREATE ROLE marketplace_refusal_audit_writer_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 2 PASSWORD '${AUDIT_WRITER_PASSWORD}';
CREATE ROLE marketplace_refusal_audit_retention LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 1 PASSWORD '${AUDIT_RETENTION_PASSWORD}';
SQL
