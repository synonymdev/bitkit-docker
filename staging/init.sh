#!/usr/bin/env bash
# Creates .env from .env.example with fresh passwords and keys, and the JWT key pair in secrets/.
# Run once per deployment; it never overwrites an existing value or key.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || cp .env.example .env
mkdir -p secrets

fill() { # fill KEY VALUE when KEY is empty in .env
  if grep -q "^$1=$" .env; then
    sed -i.bak "s|^$1=$|$1=$2|" .env && rm -f .env.bak
  fi
}
rand() { openssl rand -hex 24; }

fill BITCOIN_RPC_PASSWORD "$(rand)"
fill VSS_DB_PASSWORD "$(rand)"
fill MEMPOOL_DB_PASSWORD "$(rand)"
fill MEMPOOL_DB_ROOT_PASSWORD "$(rand)"

if grep -q '^LDK_BACKUP_SECRET_KEY=$' .env; then
  key=$(openssl ecparam -name secp256k1 -genkey -noout)
  fill LDK_BACKUP_SECRET_KEY "$(echo "$key" | openssl ec -text -noout 2>/dev/null | sed -n '/priv:/,/pub:/p' | grep -v -e priv -e pub | tr -d ' :\n' | tail -c 64)"
  sed -i.bak '/^LDK_BACKUP_PUBLIC_KEY=/d' .env && rm -f .env.bak
  echo "LDK_BACKUP_PUBLIC_KEY=$(echo "$key" | openssl ec -pubout -conv_form compressed -outform DER 2>/dev/null | tail -c 33 | xxd -p -c 33)" >> .env
fi

if [ ! -f secrets/jwt-private.pem ]; then
  openssl genrsa -out secrets/jwt-private.pem 2048 2>/dev/null
  openssl rsa -in secrets/jwt-private.pem -pubout -out secrets/jwt-public.pem 2>/dev/null
fi
# lnurl-auth-server runs as uid 1001 and must read its keys; the 700 folder keeps other host users out
chmod 600 .env
chmod 700 secrets
chmod 644 secrets/jwt-private.pem secrets/jwt-public.pem
echo "ready: edit the hostnames in .env, then docker compose up -d --build"
