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
fill FAUCET_AUTH "faucet:$(rand)"

if grep -q '^LDK_BACKUP_SECRET_KEY=$' .env; then
  key=$(openssl ecparam -name secp256k1 -genkey -noout)
  secret=$(echo "$key" | openssl ec -outform DER 2>/dev/null | od -An -v -tx1 -j7 -N32 | tr -d ' \n')
  public=$(echo "$key" | openssl ec -pubout -conv_form compressed -outform DER 2>/dev/null | od -An -v -tx1 -j23 -N33 | tr -d ' \n')
  if [ ${#secret} -ne 64 ] || [ ${#public} -ne 66 ]; then
    echo "could not derive the backup server key pair" >&2
    exit 1
  fi
  fill LDK_BACKUP_SECRET_KEY "$secret"
  fill LDK_BACKUP_PUBLIC_KEY "$public"
fi
if ! grep -Eq '^LDK_BACKUP_PUBLIC_KEY=[0-9a-f]{66}$' .env; then
  echo "LDK_BACKUP_PUBLIC_KEY is missing; clear LDK_BACKUP_SECRET_KEY in .env and rerun" >&2
  exit 1
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
