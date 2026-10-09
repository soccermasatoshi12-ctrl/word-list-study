const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../study-core.js');

function memoryStorage(seed={}) {
  const data=new Map(Object.entries(seed));
  return {getItem:k=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k),data};
}

test('recent history is capped at ten while streak remains exact', () => {
  const s=C.defaultState();
  for(let i=0;i<15;i++) C.appendResult(s,true);
  assert.equal(s.recentResults.length,10); assert.equal(s.currentStreak,15);
  assert.equal(C.normalizeState(s).currentStreak,15);
});
test('cover passage increments study count only and reversal cannot increment twice', () => {
  const state={a:C.defaultState(),b:C.defaultState()};
  const session={studiedIds:[],checkedIds:[],finalizedIds:[]};
  assert.equal(C.recordStudy(session,'a',state.a,'t'),true);
  assert.equal(C.recordStudy(session,'b',state.b,'t'),true);
  assert.equal(C.recordStudy(session,'a',state.a,'t'),false);
  assert.deepEqual([state.a.studyCount,state.a.correctCount,state.a.recentResults,state.a.currentStreak],[1,0,[],0]);
  assert.deepEqual([state.b.studyCount,state.b.correctCount,state.b.recentResults,state.b.currentStreak],[1,0,[],0]);
});
test('answer toggles do not change history and ON OFF ON finalizes as one correct', () => {
  const s=C.defaultState(),session={studiedIds:[],checkedIds:[],finalizedIds:[]};
  C.recordStudy(session,'a',s,'t');
  assert.equal(C.setSessionAnswer(session,'a',true),true);
  assert.equal(C.setSessionAnswer(session,'a',false),true);
  assert.equal(C.setSessionAnswer(session,'a',true),true);
  assert.deepEqual([s.studyCount,s.correctCount,s.recentResults,s.currentStreak],[1,0,[],0]);
  C.finalizeStudySession(session,()=>s);
  assert.deepEqual([s.studyCount,s.correctCount,s.recentResults,s.currentStreak],[1,1,[true],1]);
  C.finalizeStudySession(session,()=>s);
  assert.deepEqual([s.studyCount,s.correctCount,s.recentResults,s.currentStreak],[1,1,[true],1]);
});
test('ON OFF finalizes once as wrong and multiple words use their final states', () => {
  const state={a:C.defaultState(),b:C.defaultState(),c:C.defaultState()};
  const session={studiedIds:[],checkedIds:[],finalizedIds:[]};
  for(const id of ['a','b','c']) C.recordStudy(session,id,state[id],'t');
  C.setSessionAnswer(session,'a',true); C.setSessionAnswer(session,'a',false);
  C.setSessionAnswer(session,'b',true);
  C.finalizeStudySession(session,id=>state[id]);
  assert.deepEqual(state.a.recentResults,[false]); assert.equal(state.a.correctCount,0);
  assert.deepEqual(state.b.recentResults,[true]); assert.equal(state.b.correctCount,1);
  assert.deepEqual(state.c.recentResults,[false]); assert.equal(state.c.correctCount,0);
});
test('unlearned words cannot be checked or included in session finalization', () => {
  const s=C.defaultState(),session={studiedIds:[],checkedIds:[],finalizedIds:[]};
  assert.equal(C.setSessionAnswer(session,'a',true),false);
  C.finalizeStudySession(session,()=>s);
  assert.deepEqual([s.studyCount,s.correctCount,s.recentResults],[0,0,[]]);
});
test('GPT validation rejects invalid batches before caller applies any result', () => {
  const record={ids:['a','b'],applied:false};
  const invalid=[
    {version:1,sessionId:'s',results:[{id:'a',result:'correct'},{id:'a',result:'wrong'}]},
    {version:1,sessionId:'s',results:[{id:'x',result:'correct'}]},
    {version:1,sessionId:'s',results:[{id:'a',result:'maybe'}]},
  ];
  for(const obj of invalid) assert.throws(()=>C.validateGptResults(obj,record,['a','b']));
  assert.deepEqual(record,{ids:['a','b'],applied:false});
});
test('GPT validation requires issued, unapplied session and preserves skipped', () => {
  const rec={ids:['a','b'],applied:false};
  assert.deepEqual(C.validateGptResults({version:1,sessionId:'s',results:[{id:'a',result:'skipped'}]},rec,['a','b']),[{id:'a',result:'skipped'}]);
  assert.throws(()=>C.validateGptResults({version:1,sessionId:'z',results:[]},null,['a']));
  assert.throws(()=>C.validateGptResults({version:1,sessionId:'s',results:[]},{...rec,applied:true},['a','b']));
});
test('legacy individual keys migrate when no integrated snapshot exists', () => {
  const legacy={state:{a:{studyCount:3}},gptSessions:{g:{applied:false}},active:{key:'all',updatedAt:50,studiedIds:['a'],checkedIds:[],finalizedIds:[],revealY:80}};
  const store=memoryStorage({oldState:JSON.stringify(legacy.state),oldGpt:JSON.stringify(legacy.gptSessions),oldActive:JSON.stringify(legacy.active)});
  const loaded=C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'});
  assert.deepEqual(loaded,{state:legacy.state,gptSessions:legacy.gptSessions,activeSession:legacy.active});
  C.saveCore(store,'ledger',loaded);
  assert.deepEqual(C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'}),loaded);
});
test('integrated snapshot wins over stale legacy keys and preserves session progress', () => {
  const store=memoryStorage({oldState:JSON.stringify({a:{studyCount:90}}),oldGpt:JSON.stringify({old:{applied:false}}),oldActive:'null'});
  const snapshot={state:{a:{studyCount:2,correctCount:1,recentResults:[true],currentStreak:1}},gptSessions:{g:{ids:['a'],applied:false}},activeSession:{key:'all:off:normal:0',updatedAt:100,revealY:140,studiedIds:['a'],checkedIds:['a'],finalizedIds:['a']}};
  C.saveCore(store,'ledger',snapshot);
  const loaded=C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'});
  assert.deepEqual(loaded,snapshot);
  const st=loaded.state.a, session=loaded.activeSession;
  assert.equal(C.recordStudy(session,'a',st),false);
  assert.equal(C.setSessionAnswer(session,'a',true),false);
  assert.deepEqual([st.studyCount,st.correctCount,st.recentResults],[2,1,[true]]);
});
test('a failed snapshot write leaves the previous committed snapshot intact', () => {
  const store=memoryStorage({ledger:JSON.stringify({state:{a:{studyCount:1}},gptSessions:{},activeSession:null})});
  const broken={...store,setItem(){throw new Error('write interrupted')}};
  assert.throws(()=>C.saveCore(broken,'ledger',{state:{a:{studyCount:2}},gptSessions:{},activeSession:null}));
  assert.deepEqual(JSON.parse(store.getItem('ledger')).state,{a:{studyCount:1}});
});
test('corrupt or incomplete snapshot falls back to legacy migration inputs', () => {
  const legacy={state:{a:{studyCount:4}},gptSessions:{g:{applied:false}},activeSession:null};
  const seed={ledger:'{"state":{"a":{"studyCount":99}}',oldState:JSON.stringify(legacy.state),oldGpt:JSON.stringify(legacy.gptSessions),oldActive:'null'};
  const store=memoryStorage(seed);
  assert.deepEqual(C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'}),legacy);
  store.setItem('ledger',JSON.stringify({state:{a:{studyCount:99}},gptSessions:{}}));
  assert.deepEqual(C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'}),legacy);
});
test('five minute reload restores pending state; expiry finalizes it exactly once', () => {
  const s={sessionId:'s1',updatedAt:1000,revealY:75,studiedIds:['a','b'],checkedIds:['a'],finalizedIds:['b']};
  const state={a:C.defaultState(),b:C.defaultState()};
  state.a.studyCount=1;state.b.studyCount=1;state.b.recentResults=[false];
  const store=memoryStorage();
  C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:s});
  const restored=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'}).activeSession;
  assert.deepEqual(restored,s);
  assert.equal(C.sessionExpired(s,1000+300000,300000),false);
  assert.equal(C.sessionExpired(s,1001+300000,300000),true);
  C.finalizeStudySession(s,id=>state[id]);
  assert.deepEqual([state.a.studyCount,state.a.correctCount,state.a.recentResults],[1,1,[true]]);
  C.finalizeStudySession(s,id=>state[id]);
  assert.deepEqual([state.a.studyCount,state.a.correctCount,state.a.recentResults],[1,1,[true]]);
  assert.deepEqual([state.b.studyCount,state.b.correctCount,state.b.recentResults],[1,0,[false]]);
});
test('GPT application persists outcomes and replay is rejected after reload', () => {
  const store=memoryStorage(), state={a:C.defaultState(),b:C.defaultState(),c:C.defaultState(),d:C.defaultState()};
  const sessions={s:{ids:['a','b','c','d'],applied:false}};
  const obj={version:1,sessionId:'s',results:[{id:'a',result:'correct'},{id:'b',result:'wrong'},{id:'c',result:'uncertain'},{id:'d',result:'skipped'}]};
  assert.equal(C.applyGptResults(obj,sessions,['a','b','c','d'],state,'2026-01-01T00:00:00Z'),3);
  C.saveCore(store,'ledger',{state,gptSessions:sessions,activeSession:null});
  const restored=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(restored.state.a.recentResults,[true]); assert.equal(restored.state.a.correctCount,1);
  assert.deepEqual(restored.state.b.recentResults,[false]); assert.deepEqual(restored.state.c.recentResults,[false]);
  assert.equal(restored.state.d.studyCount,0); assert.equal(restored.gptSessions.s.applied,true);
  assert.throws(()=>C.applyGptResults(obj,restored.gptSessions,['a','b','c','d'],restored.state));
});
test('GPT import does not prematurely commit or overwrite an active app answer', () => {
  const state={a:C.defaultState()}, active={studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  state.a.studyCount=1;
  const sessions={g:{ids:['a'],applied:false}};
  C.applyGptResults({version:1,sessionId:'g',results:[{id:'a',result:'wrong'}]},sessions,['a'],state,'2026-01-01T00:00:00Z',active,id=>state[id]);
  assert.deepEqual(state.a.recentResults,[true,false]);
  assert.deepEqual([state.a.studyCount,state.a.correctCount,active.studiedIds,active.checkedIds,active.finalizedIds],[2,1,['a'],['a'],['a']]);
  assert.equal(C.setSessionAnswer(active,'a',false),false);
});
test('successful GPT import partially finalizes input and leaves session open for later words', () => {
  const state={a:C.defaultState(),b:C.defaultState(),c:C.defaultState()};
  const active={sessionId:'app',key:'all:off:normal:0',updatedAt:10,revealY:90,studiedIds:['a','b'],checkedIds:['a'],finalizedIds:[]};
  state.a.studyCount=1;state.b.studyCount=1;
  const sessions={g1:{ids:['a'],applied:false},g2:{ids:['c'],applied:false}};
  const store=memoryStorage();
  C.applyGptResults({version:1,sessionId:'g1',results:[{id:'a',result:'wrong'}]},sessions,['a','b','c'],state,'2026-01-01T00:00:00Z',active,id=>state[id]);
  C.saveCore(store,'ledger',{state,gptSessions:sessions,activeSession:active});
  assert.deepEqual([state.a.recentResults,state.b.recentResults],[ [true,false],[false] ]);
  assert.deepEqual([active.studiedIds,active.checkedIds,active.finalizedIds,active.revealY], [['a','b'],['a'],['a','b'],90]);
  assert.equal(C.recordStudy(active,'a',state.a,'later'),false);
  assert.equal(C.recordStudy(active,'c',state.c,'later'),true);
  C.setSessionAnswer(active,'c',true);
  C.applyGptResults({version:1,sessionId:'g2',results:[{id:'c',result:'wrong'}]},sessions,['a','b','c'],state,'2026-01-01T00:01:00Z',active,id=>state[id]);
  assert.deepEqual([state.a.recentResults,state.b.recentResults,state.c.recentResults], [[true,false],[false],[true,false]]);
  assert.equal(active.studiedIds.length,3);assert.equal(active.finalizedIds.length,3);
  assert.equal(C.setSessionAnswer(active,'c',false),false);
  C.finalizeStudySession(active,id=>state[id]);
  assert.deepEqual(state.c.recentResults,[true,false]);
  assert.equal(state.c.correctCount,1);
  const saved=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(saved.activeSession.studiedIds,['a','b']);
  assert.deepEqual(saved.activeSession.checkedIds,['a']);
  assert.deepEqual(saved.activeSession.finalizedIds,['a','b']);
  assert.equal(saved.activeSession.revealY,90);
  assert.equal(saved.state.c.studyCount,0);
});
test('GPT import draft commits app answers and GPT outcome in one snapshot write', () => {
  const state={a:C.defaultState()}, sessions={g:{ids:['a'],applied:false}};
  const active={sessionId:'app',updatedAt:1,revealY:40,studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  state.a.studyCount=1;
  const before=JSON.stringify({state,sessions,active});
  const draft=C.prepareGptImport({version:1,sessionId:'g',results:[{id:'a',result:'wrong'}]},sessions,['a'],state,active,'2026-01-01T00:00:00Z');
  assert.equal(JSON.stringify({state,sessions,active}),before);
  const store=memoryStorage({ledger:JSON.stringify({state:{a:C.defaultState()},gptSessions:{},activeSession:null})});
  const broken={...store,setItem(){throw new Error('write failed')}};
  assert.throws(()=>C.saveCore(broken,'ledger',{state:draft.state,gptSessions:draft.gptSessions,activeSession:draft.activeSession}));
  assert.equal(JSON.stringify({state,sessions,active}),before);
  C.saveCore(store,'ledger',{state:draft.state,gptSessions:draft.gptSessions,activeSession:draft.activeSession});
  const saved=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(saved.state.a.recentResults,[true,false]);
  assert.deepEqual(saved.activeSession.finalizedIds,['a']);
  assert.equal(saved.gptSessions.g.applied,true);
});
test('invalid GPT JSON batches are atomic, including malformed JSON at caller boundary', () => {
  const state={a:C.defaultState(),b:C.defaultState()}, sessions={s:{ids:['a','b'],applied:false}};
  const active={studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  state.a.studyCount=1;
  const before=JSON.stringify({state,sessions,active});
  const bad=[
    {version:1,sessionId:'s',results:[{id:'a',result:'correct'},{id:'b',result:'bogus'}]},
    {version:1,sessionId:'s',results:[{id:'a',result:'correct'},{id:'x',result:'wrong'}]},
    {version:1,sessionId:'s',results:[{id:'a',result:'correct'},{id:'a',result:'wrong'}]},
  ];
  for(const obj of bad) assert.throws(()=>C.applyGptResults(obj,sessions,['a','b'],state,undefined,active,id=>state[id]));
  assert.equal(JSON.stringify({state,sessions,active}),before);
  assert.throws(()=>JSON.parse('{bad json'));
  assert.equal(JSON.stringify({state,sessions,active}),before);
});
