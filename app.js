/* ============================================================
 * app.js —— 应用控制层：路由、状态与业务事件
 * ------------------------------------------------------------
 * 职责：
 *   1. 登录/登出与会话保持（handleLogin/handleLogout/checkSavedLogin），
 *      密码 SHA-256 直比与旧明文平滑迁移，记住密码（存哈希）；
 *   2. 视图路由（switchView/initView/renderView/goBack/移动端历史栈）、
 *      侧栏开关、登录后按角色显隐菜单；
 *   3. 业务操作：扣分登记提交（submitDeduction）、记录删除/修改
 *      （deleteRecord/editRecord/saveEditedRecord）、学生增删/调寝/
 *      批量导入（addStudent/deleteStudent/saveTransfer/handleExcelImport）、
 *      宿舍号与扣分项目管理、请假/停宿/退宿登记与审核
 *      （addLeaveRecord/approveLeaveRecord/applyLeaveFilter 等）；
 *   4. 全局 UI 状态：currentUser/selectedFloorId/selectedDormitoryId/
 *      学生名单检索条件/登记表单状态/折叠状态/字号缩放；
 *   5. 启动引导（DOMContentLoaded → initializeData）、网络在线/离线提示、
 *      Service Worker 注册与更新提示。
 *
 * 架构约定：
 *   - 本文件只写"做什么"（改 DB + 调用 saveDB + 触发重绘），界面 HTML
 *     拼装与视图渲染在 ui.js；数据读写在 data.js；云端同步在 sync.js；
 *   - 所有异步入口统一用 safeAsync(Impl, 上下文, {retry:true}) 包装，
 *     外层函数保留 _busy 防重入，异常由 handleError 分类处理；
 *   - HTML 内联 onclick 调用的函数全部声明在本文件（全局函数）。
 *
 * 主要依赖：config.js、data.js（DB/查询/哈希/saveDBToLocal）、sync.js
 *   （initializeData/saveDB/manualSync/resetCloudData）、ui.js（全部 renderXxxView/
 *   toast/handleError）、index.html 的 DOM 元素。
 *
 * 对外暴露：文件末尾把 currentUser/currentView/selectedFloorId/
 *   selectedDormitoryId 等状态挂载 window；函数声明为全局供 onclick 与
 *   ui.js/sync.js 回调使用。
 * ============================================================ */

    var currentUser = null;             // 当前登录用户对象（null=未登录）
    var currentView = 'hierarchy';     // 当前视图名（对应 renderXxxView）
    var selectedFloorId = null;
    var selectedDormitoryId = null;

    // ==================== 移动端历史栈 ====================
    var viewHistory = [];

    // ==================== 学生名单检索状态 ====================
    var studentSearch = { className: '', name: '', residence: '' };


    // ==================== 登录状态保持 ====================
    /**
     * 恢复登录会话：sessionStorage 中有 currentUser 且账号仍存在则直接进入主应用；
     * 同时处理"记住密码"回填——新格式回填 passwordHash（登录走哈希直比），
     * 旧明文凭证最后一次回填并后台升级为哈希存储。
     */
    function checkSavedLogin() {
        var savedUser = sessionStorage.getItem('currentUser');
        if (savedUser) {
            try {
                var user = JSON.parse(savedUser);
                var found = DB.users.find(function(u){return u.id===user.id;});
                if (found) {
                    currentUser = found;
                    document.getElementById('loginPage').style.display='none';
                    document.getElementById('mainApp').style.display='flex';
                    updateHeaderForUser(found);
                    loadFontScaleForStaff();
                    initView();
                }
            } catch(e) {}
        }
        var remembered = localStorage.getItem('rememberedCredentials');
        if (remembered) {
            try {
                var cred = JSON.parse(remembered);
                document.getElementById('loginUsername').value = cred.username;
                document.getElementById('rememberMe').checked = true;
                if (cred.passwordHash) {
                    // 新格式：回填哈希，登录时走直比分支（不再二次哈希）
                    document.getElementById('loginPassword').value = cred.passwordHash;
                } else if (cred.password) {
                    // 旧格式（明文凭证）：最后一次回填明文，同时后台升级为哈希存储，本机不再保留明文
                    document.getElementById('loginPassword').value = cred.password;
                    if (typeof hashPassword === 'function') {
                        hashPassword(cred.password).then(function(h){
                            localStorage.setItem('rememberedCredentials', JSON.stringify({username: cred.username, passwordHash: h}));
                        });
                    }
                }
            } catch(e) {}
        }
    }
    function updateHeaderForUser(user) {
        document.getElementById('userNameDisplay').textContent = user.realName;
        document.getElementById('userAvatar').textContent = user.realName.charAt(0);
        var admin = user.role === 'ADMIN';
        var classAdmin = user.role === 'CLASS_ADMIN';
        document.getElementById('roleBadge').textContent = admin ? '👨‍💼 管理人员' : (classAdmin ? '🏫 班主任' : '📝 生活老师');

        // 先隐藏所有菜单
        var menuIds = ['navHierarchy', 'navAdd', 'navStats', 'navInspection', 'navStudents', 'navItems', 'navLeaveManage', 'navExport'];
        menuIds.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        if (admin) {
            // 管理员显示全部菜单
            ['navHierarchy','navAdd','navStats','navInspection','navStudents','navItems','navLeaveManage','navExport'].forEach(function(id){
                document.getElementById(id).style.display = 'flex';
            });
        } else if (classAdmin) {
            // 班级账号：住宿信息（仅本班数据）+ 学生管理 + 数据管理
            document.getElementById('navHierarchy').style.display = 'flex';
            document.getElementById('navLeaveManage').style.display = 'flex';
            document.getElementById('navExport').style.display = 'flex';
        } else {
            // 普通生活老师（staff）：住宿信息 + 扣分登记 + 统计报表 + 巡查核实 + 学生管理
            document.getElementById('navHierarchy').style.display = 'flex';
            document.getElementById('navAdd').style.display = 'flex';
            document.getElementById('navStats').style.display = 'flex';
            document.getElementById('navInspection').style.display = 'flex';
            document.getElementById('navLeaveManage').style.display = 'flex';
            // 数据管理菜单对 staff 隐藏
            document.getElementById('navExport').style.display = 'none';
        }
        buildBottomNav();
    }

    // ==================== 登录/登出 ====================
    // 登录入口经 safeAsync 统一捕获异常（本地数据加载/哈希计算等），失败后可点击重试
    /**
     * 登录入口（登录按钮/回车调用）：经 safeAsync 统一捕获异常，失败可点击重试。
     */
    function handleLogin(){
        safeAsync(handleLoginImpl, '登录', { retry: true });
    }
    /**
     * 登录实际逻辑：校验账号 → 密码校验（有哈希走 SHA-256 直比；旧明文账号比对通过后
     * 先哈希入库再放行，平滑迁移）→ completeLogin 进入主应用。
     * 勾选"记住密码"时保存 passwordHash（绝不保存明文）。
     */
    function handleLoginImpl(){
        var username=document.getElementById('loginUsername').value.trim();
        var password=document.getElementById('loginPassword').value;
        var ready;
        if(!DB||!DB.users){
            loadDBFromLocal();
            ready = Promise.resolve(ensureCorrectUsers()); // 异步版本：等待账号补齐（含密码哈希计算）后再校验
        } else {
            ready = Promise.resolve();
        }
        // 返回 Promise 链：链内任何异常都会传递给外层 safeAsync 统一处理
        return ready.then(function(){
            if(!DB||!DB.users){toast('数据加载失败','error');return;}
            var user=DB.users.find(function(u){return u.username===username;});
            if(!user){ showLoginError(); return; }
            var hasHash = typeof user.passwordHash === 'string' && user.passwordHash.length > 0;
            var hasPlain = typeof user.password === 'string' && user.password.length > 0;
            if(!hasHash && hasPlain){
                // 旧明文账号（待迁移）：明文比对通过后，先哈希入库再放行（平滑升级）
                if(user.password !== password){ showLoginError(); return; }
                hashPassword(user.password).then(function(h){
                    user.passwordHash = h;
                    delete user.password;
                    v3MarkDirty('user', user.id);
                    saveDB(); // 落库并把哈希后的用户行加入上传队列，覆盖云端旧明文
                    completeLogin(user, username, h);
                });
                return;
            }
            // 直比分支：密码框被"记住密码"回填的是 passwordHash 本身（64位十六进制），
            // 此时不能再次哈希（hash(hash(p)) ≠ hash(p)），直接与存储哈希比对
            if(hasHash && /^[0-9a-f]{64}$/i.test(password) && password === user.passwordHash){
                completeLogin(user, username, password);
                return;
            }
            // 标准路径：输入密码哈希后与存储的 passwordHash 比对
            hashPassword(password).then(function(inputHash){
                if(hasHash && user.passwordHash === inputHash){
                    completeLogin(user, username, inputHash);
                } else {
                    showLoginError();
                }
            });
        });
    }
    // 登录失败提示：统一提示，不泄露具体失败原因
    function showLoginError(){
        document.getElementById('loginError').style.display='block';
        setTimeout(function(){document.getElementById('loginError').style.display='none';},2000);
    }
    // 登录校验通过后的共用逻辑（会话缓存/记住凭证/进入主界面）
    // 第三参数为已计算好的密码哈希（SHA-256 十六进制），"记住密码"只存哈希，本机不落明文
    function completeLogin(user, username, passwordHash){
        currentUser=user;
        sessionStorage.setItem('currentUser', JSON.stringify({id:user.id, username:user.username, role:user.role, realName:user.realName}));
        if(document.getElementById('rememberMe').checked){
            localStorage.setItem('rememberedCredentials', JSON.stringify({username:username, passwordHash:passwordHash}));
        } else {
            localStorage.removeItem('rememberedCredentials');
        }
        document.getElementById('loginPage').style.display='none';
        document.getElementById('mainApp').style.display='flex';
        updateHeaderForUser(user);
        loadFontScaleForStaff();
        initView();
        toast('欢迎，'+user.realName+'！');
    }
    /**
     * 登出：清除会话（sessionStorage）、回到登录页；"记住密码"保留的凭证不动。
     */
    function handleLogout(){
        currentUser=null;
        // 重置字体缩放
        applyFontScale(100);
        document.body.classList.remove('staff-font-scale');
        var panel=document.getElementById('fontScalePanel');
        if(panel) panel.classList.remove('show');
        // 仅清除 sessionStorage 中的登录状态，保留 localStorage 中的"记住密码"凭证
        sessionStorage.removeItem('currentUser');
        document.getElementById('mainApp').style.display='none';
        document.getElementById('loginPage').style.display='flex';
        // 若已勾选"记住账号密码"，保留账号密码输入框内容（localStorage 中的凭证不清除）；
        // 未勾选时清空输入框，避免敏感信息残留。
        var rememberEl = document.getElementById('rememberMe');
        if (!rememberEl || !rememberEl.checked) {
            document.getElementById('loginUsername').value='';
            document.getElementById('loginPassword').value='';
        } else {
            // 勾选记住密码时，用存储的哈希回填替换输入框中刚输入的明文，避免明文残留在页面
            try {
                var cred = JSON.parse(localStorage.getItem('rememberedCredentials') || 'null');
                if (cred && cred.passwordHash) {
                    document.getElementById('loginUsername').value = cred.username;
                    document.getElementById('loginPassword').value = cred.passwordHash;
                }
            } catch(e) {}
        }
        // rememberMe 复选框状态保持不变（用户主动取消勾选时，handleLogin 会清除 localStorage 凭证）
    }

    // ==================== 字体缩放（仅STAFF移动端） ====================
    var FONT_SCALE_KEY='dorm_font_scale_staff';
    var FONT_BASE=14; // 基准字号 14px
    var FONT_MIN=100, FONT_MAX=160, FONT_STEP=5;

    function applyFontScale(scale){
        scale=Math.max(FONT_MIN,Math.min(FONT_MAX,scale));
        var newSize=FONT_BASE*scale/100;
        document.documentElement.style.fontSize=newSize+'px';
        var valEl=document.getElementById('fontScaleValue');
        if(valEl) valEl.textContent=scale+'%';
        return scale;
    }
    function adjustFont(delta){
        var current=getStoredFontScale();
        var newScale=applyFontScale(current+delta);
        localStorage.setItem(FONT_SCALE_KEY,newScale.toString());
    }
    function resetFont(){
        applyFontScale(100);
        localStorage.setItem(FONT_SCALE_KEY,'100');
    }
    function toggleFontPanel(){
        var panel=document.getElementById('fontScalePanel');
        if(panel) panel.classList.toggle('show');
    }
    function getStoredFontScale(){
        var v=parseInt(localStorage.getItem(FONT_SCALE_KEY));
        return (isNaN(v)||v<FONT_MIN||v>FONT_MAX)?100:v;
    }
    function loadFontScaleForStaff(){
        if(!currentUser||currentUser.role!=='STAFF') return;
        if(window.innerWidth>768) return;
        document.body.classList.add('staff-font-scale');
        var scale=getStoredFontScale();
        applyFontScale(scale);
    }

    // ==================== 视图切换 ====================
    function updateNavActive(view){
        var items=document.querySelectorAll('.nav-item, .bottom-nav-item');
        for(var i=0;i<items.length;i++){
            if(items[i].getAttribute('data-view')===view) items[i].classList.add('active');
            else items[i].classList.remove('active');
        }
        // 首页为手机端根页面，隐藏返回按钮
        var bb=document.getElementById('mobileBackBtn');
        if(bb) bb.style.display=(view==='home')?'none':'';
    }
    /**
     * 切换到指定视图：压入移动端历史栈、高亮导航、重绘内容区并回到顶部。
     * @param {string} view - 视图名：home/hierarchy/add/stats/students/items/
     *   leavemanage/export
     */
    function switchView(view){
        // 如果当前视图与目标不同，且不是通过返回操作，则压入历史
        if (currentView !== view) {
            viewHistory.push(currentView);
        }
        currentView = view;
        updateNavActive(view);
        renderView();
        // 内容区滚动回顶部
        var content=document.getElementById('contentArea');
        if(content) content.scrollTop=0;
        // 移动端自动关闭侧边栏（桌面端无副作用）
        if (window.innerWidth <= 768) closeSidebar();
    }
    /**
     * 登录后首次进入：重绘树形导航，移动端默认首页色块、桌面端默认住宿信息，清空历史栈。
     */
    function initView(){
        // 移动端初始关闭侧边栏
        if (window.innerWidth <= 768) {
            document.getElementById('sidebar').classList.remove('open');
        }
        renderTree();
        // 手机端默认进入色块功能首页，桌面端保持住宿信息
        switchView(window.innerWidth <= 768 ? 'home' : 'hierarchy');
        // 清空历史栈
        viewHistory = [];
    }
    /**
     * 按 currentView 分发到 ui.js 对应的 renderXxxView 渲染 contentArea。
     */
    function renderView(){
        var c=document.getElementById('contentArea');
        if(currentView==='home') renderHomeView(c);
        else if(currentView==='hierarchy') renderHierarchyView(c);
        else if(currentView==='add') renderAddView(c);
        else if(currentView==='stats') renderStatsView(c);
        else if(currentView==='inspection') renderInspectionView(c);
        else if(currentView==='students') renderStudentsView(c);
        else if(currentView==='items') renderItemsView(c);
        else if(currentView==='leavemanage') renderLeaveManageView(c);
        else if(currentView==='export') renderExportView(c);
    }

    // ==================== 返回与侧边栏 ====================
    function goBack(){
        if (viewHistory.length > 0) {
            var prevView = viewHistory.pop();
            currentView = prevView;
            updateNavActive(prevView);
            renderView();
        } else {
            toast('已经是顶层页面');
        }
    }
    function toggleSidebar(){
        var sidebar = document.getElementById('sidebar');
        var overlay = document.getElementById('sidebarOverlay');
        var willOpen = !sidebar.classList.contains('open');
        sidebar.classList.toggle('open', willOpen);
        if (overlay) overlay.classList.toggle('show', willOpen);
    }
    function closeSidebar(){
        var sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.remove('open');
        var overlay = document.getElementById('sidebarOverlay');
        if (overlay) overlay.classList.remove('show');
    }
    var lastMobileState = (window.innerWidth <= 768);
    window.addEventListener('resize', function(){
        var isMobile = window.innerWidth <= 768;
        if (isMobile !== lastMobileState) {
            lastMobileState = isMobile;
            if (isMobile) {
                closeSidebar();
            } else {
                closeSidebar();
                // 桌面端无色块首页，切回住宿信息
                if (currentView === 'home') currentView = 'hierarchy';
            }
            renderTree();
            updateNavActive(currentView);
            renderView();
        } else if (!isMobile) {
            closeSidebar();
        }
    });

    // ==================== 手机端住宿信息：芯片选择器 ====================
    // 选择楼层：宿舍条更新为该楼层宿舍并自动选中第一个，随后刷新数据区
    function hierarchyPickFloor(fid){
        selectedFloorId=fid;
        var dorms=getDormitoriesByFloor(fid);
        // 班级账号：仅在本班学生入住的宿舍中选择
        if(isClassAdmin()){
            var dormSet=getClassDormIds();
            dorms=dorms.filter(function(d){ return dormSet[d.id]; });
        }
        selectedDormitoryId=dorms.length?dorms[0].id:null;
        refreshHierarchyData();
    }
    // 选择宿舍：更新选中宿舍并刷新数据区
    function hierarchyPickDorm(id){
        selectedDormitoryId=id;
        refreshHierarchyData();
    }
    // 数据区刷新（本地数据同步渲染，无需加载状态）
    function refreshHierarchyData(){
        renderHierarchyView(document.getElementById('contentArea'));
        var c=document.getElementById('contentArea');
        if(c) c.scrollTop=0;
        // 宿舍横向条自动滚动到选中项
        var actChip=document.querySelector('.chip-dorms .chip.active');
        if(actChip&&actChip.scrollIntoView){try{actChip.scrollIntoView({inline:'center',block:'nearest'});}catch(e){}}
    }
    /**
     * 删除一条扣分记录（仅管理员，confirm 确认）：打 V3 墓碑标记、
     * saveDB 落库同步、重绘住宿信息视图。
     * @param {string|number} id - 扣分记录 ID
     */
    function deleteRecord(id){
        if(!isAdmin()){toast('无权限操作','error');return;}
        if(!confirm('确认删除？')) return;
        DB.deductionRecords=DB.deductionRecords.filter(function(r){return String(r.id)!==String(id);});
        // 登记删除墓碑：防止该记录在下次拉取时从云端回灌（saveDB 全量上传时云端同步剔除）
        if(DB.deletedRecordIds.indexOf(String(id))===-1) DB.deletedRecordIds.push(String(id));
        // V3 按行存储：标记删除
        v3MarkDeleted('deduction_record', id);
        saveDB();
        toast('已删除');
        renderView();
        renderTree();
    }

    // ==================== 学生迁出 / 调宿（仅管理员） ====================
    var transferStudentId = null;
    /**
     * 学生退宿：dormitoryId 置空（走读/退宿状态），保留历史记录可追溯，
     * 落库同步后刷新视图。
     * @param {number} studentId - 学生 ID
     */
    function moveOutStudent(studentId){
        if(!isAdmin()){toast('无权限操作','error');return;}
        var s = getStudentById(studentId);
        if(!s){toast('学生不存在','error');return;}
        var dorm = getDormitoryById(s.dormitoryId);
        var dormLabel = dorm ? dorm.roomNumber : '未分配';
        if(!confirm('确定将 '+s.name+' 迁出 '+dormLabel+' 吗？\n（迁出后该学生将保留在系统中，可在学生名单管理中重新分配宿舍）')) return;
        s.dormitoryId = null;
        s.bedNumber = '';
        // V3 按行存储：学生迁出修改，标记脏记录
        v3MarkDirty('student', studentId);
        saveDB();
        toast(s.name+' 已迁出');
        renderView();
        renderTree();
    }
    /**
     * 打开调寝弹层：选择目标宿舍/床号（排除该生自己占用的床位）。
     * @param {number} studentId - 要调寝的学生 ID
     */
    function openTransferModal(studentId){
        if(!isAdmin()){toast('无权限操作','error');return;}
        var s = getStudentById(studentId);
        if(!s){toast('学生不存在','error');return;}
        transferStudentId = studentId;
        var curDorm = getDormitoryById(s.dormitoryId);
        var curRoom = curDorm ? curDorm.roomNumber : '未分配';
        // 目标宿舍：所有生效宿舍号（排除当前宿舍）
        var allActiveDorms = (DB.dormitories||[]).filter(function(d){ return isDormitoryDeleted(d.roomNumber)===false; });
        allActiveDorms.sort(function(a,b){ return String(a.roomNumber).localeCompare(String(b.roomNumber),'zh-Hans-CN',{numeric:true}); });
        var dormOpts = allActiveDorms.map(function(d){
            var selected = (curDorm && d.id===curDorm.id) ? ' selected' : '';
            var fl = getFloorById(d.floorId);
            return '<option value="'+d.id+'"'+selected+'>'+d.roomNumber+'（'+(fl?fl.name:'未分配楼层')+'）</option>';
        }).join('');
        var bedOpts = '';
        // 初始床位选项：当前宿舍的床位（含当前学生自身床位）
        if(curDorm){
            bedOpts = buildBedOptions(curDorm.id, s.id);
        }
        var html = '<div class="em-header"><span>🔄 调换床位/宿舍</span><button class="em-close" aria-label="关闭" onclick="closeTransferModal()">✕</button></div>'
            + '<div class="em-body">'
            + '<div class="form-group"><label>当前信息</label><div style="padding:8px 12px;background:var(--gray-50);border-radius:6px;font-size:0.9286rem">姓名：<b>'+escapeHtmlAttr(s.name)+'</b>　班级：'+(s.className||'-')+'　当前宿舍：'+curRoom+'　当前床号：'+(s.bedNumber||'-')+'</div></div>'
            + '<div class="form-group"><label>目标宿舍号 *</label><select id="transferDormId" onchange="onTransferDormChange()">'+dormOpts+'</select></div>'
            + '<div class="form-group"><label>目标床号 *</label><select id="transferBed">'+bedOpts+'</select></div>'
            + '<div style="font-size:0.8571rem;color:#888">提示：已被占用的床位将显示占用者姓名且不可选择</div>'
            + '</div>'
            + '<div class="em-footer"><button class="btn btn-primary" onclick="saveTransfer()">💾 确认调宿</button><button class="btn btn-outline" onclick="closeTransferModal()">取消</button></div>';
        document.getElementById('transferModalBox').innerHTML = html;
        document.getElementById('transferModal').classList.add('show');
    }
    function closeTransferModal(){
        var m=document.getElementById('transferModal');
        if(m) m.classList.remove('show');
        transferStudentId = null;
    }
    // 生成目标宿舍的床位选项：已被占用的床位标注占用者并禁用
    function buildBedOptions(dormId, currentStudentId){
        var beds = ['1','2','3','4','5','6','7','8'];
        var occupants = {};
        getStudentsByDormitory(dormId).forEach(function(st){
            if(st.id !== currentStudentId && st.bedNumber) occupants[String(st.bedNumber)] = st.name;
        });
        return beds.map(function(b){
            if(occupants[b]){
                return '<option value="'+b+'" disabled>床位 '+b+'（已被 '+occupants[b]+' 占用）</option>';
            }
            return '<option value="'+b+'">床位 '+b+'</option>';
        }).join('');
    }
    function onTransferDormChange(){
        var dormId = parseInt(document.getElementById('transferDormId').value);
        var bedSelect = document.getElementById('transferBed');
        if(!bedSelect || !dormId) return;
        bedSelect.innerHTML = buildBedOptions(dormId, transferStudentId);
    }
    /**
     * 提交调寝：更新学生宿舍/床号（旧床位释放、新床位校验冲突），
     * 落库同步后关闭弹层并刷新视图。
     */
    function saveTransfer(){
        if(!isAdmin()){toast('无权限操作','error');return;}
        if(transferStudentId === null){toast('参数错误','error');return;}
        var s = getStudentById(transferStudentId);
        if(!s){toast('学生不存在','error');closeTransferModal();return;}
        var targetDormId = parseInt(document.getElementById('transferDormId').value);
        var targetBed = document.getElementById('transferBed').value;
        var targetDorm = getDormitoryById(targetDormId);
        if(!targetDormId || !targetDorm){toast('请选择目标宿舍','error');return;}
        if(!targetBed){toast('请选择目标床号','error');return;}
        // 校验：目标宿舍不能与当前相同
        if(s.dormitoryId === targetDormId){
            // 同宿舍仅换床位，允许；但若床位未变则提示
            if(String(s.bedNumber) === String(targetBed)){
                toast('目标宿舍与床位与当前相同','error');return;
            }
        }
        // 校验：目标床位未被占用
        var occupied = getStudentsByDormitory(targetDormId).find(function(st){
            return st.id !== s.id && String(st.bedNumber) === String(targetBed);
        });
        if(occupied){toast('该床位已被 '+occupied.name+' 占用，请选择其他床位','error');return;}
        s.dormitoryId = targetDormId;
        s.bedNumber = targetBed;
        // V3 按行存储：学生调宿修改，标记脏记录
        v3MarkDirty('student', transferStudentId);
        saveDB();
        toast(s.name+' 已调至 '+targetDorm.roomNumber+' 床位 '+targetBed);
        closeTransferModal();
        renderView();
        renderTree();
    }

    // ==================== 记录修改（仅生活老师 STAFF 可用） ====================
    var editRecordId=null;

    // 打开修改模态框：回填日期/备注，并按记录勾选卫生与纪律项目（含自定义项目）
    /**
     * 打开"修改扣分记录"弹层（仅生活老师 STAFF）：回显记录的扣分项勾选与分数/备注。
     * @param {string|number} id - 扣分记录 ID
     */
    function editRecord(id){
        if(!currentUser||currentUser.role!=='STAFF'){toast('无权限操作','error');return;}
        var r=null;
        for(var i=0;i<DB.deductionRecords.length;i++){if(String(DB.deductionRecords[i].id)===String(id)){r=DB.deductionRecords[i];break;}}
        if(!r){toast('记录不存在','error');return;}
        editRecordId=id;
        function buildChecks(items,recordIds,prefix,customLabel,customScoreText){
            var html=items.map(function(i){
                var checked=(recordIds||[]).indexOf(i.id)!==-1?' checked':'';
                return '<label><input type="checkbox" value="'+i.id+'" class="'+prefix+'-item"'+checked+' onchange="updateEditScores()"> '+i.name+' (-'+i.defaultScore+'分)</label>';
            }).join('');
            // 回填自定义项目：记录中以 'custom:名称' 存储，卫生0.2分/纪律1分
            var customName='';
            (recordIds||[]).forEach(function(v){ if(typeof v==='string'&&v.indexOf('custom:')===0) customName=v.substring(7); });
            html+='<label><input type="checkbox" value="custom" class="'+prefix+'-item"'+(customName?' checked':'')+' onchange="emCustomChange(\''+prefix+'\')"> ✏️ '+customLabel+'('+customScoreText+')</label>';
            html+='<span id="'+prefix+'CustomWrap" style="display:'+(customName?'inline-block':'none')+';margin-left:8px;"><input type="text" id="'+prefix+'CustomName" placeholder="自定义项目名称" value="'+escapeHtmlAttr(customName)+'" style="padding:4px 8px;border:1px dashed #ccc;border-radius:4px;"></span>';
            return html;
        }
        var hyChecks=buildChecks(DB.deductionItems.hygiene||[],r.hygieneItemIds,'em-hy','自定义','0.2分');
        var disChecks=buildChecks(DB.deductionItems.discipline||[],r.disciplineItemIds,'em-dis','自定义','1分');
        var html='<div class="em-header"><span>✏️ 修改扣分记录</span><button class="em-close" aria-label="关闭" onclick="closeEditModal()">✕</button></div>'
            +'<div class="em-body">'
            +'<div class="form-group"><label>扣分日期 *</label><input type="text" class="date-picker" id="emDate" value="'+escapeHtmlAttr(r.recordDate)+'"></div>'
            +'<div class="form-group"><label>备注</label><input type="text" id="emRemark" placeholder="可填写具体原因..." value="'+escapeHtmlAttr(r.remark)+'"></div>'
            +'<div class="form-group"><label>🧹 卫生加扣分（可多选）</label><div class="checkbox-group">'+hyChecks+'</div><div style="margin-top:5px">卫生扣分合计：<b id="emHyScore">0</b> 分</div></div>'
            +'<div class="form-group"><label>📏 纪律加扣分（可多选）</label><div class="checkbox-group">'+disChecks+'</div><div style="margin-top:5px">纪律扣分合计：<b id="emDisScore">0</b> 分</div></div>'
            +'</div>'
            +'<div class="em-footer"><button class="btn btn-primary" onclick="saveEditedRecord()">💾 保存修改</button><button class="btn btn-outline" onclick="closeEditModal()">取消</button></div>';
        document.getElementById('editModalBox').innerHTML=html;
        document.getElementById('editModal').classList.add('show');
        updateEditScores();
        initDatePickers(document); // 初始化修改日期选择器
    }
    // 自定义项目复选框联动：显示/隐藏名称输入框并重算合计
    function emCustomChange(prefix){
        var check=document.querySelector('.'+prefix+'-item[value="custom"]');
        var wrap=document.getElementById(prefix+'CustomWrap');
        var nameInput=document.getElementById(prefix+'CustomName');
        if(check&&wrap){
            wrap.style.display=check.checked?'inline-block':'none';
            if(!check.checked&&nameInput) nameInput.value='';
        }
        updateEditScores();
    }
    // 依据勾选项目实时重算合计（预设取 defaultScore，卫生自定义0.2/纪律自定义1）
    function updateEditScores(){
        function sum(prefix,customScore){
            var total=0;
            var checked=document.querySelectorAll('.'+prefix+'-item:checked');
            for(var i=0;i<checked.length;i++){
                if(checked[i].value==='custom') total+=customScore;
                else{var it=getItemById(parseInt(checked[i].value));if(it) total+=it.defaultScore;}
            }
            return total;
        }
        var hy=sum('em-hy',0.2), dis=sum('em-dis',1);
        var hyEl=document.getElementById('emHyScore'); if(hyEl) hyEl.textContent=hy;
        var disEl=document.getElementById('emDisScore'); if(disEl) disEl.textContent=dis;
        return {hy:hy,dis:dis};
    }
    /**
     * 保存修改后的扣分记录（入口）：经 safeAsync 统一捕获异常，失败可点击重试。
     */
    function saveEditedRecord(){
        // 经 safeAsync 统一捕获数据更新/保存异常，失败可点击重试
        safeAsync(saveEditedRecordImpl, '修改扣分记录', { retry: true });
    }
    /**
     * 保存修改实际逻辑（STAFF）：校验 → 重算卫生/纪律分与项目列表 →
     * 更新记录并标脏 → 持久化同步 → 关闭弹层、刷新视图。
     */
    function saveEditedRecordImpl(){
        if(editRecordId===null) return;
        if(!currentUser||currentUser.role!=='STAFF'){toast('无权限操作','error');return;}
        var r=null;
        for(var i=0;i<DB.deductionRecords.length;i++){if(String(DB.deductionRecords[i].id)===String(editRecordId)){r=DB.deductionRecords[i];break;}}
        if(!r){toast('记录不存在','error');closeEditModal();return;}
        var date=document.getElementById('emDate').value;
        if(!date){toast('请选择扣分日期','error');return;}
        function collectItems(prefix,customScore){
            var ids=[],score=0;
            var checked=document.querySelectorAll('.'+prefix+'-item:checked');
            for(var i=0;i<checked.length;i++){
                if(checked[i].value==='custom'){
                    var name=document.getElementById(prefix+'CustomName').value.trim();
                    if(!name){return null;}
                    ids.push('custom:'+name);
                    score+=customScore;
                }else{
                    var v=parseInt(checked[i].value);
                    ids.push(v);
                    var it=getItemById(v);
                    if(it) score+=it.defaultScore;
                }
            }
            return {ids:ids,score:score};
        }
        var hy=collectItems('em-hy',0.2);
        if(hy===null){toast('请输入自定义卫生项目名称','error');return;}
        var dis=collectItems('em-dis',1);
        if(dis===null){toast('请输入自定义纪律项目名称','error');return;}
        if(hy.ids.length===0&&dis.ids.length===0){toast('请至少勾选一个扣分项目','error');return;}
        r.recordDate=date;
        r.remark=document.getElementById('emRemark').value.trim();
        r.hygieneItemIds=hy.ids;
        r.hygieneScore=hy.score;
        r.disciplineItemIds=dis.ids;
        r.disciplineScore=dis.score;
        // 修改记录重传：登记脏记录并移出已同步集合，随 saveDB 的增量上传以本地版本覆盖云端
        var k=String(r.id);
        if(DB.dirtyRecordIds.indexOf(k)===-1) DB.dirtyRecordIds.push(k);
        var si=DB.syncedRecordIds.indexOf(k);
        if(si>-1) DB.syncedRecordIds.splice(si,1);
        r.lastModified=Date.now();
        // V3 按行存储：修改扣分记录 → 脏标记
        v3MarkDirty('deduction_record', r.id);
        saveDB();
        closeEditModal();
        toast('修改已保存');
        renderView();
        renderTree();
    }
    function closeEditModal(){
        var m=document.getElementById('editModal');
        if(m) m.classList.remove('show');
        editRecordId=null;
    }

    // ==================== 移动端扣分登记：芯片选择与状态保持 ====================
    // 重渲染前同步表单输入到状态（日期/备注/分值/已勾选项/自定义名称）
    function syncAddFormInputs(){
        var d=document.getElementById('addDate'); if(d&&d.value) addFormState.recordDate=d.value;
        var r=document.getElementById('addRemark'); if(r) addFormState.remark=r.value;
        var hs=document.getElementById('hyScore'); if(hs) addFormState.hygieneScore=parseFloat(hs.value)||0;
        var dsc=document.getElementById('disScore'); if(dsc) addFormState.disciplineScore=parseFloat(dsc.value)||0;
        var hbs=document.getElementById('hyBonusScore'); if(hbs) addFormState.hygieneBonusScore=parseFloat(hbs.value)||0;
        var dbsc=document.getElementById('disBonusScore'); if(dbsc) addFormState.disciplineBonusScore=parseFloat(dbsc.value)||0;
        addFormState.hygieneItemIds=Array.prototype.map.call(document.querySelectorAll('.hy-item-checkbox:checked'),function(c){return c.value;});
        addFormState.disciplineItemIds=Array.prototype.map.call(document.querySelectorAll('.dis-item-checkbox:checked'),function(c){return c.value;});
        addFormState.hygieneBonusItemIds=Array.prototype.map.call(document.querySelectorAll('.hy-bonus-checkbox:checked'),function(c){return c.value;});
        addFormState.disciplineBonusItemIds=Array.prototype.map.call(document.querySelectorAll('.dis-bonus-checkbox:checked'),function(c){return c.value;});
        var hn=document.getElementById('hyCustomName'); if(hn) addFormState.hyCustomName=hn.value;
        var dn=document.getElementById('disCustomName'); if(dn) addFormState.disCustomName=dn.value;
        var hbn=document.getElementById('hyBonusCustomName'); if(hbn) addFormState.hyBonusCustomName=hbn.value;
        var dbn=document.getElementById('disBonusCustomName'); if(dbn) addFormState.disBonusCustomName=dbn.value;
    }
    /** 切换加/扣分模式（重渲染表单，保留楼层/宿舍/日期选择） */
    function switchRecordMode(mode){
        syncAddFormInputs();
        addFormState.recordMode = mode;
        // 切模式时清空勾选项（两套项目不同）
        if(mode==='bonus'){
            addFormState.hygieneItemIds=[]; addFormState.disciplineItemIds=[];
            addFormState.studentId=null;
        }else{
            addFormState.hygieneBonusItemIds=[]; addFormState.disciplineBonusItemIds=[];
        }
        renderAddView(document.getElementById('contentArea'));
    }
    // 依据状态重新勾选扣分/加分项目（切层/切宿舍后恢复选择）
    function restoreAddChecks(){
        function restore(cls,arr){
            (arr||[]).forEach(function(v){
                var el=document.querySelector('.'+cls+'[value="'+v+'"]');
                if(el) el.checked=true;
            });
        }
        restore('hy-item-checkbox',addFormState.hygieneItemIds);
        restore('dis-item-checkbox',addFormState.disciplineItemIds);
        restore('hy-bonus-checkbox',addFormState.hygieneBonusItemIds);
        restore('dis-bonus-checkbox',addFormState.disciplineBonusItemIds);
    }
    // 依据当前勾选重算合计并同步自定义输入框显隐/回填
    function recomputeAddScores(){
        var isBonus = (addFormState.recordMode === 'bonus');
        var types = isBonus ? [['hy','hy-bonus','hyBonusScore','hygieneBonusScore','hyBonusCustomName','hyBonusCustomInputWrap','hy-bonus-custom-check','getBonusItemById']
                              ,['dis','dis-bonus','disBonusScore','disciplineBonusScore','disBonusCustomName','disBonusCustomInputWrap','dis-bonus-custom-check','getBonusItemById']]
                            : [['hy','hy-item','hyScore','hygieneScore','hyCustomName','hyCustomInputWrap','hy-custom-check','getItemById']
                              ,['dis','dis-item','disScore','disciplineScore','disCustomName','disCustomInputWrap','dis-custom-check','getItemById']];
        types.forEach(function(cfg){
            var t=cfg[0],cls=cfg[1],scoreId=cfg[2],stateKey=cfg[3],nameId=cfg[4],wrapId=cfg[5],customCls=cfg[6],getter=cfg[7];
            var total=0,any=false;
            var checked=document.querySelectorAll('.'+cls+'-checkbox:checked');
            for(var i=0;i<checked.length;i++){
                any=true;
                if(checked[i].value==='custom') total+=(t==='hy'?0.2:1);
                else{ var it=getter==='getItemById'?getItemById(parseInt(checked[i].value)):getBonusItemById(parseInt(checked[i].value)); if(it) total+=it.defaultScore; }
            }
            var input=document.getElementById(scoreId);
            if(input) input.value=any?total:0;
            addFormState[stateKey]=any?total:0;
            var cc=document.querySelector('.'+customCls);
            var wrap=document.getElementById(wrapId);
            if(cc&&wrap) wrap.style.display=cc.checked?'inline-block':'none';
            var nameInput=document.getElementById(nameId);
            if(nameInput){
                if(cc&&cc.checked) nameInput.value=(addFormState[stateKey.replace('Score','Name')]||addFormState[t==='hy'?(isBonus?'hyBonusCustomName':'hyCustomName'):(isBonus?'disBonusCustomName':'disCustomName')]||'');
                else{ nameInput.value=''; }
            }
        });
    }
    // 移动端：选择楼层 → 宿舍/对象重置并重渲染（已勾选项自动恢复）
    function mobilePickFloor(fid){
        syncAddFormInputs();
        addFormState.floorId=fid;
        addFormState.dormitoryId=null;
        addFormState.studentId=null;
        renderAddView(document.getElementById('contentArea'));
    }
    // 移动端：选择宿舍 → 对象重置为宿舍集体并重渲染（已勾选项自动恢复）
    function mobilePickDorm(id){
        syncAddFormInputs();
        addFormState.dormitoryId=id;
        addFormState.studentId=null;
        renderAddView(document.getElementById('contentArea'));
    }
    // 移动端：选择扣分对象 → 仅更新高亮与状态，不重渲染（保留已勾选项目）
    function mobilePickTarget(el,v){
        addFormState.studentId=v?parseInt(v):null;
        var chips=document.querySelectorAll('.chip-targets .chip');
        for(var i=0;i<chips.length;i++) chips[i].classList.remove('active');
        el.classList.add('active');
    }
    function bindCheckboxEventsGeneric(type){
        // type: 'hy' | 'dis' | 'hy-bonus' | 'dis-bonus'
        var isBonus = type.indexOf('bonus') !== -1;
        var base = type.replace('-bonus','');
        var cls = type + '-checkbox';
        var scoreId = isBonus ? (base==='hy'?'hyBonusScore':'disBonusScore') : (base==='hy'?'hyScore':'disScore');
        var stateKey = isBonus ? (base==='hy'?'hygieneBonusScore':'disciplineBonusScore') : (base==='hy'?'hygieneScore':'disciplineScore');
        var checks=document.querySelectorAll('.'+cls);
        for(var i=0;i<checks.length;i++){
            checks[i].addEventListener('change',function(){
                var total=0;
                var checked=document.querySelectorAll('.'+cls+':checked');
                for(var j=0;j<checked.length;j++){
                    if(checked[j].value==='custom') total+=(base==='hy'?0.2:1);
                    else {
                        var item = isBonus ? getBonusItemById(parseInt(checked[j].value)) : getItemById(parseInt(checked[j].value));
                        if(item) total+=item.defaultScore;
                    }
                }
                var el=document.getElementById(scoreId);
                if(el) el.value=total;
                addFormState[stateKey]=total;
            });
        }
    }
    function bindCustomCheckboxEventsGeneric(type){
        var isBonus = type.indexOf('bonus') !== -1;
        var base = type.replace('-bonus','');
        var customCls = type + '-custom-check';
        var wrapId = isBonus ? (base==='hy'?'hyBonusCustomInputWrap':'disBonusCustomInputWrap') : (base+'CustomInputWrap');
        var nameId = isBonus ? (base==='hy'?'hyBonusCustomName':'disBonusCustomName') : (base+'CustomName');
        var cc=document.querySelector('.'+customCls);
        if(cc){
            cc.addEventListener('change',function(){
                var wrap=document.getElementById(wrapId);
                if(wrap) wrap.style.display=this.checked?'inline-block':'none';
                if(!this.checked){
                    var ni=document.getElementById(nameId);
                    if(ni) ni.value='';
                }
            });
        }
    }
    function addFormChange(type){
        if(type==='floor'){addFormState.floorId=parseInt(document.getElementById('addFloor').value);addFormState.dormitoryId=null;renderAddView(document.getElementById('contentArea'));}
        else if(type==='dorm'){addFormState.dormitoryId=parseInt(document.getElementById('addDormitory').value);addFormState.studentId=null;renderAddView(document.getElementById('contentArea'));}
        else if(type==='student'){addFormState.studentId=document.getElementById('addStudent').value?parseInt(document.getElementById('addStudent').value):null;}
        else if(type==='date'){addFormState.recordDate=document.getElementById('addDate').value;}
        else if(type==='hygieneScore'){addFormState.hygieneScore=parseFloat(document.getElementById('hyScore').value)||0;}
        else if(type==='disciplineScore'){addFormState.disciplineScore=parseFloat(document.getElementById('disScore').value)||0;}
        else if(type==='hygieneBonusScore'){addFormState.hygieneBonusScore=parseFloat(document.getElementById('hyBonusScore').value)||0;}
        else if(type==='disciplineBonusScore'){addFormState.disciplineBonusScore=parseFloat(document.getElementById('disBonusScore').value)||0;}
        else if(type==='remark'){addFormState.remark=document.getElementById('addRemark').value;}
    }
    function resetAddForm(){
        addFormState={floorId:DB.floors[0].id,dormitoryId:null,studentId:null,hygieneItemIds:[],disciplineItemIds:[],hygieneScore:0,disciplineScore:0,recordDate:getTodayLocalStr(),remark:'',recordMode:'deduct',hygieneBonusItemIds:[],disciplineBonusItemIds:[],hygieneBonusScore:0,disciplineBonusScore:0};
        renderAddView(document.getElementById('contentArea'));
    }
    /**
     * 提交扣分登记（入口）：_busy 防双击重复提交，safeAsync 统一异常处理。
     */
    function submitDeduction(){
        if(submitDeduction._busy) return; // 防止移动端双击重复提交
        submitDeduction._busy=true;
        setTimeout(function(){submitDeduction._busy=false;},800);
        // 经 safeAsync 统一捕获数据写入/保存异常，失败可点击重试
        safeAsync(submitDeductionImpl, '登记扣分', { retry: true });
    }
    /**
     * 扣分登记实际逻辑：收集勾选的卫生/纪律项（含自定义项）与分数、按登记范围
     * （宿舍集体 / 指定学生）生成扣分记录（generateRecordId 全局唯一 ID），
     * 写入 DB.deductionRecords 并标脏，saveDB 落库同步后刷新视图。
     */
    function submitDeductionImpl(){
        if(!addFormState.dormitoryId){toast('请选择宿舍','error');return;}
        var isBonus = (addFormState.recordMode === 'bonus');
        var hygieneItemIds=[]; var disciplineItemIds=[];
        var hygieneScore=0; var disciplineScore=0;
        // 加分模式使用 bonus 系列元素 ID；扣分模式使用原有元素
        var hyCls = isBonus ? '.hy-bonus-checkbox:checked' : '.hy-item-checkbox:checked';
        var disCls = isBonus ? '.dis-bonus-checkbox:checked' : '.dis-item-checkbox:checked';
        var hyScoreEl = isBonus ? document.getElementById('hyBonusScore') : document.getElementById('hyScore');
        var disScoreEl = isBonus ? document.getElementById('disBonusScore') : document.getElementById('disScore');
        var hyCustomNameId = isBonus ? 'hyBonusCustomName' : 'hyCustomName';
        var disCustomNameId = isBonus ? 'disBonusCustomName' : 'disCustomName';
        if(hyScoreEl){
            var hyChecked=document.querySelectorAll(hyCls);
            for(var i=0;i<hyChecked.length;i++){
                if(hyChecked[i].value==='custom'){
                    var customName=document.getElementById(hyCustomNameId).value.trim();
                    if(!customName){toast('请输入自定义卫生项目名称','error');return;}
                    hygieneItemIds.push('custom:'+customName);
                } else hygieneItemIds.push(parseInt(hyChecked[i].value));
            }
            hygieneScore=parseFloat(hyScoreEl.value)||0;
        }
        if(disScoreEl){
            var disChecked=document.querySelectorAll(disCls);
            for(var i=0;i<disChecked.length;i++){
                if(disChecked[i].value==='custom'){
                    var customName=document.getElementById(disCustomNameId).value.trim();
                    if(!customName){toast('请输入自定义纪律项目名称','error');return;}
                    disciplineItemIds.push('custom:'+customName);
                } else disciplineItemIds.push(parseInt(disChecked[i].value));
            }
            disciplineScore=parseFloat(disScoreEl.value)||0;
        }
        if(hygieneItemIds.length===0 && disciplineItemIds.length===0){toast('请至少选择一个项目','error');return;}
        var mode = isBonus ? 'bonus' : 'deduct';
        // 加分模式：生成宿舍集体记录 + 每个学生各一条个人记录
        if(isBonus){
            // 宿舍层面记录（studentId=null，recordMode='bonus'，记录生活老师实际输入分数）
            var dormRecord={id:generateRecordId(),createdAt:Date.now(),dormitoryId:addFormState.dormitoryId,studentId:null,hygieneItemIds:hygieneItemIds,hygieneScore:hygieneScore,disciplineItemIds:disciplineItemIds,disciplineScore:disciplineScore,recordDate:addFormState.recordDate,remark:addFormState.remark||'',recordMode:mode};
            DB.deductionRecords.push(dormRecord);
            v3MarkDirty('deduction_record', dormRecord.id);
            // 个人层面：为该宿舍每个学生各生成一条个人加分记录
            // 卫生加分：每个学生个人 +1 分；纪律加分：每个学生个人 +1 分
            var dormStudents = getStudentsByDormitory(addFormState.dormitoryId);
            dormStudents.forEach(function(s){
                var perHyScore = hygieneScore > 0 ? 1 : 0;
                var perDisScore = disciplineScore > 0 ? 1 : 0;
                var stuRecord={id:generateRecordId(),createdAt:Date.now(),dormitoryId:addFormState.dormitoryId,studentId:s.id,hygieneItemIds:hygieneItemIds,hygieneScore:perHyScore,disciplineItemIds:disciplineItemIds,disciplineScore:perDisScore,recordDate:addFormState.recordDate,remark:addFormState.remark||'',recordMode:mode};
                DB.deductionRecords.push(stuRecord);
                v3MarkDirty('deduction_record', stuRecord.id);
            });
            saveDB();
            toast('加分成功！'+dormStudents.length+'名学生各获加分');
        }else{
            // 扣分模式：原有逻辑
            var newRecord={id:generateRecordId(),createdAt:Date.now(),dormitoryId:addFormState.dormitoryId,studentId:addFormState.studentId||null,hygieneItemIds:hygieneItemIds,hygieneScore:hygieneScore,disciplineItemIds:disciplineItemIds,disciplineScore:disciplineScore,recordDate:addFormState.recordDate,remark:addFormState.remark||'',recordMode:'deduct'};
            DB.deductionRecords.push(newRecord);
            v3MarkDirty('deduction_record', newRecord.id);
            saveDB();
            toast('登记成功！');
        }
        addFormState.studentId=null;
        addFormState.hygieneItemIds=[]; addFormState.disciplineItemIds=[];
        addFormState.hygieneBonusItemIds=[]; addFormState.disciplineBonusItemIds=[];
        addFormState.remark='';
        renderAddView(document.getElementById('contentArea'));
        renderTree();
    }

    // 学生名单检索：班级变化时更新姓名 datalist（不清空已输入的姓名）
    function onSearchStuClassChange(className){
        studentSearch.className = className;
        var namePool = className ? DB.students.filter(function(s){ return s.className===className; }) : DB.students;
        var nameSet={}; namePool.forEach(function(s){ if(s.name) nameSet[s.name]=true; });
        var dl=document.getElementById('dlSearchStuName');
        if(dl) dl.innerHTML = Object.keys(nameSet).map(function(n){ return '<option value="'+n+'"></option>'; }).join('');
    }
    // 检索按钮：按班级+姓名+住宿状态过滤学生列表
    /**
     * 学生名单检索：收集班级/姓名/住宿状态条件写入 studentSearch 并重绘名单视图。
     */
    function searchStudents(){
        var clsEl=document.getElementById('searchStuClass');
        var nameEl=document.getElementById('searchStuName');
        var resEl=document.getElementById('searchStuResidence');
        studentSearch.className = clsEl ? clsEl.value : '';
        studentSearch.name = nameEl ? nameEl.value.trim() : '';
        studentSearch.residence = resEl ? resEl.value : '';
        renderStudentsView(document.getElementById('contentArea'));
        if(studentSearch.className || studentSearch.name || studentSearch.residence){
            toast('检索完成');
        }
    }
    // 重置检索：清空条件并显示全部学生
    function resetStudentSearch(){
        studentSearch.className='';
        studentSearch.name='';
        studentSearch.residence='';
        renderStudentsView(document.getElementById('contentArea'));
    }
    /**
     * 全选/取消全选学生名单（表头 checkbox）：设置所有 .student-checkbox 状态。
     * @param {boolean} checked - true=全部勾选；false=全部取消
     */
    function toggleAllStudents(checked){ var checkboxes=document.querySelectorAll('.student-checkbox'); for(var i=0;i<checkboxes.length;i++) checkboxes[i].checked=checked; updateSelectedCount(); }
    /**
     * 根据当前勾选数同步全选框状态（全勾则勾选全选框）。
     * 学生表 tbody 的 change 事件委托与分片渲染完成回调都会调用本函数。
     */
    function updateSelectedCount(){ var checked=document.querySelectorAll('.student-checkbox:checked'); var selectAll=document.getElementById('selectAllStudents'); if(selectAll){var total=document.querySelectorAll('.student-checkbox').length; selectAll.checked=total>0&&checked.length===total;} }
    function deleteSelectedStudents(){
        if(!isAdmin()){toast('无权限','error');return;}
        var checkedBoxes=document.querySelectorAll('.student-checkbox:checked');
        if(checkedBoxes.length===0){toast('请先选择要删除的学生','error');return;}
        if(!confirm('确认删除选中的 '+checkedBoxes.length+' 名学生？此操作不可撤销！')) return;
        var idsToDelete=[];
        for(var i=0;i<checkedBoxes.length;i++) idsToDelete.push(parseInt(checkedBoxes[i].getAttribute('data-student-id')));
        DB.students=DB.students.filter(function(s){return idsToDelete.indexOf(s.id)===-1;});
        saveDB();
        toast('成功删除 '+idsToDelete.length+' 名学生');
        renderStudentsView(document.getElementById('contentArea'));
    }
    /**
     * 新增学生（管理员）：校验同名同宿舍冲突、分配 nextIds.student 与床位，
     * 写入 DB.students 并标脏，saveDB 后刷新名单/树。
     */
    function addStudent(){
        if(!isAdmin()){toast('无权限','error');return;}
        var name=document.getElementById('newStuName').value.trim();
        var className=document.getElementById('newStuClass').value.trim();
        var dormitoryId=parseInt(document.getElementById('newStuDorm').value);
        var bedNumber=document.getElementById('newStuBed').value.trim();
        if(!name||!className||!dormitoryId){toast('请填写完整信息','error');return;}
        if(studentAlreadyExists(name, className, dormitoryId, bedNumber)){
            toast('该学生已存在（同名+同班+同宿舍+同床号），未重复添加','error');
            return;
        }
        var newStuId = DB.nextIds.student++;
        DB.students.push({id:newStuId,dormitoryId:dormitoryId,name:name,className:className,bedNumber:bedNumber});
        // V3 按行存储：新学生标记脏记录
        v3MarkDirty('student', newStuId);
        saveDB();
        toast('学生已添加');
        renderStudentsView(document.getElementById('contentArea'));
    }
    // 学生去重判断：同名+同班+同宿舍(或同为走读)+同床号视为已存在，重复导入时跳过，防止名单越导越多
    function studentAlreadyExists(name, className, dormitoryId, bedNumber){
        return (DB.students||[]).some(function(s){
            if(s.name!==name || s.className!==className) return false;
            var bothNon = (s.dormitoryId==null && dormitoryId==null);
            var sameDorm = bothNon || (s.dormitoryId!=null && dormitoryId!=null && s.dormitoryId===dormitoryId);
            if(!sameDorm) return false;
            return (s.bedNumber||'') === (bedNumber||'');
        });
    }
    // 确保宿舍号存在（导入学生名单时自动补建）：返回 {dorm, autoAdded}，无效返回 null
    function ensureDormitoryRoom(roomNumber){
        roomNumber = String(roomNumber).trim();
        if(!/^[1-8][0-9]{2}$/.test(roomNumber)) return null;
        var existing = getDormitoryByRoomNumber(roomNumber);
        if(existing){
            // 已在 dormitories 中：若不在 dormitoryList（曾被删除），重新激活
            if(DB.dormitoryList.indexOf(roomNumber) === -1){
                DB.dormitoryList.push(roomNumber);
                // V3 按行存储：dormitoryList 变化 → meta 脏
                v3MarkDirty('meta', 'main');
                return { dorm:existing, autoAdded:true };
            }
            return { dorm:existing, autoAdded:false };
        }
        // 全新宿舍号：创建 dormitories 条目并加入 dormitoryList
        var floorNum = parseInt(roomNumber.charAt(0));
        var floor = DB.floors.find(function(f){ return f.sortOrder === floorNum; });
        if(!floor) return null;
        var newDorm = { id:DB.nextIds.dormitory++, floorId:floor.id, roomNumber:roomNumber, capacity:8 };
        DB.dormitories.push(newDorm);
        DB.dormitoryList.push(roomNumber);
        // V3 按行存储：新宿舍 + dormitoryList 变化 → 脏标记
        v3MarkDirty('dormitory', newDorm.id);
        v3MarkDirty('meta', 'main');
        return { dorm:newDorm, autoAdded:true };
    }
    function batchImportStudents(){
        // 经 safeAsync 统一捕获解析/写入异常，失败可点击重试
        safeAsync(batchImportStudentsImpl, '导入学生（粘贴）', { retry: true });
    }
    function batchImportStudentsImpl(){
        if(!isAdmin()){toast('无权限','error');return;}
        var text=document.getElementById('batchImportText').value.trim();
        if(!text){toast('请粘贴学生数据','error');return;}
        var lines=text.split('\n');
        var imported=0;
        var skipped=0;
        var autoAdded=0;
        var nonResident=0;
        for(var i=0;i<lines.length;i++){
            var line=lines[i].trim();
            if(!line) continue;
            var parts=line.split(/[,，\t]/);
            if(parts.length<3) continue;
            var name=parts[0].trim();
            var className=parts[1].trim();
            var roomNumber=parts[2].trim();
            var bedNumber=parts.length>3?parts[3].trim():'';
            // 非住宿生：宿舍号为 0 或空时，dormitoryId=null，标记为走读生
            if(roomNumber===''||roomNumber==='0'||roomNumber.toLowerCase()==='null'){
                if(studentAlreadyExists(name, className, null, '')){ skipped++; continue; }
                var nonStuId = DB.nextIds.student++;
                DB.students.push({id:nonStuId,dormitoryId:null,name:name,className:className,bedNumber:''});
                v3MarkDirty('student', nonStuId);
                imported++; nonResident++;
                continue;
            }
            // 去重：宿舍已存在且同名同班同床 → 跳过（避免重复导入翻倍；不为重复学生新建宿舍）
            var existDorm = getDormitoryByRoomNumber(roomNumber);
            if(existDorm && studentAlreadyExists(name, className, existDorm.id, bedNumber)){ skipped++; continue; }
            var res=ensureDormitoryRoom(roomNumber);
            if(!res){toast('宿舍号无效或不存在：'+roomNumber,'error');continue;}
            if(res.autoAdded) autoAdded++;
            var impStuId = DB.nextIds.student++;
            DB.students.push({id:impStuId,dormitoryId:res.dorm.id,name:name,className:className,bedNumber:bedNumber});
            v3MarkDirty('student', impStuId);
            imported++;
        }
        saveDB();
        toast('成功导入'+imported+'名学生'+(skipped>0?'（跳过重复'+skipped+'名）':'')+(autoAdded>0?'（自动新增'+autoAdded+'个宿舍号）':'')+(nonResident>0?'（含'+nonResident+'名走读生）':''));
        renderStudentsView(document.getElementById('contentArea'));
    }
    /**
     * Excel 导入入口（文件选择后）：safeAsync 包装，失败可重试。
     * @param {File} file - 用户选择的 .xlsx 文件
     */
    function handleExcelImport(file){
        if(!file) return;
        // 经 safeAsync 统一捕获文件读取/解析/写入异常，失败可点击重试（重试会重新读取同一文件）
        safeAsync(function(){ return handleExcelImportImpl(file); }, '导入学生（Excel）', { retry: true });
    }
    /**
     * Excel 导入实际逻辑（XLSX 解析）：按行读取 班级/姓名/宿舍号/床号，
     * 跳过重复学生，缺失的宿舍号自动新增（ensureDormitoryRoom），支持走读生，
     * 批量写入并标脏后 saveDB。
     * @param {File} file - .xlsx 文件
     */
    function handleExcelImportImpl(file){
        if(!isAdmin()){toast('无权限','error');return;}
        var reader=new FileReader();
        // 文件读取失败（权限/损坏/被占用等）：统一错误处理
        reader.onerror=function(){ handleError(reader.error || new Error('文件读取失败'), '导入学生（Excel）'); };
        reader.onload=function(e){
            try{
                var data=new Uint8Array(e.target.result);
                var workbook=XLSX.read(data,{type:'array'});
                var firstSheet=workbook.Sheets[workbook.SheetNames[0]];
                var rows=XLSX.utils.sheet_to_json(firstSheet,{header:1});
                var validRows=rows.filter(function(row){return row.length>=2&&row[0]&&row[1];});
                var imported=0;
                var skipped=0;
                var autoAdded=0;
                var nonResident=0;
                validRows.forEach(function(row){
                    var name=String(row[0]).trim();
                    var className=String(row[1]).trim();
                    var roomNumber=row.length>2?String(row[2]).trim():'';
                    var bedNumber=row.length>3?String(row[3]).trim():'';
                    // 非住宿生：宿舍号为 0 或空时，dormitoryId=null
                    if(roomNumber===''||roomNumber==='0'||roomNumber.toLowerCase()==='null'){
                        if(studentAlreadyExists(name, className, null, '')){ skipped++; return; }
                        var exNonStu = DB.nextIds.student++;
                        DB.students.push({id:exNonStu,dormitoryId:null,name:name,className:className,bedNumber:''});
                        v3MarkDirty('student', exNonStu);
                        imported++; nonResident++;
                        return;
                    }
                    // 去重：宿舍已存在且同名同班同床 → 跳过（避免重复导入翻倍）
                    var exDorm = getDormitoryByRoomNumber(roomNumber);
                    if(exDorm && studentAlreadyExists(name, className, exDorm.id, bedNumber)){ skipped++; return; }
                    var res=ensureDormitoryRoom(roomNumber);
                    if(!res){toast('宿舍号无效或不存在：'+roomNumber,'error');return;}
                    if(res.autoAdded) autoAdded++;
                    var exStuId = DB.nextIds.student++;
                    DB.students.push({id:exStuId,dormitoryId:res.dorm.id,name:name,className:className,bedNumber:bedNumber});
                    v3MarkDirty('student', exStuId);
                    imported++;
                });
                saveDB();
                toast('成功从Excel导入'+imported+'名学生'+(skipped>0?'（跳过重复'+skipped+'名）':'')+(autoAdded>0?'（自动新增'+autoAdded+'个宿舍号）':'')+(nonResident>0?'（含'+nonResident+'名走读生）':''));
                renderStudentsView(document.getElementById('contentArea'));
            }catch(err){
                // 解析失败：静默记录到错误日志，保留原有的具体提示文案
                handleError(err, '导入学生（Excel解析）', { silent: true });
                toast('Excel解析失败，请检查文件格式','error');
            }
        };
        reader.readAsArrayBuffer(file);
    }
    /**
     * 删除单个学生（管理员，confirm 确认）：打 V3 墓碑、落库同步并刷新名单。
     * @param {number} id - 学生 ID
     */
    function deleteStudent(id){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确认删除该学生？')) return;
        DB.students=DB.students.filter(function(s){return s.id!==id;});
        // V3 按行存储：标记删除
        v3MarkDeleted('student', id);
        saveDB();
        toast('已删除');
        renderStudentsView(document.getElementById('contentArea'));
    }


    // ==================== 宿舍号管理（仅管理员） ====================
    // 按楼层分组返回生效宿舍号及其入住人数
    function getDormitoryListByFloor(){
        ensureSyncMeta();
        var result = [];
        DB.floors.forEach(function(f){
            var dorms = getDormitoriesByFloor(f.id);
            if(dorms.length === 0) return;
            dorms.sort(function(a,b){ return String(a.roomNumber).localeCompare(String(b.roomNumber),'zh-Hans-CN',{numeric:true}); });
            var items = dorms.map(function(d){
                var count = getStudentsByDormitory(d.id).length;
                return { id:d.id, roomNumber:d.roomNumber, count:count };
            });
            result.push({ floorId:f.id, floorName:f.name, items:items });
        });
        return result;
    }
    function openDormitoryManageModal(){
        if(!isAdmin()){toast('无权限','error');return;}
        renderDormitoryManage();
        document.getElementById('dormitoryManageModal').classList.add('show');
    }
    function closeDormitoryManageModal(){
        var m=document.getElementById('dormitoryManageModal');
        if(m) m.classList.remove('show');
    }

    /**
     * 新增宿舍号（管理员）：校验格式（1-8 层三位号）与重复，创建 dormitory 记录
     * 并加入 dormitoryList 权威名单，标脏落库后刷新管理弹层与树。
     */
    function addDormitory(){
        if(!isAdmin()){toast('无权限','error');return;}
        var input = document.getElementById('newDormRoom');
        var val = input ? input.value.trim() : '';
        if(!val){toast('请输入宿舍号','error');return;}
        // 校验：三位数字，百位1-8
        if(!/^[1-8][0-9]{2}$/.test(val)){
            toast('宿舍号必须为三位数字，且首位为1-8','error');
            return;
        }
        // 不允许重复
        if(DB.dormitoryList.indexOf(val) !== -1){
            toast('宿舍号 '+val+' 已存在','error');
            return;
        }
        var floorNum = parseInt(val.charAt(0));
        var floor = DB.floors.find(function(f){ return f.sortOrder === floorNum; });
        if(!floor){ toast('无法识别楼层','error'); return; }
        // 在 dormitories 中查找是否已存在该房间（历史软删除场景）
        var existingDorm = getDormitoryByRoomNumber(val);
        if(existingDorm){
            // 已存在于 dormitories 但不在 dormitoryList（曾被删除），重新激活
            if(DB.dormitoryList.indexOf(val) === -1) DB.dormitoryList.push(val);
            // V3 按行存储：重新激活 + meta 脏
            v3MarkDirty('meta', 'main');
        } else {
            // 全新宿舍号
            var newId = DB.nextIds.dormitory++;
            DB.dormitories.push({ id:newId, floorId:floor.id, roomNumber:val, capacity:8 });
            DB.dormitoryList.push(val);
            // V3 按行存储：新宿舍 + meta 脏
            v3MarkDirty('dormitory', newId);
            v3MarkDirty('meta', 'main');
        }
        saveDB();
        toast('宿舍号 '+val+' 已添加');
        input.value = '';
        renderDormitoryManage();
        renderTree();
    }
    /**
     * 删除宿舍号（管理员）：从 dormitoryList 权威名单移除（dormitory 记录保留以
     * 追溯历史），有在住学生时拒绝删除；落库同步后刷新。
     * @param {string} roomNumber - 宿舍号（如 '305'）
     */
    function deleteDormitory(roomNumber){
        if(!isAdmin()){toast('无权限','error');return;}
        roomNumber = String(roomNumber);
        var dorm = getDormitoryByRoomNumber(roomNumber);
        if(!dorm){ toast('宿舍号不存在','error'); return; }
        var residents = getStudentsByDormitory(dorm.id);
        if(residents.length > 0){
            var names = residents.map(function(s){ return s.name+'('+(s.className||'')+')'; }).join('、');
            alert('该宿舍尚有 '+residents.length+' 名学生入住，请先迁出或调宿后再删除。\n入住学生：'+names);
            return;
        }
        if(!confirm('确定删除宿舍 ['+roomNumber+'] 吗？\n（历史扣分/退宿记录将保留，但该宿舍号不再出现在选择列表中）')) return;
        // 仅从 dormitoryList 移除（控制可见性），保留 dormitories 条目以供历史记录引用
        DB.dormitoryList = DB.dormitoryList.filter(function(r){ return r !== roomNumber; });
        // V3 按行存储：dormitoryList 变化 → meta 脏
        v3MarkDirty('meta', 'main');
        saveDB();
        toast('宿舍号 '+roomNumber+' 已删除');
        // 若当前选中的是被删宿舍，清空选择
        if(selectedDormitoryId === dorm.id){ selectedDormitoryId = null; selectedFloorId = null; }
        renderDormitoryManage();
        renderTree();
        renderView();
    }

    function addHygieneItem(){
        if(!isAdmin()){toast('无权限','error');return;}
        var name=document.getElementById('newHyItemName').value.trim();
        var score=parseFloat(document.getElementById('newHyItemScore').value);
        if(!name||!score||score<=0){toast('请输入有效信息','error');return;}
        if(!DB.deductionItems.hygiene) DB.deductionItems.hygiene=[];
        var newItemId = DB.nextIds.item++;
        DB.deductionItems.hygiene.push({id:newItemId,name:name,defaultScore:score});
        v3MarkDirty('deduction_item', newItemId);
        saveDB(); toast('✅ 卫生项目添加成功！'); renderItemsView(document.getElementById('contentArea'));
    }
    function deleteHygieneItem(id){ if(!isAdmin()){toast('无权限','error');return;} if(!confirm('确认删除？'))return; DB.deductionItems.hygiene=DB.deductionItems.hygiene.filter(function(i){return i.id!==id;}); v3MarkDeleted('deduction_item', id); saveDB(); toast('已删除'); renderItemsView(document.getElementById('contentArea')); }
    function addDisciplineItem(){
        if(!isAdmin()){toast('无权限','error');return;}
        var name=document.getElementById('newDisItemName').value.trim();
        var score=parseFloat(document.getElementById('newDisItemScore').value);
        if(!name||!score||score<=0){toast('请输入有效信息','error');return;}
        if(!DB.deductionItems.discipline) DB.deductionItems.discipline=[];
        var newItemId2 = DB.nextIds.item++;
        DB.deductionItems.discipline.push({id:newItemId2,name:name,defaultScore:score});
        v3MarkDirty('deduction_item', newItemId2);
        saveDB(); toast('✅ 纪律项目添加成功！'); renderItemsView(document.getElementById('contentArea'));
    }
    function deleteDisciplineItem(id){ if(!isAdmin()){toast('无权限','error');return;} if(!confirm('确认删除？'))return; DB.deductionItems.discipline=DB.deductionItems.discipline.filter(function(i){return i.id!==id;}); v3MarkDeleted('deduction_item', id); saveDB(); toast('已删除'); renderItemsView(document.getElementById('contentArea')); }
    function batchImportHygieneItems(){
        if(!isAdmin()){toast('无权限','error');return;}
        var text=document.getElementById('hyBatchImport').value.trim();
        if(!text){toast('请输入数据','error');return;}
        var lines=text.split('\n'); var imported=0;
        for(var i=0;i<lines.length;i++){
            var line=lines[i].trim(); if(!line) continue;
            var parts=line.split(/[,，\t]/); if(parts.length<2) continue;
            var name=parts[0].trim(); var score=parseFloat(parts[1]);
            if(!name||isNaN(score)||score<=0) continue;
            if(!DB.deductionItems.hygiene) DB.deductionItems.hygiene=[];
            var impItemId = DB.nextIds.item++;
            DB.deductionItems.hygiene.push({id:impItemId,name:name,defaultScore:score});
            v3MarkDirty('deduction_item', impItemId);
            imported++;
        }
        saveDB(); toast('成功导入'+imported+'个卫生项目'); renderItemsView(document.getElementById('contentArea'));
    }
    function batchImportDisciplineItems(){
        if(!isAdmin()){toast('无权限','error');return;}
        var text=document.getElementById('disBatchImport').value.trim();
        if(!text){toast('请输入数据','error');return;}
        var lines=text.split('\n'); var imported=0;
        for(var i=0;i<lines.length;i++){
            var line=lines[i].trim(); if(!line) continue;
            var parts=line.split(/[,，\t]/); if(parts.length<2) continue;
            var name=parts[0].trim(); var score=parseFloat(parts[1]);
            if(!name||isNaN(score)||score<=0) continue;
            if(!DB.deductionItems.discipline) DB.deductionItems.discipline=[];
            var impItemId2 = DB.nextIds.item++;
            DB.deductionItems.discipline.push({id:impItemId2,name:name,defaultScore:score});
            v3MarkDirty('deduction_item', impItemId2);
            imported++;
        }
        saveDB(); toast('成功导入'+imported+'个纪律项目'); renderItemsView(document.getElementById('contentArea'));
    }
    // ===== 加分项目管理（与扣分项逻辑一致，_subType 区分） =====
    function addHygieneBonusItem(){
        if(!isAdmin()){toast('无权限','error');return;}
        var name=document.getElementById('newHyBonusItemName').value.trim();
        var score=parseFloat(document.getElementById('newHyBonusItemScore').value);
        if(!name||!score||score<=0){toast('请输入有效信息','error');return;}
        if(!DB.deductionItems.hygieneBonus) DB.deductionItems.hygieneBonus=[];
        var id = DB.nextIds.item++;
        DB.deductionItems.hygieneBonus.push({id:id,name:name,defaultScore:score});
        v3MarkDirty('deduction_item', id);
        saveDB(); toast('✅ 卫生加分项目添加成功！'); renderItemsView(document.getElementById('contentArea'));
    }
    function deleteHygieneBonusItem(id){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确认删除？'))return;
        DB.deductionItems.hygieneBonus=DB.deductionItems.hygieneBonus.filter(function(i){return i.id!==id;});
        v3MarkDeleted('deduction_item', id);
        saveDB(); toast('已删除'); renderItemsView(document.getElementById('contentArea'));
    }
    function batchImportHygieneBonusItems(){
        if(!isAdmin()){toast('无权限','error');return;}
        var text=document.getElementById('hyBonusBatchImport').value.trim();
        if(!text){toast('请输入数据','error');return;}
        var lines=text.split('\n'); var imported=0;
        for(var i=0;i<lines.length;i++){
            var line=lines[i].trim(); if(!line) continue;
            var parts=line.split(/[,，\t]/); if(parts.length<2) continue;
            var name=parts[0].trim(); var score=parseFloat(parts[1]);
            if(!name||isNaN(score)||score<=0) continue;
            if(!DB.deductionItems.hygieneBonus) DB.deductionItems.hygieneBonus=[];
            var id = DB.nextIds.item++;
            DB.deductionItems.hygieneBonus.push({id:id,name:name,defaultScore:score});
            v3MarkDirty('deduction_item', id);
            imported++;
        }
        saveDB(); toast('成功导入'+imported+'个卫生加分项目'); renderItemsView(document.getElementById('contentArea'));
    }
    function addDisciplineBonusItem(){
        if(!isAdmin()){toast('无权限','error');return;}
        var name=document.getElementById('newDisBonusItemName').value.trim();
        var score=parseFloat(document.getElementById('newDisBonusItemScore').value);
        if(!name||!score||score<=0){toast('请输入有效信息','error');return;}
        if(!DB.deductionItems.disciplineBonus) DB.deductionItems.disciplineBonus=[];
        var id = DB.nextIds.item++;
        DB.deductionItems.disciplineBonus.push({id:id,name:name,defaultScore:score});
        v3MarkDirty('deduction_item', id);
        saveDB(); toast('✅ 纪律加分项目添加成功！'); renderItemsView(document.getElementById('contentArea'));
    }
    function deleteDisciplineBonusItem(id){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确认删除？'))return;
        DB.deductionItems.disciplineBonus=DB.deductionItems.disciplineBonus.filter(function(i){return i.id!==id;});
        v3MarkDeleted('deduction_item', id);
        saveDB(); toast('已删除'); renderItemsView(document.getElementById('contentArea'));
    }
    function batchImportDisciplineBonusItems(){
        if(!isAdmin()){toast('无权限','error');return;}
        var text=document.getElementById('disBonusBatchImport').value.trim();
        if(!text){toast('请输入数据','error');return;}
        var lines=text.split('\n'); var imported=0;
        for(var i=0;i<lines.length;i++){
            var line=lines[i].trim(); if(!line) continue;
            var parts=line.split(/[,，\t]/); if(parts.length<2) continue;
            var name=parts[0].trim(); var score=parseFloat(parts[1]);
            if(!name||isNaN(score)||score<=0) continue;
            if(!DB.deductionItems.disciplineBonus) DB.deductionItems.disciplineBonus=[];
            var id = DB.nextIds.item++;
            DB.deductionItems.disciplineBonus.push({id:id,name:name,defaultScore:score});
            v3MarkDirty('deduction_item', id);
            imported++;
        }
        saveDB(); toast('成功导入'+imported+'个纪律加分项目'); renderItemsView(document.getElementById('contentArea'));
    }

    // ==================== 数据管理视图 (已移除) ====================
    // 已删除 renderDataManageView 及相关菜单

    // ==================== 删除全部记录函数 ====================
    /**
     * 清空全部扣分记录（管理员，双重 confirm）：逐条登记 V3 墓碑后清空数组，
     * 保证云端与其它设备也同步删除（防止旧记录回灌），落库后刷新视图。
     */
    function deleteAllRecords(){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确定要删除全部扣分记录吗？此操作不可恢复！')) return;
        // 登记所有被删记录的墓碑，确保 syncToCloud 合并时将其从云端剔除，
        // 防止旧记录回灌到其他设备
        ensureSyncMeta();
        DB.deductionRecords.forEach(function(r){
            var k=String(r.id);
            if(DB.deletedRecordIds.indexOf(k)===-1) DB.deletedRecordIds.push(k);
            // V3 按行存储：标记删除
            v3MarkDeleted('deduction_record', k);
        });
        DB.deductionRecords=[];
        // 清空同步状态：所有记录已删除，无需保留已同步/脏标记
        DB.syncedRecordIds=[];
        DB.dirtyRecordIds=[];
        saveDB();
        toast('已删除全部扣分记录');
        renderView();
        renderTree();
    }
    // 删除全部请假记录
    function deleteAllAbsenceRecords(){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确定要删除全部请假记录吗？此操作不可恢复！')) return;
        // V3 按行存储：先标记所有待删记录
        (DB.absenceRecords||[]).forEach(function(r){ if(r && r.id!=null) v3MarkDeleted('absence_record', r.id); });
        DB.absenceRecords=[];
        saveDB();
        toast('已删除全部请假记录');
        renderView();
    }
    // 删除全部停宿记录（leaveRecords 中 type==='stop'）
    function deleteAllStopRecords(){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确定要删除全部停宿记录吗？此操作不可恢复！')) return;
        // V3 按行存储：先标记所有待删停宿记录
        (DB.leaveRecords||[]).forEach(function(r){ if(r && r.type==='stop' && r.id!=null) v3MarkDeleted('leave_record', r.id); });
        DB.leaveRecords=(DB.leaveRecords||[]).filter(function(r){return r.type!=='stop';});
        saveDB();
        toast('已删除全部停宿记录');
        renderView();
    }
    // 删除全部退宿记录（leaveRecords 中 type==='leave'）
    function deleteAllLeaveRecords(){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确定要删除全部退宿记录吗？此操作不可恢复！')) return;
        // V3 按行存储：先标记所有待删退宿记录
        (DB.leaveRecords||[]).forEach(function(r){ if(r && r.type==='leave' && r.id!=null) v3MarkDeleted('leave_record', r.id); });
        DB.leaveRecords=(DB.leaveRecords||[]).filter(function(r){return r.type!=='leave';});
        saveDB();
        toast('已删除全部退宿记录');
        renderView();
    }
    // 删除全部巡查核实总结（每日晚检总结 DB.dailyInspectionSummaries）
    // 注意：V3 同步类型名为 'daily_summary'（见 config.js V3_RECORD_TYPES）
    function deleteAllInspectionSummaries(){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确认删除全部巡查核实总结吗？此操作不可恢复！')) return;
        // V3 按行存储：逐条登记墓碑，确保云端与其它设备同步删除
        (DB.dailyInspectionSummaries||[]).forEach(function(r){ if(r && r.id!=null) v3MarkDeleted('daily_summary', r.id); });
        DB.dailyInspectionSummaries=[];
        saveDB();
        toast('已删除全部巡查核实总结');
        renderView();
    }
    // 删除全部巡查确认记录 + 异常上报记录（两类业务数据同时清空）
    function deleteAllConfirmationsAndAnomalies(){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确认删除全部确认记录和异常上报吗？此操作不可恢复！\n\n将同时清空：\n1) 巡查确认记录\n2) 异常上报记录')) return;
        // V3 按行存储：逐条登记墓碑，确保云端与其它设备同步删除
        (DB.inspectionConfirmations||[]).forEach(function(r){ if(r && r.id!=null) v3MarkDeleted('inspection_confirmation', r.id); });
        DB.inspectionConfirmations=[];
        (DB.anomalyReports||[]).forEach(function(r){ if(r && r.id!=null) v3MarkDeleted('anomaly_report', r.id); });
        DB.anomalyReports=[];
        saveDB();
        toast('已删除全部确认记录和异常上报');
        renderView();
    }

    // 日期选择说明：所有日期输入框统一由内嵌 flatpickr 渲染（class="date-picker"），
    // initDatePickers 在视图渲染/色块展开/弹窗打开后自动初始化，选中后派发原生 change 事件，
    // 兼容 updateStopPeriod、addFormChange 等既有监听；库缺失时输入框回退为可手动键入的文本框。
    function updateStopPeriod(){
        var start=document.getElementById('stopStartDate').value;
        var end=document.getElementById('stopEndDate').value;
        if(start && end){
            document.getElementById('stopPeriod').value = start + ' 至 ' + end;
        }
    }
    function autoFillLeave(name){
        if(!name) return;
        // 班级账号优先在本班学生中匹配（其姓名下拉框仅含本班名单），未命中再全局兜底
        var match=getClassStudents().find(function(s){return s.name===name;});
        if(!match) match=DB.students.find(function(s){return s.name===name;});
        if(match){
            document.getElementById('leaveClass').value=match.className;
            var dorm=getDormitoryById(match.dormitoryId);
            var roomNum=dorm?String(dorm.roomNumber):'';
            var bedNum=match.bedNumber!=null?String(match.bedNumber):'';
            // select：刷新选项后再设值，确保选中项存在（PC 端与移动端均为 select）
            var dormSel=document.getElementById('leaveDorm');
            var bedSel=document.getElementById('leaveBed');
            if(dormSel && dormSel.tagName==='SELECT') dormSel.innerHTML=dormSelectOptions(match.className, roomNum);
            if(bedSel && bedSel.tagName==='SELECT') bedSel.innerHTML=bedSelectOptions(dorm?dorm.id:null, bedNum);
            document.getElementById('leaveDorm').value=roomNum;
            document.getElementById('leaveBed').value=bedNum;
        }
    }
    // 床号联动姓名：在当前宿舍内按床号找学生（床号按字符串宽松比较，兼容数字/字符串存储）
    function autoFillLeaveByBed(bedNumber){
        if(!bedNumber) return;
        var roomNumber=document.getElementById('leaveDorm').value;
        if(roomNumber){
            var dorm=DB.dormitories.find(function(d){return d.roomNumber===roomNumber;});
            if(dorm){
                var dormStudents=getStudentsByDormitory(dorm.id);
                if(isClassAdmin()) dormStudents=dormStudents.filter(function(s){return s.className===currentUser.className;});
                var student=dormStudents.find(function(s){return String(s.bedNumber)===String(bedNumber);});
                if(student){
                    document.getElementById('leaveName').value=student.name;
                    document.getElementById('leaveClass').value=student.className;
                }
            }
        }
    }
    function autoFillStop(name){
        if(!name) return;
        // 班级账号优先在本班学生中匹配，未命中再全局兜底
        var match=getClassStudents().find(function(s){return s.name===name;});
        if(!match) match=DB.students.find(function(s){return s.name===name;});
        if(match){
            document.getElementById('stopClass').value=match.className;
            var dorm=getDormitoryById(match.dormitoryId);
            var roomNum=dorm?String(dorm.roomNumber):'';
            var bedNum=match.bedNumber!=null?String(match.bedNumber):'';
            var dormSel=document.getElementById('stopDorm');
            var bedSel=document.getElementById('stopBed');
            if(dormSel && dormSel.tagName==='SELECT') dormSel.innerHTML=dormSelectOptions(match.className, roomNum);
            if(bedSel && bedSel.tagName==='SELECT') bedSel.innerHTML=bedSelectOptions(dorm?dorm.id:null, bedNum);
            document.getElementById('stopDorm').value=roomNum;
            document.getElementById('stopBed').value=bedNum;
        }
    }
    // 床号联动姓名：在当前宿舍内按床号找学生（床号按字符串宽松比较）
    function autoFillStopByBed(bedNumber){
        if(!bedNumber) return;
        var roomNumber=document.getElementById('stopDorm').value;
        if(roomNumber){
            var dorm=DB.dormitories.find(function(d){return d.roomNumber===roomNumber;});
            if(dorm){
                var dormStudents=getStudentsByDormitory(dorm.id);
                if(isClassAdmin()) dormStudents=dormStudents.filter(function(s){return s.className===currentUser.className;});
                var student=dormStudents.find(function(s){return String(s.bedNumber)===String(bedNumber);});
                if(student){
                    document.getElementById('stopName').value=student.name;
                    document.getElementById('stopClass').value=student.className;
                }
            }
        }
    }
    // 请假说明标签随类型动态切换（说明为选填）
    function updateAbsReasonLabel(){
        var t=document.getElementById('absType').value;
        var map={personal:'事假说明（选填）',sick:'病假说明（选填）',other:'其他说明（选填）'};
        var lbl=document.getElementById('absReasonLabel');
        if(lbl) lbl.textContent=map[t]||'请假说明（选填）';
    }
    function autoFillAbs(name){
        if(!name) return;
        var match=getClassStudents().find(function(s){return s.name===name;});
        if(!match) match=DB.students.find(function(s){return s.name===name;});
        if(match){
            document.getElementById('absClass').value=match.className;
            var dorm=getDormitoryById(match.dormitoryId);
            var roomNum=dorm?String(dorm.roomNumber):'';
            var bedNum=match.bedNumber!=null?String(match.bedNumber):'';
            var dormSel=document.getElementById('absDorm');
            var bedSel=document.getElementById('absBed');
            if(dormSel && dormSel.tagName==='SELECT') dormSel.innerHTML=dormSelectOptions(match.className, roomNum);
            if(bedSel && bedSel.tagName==='SELECT') bedSel.innerHTML=bedSelectOptions(dorm?dorm.id:null, bedNum);
            document.getElementById('absDorm').value=roomNum;
            document.getElementById('absBed').value=bedNum;
        }
    }
    // 床号联动姓名：在当前宿舍内按床号找学生（床号按字符串宽松比较）
    function autoFillAbsByBed(bedNumber){
        if(!bedNumber) return;
        var roomNumber=document.getElementById('absDorm').value;
        if(roomNumber){
            var dorm=DB.dormitories.find(function(d){return d.roomNumber===roomNumber;});
            if(dorm){
                var dormStudents=getStudentsByDormitory(dorm.id);
                if(isClassAdmin()) dormStudents=dormStudents.filter(function(s){return s.className===currentUser.className;});
                var student=dormStudents.find(function(s){return String(s.bedNumber)===String(bedNumber);});
                if(student){
                    document.getElementById('absName').value=student.name;
                    document.getElementById('absClass').value=student.className;
                }
            }
        }
    }
    /**
     * 学生管理：按"通过/待审核/全部"等筛选条件重绘请假/停宿记录列表
     * （#leaveTbody/#stopTbody 分片渲染），最后联动重绘退宿列表。
     */
    function applyLeaveFilter(){
        var className = '';
        var nameFilter = '';
        var classSelectEl = document.getElementById('leaveFilterClass');
        var nameInputEl = document.getElementById('leaveFilterName');
        if (classSelectEl) className = classSelectEl.value;
        if (nameInputEl) nameFilter = nameInputEl.value.trim().toLowerCase();
        // 如果是班级账号，强制只显示本班级数据
        if (currentUser && currentUser.role === 'CLASS_ADMIN') {
            className = currentUser.className;
        }
        var records=DB.leaveRecords||[];
        var filtered=records.filter(function(r){
            if(className && r.className!==className) return false;
            if(nameFilter && r.name.toLowerCase().indexOf(nameFilter)===-1) return false;
            return true;
        });
        var leaveRecords=filtered.filter(function(r){return r.type==='leave';});
        var stopRecords=filtered.filter(function(r){return r.type==='stop';});
        var isAdm=isAdmin();
        // 管理员操作列：待审核记录提供 通过/驳回，所有记录可删除
        function adminOps(r){
            if(!isAdm) return '';
            var btns='';
            if(r.status==='pending'){
                btns='<button class="btn btn-success btn-xs" onclick="approveLeaveRecord(\''+r.id+'\')">通过</button> '
                    +'<button class="btn btn-warning btn-xs" onclick="rejectLeaveRecord(\''+r.id+'\')">驳回</button> ';
            }
            btns+='<button class="btn btn-danger btn-xs" onclick="deleteLeaveRecord(\''+r.id+'\')">删除</button>';
            return '<td data-label="操作">'+btns+'</td>';
        }
        // 单行退宿/停宿记录 HTML（供分片渲染逐条调用）
        function leaveRowHtml(r){
            return '<tr><td data-label="班级">'+r.className+'</td><td data-label="姓名">'+r.name+'</td><td data-label="宿舍号">'+getDormSnapshotDisplay(r.dormitory)+'</td><td data-label="床号">'+r.bed+'</td><td data-label="日期">'+r.date+'</td><td data-label="原因">'+r.reason+'</td><td data-label="状态">'+getLeaveRecordStatusBadge(r)+'</td>'+adminOps(r)+'</tr>';
        }
        // 退宿记录：空 → 空状态；非空 → 表格骨架 + 分片填充（审核/删除按钮内联 onclick，逐批插入即生效）
        var leaveCntEl=document.getElementById('recCount-leave');
        if(leaveCntEl) leaveCntEl.textContent='（'+leaveRecords.length+'条）';
        var leaveListEl=document.getElementById('leaveRecordsList');
        if(leaveListEl){
            if(leaveRecords.length===0){
                leaveListEl.innerHTML='<div class="empty-state">暂无退宿记录</div>';
            }else{
                leaveListEl.innerHTML='<div style="overflow-x:auto"><table><thead><tr><th>班级</th><th>姓名</th><th>宿舍号</th><th>床号</th><th>退宿时间</th><th>退宿原因</th><th>状态</th>'+(isAdm?'<th>操作</th>':'')+'</tr></thead><tbody id="leaveTbody"></tbody></table></div>';
                renderListInChunks(document.getElementById('leaveTbody'), leaveRecords, leaveRowHtml, 50);
            }
        }
        var stopCntEl=document.getElementById('recCount-stop');
        if(stopCntEl) stopCntEl.textContent='（'+stopRecords.length+'条）';
        var stopListEl=document.getElementById('stopRecordsList');
        if(stopListEl){
            if(stopRecords.length===0){
                stopListEl.innerHTML='<div class="empty-state">暂无停宿记录</div>';
            }else{
                stopListEl.innerHTML='<div style="overflow-x:auto"><table><thead><tr><th>班级</th><th>姓名</th><th>宿舍号</th><th>床号</th><th>停宿时间段</th><th>停宿原因</th><th>状态</th>'+(isAdm?'<th>操作</th>':'')+'</tr></thead><tbody id="stopTbody"></tbody></table></div>';
                renderListInChunks(document.getElementById('stopTbody'), stopRecords, leaveRowHtml, 50);
            }
        }
        renderAbsenceRecords();
    }
    // 记录列表折叠（互斥）：同时仅展开一个列表；再次点击已展开的收起
    // foldState 记录各折叠块开合状态，视图重渲染后恢复
    var foldState={};
    /**
     * 通用折叠块展开/收起（foldState 跨重绘保持状态）。
     * @param {string} id - 折叠块 id（如 'stats-top'）
     */
    function toggleFold(id){
        var el=document.getElementById(id);
        if(!el) return;
        var opening=!el.classList.contains('open');
        el.classList.toggle('open',opening);
        foldState[id]=opening;
    }
    function toggleRecFold(type){
        ['absence','stop','leave'].forEach(function(t){
            var block=document.getElementById('recFold-'+t);
            if(!block) return;
            var opening=(t===type)&&!block.classList.contains('open');
            block.classList.toggle('open',opening);
            foldState['recFold-'+t]=opening;
        });
    }

    /**
     * 数据管理：账号管理 / 楼层分配管理 卡片互斥折叠（同时仅展开一个；
     * 再次点击已展开的则收起）。foldState 跨重渲染保持。
     * @param {string} id - 'fold-account-manage' | 'fold-floor-manage'
     */
    function toggleAccountOrFloor(id){
        ['fold-account-manage','fold-floor-manage'].forEach(function(fid){
            var block=document.getElementById(fid);
            if(!block) return;
            var opening=(fid===id)&&!block.classList.contains('open');
            block.classList.toggle('open',opening);
            foldState[fid]=opening;
        });
    }
    /**
     * PC 端学生管理：请假登记 / 停宿管理 / 退宿管理 三个表单卡片互斥折叠
     * （同时仅展开一个；再次点击已展开的则收起）。移动端色块布局不受影响。
     * @param {string} id - 'fold-leave-absence' | 'fold-leave-stop' | 'fold-leave-leave'
     */
    function toggleLeaveManageCard(id){
        ['fold-leave-absence','fold-leave-stop','fold-leave-leave'].forEach(function(fid){
            var block=document.getElementById(fid);
            if(!block) return;
            var opening=(fid===id)&&!block.classList.contains('open');
            block.classList.toggle('open',opening);
            foldState[fid]=opening;
        });
    }

    /**
     * 提交退宿(leave)/停宿(stop)登记（入口）：_busy 防双击，safeAsync 统一异常处理。
     * @param {string} type - 'leave'（退宿/请假）| 'stop'（停宿）
     */
    function addLeaveRecord(type){
        if(addLeaveRecord._busy) return; // 防止移动端双击重复提交
        addLeaveRecord._busy=true;
        setTimeout(function(){addLeaveRecord._busy=false;},800);
        // 经 safeAsync 统一捕获数据写入/保存异常，失败可点击重试
        safeAsync(function(){ return addLeaveRecordImpl(type); }, type==='leave'?'登记退宿':'登记停宿', { retry: true });
    }
    /**
     * 登记实际逻辑：读取表单（班级/姓名/宿舍/床号/日期/原因/起止日期），
     * 补 studentId 快照，生成记录写入 DB.leaveRecords 并标脏，
     * saveDB 后刷新列表（待审核状态等管理员审核）。
     * @param {string} type - 'leave' | 'stop'
     */
    function addLeaveRecordImpl(type){
        var className, name, dormitory, bed, date, reason, startDate, endDate;
        if(type==='leave'){
            className=document.getElementById('leaveClass').value.trim();
            name=document.getElementById('leaveName').value.trim();
            dormitory=document.getElementById('leaveDorm').value.trim();
            bed=document.getElementById('leaveBed').value.trim();
            date=document.getElementById('leaveDate').value;
            reason=document.getElementById('leaveReason').value.trim();
            startDate=date; endDate=date;
        } else {
            className=document.getElementById('stopClass').value.trim();
            name=document.getElementById('stopName').value.trim();
            dormitory=document.getElementById('stopDorm').value.trim();
            bed=document.getElementById('stopBed').value.trim();
            date=document.getElementById('stopPeriod').value.trim();
            reason=document.getElementById('stopReason').value.trim();
            startDate=document.getElementById('stopStartDate').value;
            endDate=document.getElementById('stopEndDate').value;
        }
        // 非住宿生（走读生）允许宿舍号/床号为空
        var matchedStu=DB.students.find(function(s){return s.className===className&&s.name===name;});
        var isNonRes=matchedStu&&isNonResidentStudent(matchedStu);
        if(!className||!name||!date||!reason){toast('请填写完整信息','error');return;}
        if(!isNonRes&&(!dormitory||!bed)){toast('请填写完整信息','error');return;}
        // 管理员登记直接生效（approved）；班级/生活老师登记需审核（pending）
        var status=isAdmin()?'approved':'pending';
        var stu=isNonRes?matchedStu:matchStudentBySnapshot(className,name,dormitory,bed);
        var newRec={
            id:generateRecordId(), type:type, className:className, name:name,
            dormitory:dormitory, bed:bed, date:date, reason:reason,
            status:status, studentId:stu?stu.id:null,
            startDate:startDate, endDate:endDate, createdAt:Date.now(),
            localNew:true   // 本地新增标记：云端拉取合并时据此保留尚未上传的新记录
        };
        if(!DB.leaveRecords) DB.leaveRecords=[];
        DB.leaveRecords.push(newRec);
        // V3 按行存储：新退宿/停宿记录标记脏
        v3MarkDirty('leave_record', newRec.id);
        saveDB();
        toast(status==='pending'?'登记成功，待管理员审核':'登记成功！');
        // 班级账号的班级字段只读锁定，重置时保留本班；其他角色清空回"请选择班级"
        var resetClassVal=isClassAdmin()?currentUser.className:'';
        if(type==='leave'){
            document.getElementById('leaveClass').value=resetClassVal; document.getElementById('leaveName').value=''; document.getElementById('leaveDorm').value=''; document.getElementById('leaveBed').value=''; setDateValue('leaveDate',''); document.getElementById('leaveReason').value='';
        } else {
            document.getElementById('stopClass').value=resetClassVal; document.getElementById('stopName').value=''; document.getElementById('stopDorm').value=''; document.getElementById('stopBed').value=''; setDateValue('stopStartDate',''); setDateValue('stopEndDate',''); document.getElementById('stopPeriod').value=''; document.getElementById('stopReason').value='';
        }
        if(window.innerWidth>768){ initPcSelects(); } // PC 端：重置后重建各下拉为初始联动状态
        applyLeaveFilter();
        refreshAccBlockInfo();
    }
    // 管理员审核：通过
    // id 匹配采用 String() 宽松比较，兼容云端同步/历史数据中 id 可能为字符串的情况
    /**
     * 审核通过退宿/停宿申请（管理员）：status 置 approved 并标脏，落库后刷新列表。
     * @param {string|number} id - 记录 ID
     */
    function approveLeaveRecord(id){
        if(!isAdmin()){toast('无权限','error');return;}
        var r=DB.leaveRecords.find(function(x){return String(x.id)===String(id);});
        if(!r){toast('记录不存在（ID:'+id+'），请刷新页面','error');return;}
        r.status='approved';
        // V3 按行存储：审核状态变更 → 脏
        v3MarkDirty('leave_record', id);
        saveDB();
        toast('✅ 审核已通过');
        applyLeaveFilter();
        refreshAccBlockInfo();
    }
    // 管理员审核：驳回
    /**
     * 审核驳回退宿/停宿申请（管理员）：status 置 rejected 并标脏，落库后刷新列表。
     * @param {string|number} id - 记录 ID
     */
    function rejectLeaveRecord(id){
        if(!isAdmin()){toast('无权限','error');return;}
        var r=DB.leaveRecords.find(function(x){return String(x.id)===String(id);});
        if(!r){toast('记录不存在（ID:'+id+'），请刷新页面','error');return;}
        r.status='rejected';
        // V3 按行存储：审核状态变更 → 脏
        v3MarkDirty('leave_record', id);
        saveDB();
        toast('❌ 审核未通过');
        applyLeaveFilter();
        refreshAccBlockInfo();
    }
    // 按 id 查找退宿/停宿记录（宽松匹配，供其他模块复用）
    function findLeaveRecordById(id){
        return (DB.leaveRecords||[]).find(function(x){return String(x.id)===String(id);})||null;
    }
    // 获取今日日期字符串（YYYY-MM-DD，基于本地时区；实现委托给 data.js 的 getTodayLocalStr）
    function getTodayStr(){ return getTodayLocalStr(); }
    // 计算学生在住宿信息中的状态标签（按优先级从高到低）
    // 返回 {label, cls}；cls 对应 CSS 类 status-red/orange/purple/blue/green
    function getStudentStatus(studentId){
        if(!studentId) return {label:'在住', cls:'status-green'};
        var today=getTodayStr();
        var leaves=DB.leaveRecords||[];
        var absences=DB.absenceRecords||[];
        // 1. 已退宿（approved）
        if(leaves.some(function(r){return r.studentId===studentId&&r.type==='leave'&&r.status==='approved';}))
            return {label:'已退宿', cls:'status-red'};
        // 2. 退宿申请中（pending）
        if(leaves.some(function(r){return r.studentId===studentId&&r.type==='leave'&&r.status==='pending';}))
            return {label:'退宿申请中', cls:'status-orange'};
        // 3. 停宿中（approved 且未过期）
        if(leaves.some(function(r){return r.studentId===studentId&&r.type==='stop'&&r.status==='approved'&&r.endDate&&r.endDate>=today;}))
            return {label:'停宿中', cls:'status-purple'};
        // 4. 停宿申请中（pending）
        if(leaves.some(function(r){return r.studentId===studentId&&r.type==='stop'&&r.status==='pending';}))
            return {label:'停宿申请中', cls:'status-orange'};
        // 5. 请假中（未过期）
        if(absences.some(function(r){return r.studentId===studentId&&r.endDate&&r.endDate>=today;}))
            return {label:'请假中', cls:'status-blue'};
        // 6. 默认在住
        return {label:'在住', cls:'status-green'};
    }
    // 退宿/停宿记录在列表中的状态标签（含"已结束"判定）
    function getLeaveRecordStatusBadge(r){
        var today=getTodayStr();
        if(r.status==='pending') return '<span class="status-tag status-orange">待审核</span>';
        if(r.status==='rejected') return '<span class="status-tag status-red">已驳回</span>';
        // approved
        if(r.type==='stop'&&r.endDate&&r.endDate<today) return '<span class="status-tag status-gray">已结束</span>';
        return '<span class="status-tag status-green">已通过</span>';
    }
    // 请假记录在列表中的状态标签
    function getAbsenceStatusBadge(r){
        var today=getTodayStr();
        if(r.endDate&&r.endDate<today) return '<span class="status-tag status-gray">已结束</span>';
        return '<span class="status-tag status-blue">请假中</span>';
    }
    /**
     * 删除退宿/停宿记录（管理员，confirm 确认）：打 V3 墓碑、落库同步后刷新列表。
     * @param {string|number} id - 记录 ID
     */
    function deleteLeaveRecord(id){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确认删除？')) return;
        DB.leaveRecords=DB.leaveRecords.filter(function(r){return r.id!==id;});
        // V3 按行存储：标记删除
        v3MarkDeleted('leave_record', id);
        saveDB();
        toast('已删除');
        applyLeaveFilter();
    }
    // ==================== 请假记录 ====================
    /**
     * 提交请假/缺宿记录登记（入口）：_busy 防双击，safeAsync 统一异常处理。
     */
    function addAbsenceRecord(){
        if(addAbsenceRecord._busy) return;
        addAbsenceRecord._busy=true;
        setTimeout(function(){addAbsenceRecord._busy=false;},800);
        // 经 safeAsync 统一捕获数据写入/保存异常，失败可点击重试
        safeAsync(addAbsenceRecordImpl, '登记请假', { retry: true });
    }
    /**
     * 登记实际逻辑：读取表单生成 absence 记录写入 DB.absenceRecords 并标脏，
     * saveDB 落库同步后刷新退宿记录列表。
     */
    function addAbsenceRecordImpl(){
        var className=document.getElementById('absClass').value.trim();
        var name=document.getElementById('absName').value.trim();
        var dormitory=document.getElementById('absDorm').value.trim();
        var bed=document.getElementById('absBed').value.trim();
        var type=document.getElementById('absType').value;
        var reason=document.getElementById('absReason').value.trim();
        var startDate=document.getElementById('absStartDate').value;
        var endDate=document.getElementById('absEndDate').value;
        // 非住宿生（走读生）允许宿舍号/床号为空
        var matchedStu=DB.students.find(function(s){return s.className===className&&s.name===name;});
        var isNonRes=matchedStu&&isNonResidentStudent(matchedStu);
        if(!className||!name||!startDate||!endDate){toast('请填写完整信息','error');return;} // 说明为选填，不校验
        if(!isNonRes&&(!dormitory||!bed)){toast('请填写完整信息','error');return;}
        if(endDate<startDate){toast('结束日期不能早于开始日期','error');return;}
        var stu=isNonRes?matchedStu:matchStudentBySnapshot(className,name,dormitory,bed);
        var newRec={
            id:DB.nextIds.absence++, studentId:stu?stu.id:null,
            className:className, name:name, dormitory:dormitory, bed:bed,
            type:type, reason:reason, startDate:startDate, endDate:endDate,
            status:'approved', createdAt:Date.now(),
            localNew:true   // 本地新增标记：云端拉取合并时据此保留尚未上传的新记录
        };
        if(!DB.absenceRecords) DB.absenceRecords=[];
        DB.absenceRecords.push(newRec);
        // V3 按行存储：新请假记录标记脏
        v3MarkDirty('absence_record', newRec.id);
        saveDB();
        toast('请假登记成功！');
        document.getElementById('absName').value=''; document.getElementById('absDorm').value=''; document.getElementById('absBed').value=''; document.getElementById('absReason').value='';
        if(window.innerWidth>768){ refreshPcSelects('abs'); } // PC 端：重建姓名/宿舍/床号下拉（班级保留）
        renderAbsenceRecords();
        refreshAccBlockInfo();
    }
    function deleteAbsenceRecord(id){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!confirm('确认删除？')) return;
        DB.absenceRecords=(DB.absenceRecords||[]).filter(function(r){return r.id!==id;});
        // V3 按行存储：标记删除
        v3MarkDeleted('absence_record', id);
        saveDB();
        toast('已删除');
        renderAbsenceRecords();
    }

    // ==================== 巡查核实模块 ====================
    // 巡查视图状态：viewDate 为空串=今日（可操作）；否则为历史只读查看日期 YYYY-MM-DD
    var inspectionState = { viewDate: '' };
    // 异常上报模态框临时状态
    var anomalyModalState = { dormitoryId: null };

    /**
     * 历史日期选择：读取日期选择器并切换到该日只读巡查视图。
     */
    function onInspectionHistoryDate(){
        var el=document.getElementById('inspectionHistoryDate');
        var v=el?String(el.value).trim():'';
        if(!v){ toast('请选择日期','error'); return; }
        inspectionState.viewDate=v;
        renderInspectionView(document.getElementById('contentArea'));
    }
    /**
     * 返回今日巡查视图。
     */
    function backToInspectionToday(){
        inspectionState.viewDate='';
        renderInspectionView(document.getElementById('contentArea'));
    }

    /**
     * 巡查确认：生活老师核实某条请假/停宿/退宿信息属实。
     * 仅表示"信息属实"，不涉及在宿/不在宿判断；写入 inspectionConfirmations
     * 并标脏纳入 V3 同步。同一记录同一天不可重复确认；历史日期只读。
     * @param {string} recordType - 'leave'（退宿）| 'stop'（停宿）| 'absence'（请假）
     * @param {string|number} recordId - 对应的 leaveRecords/absenceRecords 记录 ID
     */
    function confirmInspection(recordType, recordId){
        if(!currentUser) return;
        var today=getTodayLocalStr();
        if((inspectionState.viewDate||today) !== today){ toast('历史日期不可操作','error'); return; }
        if(getInspectionConfirmation(recordType, recordId, today)){ toast('该生今日已确认','error'); return; }
        var item=getInspectionItems(today, getAssignedFloorIds()).find(function(it){
            return it.recordType===recordType && String(it.recordId)===String(recordId);
        });
        if(!item){ toast('记录不存在或已不在负责楼层','error'); return; }
        var now=Date.now();
        var rec={
            id: generateRecordId(),
            studentId: item.studentId || null,
            dormitoryId: item.dormitoryId || null,
            recordType: recordType,
            recordId: recordId,
            confirmDate: today,
            confirmedBy: currentUser.id,
            confirmedByName: currentUser.realName,
            confirmedAt: now,
            createdAt: now, lastModified: now
        };
        if(!Array.isArray(DB.inspectionConfirmations)) DB.inspectionConfirmations=[];
        DB.inspectionConfirmations.push(rec);
        v3MarkDirty('inspection_confirmation', rec.id);
        saveDB();
        toast('✅ 已确认：'+item.name);
        renderInspectionView(document.getElementById('contentArea'));
    }

    /**
     * 打开异常上报模态框（全站唯一入口：巡查核实页顶部"异常上报"卡片）。
     * 固定为楼层→宿舍→学生三级联动模式；提交逻辑见 submitAnomalyReport。
     */
    function openAnomalyModal(){
        if(!isStaff() && !isAdmin()){ toast('无权限','error'); return; }
        anomalyModalState.dormitoryId=null;
        anomalyModalState.floorId=null;
        var floorIds=getAssignedFloorIds();
        var floorOpts='<option value="">— 请选择楼层 —</option>'
            +floorIds.map(function(fid){ var f=getFloorById(fid); return f?'<option value="'+fid+'">'+escapeHtmlAttr(f.name)+'</option>':''; }).join('');
        var html='<div class="em-header"><span>⚠️ 异常上报</span><button class="em-close" aria-label="关闭" onclick="closeAnomalyModal()">✕</button></div>'
            +'<div class="em-body">'
            +'<div class="form-group"><label>楼层 *</label><select id="anomalyFloor" onchange="onAnomalyFloorChange()">'+floorOpts+'</select></div>'
            +'<div class="form-group" id="anomalyDormWrap" style="display:none"><label>宿舍 *</label><select id="anomalyDorm" onchange="onAnomalyDormChange()"><option value="">— 请选择宿舍 —</option></select></div>'
            +'<div id="anomalyStudentArea"></div>'
            +'</div>'
            +'<div class="em-footer"><button class="btn btn-primary" onclick="submitAnomalyReport()">📤 提交上报</button><button class="btn btn-outline" onclick="closeAnomalyModal()">取消</button></div>';
        document.getElementById('anomalyModalBox').innerHTML=html;
        document.getElementById('anomalyModal').classList.add('show');
    }
    /**
     * 拼装异常上报的学生选择+类型+备注表单（级联选定宿舍后调用）。
     * @param {object} dorm - 宿舍对象
     */
    function buildAnomalyStudentForm(dorm){
        var students=getStudentsByDormitory(dorm.id);
        var stuOpts='<option value="">— 请选择学生 —</option>'
            +students.map(function(s){
                return '<option value="'+s.id+'">'+escapeHtmlAttr(s.name)+'（'+escapeHtmlAttr(s.className||'')+' · 床号'+(s.bedNumber||'-')+'）</option>';
            }).join('')
            +'<option value="manual">✏️ 其他（手动输入姓名）</option>';
        return '<div class="form-group" style="color:var(--gray-500);font-size:0.9286rem">已选宿舍：<b>'+escapeHtmlAttr(dorm.roomNumber)+'</b></div>'
            +'<div class="form-group"><label>学生 *</label><select id="anomalyStudent" onchange="onAnomalyStudentChange()">'+stuOpts+'</select></div>'
            +'<div class="form-group" id="anomalyManualWrap" style="display:none"><label>学生姓名 *</label><input type="text" id="anomalyName" placeholder="手动输入学生姓名"></div>'
            +'<div class="form-group"><label>异常类型 *</label><select id="anomalyType"><option value="picked_up">🚗 家长接走（不扣分）</option><option value="no_note">⚠️ 无假条（自动生成纪律扣分：无请假信息 1分）</option></select></div>'
            +'<div class="form-group"><label>备注</label><input type="text" id="anomalyNote" placeholder="可选：具体情况说明"></div>';
    }
    /** 通用模式：楼层变化 → 加载该楼层宿舍列表 */
    function onAnomalyFloorChange(){
        var fid=parseInt(document.getElementById('anomalyFloor').value,10)||0;
        anomalyModalState.floorId=fid||null;
        anomalyModalState.dormitoryId=null;
        var dormWrap=document.getElementById('anomalyDormWrap');
        var stuArea=document.getElementById('anomalyStudentArea');
        if(stuArea) stuArea.innerHTML='';
        if(!fid){ if(dormWrap) dormWrap.style.display='none'; return; }
        var dorms=getDormitoriesByFloor(fid).filter(function(d){ return !isDormitoryDeleted(d.roomNumber); })
            .sort(function(a,b){ return String(a.roomNumber).localeCompare(String(b.roomNumber)); });
        var opts='<option value="">— 请选择宿舍 —</option>'
            +dorms.map(function(d){ return '<option value="'+d.id+'">'+escapeHtmlAttr(d.roomNumber)+'</option>'; }).join('');
        var dormSel=document.getElementById('anomalyDorm');
        if(dormSel){ dormSel.innerHTML=opts; dormWrap.style.display=''; }
    }
    /** 通用模式：宿舍变化 → 加载该宿舍学生表单 */
    function onAnomalyDormChange(){
        var did=parseInt(document.getElementById('anomalyDorm').value,10)||0;
        anomalyModalState.dormitoryId=did||null;
        var stuArea=document.getElementById('anomalyStudentArea');
        if(!stuArea) return;
        if(!did){ stuArea.innerHTML=''; return; }
        var dorm=getDormitoryById(did);
        if(!dorm){ stuArea.innerHTML=''; return; }
        stuArea.innerHTML=buildAnomalyStudentForm(dorm);
    }
    /** 关闭异常上报模态框 */
    function closeAnomalyModal(){
        var m=document.getElementById('anomalyModal');
        if(m) m.classList.remove('show');
    }
    /** 异常上报：学生选择"手动输入"时显示姓名输入框 */
    function onAnomalyStudentChange(){
        var sel=document.getElementById('anomalyStudent');
        var wrap=document.getElementById('anomalyManualWrap');
        if(wrap) wrap.style.display = (sel && sel.value==='manual') ? '' : 'none';
    }
    /**
     * 提交异常上报：
     *  - picked_up（家长接走）：仅记录 anomalyReports，不生成扣分；
     *  - no_note（无假条）：记录 anomalyReports 并自动生成纪律扣分记录
     *    （项目"无请假信息"，扣 1 分），deductionRecordId 关联两条记录。
     * 全部落库标脏纳入 V3 同步后刷新巡查视图。
     */
    function submitAnomalyReport(){
        var dormitoryId=anomalyModalState.dormitoryId;
        if(!dormitoryId){ toast('请先选择楼层和宿舍','error'); return; }
        var dorm=getDormitoryById(dormitoryId);
        if(!dorm){ toast('宿舍信息缺失','error'); return; }
        var stuVal=document.getElementById('anomalyStudent').value;
        var stu=stuVal && stuVal!=='manual' ? getStudentById(parseInt(stuVal,10)) : null;
        var manualNameEl=document.getElementById('anomalyName');
        var manualName=manualNameEl?String(manualNameEl.value).trim():'';
        var studentName=stu ? stu.name : manualName;
        if(!studentName){ toast('请选择学生或手动输入姓名','error'); return; }
        var type=document.getElementById('anomalyType').value==='no_note' ? 'no_note' : 'picked_up';
        var note=String(document.getElementById('anomalyNote').value||'').trim();
        var today=getTodayLocalStr();
        var now=Date.now();
        var report={
            id: generateRecordId(),
            studentId: stu ? stu.id : null,
            studentName: studentName,
            className: stu ? (stu.className||'') : '',
            dormitoryId: dormitoryId,
            dormitoryRoom: dorm.roomNumber,
            bed: stu && stu.bedNumber!=null ? String(stu.bedNumber) : '',
            reportDate: today,
            reportedBy: currentUser.id,
            reportedByName: currentUser.realName,
            anomalyType: type,
            note: note,
            deductionRecordId: null,
            createdAt: now, lastModified: now
        };
        // 无假条：自动生成纪律扣分记录（"无请假信息"扣 1 分）并与异常上报互相关联
        if(type==='no_note'){
            var item=ensureNoNoteDeductionItem();
            var dedRec={
                id: generateRecordId(),
                createdAt: now,
                dormitoryId: dormitoryId,
                studentId: stu ? stu.id : null,
                hygieneItemIds: [], hygieneScore: 0,
                disciplineItemIds: [item.id], disciplineScore: item.defaultScore || 1,
                recordDate: today,
                remark: '巡查核实·无假条'+(note?'：'+note:'')
            };
            DB.deductionRecords.push(dedRec);
            v3MarkDirty('deduction_record', dedRec.id);
            report.deductionRecordId=dedRec.id;
        }
        if(!Array.isArray(DB.anomalyReports)) DB.anomalyReports=[];
        DB.anomalyReports.push(report);
        v3MarkDirty('anomaly_report', report.id);
        saveDB();
        closeAnomalyModal();
        toast(type==='no_note' ? '已上报无假条，并自动生成扣分记录' : '已上报家长接走');
        renderInspectionView(document.getElementById('contentArea'));
        renderTree();
    }

    /**
     * 今日待确认学生全部核实完成后，生成/更新当日晚检总结并落库（幂等）。
     * 已有总结时按最新统计更新（数据变化才标脏），避免重复同步；返回总结对象。
     * @returns {object} 总结数据
     */
    function ensureTodaySummary(){
        var today=getTodayLocalStr();
        var sum=computeInspectionSummary(today, currentUser);
        var existing=getDailySummary(today, currentUser.id);
        var now=Date.now();
        if(!existing){
            var rec={
                id: generateRecordId(),
                summaryDate: today,
                buildingName: sum.buildingName,
                floors: sum.floors.slice(),
                confirmedBy: sum.confirmedBy,
                confirmedByName: sum.confirmedByName,
                totalStudents: sum.totalStudents,
                absenceCount: sum.absenceCount,
                leavePendingCount: sum.leavePendingCount,
                pickedUpCount: sum.pickedUpCount,
                anomalyCount: sum.anomalyCount,
                actualCount: sum.actualCount,
                leavePendingDetails: sum.leavePendingDetails,
                pickedUpDetails: sum.pickedUpDetails,
                anomalyDetails: sum.anomalyDetails,
                createdAt: now, lastModified: now
            };
            if(!Array.isArray(DB.dailyInspectionSummaries)) DB.dailyInspectionSummaries=[];
            DB.dailyInspectionSummaries.push(rec);
            v3MarkDirty('daily_summary', rec.id);
            saveDB();
            return rec;
        }
        // 已有总结：更新统计与详情快照（有变化才标脏上传）
        var changed=false;
        ['buildingName','totalStudents','absenceCount','leavePendingCount','pickedUpCount','anomalyCount','actualCount','confirmedByName']
            .forEach(function(k){
                if(existing[k] !== sum[k]){ existing[k]=sum[k]; changed=true; }
            });
        ['floors','leavePendingDetails','pickedUpDetails','anomalyDetails'].forEach(function(k){
            if(JSON.stringify(existing[k]||null) !== JSON.stringify(sum[k]||null)){
                existing[k] = (k==='floors') ? sum[k].slice() : sum[k];
                changed=true;
            }
        });
        if(changed){
            existing.lastModified=now;
            v3MarkDirty('daily_summary', existing.id);
            saveDB();
        }
        return existing;
    }

    /**
     * 导出某日晚检总结为 Excel（XLSX，多工作表：统计 + 三类详情）。
     * @param {string} date - 日期 YYYY-MM-DD
     */
    function exportInspectionSummary(date){
        if(!window.XLSX){ toast('Excel 组件未加载','error'); return; }
        var sum=getDailySummary(date, currentUser.id) || computeInspectionSummary(date, currentUser);
        var floorNums=(sum.floors||[]).map(function(fid){ var f=getFloorById(fid); return f?f.sortOrder:fid; }).sort(function(a,b){return a-b;});
        var wb=XLSX.utils.book_new();
        var aoa=[
            ['晚检总结（'+formatInspectionDateTitle(date)+'）'],
            ['日期', date],
            ['楼栋', sum.buildingName || '本楼'],
            ['负责楼层', floorNums.join('、')+'楼'],
            ['确认人', sum.confirmedByName || ''],
            [],
            ['入宿人数', sum.totalStudents],
            ['当天请假', sum.absenceCount],
            ['退宿/停宿中', sum.leavePendingCount],
            ['家长接走', sum.pickedUpCount],
            ['无假条', sum.anomalyCount],
            ['实到人数', sum.actualCount]
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '总结统计');
        function detailSheet(name, list, cols){
            var rows=[cols.map(function(c){ return c.label; })];
            (list||[]).forEach(function(r){
                rows.push(cols.map(function(c){ return r[c.key]==null?'':r[c.key]; }));
            });
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
        }
        detailSheet('退宿停宿中', sum.leavePendingDetails, [
            {key:'name',label:'姓名'},{key:'className',label:'班级'},{key:'bed',label:'床号'},{key:'dormitory',label:'宿舍'},{key:'type',label:'类型'},{key:'startDate',label:'开始日期'},{key:'endDate',label:'结束日期'}
        ]);
        detailSheet('家长接走', sum.pickedUpDetails, [
            {key:'name',label:'姓名'},{key:'className',label:'班级'},{key:'bed',label:'床号'},{key:'dormitory',label:'宿舍'},{key:'confirmedBy',label:'确认人'},{key:'note',label:'备注'}
        ]);
        detailSheet('无假条', sum.anomalyDetails, [
            {key:'name',label:'姓名'},{key:'className',label:'班级'},{key:'bed',label:'床号'},{key:'dormitory',label:'宿舍'},{key:'reportedBy',label:'上报人'},{key:'note',label:'备注'}
        ]);
        XLSX.writeFile(wb, '晚检总结_'+date+'.xlsx');
        toast('已导出 Excel');
    }

    /**
     * 导出数据管理页所选日期范围内的全部巡查核实总结为 Excel。
     * 每天一个 Sheet，Sheet 名用日期（如 2026-09-09）；每个 Sheet 内容为
     * 巡查核实总结（标题/楼栋/楼层/值班老师 + 统计数字 + 三类学生详情）。
     * 仅 ADMIN 可用。
     */
    function exportInspectionSummariesRange(){
        if(!isAdmin()){toast('无权限','error');return;}
        if(!window.XLSX){ toast('Excel 组件未加载','error'); return; }
        var startEl=document.getElementById('exportStartDate');
        var endEl=document.getElementById('exportEndDate');
        var startDate=startEl?String(startEl.value).trim():'';
        var endDate=endEl?String(endEl.value).trim():'';
        if(!startDate||!endDate){toast('请选择日期范围','error');return;}
        if(startDate>endDate){toast('开始日期不能晚于结束日期','error');return;}
        var summaries=(DB.dailyInspectionSummaries||[]).filter(function(s){
            return s.summaryDate && s.summaryDate>=startDate && s.summaryDate<=endDate;
        }).sort(function(a,b){ return a.summaryDate<b.summaryDate?-1:(a.summaryDate>b.summaryDate?1:0); });
        if(summaries.length===0){toast('该日期范围内暂无巡查总结','error');return;}
        var wb=XLSX.utils.book_new();
        // 同一天可能有多条总结（不同值班老师/楼层），Sheet 名需加序号避免冲突
        var dateCount={};
        summaries.forEach(function(sum){
            var date=sum.summaryDate;
            var baseName=date;
            dateCount[baseName]=(dateCount[baseName]||0)+1;
            var sheetName=dateCount[baseName]>1 ? baseName+'('+dateCount[baseName]+')' : baseName;
            // 日期标题：9月9号（周三晚）
            var title;
            try{
                var parts=String(date).split('-');
                var d=new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10));
                var week='日一二三四五六'.charAt(d.getDay());
                title=(d.getMonth()+1)+'月'+d.getDate()+'号（周'+week+'晚）';
            }catch(e){ title=date; }
            var floorNums=(sum.floors||[]).map(function(fid){ var f=getFloorById(fid); return f?f.sortOrder:fid; }).sort(function(a,b){return a-b;});
            var building=sum.buildingName || '本楼';
            var teacher=sum.confirmedByName || '';
            var aoa=[
                ['巡查核实总结'],
                ['日期：'+title],
                ['楼栋：'+building],
                ['楼层：'+(floorNums.length?floorNums.join('、')+'楼':'-')],
                ['值班老师：'+teacher],
                ['————————————————'],
                ['入宿人数：'+sum.totalStudents+'人'],
                ['当天请假：'+sum.absenceCount+'人'],
                ['退  宿  中：'+sum.leavePendingCount+'人'],
                ['家长接走：'+sum.pickedUpCount+'人'],
                ['无  假  条：'+sum.anomalyCount+'人'],
                ['实到人数：'+sum.actualCount+'人'],
                []
            ];
            // 退宿中
            var lp=sum.leavePendingDetails||[];
            aoa.push(['退宿中（'+lp.length+'人）：']);
            if(lp.length===0){ aoa.push(['（暂无）']); }
            else{
                aoa.push(['姓名','班级','床号','宿舍','类型']);
                lp.forEach(function(r){ aoa.push([r.name||'',r.className||'',r.bed||'',r.dormitory||'',r.type||'']); });
            }
            aoa.push([]);
            // 家长接走
            var pu=sum.pickedUpDetails||[];
            aoa.push(['家长接走（'+pu.length+'人）：']);
            if(pu.length===0){ aoa.push(['（暂无）']); }
            else{
                aoa.push(['姓名','班级','床号','宿舍','确认人','备注']);
                pu.forEach(function(r){ aoa.push([r.name||'',r.className||'',r.bed||'',r.dormitory||'',r.confirmedBy||'',r.note||'']); });
            }
            aoa.push([]);
            // 无假条
            var nn=sum.anomalyDetails||[];
            aoa.push(['无假条（'+nn.length+'人）：']);
            if(nn.length===0){ aoa.push(['（暂无）']); }
            else{
                aoa.push(['姓名','班级','床号','宿舍','上报人','备注']);
                nn.forEach(function(r){ aoa.push([r.name||'',r.className||'',r.bed||'',r.dormitory||'',r.reportedBy||'',r.note||'']); });
            }
            // Sheet 名取日期（Excel 限制 31 字符，日期格式安全；同日多条时带序号）
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
        });
        var fileName='巡查核实总结_'+startDate+(startDate===endDate?'':'_至_'+endDate)+'.xlsx';
        XLSX.writeFile(wb, fileName);
        toast('已导出 '+summaries.length+' 天的巡查总结');
    }

    /**
     * 一键复制某日晚检总结为纯文本（含楼栋、值班老师、统计数字与学生详情），
     * 供生活老师直接粘贴到微信群。所有角色可用。
     * 优先使用 navigator.clipboard.writeText，不支持时回退到 execCommand('copy')。
     * @param {string} date - 日期 YYYY-MM-DD
     */
    function copyInspectionSummary(date){
        var sum=getDailySummary(date, currentUser.id) || computeInspectionSummary(date, currentUser);
        var floorNums=(sum.floors||[]).map(function(fid){ var f=getFloorById(fid); return f?f.sortOrder:fid; }).sort(function(a,b){return a-b;});
        // 日期标题：9月9号（周三晚）
        var title;
        try{
            var parts=String(date).split('-');
            var d=new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10));
            var week='日一二三四五六'.charAt(d.getDay());
            title=(d.getMonth()+1)+'月'+d.getDate()+'号（周'+week+'晚）';
        }catch(e){ title=date; }
        var building=sum.buildingName || '本楼';
        var teacher=sum.confirmedByName || (currentUser?currentUser.realName:'') || '';
        var sep='————————————';
        // 统计数字（对齐空格，与微信排版习惯一致）
        var pad=function(s){ while(s.length<6) s='\u3000'+s; return s; };
        var lines=[];
        lines.push(title);
        lines.push(building+'：'+floorNums.join('、')+'楼');
        lines.push('值班老师：'+teacher);
        lines.push(sep);
        lines.push('入宿人数：'+sum.totalStudents+'人');
        lines.push('当天请假：'+sum.absenceCount+'人');
        lines.push('退  宿  中：'+sum.leavePendingCount+'人');
        lines.push('家长接走：'+sum.pickedUpCount+'人');
        lines.push('无  假  条：'+sum.anomalyCount+'人');
        lines.push('实到人数：'+sum.actualCount+'人');
        // 学生详情
        function detailBlock(title, list, extraKey){
            lines.push('');
            lines.push(title+'：'+list.length+'人');
            lines.push('【学生具体信息】');
            if(list.length===0){ lines.push('（暂无）'); return; }
            list.forEach(function(r){
                var info=(r.name||'')+'（'+(r.className||'-')+'） 床号：'+(r.bed||'-');
                if(extraKey && r[extraKey]) info += '（'+r[extraKey]+'）';
                lines.push(info);
            });
        }
        detailBlock('退宿中', sum.leavePendingDetails||[]);
        detailBlock('家长接走', sum.pickedUpDetails||[], 'confirmedBy');
        detailBlock('无假条', sum.anomalyDetails||[], 'reportedBy');
        var text=lines.join('\n');
        // 复制
        if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(text).then(function(){
                toast('总结已复制，可直接粘贴到微信群');
            }).catch(function(){
                fallbackCopy(text);
            });
        }else{
            fallbackCopy(text);
        }
    }
    /** execCommand 回退复制 */
    function fallbackCopy(text){
        try{
            var ta=document.createElement('textarea');
            ta.value=text; ta.style.position='fixed'; ta.style.left='-9999px';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            toast('总结已复制，可直接粘贴到微信群');
        }catch(e){
            toast('复制失败，请手动选择文本复制','error');
        }
    }

    // ==================== 账号管理（仅管理员） ====================
    /**
     * 打开账号新增/编辑模态框（userId 为 0/空=新增）。
     * 编辑时用户名与角色只读（角色不可变更），密码留空表示不修改。
     * @param {number} userId - 用户 ID；0 表示新增
     */
    function openAccountModal(userId){
        if(!isAdmin()){ toast('无权限','error'); return; }
        var u=userId ? DB.users.find(function(x){ return String(x.id)===String(userId); }) : null;
        var isEdit=!!u;
        u=u || { id:0, username:'', realName:'', role:'STAFF', assignedFloors:[], buildingName:'' };
        // 时段规则默认值（新建账号默认启用）
        var enableTimeLimit = (typeof u.enableTimeLimit === 'boolean') ? u.enableTimeLimit : true;
        var hyStartHour = (typeof u.hygieneStartHour === 'number') ? u.hygieneStartHour : 5;
        var hyEndHour = (typeof u.hygieneEndHour === 'number') ? u.hygieneEndHour : 15;
        var roleOpts=[['STAFF','生活老师'],['CLASS_ADMIN','班主任'],['ADMIN','管理员']].map(function(r){
            return '<option value="'+r[0]+'" '+(u.role===r[0]?'selected':'')+'>'+r[1]+'</option>';
        }).join('');
        var floorChecks=DB.floors.map(function(f){
            var checked=(u.assignedFloors||[]).indexOf(f.id)!==-1 ? 'checked' : '';
            return '<label style="display:inline-flex;align-items:center;gap:4px;margin:4px 10px 4px 0;font-weight:500"><input type="checkbox" class="acct-floor-check" value="'+f.id+'" '+checked+'> '+f.name+'</label>';
        }).join('');
        var html='<div class="em-header"><span>'+(isEdit?'✏️ 编辑账号':'➕ 新增账号')+'</span><button class="em-close" aria-label="关闭" onclick="closeAccountModal()">✕</button></div>'
            +'<div class="em-body">'
            +'<input type="hidden" id="acctEditId" value="'+(isEdit?u.id:0)+'">'
            +'<div class="form-group"><label>用户名 *</label><input type="text" id="acctUsername" value="'+escapeHtmlAttr(u.username)+'" '+(isEdit?'readonly style="background:var(--gray-100)"':'')+' placeholder="登录用户名（班主任账号通常与班级同名，如 三1）"></div>'
            +'<div class="form-group"><label>姓名 *</label><input type="text" id="acctRealName" value="'+escapeHtmlAttr(u.realName||'')+'"></div>'
            +'<div class="form-group"><label>'+(isEdit?'新密码（留空则不修改）':'初始密码')+'</label><input type="text" id="acctPassword" placeholder="'+(isEdit?'留空保持原密码':'留空默认 123456')+'"></div>'
            +'<div class="form-group"><label>角色</label><select id="acctRole" '+(isEdit?'disabled style="background:var(--gray-100)"':'')+'>'+roleOpts+'</select></div>'
            +'<div class="form-group"><label>楼栋名称（生活老师）</label><input type="text" id="acctBuilding" value="'+escapeHtmlAttr(u.buildingName||'')+'" placeholder="如：恩泽楼"></div>'
            +'<div class="form-group"><label>负责楼层（仅生活老师生效，不勾选=全部楼层）</label><div class="checkbox-group">'+floorChecks+'</div></div>'
            +'<div style="border-top:1px dashed var(--gray-200);margin:12px 0;padding-top:12px"></div>'
            +'<div class="form-group"><label style="font-weight:700">⏰ 时段限制（生活老师）</label>'
            +'<label style="display:inline-flex;align-items:center;gap:4px;margin-bottom:8px;font-weight:500"><input type="checkbox" id="acctEnableTimeLimit" '+(enableTimeLimit?'checked':'')+'> 启用时段限制</label>'
            +'<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
            +'<span>卫生时段：</span>'
            +'<select id="acctHyStartHour" style="width:80px">'+Array.from({length:24},function(_,i){return '<option value="'+i+'" '+(hyStartHour===i?'selected':'')+'>'+String(i).padStart(2,'0')+':00</option>';}).join('')+'</select>'
            +'<span>至</span>'
            +'<select id="acctHyEndHour" style="width:80px">'+Array.from({length:24},function(_,i){return '<option value="'+i+'" '+(hyEndHour===i?'selected':'')+'>'+String(i).padStart(2,'0')+':00</option>';}).join('')+'</select>'
            +'</div>'
            +'<p style="color:var(--gray-500);font-size:0.8571rem;margin-top:6px">卫生时段内只显示卫生加/扣分，时段外只显示纪律加/扣分。管理员不受限制。</p>'
            +'</div>'
            +(isEdit?'<p style="color:var(--gray-500);font-size:0.8571rem">账号角色不可修改；如需变更角色请新建账号。</p>':'')
            +'</div>'
            +'<div class="em-footer"><button class="btn btn-primary" onclick="saveAccount()">💾 保存</button><button class="btn btn-outline" onclick="closeAccountModal()">取消</button></div>';
        document.getElementById('accountModalBox').innerHTML=html;
        document.getElementById('accountModal').classList.add('show');
    }
    /** 关闭账号编辑模态框 */
    function closeAccountModal(){
        var m=document.getElementById('accountModal');
        if(m) m.classList.remove('show');
    }
    /** 保存账号（入口，safeAsync 统一捕获哈希/落库异常） */
    function saveAccount(){
        safeAsync(saveAccountImpl, '保存账号', { retry: true });
    }
    /**
     * 保存账号实际逻辑：
     *  - 编辑模式（acctEditId>0）：按 id 定位账号，更新姓名/楼栋/楼层/可选新密码；
     *  - 新增模式：强制查重，用户名已存在则提示并中止（杜绝同名重复账号再次产生），
     *    否则新建（密码留空默认 123456，哈希后落库）；写 user 行并标脏，saveDB 同步。
     * @returns {Promise}
     */
    function saveAccountImpl(){
        var editId=parseInt((document.getElementById('acctEditId')||{}).value, 10) || 0;
        var username=String(document.getElementById('acctUsername').value||'').trim();
        var realName=String(document.getElementById('acctRealName').value||'').trim();
        var password=String(document.getElementById('acctPassword').value||'');
        var role=document.getElementById('acctRole').value;
        var buildingName=String(document.getElementById('acctBuilding').value||'').trim();
        var floors=[];
        document.querySelectorAll('.acct-floor-check:checked').forEach(function(cb){ floors.push(parseInt(cb.value,10)); });
        // 时段规则
        var enableTimeLimit = document.getElementById('acctEnableTimeLimit');
        enableTimeLimit = enableTimeLimit ? enableTimeLimit.checked : true;
        var hyStartHourEl = document.getElementById('acctHyStartHour');
        var hyEndHourEl = document.getElementById('acctHyEndHour');
        var hyStartHour = hyStartHourEl ? parseInt(hyStartHourEl.value,10) : 5;
        var hyEndHour = hyEndHourEl ? parseInt(hyEndHourEl.value,10) : 15;
        if(!username || !realName){ toast('请填写用户名和姓名','error'); return Promise.resolve(); }
        // 编辑模式按 id 定位（用户名只读）；新增模式 target 必须为空
        var target = editId ? DB.users.find(function(u){ return String(u.id)===String(editId); }) : null;
        if(editId && !target){ toast('账号不存在或已被删除','error'); return Promise.resolve(); }
        // 新增强制查重：同名账号已存在则中止（防跨设备重复账号的根源之一）
        if(!target && DB.users.some(function(u){ return u.username===username; })){
            toast('用户名已存在','error');
            return Promise.resolve();
        }
        function finishSave(){
            saveDB();
            closeAccountModal();
            toast('账号已保存');
            if(currentView==='export') renderExportView(document.getElementById('contentArea'));
        }
        if(target){
            // 编辑现有账号
            target.realName=realName;
            target.buildingName=buildingName;
            target.assignedFloors=(target.role==='STAFF') ? floors : [];
            if(target.role==='STAFF'){
                target.enableTimeLimit=enableTimeLimit;
                target.hygieneStartHour=hyStartHour;
                target.hygieneEndHour=hyEndHour;
            }
            target.lastModified=Date.now();
            v3MarkDirty('user', target.id);
            if(password){
                return hashPassword(password).then(function(h){
                    target.passwordHash=h;
                    target.lastModified=Date.now();
                    v3MarkDirty('user', target.id);
                    finishSave();
                });
            }
            finishSave();
            return Promise.resolve();
        }
        // 新建账号
        if(!role){ toast('请选择角色','error'); return Promise.resolve(); }
        var pwd=password || '123456';
        var nowTs=Date.now();
        return hashPassword(pwd).then(function(h){
            var nu={
                id: DB.nextIds.user++,
                username: username,
                passwordHash: h,
                realName: realName,
                role: role,
                buildingName: buildingName,
                assignedFloors: (role==='STAFF') ? floors : [],
                enableTimeLimit: (role==='STAFF') ? enableTimeLimit : undefined,
                hygieneStartHour: (role==='STAFF') ? hyStartHour : undefined,
                hygieneEndHour: (role==='STAFF') ? hyEndHour : undefined,
                createdAt: nowTs, lastModified: nowTs
            };
            if(role==='CLASS_ADMIN') nu.className=username; // 班主任账号按用户名（班级名）隔离数据
            DB.users.push(nu);
            v3MarkDirty('user', nu.id);
            finishSave();
        });
    }
    /**
     * 删除账号（二次确认）：内置 admin/staff 与当前登录账号不可删除；
     * 删除打 user 墓碑并 saveDB 同步。
     * @param {number} id - 用户 ID
     */
    function deleteUser(id){
        if(!isAdmin()){ toast('无权限','error'); return; }
        var u=DB.users.find(function(x){ return String(x.id)===String(id); });
        if(!u){ toast('账号不存在','error'); return; }
        if(String(u.id)===String(currentUser.id)){ toast('不可删除当前登录账号','error'); return; }
        if(u.username==='admin' || u.username==='staff'){ toast('内置账号不可删除','error'); return; }
        if(!confirm('确认删除账号「'+u.username+'（'+(u.realName||'')+'）」？')) return;
        DB.users=DB.users.filter(function(x){ return String(x.id)!==String(id); });
        v3MarkDeleted('user', id);
        saveDB();
        toast('账号已删除');
        renderExportView(document.getElementById('contentArea'));
    }
    /**
     * 一键重置账号密码为 123456（confirm 确认，异步哈希后落库标脏）。
     * @param {number} id - 用户 ID
     */
    function resetUserPassword(id){
        if(!isAdmin()){ toast('无权限','error'); return; }
        var u=DB.users.find(function(x){ return String(x.id)===String(id); });
        if(!u){ toast('账号不存在','error'); return; }
        if(!confirm('确认将「'+u.username+'」的密码重置为 123456？')) return;
        hashPassword('123456').then(function(h){
            u.passwordHash=h;
            u.lastModified=Date.now();
            v3MarkDirty('user', u.id);
            saveDB();
            toast('密码已重置为 123456');
        });
    }

    // ==================== 账号批量删除（仅管理员） ====================
    /**
     * 全选/取消全选账号复选框（跳过禁用的内置/当前登录账号）。
     * @param {boolean} checked - 是否全选
     */
    function toggleAllUsers(checked){
        document.querySelectorAll('.acct-check').forEach(function(cb){
            if(!cb.disabled) cb.checked=checked;
        });
    }
    /**
     * 批量删除勾选的账号：二次确认后逐个移除并打 V3 墓碑。
     * 双保险：即使复选框被绕过，内置 admin/staff 与当前登录账号也会被过滤掉。
     */
    function deleteSelectedUsers(){
        if(!isAdmin()){ toast('无权限','error'); return; }
        var ids=Array.from(document.querySelectorAll('.acct-check:checked')).map(function(cb){ return cb.getAttribute('data-user-id'); });
        if(ids.length===0){ toast('请先勾选要删除的账号','error'); return; }
        var removable=[], skipped=0;
        ids.forEach(function(id){
            var u=DB.users.find(function(x){ return String(x.id)===String(id); });
            if(!u) return;
            if(u.username==='admin' || u.username==='staff' || String(u.id)===String(currentUser.id)){ skipped++; return; }
            removable.push(u);
        });
        if(removable.length===0){ toast('所选账号均不可删除（内置账号/当前登录账号）','error'); return; }
        var msg='确认删除选中的 '+removable.length+' 个账号？此操作不可撤销';
        if(skipped>0) msg+='（另有 '+skipped+' 个内置/当前登录账号将被跳过）';
        if(!confirm(msg)) return;
        removable.forEach(function(u){
            DB.users=DB.users.filter(function(x){ return String(x.id)!==String(u.id); });
            v3MarkDeleted('user', u.id);
        });
        saveDB();
        toast('已删除 '+removable.length+' 个账号');
        renderExportView(document.getElementById('contentArea'));
    }

    // ==================== 账号批量导入（仅管理员，文本 + Excel 两种方式） ====================
    var batchUserState={ tab:'text', file:null, text:'' };  // 当前 Tab / 已选 Excel 文件 / 文本草稿（切 Tab 保留）
    /**
     * 打开批量新增账号模态框（Tab：文本导入 / Excel 导入）。
     */
    function openBatchUserModal(){
        if(!isAdmin()){ toast('无权限','error'); return; }
        batchUserState.tab='text';
        batchUserState.file=null;
        batchUserState.text='';
        document.getElementById('batchUserModalBox').innerHTML=buildBatchUserModalHtml();
        document.getElementById('batchUserModal').classList.add('show');
    }
    /** 关闭批量新增账号模态框 */
    function closeBatchUserModal(){
        var m=document.getElementById('batchUserModal');
        if(m) m.classList.remove('show');
    }
    /**
     * 拼装批量导入模态框内容（按当前 Tab 渲染文本框或文件选择）。
     * @returns {string}
     */
    function buildBatchUserModalHtml(){
        var t=batchUserState.tab;
        var tabs='<div class="batch-tab-bar">'
            +'<div class="batch-tab'+(t==='text'?' active':'')+'" onclick="switchBatchUserTab(\'text\')">📋 文本导入</div>'
            +'<div class="batch-tab'+(t==='excel'?' active':'')+'" onclick="switchBatchUserTab(\'excel\')">📂 Excel导入</div>'
            +'</div>';
        var body;
        if(t==='text'){
            body='<div class="batch-hint">每行一个账号，格式：<b>用户名,姓名,密码,角色,负责楼层（生活老师）或 班级（班主任）</b><br>'
                +'示例：<br>staff1,张老师,123456,STAFF,1,2,3<br>san5,三5班,123456,CLASS_ADMIN,三5<br>'
                +'角色支持：STAFF（生活老师）/ CLASS_ADMIN（班主任）/ ADMIN（管理员）</div>'
                +'<textarea id="batchUserText" rows="9" style="width:100%;padding:10px;border:1.5px solid var(--gray-200);border-radius:8px;font-size:0.9286rem" placeholder="staff1,张老师,123456,STAFF,1,2,3&#10;san5,三5班,123456,CLASS_ADMIN,三5"></textarea>';
        }else{
            body='<div class="batch-hint">请选择 Excel 文件（.xlsx / .xls），第一行表头自动跳过。<br>'
                +'列顺序：<b>用户名 | 姓名 | 密码 | 角色 | 负责楼层 | 班级（可选）</b><br>'
                +'负责楼层为多楼层逗号分隔（如 1,2,3，仅生活老师）；班级为班主任账号填写（如 三5）。</div>'
                +'<div style="margin-bottom:10px"><span class="file-upload-wrapper"><span class="file-upload-btn">📂 选择Excel文件</span><input type="file" id="batchUserExcel" accept=".xlsx,.xls" onchange="onBatchUserExcelChange(this.files[0])"></span>'
                +'<span id="batchUserFileName" style="margin-left:8px;color:var(--gray-600);font-size:0.8571rem">'+(batchUserState.file?escapeHtmlAttr(batchUserState.file.name):'未选择文件')+'</span></div>'
                +'<button class="btn btn-outline btn-sm" onclick="downloadUserImportTemplate()">📥 下载导入模板</button>';
        }
        return '<div class="em-header"><span>📥 批量新增账号</span><button class="em-close" aria-label="关闭" onclick="closeBatchUserModal()">✕</button></div>'
            +tabs
            +'<div class="em-body">'+body+'</div>'
            +'<div class="em-footer"><button class="btn btn-primary" onclick="submitBatchUsers()">✅ 确认导入</button><button class="btn btn-outline" onclick="closeBatchUserModal()">取消</button></div>';
    }
    /**
     * 切换导入方式 Tab（保留文本草稿，避免误切换丢内容）。
     * @param {string} tab - 'text' | 'excel'
     */
    function switchBatchUserTab(tab){
        var textEl=document.getElementById('batchUserText');
        if(textEl) batchUserState.text=textEl.value;
        batchUserState.tab=(tab==='excel')?'excel':'text';
        document.getElementById('batchUserModalBox').innerHTML=buildBatchUserModalHtml();
        var ta=document.getElementById('batchUserText');
        if(ta && batchUserState.text) ta.value=batchUserState.text;
    }
    /** Excel 文件选择回调：记录文件并显示文件名 */
    function onBatchUserExcelChange(file){
        if(!file) return;
        batchUserState.file=file;
        var el=document.getElementById('batchUserFileName');
        if(el) el.textContent='已选择：'+file.name;
    }
    /** 批量导入入口：按当前 Tab 分发（Excel 走 safeAsync，可重试） */
    function submitBatchUsers(){
        if(!isAdmin()){ toast('无权限','error'); return; }
        if(batchUserState.tab==='text'){
            safeAsync(submitBatchUsersFromText, '批量导入账号（文本）', { retry: true });
        }else{
            if(!batchUserState.file){ toast('请先选择 Excel 文件','error'); return; }
            safeAsync(function(){ return submitBatchUsersFromExcelImpl(batchUserState.file); }, '批量导入账号（Excel）', { retry: true });
        }
    }
    /**
     * 解析并校验单行账号数据：必填字段齐全、角色合法；楼层/班级按角色解析。
     * @param {string[]} fields - [username, realName, password, role, floors|class]
     * @returns {{user?:object, error?:string}}
     */
    function parseBatchUserFields(fields){
        var username=String(fields[0]||'').trim();
        var realName=String(fields[1]||'').trim();
        var password=String(fields[2]||'').trim();
        var role=String(fields[3]||'').trim().toUpperCase();
        if(!username || !realName || !password || !role) return { error:'缺少必填字段（用户名/姓名/密码/角色）' };
        if(['STAFF','CLASS_ADMIN','ADMIN'].indexOf(role)===-1) return { error:'角色非法：'+role };
        var floors=[];
        var className='';
        if(role==='STAFF'){
            // 第 5 列起为楼层编号（文本可多列，Excel 为一列逗号分隔），无效编号自动忽略
            var floorStrs=(fields.length>4?fields.slice(4):[]).join(',').split(',');
            floors=floorStrs.map(function(x){ return parseInt(String(x).trim(),10); })
                .filter(function(fid){ return fid && getFloorById(fid); });
        }else if(role==='CLASS_ADMIN'){
            className=String(fields[4]||'').trim() || username; // 班主任班级名缺省用用户名
        }
        return { user:{ username:username, realName:realName, password:password, role:role, floors:floors, className:className } };
    }
    /** 文本导入：按行解析 → 查重 → 哈希 → 建号，toast 汇总结果 */
    function submitBatchUsersFromText(){
        var ta=document.getElementById('batchUserText');
        var raw=ta?String(ta.value||''):'';
        if(!raw.trim()){ toast('请先粘贴账号文本','error'); return Promise.resolve(); }
        var parsed=[], failed=0, failMsgs=[];
        raw.split(/\r?\n/).forEach(function(line, i){
            var s=line.trim();
            if(!s) return; // 空行跳过
            var r=parseBatchUserFields(s.split(',').map(function(p){ return p.trim(); }));
            if(r.error){ failed++; failMsgs.push('第'+(i+1)+'行：'+r.error); return; }
            parsed.push(r.user);
        });
        return createBatchUsers(parsed).then(function(dupCount){
            finishBatchImport(parsed.length, dupCount, failed, failMsgs);
        });
    }
    /** Excel 导入：XLSX 解析（首行表头跳过）→ 查重 → 哈希 → 建号，toast 汇总结果 */
    function submitBatchUsersFromExcelImpl(file){
        return new Promise(function(resolve){
            var reader=new FileReader();
            reader.onerror=function(){ handleError(reader.error || new Error('文件读取失败'), '批量导入账号（Excel）'); resolve(); };
            reader.onload=function(e){
                try{
                    var data=new Uint8Array(e.target.result);
                    var workbook=XLSX.read(data, { type:'array' });
                    var firstSheet=workbook.Sheets[workbook.SheetNames[0]];
                    var rows=XLSX.utils.sheet_to_json(firstSheet, { header:1 });
                    var parsed=[], failed=0, failMsgs=[];
                    rows.forEach(function(row, i){
                        if(i===0) return; // 首行表头跳过
                        var cells=(row||[]).map(function(c){ return (c==null?'':String(c)).trim(); });
                        if(cells.every(function(c){ return !c; })) return; // 空行跳过
                        if(cells[0]==='用户名') return; // 无表头声明时的兜底：仍按表头行跳过
                        var r=parseBatchUserFields(cells);
                        if(r.error){ failed++; failMsgs.push('第'+(i+1)+'行：'+r.error); return; }
                        parsed.push(r.user);
                    });
                    createBatchUsers(parsed).then(function(dupCount){
                        finishBatchImport(parsed.length, dupCount, failed, failMsgs);
                        resolve();
                    });
                }catch(err){
                    handleError(err, '批量导入账号（Excel解析）', { silent: true });
                    toast('Excel解析失败，请检查文件格式','error');
                    resolve();
                }
            };
            reader.readAsArrayBuffer(file);
        });
    }
    /**
     * 批量创建账号：过滤与 DB / 批内重复的用户名，密码按明文去重后统一哈希，
     * 逐个落库并标脏（纳入 V3 同步），最后 saveDB。
     * @param {Array<{username,realName,password,role,floors,className}>} list - 校验通过的账号
     * @returns {Promise<number>} 跳过的重复账号数
     */
    function createBatchUsers(list){
        var dupCount=0;
        var seen={};
        var unique=list.filter(function(r){
            if(seen[r.username] || DB.users.some(function(u){ return u.username===r.username; })){ dupCount++; return false; }
            seen[r.username]=true;
            return true;
        });
        if(unique.length===0) return Promise.resolve(dupCount);
        // 相同明文密码只哈希一次
        var pwdHash={}, jobs=[];
        unique.forEach(function(r){
            if(!pwdHash[r.password]) jobs.push(hashPassword(r.password).then(function(h){ pwdHash[r.password]=h; }));
        });
        return Promise.all(jobs).then(function(){
            var nowTs=Date.now();
            unique.forEach(function(r){
                var nu={
                    id: DB.nextIds.user++,
                    username: r.username,
                    passwordHash: pwdHash[r.password],
                    realName: r.realName,
                    role: r.role,
                    buildingName: '',
                    assignedFloors: (r.role==='STAFF') ? r.floors.slice() : [],
                    enableTimeLimit: (r.role==='STAFF') ? true : undefined,
                    createdAt: nowTs, lastModified: nowTs
                };
                if(r.role==='CLASS_ADMIN') nu.className=r.className || r.username;
                DB.users.push(nu);
                v3MarkDirty('user', nu.id);
            });
            saveDB();
            return dupCount;
        });
    }
    /** 批量导入收尾：关闭模态框、刷新账号列表、toast 汇总（失败明细输出控制台） */
    function finishBatchImport(valid, dupCount, failed, failMsgs){
        closeBatchUserModal();
        renderExportView(document.getElementById('contentArea'));
        var imported=valid-dupCount;
        if(failMsgs.length>0) console.warn('[批量导入账号] 失败明细：', failMsgs.join('；'));
        if(imported===0 && dupCount===0 && failed===0){ toast('没有可导入的账号','error'); return; }
        toast('成功导入 '+imported+' 个账号，跳过重复 '+dupCount+' 个，失败 '+failed+' 个', (failed>0?'error':''));
        if(failed>0) toast('失败原因已记录到控制台（F12 查看）','error');
    }
    /** 下载账号导入 Excel 模板（表头 + 两行示例，XLSX 生成） */
    function downloadUserImportTemplate(){
        if(!window.XLSX){ toast('Excel 组件未加载','error'); return; }
        var wb=XLSX.utils.book_new();
        var aoa=[
            ['用户名','姓名','密码','角色','负责楼层','班级'],
            ['staff1','张老师','123456','STAFF','1,2,3',''],
            ['san5','三5班','123456','CLASS_ADMIN','','三5']
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '账号导入模板');
        XLSX.writeFile(wb, '账号导入模板.xlsx');
    }
    /**
     * 保存楼层分工配置（楼层分配管理卡片）：更新所选生活老师的
     * assignedFloors（空数组=全部楼层）与 buildingName，标脏落库后局部刷新卡片。
     */
    function saveFloorAssign(){
        if(!isAdmin()){ toast('无权限','error'); return; }
        var sel=document.getElementById('assignStaffSelect');
        var uid=sel ? parseInt(sel.value,10) : (typeof floorAssignState!=='undefined'?floorAssignState.staffId:null);
        var u=DB.users.find(function(x){ return String(x.id)===String(uid); });
        if(!u){ toast('请选择生活老师','error'); return; }
        var buildingName=String((document.getElementById('assignBuildingName')||{}).value||'').trim();
        var floors=[];
        document.querySelectorAll('.assign-floor-check:checked').forEach(function(cb){ floors.push(parseInt(cb.value,10)); });
        u.assignedFloors=floors; // 空数组=负责全部楼层
        u.buildingName=buildingName;
        u.lastModified=Date.now();
        v3MarkDirty('user', u.id);
        saveDB();
        toast('分工已保存：'+u.username+' → '+(floors.length?floors.slice().sort(function(a,b){return a-b;}).join('、')+'楼':'全部楼层'));
        var box=document.getElementById('floorAssignBody');
        if(box) box.innerHTML=buildFloorAssignHtml();
    }

    // ==================== 初始化 ====================
    document.addEventListener('DOMContentLoaded', function(){
        // 登录框支持回车提交
        document.getElementById('loginUsername').addEventListener('keydown', function(e){ if(e.key==='Enter') handleLogin(); });
        document.getElementById('loginPassword').addEventListener('keydown', function(e){ if(e.key==='Enter') handleLogin(); });
        initializeData().then(function(){
            document.getElementById('loadingOverlay').style.display='none';
            // 会话恢复（checkSavedLogin）已进入主应用时，不再显示登录页
            if(!currentUser) document.getElementById('loginPage').style.display='flex';
        }).catch(function(e){
            console.error('初始化失败:', e);
            document.getElementById('loadingOverlay').style.display='none';
            if(!currentUser) document.getElementById('loginPage').style.display='flex';
        });
    });

    // ==================== 网络状态提示 ====================
    // 断网/恢复均给出即时反馈（数据同步的自动重试由 sync.js 的 online 监听另行处理）
    window.addEventListener('online', function(){
        toast('网络已恢复');
    });
    window.addEventListener('offline', function(){
        toast('当前网络已断开，部分功能（云端同步）可能受限，本地记录不受影响', 'error');
    });
    // 页面加载时本就离线（如直接以离线状态打开 PWA）：待 DOM 就绪后提示一次
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        window.addEventListener('load', function(){
            toast('当前网络已断开，部分功能（云端同步）可能受限，本地记录不受影响', 'error');
        });
    }

    // ==================== PWA: Service Worker 注册 ====================
    // 独立代码块，不嵌套在应用 DOMContentLoaded 中，避免影响初始化
    if ('serviceWorker' in navigator) {
        // 记录注册前是否已被 SW 控制：首次安装 claim 导致的 controllerchange 不提示，
        // 仅"旧版本→新版本"的切换才提示用户刷新
        var swHadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener('controllerchange', function(){
            if (swHadController) {
                toast('新版本已就绪，请刷新页面以应用更新');
            }
            swHadController = true;
        });
        window.addEventListener('load', function() {
            navigator.serviceWorker.register('./sw.js')
                .then(function(reg) {
                    console.log('✅ Service Worker 注册成功', reg.scope);
                    // 版本更新时自动激活新 SW
                    if (reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
                    reg.addEventListener('updatefound', function() {
                        var installing = reg.installing;
                        installing.addEventListener('statechange', function() {
                            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                                installing.postMessage({type:'SKIP_WAITING'});
                            }
                        });
                    });
                })
                .catch(function(err) {
                    console.warn('⚠️ Service Worker 注册失败（仅影响离线能力）:', err.message);
                });
        });
    }


// ---- shared globals explicitly mounted on window ----
window.currentUser = currentUser;
window.currentView = currentView;
window.selectedFloorId = selectedFloorId;
window.selectedDormitoryId = selectedDormitoryId;
window.viewHistory = viewHistory;
window.studentSearch = studentSearch;
window.addFormState = addFormState;
window.editRecordId = editRecordId;
window.transferStudentId = transferStudentId;
window.foldState = foldState;
window.statsCache = statsCache;
window.statsDormExpandAll = statsDormExpandAll;
window.statsFloorPickId = statsFloorPickId;
window.lastMobileState = lastMobileState;
