const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../study-core.js');

function memoryStorage(seed={}) {
  const data=new Map(Object.entries(seed));
  return {getItem:k=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k),data};
}
function runRestore(storage,config,now) {
  const snapshot=C.loadCore(storage,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  const restored=C.tryRestoreSession(snapshot.activeSession,{...config,now,ttl:300000});
  if(restored)snapshot.activeSession=restored;
  else {
    const stored=snapshot.activeSession;
    const session={studiedIds:stored?.studiedIds||[],checkedIds:stored?.checkedIds||[],finalizedIds:stored?.finalizedIds||[]};
    C.finalizeStudySession(session,id=>snapshot.state[id]||(snapshot.state[id]=C.defaultState()));
    snapshot.activeSession={sessionId:'new-session',key:config.currentKey,updatedAt:now,revealY:0,studiedIds:[],checkedIds:[],finalizedIds:[]};
  }
  C.saveCore(storage,'ledger',snapshot);
  return C.loadCore(storage,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
}

test('recent history is capped at ten while streak remains exact', () => {
  const s=C.defaultState();
  for(let i=0;i<15;i++) C.appendResult(s,true);
  assert.equal(s.recentResults.length,10); assert.equal(s.currentStreak,15);
  assert.equal(C.normalizeState(s).currentStreak,15);
});
test('normal order keeps fixed ranges and original numbering with filtered gaps', () => {
  const words=Array.from({length:10},(_,i)=>({id:String(i+1),word:`w${i+1}`,meaning:''}));
  const state={'3':{studyCount:1,correctCount:1,currentStreak:3},'5':{studyCount:1,correctCount:1,currentStreak:3},'8':{studyCount:1,correctCount:1,currentStreak:3}};
  const model=C.buildPageModel(words,state,{pageSize:10,excludeStreak:true,masteryThreshold:3});
  assert.equal(model.pages.length,1);
  assert.deepEqual(model.pages[0].entries.map(w=>w.displayNumber),[1,2,4,6,7,9,10]);
  assert.deepEqual(model.pages[0].entries.map(w=>w.id),['1','2','4','6','7','9','10']);
});
test('page sizes 10, 20, 50, and 100 create the expected boundaries', () => {
  const words=Array.from({length:200},(_,i)=>({id:String(i+1)}));
  assert.deepEqual([10,20,50,100].map(pageSize=>C.buildPageModel(words,{}, {pageSize}).pages.length),[20,10,4,2]);
  assert.equal(C.buildPageModel(words.slice(0,50),{}, {pageSize:50}).pages.length,1);
  assert.equal(C.buildPageModel(words.slice(0,51),{}, {pageSize:50}).pages.length,2);
  assert.equal(C.buildPageModel([],{}, {pageSize:50}).pages.length,0);
});
test('normal empty tabs remain represented and safe selection finds a populated tab', () => {
  const words=Array.from({length:20},(_,i)=>({id:String(i+1)}));
  const state=Object.fromEntries(words.slice(0,10).map(w=>[w.id,{currentStreak:2}]));
  const model=C.buildPageModel(words,state,{pageSize:10,excludeStreak:true,masteryThreshold:2});
  assert.deepEqual(model.pages.map(p=>p.entries.length),[0,10]);
  assert.equal(C.safePageIndex(model.pages,0),1);
  for(const word of words)state[word.id]={currentStreak:2};
  const none=C.buildPageModel(words,state,{pageSize:10,excludeStreak:true,masteryThreshold:2});
  assert.deepEqual(none.pages.map(p=>p.entries.length),[0,0]);
  assert.equal(C.safePageIndex(none.pages,1),0);
});
test('random order applies filters first and numbers the remaining words continuously', () => {
  const words=['a','b','c','d'].map(id=>({id})),randomIds=['c','a','b','d'];
  const state={a:{studyCount:1,correctCount:0},b:{studyCount:1,correctCount:0}};
  const model=C.buildPageModel(words,state,{pageSize:10,sortMode:'random',randomIds,filter:'hasMiss'});
  assert.deepEqual(model.pages[0].entries.map(w=>[w.id,w.displayNumber]),[['a',1],['b',2]]);
  const allMastered=Object.fromEntries(words.map(w=>[w.id,{currentStreak:2}]));
  const empty=C.buildPageModel(words,allMastered,{pageSize:10,sortMode:'random',randomIds,excludeStreak:true,masteryThreshold:2});
  assert.equal(empty.pages.length,0);
});
test('preferences persist, restore, migrate prior mastery threshold, and default safely', () => {
  const store=memoryStorage();
  const value={pageSize:20,masteryThreshold:4};store.setItem('preferences',JSON.stringify(value));
  assert.deepEqual(C.normalizePreferences(JSON.parse(store.getItem('preferences'))),value);
  assert.deepEqual(C.normalizePreferences({},{}),{pageSize:50,masteryThreshold:3});
  assert.deepEqual(C.normalizePreferences({pageSize:17,masteryThreshold:8},{excludeStreakN:4}),{pageSize:50,masteryThreshold:4});
});
test('display setting changes only end the current target when its word set changes', () => {
  const short=Array.from({length:8},(_,i)=>({id:String(i+1)}));
  const sameBefore=C.buildPageModel(short,{}, {pageSize:10}),sameAfter=C.buildPageModel(short,{}, {pageSize:20});
  assert.deepEqual(C.displayChangePlan(sameBefore,sameAfter,0),{pageIndex:0,targetChanged:false});
  const long=Array.from({length:30},(_,i)=>({id:String(i+1)}));
  const changedBefore=C.buildPageModel(long,{}, {pageSize:10}),changedAfter=C.buildPageModel(long,{}, {pageSize:20});
  assert.deepEqual(C.displayChangePlan(changedBefore,changedAfter,0),{pageIndex:0,targetChanged:true});
  const thresholdBefore=C.buildPageModel(long,{'1':{currentStreak:3}},{pageSize:10,excludeStreak:false,masteryThreshold:3});
  const thresholdAfter=C.buildPageModel(long,{'1':{currentStreak:3}},{pageSize:10,excludeStreak:false,masteryThreshold:4});
  assert.equal(C.displayChangePlan(thresholdBefore,thresholdAfter,0).targetChanged,false);
  const activeBefore=C.buildPageModel(long,{'1':{currentStreak:3}},{pageSize:10,excludeStreak:true,masteryThreshold:3});
  const activeAfter=C.buildPageModel(long,{'1':{currentStreak:3}},{pageSize:10,excludeStreak:true,masteryThreshold:4});
  assert.equal(C.displayChangePlan(activeBefore,activeAfter,0).targetChanged,true);
});
test('CSV replacement keeps id-keyed history available and validates the existing format', () => {
  const state={x:{studyCount:7,correctCount:5,currentStreak:2}};
  const imported=C.parseWordCsv('id,word,meaning\nx,new word,new meaning\ny,another,other');
  assert.deepEqual(imported,[{id:'x',word:'new word',meaning:'new meaning'},{id:'y',word:'another',meaning:'other'}]);
  assert.equal(state.x.studyCount,7);assert.equal(state.x.correctCount,5);
  assert.throws(()=>C.parseWordCsv('id,word\nx,missing meaning'));
  assert.throws(()=>C.parseWordCsv('id,word,meaning\nx,one,a\nx,two,b'));
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
test('repeat-study decision uses exposed IDs, ignores current cover position and checked status', () => {
  const session={studiedIds:['a','b'],checkedIds:['a'],finalizedIds:[],revealY:0};
  const before=JSON.stringify(session);
  assert.equal(C.repeatStudyAction(session,[]),'empty');
  assert.equal(C.repeatStudyAction(session,['a','b','c']),'confirm');
  assert.equal(C.repeatStudyAction(session,['a','b']),'restart');
  assert.equal(JSON.stringify(session),before);
  assert.equal(C.repeatStudyAction(null,['a']),'confirm');
});
test('repeat study finalizes only pending results, reapplies mastery filter, resets and restores a new session', () => {
  const words=['a','b','c'].map(id=>({id}));
  const state={
    a:{...C.defaultState(),studyCount:1,correctCount:1,recentResults:[true],currentStreak:1},
    b:{...C.defaultState(),studyCount:1,correctCount:1,recentResults:[true],currentStreak:1},
    c:{...C.defaultState(),studyCount:2,correctCount:2,recentResults:[true,true],currentStreak:2}
  };
  const active={sessionId:'gpt-partial-app',key:'all:2:normal:50:0',updatedAt:1000,revealY:90,studiedIds:['a','b'],checkedIds:['b'],finalizedIds:['a'],pendingId:'b'};
  assert.equal(C.repeatStudyAction(active,['a','b']),'restart');
  C.finalizeStudySession(active,id=>state[id]);
  assert.deepEqual([state.a.studyCount,state.a.correctCount,state.a.recentResults],[1,1,[true]]);
  assert.deepEqual([state.b.studyCount,state.b.correctCount,state.b.recentResults,state.b.currentStreak],[1,2,[true,true],2]);
  const filtered=C.buildPageModel(words,state,{pageSize:50,excludeStreak:true,masteryThreshold:2});
  assert.deepEqual(filtered.pages[0].entries.map(w=>w.id),['a']);
  const next={sessionId:'repeat-session',key:'all:2:normal:50:0',updatedAt:2000,revealY:0,studiedIds:[],checkedIds:[],finalizedIds:[],pendingId:null};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:next});
  const restoredSnapshot=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  const restored=C.tryRestoreSession(restoredSnapshot.activeSession,{now:2001,ttl:300000,currentKey:next.key});
  assert.equal(restored.sessionId,'repeat-session');
  assert.deepEqual([restored.revealY,restored.studiedIds,restored.checkedIds,restored.finalizedIds],[0,[],[],[]]);
  assert.equal(C.recordStudy(restored,'a',restoredSnapshot.state.a,'later'),true);
  assert.equal(restoredSnapshot.state.a.studyCount,2);
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
test('legacy normal all-words session restores the existing session and progress without recounting', () => {
  const words=Array.from({length:50},(_,i)=>({id:String(i+1)}));
  const state=Object.fromEntries(words.map(w=>[w.id,{...C.defaultState(),studyCount:1}]));
  const saved={sessionId:'legacy-all',key:'all:off:normal:0',updatedAt:1000,revealY:74,studiedIds:['1','2'],checkedIds:['1'],finalizedIds:[]};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:saved});
  const currentKey='all:off:normal:50:0',model=C.buildPageModel(words,state,{pageSize:50});
  const restored=runRestore(store,{currentKey,legacyKey:saved.key,filter:'all',sortMode:'normal',pageIndex:0,pageSize:50,words,state,randomIds:[],currentPageIds:model.pages[0].entries.map(w=>w.id)},1001);
  assert.equal(restored.activeSession.sessionId,'legacy-all');assert.equal(restored.activeSession.revealY,74);
  assert.deepEqual(restored.activeSession.checkedIds,['1']);
  assert.deepEqual([restored.state['1'].studyCount,restored.state['1'].correctCount,restored.state['1'].recentResults],[1,0,[]]);
});
test('legacy random filtered session restores when the complete ordered target matches', () => {
  const words=['a','b','c'].map(id=>({id})),randomIds=['c','a','b'];
  const state={a:{...C.defaultState(),studyCount:1},b:{...C.defaultState(),studyCount:1},c:{...C.defaultState()}};
  const saved={sessionId:'legacy-random',key:'hasMiss:off:random:0',updatedAt:1000,revealY:33,studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:saved});
  const model=C.buildPageModel(words,state,{pageSize:50,sortMode:'random',randomIds,filter:'hasMiss'});
  const restored=runRestore(store,{currentKey:'hasMiss:off:random:50:0',legacyKey:saved.key,filter:'hasMiss',sortMode:'random',pageIndex:0,pageSize:50,words,state,randomIds,currentPageIds:model.pages[0].entries.map(w=>w.id)},1001);
  assert.equal(restored.activeSession.sessionId,'legacy-random');assert.equal(restored.activeSession.revealY,33);
  assert.deepEqual(restored.activeSession.checkedIds,['a']);assert.equal(restored.state.a.correctCount,0);
});
test('legacy normal filtered session restores when old and new ordered targets match', () => {
  const words=Array.from({length:50},(_,i)=>({id:String(i+1)}));
  const state=Object.fromEntries(words.map(w=>[w.id,{...C.defaultState(),studyCount:1,correctCount:0}]));
  const saved={sessionId:'legacy-filtered-same',key:'hasMiss:off:normal:0',updatedAt:1000,revealY:24,studiedIds:['1'],checkedIds:[],finalizedIds:[]};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:saved});
  const model=C.buildPageModel(words,state,{pageSize:50,filter:'hasMiss'});
  const restored=runRestore(store,{currentKey:'hasMiss:off:normal:50:0',legacyKey:saved.key,filter:'hasMiss',sortMode:'normal',pageIndex:0,pageSize:50,words,state,randomIds:[],currentPageIds:model.pages[0].entries.map(w=>w.id)},1001);
  assert.equal(restored.activeSession.sessionId,'legacy-filtered-same');assert.equal(restored.activeSession.revealY,24);
  assert.equal(restored.state['1'].studyCount,1);assert.deepEqual(restored.state['1'].recentResults,[]);
});
test('legacy normal filtered target mismatch finalizes exposed answers once and starts fresh', () => {
  const words=Array.from({length:100},(_,i)=>({id:String(i+1)}));
  const state=Object.fromEntries(words.map(w=>[w.id,C.defaultState()]));
  for(const id of ['1','51'])state[id]={...C.defaultState(),studyCount:1,correctCount:0};
  const saved={sessionId:'legacy-filtered-mismatch',key:'hasMiss:off:normal:0',updatedAt:1000,revealY:90,studiedIds:['1'],checkedIds:['1'],finalizedIds:[]};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:saved});
  const model=C.buildPageModel(words,state,{pageSize:50,filter:'hasMiss'});
  const result=runRestore(store,{currentKey:'hasMiss:off:normal:50:0',legacyKey:saved.key,filter:'hasMiss',sortMode:'normal',pageIndex:0,pageSize:50,words,state,randomIds:[],currentPageIds:model.pages[0].entries.map(w=>w.id)},1001);
  assert.equal(result.activeSession.sessionId,'new-session');assert.deepEqual(result.activeSession.studiedIds,[]);
  assert.deepEqual([result.state['1'].studyCount,result.state['1'].correctCount,result.state['1'].recentResults],[1,1,[true]]);
  assert.deepEqual([result.state['51'].studyCount,result.state['51'].correctCount,result.state['51'].recentResults],[1,0,[]]);
  assert.equal(result.state['1'].currentStreak,1);
  const again=runRestore(store,{currentKey:'hasMiss:off:normal:50:0',legacyKey:saved.key,filter:'hasMiss',sortMode:'normal',pageIndex:0,pageSize:50,words,state,randomIds:[],currentPageIds:model.pages[0].entries.map(w=>w.id)},1002);
  assert.deepEqual([again.state['1'].studyCount,again.state['1'].correctCount,again.state['1'].recentResults],[1,1,[true]]);
});
test('legacy restore rejects order mismatch, expired, unreconstructable, and inconsistent sessions', () => {
  const words=['a','b'].map(id=>({id})),state={a:{...C.defaultState(),studyCount:1},b:{...C.defaultState(),studyCount:1}};
  const base={sessionId:'legacy',key:'all:off:random:0',updatedAt:1000,revealY:40,studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  const args={now:1001,ttl:300000,currentKey:'all:off:random:50:0',legacyKey:base.key,filter:'all',sortMode:'random',pageIndex:0,words,state,randomIds:['a','b'],currentPageIds:['a','b']};
  assert.equal(C.tryRestoreSession(base,{...args,currentPageIds:['b','a']}),null);
  assert.equal(C.tryRestoreSession({...base,updatedAt:0},{...args,now:300001}),null);
  assert.equal(C.tryRestoreSession(base,{...args,randomIds:['a']}),null);
  assert.equal(C.tryRestoreSession(base,{...args,masteryThreshold:4,legacyThreshold:3,excludeStreak:true}),null);
  assert.equal(C.tryRestoreSession({...base,studiedIds:['unknown']},args),null);
  assert.equal(C.tryRestoreSession({...base,revealY:'invalid'},args),null);
  assert.equal(C.tryRestoreSession({...base,key:args.currentKey},{...args,now:1001}).sessionId,'legacy');
  assert.equal(C.tryRestoreSession({...base,key:'all:off:random:50:1'},args),null);
});
test('expired legacy session is finalized once through snapshot reload and replaced', () => {
  const words=[{id:'a'}],state={a:{...C.defaultState(),studyCount:1}};
  const saved={sessionId:'expired-legacy',key:'all:off:normal:0',updatedAt:1000,revealY:20,studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:saved});
  const model=C.buildPageModel(words,state,{pageSize:50});
  const config={currentKey:'all:off:normal:50:0',legacyKey:saved.key,filter:'all',sortMode:'normal',pageIndex:0,words,state,randomIds:[],currentPageIds:model.pages[0].entries.map(w=>w.id)};
  const result=runRestore(store,config,301001);
  assert.equal(result.activeSession.sessionId,'new-session');
  assert.deepEqual([result.state.a.studyCount,result.state.a.correctCount,result.state.a.recentResults],[1,1,[true]]);
  const again=runRestore(store,config,301002);
  assert.deepEqual([again.state.a.studyCount,again.state.a.correctCount,again.state.a.recentResults],[1,1,[true]]);
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
