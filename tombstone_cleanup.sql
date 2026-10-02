-- =============================================================
-- 宿舍管理系统 · 云端墓碑物理清理脚本（条目 3.1）
-- 作用：物理删除 sync_store 表中已超过保留期（7 天）的墓碑行
--      （deleted = true 且 updated_at 早于 7 天前），防止云端表无限膨胀。
-- 安全：仅删除"已打墓碑且过保留期"的行；存活数据与 7 天内墓碑重广播机制不受影响。
-- 用法：在 Supabase 控制台 → SQL Editor 中执行（幂等，可定期/学期末重复执行）。
-- 注意：执行前请先跑下面的【预检 count】确认将删除的行数，确认无误后再执行 DELETE。
-- =============================================================

-- ---------- 【预检】查看将被物理删除的墓碑行数（只读，无副作用）----------
select count(*) as tombstone_rows_to_delete
from sync_store
where deleted = true
  and updated_at < now() - interval '7 days';

-- ---------- 【执行】物理删除超期墓碑行（确认上面的数量可接受后再运行）----------
-- delete from sync_store
-- where deleted = true
--   and updated_at < now() - interval '7 days';

-- 说明：
-- 1) 保留期 7 天与前端 TOMBSTONE_RETENTION_MS（sync.js）保持一致；
--    7 天内的墓碑仍会随同步重广播，故只清理 7 天前的墓碑，不会造成数据倒灌。
-- 2) 脚本幂等：重复执行不会报错，已清理过的行不再存在。
-- 3) 若 RLS 已启用，需以表所有者 / service role 身份执行，或确保执行账号具备 DELETE 权限。
