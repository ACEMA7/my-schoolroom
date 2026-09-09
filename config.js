/* ============================================================
 * config.js —— 全局配置常量
 * ------------------------------------------------------------
 * 职责：
 *   集中存放系统级配置：Supabase 云端连接参数、本地存储键名、
 *   设备标识、lz-string 压缩前缀、容量阈值，以及 V3「按行存储」
 *   同步架构的全部常量（记录类型映射、基础/业务数据分类、批大小、
 *   表结构版本号）。
 *
 * 依赖：无（本文件最先加载，只定义常量，不访问 DB / DOM）。
 *
 * 对外暴露（文件末尾统一挂载 window，供 data.js / sync.js / ui.js /
 *           app.js 及 index.html 内联脚本直接引用）：
 *   SUPABASE_CONFIG     Supabase 连接配置 {url, anonKey, enabled}
 *   DB_KEY              localStorage 中本地数据库的键名
 *   DEVICE_ID           本机设备标识（生成全局唯一记录 ID 用）
 *   LOCAL_LZ_PREFIX     本地压缩数据标记（compressToUTF16）
 *   CLOUD_LZ_PREFIX     云端压缩数据标记（compressToBase64）
 *   STORAGE_WARN_BYTES  本地存储容量预警阈值（字节）
 *   V3_RECORD_TYPES     V3 记录类型 → DB 字段路径映射表
 *   V3_BASIC_TYPES      基础数据类型（云端为权威，拉取时覆盖本地）
 *   V3_MUTABLE_TYPES    业务记录类型（多设备并发，按 updated_at 合并）
 *   V3_UPSERT_CHUNK     Supabase 批量 upsert 每批条数上限
 *   V3_SCHEMA_VERSION   表结构版本号（3 = 按行存储）
 *
 * 说明：本项目为原生 JS（classic script）多文件架构，各文件共享
 *       全局作用域；加载顺序为 config → data → sync → ui → app。
 * ============================================================ */

    // ==================== 云端与本地存储配置 ====================
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

    var LOCAL_LZ_PREFIX = 'LZC1:';   // 本地压缩存储标记（compressToUTF16，localStorage 按 UTF-16 计长，密度最高）
    var CLOUD_LZ_PREFIX = 'LZC1B:';  // 云端压缩存储标记（compressToBase64，纯 ASCII，HTTP/UTF-8 传输无膨胀）
    var STORAGE_WARN_BYTES = 4 * 1024 * 1024; // 本地数据 4MB 预警阈值

    // ==================== V3 按行存储架构：常量与辅助 ====================
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
        { type: 'absence_record',   dbPath: ['absenceRecords'],   idField: 'id',    isArray: true  }
    ];
    // 基础数据类型（管理员统一维护，云端为权威）——拉取时云端覆盖本地
    var V3_BASIC_TYPES = ['meta', 'floor', 'dormitory', 'student', 'user', 'deduction_item'];
    // 业务记录类型（多设备并发写入，按 updated_at 合并）
    var V3_MUTABLE_TYPES = ['deduction_record', 'leave_record', 'absence_record'];
    // Supabase upsert 批量上限（保守值，实际约 500）
    var V3_UPSERT_CHUNK = 200;
    // 表结构版本：2 = 旧版整库压缩，3 = 新版按行存储
    var V3_SCHEMA_VERSION = 3;


// ---- shared globals explicitly mounted on window ----
window.SUPABASE_CONFIG = SUPABASE_CONFIG;
window.DB_KEY = DB_KEY;
window.DEVICE_ID = DEVICE_ID;
window.LOCAL_LZ_PREFIX = LOCAL_LZ_PREFIX;
window.CLOUD_LZ_PREFIX = CLOUD_LZ_PREFIX;
window.STORAGE_WARN_BYTES = STORAGE_WARN_BYTES;
window.V3_RECORD_TYPES = V3_RECORD_TYPES;
window.V3_BASIC_TYPES = V3_BASIC_TYPES;
window.V3_MUTABLE_TYPES = V3_MUTABLE_TYPES;
window.V3_UPSERT_CHUNK = V3_UPSERT_CHUNK;
window.V3_SCHEMA_VERSION = V3_SCHEMA_VERSION;
