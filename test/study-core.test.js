const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const C = require('../study-core.js');

function memoryStorage(seed={}) {
  const data=new Map(Object.entries(seed));
  return {getItem:k=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k),data};
}
function runRestore(storage,config,now) {
  const snapshot=C.loadCore(storage,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  const restored=C.tryRestoreSession(snapshot.activeSession,{...config,now,ttl:300000});
  if(restored)snapshot.activeSession={...restored,targetIds:restored.targetIds||config.currentPageIds.map(String)};
  else {
    const stored=snapshot.activeSession;
    const session={studiedIds:stored?.studiedIds||[],checkedIds:stored?.checkedIds||[],finalizedIds:stored?.finalizedIds||[]};
    C.finalizeStudySession(session,id=>snapshot.state[id]||(snapshot.state[id]=C.defaultState()));
    snapshot.activeSession={sessionId:'new-session',key:config.currentKey,updatedAt:now,revealY:0,targetIds:config.currentPageIds.map(String),studiedIds:[],checkedIds:[],finalizedIds:[]};
  }
  C.saveCore(storage,'ledger',snapshot);
  return C.loadCore(storage,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
}

test('filter button handler forwards the selected filter into the view transition', () => {
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const handler=html.match(/document\.querySelectorAll\("\[data-filter\]"\)\.forEach\(btn=>btn\.addEventListener\("click",\(\)=>\{([\s\S]*?)\n  \}\)\);/);
  assert.ok(handler,'filter button click handler should remain present');
  assert.match(handler[1],/const next=btn\.dataset\.filter/);
  assert.match(handler[1],/const view=\{\.\.\.currentView\(\),filter:next\}/);
  assert.match(handler[1],/restartViewSession\(view\)/);
});

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
test('fixed random page slices the persisted order before applying filters and keeps numbering gaps', () => {
  const words='abcdefghijkl'.split('').map(id=>({id})),randomIds=['d','a','f','b','e','c','g','h','i','j','k','l'];
  const state={d:{currentStreak:3},f:{currentStreak:3},b:{currentStreak:3}};
  const page=C.buildRandomFixedPage(words,state,{pageSize:10,randomIds,excludeStreak:true,masteryThreshold:3,startIndex:0});
  assert.deepEqual([page.startIndex,page.endIndex,page.total],[0,10,12]);
  assert.deepEqual(page.entries.map(word=>[word.id,word.displayNumber]),[['a',2],['e',5],['c',6],['g',7],['h',8],['i',9],['j',10]]);
  const next=C.buildRandomFixedPage(words,state,{pageSize:10,randomIds,excludeStreak:true,masteryThreshold:3,startIndex:10});
  assert.deepEqual(next.entries.map(word=>[word.id,word.displayNumber]),[['k',11],['l',12]]);
});
test('fixed random page applies hasMiss, mastery exclusion, both filters, or neither within its fixed range', () => {
  const words='abcdefghijkl'.split('').map(id=>({id})),randomIds=['d','a','f','b','e','c','g','h','i','j','k','l'];
  const clean={studyCount:1,correctCount:1,currentStreak:0};
  const state={d:{studyCount:1,correctCount:0,currentStreak:0},a:{...clean,currentStreak:3},f:{studyCount:1,correctCount:0,currentStreak:0},b:{studyCount:1,correctCount:0,currentStreak:3},e:clean,c:{studyCount:0,correctCount:0},g:{...clean,currentStreak:3},h:clean,i:clean,j:clean};
  const options={pageSize:10,randomIds,startIndex:0};
  const misses=C.buildRandomFixedPage(words,state,{...options,filter:'hasMiss'});
  assert.deepEqual(misses.entries.map(word=>[word.id,word.displayNumber]),[['d',1],['f',3],['b',4]]);
  const unmastered=C.buildRandomFixedPage(words,state,{...options,excludeStreak:true,masteryThreshold:3});
  assert.deepEqual(unmastered.entries.map(word=>[word.id,word.displayNumber]),[['d',1],['f',3],['e',5],['c',6],['h',8],['i',9],['j',10]]);
  const combined=C.buildRandomFixedPage(words,state,{...options,filter:'hasMiss',excludeStreak:true,masteryThreshold:3});
  assert.deepEqual(combined.entries.map(word=>[word.id,word.displayNumber]),[['d',1],['f',3]]);
  const unfiltered=C.buildRandomFixedPage(words,state,options);
  assert.deepEqual(unfiltered.entries.map(word=>[word.id,word.displayNumber]),randomIds.slice(0,10).map((id,index)=>[id,index+1]));
  assert.equal(unfiltered.total,12);
});
test('fixed random page supports any start offset and page-size changes without moving the start', () => {
  const words=Array.from({length:120},(_,i)=>({id:String(i+1)}));
  const randomIds=words.map(word=>word.id).reverse();
  for(const pageSize of [10,20,50,100]) {
    const page=C.buildRandomFixedPage(words,{}, {pageSize,randomIds,startIndex:50});
    assert.equal(page.startIndex,50);
    assert.equal(page.endIndex,Math.min(50+pageSize,120));
    assert.equal(page.entries[0].displayNumber,51);
    assert.equal(page.entries.at(-1).displayNumber,Math.min(50+pageSize,120));
  }
  const first=C.buildRandomFixedPage(words,{}, {pageSize:50,randomIds,startIndex:50});
  const smaller=C.buildRandomFixedPage(words,{}, {pageSize:20,randomIds,startIndex:first.startIndex});
  const larger=C.buildRandomFixedPage(words,{}, {pageSize:100,randomIds,startIndex:first.startIndex});
  assert.deepEqual([smaller.entries[0].displayNumber,smaller.entries.at(-1).displayNumber],[51,70]);
  assert.deepEqual([larger.entries[0].displayNumber,larger.entries.at(-1).displayNumber],[51,120]);
});
test('fixed random page keeps a filtered empty range and does not backfill from later words', () => {
  const words=Array.from({length:30},(_,i)=>({id:String(i+1)})),randomIds=words.map(word=>word.id);
  const state=Object.fromEntries(words.slice(10,20).map(word=>[word.id,{currentStreak:3}]));
  const empty=C.buildRandomFixedPage(words,state,{pageSize:10,randomIds,excludeStreak:true,masteryThreshold:3,startIndex:10});
  assert.deepEqual([empty.startIndex,empty.endIndex,empty.total,empty.entries.length],[10,20,30,0]);
  const following=C.buildRandomFixedPage(words,state,{pageSize:10,randomIds,excludeStreak:true,masteryThreshold:3,startIndex:20});
  assert.deepEqual(following.entries.map(word=>word.displayNumber),[21,22,23,24,25,26,27,28,29,30]);
});
test('fixed random page handles empty, single-word, and short final ranges safely', () => {
  const empty=C.buildRandomFixedPage([],{}, {pageSize:50,randomIds:[],startIndex:50});
  assert.deepEqual([empty.startIndex,empty.endIndex,empty.total,empty.entries], [0,0,0,[]]);
  const one=C.buildRandomFixedPage([{id:'one'}],{}, {pageSize:10,randomIds:['one']});
  assert.deepEqual([one.startIndex,one.endIndex,one.total,one.entries.map(word=>word.displayNumber)],[0,1,1,[1]]);
  const words=Array.from({length:51},(_,i)=>({id:String(i+1)}));
  const last=C.buildRandomFixedPage(words,{}, {pageSize:50,randomIds:words.map(word=>word.id),startIndex:50});
  assert.deepEqual([last.startIndex,last.endIndex,last.total,last.entries.map(word=>word.displayNumber)],[50,51,51,[51]]);
  const beyond=C.buildRandomFixedPage(words,{}, {pageSize:50,randomIds:words.map(word=>word.id),startIndex:100});
  assert.deepEqual([beyond.startIndex,beyond.endIndex,beyond.entries.map(word=>word.displayNumber)],[50,51,[51]]);
});
test('random page navigation advances by the fixed range end and distinguishes final or empty lists', () => {
  assert.deepEqual(C.randomPageNavigation({startIndex:10,endIndex:20,total:35},35),{canNext:true,canReshuffle:false,nextStart:20});
  assert.deepEqual(C.randomPageNavigation({startIndex:30,endIndex:35,total:35},35),{canNext:false,canReshuffle:true,nextStart:null});
  assert.deepEqual(C.randomPageNavigation({startIndex:10,endIndex:20,total:35,entries:[]},35),{canNext:true,canReshuffle:false,nextStart:20});
  assert.deepEqual(C.randomPageNavigation({startIndex:0,endIndex:0,total:0},0),{canNext:false,canReshuffle:false,nextStart:null});
  assert.deepEqual(C.randomPageNavigation({startIndex:0,endIndex:1,total:1},1),{canNext:false,canReshuffle:true,nextStart:null});
});
test('random navigation UI is separate from normal tabs and routes actions through saved view transitions', () => {
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/id="randomNav" class="random-nav" hidden/);
  assert.match(html,/id="randomNext" class="primary">次へ/);
  assert.match(html,/id="reshuffle">再シャッフル/);
  assert.match(html,/els\.tabs\.hidden=sortMode==="random"/);
  assert.match(html,/els\.randomNav\.hidden=!randomNav/);
  assert.match(html,/els\.randomNext\.addEventListener\("click",nextRandomPage\)/);
  assert.match(html,/els\.reshuffle\.addEventListener\("click",reshuffleRandomOrder\)/);
  assert.match(html,/requestViewTransition\(\{\.\.\.currentView\(\),randomStart:navigation\.nextStart\}\)/);
  assert.match(html,/requestViewTransition\(\{\.\.\.currentView\(\),sortMode:"random",randomStart:0\},\{nextRandomIds:order,writeRandomOrder:true\}\)/);
  assert.match(html,/途中までの学習結果を確定して、次のページへ進みますか？/);
});
test('randomStart defaults, clamps invalid values, and round-trips independently from the normal page index', () => {
  assert.deepEqual([C.normalizeRandomStart(undefined,80),C.normalizeRandomStart(-4,80),C.normalizeRandomStart(2.9,80),C.normalizeRandomStart('bad',80),C.normalizeRandomStart(100,80)],[0,0,2,0,79]);
  const store=memoryStorage(),view={filter:'hasMiss',sortMode:'random',excludeStreak:true,masteryThreshold:4,pageIndex:7,randomStart:50};
  store.setItem('view',JSON.stringify(C.serializeView(view)));
  const restored=C.normalizeView(JSON.parse(store.getItem('view')),120);
  assert.deepEqual([restored.filter,restored.sortMode,restored.excludeStreak,restored.masteryThreshold,restored.pageIndex,restored.randomStart],['hasMiss','random',true,4,7,50]);
  assert.equal(C.studySessionKey({...view,pageIndex:1},20),C.studySessionKey({...view,pageIndex:99},20));
  assert.notEqual(C.studySessionKey(view,20),C.studySessionKey({...view,randomStart:70},20));
  assert.notEqual(C.studySessionKey({...view,sortMode:'normal',pageIndex:1},20),C.studySessionKey({...view,sortMode:'normal',pageIndex:2},20));
});
test('existing page-model calls retain normal behavior and the legacy random path', () => {
  const words=['a','b','c','d'].map(id=>({id})),randomIds=['c','a','b','d'];
  const legacy=C.buildPageModel(words,{a:{studyCount:1,correctCount:0},b:{studyCount:1,correctCount:0}}, {pageSize:10,sortMode:'random',randomIds,filter:'hasMiss'});
  assert.deepEqual(legacy.pages[0].entries.map(word=>[word.id,word.displayNumber]),[['a',1],['b',2]]);
  const normalWords=Array.from({length:11},(_,index)=>({id:String(index+1)}));
  const normal=C.buildPageModel(normalWords,{}, {pageSize:10});
  assert.deepEqual(normal.pages.map(page=>page.entries.map(word=>word.displayNumber)),[Array.from({length:10},(_,index)=>index+1),[11]]);
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
  const next={sessionId:'repeat-session',key:'all:2:normal:50:0',updatedAt:2000,revealY:0,targetIds:['a'],studiedIds:[],checkedIds:[],finalizedIds:[],pendingId:null};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:next});
  const restoredSnapshot=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  const restored=C.tryRestoreSession(restoredSnapshot.activeSession,{now:2001,ttl:300000,currentKey:next.key,currentPageIds:['a']});
  assert.equal(restored.sessionId,'repeat-session');
  assert.deepEqual([restored.revealY,restored.studiedIds,restored.checkedIds,restored.finalizedIds],[0,[],[],[]]);
  assert.equal(C.recordStudy(restored,'a',restoredSnapshot.state.a,'later'),true);
  assert.equal(restoredSnapshot.state.a.studyCount,2);
});
test('page transition draft finalizes exposed answers once and retains the random fixed range', () => {
  const words=Array.from({length:30},(_,i)=>({id:String(i+1)})),randomIds=words.map(word=>word.id);
  const state=Object.fromEntries(words.map(word=>[word.id,C.defaultState()]));
  state['11'].studyCount=1;state['11'].currentStreak=2;
  state['12'].studyCount=1;
  const active={sessionId:'page-2',targetIds:Array.from({length:10},(_,i)=>String(i+11)),studiedIds:['11','12'],checkedIds:['11'],finalizedIds:[]};
  const draft=C.finalizeSessionDraft(state,active);
  assert.deepEqual(state['11'].recentResults,[]);assert.equal(state['12'].recentResults.length,0);
  assert.deepEqual([draft.state['11'].studyCount,draft.state['11'].correctCount,draft.state['11'].currentStreak],[1,1,3]);
  assert.deepEqual(draft.state['12'].recentResults,[false]);
  const again=C.finalizeSessionDraft(draft.state,{...active,finalizedIds:['11','12']});
  assert.deepEqual(again.state,draft.state);
  const page=C.buildRandomFixedPage(words,draft.state,{pageSize:10,randomIds,excludeStreak:true,masteryThreshold:3,startIndex:10});
  assert.deepEqual([page.startIndex,page.endIndex,page.entries.map(word=>word.id)],[10,20,['12','13','14','15','16','17','18','19','20']]);
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
test('GPT validation requires an issued pending session and preserves skipped', () => {
  const rec={ids:['a','b'],applied:false};
  assert.deepEqual(C.validateGptResults({version:1,sessionId:'s',results:[{id:'a',result:'skipped'}]},rec,['a','b']),[{id:'a',result:'skipped'}]);
  assert.throws(()=>C.validateGptResults({version:1,sessionId:'z',results:[]},null,['a']));
  assert.throws(()=>C.validateGptResults({version:1,sessionId:'s',results:[]},{...rec,applied:true},['a','b']));
  assert.deepEqual(C.inspectGptResults({version:1,sessionId:'s',results:[{id:'a',result:'correct'}]},{},['s'],['a']).isReplay,true);
});
test('legacy individual keys migrate when no integrated snapshot exists', () => {
  const legacy={state:{a:{studyCount:3}},gptSessions:{g:{applied:false}},active:{key:'all',updatedAt:50,studiedIds:['a'],checkedIds:[],finalizedIds:[],revealY:80}};
  const store=memoryStorage({oldState:JSON.stringify(legacy.state),oldGpt:JSON.stringify(legacy.gptSessions),oldActive:JSON.stringify(legacy.active)});
  const loaded=C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'});
  assert.deepEqual(loaded,{state:legacy.state,gptSessions:{g:{createdAt:null,ids:[]}},registeredGptSessionIds:[],activeSession:legacy.active});
  C.saveCore(store,'ledger',loaded);
  assert.deepEqual(C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'}),{state:legacy.state,gptSessions:{g:{createdAt:null,ids:[]}},registeredGptSessionIds:[],activeSession:legacy.active});
});
test('integrated snapshot wins over stale legacy keys and preserves session progress', () => {
  const store=memoryStorage({oldState:JSON.stringify({a:{studyCount:90}}),oldGpt:JSON.stringify({old:{applied:false}}),oldActive:'null'});
  const snapshot={state:{a:{studyCount:2,correctCount:1,recentResults:[true],currentStreak:1}},gptSessions:{g:{ids:['a'],applied:false}},activeSession:{key:'all:off:normal:0',updatedAt:100,revealY:140,studiedIds:['a'],checkedIds:['a'],finalizedIds:['a']}};
  C.saveCore(store,'ledger',snapshot);
  const loaded=C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'});
  assert.deepEqual(loaded,{state:snapshot.state,gptSessions:{g:{createdAt:null,ids:['a']}},registeredGptSessionIds:[],activeSession:snapshot.activeSession});
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
test('failed view transition rolls back related keys and can be retried without double finalization', () => {
  const state={a:C.defaultState()};state.a.studyCount=1;
  const active={sessionId:'old',targetIds:['a'],studiedIds:['a'],checkedIds:['a'],finalizedIds:[],revealY:40};
  const oldSnapshot={state,activeSession:active,gptSessions:{},registeredGptSessionIds:[]};
  const store=memoryStorage({ledger:JSON.stringify(oldSnapshot),view:JSON.stringify({sortMode:'random',randomStart:0}),order:JSON.stringify(['a','b']),words:JSON.stringify([{id:'a'}])});
  const nextState=JSON.parse(JSON.stringify(state)),nextActive=JSON.parse(JSON.stringify(active));
  C.finalizeStudySession(nextActive,id=>nextState[id]);
  const nextSnapshot={state:nextState,activeSession:{sessionId:'new',targetIds:['b'],studiedIds:[],checkedIds:[],finalizedIds:[]},gptSessions:{},registeredGptSessionIds:[]};
  const writes=[{key:'order',value:JSON.stringify(['b','a'])},{key:'view',value:JSON.stringify({sortMode:'random',randomStart:1})},{key:'words',value:JSON.stringify([{id:'a'},{id:'b'}])}];
  const broken={getItem:store.getItem,removeItem:store.removeItem,setItem(key,value){if(key==='ledger')throw new Error('quota failure');store.setItem(key,value)}};
  assert.throws(()=>C.saveCoreTransition(broken,'ledger',nextSnapshot,writes),/quota failure/);
  assert.equal(store.getItem('view'),JSON.stringify({sortMode:'random',randomStart:0}));
  assert.equal(store.getItem('order'),JSON.stringify(['a','b']));
  assert.deepEqual(JSON.parse(store.getItem('ledger')).state,state);
  assert.deepEqual(state.a.recentResults,[]);
  C.saveCoreTransition(store,'ledger',nextSnapshot,writes);
  const saved=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(saved.state.a.recentResults,[true]);assert.equal(saved.state.a.correctCount,1);
  assert.equal(JSON.parse(store.getItem('view')).randomStart,1);
  assert.deepEqual(saved.activeSession.targetIds,['b']);
});
test('corrupt or incomplete snapshot falls back to legacy migration inputs', () => {
  const legacy={state:{a:{studyCount:4}},gptSessions:{g:{applied:false}},activeSession:null};
  const seed={ledger:'{"state":{"a":{"studyCount":99}}',oldState:JSON.stringify(legacy.state),oldGpt:JSON.stringify(legacy.gptSessions),oldActive:'null'};
  const store=memoryStorage(seed);
  assert.deepEqual(C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'}),{state:legacy.state,gptSessions:{g:{createdAt:null,ids:[]}},registeredGptSessionIds:[],activeSession:null});
  store.setItem('ledger',JSON.stringify({state:{a:{studyCount:99}},gptSessions:{}}));
  assert.deepEqual(C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'}),{state:legacy.state,gptSessions:{g:{createdAt:null,ids:[]}},registeredGptSessionIds:[],activeSession:null});
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
  assert.equal(C.tryRestoreSession({...base,key:args.currentKey},{...args,now:1001}),null);
  const current={...base,key:args.currentKey,targetIds:['a','b']};
  assert.equal(C.tryRestoreSession(current,{...args,now:1001}).sessionId,'legacy');
  assert.equal(C.tryRestoreSession(current,{...args,now:1001,currentPageIds:['b','a']}),null);
  assert.equal(C.tryRestoreSession({...base,key:'all:off:random:50:1'},args),null);
});
test('current random session restoration requires the same saved position and ordered target IDs', () => {
  const words=['a','b','c','d'].map(id=>({id})),randomIds=['c','a','b','d'];
  const page=C.buildRandomFixedPage(words,{}, {pageSize:2,randomIds,startIndex:2});
  const view={filter:'all',sortMode:'random',excludeStreak:false,masteryThreshold:3,pageIndex:9,randomStart:2};
  const key=C.studySessionKey(view,2);
  const session={sessionId:'random-page',key,updatedAt:1000,revealY:42,targetIds:page.entries.map(word=>word.id),viewState:C.serializeView(view),studiedIds:['b'],checkedIds:['b'],finalizedIds:[]};
  const args={now:1001,ttl:300000,currentKey:key,currentPageIds:['b','d']};
  assert.equal(C.tryRestoreSession(session,args).sessionId,'random-page');
  assert.equal(C.tryRestoreSession(session,{...args,currentKey:C.studySessionKey({...view,randomStart:0},2)}),null);
  assert.equal(C.tryRestoreSession(session,{...args,currentPageIds:['d','b']}),null);
  assert.equal(C.tryRestoreSession({...session,targetIds:['b','b']},args),null);
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
  const sessions={s:{ids:['a','b','c','d'],createdAt:'issued'}};const registered=[];
  const obj={version:1,sessionId:'s',results:[{id:'a',result:'correct'},{id:'b',result:'wrong'},{id:'c',result:'uncertain'},{id:'d',result:'skipped'}]};
  assert.equal(C.applyGptResults(obj,sessions,['a','b','c','d'],state,'2026-01-01T00:00:00Z',null,undefined,registered),3);
  assert.deepEqual(sessions,{});assert.deepEqual(registered,['s']);
  C.saveCore(store,'ledger',{state,gptSessions:sessions,registeredGptSessionIds:registered,activeSession:null});
  const restored=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(restored.state.a.recentResults,[true]); assert.equal(restored.state.a.correctCount,1);
  assert.deepEqual(restored.state.b.recentResults,[false]); assert.deepEqual(restored.state.c.recentResults,[false]);
  assert.equal(restored.state.d.studyCount,0);assert.deepEqual(restored.gptSessions,{});assert.deepEqual(restored.registeredGptSessionIds,['s']);
  assert.throws(()=>C.prepareGptImport(obj,restored.gptSessions,['a','b','c','d'],restored.state,null,undefined,restored.registeredGptSessionIds),{code:'GPT_REPLAY_CONFIRMATION_REQUIRED'});
  const replay=C.prepareGptImport(obj,restored.gptSessions,['a','b','c','d'],restored.state,null,undefined,restored.registeredGptSessionIds,true);
  assert.deepEqual(replay.registeredGptSessionIds,['s']);assert.equal(replay.state.a.correctCount,2);
});
test('GPT import does not prematurely commit or overwrite an active app answer', () => {
  const state={a:C.defaultState()}, active={studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  state.a.studyCount=1;
  const sessions={g:{ids:['a']}},registered=[];
  C.applyGptResults({version:1,sessionId:'g',results:[{id:'a',result:'wrong'}]},sessions,['a'],state,'2026-01-01T00:00:00Z',active,id=>state[id],registered);
  assert.deepEqual(state.a.recentResults,[true,false]);
  assert.deepEqual([state.a.studyCount,state.a.correctCount,active.studiedIds,active.checkedIds,active.finalizedIds],[2,1,['a'],['a'],['a']]);
  assert.equal(C.setSessionAnswer(active,'a',false),false);
});
test('successful GPT import partially finalizes input and leaves session open for later words', () => {
  const state={a:C.defaultState(),b:C.defaultState(),c:C.defaultState()};
  const active={sessionId:'app',key:'all:off:normal:0',updatedAt:10,revealY:90,studiedIds:['a','b'],checkedIds:['a'],finalizedIds:[]};
  state.a.studyCount=1;state.b.studyCount=1;
  const sessions={g1:{ids:['a']},g2:{ids:['c']}},registered=[];
  const store=memoryStorage();
  C.applyGptResults({version:1,sessionId:'g1',results:[{id:'a',result:'wrong'}]},sessions,['a','b','c'],state,'2026-01-01T00:00:00Z',active,id=>state[id],registered);
  C.saveCore(store,'ledger',{state,gptSessions:sessions,registeredGptSessionIds:registered,activeSession:active});
  assert.deepEqual([state.a.recentResults,state.b.recentResults],[ [true,false],[false] ]);
  assert.deepEqual([active.studiedIds,active.checkedIds,active.finalizedIds,active.revealY], [['a','b'],['a'],['a','b'],90]);
  assert.equal(C.recordStudy(active,'a',state.a,'later'),false);
  assert.equal(C.recordStudy(active,'c',state.c,'later'),true);
  C.setSessionAnswer(active,'c',true);
  C.applyGptResults({version:1,sessionId:'g2',results:[{id:'c',result:'wrong'}]},sessions,['a','b','c'],state,'2026-01-01T00:01:00Z',active,id=>state[id],registered);
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
  const draft=C.prepareGptImport({version:1,sessionId:'g',results:[{id:'a',result:'wrong'}]},sessions,['a'],state,active,'2026-01-01T00:00:00Z',[]);
  assert.equal(JSON.stringify({state,sessions,active}),before);
  const store=memoryStorage({ledger:JSON.stringify({state:{a:C.defaultState()},gptSessions:{},activeSession:null})});
  const broken={...store,setItem(){throw new Error('write failed')}};
  assert.throws(()=>C.saveCore(broken,'ledger',{state:draft.state,gptSessions:draft.gptSessions,registeredGptSessionIds:draft.registeredGptSessionIds,activeSession:draft.activeSession}));
  assert.equal(JSON.stringify({state,sessions,active}),before);
  C.saveCore(store,'ledger',{state:draft.state,gptSessions:draft.gptSessions,registeredGptSessionIds:draft.registeredGptSessionIds,activeSession:draft.activeSession});
  const saved=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(saved.state.a.recentResults,[true,false]);
  assert.deepEqual(saved.activeSession.finalizedIds,['a']);
  assert.deepEqual(saved.gptSessions,{});assert.deepEqual(saved.registeredGptSessionIds,['g']);
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

test('GPT payload carries a JSON-only result contract and string word IDs', () => {
  const payload=C.makeGptPayload('issued-id',[{id:17,word:'word',meaning:'意味'}]);
  assert.equal(payload.version,1);assert.equal(payload.sessionId,'issued-id');
  assert.deepEqual(payload.words,[{id:'17',word:'word',meaning:'意味'}]);
  assert.match(payload.outputInstructions,/JSONのみ/);assert.match(payload.outputInstructions,/correct、wrong、uncertain、skipped/);
  assert.match(payload.outputInstructions,/重複させない/);
});

test('legacy pending and applied GPT records migrate without changing study history and persist on reload', () => {
  const state={a:{...C.defaultState(),studyCount:4,correctCount:2,recentResults:[true,false],currentStreak:0}};
  const oldRecords={pending:{createdAt:'issued-time',applied:false,ids:['a','b']},done:{createdAt:'old-time',applied:true,ids:['a']}};
  const store=memoryStorage({oldState:JSON.stringify(state),oldGpt:JSON.stringify(oldRecords),oldActive:'null'});
  const before=JSON.stringify(state),keys={stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'};
  const loaded=C.loadCore(store,'ledger',keys);
  assert.deepEqual(loaded.gptSessions,{pending:{createdAt:'issued-time',ids:['a','b']}});
  assert.deepEqual(loaded.registeredGptSessionIds,['done']);assert.equal(JSON.stringify(loaded.state),before);
  assert.equal(loaded.gptSessionMigrationNeeded,true);
  C.saveCore(store,'ledger',loaded);
  const restored=C.loadCore(store,'ledger',keys);
  assert.deepEqual(restored.gptSessions,loaded.gptSessions);assert.deepEqual(restored.registeredGptSessionIds,['done']);
  assert.equal(restored.gptSessionMigrationNeeded,false);assert.equal(JSON.stringify(restored.state),before);
});

test('initial all-skipped import moves the issue record to a unique registered ID without history changes', () => {
  const state={a:C.defaultState(),b:C.defaultState()},sessions={s:{createdAt:'t',ids:['a','b']}},registered=[];
  const result=C.prepareGptImport({version:1,sessionId:'s',results:[{id:'a',result:'skipped'},{id:'b',result:'skipped'}]},sessions,['a','b'],state,null,undefined,registered);
  assert.deepEqual(result.gptSessions,{});assert.deepEqual(result.registeredGptSessionIds,['s']);
  assert.deepEqual(result.state,state);assert.deepEqual(sessions,{s:{createdAt:'t',ids:['a','b']}});assert.deepEqual(registered,[]);
  const store=memoryStorage();C.saveCore(store,'ledger',{...result,activeSession:null});
  const loaded=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(loaded.registeredGptSessionIds,['s']);assert.deepEqual(loaded.gptSessions,{});
});

test('registered ID replay validates current IDs/results and retains one marker after confirmation', () => {
  const registered=['used'],sessions={},known=['a','b'];
  assert.throws(()=>C.inspectGptResults({version:1,sessionId:'never',results:[]},sessions,registered,known),/発行済み/);
  for(const results of [
    [{id:'gone',result:'correct'}],
    [{id:'a',result:'correct'},{id:'a',result:'wrong'}],
    [{id:'a',result:'unknown'}],
    [{id:1,result:'correct'}]
  ]) assert.throws(()=>C.inspectGptResults({version:1,sessionId:'used',results},sessions,registered,known));
  const state={a:C.defaultState()},before=JSON.stringify(state);
  const replay={version:1,sessionId:'used',results:[{id:'a',result:'correct'}]};
  assert.throws(()=>C.prepareGptImport(replay,sessions,known,state,null,undefined,registered),{code:'GPT_REPLAY_CONFIRMATION_REQUIRED'});
  assert.equal(JSON.stringify(state),before);assert.deepEqual(registered,['used']);
  const confirmed=C.prepareGptImport(replay,sessions,known,state,null,undefined,registered,true);
  assert.equal(confirmed.state.a.correctCount,1);assert.deepEqual(confirmed.registeredGptSessionIds,['used']);
  const again=C.prepareGptImport(replay,confirmed.gptSessions,known,confirmed.state,null,undefined,confirmed.registeredGptSessionIds,true);
  assert.deepEqual(again.registeredGptSessionIds,['used']);assert.equal(again.state.a.correctCount,2);
});

test('failed first-import snapshot write leaves memory inputs and prior durable state unchanged', () => {
  const state={a:C.defaultState()},sessions={s:{createdAt:'t',ids:['a']}},registered=[],active=null;
  state.a.studyCount=1;
  const appSession={sessionId:'app',studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  const result=C.prepareGptImport({version:1,sessionId:'s',results:[{id:'a',result:'wrong'}]},sessions,['a'],state,appSession,'now',registered);
  const store=memoryStorage({ledger:JSON.stringify({state,gptSessions:sessions,registeredGptSessionIds:registered,activeSession:appSession})});
  const broken={...store,setItem(){throw new Error('quota/write failure')}};
  assert.throws(()=>C.saveCore(broken,'ledger',{state:result.state,gptSessions:result.gptSessions,registeredGptSessionIds:result.registeredGptSessionIds,activeSession:result.activeSession}));
  assert.deepEqual(state.a.recentResults,[]);assert.deepEqual(sessions,{s:{createdAt:'t',ids:['a']}});assert.deepEqual(registered,[]);
  const durable=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(durable.state.a.recentResults,[]);assert.deepEqual(durable.gptSessions,sessions);assert.deepEqual(durable.registeredGptSessionIds,[]);
  assert.deepEqual(durable.activeSession.finalizedIds,[]);
});
