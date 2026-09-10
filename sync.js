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
 * 对外暴露：文件末尾挂载 window.supabaseClient / window.syncEnabled /
 *   window._retryState；函数声明为全局，常用：initializeData / saveDB /
 *   manualSync / resetCloudData / syncWithRetry / loadFromCloud / syncToCloud。
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
        // 遍历所有记录类型，收集脏记录和删除标记
        V3_RECORD_TYPES.forEach(function(meta){
            var dirtySet = (DB.dirtyByType && DB.dirtyByType[meta.type]) || {};
            var deletedSet = (DB.deletedByType && DB.deletedByType[meta.type]) || {};
            // 1) 脏记录：从 DB 读取当前数据，构造 upsert 行
            Object.keys(dirtySet).forEach(function(rid){
                var rec = v3GetRecordById(meta.type, rid);
                if(!rec) return; // 记录不存在了（可能已被删除），交给 deleted 处理
                didAnything = true;
                rows.push(v3BuildUpsertRow(meta.type, rid, rec, false, nowIso));
            });
            // 2) 删除标记：只对已存在的云端记录设置 deleted=true
            Object.keys(deletedSet).forEach(function(rid){
                didAnything = true;
                rows.push(v3BuildUpsertRow(meta.type, rid, null, true, nowIso));
            });
        });
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
                console.warn('[V3] 检测到数据版本变化（本机 epoch='+localEpoch+' → 云端 epoch='+cloudEpoch+'），整体丢弃本地并以下发数据为准重建');
                hardResetFromCloud(byType, cloudEpoch);
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
                var resetCount = 0;
                // meta：dormitoryList + nextIds
                var mLive = grouped['meta'] ? grouped['meta'].find(function(r){ return !r.deleted; }) : null;
                if(mLive && mLive.data){
                    if(Array.isArray(mLive.data.dormitoryList)) DB.dormitoryList = mLive.data.dormitoryList;
                    if(mLive.data.nextIds) DB.nextIds = mLive.data.nextIds;
                }
                // 数组类型：floor / dormitory / student / user + 三类业务记录 + 巡查核实三类记录
                ['floor','dormitory','student','user','deduction_record','leave_record','absence_record','inspection_confirmation','anomaly_report','daily_summary'].forEach(function(type){
                    var tMeta = V3_RECORD_TYPES.find(function(m){ return m.type === type; });
                    if(!tMeta) return;
                    var liveRows = (grouped[type] || []).filter(function(r){ return !r.deleted; }).map(function(r){ return r.data; });
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
                ['hygiene','discipline'].forEach(function(sub){
                    var localArr = (DB.deductionItems && DB.deductionItems[sub]) || [];
                    // 1) 遍历本地项目：云端活行→按云端更新（本地脏除外）；墓碑→删除；无痕迹→标脏保留
                    var kept = [];
                    localArr.forEach(function(item){
                        var rid = String(item.id);
                        if(split.live[rid]){
                            if(!dirtySet[rid]){
                                var cloudData = split.live[rid].data || {};
                                // 剔除辅助字段 _subType 后再比较，避免内容一致却每次虚计“更新”
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
                            result.removed++; // 云端明确删除（墓碑），执行移除
                        } else {
                            // 云端无任何痕迹：疑似遗漏，标脏保留补种
                            if(!dirtySet[rid] && !deletedSet[rid]){ v3MarkDirty(type, item.id); result.rescued++; }
                            kept.push(item);
                        }
                    });
                    // 2) 云端活行中本地没有的 → 新增
                    Object.keys(split.live).forEach(function(rid){
                        var exists = kept.some(function(x){ return String(x.id) === rid; });
                        if(exists || deletedSet[rid]) return;
                        var r = split.live[rid];
                        var st = (r.data && r.data._subType) || ((r.data && r.data.defaultScore <= 0.5) ? 'hygiene' : 'discipline');
                        if(st !== sub) return;
                        var clean = {};
                        Object.keys(r.data || {}).forEach(function(k){ if(k !== '_subType') clean[k] = r.data[k]; });
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
                        arr.push(split.live[rid].data);
                        localMap[rid] = split.live[rid].data;
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
                        result.updated++;
                    }
                });
                // 3) 遍历本地：墓碑→删除；无云端痕迹→标脏保留
                var keptArr = [];
                arr.forEach(function(r){
                    var rid = String(r.id);
                    if(split.tomb[rid] && !dirtySet[rid]){
                        result.removed++;
                        return;
                    }
                    if(!split.live[rid] && !split.tomb[rid] && !dirtySet[rid] && !deletedSet[rid]){
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
            // 合并后重新校准账号
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
     * @returns {Promise<boolean>} true=执行了迁移；false=无旧数据或迁移失败
     */
    function migrateOldFormatToRows(){
        if(!supabaseClient) return Promise.resolve(false);
        // 先查询是否有旧格式数据（id=1，data 非 null）
        return supabaseClient.from('sync_store').select('id,data').eq('id',1).maybeSingle().then(function(res){
            if(res.error){ console.error('[迁移] 查询旧数据失败:', res.error.message); return false; }
            if(!res.data || res.data.data == null){ console.log('[迁移] 云端无旧格式数据，跳过'); return false; }
            var decoded = decodeCloudData(res.data.data);
            if(!decoded || typeof decoded !== 'object'){
                console.log('[迁移] 旧数据无法解析，跳过');
                return false;
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
            if(allRows.length === 0){ console.log('[迁移] 旧数据无有效记录，跳过'); return false; }
            console.log('[迁移] 准备迁移 ' + allRows.length + ' 条记录...');
            // 批量 upsert（与常规同步共用 v3UploadRows），完成后删除旧格式行 id=1
            return v3UploadRows(allRows).then(function(ok){
                if(!ok) return false;
                return supabaseClient.from('sync_store').delete().eq('id',1).then(function(r2){
                    if(r2.error) console.warn('[迁移] 清理旧行失败（可忽略）:', r2.error.message);
                    else console.log('[迁移] 旧格式行已删除');
                    toast('数据格式升级完成');
                    return true;
                });
            });
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
        dot.classList.remove('synced','syncing','unsynced');
        dot.classList.add(state);
        var tips={synced:'已同步',syncing:'同步中…',unsynced:'有未同步数据（点击重试）'};
        dot.title='同步状态：'+(tips[state]||'');
    }
    // 重试状态：指数退避 5s→10s→20s→40s→60s（封顶），最多 5 次
    var _retryState={attempt:0, timer:null, running:false};
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
        if(_retryState.running) return Promise.resolve(false); // 防重入
        _retryState.running=true;
        _retryState.attempt=0;
        clearRetryTimer();
        function doAttempt(){
            updateSyncStatus('syncing');
            // 离线：不立即重试，等 online 事件触发
            if(typeof navigator!=='undefined' && navigator.onLine===false){
                updateSyncStatus('unsynced');
                _retryState.running=false;
                return Promise.resolve(false);
            }
            return syncToCloud().then(function(ok){
                if(ok){
                    updateSyncStatus('synced');
                    _retryState.attempt=0;
                    _retryState.running=false;
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
        // initDatabase/ensureCorrectUsers 为异步（含密码哈希计算），先等待其完成再继续初始化
        var boot = loadDBFromLocal() ? Promise.resolve() : initDatabase();
        return boot.then(function(){ return ensureCorrectUsers(); }).then(function(){
        ensureSyncMeta();
        // 基础数据自愈：修复本地被意外清空的楼层/宿舍（无论是否启用云端同步都要执行）
        if(repairBasicData()) saveDBToLocal();
        if (SUPABASE_CONFIG.enabled && SUPABASE_CONFIG.url.indexOf('YOUR_') === -1) {
            syncEnabled = true;
            try {
                supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
                // 网络恢复时自动重试未完成的增量上传（走重试队列）
                window.addEventListener('online', function(){ if(syncEnabled&&supabaseClient&&DB){ ensureSyncMeta(); syncWithRetry(); } });
                // V3：检测表结构版本 + 旧数据迁移
                return detectV3Schema().then(function(ver){
                    if(ver === 3){
                        // 表结构已升级，尝试迁移旧格式数据
                        console.log('[V3] 表结构已是按行存储，尝试迁移旧格式数据...');
                        return migrateOldFormatToRows().then(function(migrated){
                            if(migrated){
                                console.log('[V3] 旧格式迁移完成，跳过本地脏标记');
                            } else {
                                // 没有旧数据可迁（云端原本就是空的）：把本地所有记录标记为脏
                                v3MarkAllLocalDirty();
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
    function manualSync(){
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
            toast('云端已重置完成：以本机数据为准重新建立。其它设备点一次同步即统一下载（旧数据不会再回来）');
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
window.supabaseClient = supabaseClient;
window.syncEnabled = syncEnabled;
window._retryState = _retryState;
