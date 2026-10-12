/* Pure study-history and GPT result rules shared by the page and node:test. */
(function (root) {
  const MAX_RECENT = 10;
  function deriveStreak(results) { let n=0; for(let i=results.length-1;i>=0&&results[i]===true;i--) n++; return n; }
  function defaultState() { return {studyCount:0,correctCount:0,recentResults:[],currentStreak:0,lastStudiedAt:null}; }
  function readJson(storage,key,fallback) { try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function normalizeGptSessionRecords(raw, registeredRaw=[]) {
    const pending={}, registered=new Set(Array.isArray(registeredRaw)?registeredRaw.filter(id=>typeof id==="string"):[]);
    const source=raw&&typeof raw==="object"?raw:{};
    for(const [id,record] of Object.entries(source)) {
      if(record?.applied===true) registered.add(id);
      else if(record&&typeof record==="object") {
        pending[id]={createdAt:record.createdAt||null,ids:Array.isArray(record.ids)?record.ids.map(String):[]};
        if(Object.prototype.hasOwnProperty.call(record,"context"))pending[id].context=normalizeGptIssueContext(record.context);
      }
    }
    return {gptSessions:pending,registeredGptSessionIds:[...registered]};
  }
  function loadCore(storage, snapshotKey, legacyKeys) {
    const snapshot=readJson(storage,snapshotKey,null);
    const legacy={state:readJson(storage,legacyKeys.stateKey,{}),gptSessions:readJson(storage,legacyKeys.gptSessionsKey,{}),activeSession:readJson(storage,legacyKeys.activeSessionKey,null)};
    const has=(key)=>Object.prototype.hasOwnProperty.call(snapshot||{},key);
    if(!snapshot||typeof snapshot!=="object"||!snapshot.state||typeof snapshot.state!=="object"||
      !snapshot.gptSessions||typeof snapshot.gptSessions!=="object"||!has("activeSession")||
      (snapshot.activeSession!==null&&typeof snapshot.activeSession!=="object")) {
      const normalized=normalizeGptSessionRecords(legacy.gptSessions);
      const result={...legacy,...normalized};Object.defineProperty(result,"gptSessionMigrationNeeded",{value:true});return result;
    }
    const normalized=normalizeGptSessionRecords(snapshot.gptSessions,snapshot.registeredGptSessionIds);
    const migrationNeeded=!has("registeredGptSessionIds")||JSON.stringify(normalized.gptSessions)!==JSON.stringify(snapshot.gptSessions)||
      JSON.stringify(normalized.registeredGptSessionIds)!==JSON.stringify(snapshot.registeredGptSessionIds);
    const result={state:snapshot.state,...normalized,activeSession:snapshot.activeSession};
    Object.defineProperty(result,"gptSessionMigrationNeeded",{value:migrationNeeded});return result;
  }
  function saveCore(storage, snapshotKey, snapshot) {
    const normalized=normalizeGptSessionRecords(snapshot.gptSessions,snapshot.registeredGptSessionIds);
    storage.setItem(snapshotKey,JSON.stringify({state:snapshot.state,gptSessions:normalized.gptSessions,
      registeredGptSessionIds:normalized.registeredGptSessionIds,activeSession:snapshot.activeSession}));
  }
  function saveCoreTransition(storage,snapshotKey,snapshot,writes=[]) {
    const backup=writes.map(write=>({key:write.key,value:storage.getItem(write.key)}));
    try {
      for(const write of writes) {
        if(write.remove)storage.removeItem(write.key);
        else storage.setItem(write.key,String(write.value));
      }
      saveCore(storage,snapshotKey,snapshot);
    } catch(error) {
      const rollbackErrors=[];
      for(const prior of backup.reverse())try{if(prior.value===null)storage.removeItem(prior.key);else storage.setItem(prior.key,prior.value)}catch(rollbackError){rollbackErrors.push(rollbackError)}
      if(rollbackErrors.length)error.message=`${error.message} (関連キーの復元にも失敗しました: ${rollbackErrors.map(e=>e.message).join("; ")})`;
      throw error;
    }
  }
  function normalizePreferences(raw={},legacyView={}) {
    const pageSize=[10,20,50,100].includes(Number(raw.pageSize))?Number(raw.pageSize):10;
    const storedThreshold=Number(raw.masteryThreshold),oldThreshold=Number(legacyView.excludeStreakN||3);
    const masteryThreshold=[2,3,4,5].includes(storedThreshold)?storedThreshold:Number.isFinite(oldThreshold)?Math.min(5,Math.max(2,oldThreshold)):3;
    const defaultAnswer=raw.defaultAnswer==="correct"?"correct":"wrong";
    const gptWordCount=[5,10,20,30,50].includes(Number(raw.gptWordCount))?Number(raw.gptWordCount):20;
    return {pageSize,masteryThreshold,defaultAnswer,gptWordCount};
  }
  function selectGptWords(words,state,{sortMode="normal",randomIds=[],startId,excludeStreak=false,masteryThreshold=3,count=20}={}) {
    if(!Array.isArray(words)||!Array.isArray(randomIds))throw new TypeError("GPT出題対象の単語順が不正です。");
    const ids=words.map(word=>String(word.id));
    if(ids.some(id=>id==="undefined"||id==="null")||new Set(ids).size!==ids.length)throw new Error("単語IDは一意である必要があります。");
    const validCount=[5,10,20,30,50].includes(Number(count))?Number(count):20;
    const byId=new Map(words.map(word=>[String(word.id),word]));
    let ordered=words;
    if(sortMode==="random"){
      const order=randomIds.map(String);
      if(new Set(order).size!==order.length)throw new Error("保存済みランダム順に重複IDがあります。");
      ordered=order.map(id=>byId.get(id)).filter(Boolean);
    }
    const start=ordered.findIndex(word=>String(word.id)===String(startId));
    if(start<0)return [];
    const selected=[],selectedIds=new Set();
    for(let index=start;index<ordered.length&&selected.length<validCount;index++){
      const word=ordered[index],id=String(word.id),st=state?.[id]||defaultState();
      if(selectedIds.has(id))continue;
      if(excludeStreak&&(st.currentStreak||0)>=masteryThreshold)continue;
      selected.push(word);selectedIds.add(id);
    }
    return selected;
  }
  function fingerprint(value) {
    const text=JSON.stringify(value);let a=0x811c9dc5,b=0x9e3779b9;
    for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);a=Math.imul(a^code,0x01000193);b=Math.imul(b^code,0x85ebca6b)}
    return`${(a>>>0).toString(16).padStart(8,"0")}${(b>>>0).toString(16).padStart(8,"0")}`;
  }
  function normalizeGptIssueContext(raw) {
    if(!raw||typeof raw!=="object"||raw.version!==1||!['normal','random'].includes(raw.sortMode)||
      typeof raw.startId!=="string"||!Number.isInteger(raw.startIndex)||raw.startIndex<0||
      ![10,20,50,100].includes(raw.pageSize)||typeof raw.excludeStreak!=="boolean"||
      ![2,3,4,5].includes(raw.masteryThreshold)||!Number.isInteger(raw.wordCount)||raw.wordCount<1||raw.startIndex>=raw.wordCount||
      !Array.isArray(raw.targetPositions)||!raw.targetPositions.length||raw.targetPositions.some(n=>!Number.isInteger(n)||n<0||n>=raw.wordCount)||
      ![raw.csvOrderFingerprint,raw.orderFingerprint,raw.contentFingerprint].every(v=>typeof v==="string"&&/^[0-9a-f]{16}$/.test(v)))return null;
    return{version:1,sortMode:raw.sortMode,startId:raw.startId,startIndex:raw.startIndex,pageSize:raw.pageSize,
      excludeStreak:raw.excludeStreak,masteryThreshold:raw.masteryThreshold,wordCount:raw.wordCount,
      csvOrderFingerprint:raw.csvOrderFingerprint,orderFingerprint:raw.orderFingerprint,
      contentFingerprint:raw.contentFingerprint,targetPositions:[...raw.targetPositions]};
  }
  function orderedWords(words,sortMode,randomIds) {
    if(!Array.isArray(words)||!Array.isArray(randomIds)||!['normal','random'].includes(sortMode))return null;
    const ids=words.map(w=>String(w?.id));if(ids.some(id=>id==="undefined"||id==="null")||new Set(ids).size!==ids.length)return null;
    if(sortMode==="normal")return words;
    const order=randomIds.map(String);if(order.length!==ids.length||new Set(order).size!==order.length||order.some(id=>!ids.includes(id)))return null;
    const byId=new Map(words.map(w=>[String(w.id),w]));return order.map(id=>byId.get(id));
  }
  function createGptIssueContext(words,{sortMode="normal",randomIds=[],startId,pageSize=10,excludeStreak=false,masteryThreshold=3,ids=[]}={}) {
    const order=orderedWords(words,sortMode,randomIds);if(!order)throw new Error("GPT発行時の単語順序が不正です。");
    const startIndex=order.findIndex(w=>String(w.id)===String(startId));if(startIndex<0)throw new Error("GPT発行時の開始単語が見つかりません。");
    if(![10,20,50,100].includes(Number(pageSize)))throw new Error("GPT発行時のページ語数が不正です。");
    const positionById=new Map(order.map((w,i)=>[String(w.id),i])),targetIds=ids.map(String);
    if(!targetIds.length||new Set(targetIds).size!==targetIds.length||targetIds.some(id=>!positionById.has(id))||
      targetIds.some((id,i)=>i&&positionById.get(id)<=positionById.get(targetIds[i-1])))throw new Error("GPT発行対象と出題順序が一致しません。");
    const csvIds=words.map(w=>String(w.id));
    const content=words.map(w=>[String(w.id),String(w.word??""),String(w.meaning??"")]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
    return normalizeGptIssueContext({version:1,sortMode,startId:String(startId),startIndex,pageSize:Number(pageSize),excludeStreak:!!excludeStreak,
      masteryThreshold:[2,3,4,5].includes(Number(masteryThreshold))?Number(masteryThreshold):3,wordCount:words.length,
      csvOrderFingerprint:fingerprint(csvIds),orderFingerprint:fingerprint(order.map(w=>String(w.id))),contentFingerprint:fingerprint(content),
      targetPositions:targetIds.map(id=>positionById.get(id))});
  }
  function buildGptJumpView(view,pageSize,randomIds) {
    if(!view||typeof view!=="object")return null;
    return{...view,pageSize,randomIds:Array.isArray(randomIds)?[...randomIds]:null};
  }
  function evaluateGptJump(record,currentWords,currentView,results,currentState={}) {
    const context=record&&Object.prototype.hasOwnProperty.call(record,"context")?normalizeGptIssueContext(record.context):null;
    const out={canJump:false,reason:!record||!Object.prototype.hasOwnProperty.call(record,"context")?"legacy-no-context":context?"no-practical-result":"invalid-context",
      issuedMode:context?.sortMode||null,currentMode:currentView?.sortMode||null,orderPreserved:false,modeChanged:!!context&&context.sortMode!==currentView?.sortMode,
      requiresModeRestore:!!context&&context.sortMode!==currentView?.sortMode,lastResultId:null,candidatePosition:null};
    if(!context)return out;
    if(!currentView||!['normal','random'].includes(currentView.sortMode)){out.reason="invalid-view";return out}
    const ids=Array.isArray(record.ids)?record.ids.map(String):[];
    if(!ids.length||ids.length!==context.targetPositions.length||new Set(ids).size!==ids.length||context.targetPositions.some((p,i)=>p>=context.wordCount||(i&&p<=context.targetPositions[i-1]))){out.reason="invalid-context";return out}
    if(!Array.isArray(currentWords)||currentWords.length!==context.wordCount){out.reason="dataset-changed";return out}
    const csvIds=currentWords.map(w=>String(w?.id));if(csvIds.some(id=>id==="undefined"||id==="null")||new Set(csvIds).size!==csvIds.length){out.reason="invalid-dataset";return out}
    if(fingerprint(csvIds)!==context.csvOrderFingerprint){out.reason="csv-order-changed";return out}
    const content=currentWords.map(w=>[String(w.id),String(w.word??""),String(w.meaning??"")]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
    if(fingerprint(content)!==context.contentFingerprint){out.reason="content-changed";return out}
    const order=orderedWords(currentWords,context.sortMode,currentView?.randomIds||[]);if(!order){out.reason="invalid-order";return out}
    if(fingerprint(order.map(w=>String(w.id)))!==context.orderFingerprint){out.reason="order-changed";return out}
    if(ids.some((id,i)=>String(order[context.targetPositions[i]]?.id)!==id)){out.reason="invalid-context";return out}
    out.orderPreserved=true;
    const resultById=new Map();if(!Array.isArray(results)){out.reason="invalid-results";return out}
    for(const result of results){if(!result||typeof result.id!=="string"||!ids.includes(result.id)||!['correct','wrong','uncertain','skipped'].includes(result.result)||resultById.has(result.id)){out.reason="invalid-results";return out}resultById.set(result.id,result.result)}
    let lastIndex=-1;for(let i=0;i<ids.length;i++)if(resultById.has(ids[i])&&resultById.get(ids[i])!=="skipped")lastIndex=i;
    if(lastIndex<0){out.reason="no-practical-result";return out}
    const id=ids[lastIndex],position=context.targetPositions[lastIndex],size=Number(currentView?.pageSize);
    out.lastResultId=id;
    if(![10,20,50,100].includes(size)){out.reason="invalid-page-size";return out}
    const candidate=context.sortMode==="random"?{sortMode:"random",randomStart:Math.floor(position/size)*size,wordIndex:position,pageIndex:null}:
      {sortMode:"normal",pageIndex:Math.floor(position/size),randomStart:null,wordIndex:position};
    const st=currentState?.[id]||defaultState();
    if(currentView?.filter&&currentView.filter!=="all") {out.reason="filtered-view";return out}
    if(currentView?.excludeStreak&&(st.currentStreak||0)>=Number(currentView.masteryThreshold||3)){out.reason="target-filtered";return out}
    out.canJump=true;out.reason="ok";out.candidatePosition=candidate;return out;
  }
  function buildPageModel(words,state,{pageSize=50,sortMode="normal",randomIds=[],filter="all",excludeStreak=false,masteryThreshold=3}={}) {
    const passes=word=>{
      const st=state[String(word.id)]||defaultState();
      if(filter==="hasMiss"&&Math.max(0,(st.studyCount||0)-(st.correctCount||0))<=0)return false;
      if(excludeStreak&&(st.currentStreak||0)>=masteryThreshold)return false;
      return true;
    };
    const size=[10,20,50,100].includes(Number(pageSize))?Number(pageSize):50;
    if(sortMode==="random") {
      const rank=new Map(randomIds.map((id,i)=>[String(id),i]));
      const ordered=words.filter(passes).slice().sort((a,b)=>(rank.get(String(a.id))??Number.MAX_SAFE_INTEGER)-(rank.get(String(b.id))??Number.MAX_SAFE_INTEGER));
      const numbered=ordered.map((word,index)=>({...word,displayNumber:index+1})),pages=[];
      for(let i=0;i<numbered.length;i+=size)pages.push({index:pages.length,start:i+1,end:Math.min(i+size,numbered.length),entries:numbered.slice(i,i+size)});
      return {pages,total:numbered.length,sortMode};
    }
    const pages=[];let total=0;
    for(let offset=0;offset<words.length;offset+=size) {
      const end=Math.min(offset+size,words.length),entries=[];
      for(let i=offset;i<end;i++)if(passes(words[i]))entries.push({...words[i],displayNumber:i+1});
      total+=entries.length;pages.push({index:pages.length,start:offset+1,end,entries});
    }
    return {pages,total,sortMode};
  }
  function buildRandomFixedPage(words,state,{pageSize=50,randomIds=[],filter="all",excludeStreak=false,masteryThreshold=3,startIndex=0}={}) {
    const size=[10,20,50,100].includes(Number(pageSize))?Number(pageSize):50;
    const rank=new Map(randomIds.map((id,index)=>[String(id),index]));
    const ordered=words.slice().sort((a,b)=>(rank.get(String(a.id))??Number.MAX_SAFE_INTEGER)-(rank.get(String(b.id))??Number.MAX_SAFE_INTEGER));
    const start=normalizeRandomStart(startIndex,ordered.length),end=Math.min(start+size,ordered.length);
    const entries=[];
    for(let index=start;index<end;index++) {
      const word=ordered[index],st=state[String(word.id)]||defaultState();
      if(filter==="hasMiss"&&Math.max(0,(st.studyCount||0)-(st.correctCount||0))<=0)continue;
      if(excludeStreak&&(st.currentStreak||0)>=masteryThreshold)continue;
      entries.push({...word,displayNumber:index+1});
    }
    return {sortMode:"random",startIndex:start,endIndex:end,total:ordered.length,entries};
  }
  function normalizeRandomStart(value,total) {
    const length=Number.isFinite(Number(total))?Math.max(0,Math.floor(Number(total))):0;
    const requested=Number(value),offset=Number.isFinite(requested)?Math.max(0,Math.floor(requested)):0;
    return Math.min(offset,length?length-1:0);
  }
  function randomPageNavigation(page,totalWords) {
    const total=Math.max(0,Math.floor(Number(totalWords)||0));
    const start=Number(page?.startIndex),end=Number(page?.endIndex),length=Number(page?.total);
    if(!total||!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(length)||length<=0||end<=start)return{canNext:false,canReshuffle:false,nextStart:null};
    const atEnd=end>=length;
    return{canNext:!atEnd,canReshuffle:atEnd,nextStart:atEnd?null:end};
  }
  function safeRevealBoundary(studiedIds,cells,height) {
    if(!Array.isArray(cells)||!cells.length||!Number.isFinite(height)||height<0)return 0;
    const studied=new Set(Array.isArray(studiedIds)?studiedIds.map(String):[]);
    const firstUnstudied=cells.find(cell=>!studied.has(String(cell.id)));
    const boundary=firstUnstudied?Number(firstUnstudied.top):height;
    return Number.isFinite(boundary)?Math.max(0,Math.min(boundary,height)):0;
  }
  function normalizeView(raw={},randomTotal=0) {
    const threshold=Number(raw.masteryThreshold??raw.excludeStreakN),page=Number(raw.pageIndex);
    return{filter:raw.filter==="hasMiss"?"hasMiss":"all",sortMode:raw.sortMode==="random"?"random":"normal",
      excludeStreak:!!raw.excludeStreak,masteryThreshold:[2,3,4,5].includes(threshold)?threshold:3,
      pageIndex:Number.isFinite(page)?Math.max(0,Math.floor(page)):0,randomStart:normalizeRandomStart(raw.randomStart,randomTotal)};
  }
  function serializeView(view={}) {
    const normalized=normalizeView(view,Number.MAX_SAFE_INTEGER);
    return{filter:normalized.filter,sortMode:normalized.sortMode,excludeStreak:normalized.excludeStreak,
      excludeStreakN:normalized.masteryThreshold,pageIndex:normalized.pageIndex,randomStart:normalized.randomStart};
  }
  function studySessionKey(view,pageSize) {
    const position=view.sortMode==="random"?`random:${view.randomStart}`:`normal:${view.pageIndex}`;
    return`${view.filter}:${view.excludeStreak?view.masteryThreshold:"off"}:${view.sortMode}:${pageSize}:${position}`;
  }
  function sameOrderedIds(left,right) {
    return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((id,index)=>String(id)===String(right[index]));
  }
  function safePageIndex(pages,desired=0) {
    if(!pages.length)return 0;
    const index=Math.min(Math.max(0,Math.floor(Number(desired)||0)),pages.length-1);
    if(pages[index].entries.length)return index;
    const available=pages.find(page=>page.entries.length);
    return available?available.index:0;
  }
  function tryRestoreSession(stored,{now,ttl,currentKey,legacyKey,filter="all",sortMode="normal",pageIndex=0,excludeStreak=false,masteryThreshold=3,legacyThreshold=3,words=[],state={},randomIds=[],currentPageIds=[]}={}) {
    if(sessionExpired(stored,now,ttl))return null;
    if(typeof stored?.sessionId!=="string"||!stored.sessionId||!Number.isFinite(Number(stored.updatedAt))||!Number.isFinite(Number(stored.revealY||0)))return null;
    const visibleIds=currentPageIds.map(String);
    if(new Set(visibleIds).size!==visibleIds.length)return null;
    if(Array.isArray(stored?.targetIds)) {
      if(new Set(stored.targetIds.map(String)).size!==stored.targetIds.length)return null;
      if(!sameOrderedIds(stored.targetIds,visibleIds))return null;
    } else if(stored?.key===currentKey)return null;
    const studied=stored?.studiedIds,checked=stored?.checkedIds,finalized=stored?.finalizedIds;
    if(!Array.isArray(studied)||!Array.isArray(checked)||!Array.isArray(finalized))return null;
    const target=new Set(visibleIds),known=id=>target.has(String(id));
    if(studied.some(id=>!known(id))||checked.some(id=>!known(id))||finalized.some(id=>!known(id)))return null;
    if(new Set(studied.map(String)).size!==studied.length||new Set(checked.map(String)).size!==checked.length||new Set(finalized.map(String)).size!==finalized.length)return null;
    if(checked.some(id=>!studied.map(String).includes(String(id)))||finalized.some(id=>!studied.map(String).includes(String(id))))return null;
    if(stored?.key===currentKey)return {...stored};
    if(stored?.key!==legacyKey)return null;
    if(excludeStreak&&Number(masteryThreshold)!==Number(legacyThreshold))return null;

    let legacyWords=words.filter(word=>{
      const st=state[String(word.id)]||defaultState();
      if(filter==="hasMiss"&&Math.max(0,(st.studyCount||0)-(st.correctCount||0))<=0)return false;
      if(excludeStreak&&(st.currentStreak||0)>=masteryThreshold)return false;
      return true;
    });
    if(sortMode==="random") {
      const ids=words.map(word=>String(word.id));
      if(!Array.isArray(randomIds)||randomIds.length!==ids.length||new Set(randomIds.map(String)).size!==ids.length||!randomIds.every(id=>ids.includes(String(id))))return null;
      const rank=new Map(randomIds.map((id,index)=>[String(id),index]));
      legacyWords=legacyWords.slice().sort((a,b)=>rank.get(String(a.id))-rank.get(String(b.id)));
    }
    const oldIndex=Number(pageIndex);
    if(!Number.isInteger(oldIndex)||oldIndex<0)return null;
    const legacyIds=legacyWords.slice(oldIndex*50,(oldIndex+1)*50).map(word=>String(word.id));
    if(legacyIds.length!==visibleIds.length||legacyIds.some((id,index)=>id!==visibleIds[index]))return null;

    return {...stored,key:currentKey,studiedIds:[...studied],checkedIds:[...checked],finalizedIds:[...finalized]};
  }
  function displayChangePlan(before,after,desiredIndex) {
    const oldIndex=safePageIndex(before.pages,desiredIndex),newIndex=safePageIndex(after.pages,desiredIndex);
    const oldIds=before.pages[oldIndex]?.entries.map(w=>String(w.id))||[],newIds=after.pages[newIndex]?.entries.map(w=>String(w.id))||[];
    return {pageIndex:newIndex,targetChanged:oldIds.length!==newIds.length||oldIds.some((id,i)=>id!==newIds[i])};
  }
  function parseCsv(text) {
    const rows=[];let row=[],field="",quote=false;
    for(let i=0;i<text.length;i++) {
      const c=text[i],n=text[i+1];
      if(quote){if(c==='"'&&n==='"'){field+='"';i++;}else if(c==='"')quote=false;else field+=c;}
      else if(c==='"')quote=true;else if(c===","){row.push(field);field="";}else if(c==="\n"){row.push(field);rows.push(row);row=[];field="";}else if(c!=="\r")field+=c;
    }
    row.push(field);rows.push(row);
    return rows.filter(r=>r.some(v=>v.trim()!==""));
  }
  function parseWordCsv(text) {
    const rows=parseCsv(text);
    if(rows.length<2)throw new Error("CSVにデータ行がありません。");
    const header=rows[0].map(s=>s.trim().toLowerCase());
    const idI=header.indexOf("id"),wordI=header.indexOf("word"),meaningI=header.indexOf("meaning");
    if(idI<0||wordI<0||meaningI<0)throw new Error("ヘッダーは id,word,meaning が必要です。");
    const seen=new Set();
    return rows.slice(1).map((r,idx)=>{
      const id=(r[idI]??"").trim(),word=(r[wordI]??"").trim(),meaning=(r[meaningI]??"").trim();
      if(!id||!word)throw new Error(`${idx+2}行目: id と word は必須です。`);
      if(seen.has(id))throw new Error(`id が重複しています: ${id}`);
      seen.add(id);return{id,word,meaning};
    });
  }
  function normalizeState(raw) {
    const recent=Array.isArray(raw?.recentResults)?raw.recentResults.slice(-MAX_RECENT).map(Boolean):[];
    return {studyCount:Number(raw?.studyCount||0),correctCount:Number(raw?.correctCount||0),recentResults:recent,
      currentStreak:Number.isFinite(Number(raw?.currentStreak))?Number(raw.currentStreak):deriveStreak(recent),lastStudiedAt:raw?.lastStudiedAt||null};
  }
  function formatRecentResults(results,slots=5) {
    const count=Math.max(0,Math.floor(Number(slots)||0));
    const recent=Array.isArray(results)&&count?results.slice(-count).map(value=>value?"○":"×"):[];
    return [...Array(Math.max(0,count-recent.length)).fill("-"),...recent].join(" ");
  }
  function buildHistoryPreview(results,provisionalAnswer=null) {
    const hasPreview=provisionalAnswer!==null&&provisionalAnswer!==undefined,slots=hasPreview?4:5;
    const recent=Array.isArray(results)?results.slice(-slots).map(Boolean):[];
    const history=[...Array(Math.max(0,slots-recent.length)).fill(null),...recent].map(result=>({result,provisional:false}));
    if(hasPreview)history.push({result:!!provisionalAnswer,provisional:true});
    return history;
  }
  function appendResult(st, value) { const correct=!!value; st.recentResults=[...(st.recentResults||[]),correct].slice(-MAX_RECENT); st.currentStreak=correct?(st.currentStreak||0)+1:0; }
  function recordStudy(session,id,st,at=new Date().toISOString(),defaultAnswer="wrong") {
    if(session.studiedIds.includes(id)) return false;
    st.studyCount+=1; st.lastStudiedAt=at; session.studiedIds.push(id);
    if(defaultAnswer==="correct"&&!session.checkedIds.includes(id))session.checkedIds.push(id);
    return true;
  }
  function isStudySessionComplete(session,targetIds) {
    if(!Array.isArray(targetIds)||targetIds.length===0)return false;
    const studied=new Set((session?.studiedIds||[]).map(String));
    return targetIds.every(id=>studied.has(String(id)));
  }
  function repeatStudyAction(session,targetIds) {
    if(!Array.isArray(targetIds)||targetIds.length===0)return "empty";
    return isStudySessionComplete(session,targetIds)?"restart":"confirm";
  }
  function setSessionAnswer(session,id,checked) {
    if(!session.studiedIds.includes(id)||session.finalizedIds.includes(id)) return false;
    const index=session.checkedIds.indexOf(id);
    if(checked&&index<0) session.checkedIds.push(id);
    else if(!checked&&index>=0) session.checkedIds.splice(index,1);
    else return false;
    return true;
  }
  function finalizeStudySession(session, getState) {
    for (const id of session.studiedIds) if (!session.finalizedIds.includes(id)) {
      const correct=session.checkedIds.includes(id), st=getState(id);
      if(correct) st.correctCount+=1;
      appendResult(st,correct); session.finalizedIds.push(id);
    }
  }
  function finalizeSessionDraft(state,session) {
    const nextState=JSON.parse(JSON.stringify(state||{})),nextSession=session?JSON.parse(JSON.stringify(session)):null;
    if(nextSession)finalizeStudySession(nextSession,id=>nextState[id]=normalizeState(nextState[id]||defaultState()));
    return{state:nextState,activeSession:null,finalizedIds:nextSession?.finalizedIds||[]};
  }
  function sessionExpired(session, now, ttl) { return now-Number(session?.updatedAt||0)>ttl; }
  function inspectGptResults(obj, sessions, registeredIds, knownIds) {
    if(obj.version!==1||typeof obj.sessionId!=="string"||!obj.sessionId||!Array.isArray(obj.results)) throw new Error("結果JSONの形式が不正です。");
    const sessionId=String(obj.sessionId),record=sessions?.[sessionId],isReplay=(registeredIds||[]).includes(sessionId);
    if(!record&&!isReplay) throw new Error("発行済みのGPTセッションが見つかりません。");
    const allowed=new Set((record?.ids||[]).map(String)), known=new Set(knownIds.map(String)), seen=new Set();
    const results=obj.results.map(r=>{
      if(!r||typeof r!=="object"||typeof r.id!=="string") throw new Error("結果JSONの形式が不正です。");
      const id=r.id;
      if(seen.has(id)) throw new Error(`単語IDが重複しています: ${id}`); seen.add(id);
      if(!known.has(id)||(!isReplay&&!allowed.has(id))) throw new Error(`対象外の単語IDです: ${id}`);
      if(!["correct","wrong","uncertain","skipped"].includes(r.result)) throw new Error(`未知のresult: ${r.result}`);
      return {id,result:r.result};
    });
    return {results,isReplay};
  }
  function validateGptResults(obj, record, knownIds) {
    if(record?.applied) throw new Error("このGPTセッションは登録済みです。再登録の確認が必要です。");
    return inspectGptResults(obj,record?{[String(obj.sessionId)]:record}:{},[],knownIds).results;
  }
  function applyGptResults(obj,sessions,knownIds,state,now=new Date().toISOString(),activeSession=null,getState=id=>state[id],registeredIds=[],allowReplay=false) {
    const {results,isReplay}=inspectGptResults(obj,sessions,registeredIds,knownIds);
    if(isReplay&&!allowReplay) {const err=new Error("このGPTセッションは登録済みです。再登録の確認が必要です。");err.code="GPT_REPLAY_CONFIRMATION_REQUIRED";throw err;}
    if(activeSession) finalizeStudySession(activeSession,getState);
    let applied=0;
    for(const {id,result} of results) {
      if(result==="skipped") continue;
      const st=state[id]=normalizeState(state[id]||defaultState()); st.studyCount+=1; st.lastStudiedAt=now;
      if(result==="correct") { st.correctCount+=1; appendResult(st,true); } else appendResult(st,false);
      applied++;
    }
    if(!isReplay) {delete sessions[String(obj.sessionId)];if(!registeredIds.includes(String(obj.sessionId)))registeredIds.push(String(obj.sessionId));}
    return applied;
  }
  function prepareGptImport(obj,sessions,knownIds,state,activeSession,now=new Date().toISOString(),registeredIds=[],allowReplay=false) {
    const nextState=JSON.parse(JSON.stringify(state)), nextSessions=JSON.parse(JSON.stringify(sessions)),nextRegistered=[...registeredIds];
    const nextSession=activeSession?JSON.parse(JSON.stringify(activeSession)):null;
    const getState=id=>nextState[id]=normalizeState(nextState[id]||defaultState());
    const {isReplay}=inspectGptResults(obj,nextSessions,nextRegistered,knownIds);
    const applied=applyGptResults(obj,nextSessions,knownIds,nextState,now,nextSession,getState,nextRegistered,allowReplay);
    return {state:nextState,gptSessions:nextSessions,registeredGptSessionIds:nextRegistered,activeSession:nextSession,applied,isReplay};
  }
  function pageForGptPosition(words,state,view,pageSize,randomIds,position) {
    if(view.sortMode==="random") {
      const page=buildRandomFixedPage(words,state,{pageSize,randomIds,filter:view.filter,excludeStreak:view.excludeStreak,masteryThreshold:view.masteryThreshold,startIndex:position});
      return{view:{...view,randomStart:page.startIndex},page,ids:page.entries.map(w=>String(w.id))};
    }
    const model=buildPageModel(words,state,{pageSize,sortMode:"normal",filter:view.filter,excludeStreak:view.excludeStreak,masteryThreshold:view.masteryThreshold});
    const index=safePageIndex(model.pages,position),page=model.pages[index];
    return{view:{...view,pageIndex:index},page,model,ids:(page?.entries||[]).map(w=>String(w.id))};
  }
  function prepareGptIntegration(obj,{sessions={},registeredIds=[],knownIds=[],words=[],state={},activeSession=null,currentView=null,pageSize,randomIds=[],now=new Date().toISOString()}={}) {
    const checked=inspectGptResults(obj,sessions,registeredIds,knownIds),sessionId=String(obj.sessionId);
    if(checked.isReplay) {
      const formal=prepareGptImport(obj,sessions,knownIds,state,activeSession,now,registeredIds,true);
      return{...formal,mode:"formal-replay",jump:{canJump:false,reason:"replay",lastResultId:null,candidatePosition:null},samePage:false,
        transition:{kind:"stay",view:currentView},formalApplied:formal.applied,provisionalIds:[],ignoredOverlapIds:[]};
    }
    const original=sessions?.[sessionId],nextState=JSON.parse(JSON.stringify(state||{})),nextSessions=JSON.parse(JSON.stringify(sessions||{}));
    const nextRegistered=[...registeredIds],nextSession=activeSession?JSON.parse(JSON.stringify(activeSession)):null;
    if(nextSession&&(!Array.isArray(nextSession.studiedIds)||!Array.isArray(nextSession.checkedIds)||!Array.isArray(nextSession.finalizedIds)||!Array.isArray(nextSession.targetIds)))throw new Error("通常学習セッションが不正です。");
    const finalized=new Set((activeSession?.finalizedIds||[]).map(String));
    const pending=new Set((activeSession?.studiedIds||[]).map(String).filter(id=>!finalized.has(id)));
    const overlapping=new Set(checked.results.filter(r=>r.result!=="skipped"&&pending.has(r.id)).map(r=>r.id));
    const ignoredOverlapIds=(original?.ids||[]).map(String).filter(id=>overlapping.has(id));
    const ignored=new Set(ignoredOverlapIds),eligible=checked.results.filter(r=>r.result!=="skipped"&&!ignored.has(r.id));
    const jumpView=buildGptJumpView(currentView,pageSize,randomIds);
    let jump=evaluateGptJump(original,words,jumpView,eligible,state);
    let candidatePage=null,samePage=false;
    if(jump.canJump) {
      const pos=jump.candidatePosition.sortMode==="random"?jump.candidatePosition.randomStart:jump.candidatePosition.pageIndex;
      candidatePage=pageForGptPosition(words,state,{...currentView,sortMode:jump.candidatePosition.sortMode},pageSize,randomIds,pos);
      if(!candidatePage.ids.includes(jump.lastResultId)) {
        jump={...jump,canJump:false,reason:"target-not-visible",candidatePosition:null};candidatePage=null;
      } else {
        const currentPos=currentView.sortMode==="random"?currentView.randomStart:currentView.pageIndex;
        const currentPage=pageForGptPosition(words,state,currentView,pageSize,randomIds,currentPos||0);
        samePage=currentView.sortMode===candidatePage.view.sortMode&&sameOrderedIds(currentPage.ids,candidatePage.ids)&&
          (!nextSession||(nextSession.key===studySessionKey(currentView,pageSize)&&sameOrderedIds(nextSession.targetIds,candidatePage.ids)));
      }
    }
    const provisionalSet=new Set();
    if(jump.canJump&&candidatePage)for(const result of eligible) {
      if(!candidatePage.ids.includes(result.id))continue;
      if(samePage&&nextSession&&finalized.has(result.id))continue;
      provisionalSet.add(result.id);
    }
    let formalResults=eligible.filter(result=>!provisionalSet.has(result.id));
    const updatedAt=typeof now==="number"?now:Date.parse(now);
    if(!Number.isFinite(updatedAt))throw new Error("GPT結果の登録時刻が不正です。");
    const stamp=new Date(updatedAt).toISOString();
    const applyFormalResult=({id,result})=>{
      const st=nextState[id]=normalizeState(nextState[id]||defaultState());st.studyCount+=1;st.lastStudiedAt=stamp;
      if(result==="correct"){st.correctCount+=1;appendResult(st,true)}else appendResult(st,false);
    };
    for(const result of formalResults)applyFormalResult(result);
    const differentPage=jump.canJump&&!samePage;
    if(differentPage&&nextSession) {
      finalizeStudySession(nextSession,id=>nextState[id]=normalizeState(nextState[id]||defaultState()));
    }
    if(differentPage&&candidatePage) {
      const position=jump.candidatePosition.sortMode==="random"?jump.candidatePosition.randomStart:jump.candidatePosition.pageIndex;
      candidatePage=pageForGptPosition(words,nextState,{...currentView,sortMode:jump.candidatePosition.sortMode},pageSize,randomIds,position);
      const visible=new Set(candidatePage.ids);
      const newlyFormalized=eligible.filter(result=>provisionalSet.has(result.id)&&!visible.has(result.id));
      for(const {id,result} of newlyFormalized) {
        applyFormalResult({id,result});
        provisionalSet.delete(id);formalResults.push({id,result});
      }
      if(!candidatePage.ids.includes(jump.lastResultId)) {
        const remaining=eligible.filter(result=>provisionalSet.has(result.id));
        for(const {id,result} of remaining) {
          applyFormalResult({id,result});
          provisionalSet.delete(id);formalResults.push({id,result});
        }
        jump={...jump,canJump:false,reason:"target-not-visible-after-finalize",candidatePosition:null};candidatePage=null;
      }
    }
    let resultingSession=differentPage?null:nextSession;
    if(jump.canJump&&candidatePage&&provisionalSet.size) {
      const isNew=!resultingSession;
      if(isNew)resultingSession={sessionId:`gpt-${sessionId}`,key:studySessionKey(candidatePage.view,pageSize),updatedAt,
        revealY:0,targetIds:[...candidatePage.ids],viewState:{...candidatePage.view,pageSize},studiedIds:[],checkedIds:[],finalizedIds:[],pendingId:null};
      const byId=new Map(eligible.map(r=>[r.id,r.result]));
      for(const id of candidatePage.ids)if(provisionalSet.has(id)) {
        if(!resultingSession.studiedIds.includes(id))resultingSession.studiedIds.push(id);
        if(byId.get(id)==="correct") {if(!resultingSession.checkedIds.includes(id))resultingSession.checkedIds.push(id)}
        else resultingSession.checkedIds=resultingSession.checkedIds.filter(value=>String(value)!==id);
        const st=nextState[id]=normalizeState(nextState[id]||defaultState());st.studyCount+=1;st.lastStudiedAt=stamp;
      }
      resultingSession.updatedAt=updatedAt;
      if(isNew||differentPage)resultingSession.viewState={...candidatePage.view,pageSize};
    }
    delete nextSessions[sessionId];if(!nextRegistered.includes(sessionId))nextRegistered.push(sessionId);
    const provisionalIds=candidatePage?candidatePage.ids.filter(id=>provisionalSet.has(id)):[];
    const formalApplied=formalResults.length,applied=formalApplied+provisionalIds.length;
    return{state:nextState,gptSessions:nextSessions,registeredGptSessionIds:nextRegistered,activeSession:resultingSession,applied,
      formalApplied,provisionalIds,ignoredOverlapIds,isReplay:false,jump,samePage,
      transition:jump.canJump?{kind:differentPage?"jump":"stay",view:differentPage?candidatePage.view:currentView,position:jump.candidatePosition,
        requiresModeRestore:jump.requiresModeRestore}:
        {kind:"stay",view:currentView,requiresModeRestore:false}};
  }
  function makeGptPayload(sessionId,words) {
    const outputInstructions=[
      "学習結果はJSONのみで出力してください。説明文やMarkdownのコードフェンスは付けないでください。",
      "形式: {\"version\":1,\"sessionId\":\"発行されたsessionId\",\"results\":[{\"id\":\"単語ID\",\"result\":\"correct|wrong|uncertain|skipped\"}]}",
      "versionは数値1、sessionIdは変更せず、idは渡された単語IDを文字列のまま使ってください。",
      "resultはcorrect、wrong、uncertain、skippedのみ。incorrectやunknownなどは禁止です。",
      "resultsのIDはこのURLで渡された単語だけにし、重複させないでください。"
    ].join(" ");
    return {version:1,sessionId,mode:"en-to-ja",words:words.map(({id,word,meaning})=>({id:String(id),word,meaning})),outputInstructions};
  }
  const api={MAX_RECENT,deriveStreak,defaultState,readJson,loadCore,saveCore,saveCoreTransition,normalizeGptSessionRecords,normalizePreferences,selectGptWords,createGptIssueContext,buildGptJumpView,evaluateGptJump,buildPageModel,buildRandomFixedPage,randomPageNavigation,safeRevealBoundary,normalizeRandomStart,normalizeView,serializeView,studySessionKey,sameOrderedIds,safePageIndex,displayChangePlan,tryRestoreSession,parseWordCsv,normalizeState,formatRecentResults,buildHistoryPreview,appendResult,recordStudy,isStudySessionComplete,repeatStudyAction,setSessionAnswer,finalizeStudySession,finalizeSessionDraft,sessionExpired,validateGptResults,inspectGptResults,applyGptResults,prepareGptImport,prepareGptIntegration,makeGptPayload};
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
  else root.StudyCore=api;
})(typeof globalThis!=="undefined"?globalThis:this);
