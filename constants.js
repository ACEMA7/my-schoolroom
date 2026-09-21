/* ============================================================
 * constants.js —— 全局常量（从 config.js / app.js / ui.js / data.js 迁移）
 * ------------------------------------------------------------
 * 职责：
 *   集中存放系统级配置常量：Supabase 云端连接参数、本地存储键名、
 *   设备标识、lz-string 压缩前缀、容量阈值、V3「按行存储」同步架构
 *   常量（记录类型映射、基础/业务数据分类、批大小、表结构版本号）、
 *   分数符号版本、页面版本守卫阈值、字体缩放配置、PWA 引导配置、
 *   扣分预警阈值、错误日志配置、站内通知默认模板。
 *
 * 依赖：无（本文件最先加载，只定义常量，不访问 DB / DOM 业务对象；
 *       DEVICE_ID 仅访问 localStorage 读取/生成本机标识，与原 config.js 行为一致）。
 *
 * 对外暴露（classic script 顶层 var 声明天然全局，所有常量均可直接以
 *           变量名引用；文件末尾另将对象/数组类配置显式挂载 window，
 *           便于外部脚本访问）。
 * ============================================================ */

    // ==================== 云端与本地存储配置（原 config.js） ====================
    // Supabase 连接参数：anonKey 为公开匿名密钥（安全模型依赖行级安全策略 RLS），
    // enabled=false 时系统退化为纯本地单机模式
    var SUPABASE_CONFIG = {
        url: 'https://pburnvnfzwoyfxktqfho.supabase.co',
        anonKey: 'sb_publishable_sO8GOS5fm-k76SA7zZz0yQ_aSQkYg2u',
        enabled: true
    };
    // 本地数据库在 localStorage 中的键名（整库 JSON，经 lz-string 压缩后写入）
    var DB_KEY = 'dormitory_system_v10';

    // 设备标识：用于生成全局唯一的记录ID（多设备并发登记互不冲突）
    var DEVICE_ID=(function(){ try{ var k='dorm_device_id'; var v=localStorage.getItem(k); if(!v){ v=Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-4); localStorage.setItem(k,v);} return v; }catch(e){ return 'nos'; } })();

    // 主控设备 ID：唯一允许上传基础数据的设备，防止管理员非主控设备（手机/家里电脑）脏数据污染云端
    var MASTER_DEVICE_ID = 'd4ezy733t0';

    // 绑定密码已迁移至云端 meta 表 masterBindHash 字段，首次由管理员设置

    // 是否为主控设备：决定是否允许修改基础数据（非主控设备仅可读，UI 熔断 + 函数入口拦截）
    var IS_MASTER_DEVICE = (DEVICE_ID === MASTER_DEVICE_ID);

    var LOCAL_LZ_PREFIX = 'LZC1:';   // 本地压缩存储标记（compressToUTF16，localStorage 按 UTF-16 计长，密度最高）
    var CLOUD_LZ_PREFIX = 'LZC1B:';  // 云端压缩存储标记（compressToBase64，纯 ASCII，HTTP/UTF-8 传输无膨胀）
    var STORAGE_WARN_BYTES = 4 * 1024 * 1024; // 本地数据 4MB 预警阈值
    var STORAGE_AUTO_COMPRESS_BYTES = 3 * 1024 * 1024; // 本地数据超过 3MB 时主动切换压缩存储（不等配额耗尽）
    var TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 墓碑上传成功后本地保留 7 天（期内随同步重广播）

    // ==================== V3 按行存储架构：常量与辅助（原 config.js） ====================
    // 业务记录类型 → DB 中对应数组的映射。
    // 注意 deductionItems 是 {hygiene:[], discipline:[]} 对象，需要特殊处理。
    var V3_RECORD_TYPES = [
        { type: 'meta',            dbPath: ['meta'],              idField: 'id',    isArray: false, specialMeta: true },
        { type: 'floor',            dbPath: ['floors'],           idField: 'id',    isArray: true  },
        { type: 'dormitory',        dbPath: ['dormitories'],      idField: 'id',    isArray: true  },
        { type: 'student',          dbPath: ['students'],         idField: 'id',    isArray: true  },
        { type: 'user',             dbPath: ['users'],            idField: 'id',    isArray: true  },
        { type: 'deduction_item',   dbPath: ['deductionItems'],   idField: 'id',    isArray: false, specialItems: true },
        { type: 'deduction_record', dbPath: ['deductionRecords'], idField: 'id',    isArray: true  },
        { type: 'leave_record',     dbPath: ['leaveRecords'],     idField: 'id',    isArray: true  },
        { type: 'absence_record',   dbPath: ['absenceRecords'],   idField: 'id',    isArray: true  },
        // —— 巡查核实模块（业务记录，多设备并发按 updated_at 合并）——
        { type: 'inspection_confirmation', dbPath: ['inspectionConfirmations'],  idField: 'id', isArray: true }, // 巡查确认
        { type: 'anomaly_report',          dbPath: ['anomalyReports'],           idField: 'id', isArray: true }, // 异常上报（家长接走/无假条）
        { type: 'daily_summary',           dbPath: ['dailyInspectionSummaries'], idField: 'id', isArray: true }, // 每日晚检总结
        // —— 站内通知子系统 ——
        { type: 'notification',          dbPath: ['notifications'],         idField: 'id', isArray: true }, // 通知（业务记录，多设备并发）
        { type: 'notification_template', dbPath: ['notificationTemplates'], idField: 'id', isArray: true }, // 通知模板（管理员统一维护的基础数据）
        { type: 'floor_change_request',  dbPath: ['floorChangeRequests'],   idField: 'id', isArray: true }  // 楼层调整申请
    ];
    // 基础数据类型（管理员统一维护，云端为权威）——拉取时云端覆盖本地
    var V3_BASIC_TYPES = ['meta', 'floor', 'dormitory', 'student', 'user', 'deduction_item', 'notification_template'];
    // 业务记录类型（多设备并发写入，按 updated_at 合并）
    var V3_MUTABLE_TYPES = ['deduction_record', 'leave_record', 'absence_record', 'inspection_confirmation', 'anomaly_report', 'daily_summary', 'notification', 'floor_change_request'];
    // Supabase upsert 批量上限（保守值，实际约 500）
    var V3_UPSERT_CHUNK = 200;
    // 表结构版本：2 = 旧版整库压缩，3 = 新版按行存储
    var V3_SCHEMA_VERSION = 3;

    // 分数符号版本号：1 = 旧口径（扣分正数、加分正数，显示层取反）；
    //                 2 = 新口径（扣分负数、加分正数，净分 = 扣分 + 加分，显示层不取反）
    // 主控设备启动时检测旧版本并执行 migrateScoreSign() 全量翻转，
    // 同时递增 syncEpoch 触发其他设备整体重建，防止新旧符号数据混存。
    var SCORE_SIGN_VERSION = 2;

    // ==================== 版本守卫（原 app.js） ====================
    // 页面最长存活时间：超过即视为"可能携带过期 JS"，同步前强制刷新（2 小时）
    var PAGE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

    // ==================== 字体缩放（原 app.js） ====================
    var FONT_SCALE_KEY='dorm_font_scale_staff';
    var FONT_BASE=14; // 基准字号 14px
    var FONT_MIN=100, FONT_MAX=160, FONT_STEP=5; // 可调范围 100%~160%，步进 5%

    // ==================== 扣分预警（原 app.js） ====================
    // 七档预警阈值（与 DEFAULT_NOTIFICATION_TEMPLATES 的 warn_* 一一对应）
    var NOTIF_WARNING_THRESHOLDS = [3, 5, 6, 11, 12, 17, 18];

    // ==================== PWA 安装引导（原 app.js） ====================
    // 用户点"暂不/我知道了"后写入关闭时间戳，7 天内不再自动弹出。
    var PWA_BANNER_DISMISS_KEY = 'dorm_pwa_banner_dismissed';
    var PWA_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

    // ==================== 统一错误处理（原 ui.js） ====================
    var ERROR_LOG_KEY = 'dorm_error_logs';
    var ERROR_LOG_LIMIT = 20; // 只保留最近 20 条，避免日志本身撑爆本地存储

    // ==================== 站内通知子系统：默认模板常量（原 data.js） ====================
    // 系统内置通知模板的出厂默认值：7 条扣分预警（warn_*，含 threshold/level）
    // + 6 条审核结果通知（approval_*/reject_*）+ 楼层调整相关模板。
    // initDatabase 初始化 DB.notificationTemplates 与 getDefaultNotificationTemplate
    // （管理员"重置"模板）共用本常量，保证两处默认值永远一致。
    // 扣分预警内容变量：{studentName} {className} {score}，由 renderNotificationTemplate 替换。
    var DEFAULT_NOTIFICATION_TEMPLATES = [
        { id:'warn_3',  threshold:3,  level:'yellow', title:'⚠️ 扣分预警通知', content:'{studentName}（{className}）当前累计净分已达 {score} 分，请班主任及时关注并教育。', enabled:true },
        { id:'warn_5',  threshold:5,  level:'orange', title:'🟠 扣分预警升级', content:'{studentName}（{className}）当前累计净分已达 {score} 分，即将达到 6 分（停宿一周）标准，请班主任尽快与家长沟通。', enabled:true },
        { id:'warn_6',  threshold:6,  level:'orange', title:'🟠 停宿一周告知', content:'{studentName}（{className}）当前累计净分已达 {score} 分，按校规将停宿一周，请班主任通知家长并做好后续安排。', enabled:true },
        { id:'warn_11', threshold:11, level:'red',    title:'🔴 扣分预警升级', content:'{studentName}（{className}）当前累计净分已达 {score} 分，即将达到 12 分（停宿两周）标准，请班主任尽快约谈家长。', enabled:true },
        { id:'warn_12', threshold:12, level:'red',    title:'🔴 停宿两周告知', content:'{studentName}（{className}）当前累计净分已达 {score} 分，按校规将停宿两周，请班主任约谈家长并做好记录。', enabled:true },
        { id:'warn_17', threshold:17, level:'dark',   title:'🚨 扣分预警升级', content:'{studentName}（{className}）当前累计净分已达 {score} 分，即将达到 18 分（退宿）标准，请班主任立即联系家长并上报德育处。', enabled:true },
        { id:'warn_18', threshold:18, level:'dark',   title:'🚨 退宿处理告知', content:'{studentName}（{className}）当前累计净分已达 {score} 分，按校规将作退宿处理，请班主任配合德育处完成后续流程。', enabled:true },
        { id:'approval_leave',   title:'✅ 退宿申请已通过', content:'你提交的退宿申请已通过审核。', enabled:true },
        { id:'approval_stop',    title:'✅ 停宿申请已通过', content:'你提交的停宿申请已通过审核。', enabled:true },
        { id:'approval_absence', title:'✅ 请假申请已通过', content:'你提交的请假申请已通过审核。', enabled:true },
        { id:'reject_leave',     title:'❌ 退宿申请被驳回', content:'你提交的退宿申请未通过审核，请查看详情或重新提交。', enabled:true },
        { id:'reject_stop',      title:'❌ 停宿申请被驳回', content:'你提交的停宿申请未通过审核，请查看详情或重新提交。', enabled:true },
        { id:'reject_absence',   title:'❌ 请假申请被驳回', content:'你提交的请假申请未通过审核，请查看详情或重新提交。', enabled:true },
        { id:'floor_change_request',  title:'📝 新的楼层调整申请', content:'{staffName} 申请将负责楼层由 {fromFloors} 调整为 {toFloors}，原因：{reason}，请及时审核。', enabled:true },
        { id:'approval_floor_change', title:'✅ 楼层调整申请已通过', content:'你申请的楼层调整已通过审核，当前负责楼层已更新为 {toFloors}。', enabled:true },
        { id:'reject_floor_change',   title:'❌ 楼层调整申请被驳回', content:'你申请的楼层调整未通过审核。{reviewRemark}', enabled:true }
    ];


// ---- shared globals explicitly mounted on window ----
// 仅挂载对象/数组类型的配置引用（SUPABASE_CONFIG 及 V3_*_TYPES），
// 便于外部脚本访问；DB_KEY/DEVICE_ID/LOCAL_LZ_PREFIX/CLOUD_LZ_PREFIX/
// STORAGE_WARN_BYTES/V3_UPSERT_CHUNK/V3_SCHEMA_VERSION 等基本类型常量由
// 顶层 var 声明天然全局，直接以变量名访问即可，无需经 window 中转。
window.SUPABASE_CONFIG = SUPABASE_CONFIG;
window.V3_RECORD_TYPES = V3_RECORD_TYPES;
window.V3_BASIC_TYPES = V3_BASIC_TYPES;
window.V3_MUTABLE_TYPES = V3_MUTABLE_TYPES;
window.SCORE_SIGN_VERSION = SCORE_SIGN_VERSION;
