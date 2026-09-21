/* ============================================================
 * utils.js —— 公共纯工具函数（从 data.js / ui.js 迁移）
 * ------------------------------------------------------------
 * 职责：
 *   集中存放无业务状态依赖的纯工具函数：本地时区日期格式化、
 *   分数取整与分值文本格式化、学生床号显示文本、HTML 属性转义、
 *   时间戳/巡查日期标题格式化。
 *
 * 依赖：无（本文件在 constants.js 之后、data.js 之前加载；
 *       函数均为纯函数，不访问 DB / DOM / localStorage）。
 *
 * 对外暴露：classic script 顶层函数声明天然全局，data.js / sync.js /
 *           ui.js / app.js 可直接以函数名调用。
 * ============================================================ */

    // ==================== 日期工具函数（本地时区，原 data.js） ====================
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

    // ==================== 分数工具（原 data.js） ====================
    /**
     * 分数统一取整：保留 1 位小数，消除 0.2 等小数累加产生的浮点尾差
     * （如 0.2+0.2+0.2=0.6000000000000001 → 0.6）。
     * 全系统所有扣/加分合计均通过本函数处理，保证显示与入库口径一致。
     * @param {number} v - 原始分数
     * @returns {number} 取整后的分数（1 位小数）
     */
    function roundScore1(v) {
        return Math.round((Number(v) || 0) * 10) / 10;
    }

    /**
     * 统一分值文本格式化（新口径·符号版本 2）：
     * 底层已是「扣分负数、加分正数」，显示层不再取反，直接按底层符号呈现：
     *   - deduct：底层负数，直接显示（如 -2）
     *   - bonus：底层正数，显示 +N（如 +4）
     *   - net：底层正数=净加、负数=净扣，直接按符号显示（净扣 -3 / 净加 +3 / 0 → 0）
     * 仅用于展示与导出，不改变任何底层数值。
     * @param {number} value - 分值（底层已带符号）
     * @param {string} kind - 'deduct' | 'bonus' | 'net'
     * @returns {string} 带符号的文本，如 '-4' / '+4' / '0'
     */
    function formatScoreText(value, kind){
        var v = roundScore1(Number(value) || 0);
        if(v === 0) return '0';
        if(kind === 'bonus'){
            // 加分：底层正数，显示 +N
            return '+' + Math.abs(v);
        }
        if(kind === 'net'){
            // 净分：底层正数=净加、负数=净扣，直接按符号显示
            return v > 0 ? ('+' + v) : String(v);
        }
        // deduct（默认）：底层负数，直接显示（如 -2）
        return String(v);
    }

    // ==================== 显示文本工具 ====================
    /**
     * 格式化"学生"为"床号·姓名"显示文本，便于生活老师按床号识别。
     * 规则：
     *   - 有床号：返回 "N号·姓名"（如 "1号·蔡冠宇"）
     *   - 无床号：返回 "未知·姓名"（如 "未知·蔡冠宇"）
     *   - 学生对象为空：返回空串
     * 用途：移动端扣分对象芯片、今日明细页对象列等需要按床号辨识学生的位置。
     * @param {object} student - 学生对象（需含 name、bedNumber 字段）
     * @returns {string}
     */
    function formatStudentBedName(student) {
        if (!student) return '';
        var bed = (student.bedNumber !== null && student.bedNumber !== undefined && String(student.bedNumber).trim() !== '') ? String(student.bedNumber).trim() : '未知';
        return bed + '号·' + (student.name || '');
    }

    /**
     * 转义 HTML 属性值中的特殊字符（用于内联 onclick 参数等拼接场景，原 ui.js）。
     * @param {string} s - 原始文本
     * @returns {string} 转义后的安全文本
     */
    function escapeHtmlAttr(s){
        return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    /**
     * 将时间戳格式化为 HH:mm（用于巡查确认时间显示，原 ui.js）。
     * 非法/缺失时间戳返回空字符串，兼容历史无 confirmedAt 的旧数据。
     * @param {number|string} ts - 毫秒时间戳
     * @returns {string} HH:mm 或 ''
     */
    function formatConfirmedTime(ts){
        if(!ts) return '';
        var d = new Date(ts);
        if(isNaN(d.getTime())) return '';
        var h = String(d.getHours()).padStart(2,'0');
        var m = String(d.getMinutes()).padStart(2,'0');
        return h + ':' + m;
    }

    /**
     * 将 YYYY-MM-DD 格式化为总结标题用中文日期（如 "9月9号 周三晚"，原 ui.js）。
     * @param {string} dateStr - 日期字符串
     * @returns {string}
     */
    function formatInspectionDateTitle(dateStr){
        try{
            var parts=String(dateStr).split('-');
            var d=new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10));
            var week='日一二三四五六'.charAt(d.getDay());
            return (d.getMonth()+1)+'月'+d.getDate()+'号 周'+week+'晚';
        }catch(e){ return dateStr; }
    }
