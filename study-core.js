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
  const api={MAX_RECENT,deriveStreak,defaultState,readJson,loadCore,saveCore,normalizeState,appendResult,recordStudy,setSessionAnswer,finalizeStudySession,sessionExpired,validateGptResults,applyGptResults,prepareGptImport};
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
  else root.StudyCore=api;
})(typeof globalThis!=="undefined"?globalThis:this);
