-- MySQL SSL 测试专用用户：REQUIRE SSL 强制 TLS（docker-entrypoint 自动执行）
-- 服务端同时开启 --require-secure-transport=ON，双重保证非 TLS 连接被拒
CREATE USER IF NOT EXISTS 'ssl_user'@'%' IDENTIFIED BY 'sslpass' REQUIRE SSL;
GRANT ALL PRIVILEGES ON testdb.* TO 'ssl_user'@'%';
FLUSH PRIVILEGES;
