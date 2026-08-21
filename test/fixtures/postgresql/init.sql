-- PostgreSQL 测试种子数据（docker-entrypoint 挂载执行，PG 容器默认 UTF8）
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  age INTEGER,
  email VARCHAR(255) UNIQUE,
  balance NUMERIC(10,2) DEFAULT 0.00,
  is_active BOOLEAN DEFAULT TRUE,
  birthday DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON COLUMN users.name IS '用户姓名';
COMMENT ON TABLE users IS '用户表';

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_age ON users (age);

INSERT INTO users (name, age, email, balance, is_active, birthday) VALUES
('alice', 30, 'alice@x.com', 100.50, TRUE, '1993-01-15'),
('bob', 20, 'bob@x.com', 0.00, FALSE, '2003-06-01'),
('carol', 25, 'carol@x.com', 50.00, TRUE, '1998-12-20');

INSERT INTO orders (user_id, amount, status) VALUES
(1, 10.50, 'paid'),
(1, 5.00, 'pending'),
(3, 99.00, 'paid');
