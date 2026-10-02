-- =============================================================
-- 宿舍管理系统 · 写入口令轮换 SQL（条目 1.1·方案A）
-- 作用：把 Supabase RLS "protected write" 策略校验的 x-access-key 口令
--      换成新的强随机串，使旧的、已泄露在源码历史里的口令立即失效。
-- 用法：在 Supabase 控制台 → SQL Editor 中粘贴并 Run（service role 或表所有者身份）。
-- 配套：前端 access-key.local.js 中 window.__DORM_ACCESS_KEY__ 必须与此处口令完全一致。
-- =============================================================

-- 新口令（32 位，与 access-key.local.js 保持一致）：
--   0ddde28752fe22b58892ac5e69e2f188

ALTER TABLE sync_store ENABLE ROW LEVEL SECURITY;

-- ① 读策略：匿名可读（保持现状；如需收紧可把 anon 去掉）
DROP POLICY IF EXISTS "read" ON sync_store;
CREATE POLICY "read" ON sync_store
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ② 写策略：仅当请求头 x-access-key 等于新口令时允许写（取代旧口令）
DROP POLICY IF EXISTS "protected write" ON sync_store;
CREATE POLICY "protected write" ON sync_store
  FOR ALL
  TO anon, authenticated
  USING (
    current_setting('request.headers', true)::json->>'x-access-key'
      = '0ddde28752fe22b58892ac5e69e2f188'
  )
  WITH CHECK (
    current_setting('request.headers', true)::json->>'x-access-key'
      = '0ddde28752fe22b58892ac5e69e2f188'
  );

-- 执行后验证：
--   select * from sync_store limit 1;   -- 读应正常
--   不带 x-access-key 头的写应被拒绝；带正确口令的写应成功。
