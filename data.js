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
 *   constants.js：DB_KEY / DEVICE_ID / LOCAL_LZ_PREFIX / STORAGE_WARN_BYTES /
 *              V3_RECORD_TYPES / V3_BASIC_TYPES 等常量；
 *   utils.js：formatLocalDate / getTodayLocalStr / roundScore1 /
 *              formatScoreText / formatStudentBedName 等工具函数；
 *   app.js：currentUser（当前登录用户，权限判断用）；
 *   第三方：window.LZString（压缩）、window.crypto.subtle（哈希）。
 *
 * 对外暴露（函数声明在 classic script 中天然全局，另在文件末尾
 *           显式挂载 window 的有：hashPassword / migrateUserPasswords /
 *           formatLocalDate / getTodayLocalStr / roundScore1 等函数引用；
 *           DB 等可变状态不再在本文件挂载 window.DB，改由 sync.js
 *           initializeData 在 DB 就绪后挂载以保证指向最新实例）。
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

    // 日期工具函数 formatLocalDate / getTodayLocalStr 已迁移至 utils.js

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
     * 查询某宿舍的全部在住学生（不含已退宿/走读），并按床号升序排序。
     *
     * 排序效果（一处改，全局生效）：
     *   - 宿舍成员列表（住宿信息页）按床号 1、2、3… 升序显示；
     *   - 调换床位后（如 3 号床 → 7 号床），刷新页面即按新床号重新排序；
     *   - 扣分登记页的扣分对象芯片、异常上报学生下拉、调宿弹层等
     *     所有依赖本函数的位置一并生效；
     *   - 无需修改其他函数（renderHierarchyView、renderAddView、buildAnomalyStudentForm 等），
     *     它们都调用本函数，排序逻辑集中在此。
     *
     * 归一化规则：床号归一化为数字；空/无效值排到最后（按 999 处理）；
     *   床号相同时（异常数据）按姓名中文排序，保证结果稳定。
     * @param {number} dormitoryId - 宿舍 ID
     * @returns {Array} 学生对象数组（按床号升序，床号 bedNumber 为字符串 '1'-'8'）
     */
    function getStudentsByDormitory(dormitoryId) {
        if (!DB || !DB.students) return [];
        var list = DB.students.filter(function(s) { return s.dormitoryId === dormitoryId; });
        list.sort(function(a, b) {
            // 床号归一化为数字：空/无效值排到最后
            var ba = (a.bedNumber !== null && a.bedNumber !== undefined && String(a.bedNumber).trim() !== '')
                ? parseInt(a.bedNumber, 10) : 999;
            var bb = (b.bedNumber !== null && b.bedNumber !== undefined && String(b.bedNumber).trim() !== '')
                ? parseInt(b.bedNumber, 10) : 999;
            if (isNaN(ba)) ba = 999;
            if (isNaN(bb)) bb = 999;
            // 主要排序：床号从小到大
            if (ba !== bb) return ba - bb;
            // 次要排序：床号相同时（异常数据）按姓名中文排序，保证结果稳定
            return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
        });
        return list;
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

    // 分数工具 roundScore1 / formatScoreText 已迁移至 utils.js

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
        return roundScore1(total);
    }

    /**
     * 按 ID 查询扣分项目（在卫生项与纪律项两个数组中共同查找）。
     * @param {number} id - 项目 ID（卫生项 1xx，纪律项 2xx）
     * @returns {{id:number,name:string,defaultScore:number}|null}
     */
    function getItemById(id) {
        if (!DB || !DB.deductionItems) return null;
        var allItems = (DB.deductionItems.hygiene || []).concat(DB.deductionItems.discipline || []);
        // 用 String 比较：复选框 value 恒为字符串，云端历史数据 id 也可能是字符串，
        // 严格相等 === 会导致数字 1 与字符串 "1" 匹配失败而返回 null（合计漏算该项）
        return allItems.find(function(item) { return String(item.id) === String(id); }) || null;
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

    /**
     * 按 ID 查询加分项目（在卫生加分项与纪律加分项两个数组中共同查找）。
     * @param {number} id - 项目 ID
     * @returns {{id:number,name:string,defaultScore:number}|null}
     */
    function getBonusItemById(id) {
        if (!DB || !DB.deductionItems) return null;
        var allBonus = (DB.deductionItems.hygieneBonus || []).concat(DB.deductionItems.disciplineBonus || []);
        // 同 getItemById：String 比较，兼容数字/字符串两种 id 形态
        return allBonus.find(function(item) { return String(item.id) === String(id); }) || null;
    }
    /**
     * 获取加分项目名称；自定义项取冒号后文本。
     */
    function getBonusItemNameByIdOrCustom(id) {
        if (typeof id === 'string' && id.startsWith('custom:')) return id.substring(7);
        var item = getBonusItemById(id);
        return item ? item.name : '';
    }

    /**
     * 计算一组记录的累计加分（recordMode==='bonus' 的记录，卫生分 + 纪律分）。
     * @param {Array} records
     * @returns {number} 总加分（保留 1 位小数）
     */
    function getTotalBonusScore(records) {
        if (!records) return 0;
        var total = 0;
        records.forEach(function(r) {
            if (r.recordMode === 'bonus') {
                total += (r.hygieneScore || 0) + (r.disciplineScore || 0);
            }
        });
        return roundScore1(total);
    }

    /**
     * 计算一组记录的累计扣分（recordMode!='bonus' 的记录，即扣分模式记录）。
     * @param {Array} records
     * @returns {number} 总扣分（保留 1 位小数）
     */
    function getTotalDeductScore(records) {
        if (!records) return 0;
        var total = 0;
        records.forEach(function(r) {
            if (r.recordMode !== 'bonus') {
                total += (r.hygieneScore || 0) + (r.disciplineScore || 0);
            }
        });
        return roundScore1(total);
    }

    /**
     * 计算净分（新口径·符号版本 2）= 扣分 + 加分。
     * 底层扣分记录为负数、加分记录为正数，直接相加即为净分；
     * 返回值：负数=净扣、正数=净加、0=持平。
     * @param {Array} records
     * @returns {number}
     */
    function getNetScore(records) {
        // 新口径：扣分为负、加分为正，净分 = 扣分 + 加分
        return roundScore1(getTotalDeductScore(records) + getTotalBonusScore(records));
    }

    /**
     * 计算一组记录中，仅"宿舍集体记录"（studentId === null）的净分。
     * 用途：宿舍徽章、楼层徽章、宿舍统计卡、统计报表排名等"宿舍/楼层层面"的分数显示。
     * 目的：把个人加减分（如"宿舍集体加分触发每人 +1"）排除在宿舍总分数之外，
     *       使宿舍层面的分数只反映"集体加减分"。
     * 说明：个人记录（studentId != null）不参与本函数计算，只体现到 getStudentNetScore。
     * @param {Array} records - 某宿舍/某楼层的全部记录
     * @returns {number} 净分（扣分总和 − 加分总和，保留 1 位小数）
     */
    function getDormCollectiveNetScore(records) {
        if (!records) return 0;
        var collective = records.filter(function(r){ return r.studentId === null || r.studentId === undefined; });
        return getNetScore(collective);
    }

    /**
     * 计算宿舍/楼层汇总净分（用于树导航徽章、宿舍页统计卡、统计报表排行等）。
     * 规则：
     *   - 计入：宿舍集体记录（studentId === null）+ 个人直接记录（autoDerived 不为 true）
     *   - 排除：集体加分派生的个人记录（autoDerived === true），避免"一次集体加分被算成
     *     多人加分之和 + 集体本身"的重复累加问题。
     *   - 与 getStudentNetScore（个人净分）区别：个人净分包含所有个人记录（含派生），
     *     而宿舍汇总分排除派生记录。
     * @param {Array} records - 某宿舍/某楼层的全部记录
     * @returns {number} 净分（保留 1 位小数）
     */
    function getDormSummaryNetScore(records) {
        if (!records) return 0;
        var summaryRecords = records.filter(function(r){ return r && r.autoDerived !== true; });
        return getNetScore(summaryRecords);
    }

    /**
     * 【历史数据迁移】识别旧版加分模式下"集体加分派生的个人记录"，并补上 autoDerived: true。
     *
     * 背景：旧版 submitDeductionImpl 在加分模式下，为宿舍每个学生各生成一条个人加分记录，
     * 但当时没有 autoDerived 标记。新版需要这些记录被识别为"派生"，不计入宿舍汇总分。
     *
     * 保守判断规则（同时满足全部条件才标记）：
     *   1) recordMode === 'bonus'（加分记录）
     *   2) studentId != null（个人记录）
     *   3) 该宿舍同一天存在一条"宿舍集体加分记录"（studentId === null && recordMode === 'bonus'）
     *   4) 该个人记录的 createdAt 与集体加分记录的 createdAt 相差 ≤ 5000 毫秒（同一操作派生）
     *   5) 该个人记录尚未被标记过 autoDerived
     *
     * 宁可漏判（个别旧记录仍会被算入宿舍汇总）也绝不误判（不会把老师手动给某学生加的分误标）。
     * 幂等：重复执行不会重复标记。
     * @returns {number} 本次新标记的记录数
     */
    function migrateDerivedDeductionRecords() {
        if (!DB || !Array.isArray(DB.deductionRecords)) return 0;
        var allRecords = DB.deductionRecords;
        var marked = 0;
        // 先收集所有"集体加分记录"作为基准（studentId === null && recordMode === 'bonus'）
        var collectiveBonusByKey = {}; // key = dormitoryId + '|' + recordDate → [record, ...]
        allRecords.forEach(function(r){
            if (!r) return;
            if (r.studentId !== null && r.studentId !== undefined) return;
            if (r.recordMode !== 'bonus') return;
            if (!r.dormitoryId || !r.recordDate) return;
            var key = String(r.dormitoryId) + '|' + String(r.recordDate);
            if (!collectiveBonusByKey[key]) collectiveBonusByKey[key] = [];
            collectiveBonusByKey[key].push(r);
        });
        // 遍历所有记录，识别派生个人记录
        allRecords.forEach(function(r){
            if (!r) return;
            if (r.autoDerived === true) return; // 已标记过，跳过
            if (r.recordMode !== 'bonus') return; // 只处理加分
            if (r.studentId === null || r.studentId === undefined) return; // 只处理个人记录
            if (!r.dormitoryId || !r.recordDate || !r.createdAt) return;
            var key = String(r.dormitoryId) + '|' + String(r.recordDate);
            var collectiveList = collectiveBonusByKey[key];
            if (!collectiveList || collectiveList.length === 0) return; // 该宿舍当天没有集体加分
            // 检查是否有集体加分的 createdAt 与本记录相差 ≤ 5000 毫秒
            var isDerived = collectiveList.some(function(c){
                if (!c.createdAt) return false;
                return Math.abs(r.createdAt - c.createdAt) <= 5000;
            });
            if (isDerived) {
                r.autoDerived = true;
                r.lastModified = Date.now();
                v3MarkDirty('deduction_record', r.id); // 打脏标记，让云端和其他设备同步到新字段
                marked++;
            }
        });
        if (marked > 0) {
            console.log('[派生迁移] 已标记 ' + marked + ' 条历史派生记录（autoDerived=true）');
            saveDBToLocal();
        }
        return marked;
    }

    /**
     * 迁移历史「个人记录」（含个人直接登记 + 集体派生个人）的分值，折算为 ±1。
     * 集体记录本身（studentId=null）不迁移，保持原值。
     * 判定条件（同时满足）：
     *   1) studentId != null（个人记录，含派生）
     *   2) scoreMigratedV2 !== true（尚未迁移，幂等）
     *   3) 存在需要折算的分值
     * 折算规则：扣分侧记 -1、加分侧记 +1；无项目记 0。
     * @returns {number} 迁移条数
     */
    function migratePersonalScores() {
        if (!DB || !Array.isArray(DB.deductionRecords)) return 0;
        var migrated = 0;
        DB.deductionRecords.forEach(function(r) {
            if (!r) return;
            // 只处理个人记录（含派生）；集体记录本身 studentId=null 跳过
            if (r.studentId === null || r.studentId === undefined) return;
            if (r.scoreMigratedV2 === true) return;

            var isBonus = (r.recordMode === 'bonus');
            var hy = Number(r.hygieneScore) || 0;
            var dis = Number(r.disciplineScore) || 0;
            var targetHy = isBonus ? 1 : -1;
            var targetDis = isBonus ? 1 : -1;
            var needHy = (hy !== 0 && hy !== targetHy);
            var needDis = (dis !== 0 && dis !== targetDis);
            if (!needHy && !needDis) {
                r.scoreMigratedV2 = true;
                return;
            }
            var hyIds = Array.isArray(r.hygieneItemIds) ? r.hygieneItemIds : [];
            var disIds = Array.isArray(r.disciplineItemIds) ? r.disciplineItemIds : [];
            if (needHy) {
                r.hygieneScore = (hyIds.length > 0) ? targetHy : 0;
            }
            if (needDis) {
                r.disciplineScore = (disIds.length > 0) ? targetDis : 0;
            }
            r.scoreMigratedV2 = true;
            r.lastModified = Date.now();
            v3MarkDirty('deduction_record', r.id);
            migrated++;
        });
        if (migrated > 0) {
            console.log('[分数折算迁移] 已将 ' + migrated + ' 条历史个人记录折算为 ±1');
            saveDBToLocal();
        }
        return migrated;
    }

    /**
     * 迁移：为历史"宿舍集体扣分/加分记录"补齐缺失的派生个人记录。
     *
     * 背景：早期版本的集体扣分/加分没有为每个学生派生个人记录，
     * 导致个人净分算不到这些记录，数据管理页查询也对不上。
     *
     * 迁移规则（严格遵循，避免误伤）：
     *   1) 只处理 studentId === null 的宿舍集体记录；
     *   2) 只对"当前在住学生"补派生（系统未存历史住宿快照，无法回溯当时在住学生）；
     *   3) 幂等：已存在匹配的派生记录时跳过；
     *   4) 派生记录的 createdAt 与集体记录一致（保证 findDerivedRecords 的
     *      5000ms 时间容差能识别，级联删除时能一并清除）；
     *   5) 分值按现有规则折算：集体有分则派生侧记 1 分，否则 0 分。
     *
     * @returns {number} 本次新补的派生记录数
     */
    function migrateMissingDerivedRecords() {
        if (!DB || !Array.isArray(DB.deductionRecords)) return 0;
        var created = 0;
        // 先收集所有集体记录（studentId 为 null 且非派生）
        var collectiveRecords = DB.deductionRecords.filter(function(r){
            return r && r.studentId == null && r.autoDerived !== true;
        });
        if (collectiveRecords.length === 0) return 0;
        collectiveRecords.forEach(function(parent){
            if (!parent.dormitoryId || !parent.recordDate) return;
            var parentTime = parent.createdAt || 0;
            // 取该宿舍当前在住学生
            var students = getStudentsByDormitory(parent.dormitoryId);
            if (!students || students.length === 0) return;
            students.forEach(function(stu){
                // 二次校验：学生当前必须确实住在本宿舍（防止历史迁移误派生）
                var currentStu = getStudentById(stu.id);
                if(!currentStu || String(currentStu.dormitoryId) !== String(parent.dormitoryId)) return;
                // 幂等检查：是否已存在匹配的派生记录
                var exists = DB.deductionRecords.some(function(r){
                    if (!r || r.autoDerived !== true) return false;
                    if (String(r.studentId) !== String(stu.id)) return false;
                    if (String(r.dormitoryId) !== String(parent.dormitoryId)) return false;
                    if (r.recordDate !== parent.recordDate) return false;
                    if ((r.recordMode || 'deduct') !== (parent.recordMode || 'deduct')) return false;
                    if (parentTime > 0 && Math.abs((r.createdAt || 0) - parentTime) > 5000) return false;
                    return true;
                });
                if (exists) return; // 已存在，跳过
                // 创建派生记录
                // 新口径（符号版本 2）：按「非零」判定有无分值，并按 recordMode 赋符号：
                // 扣分派生 -1、加分派生 +1（旧口径按 >0 判定，扣分翻转后会漏判）
                var parentIsBonus = (parent.recordMode === 'bonus');
                var perHyScore = (parent.hygieneScore || 0) !== 0 ? (parentIsBonus ? 1 : -1) : 0;
                var perDisScore = (parent.disciplineScore || 0) !== 0 ? (parentIsBonus ? 1 : -1) : 0;
                var newRec = {
                    id: generateRecordId(),
                    createdAt: parentTime || Date.now(),
                    lastModified: Date.now(),
                    dormitoryId: parent.dormitoryId,
                    studentId: stu.id,
                    hygieneItemIds: (parent.hygieneItemIds || []).slice(),
                    hygieneScore: perHyScore,
                    disciplineItemIds: (parent.disciplineItemIds || []).slice(),
                    disciplineScore: perDisScore,
                    recordDate: parent.recordDate,
                    remark: parent.remark || '',
                    recordMode: parent.recordMode || 'deduct',
                    autoDerived: true
                };
                DB.deductionRecords.push(newRec);
                v3MarkDirty('deduction_record', newRec.id);
                created++;
            });
        });
        if (created > 0) {
            console.log('[派生迁移·补齐] 为历史集体记录补建 ' + created + ' 条派生个人记录');
            saveDBToLocal();
        }
        return created;
    }

    /**
     * 计算指定学生的个人累计净分（新口径·符号版本 2）。
     * 底层统一口径：扣分记录分值为负数、加分记录分值为正数，
     * 直接累加每条个人记录的卫生分 + 纪律分即为个人净分，显示层不再取反。
     * 返回值：负数 = 净扣分，正数 = 净加分，0 = 净分为 0。
     * 只统计个人记录（r.studentId 严格等于 studentId），宿舍集体记录（studentId=null）不在此函数计算。
     * @param {number|string} studentId - 学生 ID
     * @returns {number} 个人净分（新口径）
     */
    function getStudentNetScore(studentId) {
        if (!DB || !Array.isArray(DB.deductionRecords) || studentId == null) return 0;
        var total = 0;
        DB.deductionRecords.forEach(function(r) {
            if (!r || String(r.studentId) !== String(studentId)) return;
            // 底层已是新口径：扣分负数、加分正数，直接累加即为净分
            total += (r.hygieneScore || 0);
            total += (r.disciplineScore || 0);
        });
        return roundScore1(total);
    }

    /**
     * 计算某宿舍的累计净分（新口径·符号版本 2）。
     * 算法：该宿舍所有在住学生的个人净分之和。
     * 符号口径：与 getStudentNetScore 一致（负数=净扣、正数=净加、0=净分为 0）。
     *   负数 → 扣分（红色）；正数 → 加分（绿色）。
     * @param {number} dormitoryId - 宿舍 ID
     * @param {string} [classNameFilter] - 可选，仅统计指定班级的学生（班级账号用）
     * @returns {number} 累计净分（新口径）
     */
    function getDormCumulativeNetScore(dormitoryId, classNameFilter) {
        if (!DB || dormitoryId == null) return 0;
        var students = getStudentsByDormitory(dormitoryId);
        if (classNameFilter) {
            students = students.filter(function(s){ return s.className === classNameFilter; });
        }
        var total = 0;
        students.forEach(function(s){ total += getStudentNetScore(s.id); });
        return roundScore1(total);
    }

    /**
     * 计算某楼层的累计净分（新口径·符号版本 2）。
     * 算法：该楼层所有宿舍在住学生的个人净分之和。
     * 符号口径：与 getStudentNetScore 一致（负数=净扣、正数=净加、0=净分为 0）。
     *   负数 → 扣分（红色）；正数 → 加分（绿色）。
     * @param {number} floorId - 楼层 ID
     * @param {string} [classNameFilter] - 可选，仅统计指定班级的学生（班级账号用）
     * @returns {number} 累计净分（新口径）
     */
    function getFloorCumulativeNetScore(floorId, classNameFilter) {
        if (!DB || floorId == null) return 0;
        var floors = DB.floors || [];
        var floor = floors.find(function(f){ return f.id === floorId; });
        if (!floor) return 0;
        var total = 0;
        (DB.students || []).forEach(function(s){
            if (s.dormitoryId == null) return;
            var dorm = getDormitoryById(s.dormitoryId);
            if (!dorm || dorm.floorId !== floorId) return;
            if (classNameFilter && s.className !== classNameFilter) return;
            total += getStudentNetScore(s.id);
        });
        return roundScore1(total);
    }

    /**
     * 查找某条"宿舍集体记录"所派生的全部个人记录（用于级联删除）。
     * 判定规则（5 个条件同时满足）：
     *   1. 同 dormitoryId；2. 同 recordDate；3. 同 recordMode；
     *   4. autoDerived === true；5. createdAt 与集体记录相差 ≤ 5000 毫秒。
     * 若传入的记录不是"宿舍集体记录"（studentId 非 null），返回空数组。
     * @param {object} parentRecord - 一条宿舍集体扣分/加分记录
     * @returns {Array} 其派生的个人记录数组（可能为空）
     */
    function findDerivedRecords(parentRecord) {
        if (!parentRecord || parentRecord.studentId != null) return [];
        if (parentRecord.autoDerived === true) return [];
        if (!DB || !Array.isArray(DB.deductionRecords)) return [];
        var parentTime = parentRecord.createdAt || 0;
        return DB.deductionRecords.filter(function(r) {
            if (!r || r.autoDerived !== true) return false;
            if (r.studentId == null) return false;
            if (String(r.dormitoryId) !== String(parentRecord.dormitoryId)) return false;
            if (r.recordDate !== parentRecord.recordDate) return false;
            if ((r.recordMode || 'deduct') !== (parentRecord.recordMode || 'deduct')) return false;
            // 时间接近：同一次提交派生（5000ms 容差，与 migrateDerivedDeductionRecords 一致）
            if (parentTime > 0) {
                var childTime = r.createdAt || 0;
                if (Math.abs(childTime - parentTime) > 5000) return false;
            }
            return true;
        });
    }

    /**
     * 按班级名查询班主任账号（role='CLASS_ADMIN'）ID。
     * 兼容历史数据：早期班级账号无 className 字段、以 username 存班级名。
     * @param {string} className - 班级名称
     * @returns {number|string|null} 班主任用户 ID；未找到返回 null
     */
    function getClassAdminUserId(className) {
        if (!DB || !Array.isArray(DB.users) || className == null || className === '') return null;
        var target = String(className).trim();
        // 1. 精确匹配 className 或 username
        var u = DB.users.find(function(x) {
            return x && x.role === 'CLASS_ADMIN' && (String(x.className || '').trim() === target || String(x.username || '').trim() === target);
        });
        if (u) return u.id;
        // 2. 模糊匹配：去除"班"字后比对（兼容 "三1" 与 "三1班" 写法不一致的情况）
        var cleanTarget = target.replace(/班/g, '');
        var u2 = DB.users.find(function(x) {
            if (!x || x.role !== 'CLASS_ADMIN') return false;
            var xClass = String(x.className || x.username || '').trim().replace(/班/g, '');
            return xClass === cleanTarget;
        });
        return u2 ? u2.id : null;
    }

    /**
     * 判断当前时段应显示卫生类还是纪律类加/扣分项。
     * 管理员不受限制（始终返回 'both'）。
     * 生活老师按账号配置的时段规则判断。
     * @param {object} user - 当前登录用户
     * @returns {'hygiene'|'discipline'|'both'} 当前应显示的类别
     */
    function getCurrentTimeCategory(user) {
        if (!user || user.role === 'ADMIN') return 'both';
        // 非生活老师不受时段限制
        if (user.role !== 'STAFF') return 'both';
        // 时段限制关闭时同时显示
        if (user.enableTimeLimit === false) return 'both';
        var hyStart = (typeof user.hygieneStartHour === 'number') ? user.hygieneStartHour : 5;
        var hyEnd = (typeof user.hygieneEndHour === 'number') ? user.hygieneEndHour : 15;
        var hour = new Date().getHours();
        if (hour >= hyStart && hour < hyEnd) return 'hygiene';
        return 'discipline';
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

    // formatStudentBedName 已迁移至 utils.js

    /**
     * 判断一条扣分记录是否存在"学生当前宿舍与记录宿舍不一致"的错误。
     * 用于显示层的红色警告标记，提醒管理员排查。
     * 判定规则（任一不满足即返回 false）：
     *   1) 记录必须有 studentId（个人记录；集体记录不判定）；
     *   2) 记录必须有 dormitoryId；
     *   3) studentId 能查到学生对象；
     *   4) 学生当前有 dormitoryId；
     *   5) String(student.dormitoryId) !== String(record.dormitoryId) 时返回 true。
     * @param {object} record - 扣分记录对象
     * @returns {boolean} true=存在不一致（需标红警告）
     */
    function isRecordDormMismatch(record){
        if(!record || record.studentId == null || record.dormitoryId == null) return false;
        var stu = getStudentById(record.studentId);
        if(!stu || stu.dormitoryId == null) return false;
        return String(stu.dormitoryId) !== String(record.dormitoryId);
    }

    /**
     * 判断一条请假/退宿/停宿记录是否存在"学生当前宿舍与记录宿舍不一致"的错误。
     * 与 isRecordDormMismatch 判定规则一致，只是字段取值方式相同：
     * leaveRecords/absenceRecords 同样含 studentId 与 dormitoryId/dormitory 快照。
     * 说明：走读生（学生当前无宿舍）不参与判定（不存在宿舍错位）。
     * @param {object} record - 请假/退宿/停宿记录对象
     * @returns {boolean} true=存在不一致
     */
    function isLeaveRecordDormMismatch(record){
        if(!record || record.studentId == null) return false;
        var stu = getStudentById(record.studentId);
        // 学生已删除、或学生当前无宿舍（走读生）→ 不判定
        if(!stu || stu.dormitoryId == null) return false;
        // 记录侧优先用 dormitoryId；无 dormitoryId 时用宿舍号字符串反查
        var recDormId = record.dormitoryId;
        if(recDormId == null && record.dormitory){
            var d = getDormitoryByRoomNumber(record.dormitory);
            if(d) recDormId = d.id;
        }
        if(recDormId == null) return false;
        return String(stu.dormitoryId) !== String(recDormId);
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

    // ==================== 生活老师楼层分工（assignedFloors） ====================
    /**
     * 判断当前用户是否为生活老师（STAFF）。
     * @returns {boolean}
     */
    function isStaff() {
        return !!(currentUser && currentUser.role === 'STAFF');
    }
    /**
     * 取指定用户可见的楼层 ID 列表（楼层分工过滤的唯一入口）。
     * 规则：ADMIN 全部楼层；STAFF 按 user.assignedFloors 过滤，
     * assignedFloors 为空/未配置时视为负责全部楼层；CLASS_ADMIN 返回全部
     * （班级范围由 getClassDormIds 另行过滤）。
     * @param {{role:string,assignedFloors?:number[]}} [user] - 用户对象，缺省取 currentUser
     * @returns {number[]} 楼层 ID 数组（如 [1,2,3,4]）
     */
    function getAssignedFloorIds(user) {
        user = user || currentUser;
        var all = (DB && DB.floors ? DB.floors : []).map(function(f){ return f.id; });
        if (user && user.role === 'STAFF' && Array.isArray(user.assignedFloors) && user.assignedFloors.length > 0) {
            var set = {};
            user.assignedFloors.forEach(function(fid){ set[fid] = true; });
            return all.filter(function(fid){ return set[fid]; });
        }
        return all;
    }
    /**
     * 取指定用户可见的楼层对象列表（按 sortOrder 升序）。
     * @param {object} [user] - 用户对象，缺省取 currentUser
     * @returns {Array<{id:number,name:string,sortOrder:number}>}
     */
    function getAssignedFloors(user) {
        var idSet = {};
        getAssignedFloorIds(user).forEach(function(id){ idSet[id] = true; });
        return (DB && DB.floors ? DB.floors : []).filter(function(f){ return idSet[f.id]; })
            .sort(function(a,b){ return (a.sortOrder||0) - (b.sortOrder||0); });
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
     * 按 username 去重账号：同一用户名保留 id 最小（最早创建）的一条，
     * 多余的打 V3 墓碑并从 DB.users 移除。
     * 背景：跨设备同步场景下，ensureCorrectUsers 与 V3 合并各自按 id/username
     * 单方面判断，可能产生两个同名不同 id 的账号，导致登录歧义与统计混乱。
     * 去重策略跨设备确定性一致（永远保留最小 id），各设备收敛到同一条记录。
     * 若当前登录会话恰好是被移除的重复账号，自动切换到保留记录（同名账号）。
     * 幂等：无重复时零副作用。
     * @returns {number} 清理的重复账号数
     */
    function dedupeUsersByUsername() {
        if (!DB || !Array.isArray(DB.users) || DB.users.length === 0) return 0;
        var seen = {};   // username -> 保留的用户记录
        var kept = [];
        var removedIds = {};
        var removed = 0;
        // 按 id 升序遍历，保证"保留最小 id"规则确定性生效
        DB.users.slice().sort(function(a, b) { return (a && a.id || 0) - (b && b.id || 0); }).forEach(function(u) {
            if (!u || !u.username) { kept.push(u); return; } // 异常数据不处理
            if (seen[u.username]) {
                removed++;
                removedIds[String(u.id)] = true;
                v3MarkDeleted('user', u.id); // 打墓碑通知其他设备删除同 id 重复行
                return;
            }
            seen[u.username] = u;
            kept.push(u);
        });
        if (removed === 0) return 0;
        DB.users = kept;
        // 当前登录账号若为被移除的重复账号：指向保留记录（同名），保持会话有效
        try {
            if (typeof currentUser !== 'undefined' && currentUser && removedIds[String(currentUser.id)]) {
                var keeper = seen[currentUser.username];
                if (keeper) {
                    Object.keys(currentUser).forEach(function(k){ delete currentUser[k]; });
                    Object.keys(keeper).forEach(function(k){ currentUser[k] = keeper[k]; });
                    sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
                }
            }
        } catch(e) { /* 会话缓存修复失败不影响去重结果 */ }
        saveDBToLocal();
        console.log('[账号去重] 清理重复账号 ' + removed + ' 个');
        return removed;
    }

    /**
     * 按「班级 + 姓名」去重学生：同一班级同名视为同一人，保留 id 最小
     * （最早创建）的一条，多余的打 V3 墓碑并从 DB.students 移除。
     *
     * 背景：历史版本曾经存在"同班同名重复学生"导致名单膨胀的灾难场景。
     * 当前新增/导入入口已封死（studentAlreadyExists 校验），但云端历史数据
     * 中可能残留重复行，需要通过本函数在拉取合并后自动收敛。
     *
     * 收敛策略：
     *   - 主控设备执行后打墓碑并上传云端 → 云端一次收敛，其他设备下次拉取即同步；
     *   - 非主控设备执行后本地已去重，但基础数据不上传（被 syncToCloudV3 拦截），
     *     下次 loadFromCloudV3 会重新拉下云端活行再次出现重复行，
     *     故本函数需在每次 ensureCorrectUsers 中反复执行，保证本地显示始终干净。
     *
     * 去重策略跨设备确定性一致（永远保留最小 id），各设备最终收敛到同一条。
     * 幂等：无重复时零副作用。
     * @returns {number} 清理的重复学生数
     */
    function dedupeStudentsByClassAndName() {
        if (!DB || !Array.isArray(DB.students) || DB.students.length === 0) return 0;
        // 按 id 升序遍历，保证"保留最小 id"规则确定性生效
        var sorted = DB.students.slice().sort(function(a, b) {
            return ((a && a.id) || 0) - ((b && b.id) || 0);
        });
        var seen = {};       // key = className + '\u0001' + name
        var kept = [];
        var removed = 0;
        sorted.forEach(function(s) {
            if (!s) { kept.push(s); return; }
            var cls = String(s.className || '').trim();
            var nm = String(s.name || '').trim();
            // 姓名或班级为空的记录不参与去重（避免误删异常数据）
            if (!cls || !nm) { kept.push(s); return; }
            var key = cls + '\u0001' + nm;
            if (seen[key]) {
                removed++;
                v3MarkDeleted('student', s.id); // 打墓碑通知其他设备删除同 id 重复行
                return;
            }
            seen[key] = s;
            kept.push(s);
        });
        if (removed === 0) return 0;
        DB.students = kept;
        saveDBToLocal();
        console.log('[学生去重] 清理同班同名重复学生 ' + removed + ' 名');
        return removed;
    }

    /**
     * 确保内置账号齐全（幂等，应用启动与云端重置后都会调用）。
     * 保证存在：admin/管理员（ADMIN，密码 admin123）、staff/总生活老师
     * （STAFF，密码 staff123，负责全部楼层）、staff1（STAFF，密码 123456，
     * 负责 1-4 楼）、staff2（STAFF，密码 123456，负责 5-8 楼）、
     * 三1～三31 共 31 个班级账号（CLASS_ADMIN，密码 123456）。
     * staff1/staff2 已存在时跳过创建，仅补齐缺失的 assignedFloors/buildingName
     * 字段（不覆盖管理员后续在"楼层分配管理"中的调整）。
     * @returns {Promise} 账号补齐完成后 resolve
     */
    function ensureCorrectUsers() {
        if (!DB || !DB.users) return Promise.resolve();
        // 先按 username 去重：跨设备同步可能产生同名不同 id 账号，
        // 不先去重会让下方"是否已存在"判断命中任一副本，重复行长期残留
        dedupeUsersByUsername();
        // 【P2】学生名单去重自愈：云端历史数据可能残留"同班同名"重复学生，
        // 在每次账号校准前先清理，防止名单被云端活行重复拉取而无限膨胀。
        // 主控设备执行后打墓碑上传云端（一次收敛）；非主控设备本地临时去重。
        dedupeStudentsByClassAndName();
        var adminExists = false, staffExists = false;
        for (var i = 0; i < DB.users.length; i++) {
            if (DB.users[i].username === 'admin') { DB.users[i].role = 'ADMIN'; DB.users[i].realName = '管理人员'; adminExists = true; }
            if (DB.users[i].username === 'staff') {
                DB.users[i].role = 'STAFF'; DB.users[i].realName = '生活老师'; staffExists = true;
                // staff 为"总生活老师"：assignedFloors 为空数组即代表负责全部楼层
                if(!Array.isArray(DB.users[i].assignedFloors)) DB.users[i].assignedFloors = [];
            }
        }
        // 巡查楼层分工预设：staff1 负责 1-4 楼、staff2 负责 5-8 楼
        var presetStaff = [
            { username: 'staff1', realName: '生活老师（1-4楼）', floors: [1,2,3,4], buildingName: '恩泽楼' },
            { username: 'staff2', realName: '生活老师（5-8楼）', floors: [5,6,7,8], buildingName: '恩泽楼' }
        ];
        var missingStaff = [];
        presetStaff.forEach(function(p){
            var u = DB.users.find(function(x){ return x.username === p.username; });
            if(!u){ missingStaff.push(p); return; }
            // 已存在：仅补齐缺失字段，不覆盖管理员后续的楼层/楼栋调整
            var changed = false;
            if(u.role !== 'STAFF'){ u.role = 'STAFF'; changed = true; }
            if(!Array.isArray(u.assignedFloors)){ u.assignedFloors = p.floors.slice(); changed = true; }
            if(!u.buildingName){ u.buildingName = p.buildingName; changed = true; }
            if(changed) v3MarkDirty('user', u.id);
        });
        // 先收集缺失账号，统一异步计算密码哈希后再创建（确保落库即无明文）
        var missingClasses = [];
        for (var i = 1; i <= 31; i++) {
            var className = '三' + i;
            if (!DB.users.some(function(u) { return u.username === className; })) missingClasses.push(className);
        }
        var needAdmin = !adminExists, needStaff = !staffExists;
        if (!needAdmin && !needStaff && missingClasses.length === 0 && missingStaff.length === 0) {
            _ensureCorrectUsersFinish();
            return Promise.resolve();
        }
        var hashes = {};
        var jobs = [];
        if (needAdmin) jobs.push(hashPassword('admin123').then(function(h){ hashes.admin = h; }));
        if (needStaff) jobs.push(hashPassword('staff123').then(function(h){ hashes.staff = h; }));
        if (missingClasses.length > 0 || missingStaff.length > 0) jobs.push(hashPassword('123456').then(function(h){ hashes.pwd123 = h; }));
        return Promise.all(jobs).then(function(){
            if (needAdmin) { var u1={ id: DB.nextIds.user++, username: 'admin', passwordHash: hashes.admin, realName: '管理人员', role: 'ADMIN' }; DB.users.push(u1); v3MarkDirty('user', u1.id); }
            if (needStaff) { var u2={ id: DB.nextIds.user++, username: 'staff', passwordHash: hashes.staff, realName: '生活老师', role: 'STAFF', assignedFloors: [] }; DB.users.push(u2); v3MarkDirty('user', u2.id); }

            // 补充31个班级账号（如果缺失）
            missingClasses.forEach(function(className){
                var u3 = {
                    id: DB.nextIds.user++,
                    username: className,
                    passwordHash: hashes.pwd123,
                    realName: className + '班班主任',
                    role: 'CLASS_ADMIN',
                    className: className
                };
                DB.users.push(u3);
                v3MarkDirty('user', u3.id);
            });
            // 补充巡查分工生活老师账号（staff1/staff2）
            missingStaff.forEach(function(p){
                var u4 = {
                    id: DB.nextIds.user++,
                    username: p.username,
                    passwordHash: hashes.pwd123,
                    realName: p.realName,
                    role: 'STAFF',
                    assignedFloors: p.floors.slice(),
                    buildingName: p.buildingName
                };
                DB.users.push(u4);
                v3MarkDirty('user', u4.id);
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

    // 站内通知默认模板常量 DEFAULT_NOTIFICATION_TEMPLATES 已迁移至 constants.js

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

        // 新库不生成任何示例学生：本地数据为空时，用户登录后应从云端拉取真实数据；
        // 云端也为空时页面显示空列表，由管理员维护。示例数据曾导致"本地缓存被清 → 显示
        // 假数据 → 误以为真实数据 → 主控设备标脏上传污染云端"的严重事故，故彻底移除。
        var students = [];
        var stuId = 1;
        // 新口径（符号版本 2）：扣分项目默认分为【负数】，加分项目默认分为【正数】
        var deductionItems = {
            hygiene: [
                { id: 101, name: '没拖地', defaultScore: -0.2 },
                { id: 102, name: '厕所脏', defaultScore: -0.2 },
                { id: 103, name: '没倒垃圾', defaultScore: -0.2 },
                { id: 104, name: '洗漱台脏', defaultScore: -0.2 },
                { id: 105, name: '没关电器', defaultScore: -0.2 },
                { id: 106, name: '被子没叠', defaultScore: -0.2 },
                { id: 107, name: '厕所有杂物', defaultScore: -0.2 },
                { id: 108, name: '鞋摆不规范', defaultScore: -0.2 },
                { id: 109, name: '蚊帐没拉链', defaultScore: -0.2 },
                { id: 110, name: '床上有杂物', defaultScore: -0.2 },
                { id: 111, name: '空床有杂物', defaultScore: -0.2 },
                { id: 112, name: '阳台地面脏', defaultScore: -0.2 }
            ],
            discipline: [
                { id: 201, name: '讲话', defaultScore: -1 },
                { id: 202, name: '走动', defaultScore: -1 },
                { id: 203, name: '孖铺', defaultScore: -1 },
                { id: 204, name: '串宿舍', defaultScore: -1 },
                { id: 205, name: '纪律不好', defaultScore: -1 },
                { id: 206, name: '多人讲话吵闹', defaultScore: -1 },
                { id: 207, name: '带炒粉炒面等食物进宿舍', defaultScore: -1 }
            ],
            hygieneBonus: [
                { id: 301, name: '卫生优秀', defaultScore: 0.2 }
            ],
            disciplineBonus: [
                { id: 401, name: '表现良好', defaultScore: 1 }
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

        // 新库不生成任何示例扣分记录：理由同上（与示例学生一并移除）。
        var records = [];
        var recId = 1;
        var leaveRecords = [];
        var absenceRecords = [];
        // dormitoryList：系统生效的所有宿舍号（字符串数组），作为宿舍号选择/显示的唯一数据源
        var dormitoryList = dormitories.map(function(d){ return String(d.roomNumber); });
        // 巡查核实模块三张表（V3 业务记录，默认空数组）：
        // inspectionConfirmations 巡查确认 / anomalyReports 异常上报 / dailyInspectionSummaries 每日晚检总结
        var inspectionConfirmations = [];
        var anomalyReports = [];
        var dailyInspectionSummaries = [];
        // 站内通知子系统：notifications 业务通知（默认空）；notificationTemplates 由管理员统一维护，
        // 新库预置 DEFAULT_NOTIFICATION_TEMPLATES 13 条默认模板（逐项浅拷贝，勿与常量共享对象引用），
        // 后续以云端为权威
        var notifications = [];
        var notificationTemplates = DEFAULT_NOTIFICATION_TEMPLATES.map(function(t){ return Object.assign({}, t); });
        var floorChangeRequests = [];
        DB = { scoreSignVersion: SCORE_SIGN_VERSION, floors, dormitories, dormitoryList, students, deductionItems, deductionRecords: records, leaveRecords: leaveRecords, absenceRecords: absenceRecords, inspectionConfirmations: inspectionConfirmations, anomalyReports: anomalyReports, dailyInspectionSummaries: dailyInspectionSummaries, notifications: notifications, notificationTemplates: notificationTemplates, floorChangeRequests: floorChangeRequests, users, masterBindHash: '', nextIds: { floor:9, dormitory: dormId, student: stuId, item:300, record: recId, leave:1, absence:1, user: nextUserId, confirmation:1, anomaly:1, summary:1 } };
        saveDBToLocal();
        });
    }

    /**
     * 构造一个"空数据库"（不是默认数据库）。
     * 用于"绑定主控设备"场景：清空本地全部业务数据，但保留必需的空结构，
     * 让后续的 loadFromCloud 能从云端拉取一份完整数据填充进来。
     * 与 initDatabase 的区别：initDatabase 会生成默认学生/账号/项目等示例数据，
     * 本函数生成的是"完全空、等待云端填充"的空壳。
     * @returns {void}
     */
    function initEmptyDB() {
        DB = {
            // 空壳本身不含分数数据，版本号直接取最新；随后以云端整体重建为准
            // （hardResetFromCloud 通过符号健康检查后会再次收敛该字段）。
            scoreSignVersion: SCORE_SIGN_VERSION,
            floors: [],
            dormitories: [],
            dormitoryList: [],
            students: [],
            users: [],
            deductionItems: { hygiene: [], discipline: [], hygieneBonus: [], disciplineBonus: [] },
            deductionRecords: [],
            leaveRecords: [],
            absenceRecords: [],
            inspectionConfirmations: [],
            anomalyReports: [],
            dailyInspectionSummaries: [],
            notifications: [],
            notificationTemplates: [],
            floorChangeRequests: [],
            nextIds: {
                floor: 1, dormitory: 1, student: 1, item: 300, record: 1,
                leave: 1, absence: 1, user: 1, confirmation: 1, anomaly: 1, summary: 1
            },
            syncEpoch: 0,
            masterBindHash: '',
            lastSyncTime: 0,
            dirtyByType: {},
            deletedByType: {},
            syncedRecordIds: [],
            deletedRecordIds: [],
            dirtyRecordIds: []
        };
        // 补齐 V3 各类型的空脏标记桶，避免同步流程访问 undefined
        if(typeof V3_RECORD_TYPES !== 'undefined'){
            V3_RECORD_TYPES.forEach(function(m){
                if(!DB.dirtyByType[m.type]) DB.dirtyByType[m.type] = {};
                if(!DB.deletedByType[m.type]) DB.deletedByType[m.type] = {};
            });
        }
        saveDBToLocal();
        console.log('[绑定主控] 已构造空数据库，等待从云端拉取完整数据');
    }

    // ==================== 本地存储（含压缩回退 + 容量预警） ====================

    var storageWarned = false;
    var autoCompressDone = false; // 本会话是否已完成"明文→压缩"主动转换（防止重复 toast）
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
                    // 迁移：确保加分项数组存在（旧库升级）
                    if(!DB.deductionItems.hygieneBonus) DB.deductionItems.hygieneBonus = [];
                    if(!DB.deductionItems.disciplineBonus) DB.deductionItems.disciplineBonus = [];
                    // 迁移：确保已有扣分记录有 recordMode 字段（默认 'deduct'）
                    if(Array.isArray(DB.deductionRecords)){
                        DB.deductionRecords.forEach(function(r){ if(!r.recordMode) r.recordMode='deduct'; });
                    }
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
     * 写入策略：明文体积超过 3MB（STORAGE_AUTO_COMPRESS_BYTES）或 forceCompress=true
     * 时直接写 LZC1: 前缀的 lz-string 压缩串（让压缩态在后续写入中保持，避免下次
     * 明文写入又退回明文挤占配额）；否则先写明文 JSON，触发 QuotaExceededError
     * （约 5MB 上限）时同样自动回退为压缩存储；压缩仍失败则提示用户清理数据。
     * 注意：本函数只落本地，云端同步由调用方经 saveDB()→syncWithRetry() 触发。
     * @param {boolean} [forceCompress] true=强制压缩写入（供 maintainLocalStorage 主动转换）
     */
    function saveDBToLocal(forceCompress) {
        var json;
        try {
            json = JSON.stringify(DB);
        } catch(e) { console.error('数据序列化失败:', e); return; }
        // 主动压缩路径：大容量库或显式要求时，直接写压缩格式
        var byteSize = 0;
        try { byteSize = new Blob([json]).size; } catch(e) { byteSize = json.length; }
        if ((forceCompress || byteSize > STORAGE_AUTO_COMPRESS_BYTES) && window.LZString) {
            try {
                localStorage.setItem(DB_KEY, LOCAL_LZ_PREFIX + LZString.compressToUTF16(json));
                if (forceCompress) console.log('[存储] 已主动切换为压缩存储');
                return;
            } catch(ce) {
                // 主动压缩写入失败（罕见）：回落尝试明文 + 配额回退链路
                console.warn('主动压缩写入失败，改试明文存储:', ce);
            }
        }
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
        // 分数符号版本号：缺失字段的旧库一律视为版本 1（旧口径：扣分正、加分正），
        // 由主控设备 initializeData 检测后调用 migrateScoreSign() 翻转至 SCORE_SIGN_VERSION
        if(typeof DB.scoreSignVersion !== 'number') DB.scoreSignVersion = 1;
        // V3 按行存储：按类型分组的脏标记和删除标记
        if(!DB.dirtyByType) DB.dirtyByType = {};
        if(!DB.deletedByType) DB.deletedByType = {};
        V3_RECORD_TYPES.forEach(function(m){
            if(!DB.dirtyByType[m.type]) DB.dirtyByType[m.type] = {};
            if(!DB.deletedByType[m.type]) DB.deletedByType[m.type] = {};
        });
        // masterBindHash：主控绑定密码哈希（云端 meta 字段，首次由管理员设置）；旧库无此字段时补齐空串
        if(typeof DB.masterBindHash !== 'string') DB.masterBindHash='';
        if(!Array.isArray(DB.absenceRecords)) DB.absenceRecords=[];
        // 站内通知子系统：旧版本地存档缺少两表时补齐空数组（模板由云端权威数据回填）
        if(!Array.isArray(DB.notifications)) DB.notifications=[];
        if(!Array.isArray(DB.notificationTemplates)) DB.notificationTemplates=[];
        if(!Array.isArray(DB.floorChangeRequests)) DB.floorChangeRequests=[];
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
     * 本地存储容量维护（幂等安全；每次启动由 initializeData 显式调用一次）：
     *   1) 错误日志 dorm_error_logs：剔除 time 超过 30 天的条目，并只保留最近 20 条；
     *   2) 本地备份 dormitory_system_backup：本就只保留 1 份（每次写入直接覆盖），无需处理；
     *   3) 明文 DB 体积超过 3MB 时，主动调 saveDBToLocal() 转为压缩存储，
     *      并 toast「本地数据较大，已自动压缩存储」（压缩态不重复提示）。
     * 三段逻辑各自 try-catch 隔离，任何一步失败都不影响其余功能。
     */
    function maintainLocalStorage(){
        if(!DB) return;
        // ---- 1) 错误日志：超 30 天剔除 + 最多保留最近 20 条 ----
        try {
            var mlErrorKey = 'dorm_error_logs';
            var rawLogs = localStorage.getItem(mlErrorKey);
            if(rawLogs){
                var logs = [];
                try { logs = JSON.parse(rawLogs) || []; } catch(e) { logs = []; }
                if(Array.isArray(logs) && logs.length){
                    var logCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
                    var getLogTime = function(entry){
                        return entry && entry.time ? new Date(entry.time).getTime() : NaN;
                    };
                    var keptLogs = [];
                    logs.forEach(function(entry){
                        if(!entry) return;
                        var t = getLogTime(entry);
                        // time 无法解析的旧条目保留（宁可多留，不误删）
                        if(isNaN(t) || t >= logCutoff) keptLogs.push(entry);
                    });
                    // 按时间倒序（新→旧），无法解析时间的排末尾，再截断为 20 条
                    keptLogs.sort(function(a,b){
                        var ta = getLogTime(a), tb = getLogTime(b);
                        if(isNaN(ta) && isNaN(tb)) return 0;
                        if(isNaN(ta)) return 1;
                        if(isNaN(tb)) return -1;
                        return tb - ta;
                    });
                    if(keptLogs.length > 20) keptLogs = keptLogs.slice(0, 20);
                    if(keptLogs.length !== logs.length){
                        localStorage.setItem(mlErrorKey, JSON.stringify(keptLogs));
                    }
                }
            }
        } catch(e) { console.warn('[存储维护] 错误日志清理失败:', e); }
        // ---- 2) 本地备份 dormitory_system_backup 始终只保留 1 份（写入前直接覆盖），无需额外操作 ----
        // ---- 3) 大容量明文存档：主动转压缩 ----
        try {
            if(!autoCompressDone && getDBByteSize() > STORAGE_AUTO_COMPRESS_BYTES){
                var stored = localStorage.getItem(DB_KEY);
                // 仅当前为明文 JSON（首字符 '{'）时才需转换；LZC1: 压缩态/无存档不处理
                if(stored && stored.charAt(0) === '{' && window.LZString){
                    saveDBToLocal(true);
                    autoCompressDone = true;
                    // 延迟弹出，避开启动加载遮罩
                    setTimeout(function(){ toast('本地数据较大，已自动压缩存储'); }, 800);
                }
            }
        } catch(e) { console.warn('[存储维护] 主动压缩失败:', e); }
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
        // 4) 巡查核实模块：旧版本地存档缺少三张表时补齐空数组（不覆盖已有数据）
        ['inspectionConfirmations','anomalyReports','dailyInspectionSummaries'].forEach(function(k){
            if(!Array.isArray(DB[k])){ DB[k] = []; repaired = true; }
        });
        // 5) 站内通知子系统：通知与模板两表缺失时同样补齐空数组（不覆盖已有数据）
        ['notifications','notificationTemplates','floorChangeRequests'].forEach(function(k){
            if(!Array.isArray(DB[k])){ DB[k] = []; repaired = true; }
        });
        // nextIds 同步补齐巡查模块键位
        if(DB.nextIds){
            ['confirmation','anomaly','summary'].forEach(function(k){
                if(typeof DB.nextIds[k] !== 'number') DB.nextIds[k] = 1;
            });
        }
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
            return [{ id: 'main', dormitoryList: DB.dormitoryList || [], nextIds: DB.nextIds || {}, epoch: DB.syncEpoch || 0, masterBindHash: DB.masterBindHash || '' }];
        }
        if(meta.specialItems){
            // deductionItems: 扁平化 hygiene + discipline + hygieneBonus + disciplineBonus 为独立记录
            var arr = [];
            var hy = (DB.deductionItems&&DB.deductionItems.hygiene)||[];
            var dis = (DB.deductionItems&&DB.deductionItems.discipline)||[];
            var hyB = (DB.deductionItems&&DB.deductionItems.hygieneBonus)||[];
            var disB = (DB.deductionItems&&DB.deductionItems.disciplineBonus)||[];
            hy.forEach(function(x){ arr.push({ _subType:'hygiene', data:x }); });
            dis.forEach(function(x){ arr.push({ _subType:'discipline', data:x }); });
            hyB.forEach(function(x){ arr.push({ _subType:'hygieneBonus', data:x }); });
            disB.forEach(function(x){ arr.push({ _subType:'disciplineBonus', data:x }); });
            return arr;
        }
        return (DB[meta.dbPath[0]]) || [];
    }
    // 将一条云端 deduction_item 记录还原到 DB.deductionItems
    function v3RestoreDeductionItem(cloudRow){
        var st = (cloudRow.data && cloudRow.data._subType) || cloudRow._subType;
        if(!DB.deductionItems) DB.deductionItems = { hygiene: [], discipline: [], hygieneBonus: [], disciplineBonus: [] };
        if(!DB.deductionItems.hygieneBonus) DB.deductionItems.hygieneBonus = [];
        if(!DB.deductionItems.disciplineBonus) DB.deductionItems.disciplineBonus = [];
        var target = DB.deductionItems[st];
        if(!target){
            // 未知 subType 回退到 hygiene（兼容旧数据）
            target = DB.deductionItems.hygiene;
        }
        var itemData = cloudRow.data || cloudRow;
        // 移除辅助字段
        var clean = {};
        Object.keys(itemData).forEach(function(k){ if(k !== '_subType') clean[k] = itemData[k]; });
        // id 归一化：云端还原的扣分项目 id 必须为数字型（防御 JSONB/历史数据存成字符串）
        if(typeof clean.id === 'string' && /^\d+$/.test(clean.id)) clean.id = parseInt(clean.id, 10);
        // 检查是否已存在（同 id）
        var idx = target.findIndex(function(x){ return String(x.id) === String(clean.id); });
        if(idx >= 0) target[idx] = clean;
        else target.push(clean);
    }

    // 脏标记：按 type 分组存储 DB.dirtyByType[type] = { recordId: true, ... }
    // 删除标记（墓碑）：DB.deletedByType[type] = { recordId: { ts: 打标时间ms }, ... }
    //                   （历史旧形态为 recordId: true，读取处两种形态均兼容）
    // 同步流程：syncToCloudV3 只上传脏记录与墓碑行；上传成功后清除脏标记，
    //           墓碑仅清理旧布尔形态与超过 7 天的条目（7 天内持续重广播）；
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
     * 墓碑值记录打标时间 {ts: Date.now()}，供上传成功后按 7 天保留期清理；
     * 同时清除其脏标记，避免"删除"与"修改"两类标记冲突。
     * @param {string} type - V3 记录类型
     * @param {number|string} recordId - 被删除记录的 ID
     */
    function v3MarkDeleted(type, recordId){
        if(!DB) return;
        if(!DB.deletedByType) DB.deletedByType = {};
        if(!DB.deletedByType[type]) DB.deletedByType[type] = {};
        DB.deletedByType[type][String(recordId)] = { ts: Date.now() };
        // 已删除的记录同时从 dirty 标记中移除（避免删除标记和脏标记冲突）
        if(DB.dirtyByType && DB.dirtyByType[type]){
            delete DB.dirtyByType[type][String(recordId)];
        }
    }
    function v3IsDirty(type, recordId){
        return DB && DB.dirtyByType && DB.dirtyByType[type] && DB.dirtyByType[type][String(recordId)];
    }
    function v3IsDeleted(type, recordId){
        var v = DB && DB.deletedByType && DB.deletedByType[type] && DB.deletedByType[type][String(recordId)];
        // 兼容两种墓碑形态：旧版布尔 true / 新版 {ts:number}，统一归一为布尔
        return !!v;
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
            // deductionItems：扁平化 hygiene + discipline + hygieneBonus + disciplineBonus
            var hy = (DB.deductionItems&&DB.deductionItems.hygiene)||[];
            var dis = (DB.deductionItems&&DB.deductionItems.discipline)||[];
            var hyB = (DB.deductionItems&&DB.deductionItems.hygieneBonus)||[];
            var disB = (DB.deductionItems&&DB.deductionItems.disciplineBonus)||[];
            hy.forEach(function(x){ if(x && x.id!=null){ v3MarkDirty('deduction_item', x.id); count++; } });
            dis.forEach(function(x){ if(x && x.id!=null){ v3MarkDirty('deduction_item', x.id); count++; } });
            hyB.forEach(function(x){ if(x && x.id!=null){ v3MarkDirty('deduction_item', x.id); count++; } });
            disB.forEach(function(x){ if(x && x.id!=null){ v3MarkDirty('deduction_item', x.id); count++; } });
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


    // ==================== 巡查核实模块：数据查询与统计 ====================
    // 三类巡查对象的中文类型标签（recordType 取值）：
    //   leave=退宿、stop=停宿（来自 leaveRecords，待审核 pending）；absence=请假（来自 absenceRecords）
    var INSPECTION_TYPE_LABELS = { leave: '退宿', stop: '停宿', absence: '请假' };

    /**
     * 判断某条请假/停宿记录是否覆盖某个"晚检晚上"。
     * 规则：开始日 8:00 开始；endDate=startDate 时次日 3:00 结束；
     *       endDate>startDate 时 endDate 当天 7:00 结束（学生早上回校）。
     * @param {string} startDate - 开始日期 YYYY-MM-DD
     * @param {string} endDate   - 结束日期 YYYY-MM-DD（为空视为与 startDate 相同）
     * @param {string} nightDate - 待判断的"晚检晚上"日期 YYYY-MM-DD
     * @returns {boolean}
     */
    function leaveCoversNight(startDate, endDate, nightDate){
        if(!startDate || !nightDate) return false;
        if(!endDate) endDate = startDate;
        if(nightDate < startDate) return false;
        if(nightDate > endDate) return false;
        // 结束日当天晚上不算覆盖（学生早上已回校）；单日请假例外（这一晚整晚请假）
        if(nightDate === endDate && endDate !== startDate) return false;
        return true;
    }
    /**
     * 判断一条请假/退宿/停宿记录的日期区间是否覆盖指定日期的晚检。
     * 有 startDate/endDate 时按 leaveCoversNight 判断；否则回退为 date 字段单日判断。
     * @param {object} r - 记录（含 startDate/endDate 或 date，YYYY-MM-DD）
     * @param {string} date - 目标日期 YYYY-MM-DD
     * @returns {boolean}
     */
    function recordCoversDate(r, date){
        if(!r) return false;
        if(r.startDate && r.endDate) return leaveCoversNight(r.startDate || r.date, r.endDate || r.date, date);
        return (r.date || r.startDate) === date;
    }
    // 取学生所在宿舍 ID（studentId 可能缺失/学生已删除，返回 null）
    function _studentDormitoryId(studentId){
        var stu = studentId ? getStudentById(studentId) : null;
        return stu ? stu.dormitoryId : null;
    }
    /**
     * 解析一条请假/退宿/异常记录所属楼层 ID（巡查核实楼层归属的唯一入口）。
     * 优先规则：
     *   1) 记录关联了学生（studentId 可查到学生）：
     *        - 学生当前有宿舍 → 用学生当前宿舍的楼层；
     *        - 学生当前无宿舍（走读生）→ 返回 null（走读生不进巡查核实）；
     *   2) 学生已被删除 → 用记录里的 dormitoryId 或宿舍号字符串兜底；
     *   3) 都查不到 → 返回 null。
     * @param {number|string} dormitoryId - 记录里保存的宿舍 ID（历史快照）
     * @param {string} roomNumber - 记录里保存的宿舍号字符串（历史快照）
     * @param {number|string} [studentId] - 记录关联的学生 ID（可选；有则以学生当前宿舍为准）
     * @returns {number|null} 楼层 ID；无法解析返回 null
     */
    function resolveRecordFloorId(dormitoryId, roomNumber, studentId){
        // 1) 有学生 → 以学生当前宿舍为准
        if(studentId != null){
            var stu = getStudentById(studentId);
            if(stu){
                // 走读生（当前无宿舍）：返回 null，不进入巡查核实
                if(stu.dormitoryId == null) return null;
                var stuDorm = getDormitoryById(stu.dormitoryId);
                return stuDorm ? stuDorm.floorId : null;
            }
            // 学生已被删除 → 继续走下面的兜底
        }
        // 2) 记录里的 dormitoryId（历史快照兜底）
        var dorm = dormitoryId ? getDormitoryById(dormitoryId) : null;
        if(dorm) return dorm.floorId;
        // 3) 记录里的宿舍号字符串（历史快照兜底）
        if(roomNumber){
            var dorm2 = getDormitoryByRoomNumber(roomNumber);
            if(dorm2) return dorm2.floorId;
        }
        // 4) 无法解析
        return null;
    }
    /**
     * 查询某日、指定楼层范围内的待巡查核实学生列表。
     * 来源：leaveRecords 中状态为 pending（待审核）的退宿/停宿记录 +
     * absenceRecords 中覆盖该日的请假记录；均要求日期区间覆盖 date 且
     * 宿舍楼层落在 floorIds 内。
     * @param {string} date - 巡查日期 YYYY-MM-DD
     * @param {number[]} floorIds - 可见楼层 ID 列表
     * @returns {Array} 巡查项列表（含 recordType/recordId/学生与宿舍快照）
     */
    function getInspectionItems(date, floorIds){
        if(!DB) return [];
        var fset = {};
        (floorIds || []).forEach(function(f){ fset[f] = true; });
        function inScope(dormitoryId, room, studentId){
            var fid = resolveRecordFloorId(dormitoryId, room, studentId);
            return fid != null && fset[fid];
        }
        function dormRoomOf(dormitoryId, fallbackRoom, studentId){
            // 优先：学生当前宿舍号
            if(studentId != null){
                var stu = getStudentById(studentId);
                if(stu && stu.dormitoryId != null){
                    var sd = getDormitoryById(stu.dormitoryId);
                    if(sd) return sd.roomNumber;
                }
                // 学生已删除或当前无宿舍 → 走兜底
            }
            if(fallbackRoom) return fallbackRoom;
            var dorm = dormitoryId ? getDormitoryById(dormitoryId) : null;
            return dorm ? dorm.roomNumber : '';
        }
        var items = [];
        // 1) 退宿/停宿（待审核）
        (DB.leaveRecords || []).forEach(function(r){
            if(r.status !== 'pending') return;
            if(!recordCoversDate(r, date)) return;
            var stuDormId = _studentDormitoryId(r.studentId);
            if(!inScope(stuDormId, r.dormitory, r.studentId)) return;
            items.push({
                recordType: r.type === 'stop' ? 'stop' : 'leave',
                recordId: r.id, studentId: r.studentId || null, dormitoryId: stuDormId,
                room: dormRoomOf(stuDormId, r.dormitory, r.studentId), name: r.name, className: r.className,
                bed: r.bed, startDate: r.startDate || r.date, endDate: r.endDate || r.date, reason: r.reason
            });
        });
        // 2) 请假（absence 记录登记即生效，巡查时同样需核实到人）
        (DB.absenceRecords || []).forEach(function(r){
            if(r.status === 'cancelled') return;   // 已取消的记录不参与巡查核实
            if(!recordCoversDate(r, date)) return;
            var stuDormId = _studentDormitoryId(r.studentId);
            if(!inScope(stuDormId, r.dormitory, r.studentId)) return;
            items.push({
                recordType: 'absence', recordId: r.id, studentId: r.studentId || null, dormitoryId: stuDormId,
                room: dormRoomOf(stuDormId, r.dormitory, r.studentId), name: r.name, className: r.className,
                bed: r.bed, startDate: r.startDate, endDate: r.endDate, reason: r.reason
            });
        });
        return items;
    }
    /**
     * 查找某条巡查记录在某日的确认记录（同一 recordType+recordId+confirmDate 唯一）。
     * @returns {object|null} 确认记录；未确认返回 null
     */
    function getInspectionConfirmation(recordType, recordId, date){
        if(!DB || !Array.isArray(DB.inspectionConfirmations)) return null;
        return DB.inspectionConfirmations.find(function(c){
            return c.recordType === recordType && String(c.recordId) === String(recordId) && c.confirmDate === date;
        }) || null;
    }
    /**
     * 查询某日、指定楼层范围内的异常上报列表（按上报时间倒序）。
     * @param {string} date - 巡查日期
     * @param {number[]} floorIds - 可见楼层 ID 列表
     * @returns {Array} anomalyReports 记录
     */
    function getInspectionAnomalies(date, floorIds){
        if(!DB || !Array.isArray(DB.anomalyReports)) return [];
        var fset = {};
        (floorIds || []).forEach(function(f){ fset[f] = true; });
        return DB.anomalyReports.filter(function(a){
            if(a.reportDate !== date) return false;
            var fid = resolveRecordFloorId(a.dormitoryId, a.dormitoryRoom, a.studentId);
            return fid != null && fset[fid];
        }).sort(function(a,b){ return (b.createdAt||0) - (a.createdAt||0); });
    }
    /**
     * 判断某条异常上报对应的学生，在指定日期是否有一条"覆盖当晚"的请假记录。
     * 优先按 studentId 匹配；无 studentId 时按 姓名+班级 兜底匹配。
     * @param {object} anomaly - anomalyReports 中的记录
     * @param {string} date - YYYY-MM-DD
     * @returns {boolean}
     */
    function _studentHasAbsenceOnDate(anomaly, date){
        if(!DB || !Array.isArray(DB.absenceRecords) || !anomaly) return false;
        var sid = anomaly.studentId;
        var name = anomaly.studentName;
        var cls = anomaly.className;
        return DB.absenceRecords.some(function(r){
            var start = r.startDate || r.date;
            var end = r.endDate || start;
            if(!leaveCoversNight(start, end, date)) return false;
            if(sid && r.studentId) return String(r.studentId) === String(sid);
            if(name && r.name === name && (!cls || r.className === cls)) return true;
            return false;
        });
    }
    /**
     * 计算某日晚检总结数据（纯统计，不落库）。
     * 口径：
     *   totalStudents 入宿人数 = 住本用户负责楼层宿舍的学生数；
     *   absenceCount  当天请假 = absenceRecords 覆盖当日且在范围内；
     *   leavePendingCount 退宿/停宿中 = leaveRecords 已审核通过或待审核（pending）且覆盖当日；
     *   pickedUpCount 家长接走 = 当日 picked_up 异常上报；
     *   anomalyCount  无假条   = 当日 no_note 异常上报；
     *   actualCount   实到人数 = 入宿 - 请假 - 退宿/停宿中 - 家长接走 - 无假条（无假条=学生不在宿舍且无请假登记，属缺宿，计入减项）。
     * @param {string} date - 总结日期 YYYY-MM-DD
     * @param {object} [user] - 用户对象，缺省取 currentUser
     * @returns {object} 总结数据对象（详情列表含姓名/班级/床号等快照）
     */
    function computeInspectionSummary(date, user){
        user = user || currentUser;
        var floorIds = getAssignedFloorIds(user);
        var fset = {};
        floorIds.forEach(function(f){ fset[f] = true; });
        function inScope(dormitoryId, room, studentId){
            var fid = resolveRecordFloorId(dormitoryId, room, studentId);
            return fid != null && fset[fid];
        }
        // 入宿人数
        var totalStudents = (DB.students || []).filter(function(s){
            if(!s.dormitoryId) return false;
            var dorm = getDormitoryById(s.dormitoryId);
            return dorm && fset[dorm.floorId];
        }).length;
        // 当天请假（排除已取消记录）
        var absenceRecs = (DB.absenceRecords || []).filter(function(r){
            if(r.status === 'cancelled') return false;
            return recordCoversDate(r, date) && inScope(_studentDormitoryId(r.studentId), r.dormitory, r.studentId);
        });
        // 退宿/停宿中（已审核通过或待审核 pending，且覆盖当日）
        var leaveRecs = (DB.leaveRecords || []).filter(function(r){
            return (r.status === 'approved' || r.status === 'pending') && recordCoversDate(r, date) && inScope(_studentDormitoryId(r.studentId), r.dormitory, r.studentId);
        });
        // 异常上报
        var anomalies = getInspectionAnomalies(date, floorIds);
        var picked = anomalies.filter(function(a){ return a.anomalyType === 'picked_up'; });
        var noNoteAll = anomalies.filter(function(a){ return a.anomalyType === 'no_note'; });
        // 无假条去重：如果该学生当天有覆盖当天的请假记录，则不算无假条（以请假为准）
        var noNoteEffective = noNoteAll.filter(function(a){ return !_studentHasAbsenceOnDate(a, date); });
        return {
            summaryDate: date,
            buildingName: user.buildingName || '',
            floors: floorIds.slice(),
            confirmedBy: user.id,
            confirmedByName: user.realName || '',
            totalStudents: totalStudents,
            absenceCount: absenceRecs.length,
            leavePendingCount: leaveRecs.length,
            pickedUpCount: picked.length,
            anomalyCount: noNoteEffective.length,
            actualCount: Math.max(0, totalStudents - absenceRecs.length - leaveRecs.length - picked.length - noNoteEffective.length),
            // 详情快照（历史回溯时不依赖学生/记录后续变化）
            leavePendingDetails: leaveRecs.map(function(r){
                return { name: r.name, className: r.className, bed: r.bed, dormitory: r.dormitory, type: r.type === 'stop' ? '停宿' : '退宿', startDate: r.startDate || r.date, endDate: r.endDate || r.date };
            }),
            pickedUpDetails: picked.map(function(a){
                return { name: a.studentName, className: a.className, bed: a.bed, dormitory: a.dormitoryRoom, confirmedBy: a.reportedByName || '', note: a.note || '' };
            }),
            anomalyDetails: noNoteAll.map(function(a){
                return { name: a.studentName, className: a.className, bed: a.bed, dormitory: a.dormitoryRoom, reportedBy: a.reportedByName || '', note: a.note || '', correctedByAbsence: _studentHasAbsenceOnDate(a, date) };
            })
        };
    }
    /**
     * 读取已落库的某日某用户的晚检总结。
     * @param {string} date - 日期 YYYY-MM-DD
     * @param {number|string} userId - 确认人（生活老师）用户 ID
     * @returns {object|null} 总结记录；不存在返回 null
     */
    function getDailySummary(date, userId){
        if(!DB || !Array.isArray(DB.dailyInspectionSummaries)) return null;
        return DB.dailyInspectionSummaries.find(function(s){
            return s.summaryDate === date && String(s.confirmedBy) === String(userId);
        }) || null;
    }

    // ==================== 站内通知子系统：数据查询 ====================
    /**
     * 查询指定用户的通知列表（按 createdAt 倒序，最新在前）。
     * @param {number|string} [userId] - 用户 ID；参数为空（null/undefined/''）时返回全部通知
     * @returns {Array} 通知记录数组（排序副本，不改变 DB 中原始顺序）
     */
    function getNotificationsForUser(userId){
        if(!DB || !Array.isArray(DB.notifications)) return [];
        var list = DB.notifications;
        if(userId !== null && userId !== undefined && userId !== ''){
            var uid = String(userId);
            list = list.filter(function(n){ return n && String(n.userId) === uid; });
        }
        return list.slice().sort(function(a,b){
            return (b.createdAt || 0) - (a.createdAt || 0);
        });
    }
    /**
     * 统计指定用户的未读通知数量。
     * @param {number|string} userId - 用户 ID
     * @returns {number} 未读条数
     */
    function getUnreadNotificationCount(userId){
        if(!DB || !Array.isArray(DB.notifications)) return 0;
        if(userId === null || userId === undefined || userId === '') return 0;
        var uid = String(userId);
        return DB.notifications.filter(function(n){
            return n && String(n.userId) === uid && !n.read;
        }).length;
    }
    /**
     * 批量创建通知（多人同文场景的性能优化版）：
     * 逐用户生成与 app.js addNotification 单条版结构完全一致的记录，统一追加到
     * DB.notifications，逐条 v3MarkDirty 纳入 V3 同步，最后仅落库一次
     * （N 次 saveDB → 1 次）。批量发送场景请用本函数；单条创建（预警/审核）
     * 仍用 app.js 的 addNotification。
     * @param {Array<number|string>} userIdList - 接收用户 ID 数组
     * @param {string} type - 通知类型（如 'manual' / 'warning' / 'approval'）
     * @param {string} title - 通知标题
     * @param {string} content - 通知正文
     * @param {string} [relatedId] - 关联业务记录 ID（扣分/请假/审核记录等），可空
     * @returns {number} 实际成功创建的通知数量
     */
    function addNotificationsBatch(userIdList, type, title, content, relatedId){
        if(!DB || !Array.isArray(userIdList) || userIdList.length === 0) return 0;
        if(!Array.isArray(DB.notifications)) DB.notifications = [];
        var now = Date.now();
        var created = 0;
        userIdList.forEach(function(uid){
            if(uid === null || uid === undefined || uid === '') return;
            var notification = {
                id: generateRecordId(),
                userId: String(uid),
                type: type,
                title: title,
                content: content,
                relatedId: relatedId || null,
                read: false,
                createdAt: now,
                lastModified: now
            };
            DB.notifications.push(notification);
            v3MarkDirty('notification', notification.id);
            created++;
        });
        if(created > 0) saveDB();
        return created;
    }
    /**
     * 获取全部启用的通知模板（enabled !== false；缺省 enabled 字段亦视为启用）。
     * @returns {Array} 启用中的模板记录数组
     */
    function getEnabledNotificationTemplates(){
        if(!DB || !Array.isArray(DB.notificationTemplates)) return [];
        return DB.notificationTemplates.filter(function(t){ return t && t.enabled !== false; });
    }
    /**
     * 按 id 查询通知模板（包含已禁用模板）。
     * @param {string} id - 模板 id，如 'warn_3' / 'approval_leave'
     * @returns {object|null} 模板记录；不存在返回 null
     */
    function getNotificationTemplateById(id){
        if(!DB || !Array.isArray(DB.notificationTemplates)) return null;
        if(id === null || id === undefined) return null;
        return DB.notificationTemplates.find(function(t){
            return t && String(t.id) === String(id);
        }) || null;
    }
    /**
     * 读取指定通知模板的出厂默认值（副本，调用方可安全修改/覆盖）。
     * 用于管理员在模板管理中"重置"被改动的系统模板。
     * @param {string} id - 模板 id，如 'warn_3' / 'approval_leave'
     * @returns {object|null} 默认模板对象的浅拷贝；非系统内置模板 id 返回 null
     */
    function getDefaultNotificationTemplate(id){
        if(id === null || id === undefined) return null;
        var def = DEFAULT_NOTIFICATION_TEMPLATES.find(function(t){
            return String(t.id) === String(id);
        });
        return def ? Object.assign({}, def) : null;
    }
    /**
     * 确保纪律扣分项"无请假信息"存在（异常上报"无假条"自动扣分用）。
     * 缺失时以 nextIds.item 创建（新口径默认分 -1，即扣 1 分）并标脏上传；已存在直接返回。
     * @returns {{id:number,name:string,defaultScore:number}} 扣分项目
     */
    function ensureNoNoteDeductionItem(){
        if(!DB.deductionItems) DB.deductionItems = { hygiene: [], discipline: [], hygieneBonus: [], disciplineBonus: [] };
        if(!Array.isArray(DB.deductionItems.hygieneBonus)) DB.deductionItems.hygieneBonus = [];
        if(!Array.isArray(DB.deductionItems.disciplineBonus)) DB.deductionItems.disciplineBonus = [];
        if(!Array.isArray(DB.deductionItems.discipline)) DB.deductionItems.discipline = [];
        var item = DB.deductionItems.discipline.find(function(i){ return i.name === '无请假信息'; });
        if(item) return item;
        // 新口径（符号版本 2）：扣分项目默认分为负数
        item = { id: DB.nextIds.item++, name: '无请假信息', defaultScore: -1 };
        DB.deductionItems.discipline.push(item);
        v3MarkDirty('deduction_item', item.id);
        return item;
    }

    // ==================== 楼层调整申请：数据查询 ====================
    /**
     * 查询全部楼层调整申请（按 createdAt 倒序，最新在前）。
     * @returns {Array}
     */
    function getFloorChangeRequests(){
        if(!DB || !Array.isArray(DB.floorChangeRequests)) return [];
        return DB.floorChangeRequests.slice().sort(function(a,b){
            return (b.createdAt||0) - (a.createdAt||0);
        });
    }
    /**
     * 查询指定生活老师的全部申请（按 createdAt 倒序）。
     * @param {number|string} staffId
     * @returns {Array}
     */
    function getFloorChangeRequestsByStaff(staffId){
        if(!DB || !Array.isArray(DB.floorChangeRequests)) return [];
        var sid = String(staffId);
        return DB.floorChangeRequests.filter(function(r){
            return r && String(r.staffId) === sid;
        }).slice().sort(function(a,b){
            return (b.createdAt||0) - (a.createdAt||0);
        });
    }
    /**
     * 查询全部待审核申请（按 createdAt 升序，先提交先处理）。
     * @returns {Array}
     */
    function getPendingFloorChangeRequests(){
        if(!DB || !Array.isArray(DB.floorChangeRequests)) return [];
        return DB.floorChangeRequests.filter(function(r){
            return r && r.status === 'pending';
        }).slice().sort(function(a,b){
            return (a.createdAt||0) - (b.createdAt||0);
        });
    }
    /**
     * 查询指定生活老师当前的待审核申请（无则 null）。
     * @param {number|string} staffId
     * @returns {object|null}
     */
    function getPendingFloorChangeRequestByStaff(staffId){
        if(!DB || !Array.isArray(DB.floorChangeRequests)) return null;
        var sid = String(staffId);
        return DB.floorChangeRequests.find(function(r){
            return r && String(r.staffId) === sid && r.status === 'pending';
        }) || null;
    }
    /**
     * 按 ID 查询单条申请（宽松字符串比较）。
     * @param {string} id
     * @returns {object|null}
     */
    function findFloorChangeRequestById(id){
        if(!DB || !Array.isArray(DB.floorChangeRequests)) return null;
        if(id == null) return null;
        return DB.floorChangeRequests.find(function(r){
            return r && String(r.id) === String(id);
        }) || null;
    }

    /**
     * 【底层分数符号迁移·符号版本 1 → 2】
     * 将存量数据从旧口径（扣分正、加分正，显示层取反）翻转为新口径
     * （扣分负、加分正，净分 = 扣分 + 加分，显示层不取反）。
     *
     * 仅主控设备在 initializeData 中调用；幂等（DB.scoreSignVersion 已为
     * SCORE_SIGN_VERSION 时直接跳过）。
     *
     * 动作：
     *   0) 迁移前整库自动备份到 localStorage（dormitory_system_backup_before_sign）；
     *   1) 全部扣分记录按 recordMode 翻转分值（扣分取负、加分取正）并逐条标脏；
     *   2) 扣分项目默认分取负、加分项目默认分取正并标脏；
     *   3) 同步翻转"待核查记录"隔离区（localStorage）中的同形记录，避免旧符号
     *      孤儿记录在迁移后被人工确认进正式表；
     *   4) 写入 DB.scoreSignVersion = SCORE_SIGN_VERSION，递增 syncEpoch
     *      （其他设备检测到 epoch 变化会整体重建，旧符号数据不回灌）；
     *   5) 全量标脏 + 落本地，确保新符号数据由主控设备全量重传云端。
     *
     * @returns {number} 实际迁移的扣分记录条数（0 表示无需迁移）
     */
    function migrateScoreSign() {
        if (!DB) return 0;
        // 幂等：已是新版本则跳过
        if (DB.scoreSignVersion === SCORE_SIGN_VERSION) return 0;
        // 0) 迁移前自动备份（灾难恢复用，键名固定，技术人员可据此恢复）
        try {
            localStorage.setItem('dormitory_system_backup_before_sign', JSON.stringify(DB));
            console.log('[分数迁移] 迁移前已自动备份（dormitory_system_backup_before_sign）');
        } catch(e) {}
        var migrated = 0;
        // 1) 迁移扣分记录：扣分取负、加分取正（两侧分值分别处理，0 保持 0）
        (DB.deductionRecords || []).forEach(function(r){
            if(!r) return;
            var isBonus = (r.recordMode === 'bonus');
            if(isBonus){
                r.hygieneScore = Math.abs(r.hygieneScore || 0);
                r.disciplineScore = Math.abs(r.disciplineScore || 0);
            } else {
                r.hygieneScore = -(Math.abs(r.hygieneScore || 0));
                r.disciplineScore = -(Math.abs(r.disciplineScore || 0));
            }
            r.lastModified = Date.now();
            v3MarkDirty('deduction_record', r.id);
            migrated++;
        });
        // 2) 迁移扣分项目默认分：卫生/纪律扣分项取负；加分项取正
        ['hygiene','discipline'].forEach(function(sub){
            ((DB.deductionItems && DB.deductionItems[sub]) || []).forEach(function(it){
                if(!it) return;
                it.defaultScore = -(Math.abs(it.defaultScore || 0));
                v3MarkDirty('deduction_item', it.id);
            });
        });
        ['hygieneBonus','disciplineBonus'].forEach(function(sub){
            ((DB.deductionItems && DB.deductionItems[sub]) || []).forEach(function(it){
                if(!it) return;
                it.defaultScore = Math.abs(it.defaultScore || 0);
                v3MarkDirty('deduction_item', it.id);
            });
        });
        // 3) 待核查隔离区记录同口径翻转（这些记录尚未入正式表，不参与上面的遍历）
        try {
            var PENDING_KEY = 'dorm_pending_review_records';
            var pendingRaw = localStorage.getItem(PENDING_KEY);
            if(pendingRaw){
                var pendingArr = JSON.parse(pendingRaw);
                if(Array.isArray(pendingArr) && pendingArr.length > 0){
                    pendingArr.forEach(function(r){
                        if(!r) return;
                        var pIsBonus = (r.recordMode === 'bonus');
                        if(pIsBonus){
                            r.hygieneScore = Math.abs(r.hygieneScore || 0);
                            r.disciplineScore = Math.abs(r.disciplineScore || 0);
                        } else {
                            r.hygieneScore = -(Math.abs(r.hygieneScore || 0));
                            r.disciplineScore = -(Math.abs(r.disciplineScore || 0));
                        }
                    });
                    localStorage.setItem(PENDING_KEY, JSON.stringify(pendingArr));
                }
            }
        } catch(e) {}
        // 4) 写入符号版本号 + 递增 epoch（触发其他设备整体重建）
        DB.scoreSignVersion = SCORE_SIGN_VERSION;
        DB.syncEpoch = Date.now();
        v3MarkDirty('meta', 'main');
        // 5) 全量标脏，确保新符号数据全量上传
        v3MarkAllLocalDirty();
        saveDBToLocal();
        console.log('[分数迁移] 已迁移 ' + migrated + ' 条记录至新符号口径（scoreSignVersion=' + SCORE_SIGN_VERSION + '）');
        return migrated;
    }


// ---- shared globals explicitly mounted on window ----
// 仅挂载函数引用（固定引用，便于外部脚本/控制台调用）。
// DB / storageWarned / _detectedSchemaVersion 为可变状态，由顶层 var 声明天然全局，
// 直接以变量名访问即可，无需经 window 中转；window.DB 改在 sync.js initializeData
// 中 DB 就绪后挂载，确保始终指向最新实例。
window.hashPassword = hashPassword;
window.migrateUserPasswords = migrateUserPasswords;
window.formatLocalDate = formatLocalDate;
window.getTodayLocalStr = getTodayLocalStr;
window.roundScore1 = roundScore1;
window.formatScoreText = formatScoreText;
window.getDefaultNotificationTemplate = getDefaultNotificationTemplate;
window.dedupeStudentsByClassAndName = dedupeStudentsByClassAndName;
window.getDormCollectiveNetScore = getDormCollectiveNetScore;
window.getDormSummaryNetScore = getDormSummaryNetScore;
window.getStudentNetScore = getStudentNetScore;
window.getDormCumulativeNetScore = getDormCumulativeNetScore;
window.getFloorCumulativeNetScore = getFloorCumulativeNetScore;
window.migrateDerivedDeductionRecords = migrateDerivedDeductionRecords;
window.migratePersonalScores = migratePersonalScores;
window.migrateScoreSign = migrateScoreSign;
window.findDerivedRecords = findDerivedRecords;
window.formatStudentBedName = formatStudentBedName;
// 注意：copyItemsListForDiagnosis 定义在 app.js（晚于 data.js 加载），
// 不能在此处做 window 导出（会抛 ReferenceError）；app.js 为 classic script，
// 其顶层 function 声明天然是全局函数，ui.js 内联 onclick 可直接调用，无需导出。
