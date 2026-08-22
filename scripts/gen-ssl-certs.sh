#!/usr/bin/env bash
# 生成测试用自签 SSL 证书（CA + 各库 server 证书），输出到 test/fixtures/ssl/
# 运行：bash scripts/gen-ssl-certs.sh [--force]
# docker-compose 挂载这些证书，因此必须在本机先运行一次（CI 中已加入步骤）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/test/fixtures/ssl"
mkdir -p "$DIR"
cd "$DIR"

# 幂等：已存在则跳过（除非 --force）
if [ -f ca.pem ] && [ "${1:-}" != "--force" ]; then
  echo "[gen-ssl-certs] 证书已存在（$DIR），跳过。如需重新生成：bash scripts/gen-ssl-certs.sh --force"
  exit 0
fi

rm -f ca.pem ca-key.pem *.csr *.srl \
  mysql8-cert.pem mysql8-key.pem \
  postgres-cert.pem postgres-key.pem \
  mongodb-cert.pem mongodb-key.pem mongodb.pem

# 1. 自签 CA
openssl genrsa -out ca-key.pem 2048 2>/dev/null
openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 3650 \
  -subj "/CN=sql-translator-test-ca" -out ca.pem

# 2. 每库一张 server 证书（SAN 覆盖 localhost / 127.0.0.1，供本机连接）
for name in mysql8 postgres mongodb; do
  openssl genrsa -out "$name-key.pem" 2048 2>/dev/null
  openssl req -new -key "$name-key.pem" -subj "/CN=localhost" -out "$name.csr"
  openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
    -out "$name-cert.pem" -days 3650 -sha256 \
    -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1")
  rm -f "$name.csr"
done

# 3. MongoDB：cert + key 合并为单个 PEM（mongod --tlsCertificateKeyFile 要求）
cat mongodb-cert.pem mongodb-key.pem > mongodb.pem

# 4. 权限：统一 644，便于各容器以非 root 用户读取
chmod 644 ca.pem ca-key.pem *-cert.pem *-key.pem mongodb.pem

echo "[gen-ssl-certs] 生成完成 → $DIR"
ls -1
