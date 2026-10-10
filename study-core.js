/* Pure study-history and GPT result rules shared by the page and node:test. */
(function (root) {
  const MAX_RECENT = 10;
  function deriveStreak(results) { let n=0; for(let i=results.length-1;i>=0&&results[i]===true;i--) n++; return n; }
  function defaultState() { return {studyCount:0,correctCount:0,recentResults:[],currentStreak:0,lastStudiedAt:null}; }
  function readJson(storage,key,fallback) { try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function loadCore(storage, snapshotKey, legacyKeys) {
    const snapshot=readJson(storage,snapshotKey,null);
    const legacy={state:readJson(storage,legacyKeys.stateKey,{}),gptSessions:readJson(storage,legacyKeys.gptSessionsKey,{}),activeSession:readJson(storage,legacyKeys.activeSessionKey,null)};
    const has=(key)=>Object.prototype.hasOwnProperty.call(snapshot||{},key);
    if(!snapshot||typeof snapshot!=="object"||!snapshot.state||typeof snapshot.state!=="object"||
      !snapshot.gptSessions||typeof snapshot.gptSessions!=="object"||!has("activeSession")||
      (snapshot.activeSession!==null&&typeof snapshot.activeSession!=="object")) return legacy;
    return {state:snapshot.state,gptSessions:snapshot.gptSessions,activeSession:snapshot.activeSession};
  }
  function saveCore(storage, snapshotKey, snapshot) { storage.setItem(snapshotKey,JSON.stringify(snapshot)); }
  function normalizePreferences(raw={},legacyView={}) {
    const pageSize=[10,20,50,100].includes(Number(raw.pageSize))?Number(raw.pageSize):50;
    const storedThreshold=Number(raw.masteryThreshold),oldThreshold=Number(legacyView.excludeStreakN||3);
    const masteryThreshold=[2,3,4,5].includes(storedThreshold)?storedThreshold:Number.isFinite(oldThreshold)?Math.min(5,Math.max(2,oldThreshold)):3;
    return {pageSize,masteryThreshold};
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
  function safePageIndex(pages,desired=0) {
    if(!pages.length)return 0;
    const index=Math.min(Math.max(0,Math.floor(Number(desired)||0)),pages.length-1);
    if(pages[index].entries.length)return index;
    const available=pages.find(page=>page.entries.length);
    return available?available.index:0;
  }
  function tryRestoreSession(stored,{now,ttl,currentKey,legacyKey,filter="all",sortMode="normal",pageIndex=0,excludeStreak=false,masteryThreshold=3,legacyThreshold=3,words=[],state={},randomIds=[],currentPageIds=[]}={}) {
    if(sessionExpired(stored,now,ttl))return null;
    if(stored?.key===currentKey)return {...stored};
    if(stored?.key!==legacyKey)return null;
    if(typeof stored.sessionId!=="string"||!stored.sessionId||!Number.isFinite(Number(stored.updatedAt))||!Number.isFinite(Number(stored.revealY||0)))return null;
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
    const visibleIds=currentPageIds.map(String);
    if(legacyIds.length!==visibleIds.length||legacyIds.some((id,index)=>id!==visibleIds[index]))return null;

    const studied=stored.studiedIds,checked=stored.checkedIds,finalized=stored.finalizedIds;
    if(!Array.isArray(studied)||!Array.isArray(checked)||!Array.isArray(finalized))return null;
    const target=new Set(legacyIds),known=id=>target.has(String(id));
    if(studied.some(id=>!known(id))||checked.some(id=>!known(id))||finalized.some(id=>!known(id)))return null;
    if(new Set(studied.map(String)).size!==studied.length||new Set(checked.map(String)).size!==checked.length||new Set(finalized.map(String)).size!==finalized.length)return null;
    if(checked.some(id=>!studied.map(String).includes(String(id)))||finalized.some(id=>!studied.map(String).includes(String(id))))return null;

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
  function appendResult(st, value) { const correct=!!value; st.recentResults=[...(st.recentResults||[]),correct].slice(-MAX_RECENT); st.currentStreak=correct?(st.currentStreak||0)+1:0; }
  function recordStudy(session,id,st,at=new Date().toISOString()) {
    if(session.studiedIds.includes(id)) return false;
    st.studyCount+=1; st.lastStudiedAt=at; session.studiedIds.push(id); return true;
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
  function sessionExpired(session, now, ttl) { return now-Number(session?.updatedAt||0)>ttl; }
  function validateGptResults(obj, record, knownIds) {
    if(obj.version!==1||!obj.sessionId||!Array.isArray(obj.results)) throw new Error("結果JSONの形式が不正です。");
    if(!record||record.applied) throw new Error(record?"このセッション結果はすでに反映済みです。":"発行済みのGPTセッションではありません。");
    const allowed=new Set((record.ids||[]).map(String)), known=new Set(knownIds.map(String)), seen=new Set();
    return obj.results.map(r=>{
      const id=String(r.id);
      if(seen.has(id)) throw new Error(`単語IDが重複しています: ${id}`); seen.add(id);
      if(!known.has(id)||!allowed.has(id)) throw new Error(`対象外の単語IDです: ${id}`);
      if(!["correct","wrong","uncertain","skipped"].includes(r.result)) throw new Error(`未知のresult: ${r.result}`);
      return {id,result:r.result};
    });
  }
  function applyGptResults(obj,sessions,knownIds,state,now=new Date().toISOString(),activeSession=null,getState=id=>state[id]) {
    const record=sessions[obj.sessionId], results=validateGptResults(obj,record,knownIds);
    if(activeSession) finalizeStudySession(activeSession,getState);
    let applied=0;
    for(const {id,result} of results) {
      if(result==="skipped") continue;
      const st=state[id]=normalizeState(state[id]||defaultState()); st.studyCount+=1; st.lastStudiedAt=now;
      if(result==="correct") { st.correctCount+=1; appendResult(st,true); } else appendResult(st,false);
      applied++;
    }
    sessions[obj.sessionId]={...record,applied:true,appliedAt:now};
    return applied;
  }
  function prepareGptImport(obj,sessions,knownIds,state,activeSession,now=new Date().toISOString()) {
    const nextState=JSON.parse(JSON.stringify(state)), nextSessions=JSON.parse(JSON.stringify(sessions));
    const nextSession=activeSession?JSON.parse(JSON.stringify(activeSession)):null;
    const getState=id=>nextState[id]=normalizeState(nextState[id]||defaultState());
    const applied=applyGptResults(obj,nextSessions,knownIds,nextState,now,nextSession,getState);
    return {state:nextState,gptSessions:nextSessions,activeSession:nextSession,applied};
  }
  const api={MAX_RECENT,deriveStreak,defaultState,readJson,loadCore,saveCore,normalizePreferences,buildPageModel,safePageIndex,displayChangePlan,tryRestoreSession,parseWordCsv,normalizeState,appendResult,recordStudy,isStudySessionComplete,repeatStudyAction,setSessionAnswer,finalizeStudySession,sessionExpired,validateGptResults,applyGptResults,prepareGptImport};
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
  else root.StudyCore=api;
})(typeof globalThis!=="undefined"?globalThis:this);
