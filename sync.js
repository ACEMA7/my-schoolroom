/* ============================================================
 * sync.js —— 云端同步层（Supabase）
 * ------------------------------------------------------------
 * 职责：
 *   1. 创建/持有 Supabase 客户端（supabaseClient）与同步开关（syncEnabled）；
 *   2. V3「按行存储」同步：本地脏记录/墓碑增量上行（syncToCloudV3）、
 *      云端全量拉取并按类型合并（loadFromCloudV3）、V2→V3 结构迁移
 *      （detectV3Schema / migrateOldFormatToRows）；
 *   3. 同步状态指示与断网指数退避自动重试（syncWithRetry）；
 *   4. 应用数据初始化总入口（initializeData）、统一保存入口（saveDB）、
 *      手动同步（manualSync）、管理员重置云端（resetCloudData）；
 *   5. 兼容 V2 旧版整库压缩格式的解码（decodeCloudData）。
 *
 * 核心概念：
 *   - 脏标记（dirty）：本地新增/修改的记录，见 data.js 的 v3MarkDirty；
 *   - 墓碑（deleted）：本地删除的记录，上行 deleted=true，其他设备拉取后删除；
 *   - epoch（数据版本号）：管理员"重置云端"时递增，所有设备检测到 epoch
 *     变化即整体丢弃本地、以下发数据为准重建，防止旧数据回灌；
 *   - 基础数据（floor/dormitory/student/user/deduction_item/meta）云端为权威；
 *     业务记录（deduction/leave/absence）多设备并发，按 updated_at 最新者胜。
 *
 * 主要依赖：config.js（SUPABASE_CONFIG/V3_* 常量）、data.js（DB、v3MarkDirty
 *   等全部数据函数）、ui.js（toast/handleError）、app.js（currentUser/
 *   selectedDormitoryId/renderTree/renderView）、window.supabase（supabase-js）。
 *
 * 对外暴露：文件末尾挂载 window.supabaseClient / window._retryState
 *   （对象引用，便于外部访问）；另在 initializeData 中 DB 就绪后挂载
 *   window.DB，确保始终指向最新数据库实例。函数声明为全局，常用：
 *   initializeData / saveDB / manualSync / resetCloudData / syncWithRetry /
 *   loadFromCloud / syncToCloud。
 * ============================================================ */

    var supabaseClient = null;   // Supabase 客户端实例（initializeData 中创建）
    var syncEnabled = false;     // 云端同步是否启用（配置开启且 URL 有效时为 true）

    /**
     * 探测云端 sync_store 表的结构版本（结果缓存到 _detectedSchemaVersion）。
     * 尝试查询 V3 专属字段 record_type：成功 → V3（按行存储）；查询报错 →
     * V2（旧版整库压缩）。同步策略据此分流。
     * @returns {Promise<number>} 3 = V3 按行存储；2 = V2 整库压缩
     */
    function detectV3Schema(){
        if(!supabaseClient) return Promise.resolve(2);
        if(_detectedSchemaVersion === 3) return Promise.resolve(3);
        // 用 try-catch 查询新字段，成功则 V3，失败则 V2
        return supabaseClient.from('sync_store').select('id,record_type,record_id').limit(1).then(function(res){
            if(res.error){
                // 列不存在或其他错误 → 旧结构
                console.log('[V3] 检测到旧表结构，使用 V2 同步：', res.error.message);
                _detectedSchemaVersion = 2;
                return 2;
            }
            console.log('[V3] 检测到 V3 按行存储表结构');
            _detectedSchemaVersion = 3;
            return 3;
        }).catch(function(){
            _detectedSchemaVersion = 2;
            return 2;
        });
    }

    // 批量 upsert 上传：每批 V3_UPSERT_CHUNK 行，最多 V3_UPLOAD_CONCURRENCY 批并发。
    // 依赖 sync_store 表 UNIQUE (record_type, record_id)：新行插入、已存在行整行更新
    // （墓碑行 deleted=true 也通过 upsert 直接写回，不再需要先 DELETE 再 INSERT）。
    // 任一批失败即整体失败（不降级逐条，避免掩盖问题），脏标记保留由上层重试。
    var V3_UPLOAD_CONCURRENCY = 3;
    /**
     * 将上行行数组按 V3_UPSERT_CHUNK 分批，用多个并发 worker 依次 upsert。
     * 任一批次失败即整体返回 false（调用方保留脏标记、加入重试队列，不丢数据）。
     * @param {Array} rows - v3BuildUpsertRow 构造的 sync_store 行数组
     * @returns {Promise<boolean>} true=全部批次上传成功
     */
    function v3UploadRows(rows){
        if(!supabaseClient || !rows || rows.length === 0) return Promise.resolve(true);
        var batches = [];
        for(var i = 0; i < rows.length; i += V3_UPSERT_CHUNK){
            batches.push(rows.slice(i, i + V3_UPSERT_CHUNK));
        }
        var nextBatch = 0;
        function worker(){
            if(nextBatch >= batches.length) return Promise.resolve(true);
            var idx = nextBatch++;
            var batch = batches[idx];
            var t0 = Date.now();
            return supabaseClient.from('sync_store')
                .upsert(batch, { onConflict: 'record_type,record_id' })
                .then(function(res){
                    if(res.error){
                        // 打印完整错误便于诊断（409 通常是 onConflict 参数/唯一约束问题）
                        console.error('[V3] 批次 ' + (idx+1) + '/' + batches.length + '（' + batch.length + ' 行）upsert 失败:',
                            res.error.code || '', res.error.message, res.error.hint || '', res.error.details || '');
                        return false;
                    }
                    console.log('[V3] 批次 ' + (idx+1) + '/' + batches.length + ' 上传成功（' + batch.length + ' 行，' + (Date.now()-t0) + 'ms）');
                    return worker(); // 该 worker 继续领取下一批
                })
                .catch(function(e){
                    console.error('[V3] 批次 ' + (idx+1) + ' 网络异常:', (e && e.message) ? e.message : e);
                    return false;
                });
        }
        var workers = [];
        for(var w = 0; w < Math.min(V3_UPLOAD_CONCURRENCY, batches.length); w++) workers.push(worker());
        return Promise.all(workers).then(function(results){
            return results.every(function(ok){ return ok; });
        });
    }

    /**
     * V3 增量上行：收集本地全部脏记录与墓碑行，批量 upsert 到 sync_store。
     * 流程：遍历 V3_RECORD_TYPES → 脏记录读当前数据构造 upsert 行（deleted=false）、
     * 墓碑构造 deleted=true 行 → v3UploadRows 批量上传 → 全部成功后清空脏/墓碑标记
     * 并落本地存档；无任何待传数据时仅更新 lastSyncTime。
     * @returns {Promise<boolean>} true=上传成功（或无待传数据）；false=存在失败批次（脏标记保留，待重试）
     */
    function syncToCloudV3(){
        if (!syncEnabled || !supabaseClient || !DB) return Promise.resolve(false);
        ensureSyncMeta();
        var rows = [];
        var nowIso = new Date().toISOString();
        var didAnything = false;
        var staleFilteredCount = 0;
        // 遍历所有记录类型，收集脏记录和删除标记
        V3_RECORD_TYPES.forEach(function(meta){
            // 【主控设备锁定·防污染】基础数据仅允许管理员的主控设备上传
            // 非管理员 或 非主控设备（管理员手机/家里电脑）一律拦截，清空脏标记后跳过
            if(V3_BASIC_TYPES.indexOf(meta.type) !== -1 && ((!currentUser || currentUser.role !== 'ADMIN') || DEVICE_ID !== MASTER_DEVICE_ID)){
                if(DB.dirtyByType) DB.dirtyByType[meta.type] = {};
                if(DB.deletedByType) DB.deletedByType[meta.type] = {};
                return; // 禁止非主控设备上传基础数据
            }
            var dirtySet = (DB.dirtyByType && DB.dirtyByType[meta.type]) || {};
            var deletedSet = (DB.deletedByType && DB.deletedByType[meta.type]) || {};
            var isMutable = V3_MUTABLE_TYPES.indexOf(meta.type) !== -1;
            // 1) 脏记录：从 DB 读取当前数据，构造 upsert 行
            Object.keys(dirtySet).forEach(function(rid){
                var rec = v3GetRecordById(meta.type, rid);
                if(!rec) return; // 记录不存在了（可能已被删除），交给 deleted 处理
                // 【终极过滤】业务记录：createdAt/lastModified 早于上次同步时间 = 历史遗留废弃数据，
                // 直接跳过不上传，并清除其脏标记，杜绝废弃数据污染云端。
                if(isMutable){
                    var recTime = rec.lastModified || rec.createdAt || 0;
                    if(recTime < (DB.lastSyncTime || 0)){
                        staleFilteredCount++;
                        delete DB.dirtyByType[meta.type][rid];
                        return;
                    }
                }
                didAnything = true;
                rows.push(v3BuildUpsertRow(meta.type, rid, rec, false, nowIso));
            });
            // 2) 删除标记：只对已存在的云端记录设置 deleted=true
            Object.keys(deletedSet).forEach(function(rid){
                didAnything = true;
                rows.push(v3BuildUpsertRow(meta.type, rid, null, true, nowIso));
            });
        });
        if(staleFilteredCount > 0){
            console.log('已过滤掉 ' + staleFilteredCount + ' 条陈旧废弃数据，未上传云端');
        }
        if(!didAnything){
            console.log('[V3] 无脏记录需要上传');
            DB.lastSyncTime = Date.now();
            return Promise.resolve(true);
        }
        // 批量 upsert 上传（依赖 UNIQUE(record_type,record_id)）：成功后清除脏标记由调用方处理
        return v3UploadRows(rows).then(function(ok){
            if(!ok) return false;
            // 上传成功：清除脏标记和删除标记
            V3_RECORD_TYPES.forEach(function(meta){
                if(DB.dirtyByType && DB.dirtyByType[meta.type]) DB.dirtyByType[meta.type] = {};
                if(DB.deletedByType && DB.deletedByType[meta.type]) DB.deletedByType[meta.type] = {};
            });
            DB.lastSyncTime = Date.now();
            saveDBToLocal();
            console.log('[V3] 上传成功，共 ' + rows.length + ' 行');
            return true;
        });
    }
    // 从 DB 获取指定类型的记录（支持 deductionItems 特殊处理）
    function v3GetRecordById(type, recordId){
        var meta = V3_RECORD_TYPES.find(function(m){ return m.type === type; });
        if(!meta || !DB) return null;
        var rid = String(recordId);
        if(meta.specialMeta){
            // meta 类型：固定 id 为 'main'
            if(rid === 'main') return { id: 'main', dormitoryList: DB.dormitoryList || [], nextIds: DB.nextIds || {}, epoch: DB.syncEpoch || 0 };
            return null;
        }
        if(meta.specialItems){
            // deductionItems：搜 hygiene / discipline / hygieneBonus / disciplineBonus，附带 _subType
            var hy = (DB.deductionItems&&DB.deductionItems.hygiene)||[];
            var dis = (DB.deductionItems&&DB.deductionItems.discipline)||[];
            var hyB = (DB.deductionItems&&DB.deductionItems.hygieneBonus)||[];
            var disB = (DB.deductionItems&&DB.deductionItems.disciplineBonus)||[];
            var found = hy.find(function(x){ return String(x.id) === rid; });
            if(found) return Object.assign({}, found, { _subType: 'hygiene' });
            found = dis.find(function(x){ return String(x.id) === rid; });
            if(found) return Object.assign({}, found, { _subType: 'discipline' });
            found = hyB.find(function(x){ return String(x.id) === rid; });
            if(found) return Object.assign({}, found, { _subType: 'hygieneBonus' });
            found = disB.find(function(x){ return String(x.id) === rid; });
            if(found) return Object.assign({}, found, { _subType: 'disciplineBonus' });
            return null;
        }
        var arr = DB[meta.dbPath[0]] || [];
        return arr.find(function(x){ return String(x[meta.idField]) === rid; }) || null;
    }
    // 构造 sync_store upsert 行
    // 注意：不含 id 字段——id 由数据库 BIGINT 序列（sync_store_id_seq）自动生成，
    // 冲突时按 UNIQUE(record_type,record_id) 整行更新，无需也不能手动指定主键
    function v3BuildUpsertRow(recordType, recordId, data, isDeleted, updatedAt){
        return {
            record_type: recordType,
            record_id: String(recordId),
            data: isDeleted ? {} : data,
            deleted: !!isDeleted,
            updated_at: updatedAt,
            device_id: DEVICE_ID
        };
    }

    /**
     * 溯源清洗·业务记录保留决策（纯函数，零副作用，可独立单元测试）。
     *
     * 判断一条业务记录（V3_MUTABLE_TYPES，如 deduction_record）在云端拉取合并时是否应保留。
     *
     * 规则（与 mergeArrayType 中业务记录分支完全一致）：
     *   1. 云端墓碑(inCloudTomb=true) 且 本地无脏标记 → 删除（返回 false）
     *   2. 云端不存在（无活行无墓碑）→ 仅当「有脏标记 且 createdAt > lastSyncTime」
     *      （离线期间新登记的正常行为）才保留（true），否则为历史废弃数据丢弃（false）
     *   3. 云端有活行 → 保留（true，交给后续 updated_at 合并逻辑处理）
     *
     * @param {object} r 本地记录对象（需含 id、createdAt 字段）
     * @param {object} dirtySet 该类型脏标记集合，形如 {rid: true}
     * @param {number} lastSyncTime DB.lastSyncTime 时间戳（毫秒）
     * @param {boolean} inCloudLive 该记录是否存在于云端活行
     * @param {boolean} inCloudTomb 该记录是否存在于云端墓碑
     * @returns {boolean} true=保留到 keptArr；false=丢弃并计入 result.removed
     */
    function v3ShouldKeepMutableRecord(r, dirtySet, lastSyncTime, inCloudLive, inCloudTomb){
        var rid = String(r.id);
        // 规则1：墓碑删除（本地有未上传修改时除外，由 dirtySet[rid] 保护）
        if(inCloudTomb && !dirtySet[rid]) return false;
        // 规则2：云端不存在 → 仅新登记（脏标记 + createdAt > lastSyncTime）保留
        if(!inCloudLive && !inCloudTomb){
            return !!(dirtySet[rid] && (r.createdAt || 0) > (lastSyncTime || 0));
        }
        // 规则3：云端有活行 → 保留
        return true;
    }

    /**
     * 分页全量拉取 sync_store 全部行（含 deleted=true 墓碑行）。
     * Supabase 单次查询最多返回 1000 行，按 id 升序用 range 翻页，
     * 直到某页不足 1000 行为止，确保超大数据量完整取回。
     * @returns {Promise<Array>} 全部 sync_store 行
     */
    function fetchAllRows(){
        if(!supabaseClient) return Promise.resolve([]);
        var PAGE = 1000;
        var all = [];
        function fetchPage(start){
            return supabaseClient.from('sync_store')
                .select('record_type,record_id,data,deleted,updated_at,device_id')
                .order('id', { ascending: true })
                .range(start, start + PAGE - 1)
                .then(function(res){
                    if(res.error){
                        console.error('[V3] 分页拉取失败（offset='+start+'）:', res.error.message);
                        throw res.error;
                    }
                    var rows = res.data || [];
                    all = all.concat(rows);
                    if(rows.length < PAGE) return all;
                    return fetchPage(start + PAGE);
                });
        }
        return fetchPage(0);
    }

    /**
     * V3 云端拉取与合并（核心合并流程）。
     * 步骤：
     *   1) fetchAllRows 分页拉取全部行（含墓碑），按 record_type 分组；
     *   2) epoch 检测：云端为空但本机曾同步 → 判定"重置窗口"（管理员刚清空
     *      尚未回传），本次不动本地、不补种，防止旧数据回灌；
     *      云端 epoch 与本机不同 → hardResetFromCloud 整体丢弃本地、按云端
     *      活行重建（旧设备跟随管理员重置）；
     *   3) 正常合并（按类型）：
     *      - meta：dormitoryList 云端权威（云端异常空则保留本地并标脏补种），
     *        nextIds 逐键取最大值防止 id 回退；
     *      - 基础类型（floor/dormitory/student/user/deduction_item）：云端活行
     *        覆盖本地，本地多出的活行补种上传；墓碑行删除本地对应记录；
     *      - 业务记录（deduction/leave/absence）：多设备并发，按 updated_at
     *        最新者胜合并；墓碑行删除本地；
     *   4) 合并后落本地、返回 {added, updated, removed, rescued, basicChanged, reset?/aborted?}。
     * @returns {Promise<object|null>} 合并统计；同步未启用时返回 null
     */
    function loadFromCloudV3(){
        if (!syncEnabled || !supabaseClient) return Promise.resolve(null);
        ensureSyncMeta();
        // 分页全量拉取（含 deleted=true 墓碑行），超 1000 行也能完整取回
        return fetchAllRows().then(function(rows){
            console.log('[V3] 拉取到 ' + rows.length + ' 条行（含墓碑）');
            // 按 type 分组
            var byType = {};
            rows.forEach(function(r){
                if(!byType[r.record_type]) byType[r.record_type] = [];
                byType[r.record_type].push(r);
            });
            var result = { added:0, updated:0, removed:0, rescued:0, basicChanged:false, total:rows.length };
            // 云端下行记录的数字型主键/外键归一化（防御 JSONB 或历史数据把 id 存成字符串，
            // 导致本地 getItemById 等严格相等比较失效）。仅处理核心 5 类；
            // 业务记录（deduction_record 等）id 为字符串时间戳，绝不能 parseInt。
            function toIdNum(v){
                if(typeof v === 'number') return v;
                if(typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
                return v;
            }
            function normalizeCloudIds(type, obj){
                if(!obj || typeof obj !== 'object') return obj;
                if(type === 'floor'){ obj.id = toIdNum(obj.id); }
                else if(type === 'dormitory'){ obj.id = toIdNum(obj.id); obj.floorId = toIdNum(obj.floorId); }
                else if(type === 'student'){ obj.id = toIdNum(obj.id); obj.dormitoryId = toIdNum(obj.dormitoryId); }
                else if(type === 'user'){ obj.id = toIdNum(obj.id); }
                else if(type === 'deduction_item'){ obj.id = toIdNum(obj.id); }
                return obj;
            }
            // 把某类型的云端行拆成 活行 map（record_id → row）与 墓碑 set（record_id → true）
            function splitRows(type){
                var typeRows = byType[type] || [];
                var live = {}, tomb = {};
                typeRows.forEach(function(r){
                    var rid = String(r.record_id);
                    if(r.deleted) tomb[rid] = r;
                    else live[rid] = r;
                });
                return { live: live, tomb: tomb, total: typeRows.length };
            }
            // ===== 数据版本号（epoch）检测：决定"正常合并"还是"整体重置重建" =====
            var cloudMetaSplit = splitRows('meta');
            var cloudMetaLive = cloudMetaSplit.live['main'];
            var cloudEpoch = (cloudMetaLive && cloudMetaLive.data && typeof cloudMetaLive.data.epoch === 'number') ? cloudMetaLive.data.epoch : 0;
            var localEpoch = DB.syncEpoch || 0;
            // 情形A：云端整表为空
            if(rows.length === 0 && localEpoch > 0){
                // 本机曾同步过、云端却被整体清空 → 大概率是管理员正在执行"重置云端数据"，
                // 处于"已清空、尚未回传"的短暂窗口。本次不改动本地、不标脏补种，防止旧数据回灌。
                console.warn('[V3] 云端为空但本机已同步过（epoch='+localEpoch+'），判定为重置窗口，跳过本次拉取，不改动本地、不补种');
                return { aborted:true, total:0, added:0, updated:0, removed:0, rescued:0, basicChanged:false };
            }
            // 情形B：云端带 epoch 且与本机不同（含本机从未同步 epoch=0、以及管理员重置后所有旧设备）
            if(cloudEpoch > 0 && cloudEpoch !== localEpoch){
                // 【二次确认】整体覆盖前弹出 confirm，防止管理员误重置导致普通设备数据被意外抹掉
                var confirmMsg = '检测到云端数据版本更新（本机epoch='+localEpoch+'，云端epoch='+cloudEpoch+'）。云端可能被重置或更正。是否确认以云端数据覆盖本地？\n\n点击【确定】覆盖本地，点击【取消】保留本地并重新同步。';
                if(!window.confirm(confirmMsg)){
                    // 用户取消：清空本地脏标记，将本地 epoch 对齐云端（假装已是最新，避免死循环触发确认）
                    V3_RECORD_TYPES.forEach(function(m){
                        DB.dirtyByType[m.type] = {};
                        DB.deletedByType[m.type] = {};
                    });
                    DB.syncEpoch = cloudEpoch;
                    console.warn('[V3] 用户拒绝云端覆盖，已清空脏标记并对齐 epoch='+cloudEpoch+'，保留本地数据');
                    return { aborted:true, total:0, added:0, updated:0, removed:0, rescued:0, basicChanged:false };
                }
                console.warn('[V3] 检测到数据版本变化（本机 epoch='+localEpoch+' → 云端 epoch='+cloudEpoch+'），整体丢弃本地并以下发数据为准重建');
                var resetOk = hardResetFromCloud(byType, cloudEpoch);
                if(!resetOk){
                    // 健康检查失败（云端数据为空），已阻断覆盖，直接中止本次拉取
                    return { aborted:true, total:0, added:0, updated:0, removed:0, rescued:0, basicChanged:false };
                }
                DB.lastSyncTime = Date.now();
                ensureCorrectUsers();
                if(currentUser && currentUser.id != null){
                    var refreshed = DB.users.find(function(x){ return String(x.id) === String(currentUser.id); });
                    if(refreshed) currentUser = refreshed;
                }
                if(selectedDormitoryId && !getDormitoryById(selectedDormitoryId)){ selectedDormitoryId=null; selectedFloorId=null; }
                result.basicChanged = true;
                result.reset = true;
                console.log('[V3] 整体重建完成（epoch='+cloudEpoch+'）：共 '+result.total+' 行下发数据');
                return result;
            }
            // 整体重置：丢弃本地全部数据，完全以云端活行重建（墓碑不恢复）
            function hardResetFromCloud(grouped, epoch){
                // 【自动备份】覆盖前先把本地 DB 快照存入 localStorage，便于灾难恢复
                try {
                    localStorage.setItem('dormitory_system_backup', JSON.stringify(DB));
                    console.log('本地数据已自动备份');
                } catch(e) {}

                // 【数据健康检查】云端 students 或 floors 为空 → 疑似异常，阻断覆盖，保留本地数据
                var cloudStudents = (grouped['student'] || []).filter(function(r){ return !r.deleted; });
                var cloudFloors = (grouped['floor'] || []).filter(function(r){ return !r.deleted; });
                if(cloudStudents.length === 0 || cloudFloors.length === 0){
                    toast('警告：云端数据异常为空，已阻断覆盖，本地数据安全保留！', 'error');
                    console.warn('[V3] 数据健康检查失败：云端 students='+cloudStudents.length+', floors='+cloudFloors.length+'，已阻断覆盖');
                    return false;
                }

                // 【数量级检查】防脏数据/被篡改：非空但数量远少于本地（<30%）时同样阻断。
                // 仅在本地数据已具规模（学生>20 / 宿舍>10）时启用，避免小规模数据误判。
                var localStudentCount = (DB.students || []).length;
                var localDormCount = (DB.dormitories || []).length;
                if(localStudentCount > 20 && cloudStudents.length < localStudentCount * 0.3){
                    toast('警告：云端学生数量异常偏少（云端 '+cloudStudents.length+' / 本地 '+localStudentCount+'），疑似数据被篡改或损坏，已阻断覆盖，本地数据安全保留！如需强制覆盖，请联系技术人员。', 'error');
                    console.warn('[V3] 健康检查失败：云端学生数远少于本地（云端 '+cloudStudents.length+' / 本地 '+localStudentCount+'），已阻断覆盖');
                    return false;
                }
                var cloudDormitories = (grouped['dormitory'] || []).filter(function(r){ return !r.deleted; });
                if(localDormCount > 10 && cloudDormitories.length < localDormCount * 0.3){
                    toast('警告：云端宿舍数量异常偏少（云端 '+cloudDormitories.length+' / 本地 '+localDormCount+'），疑似数据被篡改或损坏，已阻断覆盖，本地数据安全保留！如需强制覆盖，请联系技术人员。', 'error');
                    console.warn('[V3] 健康检查失败：云端宿舍数远少于本地（云端 '+cloudDormitories.length+' / 本地 '+localDormCount+'），已阻断覆盖');
                    return false;
                }

                var resetCount = 0;
                // meta：dormitoryList + nextIds + masterBindHash
                var mLive = grouped['meta'] ? grouped['meta'].find(function(r){ return !r.deleted; }) : null;
                if(mLive && mLive.data){
                    if(Array.isArray(mLive.data.dormitoryList)) DB.dormitoryList = mLive.data.dormitoryList;
                    if(mLive.data.nextIds) DB.nextIds = mLive.data.nextIds;
                    // masterBindHash：从云端 meta 行恢复（云端未设置则置空，等待管理员首次设置）
                    DB.masterBindHash = (typeof mLive.data.masterBindHash === 'string') ? mLive.data.masterBindHash : '';
                } else {
                    DB.masterBindHash = '';
                }
                // 数组类型：floor / dormitory / student / user + 三类业务记录 + 巡查核实三类记录 + 站内通知两类（通知 + 通知模板）
                ['floor','dormitory','student','user','deduction_record','leave_record','absence_record','inspection_confirmation','anomaly_report','daily_summary','notification','notification_template'].forEach(function(type){
                    var tMeta = V3_RECORD_TYPES.find(function(m){ return m.type === type; });
                    if(!tMeta) return;
                    var liveRows = (grouped[type] || []).filter(function(r){ return !r.deleted; }).map(function(r){ return normalizeCloudIds(type, r.data); });
                    DB[tMeta.dbPath[0]] = liveRows;
                    resetCount += liveRows.length;
                });
                // deduction_item：按 _subType 归回 hygiene / discipline
                DB.deductionItems = { hygiene: [], discipline: [] };
                (grouped['deduction_item'] || []).forEach(function(r){
                    if(r.deleted) return;
                    var st = (r.data && r.data._subType) || ((r.data && r.data.defaultScore <= 0.5) ? 'hygiene' : 'discipline');
                    var clean = {};
                    Object.keys(r.data || {}).forEach(function(k){ if(k !== '_subType') clean[k] = r.data[k]; });
                    normalizeCloudIds('deduction_item', clean);
                    if(st === 'discipline') DB.deductionItems.discipline.push(clean);
                    else DB.deductionItems.hygiene.push(clean);
                });
                // 重建后与云端完全一致：清空全部脏/删标记，写入新 epoch
                V3_RECORD_TYPES.forEach(function(m){
                    DB.dirtyByType[m.type] = {};
                    DB.deletedByType[m.type] = {};
                });
                DB.syncEpoch = epoch;
                console.log('[V3] 重建明细：共 '+resetCount+' 条数组记录 + '+DB.deductionItems.hygiene.length+' 卫生项 + '+DB.deductionItems.discipline.length+' 纪律项');
                return true;
            }
            // meta 类型（单行：dormitoryList + nextIds）
            function mergeMetaType(){
                var split = splitRows('meta');
                var before = v3Snapshot('meta');
                var liveRow = split.live['main'];
                if(liveRow && liveRow.data){
                    var md = liveRow.data;
                    // dormitoryList 以云端权威列表为准（管理员增删宿舍号需同步到所有设备）；
                    // 兜底：若云端列表异常为空而本地有数据，保留本地并标脏补种，杜绝宿舍号被清空
                    if(Array.isArray(md.dormitoryList) && md.dormitoryList.length > 0){
                        DB.dormitoryList = md.dormitoryList;
                    } else if(Array.isArray(DB.dormitoryList) && DB.dormitoryList.length > 0){
                        v3MarkDirty('meta', 'main');
                        result.rescued++;
                    }
                    // nextIds 逐键取最大值，防止多设备并发新建记录时 id 回退冲突
                    if(md.nextIds){
                        Object.keys(md.nextIds).forEach(function(k){
                            DB.nextIds[k] = Math.max(DB.nextIds[k] || 0, md.nextIds[k] || 0);
                        });
                    }
                    // masterBindHash：云端已设置即覆盖本地（管理员首次设置后同步到所有设备）；
                    // 云端为空但本地已设置（管理员在本机刚设、尚未上传）→ 标脏补种，让云端补齐
                    if(typeof md.masterBindHash === 'string' && md.masterBindHash.length > 0){
                        DB.masterBindHash = md.masterBindHash;
                    } else if(typeof DB.masterBindHash === 'string' && DB.masterBindHash.length > 0){
                        v3MarkDirty('meta', 'main');
                        result.rescued++;
                    }
                } else if(split.total === 0){
                    // 云端完全没有 meta 行：保留本地，标脏补种
                    v3MarkDirty('meta', 'main');
                    result.rescued++;
                }
                if(v3Snapshot('meta') !== before) result.basicChanged = true;
            }
            // deduction_item（{hygiene:[], discipline:[]} 扁平结构）
            function mergeItemsType(){
                var type = 'deduction_item';
                var split = splitRows(type);
                var before = v3Snapshot(type);
                var dirtySet = (DB.dirtyByType && DB.dirtyByType[type]) || {};
                var deletedSet = (DB.deletedByType && DB.deletedByType[type]) || {};
                if(split.total === 0){
                    // 云端完全缺失该类型：保留本地，全量标脏补种
                    var n = v3MarkTypeDirty(type);
                    if(n > 0){ result.rescued += n; console.log('[V3] 云端缺失 deduction_item，保留本地 ' + n + ' 项并补种上传'); }
                    if(v3Snapshot(type) !== before) result.basicChanged = true;
                    return;
                }
                // 推断一条云端记录的归属 sub 类型：
                //   1) 优先取显式 _subType（v3GetRecordsByType 上传时附带，最可靠）；
                //   2) 缺失时按 id 范围兜底（301-400 → hygieneBonus，401-500 → disciplineBonus）；
                //   3) 再缺失时按分值兜底（<= 0.5 → hygiene，否则 discipline，旧规则）。
                function inferSubType(data){
                    if(!data) return null;
                    if(data._subType) return data._subType;
                    var id = parseInt(data.id, 10);
                    if(!isNaN(id)){
                        if(id >= 301 && id <= 400) return 'hygieneBonus';
                        if(id >= 401 && id <= 500) return 'disciplineBonus';
                    }
                    return data.defaultScore <= 0.5 ? 'hygiene' : 'discipline';
                }
                // 【核心修复】四类子数组都参与合并；遍历本地项时必须校验"云端行的 sub 类型与当前 sub 一致"，
                // 避免把错位寄生到本地 hygiene 的加分项（如 id=301 卫生优秀、id=401 表现良好）当成正常项保留。
                ['hygiene','discipline','hygieneBonus','disciplineBonus'].forEach(function(sub){
                    if(!DB.deductionItems) DB.deductionItems = { hygiene:[], discipline:[], hygieneBonus:[], disciplineBonus:[] };
                    if(!Array.isArray(DB.deductionItems[sub])) DB.deductionItems[sub] = [];
                    var localArr = DB.deductionItems[sub];
                    var kept = [];
                    localArr.forEach(function(item){
                        var rid = String(item.id);
                        var cloudRow = split.live[rid];
                        if(cloudRow){
                            // 【新增·关键修复】先校验云端 sub 类型是否与当前 sub 一致
                            var cloudST = inferSubType(cloudRow.data);
                            if(cloudST && cloudST !== sub){
                                // 云端这条属于其他类别 → 本地这条是错位寄生数据 → 丢弃
                                result.removed++;
                                return;
                            }
                            // 类别匹配：按云端内容更新本地（本地有未上传修改除外）
                            if(!dirtySet[rid]){
                                var cloudData = cloudRow.data || {};
                                var cloudClean = {};
                                Object.keys(cloudData).forEach(function(k){ if(k !== '_subType') cloudClean[k] = cloudData[k]; });
                                if(JSON.stringify(item) !== JSON.stringify(cloudClean)){
                                    Object.keys(item).forEach(function(k){ delete item[k]; });
                                    Object.keys(cloudClean).forEach(function(k){ item[k] = cloudClean[k]; });
                                    result.updated++;
                                }
                            }
                            kept.push(item);
                        } else if(split.tomb[rid] && !dirtySet[rid]){
                            // 云端墓碑：本地无未上传修改时删除
                            result.removed++;
                        } else {
                            // 云端无任何痕迹（既无活行也无墓碑）
                            // 【主控设备锁定·防污染】与 mergeArrayType 策略一致：
                            //   非主控设备：云端无 = 本地多余脏数据 → 丢弃
                            //   主控设备：标脏保留补种（防止本地正确数据被误判丢失）
                            if(V3_BASIC_TYPES.indexOf(type) !== -1 && DEVICE_ID !== MASTER_DEVICE_ID){
                                result.removed++;
                                return;
                            }
                            if(!dirtySet[rid] && !deletedSet[rid]){ v3MarkDirty(type, item.id); result.rescued++; }
                            kept.push(item);
                        }
                    });
                    // 云端活行中本地没有的 → 新增（严格按 inferSubType 归位到对应 sub 数组）
                    Object.keys(split.live).forEach(function(rid){
                        var exists = kept.some(function(x){ return String(x.id) === rid; });
                        if(exists || deletedSet[rid]) return;
                        var r = split.live[rid];
                        var st = inferSubType(r.data);
                        if(st !== sub) return;
                        var clean = {};
                        Object.keys(r.data || {}).forEach(function(k){ if(k !== '_subType') clean[k] = r.data[k]; });
                        normalizeCloudIds('deduction_item', clean);
                        kept.push(clean);
                        result.added++;
                    });
                    DB.deductionItems[sub] = kept;
                });
                if(v3Snapshot(type) !== before) result.basicChanged = true;
            }
            // 普通数组类型（floor/dormitory/student/user + 三类业务记录）统一合并
            // 策略（本地优先 + 标脏补传，坚决杜绝误删）：
            //   云端活行、本地无 → 新增接收（本地已标删除的不回灌）
            //   云端活行、本地有 → 本地脏保留本地；否则按 updated_at 取新
            //   云端墓碑行       → 明确删除信号，执行本地删除（本地有未上传修改时除外）
            //   云端无任何痕迹   → 可能分页遗漏/网络延迟/从未上传成功：标脏保留，下次同步补种
            function mergeArrayType(type){
                var meta = V3_RECORD_TYPES.find(function(m){ return m.type === type; });
                if(!meta) return;
                var split = splitRows(type);
                var before = v3Snapshot(type);
                var dirtySet = (DB.dirtyByType && DB.dirtyByType[type]) || {};
                var deletedSet = (DB.deletedByType && DB.deletedByType[type]) || {};
                var arr = DB[meta.dbPath[0]] || [];
                var localMap = {};
                arr.forEach(function(r){ if(r && r.id != null) localMap[String(r.id)] = r; });
                // 1) 云端活行、本地无 → 新增
                Object.keys(split.live).forEach(function(rid){
                    if(!localMap[rid] && !deletedSet[rid]){
                        var incoming = normalizeCloudIds(type, split.live[rid].data);
                        arr.push(incoming);
                        localMap[rid] = incoming;
                        result.added++;
                    }
                });
                // 2) 同 id：本地非脏时按 updated_at 取新
                Object.keys(split.live).forEach(function(rid){
                    var local = localMap[rid];
                    if(!local || dirtySet[rid]) return;
                    var cloud = split.live[rid].data || {};
                    var localTime = local.lastModified || local.createdAt || 0;
                    var cloudTime = split.live[rid].updated_at ? new Date(split.live[rid].updated_at).getTime() : (cloud.lastModified || cloud.createdAt || 0);
                    if(cloudTime >= localTime && JSON.stringify(local) !== JSON.stringify(cloud)){
                        Object.keys(local).forEach(function(k){ delete local[k]; });
                        Object.keys(cloud).forEach(function(k){ local[k] = cloud[k]; });
                        normalizeCloudIds(type, local); // 覆盖后同样归一化主键/外键
                        result.updated++;
                    }
                });
                // 3) 遍历本地：墓碑→删除；无云端痕迹→标脏保留
                var keptArr = [];
                var isMutableType = V3_MUTABLE_TYPES.indexOf(type) !== -1;
                arr.forEach(function(r){
                    var rid = String(r.id);
                    if(isMutableType){
                        // 业务记录：保留/丢弃决策完全由溯源清洗纯函数决定（便于单元测试）
                        if(v3ShouldKeepMutableRecord(r, dirtySet, DB.lastSyncTime, !!split.live[rid], !!split.tomb[rid])){
                            keptArr.push(r);
                        } else {
                            result.removed++;
                        }
                        return;
                    }
                    // ---- 以下为基础数据（floor/dormitory/student/user）逻辑，保持不变 ----
                    if(split.tomb[rid] && !dirtySet[rid]){
                        result.removed++;
                        return;
                    }
                    if(!split.live[rid] && !split.tomb[rid] && !dirtySet[rid] && !deletedSet[rid]){
                        // 【主控设备锁定·防污染】基础数据：非主控设备上云端无记录 = 本地多余/脏数据，直接丢弃
                        if(V3_BASIC_TYPES.indexOf(type) !== -1 && DEVICE_ID !== MASTER_DEVICE_ID){
                            result.removed++;
                            return; // 不 push 到 keptArr，强制云端覆盖本地
                        }
                        // 非基础数据 或 主控设备：保留原有补种逻辑，下次同步上传
                        v3MarkDirty(type, r.id);
                        result.rescued++;
                    }
                    keptArr.push(r);
                });
                DB[meta.dbPath[0]] = keptArr;
                if(v3Snapshot(type) !== before) result.basicChanged = true;
            }
            // 基础数据与业务记录统一走本地优先合并
            V3_BASIC_TYPES.forEach(function(type){
                if(type === 'meta') mergeMetaType();
                else if(type === 'deduction_item') mergeItemsType();
                else mergeArrayType(type);
            });
            V3_MUTABLE_TYPES.forEach(function(type){ mergeArrayType(type); });
            DB.lastSyncTime = Date.now();
            // 合并后先按 username 去重账号（跨设备同名不同 id 的重复账号，
            // 保留最小 id 并打墓碑上行），再重新校准账号
            dedupeUsersByUsername();
            ensureCorrectUsers();
            if(currentUser && currentUser.id != null){
                var refreshed = DB.users.find(function(x){ return String(x.id) === String(currentUser.id); });
                if(refreshed) currentUser = refreshed;
            }
            if(selectedDormitoryId && !getDormitoryById(selectedDormitoryId)){ selectedDormitoryId=null; selectedFloorId=null; }
            console.log('[V3] 拉取完成：新增 '+result.added+'，更新 '+result.updated+'，删除 '+result.removed+'，补种标脏 '+result.rescued+'，基础数据变化='+result.basicChanged+'，云端共 '+result.total+' 行');
            return result;
        }, function(err){
            console.error('[V3] 拉取失败:', (err && err.message) ? err.message : err);
            return null;
        });
    }
    // 辅助：取某类型数组的 JSON 快照（用于比较是否变化）
    function v3Snapshot(type){
        try {
            var meta = V3_RECORD_TYPES.find(function(m){ return m.type === type; });
            if(!meta) return '';
            if(type === 'meta') return JSON.stringify({ dormitoryList: DB.dormitoryList || [], nextIds: DB.nextIds || {} });
            if(type === 'deduction_item') return JSON.stringify(DB.deductionItems || {});
            return JSON.stringify(DB[meta.dbPath[0]] || []);
        } catch(e){ return ''; }
    }

    /**
     * 将云端旧格式（sync_store 中 id=1 的整库压缩行）迁移为 V3 按行存储。
     * 一次性迁移：解码旧整库 → 把 floor/dormitory/student/user/deduction_item/
     * 三类业务记录逐条构造为 sync_store 行批量 upsert → 成功后删除旧 id=1 行。
     *
     * 返回值语义（供 initializeData 决定是否全量标脏，必须精确区分）：
     *   'migrated'：确实执行了旧格式迁移；
     *   'empty'   ：云端 sync_store 确认为空表（无任何行），属首次上传；
     *   'v3exists'：云端已有 V3 数据，或查询/解析/网络异常（保守不标脏，
     *               避免误判把本地旧基础数据无差别覆盖云端）。
     * @returns {Promise<string>} 'migrated' | 'empty' | 'v3exists'
     */
    function migrateOldFormatToRows(){
        if(!supabaseClient) return Promise.resolve('v3exists');
        // 第一步：先判断 sync_store 表里是否有任何行
        return supabaseClient.from('sync_store').select('id').limit(1).then(function(anyRes){
            if(anyRes.error){
                // 查询报错（多为网络/权限问题）：保守判定为已有数据，绝不因此全量标脏上传
                console.warn('[迁移] 查询 sync_store 失败，跳过本地脏标记:', anyRes.error.message);
                return 'v3exists';
            }
            if(!anyRes.data || anyRes.data.length === 0){
                // 空表：首次上传，需要把本地全部记录标脏
                console.log('[迁移] 云端 sync_store 为空表');
                return 'empty';
            }
            // 第二步：查询旧格式整库行（id=1，data 非 null）
            return supabaseClient.from('sync_store').select('id,data').eq('id',1).maybeSingle().then(function(res){
            if(res.error){ console.warn('[迁移] 查询旧数据失败，跳过本地脏标记:', res.error.message); return 'v3exists'; }
            if(!res.data || res.data.data == null){ console.log('[迁移] 云端无旧格式整库行，已是按行存储'); return 'v3exists'; }
            var raw = res.data.data;
            // data 为对象（JSONB 直返）= V3 行数据；旧版 V2 整库为压缩字符串
            if(typeof raw === 'object'){
                console.log('[迁移] id=1 行 data 为对象（V3 格式），无需迁移');
                return 'v3exists';
            }
            if(typeof raw !== 'string') return 'v3exists';
            var decoded = decodeCloudData(raw);
            // 仅当带旧版压缩前缀，或确实能解析出旧整库字段时，才认定为 V2 旧格式
            var looksLikeV2 = raw.indexOf(CLOUD_LZ_PREFIX) === 0
                || raw.indexOf('LZC1U:') === 0
                || raw.indexOf('LZC1:') === 0;
            var hasOldPayload = decoded && typeof decoded === 'object'
                && (Array.isArray(decoded.floors) || Array.isArray(decoded.students));
            if(!looksLikeV2 && !hasOldPayload){
                console.log('[迁移] id=1 行不是旧版压缩整库，无需迁移');
                return 'v3exists';
            }
            if(!decoded || typeof decoded !== 'object'){
                console.log('[迁移] 旧数据无法解析，跳过');
                return 'v3exists';
            }
            // 构建完整的 DB 对象（从旧数据提取）
            var full = {
                floors: decoded.floors || [],
                dormitories: decoded.dormitories || [],
                students: decoded.students || [],
                users: decoded.users || [],
                deductionRecords: decoded.deductionRecords || [],
                leaveRecords: decoded.leaveRecords || [],
                absenceRecords: decoded.absenceRecords || []
            };
            // deductionItems 可能在旧数据中不存在
            if(decoded.deductionItems) full.deductionItems = decoded.deductionItems;
            else full.deductionItems = { hygiene:[], discipline:[] };
            // 将每条业务记录构造为 sync_store 行
            var allRows = [];
            var nowIso = new Date().toISOString();
            // floor / dormitory / student / user：直接转
            ['floors','dormitories','students','users'].forEach(function(arrKey){
                var typeMap = { floors:'floor', dormitories:'dormitory', students:'student', users:'user' };
                var records = full[arrKey] || [];
                records.forEach(function(rec){
                    if(!rec || rec.id == null) return;
                    allRows.push(v3BuildUpsertRow(typeMap[arrKey], rec.id, rec, false, nowIso));
                });
            });
            // deductionItems 特殊处理
            ['hygiene','discipline'].forEach(function(sub){
                var items = (full.deductionItems && full.deductionItems[sub]) || [];
                items.forEach(function(item){
                    if(!item || item.id == null) return;
                    var enriched = Object.assign({}, item, { _subType: sub });
                    allRows.push(v3BuildUpsertRow('deduction_item', item.id, enriched, false, nowIso));
                });
            });
            // 业务记录：deduction_record / leave_record / absence_record
            var bizMap = { deductionRecords:'deduction_record', leaveRecords:'leave_record', absenceRecords:'absence_record' };
            ['deductionRecords','leaveRecords','absenceRecords'].forEach(function(arrKey){
                var records = full[arrKey] || [];
                records.forEach(function(rec){
                    if(!rec || rec.id == null) return;
                    allRows.push(v3BuildUpsertRow(bizMap[arrKey], rec.id, rec, false, nowIso));
                });
            });
            if(allRows.length === 0){ console.log('[迁移] 旧数据无有效记录，跳过'); return 'v3exists'; }
            console.log('[迁移] 准备迁移 ' + allRows.length + ' 条记录...');
            // 批量 upsert（与常规同步共用 v3UploadRows），完成后删除旧格式行 id=1
            return v3UploadRows(allRows).then(function(ok){
                if(!ok) return 'v3exists';
                return supabaseClient.from('sync_store').delete().eq('id',1).then(function(r2){
                    if(r2.error) console.warn('[迁移] 清理旧行失败（可忽略）:', r2.error.message);
                    else console.log('[迁移] 旧格式行已删除');
                    toast('数据格式升级完成');
                    return 'migrated';
                });
            });
            }); // 结束 id=1 旧格式行查询的 then
        }).catch(function(e){
            // 任何未预期异常（含网络失败）：保守返回 v3exists，绝不触发全量标脏上传
            console.warn('[迁移] 迁移检查异常，跳过本地脏标记:', (e && e.message) ? e.message : e);
            return 'v3exists';
        });
    }

    // ==================== 云端数据编解码（向后兼容旧格式） ====================
    // 云端 data 字段为 jsonb：旧数据读回是对象，新压缩数据读回是带前缀的字符串
    /**
     * 解码云端 data 字段（jsonb）：兼容对象直返与多种 lz-string 压缩前缀
     * （CLOUD_LZ_PREFIX=LZC1B: Base64、LZC1U: UTF16、LZC1: 普通压缩），
     * 无前缀串先尝试 JSON.parse，再依次尝试各解压变体，全部失败返回 null。
     * @param {object|string} raw - 云端读回的 data 原始值
     * @returns {object|null} 解码后的整库/数据对象；无法识别时 null
     */
    function decodeCloudData(raw) {
        if (raw == null) return null;
        // 旧格式：jsonb 直接返回的对象
        if (typeof raw === 'object') return raw;
        if (typeof raw !== 'string') return null;
        var json = null;
        try {
            if (raw.indexOf(CLOUD_LZ_PREFIX) === 0) {
                // 新格式：Base64 压缩
                json = LZString.decompressFromBase64(raw.slice(CLOUD_LZ_PREFIX.length));
            } else if (raw.indexOf('LZC1U:') === 0) {
                json = LZString.decompressFromUTF16(raw.slice('LZC1U:'.length));
            } else if (raw.indexOf('LZC1:') === 0) {
                json = LZString.decompress(raw.slice('LZC1:'.length));
            } else {
                // 无前缀：先按未压缩 JSON 文本尝试（旧格式或直接字符串上传）
                try {
                    var parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') return parsed;
                } catch(je) { /* 不是 JSON，按压缩串处理 */ }
                // 兼容不带标记的压缩串：依次尝试各解压变体
                var variants = ['decompress', 'decompressFromUTF16', 'decompressFromBase64', 'decompressFromEncodedURIComponent'];
                for (var i = 0; i < variants.length; i++) {
                    try {
                        var candidate = LZString[variants[i]](raw);
                        if (candidate) {
                            var obj = JSON.parse(candidate);
                            if (obj && typeof obj === 'object') return obj;
                        }
                    } catch(ve) { /* 尝试下一种变体 */ }
                }
                console.error('云端数据无法识别：既非有效 JSON 也非支持的压缩格式');
                return null;
            }
            if (!json) {
                console.error('云端压缩数据解压失败：返回空结果（数据可能已损坏）');
                return null;
            }
            return JSON.parse(json);
        } catch(e) {
            console.error('云端数据解码失败:', e);
            return null;
        }
    }
    // ==================== 双层同步：全量基础数据 + 增量扣分记录 ====================
    // 云端 data 字段存 version 2.0 全量对象（基础数据 + 扣分记录），压缩存储
    // 上传：基础表（楼层/宿舍/学生/项目/用户/退宿）以本地为准直接覆盖；扣分记录保持增量合并
    //（pending = 未同步 ∪ 本地修改过的脏记录，同 id 以本地为准，已删除记录通过墓碑剔除）
    // ==================== 同步状态指示器 + 断网重试 ====================
    /**
     * 更新顶栏同步状态圆点（synced 绿 / syncing 黄 / unsynced 红）。
     * @param {string} state - 'synced' | 'syncing' | 'unsynced'
     */
    function updateSyncStatus(state){
        var dot=document.getElementById('syncStatusDot');
        if(!dot) return;
        // 离线优先：无论调用方传入何种状态，离线时一律显示红点 + 离线提示文案
        if(typeof navigator!=='undefined' && navigator.onLine===false){
            dot.classList.remove('synced','syncing','unsynced');
            dot.classList.add('unsynced');
            dot.title='离线中，数据将在联网后自动同步';
            _applyOfflineUI(true);
            return;
        }
        _applyOfflineUI(false);
        dot.classList.remove('synced','syncing','unsynced');
        dot.classList.add(state);
        var tips={synced:'已同步',syncing:'同步中…',unsynced:'有未同步数据（点击重试）'};
        dot.title='同步状态：'+(tips[state]||'');
    }
    // 离线视觉增强：离线超过阈值后，在状态点旁显示“离线”文字标签（仅移动端 CSS 放行）。
    // 延迟显示是为了过滤短暂网络抖动，避免标签频繁闪烁。
    var OFFLINE_LABEL_DELAY_MS=10000;
    var _offlineUIState={timer:null, active:false};
    function _clearOfflineLabelTimer(){
        if(_offlineUIState.timer){ clearTimeout(_offlineUIState.timer); _offlineUIState.timer=null; }
    }
    function _applyOfflineUI(offline){
        var label=document.getElementById('offlineLabel');
        if(offline){
            if(_offlineUIState.active) return;
            _offlineUIState.active=true;
            _clearOfflineLabelTimer();
            _offlineUIState.timer=setTimeout(function(){
                if(label) label.classList.add('show');
            }, OFFLINE_LABEL_DELAY_MS);
        }else{
            _offlineUIState.active=false;
            _clearOfflineLabelTimer();
            if(label) label.classList.remove('show');
        }
    }
    // 重试状态：指数退避 5s→10s→20s→40s→60s（封顶），最多 5 次
    var _retryState={attempt:0, timer:null, running:false, pendingRerun:false, rerunCount:0};
    // 断网 toast 防重复标志：仅在“在线→离线”跳变后的首次同步尝试时提示一次，
    // online 事件中复位。页面加载时本就离线则初值为 true（开页离线的提示由 app.js 负责）。
    var _offlineToastShown=(typeof navigator!=='undefined' && navigator.onLine===false);
    function clearRetryTimer(){ if(_retryState.timer){ clearTimeout(_retryState.timer); _retryState.timer=null; } }
    /**
     * 后台同步入口（带指数退避自动重试）。saveDB() 数据变更后即调用。
     * 防重入（running 标志）；离线时不重试、等 online 事件触发；失败按
     * 5/10/20/40/60 秒退避最多 5 次；后台失败静默（handleError silent），
     * 状态点提示"有未同步数据"。
     * @returns {Promise<boolean>} 本次尝试是否成功（false 可能已安排重试）
     */
    function syncWithRetry(){
        if(!syncEnabled||!supabaseClient||!DB) return Promise.resolve(false);
        // 【版本双重检测机制·后台同步入口】在 running 防重入判断之前强制比对版本：
        // 版本落后时绝不执行后续的 syncToCloud()/pullFromCloud()（checkLatestVersion
        // 内部已弹全屏遮罩并安排 1.2 秒强制刷新），阻断旧版本上传脏数据；
        // 断网时 checkLatestVersion 直接放行，离线分支不受影响。
        return checkLatestVersion().then(function(verOk){
            if(!verOk){
                toast('当前版本过旧，已阻断同步，请刷新页面', 'error');
                return false;
            }
            // ★ 新增：外部触发（用户操作/手动同步/online）时复位续传计数；
            //   续传是直接调用 doSyncWithRetryInner()，不经过这里，所以不会被复位。
            _retryState.rerunCount = 0;
            return doSyncWithRetryInner();
        });
    }
    /** syncWithRetry 的原有逻辑（版本守卫通过后执行）：防重入 + 指数退避重试 */
    function doSyncWithRetryInner(){
        if(_retryState.running){
            // 已有同步在跑：不新增上传通道，只登记"跑完当前这次需要续传"的意图，
            // 让当前同步结束后自动重跑一遍完整的标准流程（版本守卫 → 先拉 → 后推）。
            _retryState.pendingRerun = true;
            return Promise.resolve(false);
        }
        _retryState.running=true;
        _retryState.attempt=0;
        clearRetryTimer();
        function doAttempt(){
            // 离线：不立即重试，等 online 事件触发
            if(typeof navigator!=='undefined' && navigator.onLine===false){
                updateSyncStatus('unsynced');
                // 防重复：同一离线周期内仅在首次同步尝试时提示一次
                if(!_offlineToastShown){
                    _offlineToastShown=true;
                    toast('当前网络已断开，数据已保存本地，联网后将自动同步', 'error');
                }
                _retryState.running=false;
                return Promise.resolve(false);
            }
            updateSyncStatus('syncing');
            // 【P1·每次必先拉后推】不再区分脏记录数量：任何一次同步都先拉取云端合并清洗，
            // 再上传本地增量。目的：即使本地只改了 1 条记录，也会先拉取云端墓碑，
            // 从根本上杜绝"本地不知情地 upsert 覆盖云端墓碑，导致已被删除的记录复活"。
            // 代价：每次同步多一次网络往返（几百毫秒），收益：数据一致性显著增强。
            var mutableDirtyCount = 0;
            V3_MUTABLE_TYPES.forEach(function(t){
                var ds = (DB.dirtyByType && DB.dirtyByType[t]) || {};
                mutableDirtyCount += Object.keys(ds).length;
            });
            // 【关键】备份拉取前的 lastSyncTime：loadFromCloud 内部会把它刷新为当前时间，
            // 若不恢复，syncToCloudV3 的"陈旧过滤"（recTime < lastSyncTime）会把用户
            // 刚刚新登记/编辑的记录误判为历史废弃数据而丢弃（数据丢失事故）。
            var lastSyncBeforePull = DB.lastSyncTime;
            var uploadPromise = loadFromCloud().then(function(pulled){
                // 恢复拉取前的 lastSyncTime，让 syncToCloudV3 使用正确的陈旧过滤基准
                DB.lastSyncTime = lastSyncBeforePull;
                // 拉取失败（返回 null）：跳过本次上传，交由外层重试机制处理，
                // 避免"本地盲推"覆盖云端最新墓碑或活跃数据
                if(pulled === null){
                    throw new Error('云端拉取失败，跳过本次上传以防覆盖');
                }
                // 重置窗口（管理员正在清空云端、尚未回传）：本次不动本地、不上传，
                // 静默等待下一次同步（syncToCloudV3 内部也有 aborted 判定，双重保险）
                if(pulled && pulled.aborted){
                    throw new Error('云端正在重置中，跳过本次上传');
                }
                // 仅在原本会触发熔断的场景下提示用户（避免每次同步都弹 toast）
                if(mutableDirtyCount > 10){
                    toast('检测到本地存在大量历史待同步数据，已自动清理。即将重新同步。');
                }
                return syncToCloud();
            });
            return uploadPromise.then(function(ok){
                if(ok){
                    updateSyncStatus('synced');
                    _retryState.attempt=0;
                    _retryState.running=false;
                    // ★ 新增：仅当本次同步完整成功（拉取+上传都成功）后，才检查是否需要续传。
                    //   续传 = 重新调用 doSyncWithRetryInner() 走一遍完整的标准流程，
                    //   会重新执行 checkLatestVersion / loadFromCloud / syncToCloud，
                    //   5 道防污染防线全部原样生效，不存在绕过。
                    if(_retryState.pendingRerun && _retryState.rerunCount < 10){
                        _retryState.pendingRerun = false;
                        _retryState.rerunCount++;
                        console.log('[同步续传] 检测到同步期间有新脏数据，第 ' + _retryState.rerunCount + ' 次续传');
                        // 用 setTimeout(0) 让当前 Promise 链先完整结束，避免同步递归
                        setTimeout(function(){ doSyncWithRetryInner(); }, 0);
                    }else if(_retryState.pendingRerun && _retryState.rerunCount >= 10){
                        // 硬上限保护：避免极端情况下无限续传
                        _retryState.pendingRerun = false;
                        console.warn('[同步续传] 已达单次会话续传上限（10 次），停止续传，剩余脏数据等待下次触发');
                        updateSyncStatus('unsynced');
                    }
                    return true;
                }
                // 失败：指数退避重试
                _retryState.attempt++;
                if(_retryState.attempt>=5){
                    updateSyncStatus('unsynced');
                    _retryState.running=false;
                    return false;
                }
                var delay=Math.min(60000, 5000*Math.pow(2, _retryState.attempt-1));
                updateSyncStatus('unsynced');
                _retryState.timer=setTimeout(function(){ doAttempt(); }, delay);
                return false;
            }).catch(function(e){
                // 后台自动重试：静默记录到控制台与错误日志，不打扰用户（重试由下方指数退避接管）
                handleError(e, '后台同步', { silent: true });
                _retryState.attempt++;
                if(_retryState.attempt>=5){
                    updateSyncStatus('unsynced');
                    _retryState.running=false;
                    return false;
                }
                var delay=Math.min(60000, 5000*Math.pow(2, _retryState.attempt-1));
                updateSyncStatus('unsynced');
                _retryState.timer=setTimeout(function(){ doAttempt(); }, delay);
                return false;
            });
        }
        return doAttempt();
    }
    /**
     * 上行同步总入口：按检测到的表结构版本分流。
     * V3（按行存储）→ syncToCloudV3（脏标记增量）；
     * V2（旧整库压缩）→ 读取云端 id=1 整库 → 扣分记录按 id/lastModified
     * 合并去重、墓碑剔除 → 基础数据以本地为准组装 v2.0 全量载荷 →
     * lz-string Base64 压缩后 upsert 回 id=1；成功后登记 syncedRecordIds
     * 并清除脏标记。
     * @returns {Promise<boolean>} true=上传成功；false=失败（调用方应安排重试）
     */
    function syncToCloud() {
        if (!syncEnabled || !supabaseClient || !DB) return Promise.resolve(false);
        ensureSyncMeta();
        // V3 按行存储：表结构已升级时自动切换
        if(_detectedSchemaVersion === 3) return syncToCloudV3();
        var pending=DB.deductionRecords.filter(function(r){
            var k=String(r.id);
            return DB.syncedRecordIds.indexOf(k)===-1 || DB.dirtyRecordIds.indexOf(k)>-1;
        });
        return supabaseClient.from('sync_store').select('data').eq('id',1).maybeSingle().then(function(res){
            if (res.error) { console.error('上传失败（读取云端）:', res.error.message); return false; }
            var cloudRecords=[];
            if (res.data && res.data.data!=null) {
                var decoded=decodeCloudData(res.data.data);
                if (decoded) {
                    if (Array.isArray(decoded)) cloudRecords=decoded;                                    // v1 增量格式：纯记录数组
                    else if (decoded.deductionRecords) cloudRecords=decoded.deductionRecords;            // v1 旧整库 / v2.0 全量：提取记录
                }
            }
            // 扣分记录合并去重（按 id 唯一）：
            // 基数 = 云端现有记录（权威） ∪ 本地 pending 记录（新增或脏）
            // 同 id 按 lastModified 取较新版本；本地已删除的记录通过墓碑剔除
            // 注意：已同步且非脏的本地记录不参与合并，避免本地旧编辑回灌云端
            var byId={};
            cloudRecords.forEach(function(r){ if(r&&r.id!=null) byId[String(r.id)]=r; });
            pending.forEach(function(r){
                if(!r||r.id==null) return;
                var k=String(r.id);
                var cur=byId[k];
                if(!cur || (r.lastModified||0) >= (cur.lastModified||0)) byId[k]=r;
            });
            var tomb={}; DB.deletedRecordIds.forEach(function(id){ tomb[String(id)]=true; });
            var merged=Object.keys(byId).filter(function(k){ return !tomb[k]; }).map(function(k){ return byId[k]; });
            // 构建 v2.0 全量载荷：基础数据以本地为准
            var payload = {
                floors: DB.floors,
                dormitories: DB.dormitories,
                dormitoryList: DB.dormitoryList || [],
                students: DB.students,
                deductionItems: DB.deductionItems,
                users: DB.users,
                deductionRecords: merged,
                leaveRecords: DB.leaveRecords || [],
                absenceRecords: DB.absenceRecords || [],
                lastModified: Date.now(),
                version: '2.0'
            };
            var body;
            try {
                if (window.LZString && typeof LZString.compressToBase64 === 'function') {
                    // 压缩为 Base64（纯 ASCII）：HTTP/UTF-8 传输无字符膨胀，且 jsonb 存储安全
                    body = CLOUD_LZ_PREFIX + LZString.compressToBase64(JSON.stringify(payload));
                } else {
                    throw new Error('lz-string 未加载');
                }
            } catch(e) {
                // 压缩失败回退：直接上传 JSON 对象
                console.warn('数据压缩失败，回退为原始格式上传:', e);
                body = payload;
            }
            return supabaseClient.from('sync_store').upsert({ id:1, data: body, updated_at: new Date().toISOString() }).then(function(res2){
                if(res2.error){ console.error('上传失败:', res2.error.message); return false; }
                // 上传成功后才登记为已同步并清除脏标记；失败则下次自动重试
                pending.forEach(function(r){
                    var k=String(r.id);
                    if(DB.syncedRecordIds.indexOf(k)===-1) DB.syncedRecordIds.push(k);
                    var di=DB.dirtyRecordIds.indexOf(k);
                    if(di>-1) DB.dirtyRecordIds.splice(di,1);
                });
                DB.lastSyncTime=Date.now();
                saveDBToLocal();
                return true;
            });
        });
    }
    // 拉取合并策略：
    // - v2.0 全量格式：基础数据表（楼层/宿舍/学生/项目/用户）以云端为准直接覆盖本地；扣分记录增量合并
    // - 退宿/停宿/请假记录按 id 合并（见下方 merge 函数），防止其他设备刚完成的审核被云端旧状态回滚
    // - v1 数组 / 旧整库：仅提取扣分记录增量合并（向后兼容）
    // - 首次同步（lastSyncTime 为空）：清空本地示例记录与同步元数据，云端数据完整落地
    // - 记录合并规则：本地缺失→追加；本地修改过（脏）→保留本地；其余按 lastModified 接收云端更新；墓碑不回灌
    // 退宿/停宿记录合并：
    // 1) 以 id 为键取并集：云端有而本地无 → 追加；本地有而云端无 → 仅保留带 localNew 标记的
    //    本地新增记录（未及上传），其余视为已在其他设备删除，随拉取传播删除；
    // 2) 同 id 记录合并审核状态：本地 pending 且云端已审核 → 采纳云端（其他设备管理员已审核）；
    //    本地已审核且云端 pending → 保留本地（防止本设备刚完成的审核被回滚）；同态 → 以云端为准。
    function mergeLeaveRecordArrays(localArr, remoteArr){
        var remote=(remoteArr||[]).filter(function(r){ return r&&r.id!=null; });
        var remoteIds={};
        remote.forEach(function(r){ remoteIds[String(r.id)]=true; });
        var byId={};
        (localArr||[]).forEach(function(r){
            if(!r||r.id==null) return;
            var k=String(r.id);
            if(remoteIds[k]){
                delete r.localNew;
                var rr=remote.find(function(x){ return String(x.id)===k; });
                var ls=r.status||'pending', rs=rr.status||'pending';
                if(ls==='pending' && rs!=='pending'){ r.status=rs; }
                else if(ls!=='pending' && rs==='pending'){ /* 保留本地已审核状态 */ }
                else { r.status=rs; }
                byId[k]=r;
            } else if(r.localNew){
                byId[k]=r;
            }
        });
        remote.forEach(function(r){
            var k=String(r.id);
            if(!byId[k]){ byId[k]=r; }
        });
        return Object.keys(byId).map(function(k){ return byId[k]; });
    }
    // 请假记录合并：无审核状态流转，规则同上（并集 + localNew 对账）
    function mergeAbsenceRecordArrays(localArr, remoteArr){
        var remote=(remoteArr||[]).filter(function(r){ return r&&r.id!=null; });
        var remoteIds={};
        remote.forEach(function(r){ remoteIds[String(r.id)]=true; });
        var byId={};
        (localArr||[]).forEach(function(r){
            if(!r||r.id==null) return;
            var k=String(r.id);
            if(remoteIds[k]){ delete r.localNew; byId[k]=r; }
            else if(r.localNew){ byId[k]=r; }
        });
        remote.forEach(function(r){
            var k=String(r.id);
            if(!byId[k]){ byId[k]=r; }
        });
        return Object.keys(byId).map(function(k){ return byId[k]; });
    }
    /**
     * 拉取同步总入口：按表结构版本分流。
     * V3 → loadFromCloudV3（按行合并）；V2 → 读取云端 id=1 整库：
     * v2.0 全量格式下基础数据（楼层/宿舍/学生/项目/账号）以云端为准覆盖本地，
     * 退宿/请假记录按 id 合并（保护其他设备的审核状态不被回滚）；扣分记录
     * 增量合并（墓碑不回灌、脏记录以本地为准、其余按 lastModified 接收更新）；
     * 首次同步时清空本地示例记录。合并后落本地并返回统计信息。
     * @returns {Promise<object|null>} {added, updated, removed, rescued, basicChanged, ...}；失败/未启用返回 null
     */
    function loadFromCloud() {
        if (!syncEnabled || !supabaseClient) return Promise.resolve(null);
        // V3 按行存储：表结构已升级时自动切换
        if(_detectedSchemaVersion === 3) return loadFromCloudV3();
        return supabaseClient.from('sync_store').select('data').eq('id',1).maybeSingle().then(function(res){
            if (res.error) { console.error('拉取失败:', res.error.message); return null; }
            if (!res.data || res.data.data == null) return null;
            var decoded = decodeCloudData(res.data.data);
            if (!decoded) { console.error('云端数据解码结果为空，已忽略'); return null; }
            var cloudRecords = Array.isArray(decoded) ? decoded : (decoded.deductionRecords || null);
            if (!cloudRecords) { console.error('云端数据格式无法识别，已忽略'); return null; }
            ensureSyncMeta();
            var isV2 = !Array.isArray(decoded) && decoded.version === '2.0';
            var isFirst = !DB.lastSyncTime;
            var result = { added: 0, updated: 0, total: cloudRecords.length, basicChanged: false };
            // 基础数据表：v2.0 时以云端为准覆盖本地（管理员统一维护，云端为权威来源）
            // 退宿/停宿/请假记录例外：按 id 合并（整体覆盖会把其他设备刚完成的审核状态回滚为待审核）
            if (isV2) {
                var before = JSON.stringify([DB.floors, DB.dormitories, DB.dormitoryList || [], DB.students, DB.deductionItems, DB.users, DB.leaveRecords || [], DB.absenceRecords || []]);
                DB.floors = decoded.floors || DB.floors;
                DB.dormitories = decoded.dormitories || DB.dormitories;
                // dormitoryList：系统生效宿舍号列表，以云端为准覆盖（管理员增删宿舍号需同步到所有设备）
                DB.dormitoryList = Array.isArray(decoded.dormitoryList) ? decoded.dormitoryList : (DB.dormitoryList || []);
                DB.students = decoded.students || DB.students;
                DB.deductionItems = decoded.deductionItems || DB.deductionItems;
                DB.users = decoded.users || DB.users;
                DB.leaveRecords = mergeLeaveRecordArrays(DB.leaveRecords || [], decoded.leaveRecords || []);
                DB.absenceRecords = mergeAbsenceRecordArrays(DB.absenceRecords || [], decoded.absenceRecords || []);
                var after = JSON.stringify([DB.floors, DB.dormitories, DB.dormitoryList, DB.students, DB.deductionItems, DB.users, DB.leaveRecords, DB.absenceRecords]);
                result.basicChanged = before !== after;
                // 云端基础数据覆盖后重新校准账号（角色修正/补齐班级账号/称呼迁移），
                // 避免云端旧数据把 realName 回滚为旧称呼
                ensureCorrectUsers();
                if (currentUser && currentUser.id != null) {
                    var refreshedUser = DB.users.find(function(x){ return String(x.id) === String(currentUser.id); });
                    if (refreshedUser) currentUser = refreshedUser;
                }
            }
            // 首次同步：丢弃本地示例记录与同步元数据，云端记录完整落地
            if (isFirst) {
                DB.deductionRecords = [];
                DB.syncedRecordIds = [];
                DB.dirtyRecordIds = [];
                DB.deletedRecordIds = [];
            }
            var tomb={}; DB.deletedRecordIds.forEach(function(id){ tomb[String(id)]=true; });
            var dirty={}; DB.dirtyRecordIds.forEach(function(id){ dirty[String(id)]=true; });
            var localIds={};
            DB.deductionRecords.forEach(function(r){ localIds[String(r.id)]=r; });
            cloudRecords.forEach(function(r){
                if(!r||r.id==null) return;
                var k=String(r.id);
                if(tomb[k]) return;      // 本地已删除的记录不回灌
                if(dirty[k]) return;     // 本地有未上传的修改：以本地为准，不被云端覆盖
                if(!localIds[k]){
                    DB.deductionRecords.push(r);
                    localIds[k]=r;
                    result.added++;
                }else{
                    // 本地存在但未编辑过：接收其他设备的修改（按 lastModified 判定新旧）
                    var cur=localIds[k];
                    var ra=r.lastModified||0, ca=cur.lastModified||0;
                    if(ra>ca && JSON.stringify(cur)!==JSON.stringify(r)){
                        Object.keys(cur).forEach(function(f){ delete cur[f]; });
                        Object.keys(r).forEach(function(f){ cur[f]=r[f]; });
                        result.updated++;
                    }
                }
            });
            // 已同步集合 = 原有 ∪ 云端全部记录ID（下次上传不再重复推送云端已有且未修改的记录）
            cloudRecords.forEach(function(r){
                if(!r||r.id==null) return;
                var k=String(r.id);
                if(!tomb[k] && DB.syncedRecordIds.indexOf(k)===-1) DB.syncedRecordIds.push(k);
            });
            // 终局对账（v2.0）：删除本地存在但云端已不存在、且非本地脏编辑的记录。
            // 用于将管理员"删除全部/单条删除"的操作传播到其他设备，避免本地残留旧数据。
            if (isV2) {
                var cloudIdSet={};
                cloudRecords.forEach(function(r){ if(r&&r.id!=null) cloudIdSet[String(r.id)]=true; });
                var beforeLen=DB.deductionRecords.length;
                DB.deductionRecords=DB.deductionRecords.filter(function(r){
                    var k=String(r.id);
                    if(cloudIdSet[k]) return true;          // 云端存在，保留
                    if(dirty[k]) return true;               // 本地有未上传修改，保留（避免丢失本地编辑）
                    if(tomb[k]) return false;               // 墓碑，删除
                    return false;                           // 云端已删除，本地清理
                });
                result.removed = beforeLen - DB.deductionRecords.length;
            }
            // 云端优先策略：v2.0 且本地从未同步过（首次启动）时，强制以云端记录集合为权威，
            // 清空脏记录，防止本地示例/旧数据在后续 syncToCloud 中回灌云端
            if (isV2 && isFirst) {
                DB.syncedRecordIds = cloudRecords.map(function(r){ return String(r.id); });
                DB.dirtyRecordIds = [];
            }
            DB.lastSyncTime=Date.now();
            // 基础数据覆盖后校验当前选中引用是否失效
            if(selectedDormitoryId && !getDormitoryById(selectedDormitoryId)){ selectedDormitoryId=null; selectedFloorId=null; }
            console.log('云端拉取完成：新增 '+result.added+' 条，更新 '+result.updated+' 条，清理 '+result.removed+' 条，云端共 '+cloudRecords.length+' 条'+(isV2?'（v2.0 全量'+(result.basicChanged?'，基础数据已更新':'）'):''));
            result.cloudRecordIds = cloudRecords.map(function(r){ return String(r.id); });
            return result;
        });
    }
    /**
     * 应用数据初始化总入口（DOMContentLoaded 后由 app.js 调用）。
     * 流程：本地有存档则载入、否则 initDatabase 建默认库 → ensureCorrectUsers
     * 补齐账号 → ensureSyncMeta/repairBasicData 本地自愈 → 云端启用则创建
     * Supabase 客户端、注册 online 自动重试 → detectV3Schema 探测表版本
     * （V3 先迁移旧数据或全量标脏）→ loadFromCloud 首次拉取合并 → 拉后
     * 再自愈 + migrateUserPasswords 哈希迁移 → 启动上行同步 → checkSavedLogin
     * 恢复会话。任何一步失败都不阻断本地功能（降级为单机模式）。
     * @returns {Promise} 初始化完成（无论云端是否可用）
     */
    function initializeData() {
        // 【绑定主控设备·强制从云端拉取】识别标志：
        //   用户在数据管理页点了"将当前设备设为主控设备"后，会写入此标志。
        //   本次启动强制走"空库 → 从云端拉取"流程，彻底丢弃本地旧缓存，
        //   避免旧数据被当成"主控设备本地宝贵数据"而上传污染云端。
        var forcePull = false;
        try {
            forcePull = localStorage.getItem('dorm_force_pull_from_cloud') === 'true';
            if(forcePull) localStorage.removeItem('dorm_force_pull_from_cloud');
        } catch(e) {}
        var boot;
        if(forcePull){
            console.log('[绑定主控] 检测到强制拉取标志，清空本地后从云端重新下载');
            initEmptyDB();
            boot = Promise.resolve();
        } else {
            // 正常启动：本地有存档则加载，否则创建默认数据库
            // initDatabase/ensureCorrectUsers 为异步（含密码哈希计算），先等待其完成再继续初始化
            boot = loadDBFromLocal() ? Promise.resolve() : initDatabase();
        }
        return boot.then(function(){ return ensureCorrectUsers(); }).then(function(){
        // DB 已由 loadDBFromLocal / initDatabase 完成实例化，挂载到 window
        // 确保外部脚本与控制台访问的始终是最新数据库实例
        window.DB = DB;
        ensureSyncMeta();
        // 【历史数据迁移】识别旧版"集体加分派生的个人记录"，补上 autoDerived: true。
        // 幂等：已标记过的记录不会重复处理。迁移后标脏，云端会自动同步新字段。
        try { migrateDerivedDeductionRecords(); } catch(e) { console.warn('[派生迁移] 执行失败：', e); }
        try { migrateMissingDerivedRecords(); } catch(e) { console.warn('[派生补齐迁移] 执行失败：', e); }
        // 基础数据自愈：修复本地被意外清空的楼层/宿舍（无论是否启用云端同步都要执行）
        if(repairBasicData()) saveDBToLocal();
        if (SUPABASE_CONFIG.enabled && SUPABASE_CONFIG.url.indexOf('YOUR_') === -1) {
            syncEnabled = true;
            try {
                supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
                // 网络恢复时自动重试未完成的增量上传（走重试队列）
                window.addEventListener('online', function(){
                    if(syncEnabled&&supabaseClient&&DB){
                        _offlineToastShown=false; // 复位断网提示标志，下次断网可再次提示
                        _applyOfflineUI(false);
                        toast('网络已恢复，正在同步…');
                        ensureSyncMeta();
                        // 【强制先拉后推】网络恢复时先拉取云端合并（溯源清洗丢弃废弃数据），
                        // 再上传本地新增数据；拉取失败（如网络再次中断）则跳过上传，等待下次恢复。
                        loadFromCloud().then(function(){
                            syncWithRetry();
                        }).catch(function(e){
                            console.warn('[online] 拉取云端失败，跳过本次上传：', e);
                            updateSyncStatus('unsynced');
                        });
                    }
                });
                // 断网瞬间即把状态点切为红色（无需等待下一次同步尝试），并启动“离线”标签延时
                window.addEventListener('offline', function(){
                    if(syncEnabled&&supabaseClient&&DB){ updateSyncStatus('unsynced'); }
                });
                // V3：检测表结构版本 + 旧数据迁移
                return detectV3Schema().then(function(ver){
                    if(ver === 3){
                        // 表结构已升级，尝试迁移旧格式数据
                        console.log('[V3] 表结构已是按行存储，尝试迁移旧格式数据...');
                        return migrateOldFormatToRows().then(function(migrateResult){
                            if(migrateResult === 'migrated'){
                                console.log('[V3] 旧格式迁移完成，跳过本地脏标记');
                            } else if(migrateResult === 'empty'){
                                // 仅当云端确认为空表（首次上传）时，才把本地所有记录标记为脏
                                console.log('[V3] 云端 sync_store 为空，将本地全部记录标脏准备首次上传');
                                v3MarkAllLocalDirty();
                            } else {
                                // 云端已有 V3 数据（或查询异常保守跳过）：不标脏，
                                // 避免主控设备每次冷启动把本地旧基础数据无差别覆盖云端
                                console.log('[V3] 云端已有 V3 数据，跳过本地脏标记');
                            }
                            return null;
                        });
                    }
                    console.log('[V3] 表结构未升级，使用 V2 同步（请手动执行 ALTER TABLE SQL）');
                    return null;
                }).then(function(){
                    return loadFromCloud();
                }).then(function(pullResult) {
                    // 基础数据自愈：无论云端拉取成功与否，先修复本地被意外清空的楼层/宿舍
                    // （修复产生的脏记录由下方 syncToCloud 自动补种上传）
                    if(repairBasicData()) saveDBToLocal();
                    if (pullResult) {
                        // 云端优先策略：拉取成功后强制以云端记录集合为权威。
                        // 将本地 syncedRecordIds 替换为云端全部记录ID，清空脏记录，
                        // 确保旧设备的本地旧记录（已同步/已编辑）不会被回灌到云端。
                        // 本地新增记录（不在云端）不在 syncedRecordIds 中，仍会正常上传。
                        if (pullResult.cloudRecordIds) {
                            DB.syncedRecordIds = pullResult.cloudRecordIds.slice();
                        }
                        DB.dirtyRecordIds = [];
                        DB.lastSyncTime = Date.now();
                        saveDBToLocal();
                        checkStorageWarning();
                        console.log('已合并云端数据（新增 '+pullResult.added+' 条，更新 '+pullResult.updated+' 条，清理 '+(pullResult.removed||0)+' 条'+(pullResult.basicChanged?'，基础数据已更新':'')+'，云端共 '+pullResult.total+' 条，云端优先策略已生效）');
                    } else {
                        console.log('云端暂无有效数据，上传本地数据');
                    }
                    // 密码哈希迁移：云端拉回的账号可能仍带旧明文，统一在此升级为哈希并标脏回传云端
                    return migrateUserPasswords().then(function(n){
                        if(n > 0){
                            console.log('[安全] 已将 '+n+' 个账号的明文密码迁移为哈希存储');
                            saveDB(); // 落库并把哈希后的用户行加入上传队列，覆盖云端旧明文
                        }
                    });
                }).then(function(){
                    // 若存在未同步的脏记录，启动重试队列上传
                    if(DB.dirtyRecordIds && DB.dirtyRecordIds.length>0){
                        updateSyncStatus('unsynced');
                        syncWithRetry();
                    } else {
                        updateSyncStatus('synced');
                        syncToCloud();
                    }
                    checkSavedLogin();
                });
            } catch(e) {
                console.error('SDK初始化失败', e);
                syncEnabled = false;
                return migrateUserPasswords().then(function(n){
                    if(n > 0){ console.log('[安全] 已将 '+n+' 个账号的明文密码迁移为哈希存储'); saveDBToLocal(); }
                    checkSavedLogin();
                    return null;
                });
            }
        } else {
            // 未启用云端：迁移后仅保存本地
            return migrateUserPasswords().then(function(n){
                if(n > 0){ console.log('[安全] 已将 '+n+' 个账号的明文密码迁移为哈希存储'); saveDBToLocal(); }
                checkSavedLogin();
            });
        }
        });
    }
    /**
     * 统一保存入口：所有业务数据修改后都应调用本函数。
     * 动作：先同步落本地（saveDBToLocal），再触发云端增量上行（syncWithRetry）。
     * 与 saveDBToLocal 的区别：本函数是"落库 + 同步"的完整保存，
     * saveDBToLocal 只写本地（同步流程内部使用，避免回环）。
     */
    function saveDB() {
        saveDBToLocal();
        if (syncEnabled && supabaseClient) syncWithRetry();
    }
    /**
     * 手动同步（顶栏 🔄 按钮）：先拉取后推送，并给出完整 toast 反馈。
     * 离线时入重试队列并提示；busy 标志防重复点击；先拉后推保证拉取时
     * 补种的脏记录随本次推送一起上传；拉取后先迁移明文密码再推送；
     * 上传失败绝不误报"同步完成"，保留脏标记并入重试队列；
     * 检测到重置窗口（aborted）提示稍后再试，检测到版本重置（reset）刷新界面。
     */
    /**
     * 手动同步入口（点"同步"按钮触发）。
     * 【版本双重检测机制·手动同步入口】函数最开头（manualSync._busy 判断之前）
     * 先经 checkLatestVersion() 强制比对版本：
     *   - 版本落后 → 醒目 toast + checkLatestVersion 内部已安排 1.2 秒强制刷新，立即阻断同步；
     *   - 断网 → checkLatestVersion 直接放行（离线同步不污染云端），走离线入队分支；
     *   - 版本一致 → 执行 manualSyncInner 原有同步逻辑。
     * @returns {Promise<boolean>}
     */
    function manualSync(){
        return checkLatestVersion().then(function(verOk){
            if(!verOk){
                toast('⚠️ 系统已更新，当前版本过旧，为保护数据安全已阻断同步。即将强制刷新页面，请稍后重试。', 'error');
                return false;
            }
            return manualSyncInner();
        });
    }
    /** manualSync 的原有同步逻辑（版本双重检测通过后执行） */
    function manualSyncInner(){
        if(!syncEnabled||!supabaseClient){toast('云端同步未启用','error');return;}
        // 离线提示：加入重试队列，网络恢复后自动上传
        if(typeof navigator!=='undefined' && navigator.onLine===false){
            toast('当前网络不可用，已加入重试队列，网络恢复后自动上传','error');
            updateSyncStatus('unsynced');
            syncWithRetry();
            return;
        }
        if(manualSync._busy) return;
        manualSync._busy=true;
        var btn=document.getElementById('manualSyncBtn');
        if(btn){btn.textContent='⏳';btn.disabled=true;}
        toast('正在同步...');
        // 先拉后推：V3 拉取时可能对云端缺失的类型补种本地脏记录，
        // 顺序执行可确保补种记录随本次推送一起上传（并发会因推送先收集/后清脏而丢失补种）
        loadFromCloud().then(function(pulled){
            // 拉取后先迁移云端带下来的旧明文密码（幂等），再推送，确保哈希覆盖云端明文
            return migrateUserPasswords().then(function(n){
                if(n > 0){ console.log('[安全] 同步拉取后已将 '+n+' 个账号的明文密码迁移为哈希存储'); saveDBToLocal(); }
                return syncToCloud().then(function(pushed){ return [pulled, pushed]; });
            });
        }).then(function(results){
            manualSync._busy=false;
            if(btn){btn.textContent='🔄';btn.disabled=false;}
            var pulled=results[0], pushed=results[1];
            var added=pulled?pulled.added:0;
            var updated=pulled?pulled.updated:0;
            var removed=pulled?pulled.removed:0;
            var rescued=pulled?pulled.rescued:0;
            var basicChanged=pulled?pulled.basicChanged:false;
            var isReset=pulled?pulled.reset:false;
            var isAborted=pulled?pulled.aborted:false;
            // 重置窗口：云端被清空但正在回传，本次不改动本地，稍候再同步
            if(isAborted){
                if(btn){} // 按钮已复位
                toast('云端正在重置中，本次未改动本地数据，请稍后再点一次同步', 'error');
                syncWithRetry();
                return;
            }
            // 版本重置：本机已整体以下发数据为准重建，刷新全部界面
            if(isReset){ renderTree(); renderView(); }
            // 拉取到新数据时刷新当前视图与树形菜单（无论上传成败，拉取结果都要呈现）
            if(added>0||updated>0||removed>0||rescued>0||basicChanged||isReset){ renderTree(); renderView(); }
            // 拉取可能带来其他设备下发的新通知，同步后刷新顶栏未读角标
            updateNotifBadge();
            if(pushed === false){
                // 上传失败：明确提示，绝不误报“同步完成”；脏标记保留，加入重试队列
                updateSyncStatus('unsynced');
                var pullParts=[];
                if(added>0) pullParts.push('拉取新增 '+added+' 条');
                if(updated>0) pullParts.push('更新 '+updated+' 条');
                var pullMsg = pullParts.length>0 ? '（云端数据已拉取：'+pullParts.join('，')+'）' : '';
                toast('上传失败，请检查网络后重试'+pullMsg, 'error');
                syncWithRetry();
                return;
            }
            if(pulled === null){
                updateSyncStatus('unsynced');
                toast('拉取失败，请检查网络后重试（本地数据已保留）', 'error');
                syncWithRetry();
                return;
            }
            var parts=[];
            if(isReset) parts.push('检测到数据重置，本机已以下发数据为准整体更新');
            if(added>0) parts.push('拉取新增 '+added+' 条');
            if(updated>0) parts.push('更新 '+updated+' 条');
            if(removed>0) parts.push('删除 '+removed+' 条');
            if(rescued>0) parts.push('补种 '+rescued+' 条');
            if(basicChanged) parts.push('基础数据已同步');
            updateSyncStatus('synced');
            toast(parts.length>0?('同步完成：'+parts.join('，')):'同步完成，数据已是最新');
        }).catch(function(e){
            manualSync._busy=false;
            if(btn){btn.textContent='🔄';btn.disabled=false;}
            // 统一错误处理：分类+日志（静默），保留原有自定义提示与自动重试入队
            var detail=handleError(e, '同步数据', { silent: true });
            updateSyncStatus('unsynced');
            toast('同步失败（'+detail+'），已加入重试队列','error');
            syncWithRetry();
        });
    }

    // ==================== 重置云端数据（数据版本号 epoch） ====================
    /**
     * 管理员重置云端数据（危险操作，双重 confirm 确认）。
     * 场景：学期初或数据混乱时，以本机当前数据为唯一基准重建云端。
     * 执行步骤：
     *   1) delete().neq('id',0) 清空 sync_store 全部行（该过滤条件仅为满足
     *      Supabase delete 必须带条件的要求，实际命中全部行）；
     *   2) 本机 DB.syncEpoch 置为当前时间戳（新版本号），清空全部墓碑标记、
     *      v3MarkAllLocalDirty 全量标脏并落本地；
     *   3) syncToCloudV3 全量回传（meta 行携带新 epoch）。
     * 其它设备下次同步检测到 epoch 变化 → loadFromCloudV3 走 hardResetFromCloud
     * 整体丢弃本地、以下发数据重建，旧数据永不回灌；重置窗口期内其它设备
     * 拉到"云端空"会判定 aborted 而不动本地。回传失败时保留现场，点一次
     * 手动同步即可补传完成重置。
     */
    function resetCloudData(){
        if(!IS_MASTER_DEVICE){ toast('当前设备为受限设备，无权限修改基础数据！请在主控设备操作。','error'); return; }
        if(!isAdmin()){ toast('无权限，仅管理员可重置','error'); return; }
        if(!syncEnabled || !supabaseClient){ toast('云端同步未启用','error'); return; }
        if(typeof navigator!=='undefined' && navigator.onLine===false){ toast('当前网络不可用，请联网后再重置','error'); return; }
        var stuCount = (DB.students||[]).length;
        if(!confirm('【重置云端数据 · 危险操作】\n\n' +
                    '将清空云端的全部数据，并以本机当前显示的数据为准重新建立。\n' +
                    '本机现有：学生 '+stuCount+' 名、宿舍 '+(DB.dormitories||[]).length+' 间、账号 '+(DB.users||[]).length+' 个。\n\n' +
                    '其它设备下次点同步时，会整体丢弃本地数据、统一下载这套数据，以前不要的数据不会再同步回来。\n\n' +
                    '请务必先确认本机页面上显示的就是要保留的正确数据！\n\n是否继续？')) return;
        if(!confirm('第二次确认：\n\n1) 云端现有数据将被永久清除，不可恢复；\n2) 请确保其它设备此刻不要点同步（重置约需十几秒）；\n3) 建议在本机先刷新页面并核对数据无误。\n\n确定现在执行重置？')) return;
        if(resetCloudData._busy) return;
        resetCloudData._busy = true;
        var btn = document.getElementById('btnResetCloud');
        if(btn){ btn.disabled = true; btn.textContent = '⏳ 重置中…'; }
        toast('正在清空云端数据，请稍候…');
        var epoch = Date.now();
        // 1) 清空云端全部行（.neq('id',0) 提供 delete 必需的过滤条件，实际命中全部行）
        supabaseClient.from('sync_store').delete().neq('id', 0).then(function(delRes){
            if(delRes.error) throw delRes.error;
            console.log('[重置] 云端全部行已清空，准备回传本机数据，新 epoch=' + epoch);
            // 2) 本机进入新版本：重置旧的删除标记（新数据集中无需墓碑），全量标脏
            DB.syncEpoch = epoch;
            V3_RECORD_TYPES.forEach(function(m){
                DB.dirtyByType[m.type] = {};
                DB.deletedByType[m.type] = {};
            });
            v3MarkAllLocalDirty();
            saveDBToLocal();
            // 3) 全量回传（meta 行携带新 epoch）
            return syncToCloudV3();
        }).then(function(pushed){
            resetCloudData._busy = false;
            if(btn){ btn.disabled = false; btn.textContent = '🔁 重置云端数据（以下发为准）'; }
            if(pushed === false){
                updateSyncStatus('unsynced');
                toast('云端已清空但数据回传失败：请检查网络后点一次 🔄 同步，本机数据会自动补传完成重置', 'error');
                syncWithRetry();
                return;
            }
            updateSyncStatus('synced');
            toast('云端已重置完成：以本机数据为准重新建立。其它设备点一次同步即统一下载（旧数据不会再回来）。主控身份已保留，如需更换设备，请使用绑定密码重新绑定。');
            renderTree(); renderView();
        }).catch(function(err){
            resetCloudData._busy = false;
            if(btn){ btn.disabled = false; btn.textContent = '🔁 重置云端数据（以下发为准）'; }
            // 统一错误处理：分类+日志（静默），保留原有的可操作提示
            var detail=handleError(err, '重置云端数据', { silent: true });
            updateSyncStatus('unsynced');
            toast('重置失败：' + detail + '（若云端已清空，点一次 🔄 同步即可补传）', 'error');
        });
    }


// ---- shared globals explicitly mounted on window ----
// 仅挂载对象引用（supabaseClient 客户端实例、_retryState 重试状态对象），
// 便于外部脚本/控制台访问；syncEnabled 为布尔可变状态，顶层 var 已天然全局，
// 直接以变量名访问即可，无需经 window 中转。
window.supabaseClient = supabaseClient;
window._retryState = _retryState;
