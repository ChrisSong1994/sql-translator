-- MySQL 测试种子数据（挂载到 /docker-entrypoint-initdb.d）
-- 覆盖：主键/自增/索引/唯一键/外键/注释/多种类型/时间列
SET NAMES utf8mb4;
CREATE DATABASE IF NOT EXISTS testdb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE testdb;

CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL COMMENT '用户姓名',
  age INT NULL,
  email VARCHAR(255) NULL,
  balance DECIMAL(10,2) DEFAULT 0.00,
  is_active TINYINT(1) DEFAULT 1,
  birthday DATE NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_age (age),
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

CREATE TABLE orders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';

INSERT INTO users (name, age, email, balance, is_active, birthday) VALUES
('alice', 30, 'alice@x.com', 100.50, 1, '1993-01-15'),
('bob', 20, 'bob@x.com', 0.00, 0, '2003-06-01'),
('carol', 25, 'carol@x.com', 50.00, 1, '1998-12-20');

INSERT INTO orders (user_id, amount, status) VALUES
(1, 10.50, 'paid'),
(1, 5.00, 'pending'),
(3, 99.00, 'paid');
