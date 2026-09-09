/* ============================================================
 * data.js —— 数据状态与数据访问层
 * ------------------------------------------------------------
 * 职责：
 *   1. 持有全局内存数据库对象 DB（楼层/宿舍/学生/账号/扣分项目/
 *      扣分记录/请假记录/退宿记录等全部业务数据）；
 *   2. 提供数据查询辅助函数（按 ID/宿舍/楼层/班级检索学生与记录）；
 *   3. 本地持久化：localStorage 读写（lz-string 压缩 + 容量预警）；
 *   4. 密码安全：SHA-256 哈希（Web Crypto）与旧明文密码迁移；
 *   5. 默认数据初始化（initDatabase）与基础数据自愈（repairBasicData）；
 *   6. V3 按行存储的本地脏标记（dirtyByType）/ 删除墓碑（deletedByType）
 *      管理与记录 ID 生成——供 sync.js 增量同步使用。
 *
 * 主要依赖（全局共享变量）：
 *   config.js：DB_KEY / DEVICE_ID / LOCAL_LZ_PREFIX / STORAGE_WARN_BYTES /
 *              V3_RECORD_TYPES / V3_BASIC_TYPES 等常量；
 *   app.js：currentUser（当前登录用户，权限判断用）；
 *   第三方：window.LZString（压缩）、window.crypto.subtle（哈希）。
 *
 * 对外暴露（函数声明在 classic script 中天然全局，另在文件末尾
 *           显式挂载 window 的有：DB / storageWarned / _detectedSchemaVersion /
 *           hashPassword / migrateUserPasswords / formatLocalDate / getTodayLocalStr）。
 *   常用公共函数：getStudentById / getStudentsByDormitory / getRecordsByDormitory /
 *     getTotalScore / getItemById / isAdmin / isClassAdmin / initDatabase /
 *     loadDBFromLocal / saveDBToLocal / ensureSyncMeta / repairBasicData /
 *     generateRecordId / v3MarkDirty / v3MarkDeleted / v3MarkAllLocalDirty。
 *
 * 数据流向：UI/业务层（app.js/ui.js）读写 DB → saveDB() 落本地并触发
 *           云端增量同步（sync.js）；云端数据经 loadFromCloudV3 合并回 DB。
 * ============================================================ */

    // 全局内存数据库：所有业务数据的唯一事实来源（localStorage 是其持久化镜像）
    var DB = null;

    // ==================== 日期工具函数（本地时区） ====================
    /**
     * 将日期格式化为本地时区的 YYYY-MM-DD 字符串。
     * 注意：禁止使用 toISOString().split('T')[0]——它按 UTC 取日期，
     * 东八区晚间（00:00-08:00）会把"今天"错位成前一天。
     * @param {Date|string|number} date - Date 对象、可被 new Date() 解析的日期字符串/时间戳
     * @returns {string} 形如 '2026-09-10' 的本地日期；入参无效时返回 ''
     */
    function formatLocalDate(date) {
        if (!date) return '';
        if (typeof date === 'string') date = new Date(date);
        if (isNaN(date.getTime())) return '';
        var year = date.getFullYear();
        var month = String(date.getMonth() + 1).padStart(2, '0');
        var day = String(date.getDate()).padStart(2, '0');
        return year + '-' + month + '-' + day;
    }
    /**
     * 获取今日本地日期字符串（YYYY-MM-DD）。
     * @returns {string} 今日日期，如 '2026-09-10'
     */
    function getTodayLocalStr() {
        return formatLocalDate(new Date());
    }

    // ==================== 数据访问辅助函数 ====================
    // 以下 getXxx 系列为纯查询函数：只读 DB、不修改数据；DB 未初始化时
    // 统一返回 null（单对象）或 []（列表），调用方无需额外判空。

    /**
     * 按 ID 查询楼层。
     * @param {number} id - 楼层 ID（1-8）
     * @returns {{id:number,name:string,sortOrder:number}|null} 楼层对象，无则 null
     */
    function getFloorById(id) {
        if (!DB || !DB.floors) return null;
        return DB.floors.find(function(f) { return f.id === id; }) || null;
    }

    /**
     * 按 ID 查询宿舍。
     * @param {number} id - 宿舍记录 ID（dormitory.id，非宿舍号）
     * @returns {{id:number,floorId:number,roomNumber:string,capacity:number}|null}
     */
    function getDormitoryById(id) {
        if (!DB || !DB.dormitories) return null;
        return DB.dormitories.find(function(d) { return d.id === id; }) || null;
    }

    /**
     * 查询某楼层下所有「生效中」的宿舍（已删除宿舍号不在此列）。
     * @param {number} floorId - 楼层 ID
     * @returns {Array} 宿舍对象数组；是否生效以 DB.dormitoryList 权威名单为准
     */
    function getDormitoriesByFloor(floorId) {
        if (!DB || !DB.dormitories) return [];
        // 仅返回 dormitoryList 中的生效宿舍号；被删除的宿舍不再出现在选择列表中
        var activeSet = {};
        (DB.dormitoryList || []).forEach(function(r){ activeSet[String(r)] = true; });
        return DB.dormitories.filter(function(d) {
            return d.floorId === floorId && activeSet[String(d.roomNumber)];
        });
    }
    // 判断宿舍号是否已被删除（用于历史记录显示）
    // 修复：若该宿舍仍有学生入住，视为未删除（数据一致性兜底）
    function isDormitoryDeleted(roomNumber){
        if(!DB || !Array.isArray(DB.dormitoryList)) return false;
        if(DB.dormitoryList.indexOf(String(roomNumber)) !== -1) return false;
        // 宿舍号不在 dormitoryList，但有学生入住 → 视为有效宿舍（导入遗漏修复）
        var dorm = getDormitoryByRoomNumber(roomNumber);
        if(dorm && getStudentsByDormitory(dorm.id).length > 0) return false;
        return true;
    }
    // 通过宿舍ID获取显示名称：已删除的宿舍号标注 [已删除]
    function getDormDisplayNameById(dormitoryId){
        var d = getDormitoryById(dormitoryId);
        if(!d) return '-';
        return isDormitoryDeleted(d.roomNumber) ? (d.roomNumber + '[已删除]') : d.roomNumber;
    }
    // 历史记录中宿舍号快照的显示（已删除标注）
    function getDormSnapshotDisplay(roomNumber){
        if(!roomNumber) return '-';
        return isDormitoryDeleted(roomNumber) ? (roomNumber + '[已删除]') : roomNumber;
    }
    // 通过宿舍号查找 dormitory（含已删除的，用于历史数据回显）
    function getDormitoryByRoomNumber(roomNumber){
        if(!DB || !DB.dormitories) return null;
        return DB.dormitories.find(function(d){ return String(d.roomNumber) === String(roomNumber); }) || null;
    }
    // 获取排序后的生效宿舍号列表（按楼层优先、宿舍号从小到大：101,102,...,201,202...）
    // className 非空时仅返回该班级学生入住的宿舍号
    function getSortedDormNumbers(className){
        var set = {};
        if(className){
            DB.students.forEach(function(s){
                if(s.className !== className || s.dormitoryId == null) return;
                var d = getDormitoryById(s.dormitoryId);
                if(d) set[String(d.roomNumber)] = true;
            });
        } else {
            (DB.dormitoryList || []).forEach(function(r){ set[String(r)] = true; });
        }
        return Object.keys(set).sort(function(a, b){ return parseInt(a, 10) - parseInt(b, 10); });
    }
    // 生成宿舍号 select 选项 HTML
    function dormSelectOptions(className, selectedVal){
        var nums = getSortedDormNumbers(className);
        var opts = '<option value="">请选择宿舍</option>';
        nums.forEach(function(n){ opts += '<option value="'+n+'"'+(n===selectedVal?' selected':'')+'>'+n+'</option>'; });
        return opts;
    }
    // 获取某宿舍已占用的床号
    function getOccupiedBeds(dormitoryId){
        var beds = {};
        getStudentsByDormitory(dormitoryId).forEach(function(s){ if(s.bedNumber) beds[String(s.bedNumber)] = true; });
        return beds;
    }
    // 生成床号 select 选项 HTML（1-8，已占用的标注"已满"并禁用）
    function bedSelectOptions(dormitoryId, selectedVal, excludeStudentId){
        var opts = '<option value="">请选择床号</option>';
        var occupied = {};
        if(dormitoryId){
            getStudentsByDormitory(dormitoryId).forEach(function(s){
                if(excludeStudentId && s.id === excludeStudentId) return;
                if(s.bedNumber) occupied[String(s.bedNumber)] = true;
            });
        }
        for(var b = 1; b <= 8; b++){
            var bstr = String(b);
            var disabled = occupied[bstr] ? ' disabled' : '';
            var label = occupied[bstr] ? (b+'（已满）') : String(b);
            opts += '<option value="'+bstr+'"'+(bstr===selectedVal?' selected':'')+disabled+'>'+label+'</option>';
        }
        return opts;
    }

    /**
     * 按 ID 查询学生。
     * @param {number} id - 学生 ID
     * @returns {{id:number,dormitoryId:number|null,name:string,className:string,bedNumber:string}|null}
     */
    function getStudentById(id) {
        if (!DB || !DB.students) return null;
        return DB.students.find(function(s) { return s.id === id; }) || null;
    }

    /**
     * 查询某宿舍的全部在住学生（不含已退宿/走读）。
     * @param {number} dormitoryId - 宿舍 ID
     * @returns {Array} 学生对象数组（床号 bedNumber 为字符串 '1'-'8'）
     */
    function getStudentsByDormitory(dormitoryId) {
        if (!DB || !DB.students) return [];
        return DB.students.filter(function(s) { return s.dormitoryId === dormitoryId; });
    }
    // 判断是否为非住宿生（走读生）：dormitoryId 为 null 或未定义
    function isNonResidentStudent(student){
        return !student || student.dormitoryId == null;
    }
    // 获取住宿学生列表（排除走读生），用于住宿信息/扣分登记等场景
    function getResidentStudents(className){
        if(!DB||!Array.isArray(DB.students)) return [];
        return DB.students.filter(function(s){
            if(s.dormitoryId == null) return false;
            if(className && s.className !== className) return false;
            return true;
        });
    }

    /**
     * 查询某宿舍的全部扣分记录（卫生 + 纪律）。
     * @param {number} dormitoryId - 宿舍 ID
     * @returns {Array} 扣分记录数组（记录含 hygieneScore/disciplineScore/items 等）
     */
    function getRecordsByDormitory(dormitoryId) {
        if (!DB || !DB.deductionRecords) return [];
        return DB.deductionRecords.filter(function(r) { return r.dormitoryId === dormitoryId; });
    }

    /**
     * 查询某楼层全部宿舍的扣分记录（统计报表按楼层汇总用）。
     * @param {number} floorId - 楼层 ID
     * @returns {Array} 该楼层所有宿舍的扣分记录数组
     */
    function getRecordsByFloor(floorId) {
        if (!DB || !DB.deductionRecords || !DB.dormitories) return [];
        var dormIds = getDormitoriesByFloor(floorId).map(function(d) { return d.id; });
        return DB.deductionRecords.filter(function(r) { return dormIds.indexOf(r.dormitoryId) !== -1; });
    }

    /**
     * 计算一组扣分记录的累计扣分（卫生分 + 纪律分）。
     * @param {Array} records - 扣分记录数组
     * @returns {number} 总扣分（保留 1 位小数，已消除浮点尾差）
     */
    function getTotalScore(records) {
        if (!records) return 0;
        var total = 0;
        records.forEach(function(r) {
            total += (r.hygieneScore || 0) + (r.disciplineScore || 0);
        });
        // 消除 0.2 分自定义项累加产生的浮点尾差（如 14.600000000000001）
        return Math.round(total * 10) / 10;
    }

    /**
     * 按 ID 查询扣分项目（在卫生项与纪律项两个数组中共同查找）。
     * @param {number} id - 项目 ID（卫生项 1xx，纪律项 2xx）
     * @returns {{id:number,name:string,defaultScore:number}|null}
     */
    function getItemById(id) {
        if (!DB || !DB.deductionItems) return null;
        var allItems = (DB.deductionItems.hygiene || []).concat(DB.deductionItems.discipline || []);
        return allItems.find(function(item) { return item.id === id; }) || null;
    }

    /**
     * 获取扣分项目名称；自定义项（id 形如 'custom:xxx'）直接取冒号后文本。
     * @param {number|string} id - 项目 ID 或 'custom:自定义内容'
     * @returns {string} 项目名称；找不到时返回 ''
     */
    function getItemNameByIdOrCustom(id) {
        if (typeof id === 'string' && id.startsWith('custom:')) {
            return id.substring(7);
        }
        var item = getItemById(id);
        return item ? item.name : '';
    }

    // 班级名称排序：先按前缀（非数字部分）分组，再按数字升序（三1、三2……三31），
    // 兼容"三1"与"高一1班"等多种格式混排（纯数字提取会把不同年级的同号班级混在一起）
    function sortClassNames(list) {
        return list.slice().sort(function(a, b) {
            var pa = String(a).replace(/[0-9]+/g, ''), pb = String(b).replace(/[0-9]+/g, '');
            if (pa !== pb) return pa.localeCompare(pb, 'zh-Hans-CN');
            var na = parseInt(String(a).replace(/[^0-9]/g, '')) || 0;
            var nb = parseInt(String(b).replace(/[^0-9]/g, '')) || 0;
            if (na !== nb) return na - nb;
            return String(a).localeCompare(String(b), 'zh-Hans-CN');
        });
    }

    function getDormitoryClassName(dormitoryId) {
        var students = getStudentsByDormitory(dormitoryId);
        if (students.length === 0) return '-';
        var classSet = {};
        students.forEach(function(s) { if (s.className) classSet[s.className] = true; });
        var keys = Object.keys(classSet);
        return keys.length > 0 ? keys.join('/') : '-';
    }

    function getClassNameForRecord(record) {
        if (record.studentId) {
            var student = getStudentById(record.studentId);
            return student ? student.className || '-' : '-';
        }
        var dorm = getDormitoryById(record.dormitoryId);
        if (!dorm) return '-';
        return getDormitoryClassName(dorm.id);
    }

    function getBedNumberForSort(record) {
        if (record.studentId) {
            var student = getStudentById(record.studentId);
            return student ? parseInt(student.bedNumber) || 999 : 999;
        }
        return 999;
    }

    /**
     * 判断当前登录用户是否为管理员（ADMIN）。
     * 管理员独有：删除/修改记录、重置云端、管理宿舍号与扣分项目等。
     * @returns {boolean}
     */
    function isAdmin() {
        return currentUser && currentUser.role === 'ADMIN';
    }

    // ==================== 班级账号（CLASS_ADMIN）数据范围 ====================
    /**
     * 判断当前登录用户是否为班级账号（班主任，CLASS_ADMIN）。
     * 班级账号只能看到本班学生与本班宿舍相关的数据。
     * @returns {boolean}
     */
    function isClassAdmin() {
        return !!(currentUser && currentUser.role === 'CLASS_ADMIN');
    }
    // 当前班级账号的学生集合（按 className 匹配；非班级账号返回全部学生）
    function getClassStudents() {
        if (!isClassAdmin()) return DB.students;
        return DB.students.filter(function(s) { return s.className === currentUser.className; });
    }
    // 当前班级学生入住的宿舍ID映射 {dormitoryId:true}
    function getClassDormIds() {
        var set = {};
        getClassStudents().forEach(function(s) { if (s.dormitoryId) set[s.dormitoryId] = true; });
        return set;
    }
    // 按班级范围过滤扣分记录：班级学生的记录，或落在班级宿舍的集体记录
    function filterRecordsByClass(records) {
        if (!isClassAdmin()) return records;
        var dormSet = getClassDormIds();
        var stuSet = {};
        getClassStudents().forEach(function(s) { stuSet[s.id] = true; });
        return records.filter(function(r) {
            if (r.studentId) return !!stuSet[r.studentId];
            return !!(r.dormitoryId && dormSet[r.dormitoryId]);
        });
    }


    // ==================== 密码哈希（SHA-256 / Web Crypto API） ====================
    // 极端降级方案：crypto.subtle 不可用（如非安全上下文 HTTP）时的确定性混淆。
    // 输出带 'fb1:' 前缀以区分 SHA-256 十六进制串；登录比对两端使用同一函数，结果一致。
    function _hashPasswordFallback(text){
        try {
            return 'fb1:' + btoa(unescape(encodeURIComponent('dorm::' + text)));
        } catch(e) {
            var h = 5381;
            for (var i = 0; i < text.length; i++) { h = ((h << 5) + h + text.charCodeAt(i)) >>> 0; }
            return 'fb1:' + h.toString(16) + '-' + text.length.toString(16);
        }
    }
    /**
     * 异步计算密码哈希（供登录比对与账号落库使用）。
     * 优先使用 window.crypto.subtle 的 SHA-256（HTTPS/localhost 安全上下文可用），
     * 返回 64 位十六进制字符串；环境不支持时降级为 _hashPasswordFallback
     * 的确定性混淆（'fb1:' 前缀，安全强度低，仅保证两端比对一致）。
     * @param {string} plainText - 明文密码
     * @returns {Promise<string>} 哈希字符串（64 位 hex 或 'fb1:' 前缀串）
     */
    function hashPassword(plainText){
        return new Promise(function(resolve){
            var txt = String(plainText == null ? '' : plainText);
            try {
                if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') {
                    var data = new TextEncoder().encode(txt);
                    window.crypto.subtle.digest('SHA-256', data).then(function(buf){
                        var arr = new Uint8Array(buf);
                        var hex = '';
                        for (var i = 0; i < arr.length; i++) hex += (arr[i] < 16 ? '0' : '') + arr[i].toString(16);
                        resolve(hex);
                    }).catch(function(){ resolve(_hashPasswordFallback(txt)); });
                    return;
                }
            } catch(e) {}
            resolve(_hashPasswordFallback(txt));
        });
    }

    // ==================== 密码迁移：明文 password → passwordHash ====================
    // 幂等：仅处理「无 passwordHash 但有明文 password」的账号（哈希后删除明文字段并标脏上传），
    // 以及「已有 passwordHash 但仍残留明文」的账号（仅清理明文）。迁移完成后本地与云端均不再存明文。
    function migrateUserPasswords(){
        if(!DB || !Array.isArray(DB.users)) return Promise.resolve(0);
        var tasks = [];
        DB.users.forEach(function(u){
            if(!u) return;
            var hasHash = typeof u.passwordHash === 'string' && u.passwordHash.length > 0;
            var hasPlain = typeof u.password === 'string' && u.password.length > 0;
            if(!hasHash && hasPlain){
                var plain = u.password;
                delete u.password; // 先删明文，哈希就绪前该账号不可登录（毫秒级窗口）
                tasks.push(hashPassword(plain).then(function(h){
                    u.passwordHash = h;
                    v3MarkDirty('user', u.id); // 标脏：哈希后的密码需上传云端覆盖旧明文
                }));
            } else if(hasHash && hasPlain){
                delete u.password; // 已有哈希，清理残留明文
                v3MarkDirty('user', u.id);
            }
        });
        return Promise.all(tasks).then(function(){ return tasks.length; });
    }

    // ==================== 初始化与同步 ====================
    /**
     * 确保内置账号齐全（幂等，应用启动与云端重置后都会调用）。
     * 保证存在：admin/管理员（ADMIN，密码 admin123）、staff/生活老师
     * （STAFF，密码 staff123）、三1～三31 共 31 个班级账号
     * （CLASS_ADMIN，密码 123456）。缺失账号统一异步哈希后创建并标脏上传；
     * 同时完成旧称呼迁移与会话缓存校准（见 _ensureCorrectUsersFinish）。
     * @returns {Promise} 账号补齐完成后 resolve
     */
    function ensureCorrectUsers() {
        if (!DB || !DB.users) return Promise.resolve();
        var adminExists = false, staffExists = false;
        for (var i = 0; i < DB.users.length; i++) {
            if (DB.users[i].username === 'admin') { DB.users[i].role = 'ADMIN'; DB.users[i].realName = '管理人员'; adminExists = true; }
            if (DB.users[i].username === 'staff') { DB.users[i].role = 'STAFF'; DB.users[i].realName = '生活老师'; staffExists = true; }
        }
        // 先收集缺失账号，统一异步计算密码哈希后再创建（确保落库即无明文）
        var missingClasses = [];
        for (var i = 1; i <= 31; i++) {
            var className = '三' + i;
            if (!DB.users.some(function(u) { return u.username === className; })) missingClasses.push(className);
        }
        var needAdmin = !adminExists, needStaff = !staffExists;
        if (!needAdmin && !needStaff && missingClasses.length === 0) {
            _ensureCorrectUsersFinish();
            return Promise.resolve();
        }
        var hashes = {};
        var jobs = [];
        if (needAdmin) jobs.push(hashPassword('admin123').then(function(h){ hashes.admin = h; }));
        if (needStaff) jobs.push(hashPassword('staff123').then(function(h){ hashes.staff = h; }));
        if (missingClasses.length > 0) jobs.push(hashPassword('123456').then(function(h){ hashes.cls = h; }));
        return Promise.all(jobs).then(function(){
            if (needAdmin) { var u1={ id: DB.nextIds.user++, username: 'admin', passwordHash: hashes.admin, realName: '管理人员', role: 'ADMIN' }; DB.users.push(u1); v3MarkDirty('user', u1.id); }
            if (needStaff) { var u2={ id: DB.nextIds.user++, username: 'staff', passwordHash: hashes.staff, realName: '生活老师', role: 'STAFF' }; DB.users.push(u2); v3MarkDirty('user', u2.id); }

            // 补充31个班级账号（如果缺失）
            missingClasses.forEach(function(className){
                var u3 = {
                    id: DB.nextIds.user++,
                    username: className,
                    passwordHash: hashes.cls,
                    realName: className + '班班主任',
                    role: 'CLASS_ADMIN',
                    className: className
                };
                DB.users.push(u3);
                v3MarkDirty('user', u3.id);
            });
            _ensureCorrectUsersFinish();
        });
    }
    // ensureCorrectUsers 收尾（同步部分，账号补齐前后共用）：称呼迁移 + 会话缓存校准 + 落库
    function _ensureCorrectUsersFinish(){
        // 旧数据迁移：班级账号称呼统一为“xx班班主任”（旧值可能为“xx班管理员”或“xx班管理人员”）
        for (var j = 0; j < DB.users.length; j++) {
            var u = DB.users[j];
            if (u.role === 'CLASS_ADMIN' && u.realName && u.realName.indexOf('班主任') === -1 &&
                (u.realName.indexOf('管理员') !== -1 || u.realName.indexOf('管理人员') !== -1)) {
                u.realName = (u.className || u.username || '') + '班班主任';
                v3MarkDirty('user', u.id); // 称呼修正需上传，否则拉取时会被云端旧值覆盖
            }
        }

        // 同步已登录会话中缓存的旧称呼（realName 以 DB 为准）
        try {
            var cu = JSON.parse(sessionStorage.getItem('currentUser') || 'null');
            if (cu) {
                var nu = DB.users.find(function(x){ return x.id === cu.id; });
                if (nu && nu.realName && nu.realName !== cu.realName) {
                    cu.realName = nu.realName;
                    sessionStorage.setItem('currentUser', JSON.stringify(cu));
                }
            }
        } catch(e) {}

        // 不再过滤，保留所有用户（包括班级账号）
        saveDBToLocal();
    }

    /**
     * 首次使用时创建默认数据库（localStorage 无存档才调用）。
     * 内容：8 个楼层、每层 20 间宿舍 + 723/322/323 三间特殊宿舍、
     * 每间宿舍 4 名随机姓名示例学生、默认卫生/纪律扣分项目、
     * admin/staff 两个内置账号（密码均先哈希再落库）。
     * @returns {Promise} 默认数据（含哈希）构建完成后 resolve
     */
    function initDatabase() {
        // 先异步计算默认账号密码哈希，确保落库即无明文（admin=admin123 / staff=staff123 / 班级账号=123456）
        return Promise.all([hashPassword('admin123'), hashPassword('staff123'), hashPassword('123456')]).then(function(defaultHashes){
        var floors = [];
        var floorNames = ['一楼','二楼','三楼','四楼','五楼','六楼','七楼','八楼'];
        for (var i = 0; i < 8; i++) floors.push({ id: i+1, name: floorNames[i], sortOrder: i+1 });
        var dormitories = [];
        var dormId = 1;
        floors.forEach(function(f) {
            for (var r = 1; r <= 20; r++) dormitories.push({ id: dormId++, floorId: f.id, roomNumber: String(f.sortOrder*100+r), capacity: 8 });
        });
        var floor7 = floors.find(function(f){return f.name==='七楼';});
        dormitories.push({ id: dormId++, floorId: floor7.id, roomNumber: '723', capacity: 8 });
        var floor3 = floors.find(function(f){return f.name==='三楼';});
        dormitories.push({ id: dormId++, floorId: floor3.id, roomNumber: '322', capacity: 8 });
        dormitories.push({ id: dormId++, floorId: floor3.id, roomNumber: '323', capacity: 8 });

        var surnames = ['张','李','王','赵','钱','孙','周','吴','郑','冯','陈','褚','卫','蒋','沈','韩','杨','朱','秦','尤'];
        var given = ['伟','芳','娜','敏','静','丽','强','磊','军','洋','勇','艳','杰','娟','涛','明','超','霞','平','刚'];
        function genName() { return surnames[Math.floor(Math.random()*surnames.length)] + given[Math.floor(Math.random()*given.length)]; }
        var students = [];
        var stuId = 1;
        dormitories.forEach(function(d) {
            var classNames = ['高一1班','高一2班','高一3班','高二1班','高二2班','高三1班','三1','三2','三3'];
            var cls = classNames[Math.floor(Math.random()*classNames.length)];
            for (var i = 0; i < 4; i++) students.push({ id: stuId++, dormitoryId: d.id, name: genName(), className: cls, bedNumber: String(i+1) });
        });
        var deductionItems = {
            hygiene: [
                { id: 101, name: '地面脏乱', defaultScore: 2 },
                { id: 102, name: '物品摆放不齐', defaultScore: 2 },
                { id: 103, name: '未叠被子', defaultScore: 1 },
                { id: 104, name: '垃圾未倒', defaultScore: 2 }
            ],
            discipline: [
                { id: 201, name: '多人大声讲话', defaultScore: 1 },
                { id: 202, name: '离开宿舍', defaultScore: 1 },
                { id: 203, name: '无请假信息', defaultScore: 1 },
                { id: 204, name: '打铃后在宿舍走动', defaultScore: 1 },
                { id: 205, name: '在阳台上洗漱', defaultScore: 1 }
            ]
        };
        var users = [
            { id: 1, username: 'admin', passwordHash: defaultHashes[0], realName: '管理人员', role: 'ADMIN' },
            { id: 2, username: 'staff', passwordHash: defaultHashes[1], realName: '生活老师', role: 'STAFF' }
        ];
        // 添加31个班级账号
        var nextUserId = 3;
        for (var i = 1; i <= 31; i++) {
            var className = '三' + i;
            users.push({
                id: nextUserId++,
                username: className,
                passwordHash: defaultHashes[2],
                realName: className + '班班主任',
                role: 'CLASS_ADMIN',
                className: className
            });
        }

        var records = [];
        var recId = 1;
        var today = new Date();
        for (var i = 0; i < 50; i++) {
            var dorm = dormitories[Math.floor(Math.random()*dormitories.length)];
            var ds = students.filter(function(s){ return s.dormitoryId===dorm.id; });
            var sid = Math.random()>0.4 ? ds[Math.floor(Math.random()*ds.length)].id : null;
            var hyItem = deductionItems.hygiene[Math.floor(Math.random()*deductionItems.hygiene.length)];
            var disItem = deductionItems.discipline[Math.floor(Math.random()*deductionItems.discipline.length)];
            var rd = new Date(today); rd.setDate(rd.getDate()-Math.floor(Math.random()*30));
            records.push({
                id: recId++, dormitoryId: dorm.id, studentId: sid,
                hygieneItemIds: [hyItem.id], hygieneScore: hyItem.defaultScore,
                disciplineItemIds: [disItem.id], disciplineScore: disItem.defaultScore,
                recordDate: formatLocalDate(rd), remark: ''
            });
        }
        var leaveRecords = [];
        var absenceRecords = [];
        // dormitoryList：系统生效的所有宿舍号（字符串数组），作为宿舍号选择/显示的唯一数据源
        var dormitoryList = dormitories.map(function(d){ return String(d.roomNumber); });
        DB = { floors, dormitories, dormitoryList, students, deductionItems, deductionRecords: records, leaveRecords: leaveRecords, absenceRecords: absenceRecords, users, nextIds: { floor:9, dormitory: dormId, student: stuId, item:300, record: recId, leave:1, absence:1, user: nextUserId } };
        saveDBToLocal();
        });
    }

    // ==================== 本地存储（含压缩回退 + 容量预警） ====================

    var storageWarned = false;
    function getDBByteSize() {
        try { return new Blob([JSON.stringify(DB)]).size; } catch(e) { return 0; }
    }
    function checkStorageWarning() {
        if (storageWarned || !DB) return;
        var size = getDBByteSize();
        if (size > STORAGE_WARN_BYTES) {
            storageWarned = true;
            var mb = (size / 1024 / 1024).toFixed(2);
            console.warn('[存储预警] 本地数据约 ' + mb + 'MB，已接近 localStorage 5MB 上限，建议清理历史记录');
            // 延迟弹出，避开启动加载遮罩
            setTimeout(function () {
                toast('数据量较大（' + mb + 'MB），建议联系管理员清理历史记录', 'error');
            }, 1200);
        }
    }

    /**
     * 从 localStorage 读取并还原数据库到全局 DB。
     * 兼容三种存档：明文 JSON（旧版）、LZC1: 前缀的 lz-string 压缩串；
     * 还原后做结构完整性校验（关键字段齐全才算成功）。
     * @returns {boolean} true=成功载入有效存档；false=无存档/损坏（调用方应 initDatabase）
     */
    function loadDBFromLocal() {
        try {
            var stored = localStorage.getItem(DB_KEY);
            if (!stored) return false;
            var json = null;
            if (stored.charAt(0) === '{' || stored.charAt(0) === '[') {
                json = stored; // 旧格式：明文 JSON
            } else if (stored.indexOf(LOCAL_LZ_PREFIX) === 0) {
                // 新格式：压缩存储（本地空间不足时的回退）
                if (!window.LZString) { console.error('本地数据为压缩格式但 lz-string 未加载'); return false; }
                json = LZString.decompressFromUTF16(stored.slice(LOCAL_LZ_PREFIX.length));
                if (!json) { console.error('本地压缩数据解压失败，数据可能已损坏'); return false; }
            }
            if (json) {
                DB = JSON.parse(json);
                if (DB && DB.users && DB.floors && DB.dormitories && DB.students && DB.deductionItems && DB.deductionRecords && DB.leaveRecords && DB.nextIds) {
                    checkStorageWarning();
                    return true;
                }
            }
        } catch(e) {
            console.error('读取本地数据失败:', e);
        }
        return false;
    }
    /**
     * 将全局 DB 序列化写入 localStorage（同步）。
     * 先写明文 JSON；触发 QuotaExceededError（约 5MB 上限）时自动回退为
     * LZC1: 前缀的 lz-string 压缩存储；压缩仍失败则提示用户清理数据。
     * 注意：本函数只落本地，云端同步由调用方经 saveDB()→syncWithRetry() 触发。
     */
    function saveDBToLocal() {
        var json;
        try {
            json = JSON.stringify(DB);
        } catch(e) { console.error('数据序列化失败:', e); return; }
        try {
            localStorage.setItem(DB_KEY, json);
        } catch(e) {
            // QuotaExceededError：明文超限，回退为压缩存储
            console.warn('本地存储写入失败（空间不足），尝试压缩存储:', e);
            if (!window.LZString) {
                toast('本地存储空间已满，请清理历史记录', 'error');
                return;
            }
            try {
                localStorage.setItem(DB_KEY, LOCAL_LZ_PREFIX + LZString.compressToUTF16(json));
                console.warn('已启用本地压缩存储，建议尽快清理历史记录');
                toast('本地存储空间紧张，已自动压缩存储，建议清理历史记录', 'error');
            } catch(e2) {
                console.error('压缩存储仍失败:', e2);
                toast('本地存储空间已满，请联系管理员清理历史记录', 'error');
            }
        }
    }
    function isValidDB(db) {
        return db && db.users && db.floors && db.dormitories && db.students && db.deductionItems && db.deductionRecords && db.leaveRecords && db.nextIds;
    }

    // ==================== 增量同步：元数据与记录ID ====================
    /**
     * 确保同步所需的元数据字段齐全（幂等，启动/同步/自愈前反复调用安全）。
     * 包含：V2 时代的 syncedRecordIds/deletedRecordIds/dirtyRecordIds、
     * lastSyncTime、数据版本号 syncEpoch、V3 的 dirtyByType/deletedByType
     * （按记录类型分组的脏标记/墓碑）、dormitoryList 权威宿舍名单重建与
     * 一致性修补、退宿停宿旧记录的字段迁移（status/studentId/起止日期）。
     */
    function ensureSyncMeta(){
        if(!DB) return;
        if(!Array.isArray(DB.syncedRecordIds)) DB.syncedRecordIds=[];
        if(!Array.isArray(DB.deletedRecordIds)) DB.deletedRecordIds=[];
        if(!Array.isArray(DB.dirtyRecordIds)) DB.dirtyRecordIds=[];
        if(typeof DB.lastSyncTime!=='number') DB.lastSyncTime=0;
        // 数据版本号（epoch）：管理员"重置云端数据"时递增；本机为 0 表示从未同步过
        if(typeof DB.syncEpoch!=='number') DB.syncEpoch=0;
        // V3 按行存储：按类型分组的脏标记和删除标记
        if(!DB.dirtyByType) DB.dirtyByType = {};
        if(!DB.deletedByType) DB.deletedByType = {};
        V3_RECORD_TYPES.forEach(function(m){
            if(!DB.dirtyByType[m.type]) DB.dirtyByType[m.type] = {};
            if(!DB.deletedByType[m.type]) DB.deletedByType[m.type] = {};
        });
        if(!Array.isArray(DB.absenceRecords)) DB.absenceRecords=[];
        if(!DB.nextIds) DB.nextIds={};
        if(typeof DB.nextIds.absence!=='number') DB.nextIds.absence=1;
        // dormitoryList：生效宿舍号列表；旧数据缺失时从 dormitories 重建
        if(!Array.isArray(DB.dormitoryList) || DB.dormitoryList.length===0){
            DB.dormitoryList = (DB.dormitories||[]).map(function(d){ return String(d.roomNumber); });
        }
        // 兜底：确保 dormitories 中存在但不在 dormitoryList 的历史宿舍不会被误删，
        // 同时移除 dormitoryList 中已不存在于 dormitories 的脏条目
        var existingRooms = {};
        (DB.dormitories||[]).forEach(function(d){ existingRooms[String(d.roomNumber)] = true; });
        DB.dormitoryList = DB.dormitoryList.filter(function(r){ return existingRooms[String(r)]; });
        // 数据一致性修复：所有有学生入住的宿舍号必须在 dormitoryList 中（防止"已删除"误标）
        (DB.students||[]).forEach(function(s){
            if(s.dormitoryId == null) return;
            var d = (DB.dormitories||[]).find(function(x){ return x.id === s.dormitoryId; });
            if(d){
                var rn = String(d.roomNumber);
                if(DB.dormitoryList.indexOf(rn) === -1) DB.dormitoryList.push(rn);
            }
        });
        // 退宿停宿记录字段迁移：补齐 status / studentId / startDate / endDate（兼容历史数据）
        if(Array.isArray(DB.leaveRecords)){
            var todayStr=getTodayLocalStr();
            DB.leaveRecords.forEach(function(r){
                if(!r.status) r.status='approved';            // 旧记录视为已生效
                if(!r.studentId){
                    var m=matchStudentBySnapshot(r.className,r.name,r.dormitory,r.bed);
                    if(m) r.studentId=m.id;
                }
                if(r.type==='stop' && !r.startDate && typeof r.date==='string'){
                    var parts=r.date.split('至');
                    if(parts.length===2){ r.startDate=parts[0].trim(); r.endDate=parts[1].trim(); }
                    else { r.startDate=r.date; r.endDate=r.date; }
                }
                if(r.type==='leave' && !r.startDate){ r.startDate=r.date; r.endDate=r.date; }
            });
        }
    }
    /**
     * 基础数据自愈：楼层/宿舍被历史 bug（云端空数据覆盖本地）意外清空时重建。
     * 自愈逻辑分三步：
     *   1) 楼层为空 → 重建固定 8 层（id/sortOrder 1-8），逐楼层标脏；
     *   2) 宿舍为空 → 优先按 dormitoryList 权威名单恢复宿舍号；名单也空时
     *      按默认结构（每层 20 间 + 723/322/323）重建；宿舍号首位即楼层数；
     *   3) 若楼层经过重建，按宿舍号首位重映射全部宿舍的 floorId 引用。
     * 重建出的记录一律打脏标记，下次同步上传云端补种，其他设备拉取后自动恢复。
     * 安全性前提：楼层/宿舍在 UI 上没有新增入口、也永远不会被整类删除，
     * 因此"数组为空"必然意味着数据损坏，重建不会覆盖任何正常数据。
     * @returns {boolean} true=本次发生了重建（调用方应保存并触发同步）
     */
    function repairBasicData(){
        if(!DB) return false;
        var repaired = false;
        var floorsRepaired = false;
        ensureSyncMeta();
        // 1) 楼层：固定 8 层（id 1-8，与 initDatabase 默认结构一致）
        if(!Array.isArray(DB.floors) || DB.floors.length === 0){
            var floorNames = ['一楼','二楼','三楼','四楼','五楼','六楼','七楼','八楼'];
            DB.floors = [];
            for(var i = 1; i <= 8; i++){
                DB.floors.push({ id: i, name: floorNames[i-1], sortOrder: i });
                v3MarkDirty('floor', i);
            }
            repaired = true;
            floorsRepaired = true;
            console.log('[修复] 楼层数据为空，已重建默认 8 层');
        }
        // 2) 宿舍：优先按 dormitoryList 恢复已有宿舍号；dormitoryList 也为空时按默认结构（每层 20 间 + 723/322/323）
        if(!Array.isArray(DB.dormitories) || DB.dormitories.length === 0){
            var rooms = [];
            if(Array.isArray(DB.dormitoryList) && DB.dormitoryList.length > 0){
                DB.dormitoryList.forEach(function(rn){ rooms.push(String(rn)); });
            } else {
                for(var f = 1; f <= 8; f++){
                    for(var r = 1; r <= 20; r++) rooms.push(String(f * 100 + r));
                }
                rooms.push('723','322','323');
            }
            if(typeof DB.nextIds.dormitory !== 'number' || DB.nextIds.dormitory < 1) DB.nextIds.dormitory = 1;
            DB.dormitories = [];
            rooms.forEach(function(rn){
                if(!/^[1-8][0-9]{2}$/.test(rn)) return;
                var floorNum = parseInt(rn.charAt(0), 10);
                var floor = DB.floors.find(function(fl){ return fl.sortOrder === floorNum; });
                if(!floor) return;
                var newId = DB.nextIds.dormitory++;
                DB.dormitories.push({ id: newId, floorId: floor.id, roomNumber: rn, capacity: 8 });
                v3MarkDirty('dormitory', newId);
            });
            repaired = true;
            console.log('[修复] 宿舍数据为空，已按宿舍号重建 ' + DB.dormitories.length + ' 个宿舍');
        }
        // 3) 楼层重建后，按宿舍号首位重映射宿舍的 floorId 引用
        if(floorsRepaired && Array.isArray(DB.dormitories)){
            DB.dormitories.forEach(function(d){
                var rn = String(d.roomNumber || '');
                if(/^[1-8][0-9]{2}$/.test(rn)){
                    var fl = DB.floors.find(function(f2){ return f2.sortOrder === parseInt(rn.charAt(0), 10); });
                    if(fl) d.floorId = fl.id;
                }
            });
        }
        if(repaired) ensureSyncMeta(); // 重建 dormitoryList
        return repaired;
    }
    // 通过 班级+姓名+宿舍号+床号 快照匹配学生（用于给旧记录补 studentId）
    function matchStudentBySnapshot(className,name,dormitory,bed){
        if(!DB||!Array.isArray(DB.students)) return null;
        return DB.students.find(function(s){
            if(s.className!==className||s.name!==name) return false;
            var d=getDormitoryById(s.dormitoryId);
            if(dormitory && (!d||d.roomNumber!==dormitory)) return false;
            if(bed && String(s.bedNumber)!==String(bed)) return false;
            return true;
        })||null;
    }
    /**
     * 生成全局唯一记录 ID（多设备并发不冲突）。
     * 组成：时间戳(base36) + 设备标识 DEVICE_ID + 随机后缀。
     * 业务记录（扣分/请假/退宿）使用此 ID 方案，而非 nextIds 自增，
     * 从根本上避免多设备离线新建后同步的主键冲突。
     * @returns {string} 如 'lx3k2a-a1b2c3-9f8z'
     */
    function generateRecordId(){
        return Date.now().toString(36)+'-'+DEVICE_ID+'-'+Math.random().toString(36).slice(2,6);
    }

    // 运行时检测到的表结构版本，initializeData 中设置
    var _detectedSchemaVersion = 2;

    /**
     * 按 V3 记录类型从 DB 取出记录数组（同步上传/合并的统一入口）。
     * 特殊处理：meta 类型固定返回一条 {id:'main', dormitoryList, nextIds, epoch}；
     * deduction_item 类型把 {hygiene:[], discipline:[]} 扁平化为带 _subType 的记录列表。
     * @param {string} type - V3_RECORD_TYPES 中的类型名
     * @returns {Array} 该类型的记录数组
     */
    function v3GetRecordsByType(type){
        var meta = V3_RECORD_TYPES.find(function(m){ return m.type === type; });
        if(!meta || !DB) return [];
        if(meta.specialMeta){
            // meta 类型：固定返回一条 {id:'main', data:{...}}，epoch 为数据版本号
            return [{ id: 'main', dormitoryList: DB.dormitoryList || [], nextIds: DB.nextIds || {}, epoch: DB.syncEpoch || 0 }];
        }
        if(meta.specialItems){
            // deductionItems: 扁平化 hygiene + discipline 为独立记录
            var arr = [];
            var hy = (DB.deductionItems&&DB.deductionItems.hygiene)||[];
            var dis = (DB.deductionItems&&DB.deductionItems.discipline)||[];
            hy.forEach(function(x){ arr.push({ _subType:'hygiene', data:x }); });
            dis.forEach(function(x){ arr.push({ _subType:'discipline', data:x }); });
            return arr;
        }
        return (DB[meta.dbPath[0]]) || [];
    }
    // 将一条云端 deduction_item 记录还原到 DB.deductionItems
    function v3RestoreDeductionItem(cloudRow){
        var st = (cloudRow.data && cloudRow.data._subType) || cloudRow._subType;
        if(!DB.deductionItems) DB.deductionItems = { hygiene: [], discipline: [] };
        var target = DB.deductionItems[st] || (st==='discipline' ? DB.deductionItems.discipline : DB.deductionItems.hygiene);
        var itemData = cloudRow.data || cloudRow;
        // 移除辅助字段
        var clean = {};
        Object.keys(itemData).forEach(function(k){ if(k !== '_subType') clean[k] = itemData[k]; });
        // 检查是否已存在（同 id）
        var idx = target.findIndex(function(x){ return String(x.id) === String(clean.id); });
        if(idx >= 0) target[idx] = clean;
        else target.push(clean);
    }

    // 脏标记：按 type 分组存储 DB.dirtyByType[type] = { recordId: true, ... }
    // 删除标记（墓碑）：按 type 分组存储 DB.deletedByType[type] = { recordId: true, ... }
    // 同步流程：syncToCloudV3 只上传脏记录与墓碑行；上传成功后清除对应标记；
    //           loadFromCloudV3 按 updated_at 合并活记录、按墓碑删除本地记录。
    /**
     * 把一条记录标记为「脏」（有本地新增/修改，待上传云端）。
     * @param {string} type - V3 记录类型（如 'student' / 'deduction_record'）
     * @param {number|string} recordId - 记录 ID
     */
    function v3MarkDirty(type, recordId){
        if(!DB) return;
        if(!DB.dirtyByType) DB.dirtyByType = {};
        if(!DB.dirtyByType[type]) DB.dirtyByType[type] = {};
        DB.dirtyByType[type][String(recordId)] = true;
    }
    /**
     * 把一条记录标记为「已删除」（墓碑，待上传云端通知其他设备删除）。
     * 同时清除其脏标记，避免"删除"与"修改"两类标记冲突。
     * @param {string} type - V3 记录类型
     * @param {number|string} recordId - 被删除记录的 ID
     */
    function v3MarkDeleted(type, recordId){
        if(!DB) return;
        if(!DB.deletedByType) DB.deletedByType = {};
        if(!DB.deletedByType[type]) DB.deletedByType[type] = {};
        DB.deletedByType[type][String(recordId)] = true;
        // 已删除的记录同时从 dirty 标记中移除（避免删除标记和脏标记冲突）
        if(DB.dirtyByType && DB.dirtyByType[type]){
            delete DB.dirtyByType[type][String(recordId)];
        }
    }
    function v3IsDirty(type, recordId){
        return DB && DB.dirtyByType && DB.dirtyByType[type] && DB.dirtyByType[type][String(recordId)];
    }
    function v3IsDeleted(type, recordId){
        return DB && DB.deletedByType && DB.deletedByType[type] && DB.deletedByType[type][String(recordId)];
    }
    // 将本地某类型的所有现有记录标记为脏（用于云端缺失该类型数据时的补种上传）
    function v3MarkTypeDirty(type){
        if(!DB) return 0;
        var meta = V3_RECORD_TYPES.find(function(m){ return m.type === type; });
        if(!meta) return 0;
        ensureSyncMeta();
        var count = 0;
        if(meta.specialMeta){
            // meta 类型：固定 id='main'
            v3MarkDirty('meta', 'main');
            return 1;
        }
        if(meta.specialItems){
            // deductionItems：扁平化 hygiene + discipline
            var hy = (DB.deductionItems&&DB.deductionItems.hygiene)||[];
            var dis = (DB.deductionItems&&DB.deductionItems.discipline)||[];
            hy.forEach(function(x){ if(x && x.id!=null){ v3MarkDirty('deduction_item', x.id); count++; } });
            dis.forEach(function(x){ if(x && x.id!=null){ v3MarkDirty('deduction_item', x.id); count++; } });
            return count;
        }
        // 普通数组类型
        var arr = DB[meta.dbPath[0]] || [];
        arr.forEach(function(x){ if(x && x[meta.idField]!=null){ v3MarkDirty(meta.type, x[meta.idField]); count++; } });
        return count;
    }
    /**
     * V2→V3 首次升级后，把本地全部已有记录标记为脏，触发一次全量上传。
     * 原因：V2 整库压缩架构下的记录没有 V3 脏标记，不标脏则 syncToCloudV3
     * 不会上传它们，会导致云端 V3 表数据缺失。
     */
    function v3MarkAllLocalDirty(){
        if(!DB) return;
        var count = 0;
        V3_RECORD_TYPES.forEach(function(meta){
            count += v3MarkTypeDirty(meta.type);
        });
        if(count > 0){
            console.log('[V3] 首次升级：已将本地 '+count+' 条记录标记为脏，等待全量上传');
        }
    }


// ---- shared globals explicitly mounted on window ----
window.DB = DB;
window.storageWarned = storageWarned;
window._detectedSchemaVersion = _detectedSchemaVersion;
window.hashPassword = hashPassword;
window.migrateUserPasswords = migrateUserPasswords;
window.formatLocalDate = formatLocalDate;
window.getTodayLocalStr = getTodayLocalStr;
