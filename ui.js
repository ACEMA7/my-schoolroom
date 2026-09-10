/* ============================================================
 * ui.js —— 视图渲染与界面交互层
 * ------------------------------------------------------------
 * 职责：
 *   1. 全局轻提示 toast 与统一错误处理（handleError / safeAsync /
 *      categorizeError / 错误日志）；
 *   2. 大列表分片渲染 renderListInChunks（rAF + DocumentFragment，
 *      令牌取消机制，供历史记录/名单/排行榜/记录列表/查询结果使用）；
 *   3. 底部导航与首页、楼层-宿舍树形导航（buildBottomNav/renderTree）；
 *   4. 各业务视图渲染：住宿信息（renderHierarchyView）、扣分登记
 *      （renderAddView）、统计报表（renderStatsView）、学生名单
 *      （renderStudentsView）、宿舍管理、扣分项目管理、学生管理
 *      （请假/停宿/退宿登记与记录）、数据导出与查询（renderExportView/
 *      queryFilteredData/exportCSV/exportFilteredDataNew）。
 *
 * 渲染约定：
 *   - 视图函数统一签名 renderXxxView(container)，把 HTML 写入 container；
 *   - 大列表先写"骨架 HTML"（空 <tbody id="...">），再用 renderListInChunks
 *     分片填充；统计页缓存采用"骨架函数 + fill 函数"配对，innerHTML
 *     重绘后必须重新调用对应 fill 函数；
 *   - 行内交互一律用内联 onclick 调全局函数（app.js）；学生名单 checkbox
 *     采用 tbody change 事件委托，分片插入后无需重新绑定。
 *
 * 主要依赖：data.js（DB 与全部数据查询函数）、sync.js（saveDB/manualSync/
 *   resetCloudData 等）、app.js（currentUser/switchView/视图状态与操作函数）、
 *   index.html 中的容器元素（contentArea/toast 等）、XLSX/flatpickr（内联）。
 *
 * 对外暴露：文件末尾挂载 window.toast / handleError / categorizeError /
 *   appendErrorLog / safeAsync / renderListInChunks；渲染函数声明为全局，
 *   由 app.js 的 switchView/renderView 按当前视图调用。
 * ============================================================ */

    // ==================== Toast ====================
    /**
     * 全局轻提示（顶部/底部 toast，3 秒自动消失）。
     * @param {string} message - 提示文本（textContent 写入，杜绝 HTML 注入）
     * @param {string} [type='success'] - 类型：'success' | 'error'（决定配色）
     * @param {Object} [action] - 可选操作按钮 {label:string, onClick:Function}，
     *   带按钮时停留 8 秒；按钮用 DOM API + textContent 生成，杜绝注入
     */
    function toast(message, type, action) {
        type = type || 'success';
        var container = document.getElementById('toast');
        var item = document.createElement('div');
        item.className = 'toast-item ' + type;
        item.textContent = message;
        if (action && action.label && typeof action.onClick === 'function') {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'toast-action-btn';
            btn.textContent = String(action.label);
            btn.addEventListener('click', function() {
                if (item.parentNode) item.parentNode.removeChild(item);
                action.onClick();
            });
            item.appendChild(btn);
        }
        container.appendChild(item);
        // 带操作按钮的提示停留 8 秒，给用户足够的点击时间
        setTimeout(function() {
            if (item.parentNode) item.parentNode.removeChild(item);
        }, action ? 8000 : 3000);
    }

    // ==================== 统一错误处理（handleError / safeAsync） ====================
    var ERROR_LOG_KEY = 'dorm_error_logs';
    var ERROR_LOG_LIMIT = 20; // 只保留最近 20 条，避免日志本身撑爆本地存储

    // 错误分类：返回面向用户的提示文案
    function categorizeError(error) {
        var name = error && error.name ? String(error.name) : '';
        var msg = error && error.message ? String(error.message) : String(error || '');
        var code = error && error.code !== undefined ? String(error.code) : '';
        // 本地存储配额（QuotaExceededError / code 22 / Firefox 1014）
        if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === '22' || code === '1014' || /quota|exceeded the storage|storage.*full/i.test(msg)) {
            return '本地存储空间不足，请清理历史记录或联系管理员';
        }
        // 云端（Supabase/PostgREST）：携带 code/details/hint 结构，或典型服务端错误关键字
        if ((error && (error.details !== undefined || error.hint !== undefined)) || /^[45]|^PGRST|^[0-9]{2}[A-Z0-9]{3}/.test(code) || /supabase|postgrest|row-level security|invalid api key|jwt|relation .* does not exist|duplicate key|violates/i.test(msg)) {
            return '云端服务暂时不可用，请稍后再试';
        }
        // 网络异常（离线 / fetch 失败 / 连接类错误）
        var offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
        if (offline || (name === 'TypeError' && /fetch|network/i.test(msg)) || /networkerror|failed to fetch|err_internet|err_connection|err_name|network request failed|load failed|timed?\s*out|timeout/i.test(msg)) {
            return '网络连接异常，请检查网络后重试';
        }
        return '操作失败，请重试；若持续出现请联系管理员';
    }

    // 错误写入 localStorage 日志（时间戳/上下文/消息/栈），自身全程 try-catch 防二次报错
    function appendErrorLog(entry) {
        try {
            var logs = [];
            try { logs = JSON.parse(localStorage.getItem(ERROR_LOG_KEY) || '[]') || []; } catch (e) { logs = []; }
            logs.unshift(entry);
            if (logs.length > ERROR_LOG_LIMIT) logs = logs.slice(0, ERROR_LOG_LIMIT);
            localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(logs));
        } catch (e) { /* 日志写入失败不再提示，避免错误循环 */ }
    }

    /**
     * 统一错误处理：控制台输出完整错误（含栈）→ 写入 localStorage 错误日志
     * （最近 20 条）→ 非静默时弹出分类后的用户提示。
     * @param {Error|*} error - 捕获到的错误
     * @param {string} context - 操作上下文名称（如 '同步数据'，用于提示与日志）
     * @param {Object} [options] - { silent?:boolean } true=只记录不弹提示
     * @returns {string} 分类后的面向用户文案（便于调用方拼接更具体的提示）
     */
    function handleError(error, context, options) {
        var opts = options || {};
        var msg = error && error.message ? String(error.message) : String(error || '');
        var detail = categorizeError(error);
        // 开发者：控制台输出完整错误（含栈）
        console.error('[错误处理] ' + context + ':', error);
        // 错误日志（供导出反馈给管理员）
        appendErrorLog({
            time: new Date().toLocaleString(),
            context: String(context || ''),
            message: msg.slice(0, 200),
            stack: error && error.stack ? String(error.stack).slice(0, 500) : ''
        });
        // 用户提示
        if (!opts.silent) toast('【' + context + '】' + detail, 'error');
        return detail;
    }

    /**
     * 安全执行高阶函数：统一捕获同步异常与 Promise 拒绝，返回的 Promise
     * 永远 resolve（不 reject），失败时 resolve(failureValue)。
     * @param {Function} fn - 业务函数（同步或返回 Promise）
     * @param {string} context - 操作名称（错误提示/日志用）
     * @param {Object} [options] - {
     *   retry?:boolean,    失败 toast 附带"点击重试"按钮（重试同一 fn）
     *   silent?:boolean,   静默失败（只记日志不弹提示）
     *   retries?:number,   最大重试次数（默认 2）
     *   failureValue?:*    失败时的 resolve 值（默认 null）
     * }
     * @returns {Promise} 成功 resolve(fn 返回值)；失败 resolve(failureValue)
     */
    function safeAsync(fn, context, options) {
        var opts = options || {};
        var maxRetry = typeof opts.retries === 'number' ? opts.retries : 2;
        var attempt = typeof opts._attempt === 'number' ? opts._attempt : 0;
        function run() {
            var result;
            try {
                result = fn();
            } catch (e) {
                return Promise.reject(e);
            }
            return Promise.resolve(result);
        }
        return run().then(null, function(error) {
            if (opts.retry && attempt < maxRetry) {
                // 静默记录本次失败，弹带"点击重试"按钮的提示
                handleError(error, context, { silent: true });
                toast('【' + context + '】' + categorizeError(error), 'error', {
                    label: '点击重试',
                    onClick: function() {
                        safeAsync(fn, context, { retry: true, silent: !!opts.silent, retries: maxRetry, _attempt: attempt + 1, failureValue: opts.failureValue });
                    }
                });
            } else {
                handleError(error, context, { silent: !!opts.silent });
            }
            return opts.failureValue !== undefined ? opts.failureValue : null;
        });
    }

    // ==================== 分片渲染（大列表性能优化） ====================
    // 每个容器对应一个渲染令牌：同一容器开始新一轮渲染时，上一轮分片自动作废（快速切换不串内容）
    var _chunkRenderTokens = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
    /**
     * 分片渲染列表数据，避免大量 DOM 一次性插入造成卡顿
     * @param {HTMLElement} container - 目标容器（<tbody> 或普通块元素）
     * @param {Array} data - 数据数组
     * @param {Function} renderItem - 接收 (数据项, 索引)，返回该行 HTML 字符串
     * @param {number} chunkSize - 每批渲染条数（默认 50）
     * @param {Function} callback - 全部渲染完成后的回调（可选）
     * @param {Object} options - { emptyHtml: 空数据时的占位 HTML }（可选）
     */
    function renderListInChunks(container, data, renderItem, chunkSize, callback, options) {
        if (!container) return;
        chunkSize = chunkSize || 50;
        options = options || {};
        data = Array.isArray(data) ? data : [];
        // 令牌：使该容器上一轮尚未完成的分片立即停止
        var token = {};
        if (_chunkRenderTokens) _chunkRenderTokens.set(container, token);
        var isTbody = container.tagName === 'TBODY';
        var emptyHtml = options.emptyHtml || (isTbody
            ? '<tr><td colspan="999" style="text-align:center;color:#aaa">暂无数据</td></tr>'
            : '<div class="empty-state" style="padding:24px">暂无数据</div>');
        function done() { if (typeof callback === 'function') callback(); }
        if (data.length === 0) { container.innerHTML = emptyHtml; done(); return; }
        // 小数据量：同步一次性渲染，避免动画帧开销
        if (data.length <= chunkSize) {
            container.innerHTML = data.map(function(item, i) { return renderItem(item, i); }).join('');
            done();
            return;
        }
        // 大数据量：按帧分片。tbody 必须用 tbody 元素解析 <tr>（在 div 中解析 <tr> 会被浏览器丢弃）
        var parser = document.createElement(isTbody ? 'tbody' : 'div');
        container.innerHTML = '';
        var index = 0;
        function renderChunk() {
            // 容器已被新一轮渲染取代，或已脱离 DOM（视图切换/重绘）→ 安全停止
            if (_chunkRenderTokens && _chunkRenderTokens.get(container) !== token) return;
            if (!container.isConnected) return;
            var end = Math.min(index + chunkSize, data.length);
            var html = '';
            for (var i = index; i < end; i++) html += renderItem(data[i], i);
            parser.innerHTML = html;
            var frag = document.createDocumentFragment();
            while (parser.children.length) frag.appendChild(parser.children[0]);
            container.appendChild(frag);
            index = end;
            if (index < data.length) {
                requestAnimationFrame(renderChunk);
            } else {
                done();
            }
        }
        requestAnimationFrame(renderChunk);
    }

    // ==================== 底部导航栏（移动端） ====================
    var NAV_META = {
        home:{icon:'🏠',label:'首页'},
        hierarchy:{icon:'🌳',label:'住宿'},
        add:{icon:'📝',label:'登记'},
        stats:{icon:'📊',label:'统计'},
        inspection:{icon:'👀',label:'巡查'},
        students:{icon:'👥',label:'名单'},
        items:{icon:'📋',label:'项目'},
        leavemanage:{icon:'🏠',label:'学生'},
        export:{icon:'📤',label:'数据'}
    };
    /**
     * 构建移动端底部导航栏（5 个主入口图标，高亮当前视图）。
     * @returns {string} 底部导航 HTML 字符串（写入底栏容器）
     */
    function buildBottomNav(){
        var nav=document.getElementById('bottomNav');
        if(!nav) return;
        var visible=[];
        document.querySelectorAll('.sidebar-nav .nav-item').forEach(function(el){
            if(el.style.display!=='none') visible.push(el.getAttribute('data-view'));
        });
        // 首页为固定首Tab（色块网格是全部功能的主入口）；底栏保留最高频的4个功能
        // （管理员/生活老师可见顺序中第 4 个为"巡查核实"）
        var tabs=[{view:'home',icon:NAV_META.home.icon,label:NAV_META.home.label}];
        visible.slice(0,4).forEach(function(v){
            var m=NAV_META[v]||{icon:'•',label:v};
            tabs.push({view:v,icon:m.icon,label:m.label});
        });
        var html='';
        tabs.forEach(function(t){
            html+='<div class="bottom-nav-item'+(t.view===currentView?' active':'')+'" data-view="'+t.view+'" onclick="switchView(\''+t.view+'\')"><span class="bni-icon">'+t.icon+'</span><span>'+t.label+'</span></div>';
        });
        nav.innerHTML=html;
    }

    // ==================== 手机端功能首页（色块导航） ====================
    /**
     * 渲染首页（功能宫格导航：点击进入各业务模块）。
     * @param {HTMLElement} container - contentArea 容器
     */
    function renderHomeView(container){
        var role = currentUser ? currentUser.role : 'STAFF';
        // 权限与侧边栏菜单可见性保持一致：ADMIN全部 / CLASS_ADMIN层级(仅本班)+退宿+数据 / STAFF为层级+登记+统计+退宿
        var all = [
            {view:'hierarchy',  icon:'🌳', name:'住宿信息',     color:'#4f6ef7', roles:['ADMIN','STAFF','CLASS_ADMIN']},
            {view:'add',        icon:'📝', name:'扣分登记',     color:'#34c759', roles:['ADMIN','STAFF']},
            {view:'stats',      icon:'📊', name:'统计报表',     color:'#ff9500', roles:['ADMIN','STAFF']},
            {view:'inspection', icon:'👀', name:'巡查核实',     color:'#0ea5e9', roles:['ADMIN','STAFF']},
            {view:'students',   icon:'👥', name:'学生名单管理',     color:'#ff3b30', roles:['ADMIN']},
            {view:'items',      icon:'📋', name:'扣分项目管理', color:'#a855f7', roles:['ADMIN']},
            {view:'leavemanage',icon:'🏠', name:'学生管理', color:'#0891b2', roles:['ADMIN','STAFF','CLASS_ADMIN']},
            {view:'export',     icon:'📊', name:'数据管理',     color:'#eab308', roles:['ADMIN','CLASS_ADMIN']}
        ];
        var cards = all.filter(function(it){ return it.roles.indexOf(role) !== -1; }).map(function(it){
            return '<div class="home-card" style="background:'+it.color+'" onclick="switchView(\''+it.view+'\')"><span class="hc-icon">'+it.icon+'</span><span class="hc-name">'+it.name+'</span></div>';
        }).join('');
        var welcome = currentUser ? ('你好，' + currentUser.realName + '，请选择要使用的功能') : '请选择要使用的功能';
        container.innerHTML = '<div class="content-header"><h2>🏠 功能首页</h2></div><div class="home-welcome">'+welcome+'</div><div class="home-grid">'+cards+'</div>';
    }

    // ==================== 树形导航 ====================
    // p 为元素ID前缀（侧边栏用''，手机端页内树用'm-'），避免两处树ID冲突
    function buildTreeHtml(p, withTitle){
        p = p || '';
        var classMode = isClassAdmin();
        var dormSet = classMode ? getClassDormIds() : null;
        // 生活老师楼层分工：仅渲染 assignedFloors 内的楼层（ADMIN/班主任为全部）
        var allowedFloorSet = {};
        getAssignedFloorIds().forEach(function(fid){ allowedFloorSet[fid] = true; });
        var html = withTitle ? '<div style="font-weight:700;padding:8px 10px">🏢 全部楼层</div>' : '';
        DB.floors.forEach(function(f){
            if(!allowedFloorSet[f.id]) return; // 分工外的楼层不显示
            var rooms=getDormitoriesByFloor(f.id);
            // 班级账号：仅显示该班级学生入住的楼层与宿舍
            if(classMode){
                rooms=rooms.filter(function(r){ return dormSet[r.id]; });
                if(rooms.length===0) return;
            }
            var total=getTotalScore(filterRecordsByClass(getRecordsByFloor(f.id)));
            var isOpen = (f.id === selectedFloorId);
            html+='<div class="tree-floor"><div class="tree-floor-header" onclick="toggleFloor('+f.id+',\''+p+'\')"><span id="'+p+'arrow-'+f.id+'">'+(isOpen?'▼':'▶')+'</span>📁 '+f.name+' <span class="badge-tag badge-danger">'+total+'分</span></div><div class="tree-rooms'+(isOpen?' open':'')+'" id="'+p+'rooms-'+f.id+'">';
            rooms.forEach(function(r){
                var score=getTotalScore(filterRecordsByClass(getRecordsByDormitory(r.id)));
                var isActive = (r.id === selectedDormitoryId);
                html+='<div class="tree-room'+(isActive?' active':'')+'" id="'+p+'tree-room-'+r.id+'" onclick="selectDormitory('+r.id+')">🚪 '+r.roomNumber+' <span class="badge-tag '+(score>10?'badge-danger':score>3?'badge-warning':'badge-primary')+'">'+score+'分</span></div>';
            });
            html+='</div></div>';
        });
        return html;
    }
    /**
     * 重绘左侧/树形导航（楼层→宿舍两级树，班级账号仅显示本班宿舍）。
     * 数据或选择项变化后调用（登录、同步、重置、增删宿舍后）。
     */
    function renderTree(){
        var container = document.getElementById('sidebarTree');
        // 班级账号同样渲染树形导航，但内容由 buildTreeHtml 按班级范围过滤
        container.style.display = 'block';
        container.innerHTML = buildTreeHtml('', true);
    }
    /**
     * 树形导航：展开/收起某楼层节点。
     * @param {number} id - 楼层 ID
     * @param {string} p - 端标识：'sidebar'（PC 侧栏）| 'mobile'（移动端树）
     */
    function toggleFloor(id, p){
        p = p || '';
        var rooms=document.getElementById(p+'rooms-'+id);
        var arrow=document.getElementById(p+'arrow-'+id);
        if(rooms) rooms.classList.toggle('open');
        if(arrow) arrow.textContent=arrow.textContent==='▶'?'▼':'▶';
    }
    /**
     * 树形导航选中某宿舍：记录选中态、切换到住宿信息视图并渲染该宿舍。
     * @param {number} id - 宿舍 ID（dormitory.id）
     */
    function selectDormitory(id){
        selectedDormitoryId=id;
        var dorm=getDormitoryById(id);
        if(dorm){
            selectedFloorId=dorm.floorId;
            document.querySelectorAll('.tree-room').forEach(function(el){el.classList.remove('active');});
            // 同时更新侧边栏树（桌面）与页内树（手机）的状态，页内树随后随视图重绘
            ['', 'm-'].forEach(function(p){
                var roomEl=document.getElementById(p+'tree-room-'+id);
                if(roomEl) roomEl.classList.add('active');
                var roomsEl=document.getElementById(p+'rooms-'+dorm.floorId);
                if(roomsEl) roomsEl.classList.add('open');
                var arrowEl=document.getElementById(p+'arrow-'+dorm.floorId);
                if(arrowEl) arrowEl.textContent='▼';
            });
            renderHierarchyView(document.getElementById('contentArea'));
            if (window.innerWidth <= 768) closeSidebar();
        }
    }

    // ==================== 住宿信息视图 ====================
    /**
     * 渲染「住宿信息」视图：选中宿舍的床位/学生一览 + 历史扣分记录。
     * 历史记录先写骨架（空 tbody#historyTbody），再用 renderListInChunks
     * 分片渲染 sortedRecords（空数据显示"暂无记录"占位）；快速切换宿舍时
     * 分片令牌自动取消上一批，避免串内容。记录的删除/修改按钮内联 onclick。
     * @param {HTMLElement} container - contentArea 容器
     */
    function renderHierarchyView(container){
        var isMobileH=window.innerWidth<=768;
        var classMode=isClassAdmin();
        var classDormSet=classMode?getClassDormIds():null;
        // 生活老师楼层分工：可见楼层白名单（ADMIN/班主任为全部楼层）
        var allowedFloorSet = {};
        getAssignedFloorIds().forEach(function(fid){ allowedFloorSet[fid] = true; });
        // 若当前选中的宿舍已被删除（不在 dormitoryList），清空选择重新定位
        var selDorm = selectedDormitoryId ? getDormitoryById(selectedDormitoryId) : null;
        if(selDorm && isDormitoryDeleted(selDorm.roomNumber)){ selectedDormitoryId=null; selectedFloorId=null; selDorm=null; }
        if(!selectedDormitoryId||!getDormitoryById(selectedDormitoryId)||(classMode&&!classDormSet[selectedDormitoryId])||(selDorm&&!allowedFloorSet[selDorm.floorId])){
            // 手机端/班级账号/分工生活老师：默认选中第一个可用楼层的第一个宿舍；桌面端保持原有默认逻辑
            var firstDorm=null;
            function dormAllowed(d){
                if(!allowedFloorSet[d.floorId]) return false;           // 分工外楼层
                if(classMode && !classDormSet[d.id]) return false;      // 班级账号本班宿舍
                return true;
            }
            if(isMobileH||classMode||isStaff()){
                var floorsPool=DB.floors.filter(function(f){ return allowedFloorSet[f.id]; });
                if(classMode){
                    floorsPool=floorsPool.filter(function(f){
                        return getDormitoriesByFloor(f.id).some(function(d){ return classDormSet[d.id]; });
                    });
                }
                var f0=floorsPool[0];
                var dorms0=f0?getDormitoriesByFloor(f0.id):[];
                dorms0=dorms0.filter(dormAllowed);
                firstDorm=dorms0.length?dorms0[0]:null;
            }else{
                firstDorm=DB.dormitories.find(dormAllowed)||DB.dormitories[0];
            }
            if(firstDorm){
                selectedDormitoryId=firstDorm.id;
                selectedFloorId=firstDorm.floorId;
            }else if(classMode){
                container.innerHTML='<div class="content-header"><h2>📋 住宿信息</h2></div><div class="empty-state">该班级暂无学生入住数据</div>';
                return;
            }
        }
        if(!selectedDormitoryId){container.innerHTML='<div class="empty-state">暂无数据</div>';return;}
        var dorm=getDormitoryById(selectedDormitoryId);
        var floor=getFloorById(dorm.floorId);
        var students=getStudentsByDormitory(dorm.id);
        // 班级账号：成员仅显示本班学生（合住宿舍中其他班级学生不显示）
        if(classMode) students=students.filter(function(s){ return s.className===currentUser.className; });
        var records=getRecordsByDormitory(dorm.id);
        // 班级账号：仅显示本班学生的记录及本班宿舍的集体记录
        if(classMode) records=filterRecordsByClass(records);
        var total=getTotalScore(records);
        // 汇总当前宿舍各状态人数（与成员列表状态标签同一套优先级逻辑，每次渲染实时计算）
        var statusOrder=['在住','请假中','停宿中','退宿申请中','已退宿']; // 按需求移除"停宿申请中"统计项
        var statusColorMap={'在住':'#34c759','请假中':'#4f6ef7','停宿中':'#a855f7','退宿申请中':'#ff9500','停宿申请中':'#ff9500','已退宿':'#ff3b30'};
        var statusCounts={}; statusOrder.forEach(function(k){ statusCounts[k]=0; });
        students.forEach(function(s){ var st=getStudentStatus(s.id); if(statusCounts[st.label]!==undefined) statusCounts[st.label]++; });
        var statusRowHtml=statusOrder.map(function(k){
            return '<span style="display:inline-flex;align-items:center;gap:6px;font-size:0.9286rem;font-weight:600;color:var(--gray-700)"><span style="width:10px;height:10px;border-radius:50%;background:'+statusColorMap[k]+';flex-shrink:0"></span>'+k+': '+statusCounts[k]+'人</span>';
        }).join('');
        var studentHtml=students.map(function(s){
            var sr=records.filter(function(r){return r.studentId===s.id;});
            var ss=getNetScore(sr);
            var st=getStudentStatus(s.id);
            var ops = '';
            if(isAdmin()){
                ops = '<td data-label="操作"><button class="btn btn-outline btn-xs" onclick="openTransferModal('+s.id+')">调宿</button> <button class="btn btn-danger btn-xs" onclick="moveOutStudent('+s.id+')">迁出</button></td>';
            }
            return '<tr><td data-label="姓名"><b>'+s.name+'</b></td><td data-label="班级">'+(s.className||'-')+'</td><td data-label="床号">'+(s.bedNumber||'-')+'</td><td data-label="状态"><span class="status-tag '+st.cls+'">'+st.label+'</span></td><td data-label="个人净分" class="'+(ss>0?'highlight-red':'')+'">'+ss+'</td>'+ops+'</tr>';
        }).join('')||'<tr><td colspan="5" style="text-align:center;color:#aaa">该宿舍暂无成员</td></tr>';
        // 移动端成员单行紧凑列表：姓名 + 彩色圆点状态（圆点与文字同色）+ 班级·床号，右侧个人扣分（0分绿色/有分红色）
        var memberCardHtml=students.map(function(s){
            var sr=records.filter(function(r){return r.studentId===s.id;});
            var ss=getNetScore(sr);
            var st=getStudentStatus(s.id);
            var dotColor=statusColorMap[st.label]||'#9ca3af';
            var memOps = '';
            if(isAdmin()){
                memOps = '<span class="mem-ops"><button class="btn btn-outline btn-xs" style="padding:2px 6px;font-size:0.7857rem" onclick="openTransferModal('+s.id+')">调宿</button><button class="btn btn-danger btn-xs" style="padding:2px 6px;font-size:0.7857rem" onclick="moveOutStudent('+s.id+')">迁出</button></span>';
            }
            return '<div class="mem-row"><span class="mem-name">'+s.name+'</span><span class="mem-status" style="color:'+dotColor+'"><span class="mem-dot" style="background:'+dotColor+'"></span>'+st.label+'</span><span class="mem-sub">'+(s.className||'-')+'·床号'+(s.bedNumber||'-')+'</span><span class="mem-score'+(ss>0?' has':'')+'">'+ss+'分</span>'+memOps+'</div>';
        }).join('')||'<div class="empty-state" style="padding:18px">该宿舍暂无成员</div>';
        // 按日期倒序排列：当天记录显示在最顶部（同日内较新记录优先；兼容字符串ID与旧数字ID）
        var sortedRecords=records.slice().sort(function(a,b){
            if(a.recordDate!==b.recordDate) return a.recordDate<b.recordDate?1:-1;
            var ta=a.createdAt||0, tb=b.createdAt||0;
            if(ta!==tb) return tb-ta;
            return String(b.id)<String(a.id)?-1:(String(b.id)>String(a.id)?1:0);
        });
        var isStaff=currentUser&&currentUser.role==='STAFF';
        // 单行历史记录 HTML（供分片渲染逐条调用）
        function historyRowHtml(r){
            var student=r.studentId?getStudentById(r.studentId):null;
            var isBonusRec = (r.recordMode === 'bonus');
            var nameGetter = isBonusRec ? getBonusItemNameByIdOrCustom : getItemNameByIdOrCustom;
            var hyNames=(r.hygieneItemIds||[]).map(nameGetter).filter(Boolean).join('、');
            var disNames=(r.disciplineItemIds||[]).map(nameGetter).filter(Boolean).join('、');
            var scorePrefix = isBonusRec ? '+' : '-';
            var scoreColor = isBonusRec ? '#34c759' : '#ff3b30';
            var modeTag = isBonusRec ? '<span class="badge-tag badge-primary" style="margin-right:4px">加分</span>' : '';
            // 操作列：管理员可删除，生活老师（STAFF）可修改，其他角色无操作（ID为字符串需加引号传参）
            var actionHtml='<td data-label="操作">-</td>';
            if(isAdmin()) actionHtml='<td data-label="操作"><button class="btn btn-danger btn-xs" onclick="deleteRecord(\''+r.id+'\')">删除</button></td>';
            else if(isStaff) actionHtml='<td data-label="操作"><button class="btn btn-primary btn-xs" onclick="editRecord(\''+r.id+'\')">修改</button></td>';
            return '<tr><td data-label="日期">'+r.recordDate+'</td><td data-label="对象">'+modeTag+(student?student.name:'宿舍集体')+'</td><td data-label="卫生项目">'+(hyNames||'-')+'</td><td data-label="卫生分值" style="color:'+scoreColor+'">'+scorePrefix+(r.hygieneScore||0)+'</td><td data-label="纪律项目">'+(disNames||'-')+'</td><td data-label="纪律分值" style="color:'+scoreColor+'">'+scorePrefix+(r.disciplineScore||0)+'</td><td data-label="备注">'+escapeHtmlAttr(r.remark||'-')+'</td>'+actionHtml+'</tr>';
        }
        // 手机端顶部导航卡：楼层芯片(每行4个均匀分布) + 宿舍横滑条，与扣分登记页交互一致；桌面端不渲染（侧边栏树保留）
        var topCard='';
        if (window.innerWidth<=768) {
            var floorsList=DB.floors.filter(function(f){ return allowedFloorSet[f.id]; });
            var dormsOfFloor=getDormitoriesByFloor(dorm.floorId).filter(function(d){ return allowedFloorSet[d.floorId]; });
            // 班级账号：仅显示本班学生入住的楼层与宿舍
            if(classMode){
                floorsList=floorsList.filter(function(f){
                    return getDormitoriesByFloor(f.id).some(function(d){ return classDormSet[d.id]; });
                });
                dormsOfFloor=dormsOfFloor.filter(function(d){ return classDormSet[d.id]; });
            }
            var floorChips=floorsList.map(function(f){
                return '<div class="chip'+(f.id===dorm.floorId?' active':'')+'" onclick="hierarchyPickFloor('+f.id+')">'+f.name+'</div>';
            }).join('');
            var dormChips=dormsOfFloor.map(function(r){
                return '<div class="chip'+(r.id===dorm.id?' active':'')+'" onclick="hierarchyPickDorm('+r.id+')">'+r.roomNumber+'</div>';
            }).join('')||'<span style="color:#aaa;font-size:0.9286rem">该楼层暂无宿舍</span>';
            topCard='<div class="card"><div class="card-body">'
                +'<div class="form-group"><label>🏢 选择楼层</label><div class="chip-floors chip-floors-left">'+floorChips+'</div></div>'
                +'<div class="form-group" style="margin-bottom:0"><label>🚪 选择宿舍号 <span style="font-weight:400;font-size:0.8571rem;color:var(--gray-500)">左右滑动查看更多</span></label><div class="chip-dorms">'+dormChips+'</div></div>'
                +'</div></div>';
        }
        // 三个统计卡片内容（宿舍人数/扣分记录数/累计扣分）：PC 端合并在统计大卡内；移动端移至成员列表下方
        var statThreeInner='<div class="stat-card"><div class="number">'+students.length+'</div><div class="label">👥 宿舍人数</div></div><div class="stat-card warning"><div class="number">'+records.length+'</div><div class="label">📋 扣分记录数</div></div><div class="stat-card danger"><div class="number">'+total+'</div><div class="label">📊 累计扣分</div></div>';
        // PC 端宿舍信息统计大卡：状态汇总行 + 三张统计卡片（保持原样）
        var statsCard='<div class="card"><div class="card-header">📊 宿舍信息统计</div><div class="card-body">'
            +'<div style="display:flex;flex-wrap:wrap;gap:8px 18px;padding:10px 14px;background:var(--gray-50);border-radius:6px;margin-bottom:14px">'+statusRowHtml+'</div>'
            +'<div class="stat-cards" style="margin-bottom:0">'+statThreeInner+'</div>'
            +'</div></div>';
        // 移动端：状态汇总单独成卡（三张统计卡下移到成员列表之后、历史记录之前），使用独立 .stat-cards-mobile 类避免与其他 stat-cards 冲突
        var statusCard='<div class="card"><div class="card-header">📊 宿舍信息统计</div><div class="card-body">'
            +'<div style="display:flex;flex-wrap:wrap;gap:8px 18px;padding:10px 14px;background:var(--gray-50);border-radius:6px">'+statusRowHtml+'</div>'
            +'</div></div>';
        var statThreeMobile='<div class="stat-cards-mobile"><div class="stat-item"><div class="number">'+students.length+'</div><div class="label">👥 宿舍人数</div></div><div class="stat-item"><div class="number" style="color:#f59e0b">'+records.length+'</div><div class="label">📋 扣分记录数</div></div><div class="stat-item"><div class="number" style="color:#ff3b30">'+total+'</div><div class="label">📊 累计扣分</div></div></div>';
        // 页头仅保留标题（登记扣分入口统一收敛到功能首页/侧边栏/底部导航，住宿信息页只读）
        var memberOpsTh = isAdmin() ? '<th>操作</th>' : '';
        var membersCardPc='<div class="card"><div class="card-header">👥 宿舍成员</div><div style="overflow-x:auto"><table><thead><tr><th>姓名</th><th>班级</th><th>床号</th><th>状态</th><th>个人净分</th>'+memberOpsTh+'</tr></thead><tbody>'+studentHtml+'</tbody></table></div></div>';
        var membersCardMobile='<div class="card"><div class="card-header">👥 宿舍成员</div><div class="card-body" style="padding:2px 14px">'+memberCardHtml+'</div></div>';
        var recordsCard='<div class="card"><div class="card-header">📜 历史记录 <span class="badge-tag badge-danger">'+total+'分</span><span style="font-weight:400;font-size:0.8571rem;color:var(--gray-500);margin-left:6px">按日期倒序</span></div><div style="overflow-x:auto"><table><thead><tr><th>日期</th><th>对象</th><th>卫生项目</th><th>分值</th><th>纪律项目</th><th>分值</th><th>备注</th><th>操作</th></tr></thead><tbody id="historyTbody"></tbody></table></div></div>';
        // 移动端顺序：楼层/宿舍芯片 → 状态汇总 → 宿舍成员（单行紧凑）→ 三个统计卡片 → 历史扣分记录
        // PC 端顺序保持不变：统计大卡（状态+三卡片）→ 历史扣分记录 → 宿舍成员表
        container.innerHTML='<div class="content-header"><h2>📋 宿舍 '+dorm.roomNumber+'（'+floor.name+'）</h2></div>'+topCard+(isMobileH?(statusCard+membersCardMobile+statThreeMobile+recordsCard):(statsCard+recordsCard+membersCardPc));
        // 历史记录分片填充：切换宿舍时上一轮分片自动作废（令牌机制），空数据显示占位行
        renderListInChunks(document.getElementById('historyTbody'), sortedRecords, historyRowHtml, 50, null,
            { emptyHtml:'<tr><td colspan="8" style="text-align:center;color:#aaa">暂无记录</td></tr>' });
    }

    /**
     * 转义 HTML 属性值中的特殊字符（用于内联 onclick 参数等拼接场景）。
     * @param {string} s - 原始文本
     * @returns {string} 转义后的安全文本
     */
    function escapeHtmlAttr(s){
        return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ==================== 扣分登记视图 ====================
    var addFormState={floorId:null,dormitoryId:null,studentId:null,hygieneItemIds:[],disciplineItemIds:[],hygieneScore:0,disciplineScore:0,recordDate:getTodayLocalStr(),remark:'',recordMode:'deduct',hygieneBonusItemIds:[],disciplineBonusItemIds:[],hygieneBonusScore:0,disciplineBonusScore:0};
    /**
     * 渲染「扣分登记」视图：班级/宿舍/床号联动选择、卫生/纪律扣分项勾选、
     * 实时扣分合计与提交按钮。PC 与移动端共用同一套数据、布局不同。
     * 勾选状态由 app.js 的 addFormState 维护（重绘后 restoreAddChecks 恢复）。
     * @param {HTMLElement} container - contentArea 容器
     */
    function renderAddView(container){
        // 生活老师楼层分工：楼层选择仅列出 assignedFloors 内楼层（为空=全部）
        var allowedFloors=getAssignedFloors();
        if(!addFormState.floorId || !allowedFloors.some(function(f){ return f.id===addFormState.floorId; })){
            addFormState.floorId = allowedFloors.length ? allowedFloors[0].id : (DB.floors[0] && DB.floors[0].id);
        }
        var dormitories=getDormitoriesByFloor(addFormState.floorId);
        if(dormitories.length>0&&!addFormState.dormitoryId) addFormState.dormitoryId=dormitories[0].id;
        if(addFormState.dormitoryId&&!getDormitoryById(addFormState.dormitoryId)) addFormState.dormitoryId=null;
        var students=getStudentsByDormitory(addFormState.dormitoryId);
        var isBonus = (addFormState.recordMode === 'bonus');
        // 时段规则：管理员不限，生活老师按账号配置
        var timeCat = getCurrentTimeCategory(currentUser);
        var showHygiene = (timeCat === 'both' || timeCat === 'hygiene');
        var showDiscipline = (timeCat === 'both' || timeCat === 'discipline');
        // 扣分模式项目
        var hyItems = isBonus ? (DB.deductionItems.hygieneBonus||[]) : (DB.deductionItems.hygiene||[]);
        var disItems = isBonus ? (DB.deductionItems.disciplineBonus||[]) : (DB.deductionItems.discipline||[]);
        var hyCls = isBonus ? 'hy-bonus-checkbox' : 'hy-item-checkbox';
        var disCls = isBonus ? 'dis-bonus-checkbox' : 'dis-item-checkbox';
        var hyCustomCls = isBonus ? 'hy-bonus-custom-check' : 'hy-custom-check';
        var disCustomCls = isBonus ? 'dis-bonus-custom-check' : 'dis-custom-check';
        var hyCustomNameId = isBonus ? 'hyBonusCustomName' : 'hyCustomName';
        var hyCustomWrapId = isBonus ? 'hyBonusCustomInputWrap' : 'hyCustomInputWrap';
        var disCustomNameId = isBonus ? 'disBonusCustomName' : 'disCustomName';
        var disCustomWrapId = isBonus ? 'disBonusCustomInputWrap' : 'disCustomInputWrap';
        var hyScoreId = isBonus ? 'hyBonusScore' : 'hyScore';
        var disScoreId = isBonus ? 'disBonusScore' : 'disScore';
        var hyScoreRestoreKey = isBonus ? 'hygieneBonusScore' : 'hygieneScore';
        var disScoreRestoreKey = isBonus ? 'disciplineBonusScore' : 'disciplineScore';
        var scorePrefix = isBonus ? '+' : '-';
        var scoreLabel = isBonus ? '加分' : '扣分';
        var defaultHyCustom = isBonus ? 0.2 : 0.2;
        var defaultDisCustom = isBonus ? 1 : 1;
        // 模式切换 UI
        var isMobile = window.innerWidth <= 768;
        var modeSwitchHtml;
        if(isMobile){
            // 移动端：两个并列大芯片
            modeSwitchHtml = '<div class="mode-chip-switch">'
                + '<div class="mode-chip'+(!isBonus?' active':'')+'" onclick="switchRecordMode(\'deduct\')">📉 扣分模式</div>'
                + '<div class="mode-chip'+(isBonus?' active':'')+'" onclick="switchRecordMode(\'bonus\')">📈 加分模式</div>'
                + '</div>';
        }else{
            // PC 端：Tab 风格
            modeSwitchHtml = '<div class="mode-tab-switch">'
                + '<div class="mode-tab'+(!isBonus?' active':'')+'" onclick="switchRecordMode(\'deduct\')">📉 扣分模式</div>'
                + '<div class="mode-tab'+(isBonus?' active':'')+'" onclick="switchRecordMode(\'bonus\')">📈 加分模式</div>'
                + '</div>';
        }
        var hySection = '';
        var disSection = '';
        if (showHygiene) {
            var hyCheckboxes=hyItems.map(function(i){return '<label><input type="checkbox" value="'+i.id+'" class="'+hyCls+'"> '+i.name+' ('+scorePrefix+i.defaultScore+'分)</label>';}).join('');
            hyCheckboxes+='<label><input type="checkbox" value="custom" class="'+hyCls+' '+hyCustomCls+'"> ✏️ 自定义('+defaultHyCustom+'分)</label>';
            hyCheckboxes+='<span id="'+hyCustomWrapId+'" style="display:none;margin-left:8px;"><input type="text" id="'+hyCustomNameId+'" placeholder="自定义项目名称" style="padding:4px 8px;border:1px dashed #ccc;border-radius:4px;"></span>';
            hySection = '<div class="form-group"><label>🧹 卫生'+scoreLabel+'（可多选）</label><div class="checkbox-group">'+hyCheckboxes+'</div><div style="margin-top:5px">卫生'+scoreLabel+'合计：<input type="number" id="'+hyScoreId+'" value="'+(addFormState[hyScoreRestoreKey]||0)+'" min="0" step="0.1" inputmode="decimal" style="width:80px;padding:4px" onchange="addFormChange(\''+hyScoreRestoreKey+'\')"> 分</div></div>';
        }
        if (showDiscipline) {
            var disCheckboxes=disItems.map(function(i){return '<label><input type="checkbox" value="'+i.id+'" class="'+disCls+'"> '+i.name+' ('+scorePrefix+i.defaultScore+'分)</label>';}).join('');
            disCheckboxes+='<label><input type="checkbox" value="custom" class="'+disCls+' '+disCustomCls+'"> ✏️ 自定义('+defaultDisCustom+'分)</label>';
            disCheckboxes+='<span id="'+disCustomWrapId+'" style="display:none;margin-left:8px;"><input type="text" id="'+disCustomNameId+'" placeholder="自定义项目名称" style="padding:4px 8px;border:1px dashed #ccc;border-radius:4px;"></span>';
            disSection = '<div class="form-group"><label>📏 纪律'+scoreLabel+'（可多选）</label><div class="checkbox-group">'+disCheckboxes+'</div><div style="margin-top:5px">纪律'+scoreLabel+'合计：<input type="number" id="'+disScoreId+'" value="'+(addFormState[disScoreRestoreKey]||0)+'" min="0" step="0.1" inputmode="decimal" style="width:80px;padding:4px" onchange="addFormChange(\''+disScoreRestoreKey+'\')"> 分</div></div>';
        }
        var submitLabel = isBonus ? '✅ 提交加分' : '✅ 提交扣分';
        var tailHtml='<div class="form-group"><label>备注</label><input type="text" id="addRemark" placeholder="可填写具体原因..." onchange="addFormChange(\'remark\')" value="'+(addFormState.remark||'')+'"></div><div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-primary" onclick="submitDeduction()">'+submitLabel+'</button><button class="btn btn-outline" onclick="resetAddForm()">🔄 重置</button></div>';
        if(isMobile){
            // ===== 移动端芯片式布局：楼层4/行均布 → 宿舍横滑 → 对象（加分模式仅宿舍集体） =====
            var floorChips=allowedFloors.map(function(f){
                return '<div class="chip'+(f.id===addFormState.floorId?' active':'')+'" onclick="mobilePickFloor('+f.id+')">'+f.name+'</div>';
            }).join('');
            var dormChips=dormitories.map(function(d){
                return '<div class="chip'+(d.id===addFormState.dormitoryId?' active':'')+'" onclick="mobilePickDorm('+d.id+')">'+d.roomNumber+'</div>';
            }).join('')||'<span style="color:#aaa;font-size:0.9286rem">该楼层暂无宿舍</span>';
            var targetChips;
            if(isBonus){
                // 加分模式：只显示宿舍集体
                var dorm=getDormitoryById(addFormState.dormitoryId);
                var dormLabel = dorm ? dorm.roomNumber : '';
                targetChips='<div class="chip active">🏠 '+dormLabel+'宿舍集体</div>';
            }else{
                targetChips='<div class="chip'+(addFormState.studentId===null?' active':'')+'" onclick="mobilePickTarget(this,null)">🏠 宿舍集体</div>'
                    +students.map(function(s){
                        return '<div class="chip'+(addFormState.studentId===s.id?' active':'')+'" onclick="mobilePickTarget(this,'+s.id+')">'+s.name+'</div>';
                    }).join('');
            }
            container.innerHTML='<div class="content-header"><h2>📝 '+(isBonus?'加分':'扣分')+'登记</h2></div><div class="card"><div class="card-header">'+modeSwitchHtml+'<span style="margin-top:8px;display:block">填写信息</span></div><div class="card-body">'
                +'<div class="form-group"><label>🏢 选择楼层 *</label><div class="chip-floors">'+floorChips+'</div></div>'
                +'<div class="form-group"><label>🚪 选择宿舍号 * <span style="font-weight:400;font-size:0.8571rem;color:var(--gray-500)">左右滑动查看更多</span></label><div class="chip-dorms">'+dormChips+'</div></div>'
                +'<div class="form-group"><label>👤 '+(isBonus?'加分对象（宿舍集体）':'扣分对象 *')+'</label><div class="chip-targets">'+targetChips+'</div></div>'
                +'<div class="form-group"><label>'+(isBonus?'加分':'扣分')+'日期 *</label><input type="text" class="date-picker" id="addDate" value="'+addFormState.recordDate+'" onchange="addFormChange(\'date\')"></div>'
                +hySection+disSection+tailHtml
                +'</div></div>';
        }else{
            // ===== 桌面端：下拉框 + 复选框布局 =====
            var floorOpts=allowedFloors.map(function(f){return '<option value="'+f.id+'" '+(f.id===addFormState.floorId?'selected':'')+'>'+f.name+'</option>';}).join('');
            var dormOpts=dormitories.map(function(d){return '<option value="'+d.id+'" '+(d.id===addFormState.dormitoryId?'selected':'')+'>'+d.roomNumber+'</option>';}).join('');
            var stuOpts;
            if(isBonus){
                var dorm=getDormitoryById(addFormState.dormitoryId);
                var dormLabel=dorm?dorm.roomNumber:'';
                stuOpts='<option value="" selected>🏠 '+dormLabel+'宿舍集体</option>';
            }else{
                stuOpts='<option value="">🏠 宿舍集体</option>'+students.map(function(s){return '<option value="'+s.id+'" '+(addFormState.studentId===s.id?'selected':'')+'>'+s.name+'（'+(s.className||'')+'）床号'+(s.bedNumber||'-')+'</option>';}).join('');
            }
            container.innerHTML='<div class="content-header"><h2>📝 '+(isBonus?'加分':'扣分')+'登记</h2></div><div class="card"><div class="card-header">'+modeSwitchHtml+'</div><div class="card-body"><div class="form-row"><div class="form-group"><label>楼层 *</label><select id="addFloor" onchange="addFormChange(\'floor\')">'+floorOpts+'</select></div><div class="form-group"><label>宿舍号 *</label><select id="addDormitory" onchange="addFormChange(\'dorm\')">'+dormOpts+'</select></div></div><div class="form-row"><div class="form-group"><label>'+(isBonus?'加分对象':'扣分对象 *')+'</label><select id="addStudent" onchange="addFormChange(\'student\')" '+(isBonus?'disabled':'')+'>'+stuOpts+'</select></div><div class="form-group"><label>'+(isBonus?'加分':'扣分')+'日期 *</label><input type="text" class="date-picker" id="addDate" value="'+addFormState.recordDate+'" onchange="addFormChange(\'date\')"></div></div>'+hySection+disSection+tailHtml+'</div></div>';
        }
        // 绑定复选框事件（加分/扣分模式共用同一套类名逻辑）
        if (showHygiene) bindCheckboxEventsGeneric(isBonus?'hy-bonus':'hy');
        if (showDiscipline) bindCheckboxEventsGeneric(isBonus?'dis-bonus':'dis');
        if (showHygiene) bindCustomCheckboxEventsGeneric(isBonus?'hy-bonus':'hy');
        if (showDiscipline) bindCustomCheckboxEventsGeneric(isBonus?'dis-bonus':'dis');
        // 恢复切换楼层/宿舍前已勾选的扣分项目，并重算合计
        restoreAddChecks();
        recomputeAddScores();
        initDatePickers(document);
        var actChip=document.querySelector('.chip-dorms .chip.active');
        if(actChip&&actChip.scrollIntoView){try{actChip.scrollIntoView({inline:'center',block:'nearest'});}catch(e){}}
    }

    // ==================== 巡查核实视图 ====================
    /**
     * 将 YYYY-MM-DD 格式化为总结标题用中文日期（如 "9月9号 周三晚"）。
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
    // 巡查类型标签样式
    var INSPECTION_TAG_CLS = { leave:'status-tag status-orange', stop:'status-tag status-blue', absence:'status-tag status-blue', picked_up:'status-tag status-orange', no_note:'status-tag status-red' };
    function inspectionTagCls(t){ return INSPECTION_TAG_CLS[t] || 'status-tag'; }

    /**
     * 渲染「巡查核实」视图（仅 STAFF/ADMIN）：
     * 顶部历史日期查询 + 四张统计卡（待核实总数/已确认/待确认/异常数）+
     * 按楼层→宿舍分组的待核实学生列表（确认按钮/异常上报按钮）+
     * 晚检总结卡（今日待确认为 0 自动生成；历史日期只读，支持导出 Excel）。
     * @param {HTMLElement} container - contentArea 容器
     */
    function renderInspectionView(container){
        if(!currentUser || (currentUser.role!=='STAFF' && currentUser.role!=='ADMIN')){
            container.innerHTML='<div class="empty-state">无权限</div>';
            return;
        }
        var today=getTodayLocalStr();
        var date=(typeof inspectionState!=='undefined' && inspectionState.viewDate) || today;
        var isToday=(date===today);
        var floorIds=getAssignedFloorIds();
        var items=getInspectionItems(date, floorIds);
        var anomalies=getInspectionAnomalies(date, floorIds);
        var confirmedCount=0;
        items.forEach(function(it){ if(getInspectionConfirmation(it.recordType, it.recordId, date)) confirmedCount++; });
        var pendingCount=items.length-confirmedCount;

        // —— 历史日期查询卡 ——
        var html='<div class="content-header"><h2>👀 巡查核实</h2></div>';
        html+='<div class="card"><div class="card-header">📅 晚检总结查询</div><div class="card-body"><div class="filter-section">'
            +'<div class="form-group"><label>选择日期</label><input type="text" class="date-picker" id="inspectionHistoryDate" value="'+date+'" onchange="onInspectionHistoryDate()"></div>'
            +'<button class="btn btn-primary" onclick="onInspectionHistoryDate()">🔍 查看该日</button>'
            +(isToday?'':'<button class="btn btn-outline" onclick="backToInspectionToday()">↩️ 返回今日</button>')
            +(isToday?'':'<span style="color:var(--gray-500);font-size:0.8571rem;align-self:center">历史日期为只读模式</span>')
            +'</div></div></div>';

        // —— 统计卡片 ——
        html+='<div class="stat-cards-mobile inspection-stat-cards">'
            +'<div class="stat-item"><div class="number" style="color:#4f6ef7">'+items.length+'</div><div class="label">📋 待核实总数</div></div>'
            +'<div class="stat-item"><div class="number" style="color:#34c759">'+confirmedCount+'</div><div class="label">✅ 已确认</div></div>'
            +'<div class="stat-item"><div class="number" style="color:#ff9500">'+pendingCount+'</div><div class="label">⏳ 待确认</div></div>'
            +'<div class="stat-item"><div class="number" style="color:#ff3b30">'+anomalies.length+'</div><div class="label">⚠️ 异常上报</div></div>'
            +'<div class="stat-item stat-item-action" onclick="openAnomalyModal(0)" role="button" tabindex="0">'
            +'<div class="number" style="color:#ff3b30;font-size:1.4286rem">⚠️</div>'
            +'<div class="label" style="font-weight:700">异常上报</div>'
            +'<div style="font-size:0.7857rem;color:#ff3b30;margin-top:2px">点击上报</div>'
            +'</div>'
            +'</div>';

        // —— 按楼层→宿舍分组 ——
        var floorMap={};
        function roomBucket(fid, room){
            if(!floorMap[fid]) floorMap[fid]={ floor:getFloorById(fid), rooms:{} };
            if(!floorMap[fid].rooms[room]) floorMap[fid].rooms[room]={ items:[], anomalies:[], dormitoryId:null };
            return floorMap[fid].rooms[room];
        }
        items.forEach(function(it){
            var fid=resolveRecordFloorId(it.dormitoryId, it.room);
            if(fid==null) return;
            var bucket=roomBucket(fid, it.room||'未知');
            bucket.items.push(it);
            if(it.dormitoryId) bucket.dormitoryId=it.dormitoryId;
            else if(!bucket.dormitoryId){ var d=getDormitoryByRoomNumber(it.room); if(d) bucket.dormitoryId=d.id; }
        });
        anomalies.forEach(function(a){
            var fid=resolveRecordFloorId(a.dormitoryId, a.dormitoryRoom);
            if(fid==null) return;
            var bucket=roomBucket(fid, a.dormitoryRoom||'未知');
            bucket.anomalies.push(a);
            if(a.dormitoryId) bucket.dormitoryId=a.dormitoryId;
        });
        var floorIdsSorted=Object.keys(floorMap).map(Number).sort(function(a,b){
            var fa=floorMap[a].floor, fb=floorMap[b].floor;
            return ((fa&&fa.sortOrder)||a)-((fb&&fb.sortOrder)||b);
        });
        if(floorIdsSorted.length===0){
            html+='<div class="card"><div class="card-body" style="text-align:center;color:var(--gray-500);padding:24px">'+(isToday?'今日负责楼层暂无请假/停宿/退宿待核实学生':'该日暂无巡查记录')+'</div></div>';
        }
        floorIdsSorted.forEach(function(fid){
            var fg=floorMap[fid];
            html+='<div class="content-header" style="margin-top:14px"><h2 style="font-size:1.1rem">🏢 '+((fg.floor&&fg.floor.name)||('楼层'+fid))+'</h2></div>';
            var roomKeys=Object.keys(fg.rooms).sort();
            roomKeys.forEach(function(room){
                var bucket=fg.rooms[room];
                html+='<div class="card"><div class="card-header">🚪 '+room+' 宿舍</div><div class="card-body" style="padding:10px 14px">';
                bucket.items.forEach(function(it){
                    var conf=getInspectionConfirmation(it.recordType, it.recordId, date);
                    var timeRange=it.startDate&&it.endDate ? (it.startDate===it.endDate?it.startDate:it.startDate+' ~ '+it.endDate) : '';
                    html+='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--gray-100);flex-wrap:wrap">'
                        +'<div style="min-width:0"><b>'+escapeHtmlAttr(it.name||'')+'</b> <span class="'+inspectionTagCls(it.recordType)+'">'+(INSPECTION_TYPE_LABELS[it.recordType]||'')+'</span>'
                        +'<div style="color:var(--gray-500);font-size:0.8571rem;margin-top:2px">'+escapeHtmlAttr(it.className||'-')+' · 床号'+escapeHtmlAttr(it.bed||'-')+(timeRange?' · '+timeRange:'')+'</div></div>'
                        +'<div style="flex-shrink:0">'
                        +(conf
                            ? '<span class="status-tag status-blue">✅ 已确认（'+escapeHtmlAttr(conf.confirmedByName||'')+'）</span>'
                            : (isToday
                                ? '<button class="btn btn-primary btn-xs" onclick="confirmInspection(\''+it.recordType+'\',\''+String(it.recordId).replace(/'/g,'')+'\')">✅ 确认属实</button>'
                                : '<span class="status-tag" style="background:var(--gray-100);color:var(--gray-500)">⏳ 待确认</span>'))
                        +'</div></div>';
                });
                bucket.anomalies.forEach(function(a){
                    html+='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--gray-100);flex-wrap:wrap">'
                        +'<div style="min-width:0"><b>'+escapeHtmlAttr(a.studentName||'')+'</b> <span class="'+inspectionTagCls(a.anomalyType)+'">'+(a.anomalyType==='picked_up'?'家长接走':'无假条')+'</span>'
                        +'<div style="color:var(--gray-500);font-size:0.8571rem;margin-top:2px">'+escapeHtmlAttr(a.className||'-')+' · 床号'+escapeHtmlAttr(a.bed||'-')+' · 上报人：'+escapeHtmlAttr(a.reportedByName||'-')+(a.note?' · '+escapeHtmlAttr(a.note):'')+'</div></div>'
                        +'<div style="flex-shrink:0"><span class="status-tag status-red">⚠️ 异常</span></div></div>';
                });
                if(isToday){
                    html+='<div style="margin-top:10px"><button class="btn btn-danger btn-xs" onclick="openAnomalyModal('+(bucket.dormitoryId||0)+')">⚠️ 异常上报</button></div>';
                }
                html+='</div></div>';
            });
        });

        // —— 晚检总结 ——
        if(isToday){
            if(pendingCount===0){
                var sum=ensureTodaySummary(); // app.js：待确认为 0 时落库/更新今日总结并返回
                html+=buildInspectionSummaryHtml(sum, date, true, false);
            }else{
                html+='<div class="card"><div class="card-body" style="text-align:center;color:var(--gray-500);padding:20px">还有 <b style="color:var(--warning)">'+pendingCount+'</b> 名学生待核实，全部确认后将自动生成今日晚检总结</div></div>';
            }
        }else{
            var stored=getDailySummary(date, currentUser.id);
            var histSum=stored || computeInspectionSummary(date, currentUser);
            html+=buildInspectionSummaryHtml(histSum, date, false, !stored);
        }
        container.innerHTML=html;
        initDatePickers(document);
    }

    /**
     * 拼装晚检总结卡片 HTML（今日/历史共用；历史重算时标注"只读"）。
     * @param {object} sum - computeInspectionSummary 返回的总结数据
     * @param {string} date - 总结日期
     * @param {boolean} isToday - 是否今日
     * @param {boolean} isRecomputed - 历史日期无存档、按记录重算
     * @returns {string}
     */
    function buildInspectionSummaryHtml(sum, date, isToday, isRecomputed){
        var floorNums=(sum.floors||[]).map(function(fid){ var f=getFloorById(fid); return f?f.sortOrder:fid; }).sort(function(a,b){return a-b;});
        var building=sum.buildingName || '本楼';
        function line(label,val,color){ return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:1.02rem"><span>'+label+'</span><b style="color:'+(color||'var(--text)')+'">'+val+'人</b></div>'; }
        function detailTable(title, list, columns, emptyText){
            var h='<div style="margin-top:12px"><div style="font-weight:700;margin-bottom:6px">'+title+'（'+list.length+'人）</div>';
            if(list.length===0){ h+='<div style="color:var(--gray-500);font-size:0.8571rem">'+(emptyText||'无')+'</div></div>'; return h; }
            h+='<div style="overflow-x:auto"><table style="font-size:0.9rem"><thead><tr>'+columns.map(function(c){return '<th>'+c.label+'</th>';}).join('')+'</tr></thead><tbody>';
            list.forEach(function(row){
                h+='<tr>'+columns.map(function(c){ return '<td>'+escapeHtmlAttr(row[c.key]==null?'-':String(row[c.key]))+'</td>'; }).join('')+'</tr>';
            });
            return h+'</tbody></table></div></div>';
        }
        var html='<div class="card" style="margin-top:16px;border:2px solid var(--primary)">'
            +'<div class="card-header">📊 '+(isToday?'今日晚检总结':'晚检总结（历史只读）')+'（'+formatInspectionDateTitle(date)+'）</div>'
            +'<div class="card-body">'
            +'<div style="font-weight:700;font-size:1.05rem">'+escapeHtmlAttr(building)+'：'+floorNums.join('、')+'楼</div>'
            +'<div style="border-top:1px dashed var(--gray-200);margin:8px 0"></div>'
            +'<div class="summary-split">'
            +'<div class="summary-stats-col">'
            +line('入宿人数', sum.totalStudents)
            +line('当天请假', sum.absenceCount, '#4f6ef7')
            +line('退宿/停宿中', sum.leavePendingCount, '#ff9500')
            +line('家长接走', sum.pickedUpCount, '#a855f7')
            +line('无假条', sum.anomalyCount, '#ff3b30')
            +line('实到人数', sum.actualCount, '#34c759')
            +'<div style="margin-top:12px"><button class="btn btn-primary" onclick="copyInspectionSummary(\''+date+'\')">📋 一键复制总结</button></div>'
            +(isRecomputed?'<p style="color:var(--gray-500);font-size:0.8571rem;margin-top:8px">该日无存档总结，以上为按当日记录重新计算（历史数据不可修改）。</p>':'')
            +'</div>'
            +'<div class="summary-detail-col">'
            +detailTable('📋 退宿/停宿中学生详情', sum.leavePendingDetails||[], [
                {key:'name',label:'姓名'},{key:'className',label:'班级'},{key:'bed',label:'床号'},{key:'dormitory',label:'宿舍'},{key:'type',label:'类型'},{key:'startDate',label:'开始'},{key:'endDate',label:'结束'}
            ])
            +detailTable('🚗 家长接走学生详情', sum.pickedUpDetails||[], [
                {key:'name',label:'姓名'},{key:'className',label:'班级'},{key:'bed',label:'床号'},{key:'dormitory',label:'宿舍'},{key:'confirmedBy',label:'确认人'},{key:'note',label:'备注'}
            ])
            +detailTable('⚠️ 无假条学生详情', sum.anomalyDetails||[], [
                {key:'name',label:'姓名'},{key:'className',label:'班级'},{key:'bed',label:'床号'},{key:'dormitory',label:'宿舍'},{key:'reportedBy',label:'上报人'},{key:'note',label:'备注'}
            ])
            +'</div>'
            +'</div>'
            +'</div></div>';
        return html;
    }

    // ==================== 统计报表视图 ====================
    /**
     * 渲染「统计报表」视图：全校宿舍排行榜（默认前 20，可展开全部）+
     * 楼层扣分情况（芯片切换楼层）+ 各楼层详情折叠卡。
     * 所有大列表写骨架后分片填充（#statsDormTbody/#statsDormCards/#statsFloorRows/
     * statsFloorLowTbody-*）；statsCache 缓存"骨架函数 + fill 函数"配对，
     * 展开/切楼层/重绘后必须调用对应 fill（fillStatsDormList/fillStatsFloorDetail）。
     * @param {HTMLElement} container - contentArea 容器
     */
    function renderStatsView(container){
        var allRecords = DB.deductionRecords;
        var total = getTotalScore(allRecords);
        // 楼层排名：扣分从高到低，同分按楼层原顺序（稳定排序）
        var floorStats = DB.floors.map(function(f){ var r=getRecordsByFloor(f.id); return {id:f.id,name:f.name,score:getTotalScore(r),count:r.length}; }).sort(function(a,b){return b.score-a.score;});
        // 全校宿舍排行：扣分从高到低，同分按宿舍号升序（含 0 分宿舍，排名连续）；已删除的宿舍号不参与排行
        var dormStatsAll = [];
        DB.dormitories.forEach(function(d){
            if(isDormitoryDeleted(d.roomNumber)) return;
            var r = getRecordsByDormitory(d.id);
            var score = getTotalScore(r);
            dormStatsAll.push({ roomNumber: d.roomNumber, name: d.roomNumber + ' (' + getFloorById(d.floorId).name + ')', className: getDormitoryClassName(d.id), score: score, count: r.length });
        });
        dormStatsAll.sort(function(a,b){ if(a.score!==b.score) return b.score-a.score; return a.roomNumber.localeCompare(b.roomNumber,'zh-Hans-CN',{numeric:true}); });
        statsCache.dormAll = dormStatsAll;
        // 楼层条形图（两端共用）
        var floorBarsHtml = floorStats.map(function(f,i){ var max=floorStats[0].score||1; var pct=max>0?(f.score/max*100):0; var colors=['#4f6ef7','#7c5cfc','#a855f7','#ec4899','#f43f5e','#f97316','#eab308','#22c55e']; return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><span style="font-weight:700;width:30px">#'+(i+1)+'</span><span style="width:50px">'+f.name+'</span><div style="flex:1;height:22px;background:#f0f0f0;border-radius:11px;overflow:hidden;"><div style="height:100%;width:'+pct+'%;background:'+colors[i%colors.length]+';border-radius:11px;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;"><span style="color:#fff;font-size:0.7857rem;font-weight:700">'+f.score+'分</span></div></div><span style="min-width:40px;font-size:0.8571rem;color:#6b7280;">'+f.count+'条</span></div>'; }).join('');
        // 全校宿舍排行榜：默认 TOP20，可展开全部（含 0 分）
        // PC 端表格行（供分片渲染逐条调用）
        function dormRankRowHtml(d, i){
            return '<tr><td data-label="排名">'+(i+1)+'</td><td data-label="宿舍"><b>'+d.name+'</b></td><td data-label="班级">'+(d.className||'-')+'</td><td data-label="扣分" class="highlight-red">'+d.score+'</td><td data-label="记录数">'+d.count+'</td></tr>';
        }
        // 移动端卡片行（复用 dorm-row-mobile / rank-item 样式，供分片渲染逐条调用）
        function dormRankCardHtml(item, idx){
            var rank = idx+1;
            var topCls = rank<=3 ? ' top' : '';
            var scoreHas = item.score>0 ? ' has' : '';
            return '<div class="dorm-row-mobile">'
                + '<div class="rank-item rank-idx-1'+topCls+'"><span class="rank-label">排名</span><span class="rank-value">#'+rank+'</span></div>'
                + '<div class="rank-item rank-idx-2"><span class="rank-label">宿舍</span><span class="rank-value">'+item.roomNumber+'</span></div>'
                + '<div class="rank-item rank-idx-3"><span class="rank-label">班级</span><span class="rank-value">'+(item.className||'—')+'</span></div>'
                + '<div class="rank-item rank-idx-4"><span class="rank-label">扣分</span><span class="rank-value'+scoreHas+'">'+item.score+'分</span></div>'
                + '<div class="rank-item rank-idx-5"><span class="rank-label">记录数</span><span class="rank-value">'+item.count+'条</span></div>'
                + '</div>';
        }
        // 排行榜骨架（空容器，列表内容由 fillStatsDormList 分片填充）
        function dormSectionHtml(){
            var btn = dormStatsAll.length>20
                ? '<div style="text-align:center;padding:10px 14px 14px"><button class="btn btn-primary btn-sm" onclick="toggleStatsDormAll()">'+(statsDormExpandAll?'收起':'展开查看全部（共'+dormStatsAll.length+'个宿舍）')+'</button></div>'
                : '';
            if(window.innerWidth<=768){
                return '<div style="padding:2px 0"><div id="statsDormCards"></div></div>'+btn;
            }
            return '<div style="overflow-x:auto"><table><thead><tr><th>排名</th><th>宿舍</th><th>班级</th><th>扣分</th><th>记录数</th></tr></thead><tbody id="statsDormTbody"></tbody></table></div>'+btn;
        }
        // 排行榜数据分片填充（初次渲染 / 展开收起切换后调用）
        function fillStatsDormList(){
            var list = statsDormExpandAll ? dormStatsAll : dormStatsAll.slice(0,20);
            var tb=document.getElementById('statsDormTbody');
            if(tb) renderListInChunks(tb, list, dormRankRowHtml, 50, null, {emptyHtml:'<tr><td colspan="5" style="text-align:center;color:#aaa">暂无数据</td></tr>'});
            var cd=document.getElementById('statsDormCards');
            if(cd) renderListInChunks(cd, list, dormRankCardHtml, 50, null, {emptyHtml:'<div class="empty-state" style="padding:24px">暂无数据</div>'});
        }
        statsCache.dormSectionHtml = dormSectionHtml;
        statsCache.fillDormList = fillStatsDormList;
        // 楼层扣分情况：单楼层全部宿舍（含 0 分），扣分从低到高、同分按宿舍号升序；芯片切换楼层
        if(!statsFloorPickId || !getFloorById(statsFloorPickId)) statsFloorPickId = DB.floors[0] ? DB.floors[0].id : null;
        // 当前选中楼层的排行数据
        function getFloorDetailList(){
            var roomsInFloor = getDormitoriesByFloor(statsFloorPickId);
            var dormList = roomsInFloor.map(function(d){
                var r = getRecordsByDormitory(d.id);
                return { roomNumber: d.roomNumber, className: getDormitoryClassName(d.id), score: getTotalScore(r), count: r.length };
            });
            // 扣分从低到高排序（扣分少在前），同分按宿舍号升序
            dormList.sort(function(a,b){ if(a.score !== b.score) return a.score - b.score; return a.roomNumber.localeCompare(b.roomNumber,'zh-Hans-CN',{numeric:true}); });
            return dormList;
        }
        // 楼层详情卡片行（供分片渲染逐条调用）
        function floorDetailCardHtml(item, idx){
            var rank = idx+1;
            var topCls = rank<=3 ? ' top' : '';
            var scoreHas = item.score>0 ? ' has' : '';
            return '<div class="dorm-row-mobile">'
                + '<div class="rank-item rank-idx-1'+topCls+'"><span class="rank-label">排名</span><span class="rank-value">#'+rank+'</span></div>'
                + '<div class="rank-item rank-idx-2"><span class="rank-label">宿舍</span><span class="rank-value">'+item.roomNumber+'</span></div>'
                + '<div class="rank-item rank-idx-3"><span class="rank-label">班级</span><span class="rank-value">'+(item.className||'—')+'</span></div>'
                + '<div class="rank-item rank-idx-4"><span class="rank-label">扣分</span><span class="rank-value'+scoreHas+'">'+item.score+'分</span></div>'
                + '<div class="rank-item rank-idx-5"><span class="rank-label">记录数</span><span class="rank-value">'+item.count+'条</span></div>'
                + '</div>';
        }
        // 楼层详情骨架（芯片 + 空容器，内容由 fillStatsFloorDetail 分片填充）
        function floorDetailHtml(){
            var floorChips = DB.floors.map(function(f2){
                return '<div class="chip'+(f2.id===statsFloorPickId?' active':'')+'" onclick="selectStatsFloor('+f2.id+')">'+f2.name+'</div>';
            }).join('');
            return '<div style="padding:8px 2px 4px"><div class="chip-floors-scroll">'+floorChips+'</div></div>'
                + '<div id="statsFloorRows" style="padding:10px 0 4px"></div>';
        }
        // 楼层详情数据分片填充（初次渲染 / 切换楼层后调用）
        function fillStatsFloorDetail(){
            var el=document.getElementById('statsFloorRows');
            if(el) renderListInChunks(el, getFloorDetailList(), floorDetailCardHtml, 50, null, {emptyHtml:'<div class="empty-state" style="padding:24px">该楼层暂无宿舍</div>'});
        }
        statsCache.floorDetailHtml = floorDetailHtml;
        statsCache.fillFloorDetail = fillStatsFloorDetail;
        // 各楼层独立详情卡（PC 端保留原有样式）；tbody 留空，渲染后分片填充
        var floorDormLowTables = '';
        var floorLowFillJobs = []; // {tbId, list} 供 container.innerHTML 落 DOM 后分片渲染
        DB.floors.forEach(function(f){
            var roomsInFloor = getDormitoriesByFloor(f.id);
            var dormList = roomsInFloor.map(function(d){
                var r = getRecordsByDormitory(d.id);
                var score = getTotalScore(r);
                return { roomNumber: d.roomNumber, className: getDormitoryClassName(d.id), score: score, count: r.length };
            });
            dormList.sort(function(a,b){ if(a.score !== b.score) return a.score - b.score; return a.roomNumber.localeCompare(b.roomNumber,'zh-Hans-CN',{numeric:true}); });
            var tbId = 'statsFloorLowTbody-'+f.id;
            floorLowFillJobs.push({ tbId: tbId, list: dormList });
            floorDormLowTables += '<div class="card" style="margin-bottom:16px;"><div class="card-header">📉 '+f.name+' · 扣分少的宿舍排名</div><div style="overflow-x:auto;"><table><thead><tr><th>排名</th><th>宿舍</th><th>班级</th><th>扣分</th><th>记录数</th></tr></thead><tbody id="'+tbId+'"></tbody></table></div></div>';
        });
        // 折叠块骨架（开合状态跨重渲染保持）；局部刷新区（排行榜/楼层详情）仅替换 wrap 内部，不影响折叠状态
        function foldBlock(id, title, bodyHtml){
            return '<div class="fold-block'+(foldState[id]?' open':'')+'" id="'+id+'"><div class="fold-header" onclick="toggleFold(\''+id+'\')">'+title+'<span class="fold-arrow">▶</span></div><div class="fold-body">'+bodyHtml+'</div></div>';
        }
        var topTitle = '🏠 全校宿舍排行榜' + (statsDormExpandAll ? '<span class="fold-sub">全部'+dormStatsAll.length+'个</span>' : '<span class="fold-sub">TOP20</span>');
        var topBody = '<div id="statsDormWrap">'+dormSectionHtml()+'</div>';
        // 净分排行榜：净分 = 扣分 - 加分，从高到低
        var netStatsAll = dormStatsAll.map(function(d){
            var dormObj = DB.dormitories.find(function(dm){ return dm.roomNumber===d.roomNumber; });
            var recs = dormObj ? getRecordsByDormitory(dormObj.id) : [];
            var bonus = getTotalBonusScore(recs);
            var deduct = getTotalDeductScore(recs);
            var net = Math.round((deduct - bonus) * 10) / 10;
            return { roomNumber: d.roomNumber, name: d.name, className: d.className, deduct: deduct, bonus: bonus, net: net, count: d.count };
        });
        netStatsAll.sort(function(a,b){ if(a.net !== b.net) return b.net - a.net; return a.roomNumber.localeCompare(b.roomNumber,'zh-Hans-CN',{numeric:true}); });
        function netDormRowHtml(d, i){
            var netCls = d.net > 0 ? 'highlight-red' : (d.net < 0 ? 'highlight-green' : '');
            return '<tr><td data-label="排名">'+(i+1)+'</td><td data-label="宿舍"><b>'+d.name+'</b></td><td data-label="班级">'+(d.className||'-')+'</td><td data-label="扣分" class="highlight-red">'+d.deduct+'</td><td data-label="加分" class="highlight-green">'+d.bonus+'</td><td data-label="净分" class="'+netCls+'"><b>'+d.net+'</b></td><td data-label="记录数">'+d.count+'</td></tr>';
        }
        function netDormCardHtml(d, idx){
            var netColor = d.net > 0 ? '#ff3b30' : (d.net < 0 ? '#34c759' : '#9ca3af');
            return '<div class="dorm-row-mobile">'
                + '<div class="rank-item rank-idx-1"><span class="rank-label">排名</span><span class="rank-value">#'+(idx+1)+'</span></div>'
                + '<div class="rank-item rank-idx-2"><span class="rank-label">宿舍</span><span class="rank-value">'+d.roomNumber+'</span></div>'
                + '<div class="rank-item rank-idx-3"><span class="rank-label">班级</span><span class="rank-value">'+(d.className||'—')+'</span></div>'
                + '<div class="rank-item rank-idx-4"><span class="rank-label">扣分</span><span class="rank-value has">'+d.deduct+'分</span></div>'
                + '<div class="rank-item rank-idx-5"><span class="rank-label">加分</span><span class="rank-value" style="color:#34c759">'+d.bonus+'分</span></div>'
                + '<div class="rank-item rank-idx-6" style="flex:0 0 100%;border-right:none;border-top:1px dashed #e5e7eb;margin-top:4px;padding-top:6px"><span class="rank-label">净分</span><span class="rank-value" style="color:'+netColor+';font-size:1.2857rem"><b>'+d.net+'分</b></span></div>'
                + '</div>';
        }
        var netList = netStatsAll.slice(0, 20);
        var netBody;
        if(window.innerWidth <= 768){
            netBody = '<div id="statsNetCards">'+netList.map(netDormCardHtml).join('')+'</div>';
        }else{
            netBody = '<div style="overflow-x:auto"><table><thead><tr><th>排名</th><th>宿舍</th><th>班级</th><th>扣分</th><th>加分</th><th>净分</th><th>记录数</th></tr></thead><tbody>'+netList.map(netDormRowHtml).join('')+'</tbody></table></div>';
        }
        var mobileDetailBody = '<div id="statsFloorDetailWrap">'+floorDetailHtml()+'</div>';
        var pcDetailBody = '<div style="padding:14px">'+floorDormLowTables+'</div>';
        container.innerHTML = '<div class="content-header"><h2>📊 统计报表</h2></div>'
            + '<div class="stat-cards"><div class="stat-card"><div class="number">'+allRecords.length+'</div><div class="label">总扣分记录</div></div><div class="stat-card warning"><div class="number">'+total+'</div><div class="label">总扣分</div></div><div class="stat-card danger"><div class="number">'+dormStatsAll.filter(function(d){return d.score>0;}).length+'</div><div class="label">有扣分宿舍</div></div></div>'
            + foldBlock('fold-stats-floor','🏆 楼层扣分排名','<div style="padding:18px">'+floorBarsHtml+'</div>')
            + foldBlock('fold-stats-top', topTitle, topBody)
            + foldBlock('fold-stats-net','📊 净分排行榜 <span class="fold-sub">TOP20（净分=扣分-加分）</span>', netBody)
            + (window.innerWidth<=768
                ? foldBlock('fold-stats-detail','📉 楼层扣分情况', mobileDetailBody)
                : foldBlock('fold-stats-detail','📉 各楼层扣分详情', pcDetailBody));
        // 列表分片填充：排行榜、楼层详情、各楼层详情卡（折叠状态不受影响，隐藏容器内照样填充）
        fillStatsDormList();
        fillStatsFloorDetail();
        var floorLowEmpty='<tr><td colspan="5" style="text-align:center;color:#aaa">暂无数据</td></tr>';
        floorLowFillJobs.forEach(function(job){
            var tb=document.getElementById(job.tbId);
            if(tb) renderListInChunks(tb, job.list, function(item, idx){
                return '<tr><td data-label="排名">'+(idx+1)+'</td><td data-label="宿舍">'+item.roomNumber+'</td><td data-label="班级">'+item.className+'</td><td data-label="扣分">'+item.score+'</td><td data-label="记录数">'+item.count+'</td></tr>';
            }, 50, null, {emptyHtml:floorLowEmpty});
        });
    }
    // 统计报表交互状态：排行榜展开全部 / 楼层扣分情况当前楼层（跨重渲染保持）
    var statsDormExpandAll=false;
    var statsFloorPickId=null;
    var statsCache={};
    /**
     * 排行榜"展开/收起全部"切换：翻转展开标志、重写排行榜区块骨架并重新分片填充。
     */
    function toggleStatsDormAll(){
        statsDormExpandAll=!statsDormExpandAll;
        var w=document.getElementById('statsDormWrap');
        if(w && statsCache.dormSectionHtml) w.innerHTML=statsCache.dormSectionHtml();
        // 骨架替换后重新分片填充排行榜
        if(statsCache.fillDormList) statsCache.fillDormList();
        // 同步折叠头部的 TOP20/全部 副标题
        var head=document.querySelector('#fold-stats-top .fold-header');
        if(head){
            var sub=head.querySelector('.fold-sub');
            var total=statsCache.dormAll?statsCache.dormAll.length:0;
            if(sub) sub.textContent=statsDormExpandAll?('全部'+total+'个'):'TOP20';
        }
    }
    /**
     * 楼层扣分情况：切换选中楼层芯片，重写骨架并重新分片填充该楼层明细。
     * @param {number} fid - 楼层 ID
     */
    function selectStatsFloor(fid){
        statsFloorPickId=fid;
        var w=document.getElementById('statsFloorDetailWrap');
        if(w && statsCache.floorDetailHtml) w.innerHTML=statsCache.floorDetailHtml();
        // 骨架替换后重新分片填充楼层详情
        if(statsCache.fillFloorDetail) statsCache.fillFloorDetail();
    }

    // ==================== 学生名单管理视图 ====================
    /**
     * 渲染「学生名单」视图：检索栏（班级/姓名/住宿状态）+ 全选 checkbox +
     * 学生表格（#studentsTbody 分片渲染）+ 批量删除/新增/导入入口。
     * checkbox 勾选采用 tbody change 事件委托（分片插入的行无需重新绑定）；
     * 分片完成回调中同步计数与全选框状态。
     * @param {HTMLElement} container - contentArea 容器
     */
    function renderStudentsView(container){
        if(!isAdmin()){container.innerHTML='<div class="empty-state">无权限</div>';return;}
        // 宿舍下拉仅显示生效宿舍号（已删除的不再出现）
        var activeDorms = (DB.dormitories||[]).filter(function(d){ return isDormitoryDeleted(d.roomNumber)===false; });
        activeDorms.sort(function(a,b){ return String(a.roomNumber).localeCompare(String(b.roomNumber),'zh-Hans-CN',{numeric:true}); });
        var dormOpts=activeDorms.map(function(d){return '<option value="'+d.id+'">'+d.roomNumber+'（'+getFloorById(d.floorId).name+'）</option>';}).join('');
        // 检索：班级下拉 + 姓名输入（datalist 按班级联动）
        var classSet={}; DB.students.forEach(function(s){ if(s.className) classSet[s.className]=true; });
        var classList=sortClassNames(Object.keys(classSet));
        var searchClassOpts='<option value="">全部班级</option>'+classList.map(function(c){ return '<option value="'+c+'"'+(studentSearch.className===c?' selected':'')+'>'+c+'</option>'; }).join('');
        var namePool = studentSearch.className ? DB.students.filter(function(s){ return s.className===studentSearch.className; }) : DB.students;
        var nameSet={}; namePool.forEach(function(s){ if(s.name) nameSet[s.name]=true; });
        var nameDatalistOpts=Object.keys(nameSet).map(function(n){ return '<option value="'+n+'"></option>'; }).join('');
        // 按检索条件过滤学生
        var filteredStudents = DB.students.filter(function(s){
            if(studentSearch.className && s.className !== studentSearch.className) return false;
            if(studentSearch.name && s.name && s.name.indexOf(studentSearch.name) === -1) return false;
            if(studentSearch.residence==='resident' && isNonResidentStudent(s)) return false;
            if(studentSearch.residence==='nonresident' && !isNonResidentStudent(s)) return false;
            return true;
        });
        // 单行学生 HTML（供分片渲染逐条调用）
        function studentRowHtml(s){
            var dorm=getDormitoryById(s.dormitoryId);
            var floor=dorm?getFloorById(dorm.floorId):null;
            var dormDisplay = dorm ? (isDormitoryDeleted(dorm.roomNumber) ? dorm.roomNumber+' [已删除]' : dorm.roomNumber) : '-';
            var resideTag = isNonResidentStudent(s) ? '<span style="color:var(--info)">走读</span>' : '住宿';
            return '<tr><td data-label="选择"><input type="checkbox" class="student-checkbox" data-student-id="'+s.id+'"></td><td data-label="姓名"><b>'+s.name+'</b></td><td data-label="班级">'+(s.className||'-')+'</td><td data-label="住宿状态">'+resideTag+'</td><td data-label="床号">'+(s.bedNumber||'-')+'</td><td data-label="宿舍">'+dormDisplay+'</td><td data-label="楼层">'+(floor?floor.name:'-')+'</td><td data-label="操作"><button class="btn btn-danger btn-xs" onclick="deleteStudent('+s.id+')">删除</button></td></tr>';
        }
        var isFiltered = (studentSearch.className || studentSearch.name || studentSearch.residence);
        var listTitle = isFiltered ? ('学生列表（筛选结果 '+filteredStudents.length+' / 共 '+DB.students.length+' 人）') : ('学生列表（'+DB.students.length+'人）');
        container.innerHTML='<div class="content-header"><h2>👥 学生名单管理</h2><button class="btn btn-outline btn-sm" onclick="openDormitoryManageModal()" style="margin-left:auto">🏠 宿舍号管理</button></div>'
            +'<div class="two-col-grid">'
            +'<div class="card"><div class="card-header">单个添加学生</div><div class="card-body">'
            +'<div class="form-row"><div class="form-group"><label>姓名 *</label><input type="text" id="newStuName" placeholder="学生姓名"></div>'
            +'<div class="form-group"><label>班级 *</label><input type="text" id="newStuClass" placeholder="如：高一1班" value="高一1班"></div></div>'
            +'<div class="form-row"><div class="form-group"><label>宿舍 *</label><select id="newStuDorm">'+dormOpts+'</select></div>'
            +'<div class="form-group"><label>床号</label><input type="text" id="newStuBed" placeholder="如：1-8"></div></div>'
            +'<button class="btn btn-primary" onclick="addStudent()">➕ 添加学生</button>'
            +'</div></div>'
            +'<div class="card"><div class="card-header">批量导入学生</div><div class="card-body">'
            +'<p style="color:#6b7280;margin-bottom:12px">支持两种方式：</p>'
            +'<div style="margin-bottom:12px"><b>📂 Excel导入：</b> <span class="file-upload-wrapper"><span class="file-upload-btn">选择Excel文件</span><input type="file" id="excelFileInput" accept=".xlsx,.xls" onchange="handleExcelImport(this.files[0])"></span></div>'
            +'<div><b>📋 粘贴文本：</b> <textarea id="batchImportText" rows="6" style="width:100%;padding:8px;border:1.5px solid #ddd;border-radius:6px" placeholder="模板：姓名,班级,宿舍号,床号（逗号分隔）"></textarea>'
            +'<button class="btn btn-primary" onclick="batchImportStudents()">📥 从文本导入</button></div>'
            +'</div></div>'
            +'</div>'
            +'<div class="card"><div class="card-header">🔍 检索学生</div><div class="card-body">'
            +'<div class="filter-section">'
            +'<div class="form-group"><label>班级</label><select id="searchStuClass" onchange="onSearchStuClassChange(this.value)">'+searchClassOpts+'</select></div>'
            +'<div class="form-group"><label>姓名</label><input type="text" id="searchStuName" list="dlSearchStuName" placeholder="输入姓名（支持模糊匹配）" value="'+escapeHtmlAttr(studentSearch.name)+'"></div>'
            +'<div class="form-group"><label>住宿状态</label><select id="searchStuResidence"><option value=""'+(studentSearch.residence===''?' selected':'')+'>全部</option><option value="resident"'+(studentSearch.residence==='resident'?' selected':'')+'>住宿</option><option value="nonresident"'+(studentSearch.residence==='nonresident'?' selected':'')+'>走读</option></select></div>'
            +'<button class="btn btn-primary" onclick="searchStudents()">🔍 检索</button>'
            +'<button class="btn btn-outline" onclick="resetStudentSearch()">重置</button>'
            +'</div>'
            +'</div></div>'
            +'<datalist id="dlSearchStuName">'+nameDatalistOpts+'</datalist>'
            +'<div class="card"><div class="card-header">'+listTitle
            +'<div style="display:flex;gap:8px;align-items:center">'
            +'<input type="checkbox" id="selectAllStudents" onchange="toggleAllStudents(this.checked)"> <label for="selectAllStudents" style="font-weight:400;cursor:pointer">全选</label>'
            +'<button class="btn btn-danger btn-sm" onclick="deleteSelectedStudents()">🗑️ 删除选中</button>'
            +'</div>'
            +'</div><div style="overflow-x:auto;max-height:500px;overflow-y:auto"><table><thead><tr><th style="width:30px"></th><th>姓名</th><th>班级</th><th>住宿状态</th><th>床号</th><th>宿舍</th><th>楼层</th><th>操作</th></tr></thead><tbody id="studentsTbody"></tbody></table></div></div>';
        // 学生列表分片渲染：checkbox 事件改在 tbody 上委托（逐行绑定在分批插入时会漏绑）
        var stuTbody=document.getElementById('studentsTbody');
        if(stuTbody) stuTbody.addEventListener('change', updateSelectedCount);
        renderListInChunks(stuTbody, filteredStudents, studentRowHtml, 50, function(){
            updateSelectedCount();
            // 分片插入期间用户若已点"全选"，全部行就绪后补同步一次
            var sa=document.getElementById('selectAllStudents');
            if(sa && sa.checked) toggleAllStudents(true);
        }, { emptyHtml:'<tr><td colspan="8" style="text-align:center;color:#aaa">暂无符合条件的学生</td></tr>' });
    }

    /**
     * 渲染「宿舍管理」（管理员）：生效宿舍号列表 + 新增/删除宿舍号入口。
     * 结果写入宿舍管理弹层；增删后同步 dormitoryList 权威名单并刷新树。
     */
    function renderDormitoryManage(){
        var groups = getDormitoryListByFloor();
        var groupHtml = groups.map(function(g){
            var rows = g.items.map(function(it){
                return '<tr><td><b>'+it.roomNumber+'</b></td><td>'+it.count+'人</td><td><button class="btn btn-danger btn-xs" onclick="deleteDormitory(\''+escapeHtmlAttr(it.roomNumber)+'\')">删除</button></td></tr>';
            }).join('') || '<tr><td colspan="3" style="text-align:center;color:#aaa">该楼层暂无生效宿舍号</td></tr>';
            return '<div class="card" style="margin-bottom:12px"><div class="card-header">'+g.floorName+'（'+g.items.length+'间）</div><div style="overflow-x:auto"><table><thead><tr><th>宿舍号</th><th>入住人数</th><th>操作</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
        }).join('') || '<div class="empty-state">暂无宿舍号数据</div>';
        var html = '<div class="em-header"><span>🏠 宿舍号管理</span><button class="em-close" aria-label="关闭" onclick="closeDormitoryManageModal()">✕</button></div>'
            + '<div class="em-body">'
            + '<div class="form-group"><label>新增宿舍号</label>'
            + '<div style="display:flex;gap:8px;align-items:center">'
            + '<input type="text" id="newDormRoom" placeholder="如：123、725（三位数字，百位1-8）" maxlength="3" style="flex:1;padding:8px;border:1.5px solid #ddd;border-radius:6px">'
            + '<button class="btn btn-primary" onclick="addDormitory()">➕ 添加</button>'
            + '</div>'
            + '<div style="font-size:0.8571rem;color:#888;margin-top:6px">系统按百位数字自动识别所属楼层（1xx=一楼 … 8xx=八楼）</div>'
            + '</div>'
            + groupHtml
            + '</div>';
        document.getElementById('dormitoryManageBox').innerHTML = html;
    }

    // ==================== 扣分项目管理视图 ====================
    /**
     * 渲染「扣分项目管理」（管理员）：卫生项/纪律项两个表格 + 新增/批量导入/删除。
     * @param {HTMLElement} container - contentArea 容器
     */
    function renderItemsView(container){
        if(!isAdmin()){container.innerHTML='<div class="empty-state">无权限</div>';return;}
        var hyItems=DB.deductionItems.hygiene||[];
        var disItems=DB.deductionItems.discipline||[];
        var hyBonusItems=DB.deductionItems.hygieneBonus||[];
        var disBonusItems=DB.deductionItems.disciplineBonus||[];
        function itemRows(items,delFn,prefix){
            return items.map(function(i){return '<div class="item-row"><span><b>'+i.name+'</b> <span class="badge-tag '+(prefix==='+'?'badge-primary':'badge-danger')+'">'+prefix+i.defaultScore+'分</span></span><button class="btn btn-danger btn-xs" onclick="'+delFn+'('+i.id+')">删除</button></div>';}).join('');
        }
        function addForm(opts){
            return '<div style="display:flex;gap:8px;margin-top:12px"><input type="text" id="'+opts.nameId+'" placeholder="新项目名称" style="flex:1;padding:8px;border:1.5px solid #ddd;border-radius:6px"><input type="number" id="'+opts.scoreId+'" value="'+opts.defaultScore+'" min="0.1" step="0.1" style="width:70px;padding:8px;border:1.5px solid #ddd;border-radius:6px"><button class="btn btn-primary btn-sm" onclick="'+opts.addFn+'()">添加</button></div>'
                +'<div style="margin-top:16px"><b>批量导入：</b><textarea id="'+opts.batchId+'" rows="4" style="width:100%;margin-top:4px;padding:8px;border:1.5px solid #ddd;border-radius:6px" placeholder="每行一个：项目名称,分值"></textarea><button class="btn btn-primary btn-sm" onclick="'+opts.batchFn+'()">📥 批量导入</button></div>';
        }
        var hyRows=itemRows(hyItems,'deleteHygieneItem','-');
        var disRows=itemRows(disItems,'deleteDisciplineItem','-');
        var hyBonusRows=itemRows(hyBonusItems,'deleteHygieneBonusItem','+');
        var disBonusRows=itemRows(disBonusItems,'deleteDisciplineBonusItem','+');
        container.innerHTML='<div class="content-header"><h2>📋 加扣分项目管理</h2></div>'
            +'<div class="two-col-grid">'
            +'<div class="card"><div class="card-header">🧹 卫生扣分项目（'+hyItems.length+'项）</div><div class="card-body"><div class="item-list">'+(hyRows||'<div style="color:#aaa;text-align:center;padding:20px">暂无项目</div>')+'</div>'
            +addForm({nameId:'newHyItemName',scoreId:'newHyItemScore',defaultScore:2,addFn:'addHygieneItem',batchId:'hyBatchImport',batchFn:'batchImportHygieneItems'})
            +'</div></div>'
            +'<div class="card"><div class="card-header">📏 纪律扣分项目（'+disItems.length+'项）</div><div class="card-body"><div class="item-list">'+(disRows||'<div style="color:#aaa;text-align:center;padding:20px">暂无项目</div>')+'</div>'
            +addForm({nameId:'newDisItemName',scoreId:'newDisItemScore',defaultScore:1,addFn:'addDisciplineItem',batchId:'disBatchImport',batchFn:'batchImportDisciplineItems'})
            +'</div></div>'
            +'<div class="card"><div class="card-header">🧹 卫生加分项目（'+hyBonusItems.length+'项）</div><div class="card-body"><div class="item-list">'+(hyBonusRows||'<div style="color:#aaa;text-align:center;padding:20px">暂无项目</div>')+'</div>'
            +addForm({nameId:'newHyBonusItemName',scoreId:'newHyBonusItemScore',defaultScore:0.2,addFn:'addHygieneBonusItem',batchId:'hyBonusBatchImport',batchFn:'batchImportHygieneBonusItems'})
            +'</div></div>'
            +'<div class="card"><div class="card-header">📏 纪律加分项目（'+disBonusItems.length+'项）</div><div class="card-body"><div class="item-list">'+(disBonusRows||'<div style="color:#aaa;text-align:center;padding:20px">暂无项目</div>')+'</div>'
            +addForm({nameId:'newDisBonusItemName',scoreId:'newDisBonusItemScore',defaultScore:1,addFn:'addDisciplineBonusItem',batchId:'disBonusBatchImport',batchFn:'batchImportDisciplineBonusItems'})
            +'</div></div>'
            +'</div>';
    }

    // ==================== 学生管理视图 ====================
    /**
     * 渲染「学生管理」视图：请假(leave)/停宿(stop)/退宿(absence)三类登记表单
     * （班级→姓名→宿舍→床号级联，自动带出）与各自折叠记录列表（分片渲染）。
     * @param {HTMLElement} container - contentArea 容器
     */
    function renderLeaveManageView(container){
        if(!isAdmin() && currentUser.role !== 'CLASS_ADMIN' && currentUser.role !== 'STAFF'){ container.innerHTML='<div class="empty-state">无权限</div>'; return; }
        var isClassAdmin = (currentUser && currentUser.role === 'CLASS_ADMIN');
        // 移动端（≤768px）所有角色（ADMIN/STAFF/CLASS_ADMIN）统一使用色块式折叠布局；
        // 管理员的待审核列表与通过/驳回按钮渲染在下方记录区（applyLeaveFilter），不受影响
        if(window.innerWidth<=768){
            renderLeaveManageBlocks(container, isClassAdmin);
            return;
        }
        // 移动端增强开关：仅 移动端(≤768px) + 班级账号 生效（姓名下拉、日期选择器增强）
        var mEnhance = isClassAdmin && window.innerWidth<=768;
        var classAccountClassName = isClassAdmin ? currentUser.className : '';
        var isAdminUser = isAdmin(); // 只有管理员可删除
        var classSet={}; DB.students.forEach(function(s){ if(s.className) classSet[s.className]=true; });
        var classList=sortClassNames(Object.keys(classSet));
        var classOptions='<option value="">全部班级</option>';
        classList.forEach(function(c){ classOptions+='<option value="'+c+'">'+c+'</option>'; });
        // 表单用班级下拉选项（含"请选择班级"提示项）
        var classSelectOpts='<option value="">请选择班级</option>';
        classList.forEach(function(c){ classSelectOpts+='<option value="'+c+'">'+c+'</option>'; });
        var today=getTodayLocalStr();
        var defaultStart=new Date(); defaultStart.setDate(defaultStart.getDate()-30);
        var defaultStartStr=formatLocalDate(defaultStart);
        // 班级账号（移动端）：姓名改为原生 <select> 下拉框，选项 = 本班级当前全部学生姓名
        // （原生 select 选择后选项列表始终完整保留，可随时切换其他学生；名单为空时显示提示项）
        var studentSelectOpts='';
        if(mEnhance){
            var classStus=DB.students.filter(function(s){ return s.className===classAccountClassName; });
            studentSelectOpts = classStus.length
                ? '<option value="">请选择学生</option>'+classStus.map(function(s){ return '<option value="'+s.name+'">'+s.name+'</option>'; }).join('')
                : '<option value="" disabled>本班暂无学生</option>';
        }
        // PC 端联动下拉（与移动端一致，统一使用原生 <select>，体验与"班级"字段完全相同）：
        // - 班级账号：班级只读锁定；姓名/宿舍/床号为 <select>，选项按本班数据联动
        // - 管理员/生活老师：班级为 <select>（选择后联动）；姓名/宿舍/床号为 <select>
        var classFieldLeave, classFieldStop, classFieldAbs;
        if(isClassAdmin){
            classFieldLeave='<label>班级 *</label><input type="text" id="leaveClass" value="'+classAccountClassName+'" readonly>';
            classFieldStop='<label>班级 *</label><input type="text" id="stopClass" value="'+classAccountClassName+'" readonly>';
            classFieldAbs='<label>班级 *</label><input type="text" id="absClass" value="'+classAccountClassName+'" readonly>';
        } else {
            classFieldLeave='<label>班级 *</label><select id="leaveClass" onchange="onPcClassChange(\'leave\')">'+classSelectOpts+'</select>';
            classFieldStop='<label>班级 *</label><select id="stopClass" onchange="onPcClassChange(\'stop\')">'+classSelectOpts+'</select>';
            classFieldAbs='<label>班级 *</label><select id="absClass" onchange="onPcClassChange(\'abs\')">'+classSelectOpts+'</select>';
        }
        // 姓名/宿舍/床号：PC 端统一 <select>，选项由 refreshPcSelects 按"班级→宿舍→床号"联动刷新
        var nameLeave='<select id="leaveName" onchange="onPcNameChange(\'leave\',this.value)"></select>';
        var nameStop='<select id="stopName" onchange="onPcNameChange(\'stop\',this.value)"></select>';
        var nameAbs='<select id="absName" onchange="onPcNameChange(\'abs\',this.value)"></select>';
        var dormLeave='<select id="leaveDorm" onchange="onPcDormChange(\'leave\',this.value)"></select>';
        var bedLeave='<select id="leaveBed" onchange="onPcBedChange(\'leave\',this.value)"></select>';
        var dormStop='<select id="stopDorm" onchange="onPcDormChange(\'stop\',this.value)"></select>';
        var bedStop='<select id="stopBed" onchange="onPcBedChange(\'stop\',this.value)"></select>';
        var dormAbs='<select id="absDorm" onchange="onPcDormChange(\'abs\',this.value)"></select>';
        var bedAbs='<select id="absBed" onchange="onPcBedChange(\'abs\',this.value)"></select>';
        container.innerHTML='<div class="content-header"><h2>🏠 学生管理</h2></div>'
            + (isClassAdmin ? '' : '<div class="card"><div class="card-header">筛选条件</div><div class="card-body"><div class="filter-section">'
            + '<div class="form-group"><label>班级</label><select id="leaveFilterClass">'+classOptions+'</select></div>'
            + '<div class="form-group"><label>姓名</label><input type="text" id="leaveFilterName" placeholder="输入姓名关键字" style="width:150px;"></div>'
            + '<button class="btn btn-primary" onclick="applyLeaveFilter()">🔍 查询</button>'
            + '</div></div></div>')
            + '<div style="display:grid;grid-template-columns:1fr;gap:16px">'
            + '<div class="card"><div class="card-header">📝 请假登记（即刻生效，到期自动销假）</div><div class="card-body">'
            + '<div class="form-row"><div class="form-group">'
            + classFieldAbs
            + '</div>'
            + '<div class="form-group"><label>姓名 *</label>'+nameAbs+'</div></div>'
            + '<div class="form-row"><div class="form-group"><label>宿舍号 *</label>'+dormAbs+'</div>'
            + '<div class="form-group"><label>床号 *</label>'+bedAbs+'</div></div>'
            + '<div class="form-row"><div class="form-group"><label>请假类型 *</label><select id="absType" onchange="updateAbsReasonLabel()"><option value="personal">事假</option><option value="sick">病假</option><option value="other">其他</option></select></div>'
            + '<div class="form-group"><label id="absReasonLabel">事假说明（选填）</label><input type="text" id="absReason" placeholder="选填，可不填"></div></div>'
            + '<div class="form-row"><div class="form-group"><label>开始日期 *</label><input type="text" class="date-picker" id="absStartDate" value="'+today+'"></div>'
            + '<div class="form-group"><label>结束日期 *</label><input type="text" class="date-picker" id="absEndDate" value="'+today+'"></div></div>'
            + '<button class="btn btn-primary" onclick="addAbsenceRecord()">📝 登记请假</button>'
            + '</div></div>'
            + '<div class="card"><div class="card-header">停宿管理</div><div class="card-body">'
            + '<div class="form-row"><div class="form-group">'
            + classFieldStop
            + '</div>'
            + '<div class="form-group"><label>姓名 *</label>'+nameStop+'</div></div>'
            + '<div class="form-row"><div class="form-group"><label>宿舍号 *</label>'+dormStop+'</div>'
            + '<div class="form-group"><label>床号 *</label>'+bedStop+'</div></div>'
            + '<div class="form-row"><div class="form-group"><label>停宿开始日期 *</label><input type="text" class="date-picker" id="stopStartDate" value="'+today+'"></div>'
            + '<div class="form-group"><label>停宿结束日期 *</label><input type="text" class="date-picker" id="stopEndDate" value="'+today+'"></div></div>'
            + '<div class="form-group"><label>停宿时间段（自动生成）</label><input type="text" id="stopPeriod" readonly placeholder="选择日期后自动生成"></div>'
            + '<div class="form-group"><label>停宿原因 *</label><input type="text" id="stopReason" placeholder="原因"></div>'
            + '<button class="btn btn-primary" onclick="addLeaveRecord(\'stop\')">📝 登记停宿</button>'
            + '</div></div>'
            + '<div class="card"><div class="card-header">退宿管理</div><div class="card-body">'
            + '<div class="form-row"><div class="form-group">'
            + classFieldLeave
            + '</div>'
            + '<div class="form-group"><label>姓名 *</label>'+nameLeave+'</div></div>'
            + '<div class="form-row"><div class="form-group"><label>宿舍号 *</label>'+dormLeave+'</div>'
            + '<div class="form-group"><label>床号 *</label>'+bedLeave+'</div></div>'
            + '<div class="form-row"><div class="form-group"><label>退宿时间 *</label><input type="text" class="date-picker" id="leaveDate" value="'+today+'"></div>'
            + '<div class="form-group"><label>退宿原因 *</label><input type="text" id="leaveReason" placeholder="原因"></div></div>'
            + '<button class="btn btn-primary" onclick="addLeaveRecord(\'leave\')">📝 登记退宿</button>'
            + '</div></div>'
            + '</div>'
            + '<div class="fold-block" id="recFold-absence"><div class="fold-header" onclick="toggleRecFold(\'absence\')">📋 请假记录<span class="fold-sub" id="recCount-absence"></span><span class="fold-arrow">▶</span></div><div class="fold-body"><div id="absenceRecordsList"></div></div></div>'
            + '<div class="fold-block" id="recFold-stop"><div class="fold-header" onclick="toggleRecFold(\'stop\')">🛏 停宿记录<span class="fold-sub" id="recCount-stop"></span><span class="fold-arrow">▶</span></div><div class="fold-body"><div id="stopRecordsList"></div></div></div>'
            + '<div class="fold-block" id="recFold-leave"><div class="fold-header" onclick="toggleRecFold(\'leave\')">🚪 退宿记录<span class="fold-sub" id="recCount-leave"></span><span class="fold-arrow">▶</span></div><div class="fold-body"><div id="leaveRecordsList"></div></div></div>';
        document.getElementById('stopStartDate').addEventListener('change', updateStopPeriod);
        document.getElementById('stopEndDate').addEventListener('change', updateStopPeriod);
        updateStopPeriod();
        applyLeaveFilter();
        renderAbsenceRecords();
        initPcSelects(); // 初始化 PC 端联动下拉选项（班级/姓名/宿舍/床号）
        // 恢复记录列表折叠开合状态
        Object.keys(foldState).forEach(function(id){ var el=document.getElementById(id); if(el&&foldState[id]) el.classList.add('open'); });
        initDatePickers(document); // 初始化退宿/停宿/请假日期选择器
    }

    // ==================== 移动端学生管理：色块式折叠布局（非管理员专用） ====================
    // 三个色块（退宿/停宿/请假）默认全部收起；互斥展开；表单数据随 DOM 保留不丢失
    function renderLeaveManageBlocks(container, isClassAdmin){
        var classAccountClassName=isClassAdmin?currentUser.className:'';
        var today=getTodayLocalStr();
        // 班级字段：班级账号=只读文本；生活老师=下拉选择（联动姓名下拉）
        var classFieldLeave, classFieldStop, classFieldAbs;
        if(isClassAdmin){
            classFieldLeave='<label>班级 *</label><input type="text" id="leaveClass" value="'+classAccountClassName+'" readonly>';
            classFieldStop='<label>班级 *</label><input type="text" id="stopClass" value="'+classAccountClassName+'" readonly>';
            classFieldAbs='<label>班级 *</label><input type="text" id="absClass" value="'+classAccountClassName+'" readonly>';
        } else {
            var cs={}; DB.students.forEach(function(s){ if(s.className) cs[s.className]=true; });
            var clsOpts='<option value="">请选择班级</option>';
            sortClassNames(Object.keys(cs)).forEach(function(c){ clsOpts+='<option value="'+c+'">'+c+'</option>'; });
            classFieldLeave='<label>班级 *</label><select id="leaveClass" onchange="onAccClassChange(this.value,\'leaveName\')">'+clsOpts+'</select>';
            classFieldStop='<label>班级 *</label><select id="stopClass" onchange="onAccClassChange(this.value,\'stopName\')">'+clsOpts+'</select>';
            classFieldAbs='<label>班级 *</label><select id="absClass" onchange="onAccClassChange(this.value,\'absName\')">'+clsOpts+'</select>';
        }
        // 姓名字段：班级账号=本班学生下拉；生活老师=随班级联动的下拉（初始为空）
        var nameOpts;
        if(isClassAdmin){
            var classStus=DB.students.filter(function(s){ return s.className===classAccountClassName; });
            nameOpts=classStus.length?'<option value="">请选择学生</option>'+classStus.map(function(s){ return '<option value="'+s.name+'">'+s.name+(isNonResidentStudent(s)?'（走读）':'')+'</option>'; }).join(''):'<option value="" disabled>本班暂无学生</option>';
        } else {
            nameOpts='<option value="">请先选择班级</option>';
        }
        var nameSelLeave='<label>姓名 *</label><select id="leaveName" onchange="autoFillLeave(this.value)">'+nameOpts+'</select>';
        var nameSelStop='<label>姓名 *</label><select id="stopName" onchange="autoFillStop(this.value)">'+nameOpts+'</select>';
        var nameSelAbs='<label>姓名 *</label><select id="absName" onchange="autoFillAbs(this.value)">'+nameOpts+'</select>';
        var leaveBody='<div class="form-row"><div class="form-group">'+classFieldLeave+'</div>'
            +'<div class="form-group">'+nameSelLeave+'</div></div>'
            +'<div class="form-row"><div class="form-group"><label>宿舍号 *</label><select id="leaveDorm" onchange="onAccDormChange(\'leave\',this.value)">'+dormSelectOptions('','')+'</select></div>'
            +'<div class="form-group"><label>床号 *</label><select id="leaveBed" onchange="onAccBedChange(\'leave\',this.value)">'+bedSelectOptions(null,'')+'</select></div></div>'
            +'<div class="form-row"><div class="form-group"><label>退宿时间 *</label><input type="text" class="date-picker" id="leaveDate" value="'+today+'"></div>'
            +'<div class="form-group"><label>退宿原因 *</label><input type="text" id="leaveReason" placeholder="原因"></div></div>'
            +'<button class="btn btn-primary" onclick="addLeaveRecord(\'leave\')">📝 登记退宿</button>';
        var stopBody='<div class="form-row"><div class="form-group">'+classFieldStop+'</div>'
            +'<div class="form-group">'+nameSelStop+'</div></div>'
            +'<div class="form-row"><div class="form-group"><label>宿舍号 *</label><select id="stopDorm" onchange="onAccDormChange(\'stop\',this.value)">'+dormSelectOptions('','')+'</select></div>'
            +'<div class="form-group"><label>床号 *</label><select id="stopBed" onchange="onAccBedChange(\'stop\',this.value)">'+bedSelectOptions(null,'')+'</select></div></div>'
            +'<div class="form-row"><div class="form-group"><label>停宿开始日期 *</label><input type="text" class="date-picker" id="stopStartDate" value="'+today+'"></div>'
            +'<div class="form-group"><label>停宿结束日期 *</label><input type="text" class="date-picker" id="stopEndDate" value="'+today+'"></div></div>'
            +'<div class="form-group"><label>停宿时间段（自动生成）</label><input type="text" id="stopPeriod" readonly placeholder="选择日期后自动生成"></div>'
            +'<div class="form-group"><label>停宿原因 *</label><input type="text" id="stopReason" placeholder="原因"></div>'
            +'<button class="btn btn-primary" onclick="addLeaveRecord(\'stop\')">📝 登记停宿</button>';
        var absenceBody='<div class="form-row"><div class="form-group">'+classFieldAbs+'</div>'
            +'<div class="form-group">'+nameSelAbs+'</div></div>'
            +'<div class="form-row"><div class="form-group"><label>宿舍号 *</label><select id="absDorm" onchange="onAccDormChange(\'abs\',this.value)">'+dormSelectOptions('','')+'</select></div>'
            +'<div class="form-group"><label>床号 *</label><select id="absBed" onchange="onAccBedChange(\'abs\',this.value)">'+bedSelectOptions(null,'')+'</select></div></div>'
            +'<div class="form-row"><div class="form-group"><label>请假类型 *</label><select id="absType" onchange="updateAbsReasonLabel()"><option value="personal">事假</option><option value="sick">病假</option><option value="other">其他</option></select></div>'
            +'<div class="form-group"><label id="absReasonLabel">事假说明（选填）</label><input type="text" id="absReason" placeholder="选填，可不填"></div></div>'
            +'<div class="form-row"><div class="form-group"><label>开始日期 *</label><input type="text" class="date-picker" id="absStartDate" value="'+today+'"></div>'
            +'<div class="form-group"><label>结束日期 *</label><input type="text" class="date-picker" id="absEndDate" value="'+today+'"></div></div>'
            +'<button class="btn btn-primary" onclick="addAbsenceRecord()">📝 登记请假</button>';
        // 列表筛选行：班级账号锁定本班（不显示）；生活老师可选班级+姓名关键字过滤记录列表
        var filterRow=isClassAdmin?'':('<div class="card"><div class="card-header">筛选条件</div><div class="card-body"><div class="filter-section">'
            +'<div class="form-group"><label>班级</label><select id="leaveFilterClass">'+classOptionsLeaveFilter()+'</select></div>'
            +'<div class="form-group"><label>姓名</label><input type="text" id="leaveFilterName" placeholder="输入姓名关键字"></div>'
            +'<button class="btn btn-primary" onclick="applyLeaveFilter()">🔍 查询</button>'
            +'</div></div></div>');
        container.innerHTML='<div class="content-header"><h2>🏠 学生管理</h2></div>'
            +'<div class="acc-block acc-absence" id="accBlock-absence"><div class="acc-header" onclick="toggleAccBlock(\'absence\')"><span class="acc-title">📝 请假登记</span><span class="acc-info" id="accInfo-absence"></span><span class="acc-arrow" id="accArrow-absence">▶</span></div><div class="acc-body" id="accBody-absence"><div class="acc-body-inner">'+absenceBody+'</div></div></div>'
            +'<div class="acc-block acc-stop" id="accBlock-stop"><div class="acc-header" onclick="toggleAccBlock(\'stop\')"><span class="acc-title">🏠 停宿管理</span><span class="acc-info" id="accInfo-stop"></span><span class="acc-arrow" id="accArrow-stop">▶</span></div><div class="acc-body" id="accBody-stop"><div class="acc-body-inner">'+stopBody+'</div></div></div>'
            +'<div class="acc-block acc-leave" id="accBlock-leave"><div class="acc-header" onclick="toggleAccBlock(\'leave\')"><span class="acc-title">🚪 退宿管理</span><span class="acc-info" id="accInfo-leave"></span><span class="acc-arrow" id="accArrow-leave">▶</span></div><div class="acc-body" id="accBody-leave"><div class="acc-body-inner">'+leaveBody+'</div></div></div>'
            +filterRow
            +'<div class="fold-block" id="recFold-absence"><div class="fold-header" onclick="toggleRecFold(\'absence\')">📋 请假记录<span class="fold-sub" id="recCount-absence"></span><span class="fold-arrow">▶</span></div><div class="fold-body"><div id="absenceRecordsList"></div></div></div>'
            +'<div class="fold-block" id="recFold-stop"><div class="fold-header" onclick="toggleRecFold(\'stop\')">🛏 停宿记录<span class="fold-sub" id="recCount-stop"></span><span class="fold-arrow">▶</span></div><div class="fold-body"><div id="stopRecordsList"></div></div></div>'
            +'<div class="fold-block" id="recFold-leave"><div class="fold-header" onclick="toggleRecFold(\'leave\')">🚪 退宿记录<span class="fold-sub" id="recCount-leave"></span><span class="fold-arrow">▶</span></div><div class="fold-body"><div id="leaveRecordsList"></div></div></div>';
        document.getElementById('stopStartDate').addEventListener('change', updateStopPeriod);
        document.getElementById('stopEndDate').addEventListener('change', updateStopPeriod);
        updateStopPeriod();
        applyLeaveFilter();
        refreshAccBlockInfo();
        // 恢复记录列表折叠开合状态
        Object.keys(foldState).forEach(function(id){ var el=document.getElementById(id); if(el&&foldState[id]) el.classList.add('open'); });
        initDatePickers(document); // 初始化色块内日期选择器
    }
    function classOptionsLeaveFilter(){
        var cs={}; DB.students.forEach(function(s){ if(s.className) cs[s.className]=true; });
        var opts='<option value="">全部班级</option>';
        sortClassNames(Object.keys(cs)).forEach(function(c){ opts+='<option value="'+c+'">'+c+'</option>'; });
        return opts;
    }
    // 色块互斥展开/收起：点击已展开的收起；点击其他色块时前一个自动收起
    // 展开/收起完全由 .open 类 + CSS max-height 过渡完成（无 JS 高度测量，不会卡住在半开状态）
    /**
     * 学生管理：展开/收起 请假/停宿/退宿 记录折叠块，并重绘该块记录列表。
     * @param {string} type - 'leave' | 'stop' | 'abs'
     */
    function toggleAccBlock(type){
        ['leave','stop','absence'].forEach(function(t){
            var block=document.getElementById('accBlock-'+t);
            var arrow=document.getElementById('accArrow-'+t);
            if(!block) return;
            if(t===type){
                var opening=!block.classList.contains('open');
                block.classList.toggle('open',opening);
                if(arrow) arrow.textContent=opening?'▼':'▶';
                if(!opening) refreshAccBlockInfo(); // 收起时刷新状态摘要（登记后数量可能变化）
            } else if(block.classList.contains('open')){
                block.classList.remove('open');
                if(arrow) arrow.textContent='▶';
                refreshAccBlockInfo();
            }
        });
        initDatePickers(document); // 展开后立即初始化色块内日期选择器（重复调用安全）
    }
    // 刷新各色块收起状态右侧的状态摘要（按当前班级范围实时计算）
    function refreshAccBlockInfo(){
        var today=getTodayStr();
        function curCls(id){
            var el=document.getElementById(id);
            var v=el?el.value.trim():'';
            if(currentUser&&currentUser.role==='CLASS_ADMIN') v=currentUser.className;
            return v;
        }
        var el=document.getElementById('accInfo-leave');
        if(el){
            var c1=curCls('leaveClass');
            el.textContent='待审核: '+(DB.leaveRecords||[]).filter(function(r){return r.type==='leave'&&r.status==='pending'&&(!c1||r.className===c1);}).length+'人';
        }
        el=document.getElementById('accInfo-stop');
        if(el){
            var c2=curCls('stopClass');
            el.textContent='停宿中: '+(DB.leaveRecords||[]).filter(function(r){return r.type==='stop'&&r.status==='approved'&&r.endDate&&r.endDate>=today&&(!c2||r.className===c2);}).length+'人';
        }
        el=document.getElementById('accInfo-absence');
        if(el){
            var c3=curCls('absClass');
            el.textContent='请假中: '+(DB.absenceRecords||[]).filter(function(r){return r.endDate&&r.endDate>=today&&(!c3||r.className===c3);}).length+'人';
        }
    }
    // 生活老师：切换班级后重建对应姓名下拉 + 宿舍号下拉选项
    function onAccClassChange(className, nameSelectId){
        var sel=document.getElementById(nameSelectId);
        if(sel){
            var stus=className?DB.students.filter(function(s){return s.className===className;}):[];
            sel.innerHTML='<option value="">'+(className?'请选择学生':'请先选择班级')+'</option>'+stus.map(function(s){return '<option value="'+s.name+'">'+s.name+(isNonResidentStudent(s)?'（走读）':'')+'</option>';}).join('');
        }
        // 联动宿舍号下拉：仅显示该班级学生入住的宿舍；取消班级则恢复全部宿舍
        var prefix = nameSelectId.replace('Name',''); // leave/stop/abs
        var dormSel = document.getElementById(prefix + 'Dorm');
        if(dormSel){
            dormSel.innerHTML = dormSelectOptions(className, dormSel.value);
        }
        // 清空床号下拉（宿舍未选时显示全部1-8）
        var bedSel = document.getElementById(prefix + 'Bed');
        if(bedSel){
            bedSel.innerHTML = bedSelectOptions(null, '');
        }
    }
    // 移动端：选择宿舍号后联动姓名（仅该宿舍学生）+ 床号（可用床位）
    function onAccDormChange(prefix, roomNumber){
        var nameSel = document.getElementById(prefix + 'Name');
        var bedSel = document.getElementById(prefix + 'Bed');
        var classEl = document.getElementById(prefix + 'Class');
        var className = classEl ? classEl.value.trim() : '';
        // 姓名下拉：显示该宿舍学生（若有班级则限定本班）
        if(nameSel){
            var dorm = roomNumber ? getDormitoryByRoomNumber(roomNumber) : null;
            var stus = dorm ? getStudentsByDormitory(dorm.id) : [];
            if(className) stus = stus.filter(function(s){ return s.className === className; });
            // 保留当前班级的全部学生（不消失），但高亮该宿舍学生
            var allStus = className ? DB.students.filter(function(s){return s.className===className;}) : [];
            if(roomNumber){
                nameSel.innerHTML = '<option value="">请选择学生</option>' + allStus.map(function(s){
                    var inDorm = stus.some(function(x){ return x.id === s.id; });
                    return '<option value="'+s.name+'">'+s.name+(inDorm?'（'+roomNumber+'）':'')+'</option>';
                }).join('');
            } else {
                nameSel.innerHTML = '<option value="">'+(className?'请选择学生':'请先选择班级')+'</option>' + allStus.map(function(s){return '<option value="'+s.name+'">'+s.name+'</option>';}).join('');
            }
        }
        // 床号下拉：仅显示该宿舍可用床位
        if(bedSel){
            var dorm = roomNumber ? getDormitoryByRoomNumber(roomNumber) : null;
            bedSel.innerHTML = bedSelectOptions(dorm ? dorm.id : null, bedSel.value);
        }
    }
    // 移动端：选择床号后联动姓名（该床位学生）
    function onAccBedChange(prefix, bedNumber){
        var dormEl = document.getElementById(prefix + 'Dorm');
        var nameSel = document.getElementById(prefix + 'Name');
        var classEl = document.getElementById(prefix + 'Class');
        var className = classEl ? classEl.value.trim() : '';
        var roomNumber = dormEl ? dormEl.value : '';
        if(!roomNumber || !bedNumber || !nameSel) return;
        var dorm = getDormitoryByRoomNumber(roomNumber);
        if(!dorm) return;
        var dormStus = getStudentsByDormitory(dorm.id);
        if(className) dormStus = dormStus.filter(function(s){ return s.className === className; });
        var student = dormStus.find(function(s){ return String(s.bedNumber) === String(bedNumber); });
        if(student){
            nameSel.value = student.name;
        }
    }
    // ==================== PC 端学生管理：select 联动下拉 ====================
    // 三模块（leave/stop/abs）× 四字段（班级/姓名/宿舍/床号）；
    // 班级账号班级只读锁定，管理员/生活老师班级可选；选项始终按当前状态实时重建，
    // 再次展开下拉看到的一定是最新选项（与"班级"下拉体验完全一致）
    var PC_SEL = {
        leave:{classInput:'leaveClass',nameInput:'leaveName',dormInput:'leaveDorm',bedInput:'leaveBed'},
        stop:{classInput:'stopClass',nameInput:'stopName',dormInput:'stopDorm',bedInput:'stopBed'},
        abs:{classInput:'absClass',nameInput:'absName',dormInput:'absDorm',bedInput:'absBed'}
    };
    // 按当前 班级/宿舍 取值重建 姓名/宿舍/床号 三个下拉的选项，并尽量保持已选值
    // （已选值在新选项中不存在时，自动回到"请选择"提示项，不会出现悬空值）
    function refreshPcSelects(p){
        var m=PC_SEL[p]; if(!m) return;
        var clsEl=document.getElementById(m.classInput);
        var nameEl=document.getElementById(m.nameInput);
        var dormEl=document.getElementById(m.dormInput);
        var bedEl=document.getElementById(m.bedInput);
        if(!clsEl||!nameEl||!dormEl||!bedEl) return;
        var clsVal=clsEl.value.trim();
        if(isClassAdmin()) clsVal=currentUser.className; // 班级账号强制本班范围
        var nameVal=nameEl.value;
        var dormVal=dormEl.value;
        var bedVal=bedEl.value;
        // 姓名：班级→仅该班学生；未选班级时宿舍→仅该宿舍学生；都未选→全部学生
        var pool=DB.students;
        if(clsVal){
            pool=pool.filter(function(s){ return s.className===clsVal; });
        } else if(dormVal){
            var d0=getDormitoryByRoomNumber(dormVal);
            pool=d0?getStudentsByDormitory(d0.id):[];
        }
        nameEl.innerHTML='<option value="">请选择学生</option>'
            +pool.map(function(s){ return '<option value="'+s.name+'">'+s.name+(isNonResidentStudent(s)?'（走读）':'')+'</option>'; }).join('');
        if(nameVal) nameEl.value=nameVal;
        // 宿舍号：班级→该班学生入住的宿舍；未选班级→全部生效宿舍
        dormEl.innerHTML=dormSelectOptions(clsVal, dormVal);
        // 床号：宿舍→该宿舍床位 1~8（已占用的禁用并标注"已满"）；未选宿舍→1~8 全部可选
        var dormObj=dormVal?getDormitoryByRoomNumber(dormVal):null;
        bedEl.innerHTML=bedSelectOptions(dormObj?dormObj.id:null, bedVal);
    }
    function initPcSelects(){ ['leave','stop','abs'].forEach(function(p){ refreshPcSelects(p); }); }
    // 班级变化：清空姓名/宿舍/床号，并按新班级重建下拉（姓名=该班学生，宿舍=该班入住宿舍）
    function onPcClassChange(p){
        var m=PC_SEL[p]; if(!m) return;
        [m.nameInput,m.dormInput,m.bedInput].forEach(function(id){
            var el=document.getElementById(id);
            if(el) el.value='';
        });
        refreshPcSelects(p);
    }
    // 姓名变化：先由 autoFillXxx 自动填充班级/宿舍/床号，再统一刷新各下拉选中态
    function onPcNameChange(p, v){
        if(p==='leave') autoFillLeave(v);
        else if(p==='stop') autoFillStop(v);
        else autoFillAbs(v);
        refreshPcSelects(p);
    }
    // 宿舍变化：清空床号并重建床号下拉；该宿舍（班级范围内）仅 1 名学生时自动选中该学生，
    // 否则清空姓名等待手动选择（避免多人间误填第一人）
    function onPcDormChange(p, roomNumber){
        var m=PC_SEL[p]; if(!m) return;
        var clsEl=document.getElementById(m.classInput);
        var nameEl=document.getElementById(m.nameInput);
        var bedEl=document.getElementById(m.bedInput);
        if(bedEl) bedEl.value='';
        var stus=[];
        if(roomNumber){
            var dorm=getDormitoryByRoomNumber(roomNumber);
            if(dorm){
                var clsVal=clsEl?clsEl.value.trim():'';
                if(isClassAdmin()) clsVal=currentUser.className;
                stus=getStudentsByDormitory(dorm.id);
                if(clsVal) stus=stus.filter(function(s){ return s.className===clsVal; });
                if(stus.length===1){
                    if(clsEl && !clsEl.readOnly) clsEl.value=stus[0].className;
                    if(nameEl) nameEl.value=stus[0].name;
                } else if(nameEl){
                    nameEl.value='';
                }
            } else if(nameEl){ nameEl.value=''; }
        } else if(nameEl){ nameEl.value=''; }
        refreshPcSelects(p);
    }
    // 床号变化：该床位若有学生则自动填充姓名/班级（autoFillXxxByBed），再统一刷新下拉
    function onPcBedChange(p, bedNumber){
        if(p==='leave') autoFillLeaveByBed(bedNumber);
        else if(p==='stop') autoFillStopByBed(bedNumber);
        else autoFillAbsByBed(bedNumber);
        refreshPcSelects(p);
    }

    /**
     * 重绘退宿记录列表（#absenceTbody 分片渲染）。
     * 学生管理视图内退宿块展开、删除退宿记录、筛选条件变化后调用。
     */
    function renderAbsenceRecords(){
        var container=document.getElementById('absenceRecordsList');
        if(!container) return;
        var className='', nameFilter='';
        var classSelectEl=document.getElementById('leaveFilterClass');
        var nameInputEl=document.getElementById('leaveFilterName');
        if(classSelectEl) className=classSelectEl.value;
        if(nameInputEl) nameFilter=nameInputEl.value.trim().toLowerCase();
        if(currentUser&&currentUser.role==='CLASS_ADMIN') className=currentUser.className;
        var records=(DB.absenceRecords||[]).filter(function(r){
            if(className&&r.className!==className) return false;
            if(nameFilter&&r.name.toLowerCase().indexOf(nameFilter)===-1) return false;
            return true;
        }).sort(function(a,b){ return (b.startDate||'')<(a.startDate||'')?-1:1; });
        var typeMap={personal:'事假',sick:'病假',other:'其他'};
        var isAdm=isAdmin();
        // 单行请假记录 HTML（供分片渲染逐条调用）
        function absenceRowHtml(r){
            var stu = r.studentId ? getStudentById(r.studentId) : DB.students.find(function(s){return s.className===r.className&&s.name===r.name;});
            var resideTag = isNonResidentStudent(stu) ? '<span style="color:var(--info)">走读</span>' : '住宿';
            return '<tr><td data-label="班级">'+r.className+'</td><td data-label="姓名">'+r.name+'</td><td data-label="住宿状态">'+resideTag+'</td><td data-label="宿舍号">'+getDormSnapshotDisplay(r.dormitory)+'</td><td data-label="床号">'+r.bed+'</td><td data-label="类型">'+(typeMap[r.type]||r.type)+'</td><td data-label="说明">'+(r.reason||'-')+'</td><td data-label="开始">'+r.startDate+'</td><td data-label="结束">'+r.endDate+'</td><td data-label="状态">'+getAbsenceStatusBadge(r)+'</td>'+(isAdm?'<td data-label="操作"><button class="btn btn-danger btn-xs" onclick="deleteAbsenceRecord(\''+r.id+'\')">删除</button></td>':'')+'</tr>';
        }
        var cntEl=document.getElementById('recCount-absence');
        if(cntEl) cntEl.textContent='（'+records.length+'条）';
        if(records.length===0){
            container.innerHTML='<div class="empty-state">暂无请假记录</div>';
            return;
        }
        // 表格骨架 + 分片填充（大量请假记录时不卡顿；删除按钮为内联 onclick，逐批插入即生效）
        container.innerHTML='<div style="overflow-x:auto"><table><thead><tr><th>班级</th><th>姓名</th><th>住宿状态</th><th>宿舍号</th><th>床号</th><th>请假类型</th><th>说明</th><th>开始日期</th><th>结束日期</th><th>状态</th>'+(isAdm?'<th>操作</th>':'')+'</tr></thead><tbody id="absenceTbody"></tbody></table></div>';
        renderListInChunks(document.getElementById('absenceTbody'), records, absenceRowHtml, 50);
    }

    // ==================== 导出数据视图 (含危险操作) ====================
    /**
     * 渲染「数据管理」视图：数据类型选择（扣分/退宿/请假）、班级/学生/宿舍/
     * 床号/日期范围等筛选器、结果预览表（分片渲染）与导出按钮。
     * @param {HTMLElement} container - contentArea 容器
     */
    function renderExportView(container) {
        if (!isAdmin() && currentUser.role !== 'CLASS_ADMIN') {
            container.innerHTML = '<div class="empty-state">无权限</div>';
            return;
        }

        var isClassAdmin = currentUser.role === 'CLASS_ADMIN';
        var classAccountClassName = isClassAdmin ? currentUser.className : '';

        // 班级下拉选项
        var classSet = {};
        DB.students.forEach(function(s) { if (s.className) classSet[s.className] = true; });
        var classList = sortClassNames(Object.keys(classSet));
        var classOptions = '<option value="">全部班级</option>';
        classList.forEach(function(c) { classOptions += '<option value="'+c+'">'+c+'</option>'; });
        if (isClassAdmin) {
            classOptions = '<option value="'+classAccountClassName+'" selected>'+classAccountClassName+'</option>';
        }

        var today = getTodayLocalStr();
        var defaultStart = new Date();
        defaultStart.setDate(defaultStart.getDate() - 30);
        var defaultStartStr = formatLocalDate(defaultStart);

        var isAdminRole = isAdmin();
        var summaryOption = isAdminRole ? '<option value="inspection_summary">巡查核实总结</option>' : '';
        var html = '<div class="content-header"><h2>📊 数据管理</h2></div>'
            + '<div class="card"><div class="card-header">筛选导出条件</div><div class="card-body"><div class="filter-section">'
            + '<div class="form-group"><label>数据类型</label><select id="exportDataType" onchange="onExportDataTypeChange()"><option value="deduction">扣分记录</option><option value="leave">退宿记录</option><option value="stop">停宿记录</option><option value="absence">请假记录</option>'+summaryOption+'</select></div>'
            + '<div class="form-group"><label>开始日期</label><input type="text" class="date-picker" id="exportStartDate" value="'+defaultStartStr+'"></div>'
            + '<div class="form-group"><label>结束日期</label><input type="text" class="date-picker" id="exportEndDate" value="'+today+'"></div>'
            + '<div class="form-group"><label>班级</label><select id="exportClass" onchange="onExportClassChange()">'+classOptions+'</select></div>'
            + '<div class="form-group" id="grpExportStudent"><label>学生</label><select id="exportStudent" onchange="onExportStudentChange()"></select></div>'
            + '<div class="form-group" id="grpExportAbsenceName" style="display:none"><label>学生姓名</label><select id="exportAbsenceName" onchange="onExportAbsenceNameChange()"></select></div>'
            + '<div class="form-group" id="grpExportDorm"><label>宿舍号</label><select id="exportDorm" onchange="onExportDormChange()"></select></div>'
            + '<div class="form-group" id="grpExportBed"><label>床号</label><select id="exportBed" onchange="onExportBedChange()"></select></div>'
            + '<button class="btn btn-primary" onclick="queryFilteredData()">🔍 查询筛选数据</button>'
            + '<button class="btn btn-outline" onclick="exportFilteredDataNew()">📥 导出筛选数据</button>'
            + '</div></div></div>';

        if (!isClassAdmin) {
            // 扣分记录专属操作卡片：切换到退宿/停宿类型时自动隐藏（onExportDataTypeChange）
            html += '<div id="deductionOnlyCards">'
                + '<div class="card"><div class="card-header">导出全部数据</div><div class="card-body"><button class="btn btn-primary" onclick="exportCSV()">📥 导出全部CSV</button></div></div>'
                + '<div class="card"><div class="card-header">危险操作</div><div class="card-body">'
                + '<button class="btn btn-danger" onclick="deleteAllRecords()">🗑️ 删除全部扣分记录</button>'
                + '<button class="btn btn-danger" style="margin-left:8px" onclick="deleteAllAbsenceRecords()">🗑️ 删除全部请假记录</button>'
                + '<button class="btn btn-danger" style="margin-left:8px" onclick="deleteAllStopRecords()">🗑️ 删除全部停宿记录</button>'
                + '<button class="btn btn-danger" style="margin-left:8px" onclick="deleteAllLeaveRecords()">🗑️ 删除全部退宿记录</button>'
                + '<p style="color:var(--danger);margin-top:8px;font-size:0.8571rem">此操作将永久删除对应类型的全部记录，不可恢复！</p></div></div>'
                + '<div class="card"><div class="card-header">☁️ 云端数据重置（新学期/数据清理）</div><div class="card-body">'
                + '<p style="margin:0 0 8px;color:var(--text-light);font-size:0.9rem">先在本机把数据整理到正确状态（删除不要的学生、导入新名单），再点此按钮：云端将被清空并以本机数据为准重新建立；其它设备点一次同步即统一下载，旧数据不会再同步回来。</p>'
                + '<button class="btn btn-danger" id="btnResetCloud" onclick="resetCloudData()">🔁 重置云端数据（以下发为准）</button>'
                + '<p style="color:var(--danger);margin-top:8px;font-size:0.8571rem">此操作会永久清空云端全部数据！执行时请让其它设备暂时不要点同步。</p></div></div>'
                + '</div>';
            // 账号管理 + 楼层分配管理（仅管理员）
            html += '<div class="card"><div class="card-header">👤 账号管理</div><div class="card-body" id="accountManageBody">'
                + buildAccountManageHtml() + '</div></div>';
            html += '<div class="card"><div class="card-header">🏢 楼层分配管理（生活老师负责楼层）</div><div class="card-body" id="floorAssignBody">'
                + buildFloorAssignHtml() + '</div></div>';
        }

        html += '<div id="queryResultArea" style="margin-top:16px;"></div>';
        container.innerHTML = html;

        // 初始化联动
        refreshExportSelects();
        initDatePickers(document); // 初始化导出筛选日期选择器
    }

    // ==================== 账号管理（仅管理员，数据管理视图内卡片） ====================
    // 角色中文标签
    var USER_ROLE_LABELS = { ADMIN:'管理员', STAFF:'生活老师', CLASS_ADMIN:'班主任' };
    function userRoleLabel(role){ return USER_ROLE_LABELS[role] || role; }
    // 负责楼层展示文案：STAFF 且 assignedFloors 非空 → "1、2楼"；空 → "全部楼层"；其他角色 → "-"
    function userFloorsText(u){
        if(u.role !== 'STAFF') return '-';
        if(Array.isArray(u.assignedFloors) && u.assignedFloors.length > 0){
            var nums = u.assignedFloors.slice().sort(function(a,b){ return a-b; })
                .map(function(fid){ var f=getFloorById(fid); return f ? f.sortOrder : fid; });
            return nums.join('、') + '楼';
        }
        return '全部楼层';
    }
    /**
     * 账号管理卡片内容：全部用户列表（用户名/姓名/角色/负责楼层/操作）+ 新增账号按钮。
     * 写操作（新增/编辑/删除/重置密码）统一在 app.js，落 DB 并 saveDB 同步。
     * @returns {string}
     */
    function buildAccountManageHtml(){
        if(!isAdmin()) return '<div class="empty-state">无权限</div>';
        var rows = (DB.users||[]).map(function(u){
            // 内置 admin/staff 账号受保护，不可删除（staff 为总生活老师）
            var protectedAcct = (u.username === 'admin' || u.username === 'staff');
            var isSelf = currentUser && String(u.id) === String(currentUser.id);
            var ops = '<button class="btn btn-outline btn-xs" onclick="openAccountModal('+u.id+')">编辑</button> '
                + '<button class="btn btn-outline btn-xs" onclick="resetUserPassword('+u.id+')">重置密码</button> '
                + ((protectedAcct||isSelf)
                    ? '<button class="btn btn-danger btn-xs" disabled style="opacity:.4" title="内置账号/当前登录账号不可删除">删除</button>'
                    : '<button class="btn btn-danger btn-xs" onclick="deleteUser('+u.id+')">删除</button>');
            return '<tr><td data-label="用户名">'+escapeHtmlAttr(u.username)+'</td>'
                + '<td data-label="姓名">'+escapeHtmlAttr(u.realName||'')+'</td>'
                + '<td data-label="角色">'+userRoleLabel(u.role)+'</td>'
                + '<td data-label="负责楼层">'+userFloorsText(u)+(u.buildingName?'（'+escapeHtmlAttr(u.buildingName)+'）':'')+'</td>'
                + '<td data-label="操作">'+ops+'</td></tr>';
        }).join('');
        return '<button class="btn btn-primary" onclick="openAccountModal(0)">➕ 新增账号</button>'
            + '<div style="overflow-x:auto;margin-top:10px"><table><thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>负责楼层</th><th>操作</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
            + '<p style="color:var(--gray-500);font-size:0.8571rem;margin-top:8px">新增账号默认密码 123456；重置密码也会重置为 123456。</p>';
    }

    // ==================== 楼层分配管理（仅管理员） ====================
    var floorAssignState = { staffId: null };  // 当前在卡片中选中的生活老师用户 ID
    /**
     * 楼层分配管理卡片内容：下拉选择 STAFF 用户 → 楼栋名称 + 楼层勾选 → 保存。
     * @returns {string}
     */
    function buildFloorAssignHtml(){
        if(!isAdmin()) return '<div class="empty-state">无权限</div>';
        var staffList = (DB.users||[]).filter(function(u){ return u.role === 'STAFF'; });
        if(staffList.length === 0) return '<div class="empty-state">暂无生活老师账号</div>';
        if(!floorAssignState.staffId || !staffList.some(function(u){ return String(u.id)===String(floorAssignState.staffId); })){
            floorAssignState.staffId = staffList[0].id;
        }
        var opts = staffList.map(function(u){
            return '<option value="'+u.id+'" '+(String(u.id)===String(floorAssignState.staffId)?'selected':'')+'>'+escapeHtmlAttr(u.username)+'（'+escapeHtmlAttr(u.realName||'')+'）</option>';
        }).join('');
        var html = '<div class="form-group"><label>选择生活老师</label>'
            + '<select id="assignStaffSelect" onchange="onAssignStaffChange()">'+opts+'</select></div>';
        html += buildFloorAssignDetailHtml();
        return html;
    }
    /**
     * 楼层分配详情区（楼栋名称输入 + 8 个楼层勾选 + 保存按钮），切换老师时局部刷新。
     * @returns {string}
     */
    function buildFloorAssignDetailHtml(){
        var u = (DB.users||[]).find(function(x){ return String(x.id) === String(floorAssignState.staffId); });
        if(!u) return '';
        var assigned = {};
        (u.assignedFloors||[]).forEach(function(fid){ assigned[fid] = true; });
        var checks = DB.floors.map(function(f){
            return '<label style="display:inline-flex;align-items:center;gap:4px;margin:4px 10px 4px 0;font-weight:500"><input type="checkbox" class="assign-floor-check" value="'+f.id+'" '+(assigned[f.id]?'checked':'')+'> '+f.name+'</label>';
        }).join('');
        return '<div class="form-group"><label>楼栋名称</label><input type="text" id="assignBuildingName" value="'+escapeHtmlAttr(u.buildingName||'')+'" placeholder="如：恩泽楼"></div>'
            + '<div class="form-group"><label>负责楼层（不勾选 = 全部楼层）</label><div class="checkbox-group">'+checks+'</div></div>'
            + '<button class="btn btn-primary" onclick="saveFloorAssign()">💾 保存分工配置</button>';
    }
    // 切换楼层分配卡片中的生活老师：更新状态并重绘详情区
    function onAssignStaffChange(){
        var sel = document.getElementById('assignStaffSelect');
        if(sel) floorAssignState.staffId = parseInt(sel.value, 10);
        var box = document.getElementById('floorAssignBody');
        if(box) box.innerHTML = buildFloorAssignHtml();
    }

    // 切换数据类型：
    // - 扣分记录：显示 班级/学生/宿舍号/床号
    // - 退宿/停宿记录：显示 班级/宿舍号/床号（隐藏学生姓名）
    // - 请假记录：显示 班级/学生姓名（隐藏学生/宿舍号/床号）
    function onExportDataTypeChange(){
        var typeEl=document.getElementById('exportDataType');
        var type=typeEl?typeEl.value:'deduction';
        var cards=document.getElementById('deductionOnlyCards');
        if(cards) cards.style.display=(type==='deduction'?'':'none');
        var isSummary=(type==='inspection_summary');
        var isLeaveOrStop=(type==='leave'||type==='stop');
        var isAbsence=(type==='absence');
        // 巡查核实总结：只保留日期范围，隐藏班级/学生/宿舍号/床号
        ['grpExportStudent','grpExportDorm','grpExportBed','grpExportAbsenceName'].forEach(function(id){
            var el=document.getElementById(id);
            if(el) el.style.display=isSummary?'none':(id==='grpExportStudent'?(type==='deduction'?'':'none'):(id==='grpExportAbsenceName'?(isAbsence?'':'none'):''));
        });
        // 班级筛选：巡查核实总结隐藏
        var classGrp=document.getElementById('exportClass');
        if(classGrp) classGrp.closest('.form-group').style.display=isSummary?'none':'';
        if(isSummary){
            var resultArea=document.getElementById('queryResultArea');
            if(resultArea) resultArea.innerHTML='';
            return;
        }
        if(isAbsence){ updateExportAbsenceNameList(); }
        else { refreshExportSelects(); }
        var resultArea=document.getElementById('queryResultArea');
        if(resultArea) resultArea.innerHTML='';
    }
    // 请假记录专用姓名下拉：按选中班级过滤；切换班级后默认选中第一个学生（保持原筛选习惯）
    function updateExportAbsenceNameList(){
        var clsEl=document.getElementById('exportClass');
        var className=clsEl?clsEl.value.trim():'';
        if(currentUser&&currentUser.role==='CLASS_ADMIN') className=currentUser.className;
        var nameEl=document.getElementById('exportAbsenceName');
        if(!nameEl) return;
        var pool=className?DB.students.filter(function(s){return s.className===className;}):DB.students;
        var nameSet={}; pool.forEach(function(s){ if(s.name) nameSet[s.name]=true; });
        var names=Object.keys(nameSet);
        nameEl.innerHTML='<option value="">全部学生</option>'+names.map(function(n){return '<option value="'+n+'">'+n+'</option>';}).join('');
        // 当前选中值仍在名单中则保留；否则默认选中该班级第一个学生（与原 datalist 版行为一致）
        if(nameEl.value && nameSet[nameEl.value]) return;
        nameEl.value=names.length>0?names[0]:'';
    }

    // 统一读取数据管理页筛选条件；班级账号强制锁定本班
    function getExportFilterValues(){
        var startDate=document.getElementById('exportStartDate').value;
        var endDate=document.getElementById('exportEndDate').value;
        var className=document.getElementById('exportClass')?document.getElementById('exportClass').value.trim():'';
        if(currentUser&&currentUser.role==='CLASS_ADMIN') className=currentUser.className;
        var dormRoom=document.getElementById('exportDorm')?document.getElementById('exportDorm').value.trim():'';
        var bed=document.getElementById('exportBed')?document.getElementById('exportBed').value.trim():'';
        var studentName=document.getElementById('exportStudent')?document.getElementById('exportStudent').value.trim():'';
        // 请假记录专用姓名筛选
        var absenceNameEl=document.getElementById('exportAbsenceName');
        var absenceName=absenceNameEl?absenceNameEl.value.trim():'';
        var typeEl=document.getElementById('exportDataType');
        var dataType=typeEl?typeEl.value:'deduction';
        return {startDate:startDate,endDate:endDate,className:className,dormRoom:dormRoom,bed:bed,studentName:studentName,absenceName:absenceName,dataType:dataType};
    }

    // 退宿/停宿记录筛选：记录中的 班级/宿舍号/床号/姓名 为登记时从学生数据同步的快照，
    // 与关联 DB.students 过滤等价；日期方面退宿为单日、停宿为"起 至 止"区间（有交集即命中）
    function getFilteredLeaveRecords(f){
        // 数据管理页仅展示「已通过」的退宿/停宿记录（待审核/驳回属于流程态，不纳入统计与导出）
        var records=(DB.leaveRecords||[]).filter(function(r){return r.type===f.dataType&&(!r.status||r.status==='approved');});
        records=records.filter(function(r){
            var dStart=r.date, dEnd=r.date;
            if(f.dataType==='stop'){
                var parts=String(r.date).split('至');
                if(parts.length>=2){ dStart=parts[0].trim(); dEnd=parts[1].trim(); }
            }
            if(dEnd<f.startDate||dStart>f.endDate) return false;
            if(f.className&&r.className!==f.className) return false;
            if(f.dormRoom&&r.dormitory!==f.dormRoom) return false;
            if(f.bed&&String(r.bed)!==String(f.bed)) return false;
            if(f.studentName&&r.name!==f.studentName) return false;
            return true;
        });
        records.sort(function(a,b){ return a.date<b.date?-1:(a.date>b.date?1:0); });
        return records;
    }

    // 请假记录筛选：班级/姓名 + 日期范围与请假区间 [startDate,endDate] 取交集
    function getFilteredAbsenceRecords(f){
        var records=(DB.absenceRecords||[]).filter(function(r){
            var dStart=r.startDate||'', dEnd=r.endDate||dStart;
            if(dStart&&dEnd&&(dEnd<f.startDate||dStart>f.endDate)) return false;
            if(f.className&&r.className!==f.className) return false;
            // 请假记录使用专用姓名筛选字段（absenceName）
            var nameFilter=f.absenceName||f.studentName;
            if(nameFilter&&r.name!==nameFilter) return false;
            return true;
        });
        records.sort(function(a,b){ return (a.startDate||'')<(b.startDate||'')?-1:1; });
        return records;
    }

    // 统一重建数据管理页所有筛选下拉（学生/宿舍号/床号）的选项；班级为 <select> 自身保持不变
    // 核心原则：按当前 班级/宿舍 范围实时重建，已选值仍在范围内则保留，否则回到"全部"提示项
    function refreshExportSelects() {
        var clsEl=document.getElementById('exportClass');
        var className=clsEl?clsEl.value.trim():'';
        if(currentUser&&currentUser.role==='CLASS_ADMIN') className=currentUser.className;
        var dormEl=document.getElementById('exportDorm');
        var bedEl=document.getElementById('exportBed');
        var stuEl=document.getElementById('exportStudent');
        var dormRoom=dormEl?dormEl.value.trim():'';
        var bedVal=bedEl?bedEl.value.trim():'';
        var stuVal=stuEl?stuEl.value.trim():'';

        // 宿舍号：班级→该班学生入住宿舍；未选班级（全部班级）→全部生效宿舍
        var dormSet={};
        if(className){
            DB.students.forEach(function(s){
                if(s.className!==className) return;
                var d=getDormitoryById(s.dormitoryId);
                if(d && !isDormitoryDeleted(d.roomNumber)) dormSet[d.roomNumber]=true;
            });
        } else {
            DB.dormitories.forEach(function(d){ if(!isDormitoryDeleted(d.roomNumber)) dormSet[d.roomNumber]=true; });
        }
        if(dormEl){
            dormEl.innerHTML='<option value="">全部宿舍</option>'+Object.keys(dormSet).sort().map(function(r){return '<option value="'+r+'">'+r+'</option>';}).join('');
            if(dormRoom && dormSet[dormRoom]) dormEl.value=dormRoom;
        }

        // 床号：宿舍→该宿舍（班级范围内）已入住床号；未选宿舍→1~8 全部床位
        var beds=[];
        if(dormRoom && dormSet[dormRoom]){
            var dormObj=DB.dormitories.find(function(d){return d.roomNumber===dormRoom;});
            if(dormObj){
                var bs={};
                getStudentsByDormitory(dormObj.id).forEach(function(s){
                    if((!className||s.className===className)&&s.bedNumber!=null) bs[String(s.bedNumber)]=true;
                });
                beds=Object.keys(bs).sort(function(a,b){return parseInt(a,10)-parseInt(b,10);});
            }
        }
        if(!beds.length) beds=['1','2','3','4','5','6','7','8'];
        if(bedEl){
            bedEl.innerHTML='<option value="">全部床号</option>'+beds.map(function(b){return '<option value="'+b+'">'+b+'</option>';}).join('');
            if(bedVal && beds.indexOf(bedVal)!==-1) bedEl.value=bedVal;
        }

        // 学生：班级→该班学生；未选班级时宿舍→该宿舍学生；否则全部学生
        var pool=DB.students;
        if(className) pool=pool.filter(function(s){return s.className===className;});
        else if(dormRoom){
            var d0=DB.dormitories.find(function(x){return x.roomNumber===dormRoom;});
            pool=d0?getStudentsByDormitory(d0.id):[];
        }
        var nameSet={}; pool.forEach(function(s){if(s.name) nameSet[s.name]=true;});
        if(stuEl){
            stuEl.innerHTML='<option value="">全部学生</option>'+Object.keys(nameSet).map(function(n){return '<option value="'+n+'">'+n+'</option>';}).join('');
            stuEl.value=(stuVal && nameSet[stuVal])?stuVal:'';
        }

        // 同步请假记录专用姓名下拉
        updateExportAbsenceNameList();
    }

    // 班级变化：清空学生/宿舍/床号/请假姓名，按新班级重建所有下拉
    function onExportClassChange(){
        var stuEl=document.getElementById('exportStudent'); if(stuEl) stuEl.value='';
        var dormEl=document.getElementById('exportDorm'); if(dormEl) dormEl.value='';
        var bedEl=document.getElementById('exportBed'); if(bedEl) bedEl.value='';
        var absNameEl=document.getElementById('exportAbsenceName'); if(absNameEl) absNameEl.value='';
        refreshExportSelects();
    }

    // 学生变化：自动回填班级/宿舍号/床号，再重建下拉使各选中态一致
    function onExportStudentChange(){
        var name=document.getElementById('exportStudent')?document.getElementById('exportStudent').value.trim():'';
        if(name){
            var student=DB.students.find(function(s){return s.name===name;});
            if(student){
                var classEl=document.getElementById('exportClass');
                if(classEl) classEl.value=student.className||'';
                var dorm=getDormitoryById(student.dormitoryId);
                var dormEl=document.getElementById('exportDorm');
                if(dormEl) dormEl.value=dorm?String(dorm.roomNumber):'';
                var bedEl=document.getElementById('exportBed');
                if(bedEl) bedEl.value=student.bedNumber!=null?String(student.bedNumber):'';
            }
        }
        refreshExportSelects();
    }

    // 宿舍号变化：清空床号并重建下拉（学生列表随班级/宿舍范围更新）
    function onExportDormChange(){
        var bedEl=document.getElementById('exportBed'); if(bedEl) bedEl.value='';
        refreshExportSelects();
    }

    // 床号变化：仅重建下拉保持选项最新
    function onExportBedChange(){
        refreshExportSelects();
    }

    // 请假记录姓名变化：不触发联动（可选"全部学生"，查询时按所选姓名过滤）
    function onExportAbsenceNameChange(){
        // 姓名列表始终显示该班级全部学生，选择后直接参与筛选，无需额外处理
    }

    // 查询筛选数据函数
    /**
     * 按当前筛选条件查询数据并分片渲染结果表。
     * 三分支：请假记录（#queryLeaveTbody）/退宿记录（#queryAbsTbody）/
     * 扣分记录（#queryDeductionTbody）；日期按本地时区字符串比较；
     * 空结果显示"暂无符合条件"占位。
     */
    function queryFilteredData() {
        if(!isAdmin() && currentUser.role !== 'CLASS_ADMIN'){toast('无权限','error');return;}
        var f=getExportFilterValues();
        if(!f.startDate || !f.endDate){toast('请选择日期范围','error');return;}
        if(f.startDate > f.endDate){toast('开始日期不能晚于结束日期','error');return;}

        var resultArea = document.getElementById('queryResultArea');
        if (!resultArea) return;

        // ===== 巡查核实总结 =====
        if(f.dataType==='inspection_summary'){
            if(!isAdmin()){toast('无权限','error');return;}
            var summaries=(DB.dailyInspectionSummaries||[]).filter(function(s){
                return s.summaryDate && s.summaryDate>=f.startDate && s.summaryDate<=f.endDate;
            }).sort(function(a,b){ return a.summaryDate<b.summaryDate?-1:(a.summaryDate>b.summaryDate?1:0); });
            if(summaries.length===0){
                resultArea.innerHTML='<div class="card"><div class="card-header">查询结果</div><div class="card-body"><div class="empty-state">该日期范围内暂无已生成的巡查核实总结</div></div></div>';
                return;
            }
            function floorText(sum){
                var nums=(sum.floors||[]).map(function(fid){ var fl=getFloorById(fid); return fl?fl.sortOrder:fid; }).sort(function(a,b){return a-b;});
                return nums.length?nums.join('、')+'楼':'-';
            }
            function summaryRowHtml(s){
                var rowId='sumrow_'+s.id;
                var detailId='sumdetail_'+s.id;
                return '<tr class="sum-row" data-sid="'+s.id+'" onclick="toggleSummaryDetail(\''+s.id+'\')" style="cursor:pointer">'
                    +'<td data-label="日期">'+s.summaryDate+'</td>'
                    +'<td data-label="楼栋">'+escapeHtmlAttr(s.buildingName||'-')+'</td>'
                    +'<td data-label="楼层">'+floorText(s)+'</td>'
                    +'<td data-label="值班老师">'+escapeHtmlAttr(s.confirmedByName||'-')+'</td>'
                    +'<td data-label="入宿人数">'+s.totalStudents+'</td>'
                    +'<td data-label="当天请假">'+s.absenceCount+'</td>'
                    +'<td data-label="退宿中">'+s.leavePendingCount+'</td>'
                    +'<td data-label="家长接走">'+s.pickedUpCount+'</td>'
                    +'<td data-label="无假条">'+s.anomalyCount+'</td>'
                    +'<td data-label="实到人数">'+s.actualCount+'</td>'
                    +'</tr>'
                    +'<tr id="'+detailId+'" style="display:none"><td colspan="10" style="background:var(--gray-50);padding:12px">'+buildSummaryDetailHtml(s)+'</td></tr>';
            }
            resultArea.innerHTML='<div class="card">'
                +'<div class="card-header">查询结果（巡查核实总结 '+summaries.length+' 条）<span style="font-weight:400;font-size:0.8571rem;color:var(--gray-500);margin-left:8px">点击行展开学生详情</span></div>'
                +(isAdmin()?'<div style="padding:10px 14px;border-bottom:1px solid var(--gray-100)"><button class="btn btn-primary" onclick="exportInspectionSummariesRange()">📥 导出 Excel（每天一个 Sheet）</button></div>':'')
                +'<div style="overflow-x:auto;"><table>'
                +'<thead><tr><th>日期</th><th>楼栋</th><th>楼层</th><th>值班老师</th><th>入宿人数</th><th>当天请假</th><th>退宿中</th><th>家长接走</th><th>无假条</th><th>实到人数</th></tr></thead>'
                +'<tbody id="querySummaryTbody"></tbody>'
                +'</table></div></div>';
            renderListInChunks(document.getElementById('querySummaryTbody'), summaries, summaryRowHtml, 50);
            return;
        }

        // ===== 退宿/停宿记录 =====
        if(f.dataType==='leave' || f.dataType==='stop'){
            var typeLabel=f.dataType==='leave'?'退宿':'停宿';
            var dateLabel=f.dataType==='leave'?'退宿时间':'停宿时间段';
            var leaveRecords=getFilteredLeaveRecords(f);
            if(leaveRecords.length===0){
                resultArea.innerHTML='<div class="card"><div class="card-header">查询结果</div><div class="card-body"><div class="empty-state">暂无符合条件的'+typeLabel+'记录</div></div></div>';
                return;
            }
            function queryLeaveRowHtml(r){
                return '<tr><td data-label="'+dateLabel+'">'+r.date+'</td>'
                    + '<td data-label="宿舍号">'+getDormSnapshotDisplay(r.dormitory)+'</td>'
                    + '<td data-label="床号">'+r.bed+'</td>'
                    + '<td data-label="班级">'+r.className+'</td>'
                    + '<td data-label="姓名">'+r.name+'</td>'
                    + '<td data-label="原因">'+r.reason+'</td></tr>';
            }
            resultArea.innerHTML='<div class="card">'
                + '<div class="card-header">查询结果（'+typeLabel+'记录 '+leaveRecords.length+' 条）</div>'
                + '<div style="overflow-x:auto;"><table>'
                + '<thead><tr><th>'+dateLabel+'</th><th>宿舍号</th><th>床号</th><th>班级</th><th>姓名</th><th>原因</th></tr></thead>'
                + '<tbody id="queryLeaveTbody"></tbody>'
                + '</table></div></div>';
            renderListInChunks(document.getElementById('queryLeaveTbody'), leaveRecords, queryLeaveRowHtml, 50);
            return;
        }

        // ===== 请假记录 =====
        if(f.dataType==='absence'){
            var absRecords=getFilteredAbsenceRecords(f);
            if(absRecords.length===0){
                resultArea.innerHTML='<div class="card"><div class="card-header">查询结果</div><div class="card-body"><div class="empty-state">暂无符合条件的请假记录</div></div></div>';
                return;
            }
            var absTypeMap={personal:'事假',sick:'病假',other:'其他'};
            var todayStr=getTodayStr();
            function queryAbsRowHtml(r){
                var absSt=(r.endDate&&r.endDate<todayStr)?'已结束':'请假中';
                return '<tr><td data-label="班级">'+r.className+'</td>'
                    + '<td data-label="姓名">'+r.name+'</td>'
                    + '<td data-label="类型">'+(absTypeMap[r.type]||r.type)+'</td>'
                    + '<td data-label="说明">'+(r.reason||'-')+'</td>'
                    + '<td data-label="开始">'+r.startDate+'</td>'
                    + '<td data-label="结束">'+r.endDate+'</td>'
                    + '<td data-label="状态">'+absSt+'</td></tr>';
            }
            resultArea.innerHTML='<div class="card">'
                + '<div class="card-header">查询结果（请假记录 '+absRecords.length+' 条）</div>'
                + '<div style="overflow-x:auto;"><table>'
                + '<thead><tr><th>班级</th><th>姓名</th><th>请假类型</th><th>说明</th><th>开始日期</th><th>结束日期</th><th>状态</th></tr></thead>'
                + '<tbody id="queryAbsTbody"></tbody>'
                + '</table></div></div>';
            renderListInChunks(document.getElementById('queryAbsTbody'), absRecords, queryAbsRowHtml, 50);
            return;
        }

        // ===== 扣分记录（原有逻辑保持不变） =====
        var startDate=f.startDate, endDate=f.endDate, className=f.className, dormRoom=f.dormRoom, bed=f.bed, studentName=f.studentName;
        var records = DB.deductionRecords.filter(function(r) {
            if (r.recordDate < startDate || r.recordDate > endDate) return false;
            var student = r.studentId ? getStudentById(r.studentId) : null;
            var dorm = getDormitoryById(r.dormitoryId);
            if (className && getClassNameForRecord(r) !== className) return false;
            if (dormRoom && (!dorm || dorm.roomNumber !== dormRoom)) return false;
            if (bed && (!student || student.bedNumber !== bed)) return false;
            if (studentName && (!student || student.name !== studentName)) return false;
            return true;
        });

        records.sort(function(a, b) {
            var dateCompare = a.recordDate.localeCompare(b.recordDate);
            if (dateCompare !== 0) return dateCompare;
            var dormA = getDormitoryById(a.dormitoryId);
            var dormB = getDormitoryById(b.dormitoryId);
            var roomA = dormA ? dormA.roomNumber : '';
            var roomB = dormB ? dormB.roomNumber : '';
            var roomCompare = roomA.localeCompare(roomB);
            if (roomCompare !== 0) return roomCompare;
            var bedA = getBedNumberForSort(a);
            var bedB = getBedNumberForSort(b);
            return bedA - bedB;
        });

        var resultArea = document.getElementById('queryResultArea');
        if (!resultArea) return;

        if (records.length === 0) {
            resultArea.innerHTML = '<div class="card"><div class="card-header">查询结果</div><div class="card-body"><div class="empty-state">暂无符合条件的扣分记录</div></div></div>';
            return;
        }

        function queryDeductionRowHtml(r) {
            var dorm = getDormitoryById(r.dormitoryId);
            var student = r.studentId ? getStudentById(r.studentId) : null;
            var hyNames = (r.hygieneItemIds || []).map(getItemNameByIdOrCustom).filter(Boolean).join('、');
            var disNames = (r.disciplineItemIds || []).map(getItemNameByIdOrCustom).filter(Boolean).join('、');
            var bedNumber = student ? (student.bedNumber || '-') : '-';
            var classNameVal = getClassNameForRecord(r);
            var studentNameVal = student ? student.name : '宿舍集体';
            return '<tr>'
                + '<td data-label="日期">' + r.recordDate + '</td>'
                + '<td data-label="宿舍号">' + getDormDisplayNameById(r.dormitoryId) + '</td>'
                + '<td data-label="床号">' + bedNumber + '</td>'
                + '<td data-label="班级">' + classNameVal + '</td>'
                + '<td data-label="学生">' + studentNameVal + '</td>'
                + '<td data-label="卫生项目">' + (hyNames || '-') + '</td>'
                + '<td data-label="卫生扣分">' + (r.hygieneScore || 0) + '</td>'
                + '<td data-label="纪律项目">' + (disNames || '-') + '</td>'
                + '<td data-label="纪律扣分">' + (r.disciplineScore || 0) + '</td>'
                + '<td data-label="备注">' + escapeHtmlAttr(r.remark || '-') + '</td>'
                + '</tr>';
        }

        resultArea.innerHTML = '<div class="card">'
            + '<div class="card-header">查询结果（' + records.length + '条记录）</div>'
            + '<div style="overflow-x:auto;"><table>'
            + '<thead><tr><th>日期</th><th>宿舍号</th><th>床号</th><th>班级</th><th>学生</th><th>卫生加扣分</th><th>卫生分值</th><th>纪律加扣分</th><th>纪律分值</th><th>备注</th></tr></thead>'
            + '<tbody id="queryDeductionTbody"></tbody>'
            + '</table></div></div>';
        renderListInChunks(document.getElementById('queryDeductionTbody'), records, queryDeductionRowHtml, 50);
    }

    /**
     * 构建巡查核实总结的学生详情 HTML（退宿中/家长接走/无假条三类列表）。
     * @param {object} sum - dailyInspectionSummaries 记录
     * @returns {string}
     */
    function buildSummaryDetailHtml(sum){
        function block(title, list, cols){
            var h='<div style="margin-top:10px"><div style="font-weight:700;margin-bottom:4px">'+title+'（'+(list||[]).length+'人）</div>';
            if(!list||list.length===0){ h+='<div style="color:var(--gray-500);font-size:0.8571rem">（暂无）</div></div>'; return h; }
            h+='<div style="overflow-x:auto"><table style="font-size:0.8571rem"><thead><tr>'+cols.map(function(c){return '<th>'+c.label+'</th>';}).join('')+'</tr></thead><tbody>';
            list.forEach(function(r){
                h+='<tr>'+cols.map(function(c){ return '<td>'+escapeHtmlAttr(r[c.key]==null?'-':String(r[c.key]))+'</td>'; }).join('')+'</tr>';
            });
            return h+'</tbody></table></div></div>';
        }
        return block('退宿中', sum.leavePendingDetails, [
                {key:'name',label:'姓名'},{key:'className',label:'班级'},{key:'bed',label:'床号'},{key:'dormitory',label:'宿舍'},{key:'type',label:'类型'}
            ])
            +block('家长接走', sum.pickedUpDetails, [
                {key:'name',label:'姓名'},{key:'className',label:'班级'},{key:'bed',label:'床号'},{key:'dormitory',label:'宿舍'},{key:'confirmedBy',label:'确认人'},{key:'note',label:'备注'}
            ])
            +block('无假条', sum.anomalyDetails, [
                {key:'name',label:'姓名'},{key:'className',label:'班级'},{key:'bed',label:'床号'},{key:'dormitory',label:'宿舍'},{key:'reportedBy',label:'上报人'},{key:'note',label:'备注'}
            ]);
    }
    /** 展开/收起巡查总结行的学生详情 */
    function toggleSummaryDetail(sid){
        var tr=document.getElementById('sumdetail_'+sid);
        if(tr) tr.style.display=(tr.style.display==='none'?'':'none');
    }

    /**
     * 导出筛选后的数据为 XLSX 工作簿（SheetJS/xlsx）。
     * 按所选数据类型（扣分/退宿/请假）构建表头与行数据，导出文件名含本地日期。
     */
    function exportFilteredDataNew(){
        if(!isAdmin() && currentUser.role !== 'CLASS_ADMIN'){toast('无权限','error');return;}
        var f=getExportFilterValues();
        if(!f.startDate||!f.endDate){toast('请选择日期范围','error');return;}
        if(f.startDate>f.endDate){toast('开始日期不能晚于结束日期','error');return;}

        // ===== 巡查核实总结导出（仅 ADMIN，每天一个 Sheet） =====
        if(f.dataType==='inspection_summary'){
            exportInspectionSummariesRange();
            return;
        }

        // ===== 退宿/停宿记录导出（字段与原退宿停宿页导出保持一致） =====
        if(f.dataType==='leave' || f.dataType==='stop'){
            var lr=getFilteredLeaveRecords(f);
            if(lr.length===0){toast('暂无数据','error');return;}
            var isLeave=f.dataType==='leave';
            var lCsv='\uFEFF班级,姓名,宿舍号,床号,'+(isLeave?'退宿时间,退宿原因':'停宿时间段,停宿原因')+'\n';
            lr.forEach(function(r){
                lCsv+=r.className+','+r.name+','+getDormSnapshotDisplay(r.dormitory)+','+r.bed+','+r.date+','+r.reason+'\n';
            });
            var lBlob=new Blob([lCsv],{type:'text/csv;charset=utf-8;'});
            var lLink=document.createElement('a');
            lLink.href=URL.createObjectURL(lBlob);
            lLink.download=(isLeave?'退宿记录':'停宿记录')+'_'+getTodayLocalStr()+'.csv';
            lLink.click();
            toast('导出成功');
            return;
        }

        // ===== 请假记录导出（班级账号仅本班，由 getExportFilterValues 强制锁定） =====
        if(f.dataType==='absence'){
            var ar=getFilteredAbsenceRecords(f);
            if(ar.length===0){toast('暂无数据','error');return;}
            var aTypeMap={personal:'事假',sick:'病假',other:'其他'};
            var tStr=getTodayStr();
            var aCsv='\uFEFF班级,姓名,请假类型,说明,开始日期,结束日期,状态\n';
            ar.forEach(function(r){
                var absSt=(r.endDate&&r.endDate<tStr)?'已结束':'请假中';
                aCsv+=r.className+','+r.name+','+(aTypeMap[r.type]||r.type)+','+(r.reason||'-')+','+r.startDate+','+r.endDate+','+absSt+'\n';
            });
            var aBlob=new Blob([aCsv],{type:'text/csv;charset=utf-8;'});
            var aLink=document.createElement('a');
            aLink.href=URL.createObjectURL(aBlob);
            aLink.download='请假记录_'+getTodayLocalStr()+'.csv';
            aLink.click();
            toast('导出成功');
            return;
        }

        // ===== 扣分记录导出（原有逻辑保持不变） =====
        var startDate=f.startDate, endDate=f.endDate, className=f.className, dormRoom=f.dormRoom, bed=f.bed, studentName=f.studentName;
        var records=DB.deductionRecords.filter(function(r){
            if(r.recordDate<startDate||r.recordDate>endDate) return false;
            var student=r.studentId?getStudentById(r.studentId):null;
            var dorm=getDormitoryById(r.dormitoryId);
            if(className && getClassNameForRecord(r)!==className) return false;
            if(dormRoom && (!dorm || dorm.roomNumber!==dormRoom)) return false;
            if(bed && (!student || student.bedNumber!==bed)) return false;
            if(studentName && (!student || student.name!==studentName)) return false;
            return true;
        });
        records.sort(function(a,b){
            var dateCompare=a.recordDate.localeCompare(b.recordDate);
            if(dateCompare!==0) return dateCompare;
            var dormA=getDormitoryById(a.dormitoryId); var dormB=getDormitoryById(b.dormitoryId);
            var roomA=dormA?dormA.roomNumber:''; var roomB=dormB?dormB.roomNumber:'';
            var roomCompare=roomA.localeCompare(roomB);
            if(roomCompare!==0) return roomCompare;
            var bedA=getBedNumberForSort(a); var bedB=getBedNumberForSort(b);
            return bedA-bedB;
        });
        var csv='\uFEFF日期,宿舍号,床号,班级,学生,卫生加扣分,扣分值,纪律加扣分,扣分值,备注\n';
        records.forEach(function(r){
            var dorm=getDormitoryById(r.dormitoryId);
            var student=r.studentId?getStudentById(r.studentId):null;
            var hyNames=(r.hygieneItemIds||[]).map(getItemNameByIdOrCustom).filter(Boolean).join('、');
            var disNames=(r.disciplineItemIds||[]).map(getItemNameByIdOrCustom).filter(Boolean).join('、');
            var bedNumber=student?(student.bedNumber||'-'):'-';
            var classNameVal=getClassNameForRecord(r);
            var studentNameVal=student?student.name:'宿舍集体';
            csv+=r.recordDate+','+getDormDisplayNameById(r.dormitoryId)+','+bedNumber+','+classNameVal+','+studentNameVal+','+(hyNames||'-')+','+(r.hygieneScore||0)+','+(disNames||'-')+','+(r.disciplineScore||0)+','+escapeHtmlAttr(r.remark||'').replace(/,/g,'，')+'\n';
        });
        var fileName;
        if(startDate===endDate && !className && !dormRoom && !bed && !studentName){
            fileName = startDate+'宿舍管理情况登记表';
        } else if(className && !studentName && !dormRoom && !bed){
            fileName = className+'宿舍管理情况登记表';
        } else if(studentName){
            fileName = studentName+'宿舍管理情况登记表';
        } else {
            var weekNum = getWeekNumber(startDate);
            fileName = '第'+weekNum+'周宿舍管理情况登记表';
        }
        var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
        var link=document.createElement('a');
        link.href=URL.createObjectURL(blob);
        link.download=fileName+'.csv';
        link.click();
        toast('导出成功');
    }
    function getWeekNumber(dateStr){
        var refDate = new Date('2026-08-28');
        var date = new Date(dateStr);
        var diffDays = Math.floor((date - refDate) / (1000*60*60*24));
        if(diffDays<0) return 1;
        return Math.floor(diffDays/7)+1;
    }
    /**
     * 旧版 CSV 导出（兼容入口）：把扣分记录按行拼成 CSV 文本并触发下载。
     * 新增导出建议使用 exportFilteredDataNew（XLSX）。
     */
    function exportCSV(){
        if(!isAdmin()){toast('无权限','error');return;}
        var records=DB.deductionRecords;
        if(records.length===0){toast('暂无数据','error');return;}
        records.sort(function(a,b){
            var dateCompare=a.recordDate.localeCompare(b.recordDate);
            if(dateCompare!==0) return dateCompare;
            var dormA=getDormitoryById(a.dormitoryId); var dormB=getDormitoryById(b.dormitoryId);
            var roomA=dormA?dormA.roomNumber:''; var roomB=dormB?dormB.roomNumber:'';
            var roomCompare=roomA.localeCompare(roomB);
            if(roomCompare!==0) return roomCompare;
            var bedA=getBedNumberForSort(a); var bedB=getBedNumberForSort(b);
            return bedA-bedB;
        });
        var csv='\uFEFF日期,宿舍号,床号,班级,学生,卫生加扣分,扣分值,纪律加扣分,扣分值,备注\n';
        records.forEach(function(r){
            var dorm=getDormitoryById(r.dormitoryId);
            var student=r.studentId?getStudentById(r.studentId):null;
            var hyNames=(r.hygieneItemIds||[]).map(getItemNameByIdOrCustom).filter(Boolean).join('、');
            var disNames=(r.disciplineItemIds||[]).map(getItemNameByIdOrCustom).filter(Boolean).join('、');
            var bedNumber=student?(student.bedNumber||'-'):'-';
            var classNameVal=getClassNameForRecord(r);
            var studentNameVal=student?student.name:'宿舍集体';
            csv+=r.recordDate+','+getDormDisplayNameById(r.dormitoryId)+','+bedNumber+','+classNameVal+','+studentNameVal+','+(hyNames||'-')+','+(r.hygieneScore||0)+','+(disNames||'-')+','+(r.disciplineScore||0)+','+escapeHtmlAttr(r.remark||'').replace(/,/g,'，')+'\n';
        });
        var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
        var link=document.createElement('a');
        link.href=URL.createObjectURL(blob);
        link.download='全部扣分记录_'+getTodayLocalStr()+'.csv';
        link.click();
        toast('导出成功');
    }

// ---- shared globals explicitly mounted on window ----
window.toast = toast;
window.handleError = handleError;
window.categorizeError = categorizeError;
window.appendErrorLog = appendErrorLog;
window.safeAsync = safeAsync;
window.renderListInChunks = renderListInChunks;


