# 宿舍管理系统（PWA）

学校宿舍日常管理的纯前端单页应用：学生住宿信息、扣分登记与统计、请假/停宿/退宿登记与审核、学生名单与宿舍号管理、数据查询导出，支持多设备云端同步与离线使用。移动端（手机浏览器/添加到主屏幕）与桌面端自适应。

## 技术栈

| 类别 | 选型 | 说明 |
| --- | --- | --- |
| 前端 | 原生 HTML + CSS + JavaScript（无框架、无构建） | 多文件 classic script，共享全局作用域，按 `config → data → sync → ui → app` 顺序加载 |
| 云端 | Supabase（Postgres + supabase-js v2 CDN） | 单表 `sync_store` 按行存储（V3 架构），多设备增量同步 |
| 本地 | localStorage（整库存档，lz-string 压缩） | 离线可用；约 5MB 配额，超限自动压缩并预警 |
| PWA | Service Worker（sw.js）+ manifest.json | 预缓存本地资源与 CDN 库，离线可打开；断网 toast 提示 |
| 日期 | flatpickr v4.6.13（内联在 index.html） | 无外部请求，离线可用 |
| 导出 | SheetJS xlsx 0.18.5（CDN） | 学生 Excel 导入、数据导出 .xlsx |
| 压缩 | lz-string 1.5.0（CDN） | 本地 UTF-16 压缩、云端 Base64 压缩 |
| 密码 | Web Crypto SHA-256（含降级方案） | 不存明文密码 |

## 目录结构

```
index.html      页面结构 + CSS + 内联 flatpickr（日期选择器）
config.js       全局配置：Supabase 连接、存储键、V3 同步架构常量
data.js         数据层：内存库 DB、数据查询、本地持久化、密码哈希、数据自愈
sync.js         同步层：Supabase 客户端、V3 按行同步、重试队列、重置云端、初始化入口
ui.js           视图层：toast/错误处理、分片渲染、各业务视图 HTML 渲染
app.js          控制层：登录、路由、所有业务事件（onclick 入口）、SW 注册
sw.js           Service Worker（离线缓存）；版本号由 update_version.ps1 自动维护，勿手改
manifest.json   PWA 清单；icon-192/512.png
_server.ps1     本地静态服务器（http://localhost:8765，no-cache）
update_version.ps1 版本号自动更新脚本（改完任何 .js/.html 后运行，详见「版本号管理」）
```

分层约定：**app.js 决定"做什么"**（改 DB → `saveDB()` → 触发重绘）；**ui.js 负责"怎么显示"**（拼 HTML、渲染视图）；**data.js 管数据读写**；**sync.js 管云端**。新增交互函数放在 app.js，新增视图渲染放在 ui.js。

## 数据模型（DB 对象，存于 localStorage 键 `dormitory_system_v10`）

```js
DB = {
  floors: [ {id, name, sortOrder} ],                    // 楼层（固定 8 层）
  dormitories: [ {id, floorId, roomNumber, capacity} ], // 宿舍（房间号=层号*100+序号，如 305）
  dormitoryList: ['101','102', ...],                    // 生效宿舍号权威名单（增删宿舍号维护此列表）
  students: [ {id, dormitoryId, name, className, bedNumber} ], // dormitoryId=null 表示走读生
  users: [ {id, username, passwordHash, realName, role, className?} ],
  deductionItems: { hygiene: [{id,name,defaultScore}], discipline: [...] }, // 卫生项/纪律项
  deductionRecords: [ {id, dormitoryId, studentId?, className, name, date,
      hygieneItems, disciplineItems, hygieneScore, disciplineScore, remark, updatedAt} ], // 扣分记录
  leaveRecords: [ {id, type:'leave'|'stop', className, name, dormitory, bed,
      studentId, date, startDate, endDate, reason, status:'pending'|'approved'|'rejected'} ], // 退宿/停宿
  absenceRecords: [ {id, className, name, dormitory, bed, studentId, date, reason} ], // 请假/缺宿
  nextIds: {floor, dormitory, student, item, record, leave, absence, user}, // 自增 ID
  // —— 同步元数据 ——
  syncEpoch, lastSyncTime,                               // 数据版本号（云端重置用）、上次同步时间
  dirtyByType: { [recordType]: { [recordId]: true } },   // 脏标记：本地新增/修改待上传
  deletedByType: { [recordType]: { [recordId]: true } }, // 墓碑：本地删除待广播
}
```

V3 记录类型（`V3_RECORD_TYPES`）：`floor / dormitory / student / user / deduction_item` 为**基础数据**（云端权威，拉取覆盖本地）；`deduction_record / leave_record / absence_record` 为**业务记录**（多设备并发，按 `updated_at` 最新者胜）；`meta` 为单行（dormitoryList + nextIds + epoch）。

## 内置账号

| 用户名 | 密码 | 角色 | 权限 |
| --- | --- | --- | --- |
| `admin` | `admin123` | ADMIN 管理员 | 全部功能（删除/审核/重置云端/管理宿舍与项目） |
| `staff` | `staff123` | STAFF 生活老师 | 住宿信息、扣分登记、统计、学生管理（无数据管理） |
| `三1`～`三31` | `123456` | CLASS_ADMIN 班主任 | 仅本班学生/宿舍相关数据 + 学生管理 + 数据管理 |

## 核心功能

- **住宿信息**：楼层→宿舍树导航；宿舍床位/学生一览；历史扣分记录（大列表分片渲染）
- **扣分登记**：班级/宿舍/床号级联选择，卫生项/纪律项勾选 + 自定义项，实时合计分数，支持按宿舍集体或指定学生登记
- **统计报表**：全校宿舍排行榜（TOP20/展开全部）、楼层扣分情况、各楼层明细，折叠状态跨重绘保持
- **学生名单**：班级/姓名/住宿状态检索、全选批量删除、新增、调寝、退宿、Excel 批量导入
- **学生管理**：退宿/停宿/请假三类登记，管理员审核（通过/驳回），按班级/状态筛选
- **数据管理**：按类型（扣分/退宿/请假）+ 班级/宿舍/日期范围查询预览，导出 XLSX；危险操作区（清空记录、重置云端）

## 部署与运行

### 本地运行
```powershell
# Windows：项目根目录执行
powershell -ExecutionPolicy Bypass -File .\_server.ps1
# 浏览器打开 http://localhost:8765/
```
也可用任何静态服务器（`python -m http.server` 等）。**注意**：密码哈希的 SHA-256 需要安全上下文（localhost 或 HTTPS）；普通 HTTP 局域网 IP 访问会自动降级为混淆哈希（功能正常、强度降低）。

### Supabase 配置
1. 新建 Supabase 项目，在 SQL Editor 执行建表（V3 按行存储）：
   ```sql
   create table sync_store (
     id bigint generated always as identity primary key,
     record_type text not null,
     record_id   text not null,
     data jsonb,
     deleted boolean default false,
     updated_at timestamptz,
     device_id text,
     unique (record_type, record_id)
   );
   -- 行级安全策略（anon 开放读写，按学校实际情况收紧）
   alter table sync_store enable row level security;
   create policy "anon all" on sync_store for all to anon using (true) with check (true);
   ```
2. 把项目 URL 与 anon key 填入 [config.js](config.js) 的 `SUPABASE_CONFIG`；`enabled:false` 可切换为纯本地单机模式。
3. CDN 依赖（supabase-js/xlsx/lz-string）已被 Service Worker 预缓存，首次联网打开后离线可用。

### PWA
- 移动端浏览器菜单选"添加到主屏幕"即可以独立应用启动；
- [sw.js](sw.js) 采用 cache-first（本地 + CDN）、Supabase API 仅网络、导航离线回退缓存页；
- **修改任何 .js / .html 文件后，必须运行 `update_version.ps1` 升级 sw.js 版本号**（自动同步 `CACHE_NAME` 与 `APP_VERSION` 两处），否则设备继续运行旧缓存。操作方式见下方[版本号管理](#版本号管理必看)。

## 版本号管理（必看）

Service Worker 对同源 JS / HTML 采用 cache-first：**不升版本号，已打开过应用的设备会一直加载旧缓存代码**，出现"代码已改但运行时不存在"的幽灵错误。因此版本号的两处声明必须在每次代码改动后同步更新，且严格同值：

```js
// sw.js 顶部（由脚本自动生成，禁止手动修改）
var CACHE_NAME = 'dormitory-cache-2026-09-12-1124'; // 浏览器据此发现并安装新 SW
self.APP_VERSION = '2026-09-12-1124';               // 顶栏版本号文字，漏改会显示旧值
```

### 版本号格式规范

- 格式：**`yyyy-MM-dd-HHmm`**（年-月-日-时分，24 小时制，月/日/时/分均为两位补零）
- 示例：`2026-09-12-1124` 表示 2026 年 9 月 12 日 11:24
- 由 [update_version.ps1](update_version.ps1) 在执行时取**系统当前时间**生成，无需人工编号，也不存在序号冲突
- 注意：同一分钟内重复运行脚本，版本号不会变化（属正常现象）

### 自动更新流程（推荐）

**每次修改并保存任何 `.js` / `.html` 文件后**，在项目根目录执行一次脚本：

```powershell
# 方式一：PowerShell 中执行（推荐，可绕过默认执行策略限制）
powershell -ExecutionPolicy Bypass -File .\update_version.ps1

# 方式二：已在 PowerShell 窗口且执行策略允许时
.\update_version.ps1
```

也可以在文件资源管理器中**右键 `update_version.ps1` →「使用 PowerShell 运行」**。

脚本执行成功后会输出新旧版本号对照，例如：

```text
sw.js 版本号已同步更新：2026-09-12-1124
  CACHE_NAME : var CACHE_NAME = 'dormitory-cache-2026-09-12-0017';
             -> var CACHE_NAME = 'dormitory-cache-2026-09-12-1124';
  APP_VERSION: self.APP_VERSION = '2026-09-12-0017';
             -> self.APP_VERSION = '2026-09-12-1124';
```

脚本安全机制：

1. 只精确匹配 `var CACHE_NAME = ...;` 与 `self.APP_VERSION = ...;` 两处单行声明，其他内容一律不动；
2. 两处声明各必须且只能命中 1 次，否则**中止写入并报错**，不会写坏文件；
3. 以 UTF-8（无 BOM）写回，保留中文注释与原有换行格式。

### 备选方案：手动更新（无法运行脚本时）

若当前环境不方便执行 PowerShell（如非 Windows 设备、执行策略被组策略锁定），可手动编辑 [sw.js](sw.js) 顶部的两行，**两处版本号必须完全相同**：

1. 取当前系统时间，按 `yyyy-MM-dd-HHmm` 拼出版本号（例如下午 3:05 → `2026-09-12-1505`）；
2. 替换 `CACHE_NAME` 引号中 `dormitory-cache-` 之后的部分；
3. 用同一版本号替换 `self.APP_VERSION` 引号中的值；
4. 保存后刷新页面两次（第一次安装新 SW，第二次加载新代码）。

> 手动更新只作为兜底，日常开发请始终使用脚本，从根本上消除两处不一致的风险。

## 维护指南

- **新增/删除扣分项目**：数据管理 → 扣分项目（仅管理员），或"批量导入"；改动经 `v3MarkDirty('deduction_item', id)` 自动同步。
- **管理宿舍号**：学生名单 → 宿舍管理。新增即加入 `dormitoryList` 权威名单；删除仅移除名单（历史记录可追溯，有在住学生时拒绝删除）。
- **重置云端数据**（学期初换数据）：数据管理 → 🔁 重置云端数据（仅管理员，双重确认）。它会清空云端、递增 `syncEpoch` 并全量回传；**其它设备点一次同步即整体替换为这套数据，旧数据不会回灌**。重置期间其它设备不要点同步。
- **清空扣分记录**：数据管理危险区（全部/退宿/停宿/请假分别可清），会逐行登记墓碑同步删除。
- 所有数据写操作统一走 `saveDB()`（落本地 + 触发云端增量同步），不要只改 DB 不保存。

## 常见问题

- **日期差一天**：业务日期必须用 `formatLocalDate()`/`getTodayLocalStr()`（本地时区）；禁止 `toISOString().split('T')[0]`（UTC，东八区夜间会错位）。同步用 ISO 时间戳（`updated_at`）保留 UTC 属正常。
- **同步失败/红点提示"有未同步数据"**：断网自动进入指数退避重试（5/10/20/40/60 秒，最多 5 次），联网后自动补传；也可点顶栏 🔄 手动同步。上传失败不会误报"同步完成"，脏标记保留。
- **云端数据被清空后别慌**：若管理员正在重置，拉取会判定"重置窗口"（aborted）不动本地，稍后再同步即可。
- **本地存储空间告警**：数据接近 localStorage 上限时会自动 lz-string 压缩并提示，建议在数据管理中清理历史记录。
- **改了代码不生效**：运行 `update_version.ps1` 升级 sw.js 版本号（详见[版本号管理](#版本号管理必看)），并刷新页面两次（第一次安装新 SW，第二次才加载新代码）。
- **错误排查**：顶栏异常 toast 已分类（网络/权限/配额）；详细错误栈写入 localStorage 的 `dorm_error_logs`（最近 20 条）。
