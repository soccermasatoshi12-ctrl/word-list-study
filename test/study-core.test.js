const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const C = require('../study-core.js');

function parsePromptWords(prompt,expectedCount) {
  const marker='id,word,meaning\n',start=prompt.indexOf(marker);
  assert.notEqual(start,-1,'prompt includes the word data header');
  const body=prompt.slice(start+marker.length);
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<body.length&&rows.length<expectedCount;i++) {
    const char=body[i];
    if(quoted) {
      if(char==='"'&&body[i+1]==='"'){field+='"';i++}
      else if(char==='"')quoted=false;
      else field+=char;
    } else if(char==='"')quoted=true;
    else if(char===','){row.push(field);field=''}
    else if(char==='\n'){row.push(field);rows.push(row);row=[];field=''}
    else if(char!=='\r')field+=char;
  }
  if(field!==''||row.length){row.push(field);rows.push(row)}
  assert.equal(quoted,false,'CSV fields are closed');
  return rows.map(([id,word,meaning])=>({id,word,meaning}));
}

function memoryStorage(seed={}) {
  const data=new Map(Object.entries(seed));
  return {getItem:k=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k),data};
}
function runRestore(storage,config,now) {
  const snapshot=C.loadCore(storage,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  const restored=C.tryRestoreSession(snapshot.activeSession,config);
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
function jumpView(view={},pageSize=10,randomIds=[]) {
  const currentView={filter:'all',sortMode:'normal',excludeStreak:false,excludeStreakN:3,masteryThreshold:3,pageIndex:0,randomStart:0,...view};
  return C.buildGptJumpView(currentView,pageSize,randomIds);
}

function prepareIntegration(obj,args={}) {
  const sessions=JSON.parse(JSON.stringify(args.sessions||{}));
  let seq=0;
  if(!Object.hasOwn(args,'latestIssueSequence'))for(const record of Object.values(sessions)) {
    if(!Number.isSafeInteger(record.issueSequence))record.issueSequence=++seq;
    else seq=Math.max(seq,record.issueSequence);
  } else {
    for(const record of Object.values(sessions))if(Number.isSafeInteger(record.issueSequence))seq=Math.max(seq,record.issueSequence);
  }
  const latestIssueSequence=Object.hasOwn(args,'latestIssueSequence')?args.latestIssueSequence:seq;
  return C.prepareGptIntegration(obj,{...args,sessions,latestIssueSequence});
}

test('legacy hasMiss view is removed from the page UI and migrates safely to all words', () => {
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.doesNotMatch(html,/data-filter="|querySelectorAll\("\[data-filter\]"\)/);
  assert.match(html,/normalizedView\.filter="all"/);
  assert.match(html,/stored\.viewState\?\.filter==="hasMiss"/);
  assert.match(html,/Array\.isArray\(stored\.targetIds\)&&StudyCore\.sameOrderedIds\(stored\.targetIds,target\.ids\)/);
  assert.doesNotMatch(html,/stored\.targetIds=\[\.\.\.target\.ids\]/);
  assert.match(html,/露出済みの結果を確定して全単語表示で再開します/);
});

function progressInput(frequencies) {
  const words=[],state={};let id=0;
  for(const [studyCount,questionCount] of frequencies)for(let i=0;i<questionCount;i++) {
    const key=String(++id);words.push({id:key});state[key]={studyCount,currentStreak:0};
  }
  return{words,state};
}

test('progress summary computes mastery count and percentage from all registered questions',()=>{
  const words=[{id:'a'},{id:'b'},{id:'c'},{id:'d'}],state={a:{currentStreak:2,studyCount:1},b:{currentStreak:3,studyCount:2},c:{currentStreak:5,studyCount:3}};
  assert.deepEqual(C.buildProgressSummary(words,state,{masteryThreshold:3}),{
    registeredQuestionCount:4,masteredQuestionCount:2,masteryRate:50,distributionMode:'all',distributionQuestionCount:4,
    distribution:[{lowerBound:0,upperBound:0,questionCount:1,ratio:.25,label:'0回'},{lowerBound:1,upperBound:1,questionCount:1,ratio:.25,label:'1回'},
      {lowerBound:2,upperBound:2,questionCount:1,ratio:.25,label:'2回'},{lowerBound:3,upperBound:3,questionCount:1,ratio:.25,label:'3回'}]
  });
  assert.equal(C.buildProgressSummary(words,state,{masteryThreshold:2}).masteredQuestionCount,3);
  assert.equal(C.buildProgressSummary(words,{}, {masteryThreshold:2}).masteredQuestionCount,0);
  assert.equal(C.buildProgressSummary(words,{a:{currentStreak:2},b:{currentStreak:2},c:{currentStreak:2},d:{currentStreak:2}},{masteryThreshold:2}).masteryRate,100);
});

test('progress summary reports an explicit zero denominator and empty distribution',()=>{
  assert.deepEqual(C.buildProgressSummary([],{orphan:{studyCount:8,currentStreak:9}}),{
    registeredQuestionCount:0,masteredQuestionCount:0,masteryRate:null,distributionMode:'all',distributionQuestionCount:0,distribution:[]
  });
});

test('progress distribution supports all and unmastered scopes without changing mastery totals',()=>{
  const words=[{id:'a'},{id:'b'},{id:'c'},{id:'d'}],state={a:{studyCount:0,currentStreak:3},b:{studyCount:1,currentStreak:0},c:{studyCount:4,currentStreak:2},orphan:{studyCount:99,currentStreak:0}};
  const all=C.buildProgressSummary(words,state,{masteryThreshold:3,distributionMode:'all',excludeStreak:true});
  const unmastered=C.buildProgressSummary(words,state,{masteryThreshold:3,distributionMode:'unmastered'});
  assert.equal(all.masteredQuestionCount,1);assert.equal(all.masteryRate,25);assert.equal(all.distributionQuestionCount,4);
  assert.equal(unmastered.masteredQuestionCount,all.masteredQuestionCount);assert.equal(unmastered.masteryRate,all.masteryRate);
  assert.equal(unmastered.distributionMode,'unmastered');assert.equal(unmastered.distributionQuestionCount,3);
  assert.deepEqual(unmastered.distribution.map(bucket=>[bucket.label,bucket.questionCount]),[['0回',1],['1回',1],['4回',1]]);
  assert.equal(C.buildProgressSummary(words,state,{masteryThreshold:3,distributionMode:'unmastered'}).distributionQuestionCount,3);
  assert.equal(C.buildProgressSummary(words,state,{masteryThreshold:3,distributionMode:'invalid'}).distributionMode,'all');
  const mastered=C.buildProgressSummary(words,{a:{currentStreak:3},b:{currentStreak:3},c:{currentStreak:3},d:{currentStreak:3}},{masteryThreshold:3,distributionMode:'unmastered'});
  assert.equal(mastered.distributionQuestionCount,0);assert.deepEqual(mastered.distribution,[]);
});

test('progress distribution uses studyCount as stored, including provisional counts, and ignores unregistered states',()=>{
  const words=[{id:'a'},{id:'b'}],state={a:{studyCount:7,currentStreak:0},b:{studyCount:0,currentStreak:0},orphan:{studyCount:100,currentStreak:0}};
  const before=JSON.stringify({words,state});
  const result=C.buildProgressSummary(words,state,{masteryThreshold:3});
  assert.deepEqual(result.distribution.map(bucket=>[bucket.label,bucket.questionCount]),[['0回',1],['7回',1]]);
  assert.equal(result.distributionQuestionCount,2);assert.equal(JSON.stringify({words,state}),before);
});

test('progress distribution keeps six or fewer present study counts as individual buckets, including gaps',()=>{
  const {words,state}=progressInput([[0,2],[1,1],[2,3],[20,2],[100,1],[1000,1]]);
  const result=C.buildProgressSummary(words,state);
  assert.deepEqual(result.distribution.map(bucket=>bucket.label),['0回','1回','2回','20回','100回','1000回']);
  assert.equal(result.distribution.length,6);
});

test('progress distribution centers the densest four-count window and aggregates lower counts by actual edge',()=>{
  const {words,state}=progressInput([[0,1],[1,10],[2,20],[3,30],[4,20],[5,10],[6,1],[7,40],[8,40],[9,40],[10,40]]);
  const result=C.buildProgressSummary(words,state);
  assert.deepEqual(result.distribution.map(bucket=>bucket.label),['6回以下','7回','8回','9回','10回']);
  assert.equal(result.distribution[0].lowerBound,0);assert.equal(result.distribution[0].upperBound,6);assert.equal(result.distribution[0].questionCount,92);
  assert.equal(result.distribution.reduce((sum,bucket)=>sum+bucket.questionCount,0),result.distributionQuestionCount);
});

test('progress distribution resolves tied peaks toward the lower four-count window',()=>{
  const {words,state}=progressInput([[0,2],[1,2],[2,2],[3,2],[100,2],[101,2],[102,2],[103,2]]);
  const result=C.buildProgressSummary(words,state);
  assert.deepEqual(result.distribution.map(bucket=>bucket.label),['0回','1回','2回','3回','100回以上']);
  assert.equal(result.distribution.at(-1).questionCount,8);
});

test('progress distribution labels a one-count lower tail individually and aggregates a multi-count upper tail',()=>{
  const {words,state}=progressInput([[0,1],[10,3],[11,3],[12,3],[13,3],[14,3],[15,3],[16,3]]);
  const result=C.buildProgressSummary(words,state);
  assert.deepEqual(result.distribution.map(bucket=>bucket.label),['0回','10回','11回','12回','13回','14回以上']);
  assert.equal(result.distribution[0].lowerBound,result.distribution[0].upperBound);
  assert.equal(result.distribution.at(-1).lowerBound,14);assert.equal(result.distribution.at(-1).upperBound,16);
});

test('progress distribution handles a selected window at the high end without an upper aggregate',()=>{
  const {words,state}=progressInput([[0,1],[1,1],[2,1],[3,10],[4,10],[5,10],[6,10]]);
  const result=C.buildProgressSummary(words,state);
  assert.deepEqual(result.distribution.map(bucket=>bucket.label),['2回以下','3回','4回','5回','6回']);
});

test('progress distribution renders a single-count upper tail as an individual bucket',()=>{
  const {words,state}=progressInput([[0,1],[1,1],[2,10],[3,10],[4,10],[5,10],[100,1]]);
  const result=C.buildProgressSummary(words,state);
  assert.deepEqual(result.distribution.map(bucket=>bucket.label),['1回以下','2回','3回','4回','5回','100回']);
});

test('progress distribution handles very large counts without iterating through missing integer values',()=>{
  const large=1_000_000_000_000,{words,state}=progressInput([[0,1],[1,1],[2,1],[3,1],[large,1],[large+1,1],[large+2,1],[large+3,1]]);
  const result=C.buildProgressSummary(words,state);
  assert.deepEqual(result.distribution.map(bucket=>bucket.label),['0回','1回','2回','3回',`${large}回以上`]);
  assert.ok(result.distribution.length<=6);
});

test('progress distribution never loses, duplicates, or exceeds its registered targets',()=>{
  for(const frequencies of [ [[0,1],[1,1],[2,1],[3,1],[4,1],[5,1],[100,1]], [[0,4],[1,2],[2,1],[9,7],[10,2],[100,5],[1000,1]] ]) {
    const {words,state}=progressInput(frequencies),result=C.buildProgressSummary(words,state);
    assert.ok(result.distribution.length<=6);
    assert.equal(result.distribution.reduce((sum,bucket)=>sum+bucket.questionCount,0),words.length);
    assert.ok(Math.abs(result.distribution.reduce((sum,bucket)=>sum+bucket.ratio,0)-1)<1e-12);
    for(const [count,number] of frequencies){
      const matches=result.distribution.filter(bucket=>count>=bucket.lowerBound&&count<=bucket.upperBound);
      assert.equal(matches.length,1,`studyCount ${count} belongs to exactly one bucket`);
      assert.ok(matches[0].questionCount>=number);
    }
  }
});

test('home and study screens share circular mastery rings and a modal progress detail view',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/<section id="progressOverview"[^>]*aria-label="学習進捗"/);
  assert.match(html,/<div id="homeMasteryRing" class="home-study-mastery" aria-label="習得率"><\/div>/);
  assert.match(html,/<div id="studyMasteryRing"><\/div>/);
  assert.match(html,/<dialog id="progressDialog" class="progress-dialog"/);
  assert.match(html,/<button id="openProgressDetails"[^>]*aria-label="進捗詳細を開く"/);
  assert.match(html,/<button id="closeProgressDetails"[^>]*aria-label="進捗詳細を閉じる"/);
  assert.match(html,/<div class="mastery-detail"><div class="mastery-detail-heading"><svg class="medal-icon"[^>]*viewBox="0 0 20 24">[\s\S]*?<\/svg><h3 id="progressMasteryTitle">習得率<\/h3><\/div><div id="detailMasteryRing"><\/div><p id="masteryCount" class="mastery-detail-count">/);
  const masterySwitchMedal=html.match(/<label class="mastery-switch">\s*(<svg class="medal-icon"[\s\S]*?<\/svg>)/)?.[1];
  const dialogMedal=html.match(/<div class="mastery-detail-heading">(<svg class="medal-icon"[\s\S]*?<\/svg>)/)?.[1];
  assert.ok(masterySwitchMedal&&dialogMedal,'dialog heading uses the mastery medal artwork');
  assert.equal(masterySwitchMedal.replace(/^[\s\S]*?>/,'').replace(/<\/svg>$/,''),dialogMedal.replace(/^[\s\S]*?>/,'').replace(/<\/svg>$/,''));
  assert.match(html,/\.mastery-detail\{display:flex;align-items:flex-start;justify-content:flex-start;gap:16px\}/);
  assert.match(html,/\.mastery-detail-count\{align-self:center/);
  assert.match(html,/<h3 id="progressDistributionTitle">学習回数の分布<\/h3>/);
  assert.match(html,/<button id="distributionAll"[^>]*aria-pressed="true">全問題<\/button>/);
  assert.match(html,/<button id="distributionUnmastered"[^>]*aria-pressed="false">未習得のみ<\/button>/);
  assert.match(html,/StudyCore\.buildProgressSummary\(words,state,\{masteryThreshold,distributionMode\}\)/);
  assert.match(html,/function makeMasteryRing\(rate,size,label\)/);
  assert.match(html,/text\.textContent=value===null\?"—":`\$\{Math\.round\(value\)\}%`/);
  assert.match(html,/segment\.style\.width=`\$\{bucket\.ratio\*100\}%`/);
  assert.match(html,/label\.textContent=`\$\{bucket\.label\}：\$\{bucket\.questionCount\}問`/);
  assert.match(html,/state=draftState;activeSession=progressedSession;studyProgress=draftProgress;gptSkipped=draftSkipped;renderAnswerControlForExposure\(id,measuredGeometry\);renderProgressSummary\(\)/);
  assert.match(html,/els\.distributionEmpty\.textContent=empty\?"対象問題なし"/);
  assert.match(html,/els\.openProgressDetails\.addEventListener\("click",\(\)=>\{if\(!els\.progressDialog\.open\)els\.progressDialog\.showModal\(\)\}\)/);
  assert.match(html,/els\.closeProgressDetails\.addEventListener\("click",\(\)=>\{if\(els\.progressDialog\.open\)els\.progressDialog\.close\(\)\}\)/);
  assert.match(html,/els\.homeMasteryRing\.replaceChildren\(makeMasteryRing\(rate,"small","習得率"\)\)/);
  assert.match(html,/els\.studyMasteryRing\.replaceChildren\(makeMasteryRing\(rate,"medium","習得率"\)\)/);
  assert.match(html,/els\.detailMasteryRing\.replaceChildren\(makeMasteryRing\(rate,"large","習得率"\)\)/);
  assert.doesNotMatch(html,/distributionCount|対象：\$\{summary\.distributionQuestionCount\}問/);
  assert.match(html,/els\.distributionBar\.hidden=empty;els\.distributionLegend\.hidden=empty/);
});

test('recent history is capped at ten while streak remains exact', () => {
  const s=C.defaultState();
  for(let i=0;i<15;i++) C.appendResult(s,true);
  assert.equal(s.recentResults.length,10); assert.equal(s.currentStreak,15);
  assert.equal(C.normalizeState(s).currentStreak,15);
});
test('five-slot history display left-pads short histories and keeps chronological order', () => {
  const cases=[
    [[], '- - - - -'],
    [[true], '- - - - ○'],
    [[true,false], '- - - ○ ×'],
    [[true,false,true], '- - ○ × ○'],
    [[true,false,true,true], '- ○ × ○ ○'],
    [[false,true,false,true,true], '× ○ × ○ ○'],
    [[true,false,true,false,true,true], '× ○ × ○ ○']
  ];
  for(const [input,expected] of cases) assert.equal(C.formatRecentResults(input,5),expected);
});
test('five-slot history formatting does not change saved history, streak, or mastery state', () => {
  const state={...C.defaultState(),studyCount:8,correctCount:6,recentResults:[true,false,true,true],currentStreak:2};
  const before=structuredClone(state);
  assert.equal(C.formatRecentResults(state.recentResults,5),'- ○ × ○ ○');
  assert.deepEqual(state,before);
  assert.equal(C.deriveStreak(state.recentResults),2);
  assert.equal(state.currentStreak>=3,false);
});
test('history preview composes four confirmed results and a provisional fifth slot without mutation', () => {
  const symbols=slots=>slots.map(slot=>slot.result===null?'–':slot.result?'○':'×');
  const history=[true,false,true,true,false,true,false,true,true,true],before=history.slice();
  assert.deepEqual(symbols(C.buildHistoryPreview([])),['–','–','–','–','–']);
  assert.deepEqual(symbols(C.buildHistoryPreview([true])),['–','–','–','–','○']);
  assert.deepEqual(symbols(C.buildHistoryPreview([true,false,true,true])),['–','○','×','○','○']);
  assert.deepEqual(symbols(C.buildHistoryPreview(history)),['○','×','○','○','○']);
  assert.deepEqual(symbols(C.buildHistoryPreview([],false)),['–','–','–','–','×']);
  assert.deepEqual(symbols(C.buildHistoryPreview([true],false)),['–','–','–','○','×']);
  assert.deepEqual(symbols(C.buildHistoryPreview([true,false,true,true],false)),['○','×','○','○','×']);
  assert.deepEqual(symbols(C.buildHistoryPreview(history,false)),['×','○','○','○','×']);
  assert.deepEqual(symbols(C.buildHistoryPreview(history,true)),['×','○','○','○','○']);
  assert.deepEqual(history,before);
  assert.deepEqual(C.buildHistoryPreview([true],false).at(-1),{result:false,provisional:true});
  assert.equal(C.buildHistoryPreview([true],null).some(slot=>slot.provisional),false);
});
test('provisional history changes only on finalization and finalizes once', () => {
  const state=C.defaultState();state.studyCount=4;state.correctCount=2;state.recentResults=[true,false,true];state.currentStreak=3;
  const session={studiedIds:[],checkedIds:[],finalizedIds:[]};
  C.recordStudy(session,'a',state,'t','wrong');
  const before=structuredClone(state),symbols=answer=>C.buildHistoryPreview(state.recentResults,answer).map(slot=>slot.result===null?'–':slot.result?'○':'×');
  assert.deepEqual(symbols(session.checkedIds.includes('a')),['–','○','×','○','×']);
  C.setSessionAnswer(session,'a',true);
  assert.deepEqual(symbols(session.checkedIds.includes('a')),['–','○','×','○','○']);
  assert.deepEqual(state.recentResults,before.recentResults);
  assert.deepEqual([state.correctCount,state.currentStreak],[before.correctCount,before.currentStreak]);
  assert.equal(state.currentStreak>=3,true);
  C.setSessionAnswer(session,'a',false);C.setSessionAnswer(session,'a',true);
  C.finalizeStudySession(session,()=>state);C.finalizeStudySession(session,()=>state);
  assert.deepEqual(state.recentResults,[true,false,true,true]);
  assert.deepEqual([state.studyCount,state.correctCount,state.currentStreak],[5,3,4]);
  assert.equal(C.buildHistoryPreview(state.recentResults).at(-1).provisional,false);
});
test('safe reveal boundary never exposes an unstudied cell and keeps the studied prefix visible', () => {
  const cells=[{id:'a',top:0,bottom:48},{id:'b',top:56,bottom:130},{id:'c',top:138,bottom:186}];
  assert.equal(C.safeRevealBoundary([],cells,186),0);
  assert.equal(C.safeRevealBoundary(['a'],cells,186),56);
  assert.equal(C.safeRevealBoundary(['a','c'],cells,186),56);
  assert.equal(C.safeRevealBoundary(['a','b','c'],cells,186),186);
  assert.equal(C.safeRevealBoundary(['a'],[{id:'b',top:200}],100),100);
  assert.equal(C.safeRevealBoundary(['a'],[],100),0);
});
test('processRevealThresholds handles multiple eligible words in order and returns success',()=>{
  const thresholds=[{id:'a',bottom:20},{id:'b',bottom:40},{id:'c',bottom:60},{id:'below',bottom:120}],calls=[];
  const result=C.processRevealThresholds(thresholds,100,[],(id,boundary)=>{calls.push([id,boundary]);return true});
  assert.equal(result,true);assert.deepEqual(calls,[['a',20],['b',40],['c',60]]);
});
test('processRevealThresholds stops on the first failed save and leaves success prefix empty',()=>{
  const thresholds=[{id:'a',bottom:20},{id:'b',bottom:40},{id:'c',bottom:60}],calls=[],committed=[];
  const result=C.processRevealThresholds(thresholds,100,[],id=>{
    calls.push(id);const storage={getItem:()=>null,setItem:()=>{throw new Error('quota')}};
    try{C.saveCore(storage,'ledger',{state:{},activeSession:{revealY:20},gptSessions:{}});committed.push(id);return true}catch{return false}
  });
  assert.equal(result,false);assert.deepEqual(calls,['a']);assert.deepEqual(committed,[]);
});
test('processRevealThresholds stops at a mid-batch failure after preserving successful words',()=>{
  const thresholds=['a','b','c','d','e'].map((id,index)=>({id,bottom:(index+1)*20})),calls=[],committed=[];
  const result=C.processRevealThresholds(thresholds,100,[],id=>{calls.push(id);if(id==='c')return false;committed.push(id);return true});
  assert.equal(result,false);assert.deepEqual(calls,['a','b','c']);assert.deepEqual(committed,['a','b']);
});
test('processRevealThresholds skips GPT-disclosed IDs while stopping on a later ordinary disclosure failure',()=>{
  const thresholds=['a','gpt','b','c'].map((id,index)=>({id,bottom:(index+1)*20})),calls=[],committed=['gpt'];
  const result=C.processRevealThresholds(thresholds,100,committed,id=>{calls.push(id);if(id==='c')return false;committed.push(id);return true});
  assert.equal(result,false);assert.deepEqual(calls,['a','b','c']);assert.deepEqual(committed,['gpt','a','b']);
});
test('processRevealThresholds does not auto-disclose explicitly GPT-skipped rows',()=>{
  const thresholds=['a','skip','b'].map((id,index)=>({id,bottom:(index+1)*20})),calls=[];
  assert.equal(C.processRevealThresholds(thresholds,100,[],id=>{calls.push(id);return true},['skip']),true);
  assert.deepEqual(calls,['a','b']);
});
test('display-size frontier uses stable order IDs and places the cover after the furthest fully disclosed word',()=>{
  const words=Array.from({length:100},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const randomIds=[...words].reverse().map(word=>word.id);
  const longer=Array.from({length:120},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  assert.deepEqual(C.pagePositionForId(longer,'normal',[], '51',20),{sortMode:'normal',position:50,start:40,pageIndex:2},'10-question page six maps to the page containing 51 at size 20');
  assert.deepEqual(C.pagePositionForId(words,'normal',randomIds,'100',20),{sortMode:'normal',position:99,start:80,pageIndex:4},'a fully disclosed list resolves to its final raw page');
  assert.deepEqual(C.pagePositionForId(words,'normal',randomIds,'51',20),{sortMode:'normal',position:50,start:40,pageIndex:2});
  assert.deepEqual(C.pagePositionForId(words,'random',randomIds,'51',20),{sortMode:'random',position:49,start:40,randomStart:40});
  const identity=C.studyOrderIdentity(words,'normal',randomIds);
  const session={targetIds:words.map(word=>word.id),studiedIds:['41','51'],checkedIds:['51'],finalizedIds:[],furthestProgressId:'51'};
  const frontier=C.resolveDisplayFrontier(session,words,'normal',randomIds,'1');
  assert.equal(frontier.learnedId,'51');assert.equal(frontier.position,50);
  const empty=C.resolveDisplayFrontier(null,words,'normal',randomIds,'51');
  assert.equal(empty.id,'51');assert.equal(empty.learnedId,null,'no learned frontier uses the old page start only as page-selection fallback');
  let anchored={...session,curtainFrontierId:'51',curtainFrontierIdentity:identity};
  anchored=C.advanceCurtainFrontier(anchored,words,'normal',randomIds,'45');assert.equal(anchored.curtainFrontierId,'51','frontier never moves backward');
  anchored=C.advanceCurtainFrontier(anchored,words,'normal',randomIds,'52');assert.equal(anchored.curtainFrontierId,'52');
  assert.deepEqual(C.idsThroughPosition(words,'normal',randomIds,['41','43','52','60'],'51'),['41','43']);
  assert.equal(C.curtainFrontierBoundary([{id:'41',bottom:20},{id:'43',bottom:40},{id:'52',bottom:60}],words,'normal',randomIds,'51'),40);
  assert.equal(C.curtainFrontierBoundary([{id:'52',bottom:20},{id:'53',bottom:40}],words,'normal',randomIds,'51'),0,'a filtered-out frontier keeps later visible rows fully covered');
});
test('order-resume records restore learned and untouched mode positions by stable ID and order identity',()=>{
  const words=Array.from({length:100},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const randomIds=[...words].reverse().map(word=>word.id),normalIdentity=C.studyOrderIdentity(words,'normal',randomIds),randomIdentity=C.studyOrderIdentity(words,'random',randomIds);
  const resume=C.normalizeOrderResume({
    normal:{sortMode:'normal',anchorId:'35',learnedId:'35',identity:normalIdentity},
    random:{sortMode:'random',anchorId:randomIds[50],learnedId:null,identity:randomIdentity}
  });
  assert.equal(C.pagePositionForId(words,'normal',randomIds,resume.normal.anchorId,10).pageIndex,3,'normal learned ID 35 returns to words 31–40');
  assert.equal(C.pagePositionForId(words,'random',randomIds,resume.random.anchorId,10).randomStart,50,'random untouched page returns to its fixed-order positions 51–60');
  const restoredSession={targetIds:words.slice(30,40).map(word=>word.id),studiedIds:[],curtainFrontierId:'35',curtainFrontierIdentity:normalIdentity,curtainFrontierResumeOnly:true};
  const displayFrontier=C.resolveDisplayFrontier(restoredSession,words,'normal',randomIds,'31');
  assert.equal(displayFrontier.id,'31','a resume-only curtain boundary does not pull a later page-size change back to word 35');
  assert.equal(displayFrontier.learnedId,null);
  assert.deepEqual(C.pagePositionForId(words,'normal',randomIds,displayFrontier.id,20),{sortMode:'normal',position:30,start:20,pageIndex:1},'the subsequent 20-word page is 21–40');
  const invalid=C.normalizeOrderResume({...resume,random:{...resume.random,identity:{...randomIdentity,orderFingerprint:'0000000000000000'}}});
  assert.equal(C.sameStudyOrderIdentity(invalid.random.identity,randomIdentity),false,'changed order identity cannot validate an old random resume record');
});
test('sort-order switch handlers capture source mode position and restore the destination mode anchor',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/const STORAGE_ORDER_RESUME="wordlist\.orderResume\.v1"/);
  assert.match(html,/function captureCurrentOrderResume\(\)[\s\S]*?resolveDisplayFrontier\(activeSession,words,sortMode,randomIds,fallbackId\)/);
  assert.match(html,/function viewForOrderResume\(mode,source=orderResume\)[\s\S]*?pagePositionForId\(words,mode,randomIds,entry\.anchorId,pageSize\)/);
  const normal=html.match(/els\.normalOrder\.addEventListener\("click",\(\)=>\{([\s\S]*?)\n  \}\);/)?.[1];
  const random=html.match(/els\.randomOrder\.addEventListener\("click",\(\)=>\{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(normal);assert.ok(random);
  assert.match(normal,/captureCurrentOrderResume\(\)/);assert.match(normal,/viewForOrderResume\("normal",nextOrderResume\)/);assert.doesNotMatch(normal,/pageIndex:0/);
  assert.match(random,/captureCurrentOrderResume\(\)/);assert.match(random,/pagePositionForId\(words,"random",order,target\.anchorId,pageSize\)/);
  assert.match(html,/if\(writeRandomOrder\)draftOrderResume\.random=null/,'explicit shuffle invalidates the prior random resume anchor');
  assert.match(html,/if\(curtainFrontier\.resumeOnly\)nextSession\.curtainFrontierResumeOnly=true/);
  assert.match(html,/delete draftSession\.curtainFrontierResumeOnly/,'new study activity makes the resumed boundary an active session frontier');
  assert.ok(normal.indexOf('orderChangeNeedsConfirmation()')<normal.indexOf('captureCurrentOrderResume()'),'cancelled normal-order switches return before capturing or saving resume state');
  assert.ok(random.indexOf('orderChangeNeedsConfirmation()')<random.indexOf('captureCurrentOrderResume()'),'cancelled random-order switches return before capturing or saving resume state');
});

test('order-resume transition sequence preserves learned and untouched anchors, masks, persistence, and later resize behavior',()=>{
  const words=Array.from({length:120},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const normalIds=words.map(word=>word.id),randomIds=Array.from({length:120},(_,i)=>String((i*37)%120+1));
  const storage=memoryStorage(),identityFor=mode=>C.studyOrderIdentity(words,mode,randomIds);
  const pageIds=(mode,start,size)=> (mode==='random'?randomIds:normalIds).slice(start,start+size);
  const makeSession=(mode,start,size,{studied=[],frontier=null,resumeOnly=false}={})=>{
    const targetIds=pageIds(mode,start,size),session={sessionId:`${mode}-${start}-${size}`,key:`all:off:${mode}:${size}:${mode}:${start}`,updatedAt:1,revealY:0,targetIds,
      viewState:{filter:'all',sortMode:mode,excludeStreak:false,masteryThreshold:3,pageIndex:mode==='normal'?start/size:0,randomStart:mode==='random'?start:0,pageSize:size},
      studiedIds:[...studied],checkedIds:[],finalizedIds:[],furthestProgressId:studied.at(-1)||null,pendingId:null};
    if(frontier){session.curtainFrontierId=frontier;session.curtainFrontierIdentity=identityFor(mode);if(resumeOnly)session.curtainFrontierResumeOnly=true}
    return session;
  };
  const capture=(mode,start,size,session)=>{
    const fallbackId=pageIds(mode,start,size)[0]??null,frontier=C.resolveDisplayFrontier(session,words,mode,randomIds,fallbackId);
    if(frontier.id===null||!frontier.identity)return null;
    if(session?.curtainFrontierResumeOnly&&session.curtainFrontierId&&C.sameStudyOrderIdentity(session.curtainFrontierIdentity,frontier.identity))
      return{sortMode:mode,anchorId:String(session.curtainFrontierId),learnedId:String(session.curtainFrontierId),identity:frontier.identity};
    return{sortMode:mode,anchorId:frontier.id,learnedId:frontier.learnedId,identity:frontier.identity};
  };
  const switchMode=(mode,start,size,session,resume,nextMode,nextSize)=>{
    const nextResume=C.normalizeOrderResume(resume),record=capture(mode,start,size,session);if(record)nextResume[mode]=record;
    const entry=nextResume[nextMode],identity=identityFor(nextMode);
    const valid=entry&&C.sameStudyOrderIdentity(entry.identity,identity)&&C.studyOrderPosition(words,nextMode,randomIds,entry.anchorId)>=0?entry:null;
    const position=valid?C.pagePositionForId(words,nextMode,randomIds,valid.anchorId,nextSize):null;
    const nextStart=position?(nextMode==='random'?position.randomStart:position.start):0;
    const nextSession=makeSession(nextMode,nextStart,nextSize,{frontier:valid?.learnedId||null,resumeOnly:!!valid?.learnedId});
    const nextView={filter:'all',sortMode:nextMode,excludeStreak:false,masteryThreshold:3,pageIndex:nextMode==='normal'?nextStart/nextSize:0,randomStart:nextMode==='random'?nextStart:0};
    C.saveCoreTransition(storage,'ledger',{state:{},activeSession:nextSession,gptSessions:{},registeredGptSessionIds:[],studyProgress:{},gptSkipped:null},[
      {key:'orderResume',value:JSON.stringify(nextResume)},{key:'view',value:JSON.stringify(C.serializeView(nextView))}
    ]);
    return{start:nextStart,session:nextSession,resume:C.normalizeOrderResume(JSON.parse(storage.getItem('orderResume'))),view:nextView};
  };

  // Normal-order study through ID 35, switch away, resize while away, then return.
  let resume=C.normalizeOrderResume(),normalSession=makeSession('normal',0,50,{studied:normalIds.slice(0,35),frontier:'35'});
  let switched=switchMode('normal',0,50,normalSession,resume,'random',50);resume=switched.resume;
  assert.equal(resume.normal.anchorId,'35');assert.equal(switched.session.furthestProgressId,null);
  let randomSession=makeSession('random',0,10); // equivalent to page-size transition on the other order, with no study there
  switched=switchMode('random',0,10,randomSession,resume,'normal',10);resume=switched.resume;
  assert.equal(switched.start,30);assert.deepEqual(switched.session.targetIds,normalIds.slice(30,40));
  assert.equal(switched.session.curtainFrontierId,'35');assert.equal(switched.session.curtainFrontierResumeOnly,true);
  let protectedIds=C.idsThroughPosition(words,'normal',randomIds,switched.session.targetIds,switched.session.curtainFrontierId),opened=[];
  const thresholds=switched.session.targetIds.map((id,index)=>({id,bottom:(index+1)*20}));
  assert.equal(C.processRevealThresholds(thresholds,100,[],id=>{opened.push(id);return true},protectedIds),true);
  assert.deepEqual(opened,[],'IDs 31–35 remain individual masks even though the resume boundary has passed them');
  C.processRevealThresholds(thresholds,200,[],id=>{opened.push(id);return true},protectedIds);
  assert.deepEqual(opened,normalIds.slice(35,40),'curtain movement can disclose only IDs 36–40');

  // Persist and reload the resumed session, then resize without new study.
  const restoredSnapshot=C.loadCore(storage,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  const restored=C.tryRestoreSession(restoredSnapshot.activeSession,{currentKey:switched.session.key,legacyKey:'',filter:'all',sortMode:'normal',pageIndex:3,
    excludeStreak:false,masteryThreshold:3,words,state:{},randomIds,currentPageIds:normalIds.slice(30,40)});
  assert.equal(restored.curtainFrontierId,'35');assert.equal(restored.curtainFrontierResumeOnly,true);
  const fallback='31',laterFrontier=C.resolveDisplayFrontier(restored,words,'normal',randomIds,fallback);
  assert.equal(laterFrontier.id,'31');assert.equal(laterFrontier.learnedId,null);
  const resized=C.pagePositionForId(words,'normal',randomIds,laterFrontier.id,20);
  assert.equal(resized.start,20);assert.deepEqual(normalIds.slice(resized.start,resized.start+20),normalIds.slice(20,40));
  const laterProtected=C.idsThroughPosition(words,'normal',randomIds,normalIds.slice(20,40),restored.curtainFrontierId);
  assert.deepEqual(laterProtected,normalIds.slice(20,35),'the later resize uses the current page anchor but retains the old boundary protection');
  const afterNewStudy={...restored,curtainFrontierResumeOnly:false,studiedIds:['36'],furthestProgressId:'36',curtainFrontierId:'36'};
  assert.equal(C.resolveDisplayFrontier(afterNewStudy,words,'normal',randomIds,'31').id,'36','new study activity replaces the resume-only anchor');
  const movedToFreshPage=makeSession('normal',40,20);
  assert.equal(C.resolveDisplayFrontier(movedToFreshPage,words,'normal',randomIds,'41').id,'41','a fresh unstudied page is anchored to its own first ID');

  const sameSizeAway=switchMode('normal',0,50,normalSession,C.normalizeOrderResume(),'random',50);
  const sameSizeBack=switchMode('random',0,50,makeSession('random',0,50),sameSizeAway.resume,'normal',50);
  assert.equal(sameSizeBack.start,0);assert.deepEqual(sameSizeBack.session.targetIds,normalIds.slice(0,50));
  assert.equal(sameSizeBack.session.curtainFrontierId,'35','same-size return also restores the learned curtain boundary');

  // Random-order restoration is symmetric and maps by the same fixed randomIds after resizing.
  for(const returnSize of [50,10]){
    const randomFrontier=randomIds[34],source=makeSession('random',0,50,{studied:randomIds.slice(0,35),frontier:randomFrontier});
    let away=switchMode('random',0,50,source,C.normalizeOrderResume(),'normal',50);
    if(returnSize!==50)away=switchMode('normal',away.start,50,away.session,away.resume,'random',returnSize);
    else away=switchMode('normal',away.start,50,away.session,away.resume,'random',returnSize);
    assert.equal(away.start,Math.floor(34/returnSize)*returnSize);
    assert.deepEqual(away.session.targetIds,randomIds.slice(away.start,away.start+returnSize));
    assert.equal(away.session.curtainFrontierId,randomFrontier);
    assert.equal(away.session.curtainFrontierResumeOnly,true);
  }

  // Visiting an untouched normal page stores its first ID, not a stale progress cursor.
  const untouched=makeSession('normal',50,50),untouchedAway=switchMode('normal',50,50,untouched,C.normalizeOrderResume(),'random',10);
  const untouchedBack=switchMode('random',0,10,makeSession('random',0,10),untouchedAway.resume,'normal',10);
  assert.equal(untouchedBack.start,50);assert.deepEqual(untouchedBack.session.targetIds,normalIds.slice(50,60));
  assert.equal(untouchedBack.session.curtainFrontierId,undefined,'untouched-page return does not import old learned progress as a curtain boundary');

  // An identity change makes a saved cursor unusable; an explicit shuffle clears it.
  const changedWords=words.map(word=>({...word}));changedWords[0].answer='changed';
  const changedIdentity=C.studyOrderIdentity(changedWords,'random',randomIds),savedRandom=untouchedAway.resume.random;
  assert.equal(C.sameStudyOrderIdentity(savedRandom?.identity,changedIdentity),false);
  const changedIdentityStart=C.sameStudyOrderIdentity(savedRandom?.identity,changedIdentity)
    ?C.pagePositionForId(changedWords,'random',randomIds,savedRandom.anchorId,10).randomStart:0;
  assert.equal(changedIdentityStart,0,'a changed dataset falls back safely instead of applying the stale anchor');
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/if\(writeRandomOrder\)draftOrderResume\.random=null/,'explicit reshuffle clears the old random resume record');
});
test('display-size transition clears only skipped IDs leaving the old target and keeps common or unrelated skips',()=>{
  const words=Array.from({length:100},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  let skipped=null;for(const id of ['30','44','59','99'])skipped=C.setGptSkippedState(skipped,words,id,true);
  const next=C.clearGptSkippedOutsideTarget(skipped,words,['30','44','59'],['44','59','60']);
  assert.deepEqual(next.ids,['44','59','99']);
  const roundTrip=C.clearGptSkippedOutsideTarget(next,words,['44','59','60'],['1','100']);
  assert.deepEqual(roundTrip.ids,['99'],'an already-cleared skip does not return when the old range is shown again');
});
test('display-size cover protection keeps rows through the saved frontier masked during forward curtain movement',()=>{
  const words=Array.from({length:60},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const order=words.map(word=>word.id),currentIds=order.slice(40,60),identity=C.studyOrderIdentity(words,'normal',[]);
  const protectedIds=C.idsThroughPosition(words,'normal',[],currentIds,'51'),thresholds=currentIds.map((id,index)=>({id,bottom:(index+1)*20})),opened=[];
  assert.equal(C.processRevealThresholds(thresholds,260,[],id=>{opened.push(id);return true},protectedIds),true);
  assert.deepEqual(opened,['52','53'],'previously passed but fresh-session undisclosed IDs stay individually masked');
  const active={sessionId:'new',key:'all:off:normal:20:normal:1',updatedAt:1,revealY:0,targetIds:currentIds,viewState:{filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:2,randomStart:0,pageSize:20},studiedIds:[],checkedIds:[],finalizedIds:[],pendingId:null,curtainFrontierId:'51',curtainFrontierIdentity:identity};
  const restored=C.tryRestoreSession(active,{currentKey:active.key,legacyKey:'',filter:'all',sortMode:'normal',pageIndex:2,excludeStreak:false,masteryThreshold:3,legacyThreshold:3,words,state:{},randomIds:[],currentPageIds:currentIds});
  assert.equal(restored.curtainFrontierId,'51');assert.deepEqual(restored.curtainFrontierIdentity,identity,'ID anchor and order identity survive session restoration');
});
test('display-size finalization commits pending evaluations once without incrementing disclosure counts again',()=>{
  const state={};const active={studiedIds:['41','42','43'],checkedIds:['41','43'],finalizedIds:[]};
  for(const id of active.studiedIds)state[id]={...C.defaultState(),studyCount:1};
  const first=C.finalizeSessionDraft(state,active);
  assert.equal(first.state['41'].studyCount,1);assert.equal(first.state['41'].correctCount,1);
  assert.equal(first.state['42'].studyCount,1);assert.equal(first.state['42'].correctCount,0);
  assert.deepEqual(first.activeSession,null);assert.deepEqual(first.finalizedIds,['41','42','43']);
  C.finalizeStudySession(active,id=>state[id]);const once=JSON.stringify(state);C.finalizeStudySession(active,id=>state[id]);
  assert.deepEqual(active.finalizedIds,['41','42','43']);assert.equal(JSON.stringify(state),once,'retrying finalization does not append history twice');
});
test('page-size input uses its isolated frontier transition while other display settings keep their prior path',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const pageSize=html.match(/function changePageSizePreservingLearningPosition\(nextPageSize\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(pageSize,'page-size change has a dedicated transition');
  assert.match(pageSize,/const oldRawStart=sortMode===\"random\"\?randomStart:pageIndex\*pageSize/);
  assert.match(pageSize,/const fallbackId=orderedIds\[oldRawStart\]/);
  assert.match(pageSize,/resolveDisplayFrontier\(activeSession,words,sortMode,randomIds,fallbackId\)/);
  assert.match(pageSize,/pagePositionForId\(words,sortMode,randomIds,frontier\.id,nextPageSize\)/);
  assert.match(pageSize,/finalize:true,resetCurtain:true,clearGptSkippedExitedTarget:true/);
  assert.match(pageSize,/const curtainResume=frontier\.learnedId\?frontier:resumeOnlyFrontier/);
  assert.match(pageSize,/curtainFrontier:curtainResume/);
  const pageHandler=html.match(/els\.pageSize\.addEventListener\("change",\(\)=>\{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(pageHandler);assert.match(pageHandler,/changePageSizePreservingLearningPosition\(next\)/);assert.doesNotMatch(pageHandler,/changeDisplaySettings/);
  assert.match(html,/const nextSession=!nextWords\.length\?null:finalize\|\|!priorSession[\s\S]*?studiedIds:\[\],checkedIds:\[\],finalizedIds:\[\]/);
  assert.match(html,/saveCoreTransition\(localStorage,STORAGE_LEDGER,[\s\S]*?state=draftState;studyProgress=draftProgress;orderResume=draftOrderResume;activeSession=nextSession/);
  assert.match(html,/clearGptSkippedOutsideTarget\(draftSkipped,nextWords,oldTarget\.ids,target\.ids\)/);
});
test('processRevealThresholds retry handles only remaining IDs without recounting committed words',()=>{
  const thresholds=['a','b','c','d'].map((id,index)=>({id,bottom:(index+1)*20})),committed=[],firstCalls=[];
  assert.equal(C.processRevealThresholds(thresholds,100,committed,id=>{firstCalls.push(id);if(id==='c')return false;committed.push(id);return true}),false);
  const retryCalls=[];
  assert.equal(C.processRevealThresholds(thresholds,100,committed,id=>{retryCalls.push(id);committed.push(id);return true}),true);
  assert.deepEqual(firstCalls,['a','b','c']);assert.deepEqual(retryCalls,['c','d']);assert.deepEqual(committed,['a','b','c','d']);
});
test('word rows use flowing full-meaning text, five-result history, and mastered medal without changing history rules', () => {
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/\.meaning-cell\{[^}]*min-height:48px[^}]*overflow:hidden/);
  assert.match(html,/\.meaning-text\{position:relative;display:block;width:100%;padding:[^;]+;font-size:13px;line-height:1\.35;overflow-wrap:anywhere/);
  const meaningRule=html.match(/\.meaning-text\{[^}]*\}/)?.[0]||'';
  assert.doesNotMatch(meaningRule,/position:absolute|line-clamp|max-height/);
  assert.match(html,/\.meaning-text\.is-undisclosed\{visibility:hidden\}/);
  assert.match(html,/\.meaning-curtain\{position:absolute;z-index:20;background:var\(--cover\);border-radius:8px/);
  assert.match(html,/<div id="meaningCurtain" class="meaning-curtain hidden" aria-hidden="true"><\/div>/);
  assert.doesNotMatch(html,/meaning-mask/);
  assert.match(html,/function syncMeaningDisclosure\(row,id\)/);
  assert.match(html,/text\.setAttribute\('aria-hidden',String\(!disclosed\)\)/);
  assert.doesNotMatch(html,/createElement\('span'\);mask\.className='meaning-mask'/);
  assert.match(html,/mc\.addEventListener\("click",\(\)=>\{if\(!rowDisclosed\(w\.id\)&&canIndividuallyDisclose\(w\.id\)\)markStudied\(w\.id,revealY,true,undefined,defaultAnswer\)\}\)/);
  assert.match(html,/row\.append\(wc,cc,mc\);syncMeaningDisclosure\(row,w\.id\)/);
  assert.match(html,/function renderAnswerControlForExposure\(id,measuredGeometry=undefined\)\{const row=.*syncMeaningDisclosure\(row,id\)/);
  assert.match(html,/function processRevealProgress\(g=geometry\(\)\)[\s\S]*?idsThroughPosition\(words,sortMode,randomIds,g\.thresholds\.map\(item=>item\.id\),activeSession\.curtainFrontierId\)[\s\S]*?StudyCore\.processRevealThresholds\(g\.thresholds,revealY,activeSession\.studiedIds,\(id,boundary\)=>markStudied\(id,boundary,false,g\),\[\.\.\.gptSkipped\.ids,\.\.\.protectedIds\]\)/);
  assert.match(html,/function markStudied\(id,committedRevealY=revealY,clearSkipped=false,measuredGeometry=undefined,studyDefaultAnswer=defaultAnswer\)[\s\S]*draftSession\.revealY=Number\(committedRevealY\)\|\|0[\s\S]*return false/);
  assert.match(html,/mc\.addEventListener\("click",\(\)=>\{if\(!rowDisclosed\(w\.id\)&&canIndividuallyDisclose\(w\.id\)\)markStudied\(w\.id,revealY,true,undefined,defaultAnswer\)\}\)/);
  assert.match(html,/function toggleAnswer\(id\)\{\s*if\(!rowDisclosed\(id\)\|\|activeSession\?\.finalizedIds\?\.includes\(id\)\)return/);
  assert.match(html,/const restoreCommittedPosition=\(\)=>\{cancelDrag\(\);curtainUserDragging=false;revealY=Number\(activeSession\?\.revealY\|\|0\);positionCurtain\(\)\}/);
  assert.match(html,/const persistDragPosition=\(\)=>\{try\{saveActiveSession\(true,\[\],true\);return true\}catch\(error\)[\s\S]*restoreCommittedPosition\(\);return false\}/);
  assert.doesNotMatch(html,/safeRevealBoundary\(activeSession\?\.studiedIds/);
  assert.match(html,/function positionCurtain\(g=geometry\(\),\{preserveBoundary=false\}=\{\}\)[\s\S]*?const anchor=!preserveBoundary&&[\s\S]*?const frontierAnchor=!preserveBoundary&&[\s\S]*?els\.meaningCurtain\.style\.height=`\$\{Math\.max\(0,g\.height-revealY\)\}px`[\s\S]*?els\.curtainHandle\.style\.top=[\s\S]*?syncAnswerControl\(row,row\.dataset\.id,g\)/);
  assert.match(html,/function canIndividuallyDisclose\(id,measuredGeometry=undefined\)[\s\S]*?measuredGeometry===undefined\?geometry\(\):measuredGeometry/);
  assert.match(html,/row\.append\(wc,cc,mc\);syncMeaningDisclosure\(row,w\.id\);syncAnswerControl\(row,w\.id,null\)/);
  assert.match(html,/function historySlots\(id,st\)/);
  assert.match(html,/StudyCore\.buildHistoryPreview\(st\.recentResults,provisional\)/);
  assert.match(html,/function renderRecent\(recent,id,st\)/);
  assert.match(html,/\.history-slot\{display:block;min-width:0;text-align:center;color:#9299a3\}\.history-slot\.provisional\{color:#1f2328;text-decoration:underline;text-decoration-color:#1f2328/);
  assert.match(html,/if\(row\)\{syncAnswerControl\(row,id\);renderRecent\(row\.querySelector\('\.recent'\),id,getState\(id\)\)\}\}/);
  assert.match(html,/recordStudyDisclosure\(studyProgress,words,sortMode,randomIds,id\)/);
  assert.match(html,/saveCore\(localStorage,STORAGE_LEDGER,\{state:draftState,activeSession:progressedSession,gptSessions,registeredGptSessionIds,studyProgress:draftProgress,gptSkipped:draftSkipped\}\)/);
  assert.match(html,/renderAnswerControlFor\(id\);saveActiveSession\(true\)/);
  assert.match(html,/const recent=document\.createElement\("span"\);recent\.className="recent";renderRecent\(recent,w\.id,st\)/);
  assert.match(html,/\.word-meta\{grid-column:1 \/ -1;grid-row:2/);
  assert.doesNotMatch(html,/recent\.setAttribute\("aria-label","直近"/);
  assert.match(html,/meta\.append\(recent\);if\(isMastered\(st\)\)meta\.append\(makeMedalIcon\(\)\)/);
  assert.match(html,/if\(mastered&&!medal\)row\.querySelector\('\.recent'\)\.after\(makeMedalIcon\(\)\)/);
  assert.match(html,/function isMastered\(st\)\{return\(st\.currentStreak\|\|0\)>=masteryThreshold\}/);
  assert.match(html,/revealY=Number\(activeSession\?\.revealY\|\|0\);\s*if\(initialScreen==="study"\)\{render\(\);requestAnimationFrame\(\(\)=>positionCurtain\(\)\)\}/);
  assert.doesNotMatch(html,/requestAnimationFrame\(positionCurtain\)/);
  assert.match(html,/Number\(activeSession\?\.revealY\?\?revealY\)\|\|0,g\.height/);
  assert.match(html,/window\.addEventListener\("resize",correctAfterLayoutChange\)/);
  assert.match(html,/new ResizeObserver\(entries=>/);
  assert.doesNotMatch(html,/recentThree|className="streak"|\.streak\{/);
});
test('session frontier is the farthest reached ID in this session order and advances monotonically',()=>{
  const session={targetIds:['r','b','x','a'],studiedIds:['r','x'],gptRevealTargetId:'b'};
  assert.equal(C.sessionFurthestProgressId(session),'x');
  assert.equal(C.advanceSessionFrontier(session,'b').furthestProgressId,'x');
  assert.equal(C.advanceSessionFrontier(session,'a').furthestProgressId,'a');
  assert.equal(C.advanceSessionFrontier({...session,furthestProgressId:'a'},'r').furthestProgressId,'a');
  assert.equal(C.advanceSessionFrontier(session,'outside'),session);
  assert.equal(C.sessionFurthestProgressId({targetIds:['1','2'],studiedIds:[]}),null);
});
test('tip-return UI uses the session or preserved display frontier without invoking reveal learning',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/<button id="curtainReturnToggle" class="curtain-return-button hidden"[^>]*aria-label="続きに戻る"[^>]*disabled><svg/);
  assert.match(html,/<div id="curtainControls" class="curtain-controls hidden">\s*<button id="curtainReturnToggle"[\s\S]*?<button id="curtainLockToggle"/);
  assert.match(html,/\.curtain-controls\{position:absolute;z-index:22;display:flex;align-items:center;gap:8px\}/);
  assert.match(html,/\.curtain-controls\.is-curtain-locked\{position:fixed\}/);
  assert.match(html,/function positionCurtainControls\(g\)[\s\S]*?right=curtainLocked\?wrapRect\.left\+g\.left\+Math\.max\(0,g\.width-44\):g\.left\+Math\.max\(0,g\.width-44\),boundary=curtainLocked\?effectiveLockedY\(\):g\.top\+revealY[\s\S]*?right-\(pageSize===10\?0:46\)[\s\S]*?boundary\+20/);
  assert.match(html,/function scheduleLockedCurtainUpdate\(\)\{if\(lockScrollFrame\|\|!curtainLocked\)return;lockScrollFrame=requestAnimationFrame\(\(\)=>\{lockScrollFrame=0;if\(curtainLocked\)updateLockedCurtain\(\)\}\)\}/);
  assert.doesNotMatch(html,/setReturnButtonState\(geometry\(\)\)/,'normal scrolling relies on the shared absolute controls group instead of JS return-button tracking');
  assert.match(html,/function returnToSessionFrontier\(\)[\s\S]*?resolveDisplayFrontier\(activeSession,words,sortMode,randomIds\)\.learnedId[\s\S]*?saveActiveSession\(true,\[\],true\)[\s\S]*?updateLockedCurtain\(\{suppressRevealProcessing:true\}\)/);
  assert.match(html,/const updateResult=updateLockedCurtain\(\{suppressRevealProcessing:true\}\);[\s\S]*?if\(!curtainLocked&&updateResult!=="natural-end"\)return false;[\s\S]*?if\(!curtainLocked&&updateResult==="natural-end"\)[\s\S]*?const unlockedGeometry=geometry\(\)[\s\S]*?revealY=Number\(unlockedTarget\.bottom\)[\s\S]*?saveActiveSession/);
  assert.match(html,/function updateLockedCurtain\(\{suppressRevealProcessing=false\}=\{\}\)[\s\S]*?advanced&&!suppressRevealProcessing&&!processRevealProgress\(g\)/);
});
test('shared curtain control group aligns return and lock buttons for 10, 20, and 50 item pages',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const source=html.match(/function positionCurtainControls\(g\)\{([\s\S]*?)\n  \}/)?.[0];assert.ok(source);
  const position=new Function('input',`
    let curtainLocked=input.locked,pageSize=input.pageSize,revealY=input.revealY;
    const classes=new Set(),els={curtainControls:{classList:{remove(name){classes.delete(name)},toggle(name,on){if(on)classes.add(name);else classes.delete(name)},add(name){classes.add(name)}},style:{}},listWrap:{getBoundingClientRect(){return{left:input.wrapLeft}}}};
    function effectiveLockedY(){return input.effectiveY}
    ${source}
    positionCurtainControls(input.g);
    return{left:parseFloat(els.curtainControls.style.left),top:parseFloat(els.curtainControls.style.top),lockedClass:classes.has('is-curtain-locked')};
  `);
  for(const pageSize of [10,20,50]){
    const g={left:12,width:300,top:90},revealY=30,normal=position({pageSize,locked:false,revealY,wrapLeft:0,g});
    const right=g.left+g.width-44,groupLeft=right-(pageSize===10?0:46);
    assert.equal(normal.left,groupLeft);assert.equal(normal.top,g.top+revealY+20);assert.equal(normal.lockedClass,false);
    if(pageSize>10)assert.equal(groupLeft+38+8,right-0,'the return button and lock button retain an 8px gap with the lock on the original right edge');
    const locked=position({pageSize,locked:true,revealY,wrapLeft:40,effectiveY:260,g});
    assert.equal(locked.left,40+right-(pageSize===10?0:46));assert.equal(locked.top,280);assert.equal(locked.lockedClass,true);
  }
  assert.match(html,/function setLockButtonState\(g\)\{\s*const button=els\.curtainLockToggle;if\(!g\|\|pageSize===10\)\{button\.classList\.add\("hidden"\);return\}/);
  assert.match(html,/\.curtain-return-button\{position:static;display:grid;place-items:center;width:38px;height:34px/);
});
test('unlock preserves the locked viewport boundary and does not reapply learning or GPT anchors',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const release=html.match(/function releaseCurtainLock\(preserveViewportBoundary=false\)\{([\s\S]*?)\n  \}/)?.[0];
  const end=html.match(/function endCurtainLock\(\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(release&&end,'lock release functions should be present');
  assert.match(release,/priorEffectiveY=effectiveLockedY\(first\)/);
  assert.match(release,/revealY=Math\.max\(0,Math\.min\(priorEffectiveY-currentFirst\.getBoundingClientRect\(\)\.top,g\.height\)\)/);
  assert.match(release,/positionCurtain\(g,\{preserveBoundary:preserveViewportBoundary\}\)/);
  assert.match(end,/releaseCurtainLock\(true\)/);
  assert.match(html,/function positionCurtain\(g=geometry\(\),\{preserveBoundary=false\}=\{\}\)[\s\S]*?const anchor=!preserveBoundary&&[\s\S]*?const frontierAnchor=!preserveBoundary&&/);

  for(const {scrollY,firstTop,lockedY} of [
    {scrollY:0,firstTop:100,lockedY:340},
    {scrollY:720,firstTop:-620,lockedY:188},
    {scrollY:1080,firstTop:-980,lockedY:120}
  ]){
    const run=new Function('input',`
      let curtainLocked=true,lockedY=input.lockedY,lockLastRevealY=0,revealY=0,lockScrollFrame=0;
      let usedOptions=null,renderedViewportBoundary=null;
      const els={curtainLockToggle:{setAttribute(){}},words:{querySelector(){return{getBoundingClientRect(){return{top:input.firstTop}}}}}};
      const priorEffectiveY=Math.max(lockedY,input.firstTop);
      function effectiveLockedY(){return priorEffectiveY}
      function geometry(){return{height:2000}}
      function positionCurtain(g,options={}){usedOptions=options;if(!options.preserveBoundary)revealY=input.sessionAnchor;renderedViewportBoundary=input.firstTop+revealY}
      function cancelAnimationFrame(){}
      ${release}
      releaseCurtainLock(true);
      return{revealY,curtainLocked,lockedY,usedOptions,renderedViewportBoundary,renderedDocumentBoundary:input.scrollY+renderedViewportBoundary,expectedViewportY:priorEffectiveY,expectedDocumentBoundary:input.scrollY+priorEffectiveY};
    `)({scrollY,firstTop,lockedY,sessionAnchor:640});
    assert.equal(run.curtainLocked,false);
    assert.equal(run.lockedY,null);
    assert.equal(run.usedOptions.preserveBoundary,true);
    assert.equal(run.renderedViewportBoundary,run.expectedViewportY);
    assert.equal(run.renderedDocumentBoundary,run.expectedDocumentBoundary);
    assert.notEqual(run.revealY,640,'the learning anchor must not overwrite the released boundary');
  }
});
test('locked return flushes pre-return scroll disclosures before its own scroll and suppresses new thresholds',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const update=html.match(/function updateLockedCurtain\(\{suppressRevealProcessing=false\}=\{\}\)\{[\s\S]*?\n  \}/)?.[0];
  const returning=html.match(/function returnToSessionFrontier\(\)\{[\s\S]*?\n  \}/)?.[0];
  assert.ok(update&&returning);
  const run=new Function('input',`
    let curtainLocked=true,lockScrollFrame=7,lockedY=150,lockLastRevealY=40,revealY=0;
    const opened=[];
    const window={scrollY:400,scrollTo(_x,y){this.scrollY=y}};
    const thresholds=[{id:'already-satisfied-before-return',bottom:45},{id:'satisfied-only-after-return-scroll',bottom:250},{id:'target',bottom:300}];
    const first={getBoundingClientRect(){return{top:500-window.scrollY}}};
    const els={studyScreen:{hidden:false},words:{querySelector(){return first},querySelectorAll(){return[{getBoundingClientRect(){return{bottom:1400-window.scrollY}}}]}},studyActions:{getBoundingClientRect(){return{top:800}}}};
    const document={documentElement:{scrollHeight:2000}},innerHeight=852,activeSession={};
    const words=[],sortMode='normal',randomIds=[];
    const StudyCore={resolveDisplayFrontier(){return{learnedId:'target'}}};
    function geometry(){return{height:500,thresholds}}
    function positionCurtain(){}
    function processRevealProgress(){for(const item of thresholds)if(item.bottom<=revealY&&!opened.includes(item.id))opened.push(item.id);return true}
    function saveActiveSession(){return true}
    function endCurtainLock(){curtainLocked=false;lockedY=null;return true}
    function effectiveLockedY(){return Math.max(lockedY,first.getBoundingClientRect().top)}
    function cancelAnimationFrame(){}
    ${update}
    ${returning}
    const returned=returnToSessionFrontier();
    return{returned,opened,scrollY:window.scrollY,revealY,lockLastRevealY,curtainLocked};
  `)({});
  assert.deepEqual(run.opened,['already-satisfied-before-return']);
  assert.equal(run.scrollY,650);
  assert.equal(run.revealY,300);
  assert.equal(run.lockLastRevealY,300);
  assert.equal(run.curtainLocked,true);
  assert.equal(run.returned,true);
});
test('normal order keeps fixed ranges and original numbering with filtered gaps', () => {
  const words=Array.from({length:10},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:''}));
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
test('normal next-page navigation wraps and skips excluded empty pages', () => {
  const pages=[
    {index:0,entries:[{id:'1'}]},
    {index:1,entries:[]},
    {index:2,entries:[{id:'21'}]},
    {index:3,entries:[]}
  ];
  assert.equal(C.nextAvailablePageIndex(pages,0),2);
  assert.equal(C.nextAvailablePageIndex(pages,1),2,'from a temporarily retained empty page, next follows the physical page order');
  assert.equal(C.nextAvailablePageIndex(pages,2),0);
  assert.equal(C.nextAvailablePageIndex(pages,3),0,'wrap only after checking later physical pages');
  assert.equal(C.nextAvailablePageIndex([{index:0,entries:[{id:'only'}]}],0),0);
  assert.equal(C.nextAvailablePageIndex([{index:0,entries:[]}],0),null);
  assert.equal(C.nextAvailablePageIndex([],0),null);
});
test('random page navigation advances by the fixed range end and distinguishes final or empty lists', () => {
  assert.deepEqual(C.randomPageNavigation({startIndex:10,endIndex:20,total:35},35),{canNext:true,canReshuffle:false,nextStart:20});
  assert.deepEqual(C.randomPageNavigation({startIndex:30,endIndex:35,total:35},35),{canNext:false,canReshuffle:true,nextStart:null});
  assert.deepEqual(C.randomPageNavigation({startIndex:10,endIndex:20,total:35,entries:[]},35),{canNext:true,canReshuffle:false,nextStart:20});
  assert.deepEqual(C.randomPageNavigation({startIndex:0,endIndex:0,total:0},0),{canNext:false,canReshuffle:false,nextStart:null});
  assert.deepEqual(C.randomPageNavigation({startIndex:0,endIndex:1,total:1},1),{canNext:false,canReshuffle:true,nextStart:null});
});
test('normal next and random navigation share the fixed study footer without changing controls', () => {
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/id="randomNav" class="random-nav" hidden/);
  assert.match(html,/id="randomNext" class="primary" hidden>次へ/);
  assert.match(html,/id="reshuffle" hidden>再シャッフル/);
  assert.match(html,/els\.tabs\.hidden=sortMode==="random"/);
  assert.match(html,/if\(sortMode==="random"\)return/);
  assert.match(html,/id="pagePositionRow" class="page-position-row"/);
  assert.doesNotMatch(html,/pagePositionRow\.hidden|count\.hidden/);
  assert.match(html,/const positionPages=sortMode==="random"\?model\.pages:model\.pages\.filter\(item=>item\.entries\.length>0\)/);
  assert.match(html,/const currentPosition=sortMode==="random"\?randomStart:pageIndex/);
  assert.match(html,/const positionIndex=positionPages\.findIndex\(item=>item\.index===currentPosition\)/);
  assert.match(html,/id="normalNext" class="primary" hidden>次へ/);
  const actions=html.match(/<div class="study-actions study-footer"[\s\S]*?<\/div>/)?.[0];
  assert.match(actions,/id="repeatStudy"[\s\S]*id="normalNext"[\s\S]*id="randomNext"[\s\S]*id="reshuffle"/);
  assert.doesNotMatch(html,/normal-next-row|normalNextRow/);
  assert.match(html,/StudyCore\.nextAvailablePageIndex\(model\.pages,pageIndex\)/);
  const nextHandler=html.match(/function nextNormalPage\(\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.match(nextHandler,/pageTransitionNeedsConfirmation\("途中までの学習結果を確定して、次のページへ進みますか？"\)/);
  assert.match(nextHandler,/requestViewTransition\(\{\.\.\.currentView\(\),pageIndex:next\}\)/);
  assert.equal((nextHandler.match(/pageTransitionNeedsConfirmation\(/g)||[]).length,1);
  const requestTransition=html.match(/function requestViewTransition\(view,options\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.doesNotMatch(requestTransition,/confirm\(/);
  assert.match(html,/els\.randomProgress\.textContent=page\.total\?`\$\{page\.startIndex\+1\}–\$\{page\.endIndex\} · 残\$\{current\.length\}`:"0–0 · 残0"/);
  assert.match(html,/\.random-nav\{display:flex;align-items:center;box-sizing:border-box;min-width:0;min-height:46px;padding:2px 0 8px\}/);
  assert.doesNotMatch(html,/<div id="randomProgress" class="random-progress"[^>]*>\s*<button/);
  assert.match(html,/function ensureActiveTabVisible\(\)[\s\S]*?els\.tabs\.scrollLeft/);
  assert.match(html,/id="pagePosition" class="page-position">0 \/ 0 ページ/);
  assert.match(html,/\.study-actions\.study-footer\{position:fixed;z-index:50;left:50%;bottom:calc\(12px \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(html,/env\(safe-area-inset-bottom,0px\)/);
  assert.match(html,/id="studyFooterSpacer"/);
  assert.match(html,/els\.count\.textContent=`全\$\{model\.total\}問`/);
  assert.match(html,/sortMode==="normal"&&model\.pages\.length&&page&&!current\.length[\s\S]*?\$\{pageIndex\+1\} \/ \$\{model\.pages\.length\} ページ/);
  assert.match(html,/els\.randomNext\.addEventListener\("click",nextRandomPage\)/);
  assert.match(html,/els\.reshuffle\.addEventListener\("click",reshuffleRandomOrder\)/);
  assert.match(html,/requestViewTransition\(\{\.\.\.currentView\(\),randomStart:navigation\.nextStart\}\)/);
  assert.match(html,/requestViewTransition\(\{\.\.\.currentView\(\),sortMode:"random",randomStart:0\},\{nextRandomIds:order,writeRandomOrder:true\}\)/);
  assert.match(html,/途中までの学習結果を確定して、次のページへ進みますか？/);
});
test('empty filtered pages stay selected, persist their fixed index, and show the shared mastery medal',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const buildTarget=html.match(/function buildTarget\(([\s\S]*?)\n  \}/)?.[0];
  assert.match(buildTarget,/keepEmptyPage=false/);
  assert.match(buildTarget,/keepEmptyPage&&model\.pages\.length\?requestedIndex:StudyCore\.safePageIndex/,'empty-page retention is opt-in and safe fallback remains available');
  assert.match(html,/const model=pageModel\(\),target=buildTarget\(currentView\(\),state,words,randomIds,pageSize,true\)/);
  assert.match(html,/buildTarget\(view,draftState,nextWords,nextRandomIds,nextPageSize,true\)/);
  assert.match(html,/b\.disabled=page\.entries\.length===0;b\.classList\.toggle\("active",i===pageIndex\)/);
  assert.match(html,/function isMasteryCompletePage\(page\)[\s\S]*if\(!words\.length\|\|!excludeStreak\|\|filter!=="all"\|\|!page\)return false/);
  assert.match(html,/makeMedalIcon\(\);medal\.setAttribute\("aria-hidden","true"\)[\s\S]*このページの単語をすべて習得しました！/);
  assert.match(html,/\?`\$\{pageIndex\+1\} \/ \$\{model\.pages\.length\} ページ`/);
  const restart=html.match(/function restartViewSession\(nextView=currentView\(\)\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.match(restart,/return requestViewTransition\(nextView\)/);assert.doesNotMatch(restart,/pageIndex:0/);
});
test('page-size change scrolls to the first answer row below the restored curtain boundary',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const pageSize=html.match(/function changePageSizePreservingLearningPosition\(nextPageSize\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.match(pageSize,/requestAnimationFrame\(\(\)=>\{positionCurtain\(\);syncStudyFooterSpacer\(\);requestAnimationFrame\(scrollToCurtainResumePosition\)\}\)/);
  const scroll=html.match(/function scrollToCurtainResumePosition\(\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.match(scroll,/item\.bottom\)>boundary\+1/);
  assert.match(scroll,/window\.scrollTo\(0,next\)/);
  assert.match(scroll,/if\(!g\?\.thresholds\.length\)return false/);
});
test('compact row actions gate shared explanation popup on disclosure without persisting popup state',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/\.word-row\{display:grid;grid-template-columns:minmax\(0,210px\) 28px minmax\(0,1fr\)/);
  assert.match(html,/\.words\{display:flex;flex-direction:column;gap:7px\}/);
  assert.match(html,/\.word-row\{grid-template-columns:minmax\(96px,max\(96px,min\(calc\(\(100% - 54px\)\/2\),calc\(100% - 164px\)\)\)\) 28px minmax\(110px,1fr\);gap:6px;padding:5px 6px\}/);
  assert.match(html,/\.row-actions\{display:grid;grid-template-rows:28px 20px;align-items:center;justify-items:center;align-self:center;gap:0;width:28px;height:48px/);
  assert.match(html,/\.row-actions button\{[^}]*width:28px[^}]*background:#f7f8fa/);
  assert.match(html,/\.answer-toggle\{height:28px;min-height:28px;font-size:1\.05rem\}/);
  assert.match(html,/\.row-actions \.explanation-button\{width:28px;height:20px;min-height:20px;padding:0;border:0;background:transparent;color:#2563eb/);
  assert.match(html,/\.explanation-button svg\{display:block;width:16px;height:16px/);
  assert.match(html,/\.row-actions\{display:grid;grid-template-rows:28px 20px;align-items:center;justify-items:center;align-self:center;gap:0;width:28px;height:48px/);
  assert.match(html,/<div id="explanationPopup" class="explanation-popup" role="tooltip" aria-hidden="true" hidden><\/div>/);
  assert.match(html,/const explanation=document\.createElement\("button"\);explanation\.type="button";explanation\.className="explanation-button";explanation\.dataset\.id=String\(w\.id\);explanation\.dataset\.explanation=String\(w\.explanation\|\|""\)/);
  assert.match(html,/cc\.appendChild\(explanation\)/);
  assert.match(html,/book\.setAttribute\("viewBox","0 0 24 24"\)/);
  assert.match(html,/bookPath\.setAttribute\("d","M12 6\.5/);
  assert.doesNotMatch(html,/textContent="ⓘ"/);
  assert.match(html,/function rowDisclosed\(id\)\{return\(activeSession\?\.studiedIds\|\|\[\]\)\.some\(value=>String\(value\)===String\(id\)\)\}/);
  assert.match(html,/function syncExplanationControl\(row,id\)[\s\S]*hasExplanation=!!String\(button\.dataset\.explanation\|\|""\)\.trim\(\),available=hasExplanation&&rowDisclosed\(id\);button\.disabled=!available/);
  assert.match(html,/function showExplanationPopup\(button,clientX,clientY,pointerType="mouse",contactHeight=0\)[\s\S]*if\(!String\(explanation\|\|""\)\.trim\(\)\|\|!rowDisclosed\(id\)\)return/);
  assert.match(html,/if\(pointerType==="touch"\)[\s\S]*fingerHalfHeight=Math\.max\(24,\(Number\(contactHeight\)\|\|0\)\/2\),gap=24/);
  assert.match(html,/fitsAbove=popup\.height<=aboveSpace,fitsBelow=popup\.height<=belowSpace/);
  assert.match(html,/style\.maxHeight=`\$\{Math\.max\(0,available-padding-borders\)\}px`/);
  assert.match(html,/function hideExplanationPopup\(\)[\s\S]*els\.explanationPopup\.style\.maxHeight=""/);
  assert.match(html,/els\.explanationPopup\.textContent=explanation/);
  assert.doesNotMatch(html,/explanationPopup\.innerHTML/);
  assert.match(html,/addEventListener\("pointerdown",event=>beginExplanationPress/);
  assert.match(html,/addEventListener\("pointerleave",endExplanationPress\)/);
  assert.match(html,/addEventListener\("pointercancel",endExplanationPress\)/);
  assert.match(html,/function beginExplanationKey\(event,button\)[\s\S]*\['Enter',' '\]/);
  assert.match(html,/window\.addEventListener\("pointerup"/);
  assert.match(html,/window\.addEventListener\("pointercancel"/);
  assert.match(html,/function beginExplanationPress\(event,button\)\{if\(button\.disabled\|\|event\.button>0\)return;event\.stopPropagation\(\);explanationPointerId=event\.pointerId;showExplanationPopup\(button,event\.clientX,event\.clientY,event\.pointerType,event\.height\)\}/);
  assert.match(html,/function hideExplanationPopup\(\)[\s\S]*els\.explanationPopup\.hidden=true/);
  assert.match(html,/function renderRowsOnly\(current,page\)\{\s*hideExplanationPopup\(\)/);
  assert.match(html,/function showHome\(\)\{\s*hideExplanationPopup\(\)/);
  assert.doesNotMatch(html,/STORAGE_EXPLANATION|explanationPopup.*localStorage/);
});
test('study screen groups controls, exposes accessible header icons, and places actions after the list', () => {
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/<header class="app-header">[\s\S]*?<h1 class="app-title">Word List Study<\/h1>[\s\S]*?id="goHome" class="icon-button"[^>]*aria-label="ホーム"[^>]*><svg[\s\S]*?id="openSettings"[^>]*aria-label="設定"[^>]*>[\s\S]*?id="openGpt"[^>]*aria-label="GPT学習"/);
  assert.match(html,/<dialog id="settingsPanel"[\s\S]*?<details id="csvHelpDetails" open><summary>CSV形式と読み込みについて<\/summary>[\s\S]*?id,question,answer,explanation[\s\S]*?id,word,meaning[\s\S]*?<\/details>[\s\S]*?<\/dialog>/);
  assert.match(html,/<section class="settings-section" aria-labelledby="learningSettingsTitle">[\s\S]*?1ページの表示問題数[\s\S]*?id="defaultAnswer"[\s\S]*?id="masteryThreshold"[\s\S]*?<\/section>/);
  const settingsDialog=html.match(/<dialog id="settingsPanel"[\s\S]*?<\/dialog>/)?.[0];
  const gptDialog=html.match(/<dialog id="gptPanel"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(settingsDialog&&gptDialog);
  assert.doesNotMatch(settingsDialog,/id="gptWordCount"/);
  const gptStep1=gptDialog.match(/<section class="gpt-step" aria-labelledby="gptStep1Title">[\s\S]*?<\/section>/)?.[0];
  const gptStep2=gptDialog.match(/<section class="gpt-step" aria-labelledby="gptStep2Title">[\s\S]*?<\/section>/)?.[0];
  const gptStep3=gptDialog.match(/<section class="gpt-step" aria-labelledby="gptStep3Title">[\s\S]*?<\/section>/)?.[0];
  assert.ok(gptStep1&&gptStep2&&gptStep3);
  assert.match(gptStep1,/id="gptWordCount"[\s\S]*?id="gptStartPosition"/);
  assert.doesNotMatch(gptStep1,/id="makeSession"/);
  assert.match(gptStep2,/id="makeSession"[\s\S]*?id="gptPromptPreview"[^>]*hidden[\s\S]*?プロンプト発行済み[\s\S]*?id="copyChatGpt"[^>]*aria-label="プロンプトをコピー"[^>]*><svg[\s\S]*?id="gptPromptText"[\s\S]*?id="openChatGpt"[^>]*hidden/);
  assert.doesNotMatch(gptDialog,/id="gptIssueConfirm"/);
  assert.doesNotMatch(gptDialog,/id="copySession"|id="sessionUrl"|id="chatGptUrl"|gpt-url-details/);
  assert.match(gptDialog,/aria-labelledby="gptStep3Title"[\s\S]*?ChatGPTで学習した結果のJSONを貼り付けてください[\s\S]*?id="resultJson"[\s\S]*?id="applyResults"/);
  assert.match(gptDialog,/id="makeSession" class="gpt-action gpt-step-action gpt-issue-button">プロンプトを発行/);
  assert.match(gptDialog,/id="gptPromptPreview" class="gpt-prompt-preview" hidden/);
  assert.match(gptDialog,/id="gptPromptText" class="gpt-prompt-text" tabindex="0"/);
  assert.match(gptDialog,/id="openChatGpt" class="primary gpt-action gpt-step-action gpt-open-action" disabled hidden/);
  assert.match(gptDialog,/id="copyChatGpt" class="gpt-prompt-copy-button" type="button" disabled[^>]*><svg/);
  assert.match(gptDialog,/id="applyResults" class="gpt-action gpt-step-action gpt-result-action"/);
  assert.match(html,/\.gpt-fields\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(html,/\.gpt-fields \.settings-item\{display:grid;grid-template-columns:minmax\(5\.8em,1fr\) minmax\(0,min\(220px,58%\)\)/);
  assert.match(html,/\.gpt-step-action\{justify-self:start;width:min\(232px,100%\);white-space:nowrap\}/);
  assert.match(gptStep1,/<label for="gptWordCount">問題数<\/label>[\s\S]*?<label for="gptStartPosition">開始位置<\/label>/);
  assert.match(html,/\.gpt-open-action,\.gpt-result-action\{justify-self:end\}/);
  assert.match(html,/\.gpt-prompt-text\{[^}]*height:60px[^}]*user-select:text/);
  assert.match(html,/\.gpt-prompt-text\{[^}]*border:0/);
  assert.match(html,/\.gpt-prompt-preview\{[^}]*border:1px solid/);
  assert.match(html,/\.gpt-prompt-preview\{[^}]*width:100%/);
  assert.match(html,/\.gpt-prompt-copy-button\{[^}]*min-height:30px/);
  assert.match(html,/#gptPanel #resultJson\{[^}]*max-height:26dvh/);
  assert.match(html,/@media\(max-width:560px\)[\s\S]*?\.study-actions\.study-footer\{bottom:env\(safe-area-inset-bottom,0px\)\}/);
  assert.match(html,/\.modal-close\{[^}]*width:36px;height:36px/);
  assert.match(html,/\.modal-header\{position:sticky/);
  assert.match(html,/\.settings-item select\{[^}]*min-height:34px[^}]*border-radius:8px/);
  assert.match(html,/\.settings-section>:not\(h2\)\{margin-left:14px;min-width:0;box-sizing:border-box\}/);
  assert.match(html,/\.settings-section\[aria-labelledby="learningSettingsTitle"\]>.settings-item\{display:grid;grid-template-columns:minmax\(0,1fr\) 120px;gap:10px;min-height:42px\}/);
  assert.match(html,/\.settings-section\[aria-labelledby="learningSettingsTitle"\]>.settings-item select\{box-sizing:border-box;width:120px;height:42px;min-height:42px/);
  assert.match(html,/class="mastery-setting"[^>]*>[\s\S]*?<\/svg>判定（連続正答）<\/label>/);
  assert.match(html,/\.data-action-row\{display:grid;grid-template-columns:160px minmax\(0,1fr\)/);
  assert.match(html,/\.data-action-row button,\.settings-section\[aria-labelledby="csvSettingsTitle"\]>.file-btn\{[^}]*width:180px[^}]*height:42px;min-height:42px/);
  assert.match(html,/\.data-action-row button\{width:160px;justify-self:start\}/);
  assert.match(html,/\.gpt-step>:not\(\.gpt-step-heading\)\{margin-left:22px;min-width:0;box-sizing:border-box\}/);
  assert.match(html,/\.gpt-step>\.gpt-prompt-preview\{width:calc\(100% - 22px\)\}/);
  assert.match(html,/\.gpt-step>#openChatGpt\{width:min\(232px,calc\(100% - 22px\)\);margin-left:0\}/);
  assert.match(html,/const STORAGE_CSV_HELP_OPEN="wordlist\.csvHelpOpen\.v1"/);
  assert.match(html,/if\(savedCsvHelpOpen==="open"\|\|savedCsvHelpOpen==="closed"\)els\.csvHelpDetails\.open=savedCsvHelpOpen==="open"/);
  assert.match(html,/els\.csvHelpDetails\.addEventListener\("toggle",\(\)=>\{try\{localStorage\.setItem\(STORAGE_CSV_HELP_OPEN,els\.csvHelpDetails\.open\?"open":"closed"\)\}catch\{\}\}\)/);
  assert.match(html,/@media\(max-width:560px\)[\s\S]*?\.data-action-row\{grid-template-columns:160px minmax\(0,1fr\);gap:7px\}/);
  assert.match(html,/<section class="settings-section" aria-labelledby="csvSettingsTitle">[\s\S]*?id="csvFile"[\s\S]*?<\/section>/);
  assert.match(html,/<section class="settings-section" aria-labelledby="dataSettingsTitle">[\s\S]*?<div class="data-action-row"><button id="resetSettings"[\s\S]*?学習履歴や登録データは消去されません[\s\S]*?<div class="data-action-row"><button id="clearData"[\s\S]*?この端末の学習データと履歴を削除します[\s\S]*?<\/section>/);
  assert.match(html,/id="closeSettings" class="modal-close"[^>]*aria-label="設定を閉じる"[^>]*><svg/);
  assert.match(html,/id="closeGpt" class="modal-close"[^>]*aria-label="GPT学習を閉じる"[^>]*><svg/);
  const issueConfirm=html.match(/<dialog id="gptIssueConfirm"[^>]*>[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(issueConfirm,'pending issue confirmation is an independent native modal dialog');
  assert.match(issueConfirm,/id="gptIssueConfirmTitle">前回の学習結果が未反映です/);
  assert.match(issueConfirm,/id="gptIssueConfirmDescription">新しいプロンプトを発行しますか？/);
  assert.match(issueConfirm,/id="cancelGptIssue"[^>]*autofocus[^>]*>キャンセル[\s\S]*?id="confirmGptIssue"[^>]*>発行する/);
  assert.match(html,/dialog\.gpt-issue-confirm-dialog::backdrop/);
  assert.match(html,/\.gpt-issue-confirm-actions #confirmGptIssue[\s\S]*?-webkit-text-fill-color:#fff!important/);
  assert.match(html,/\.gpt-issue-confirm-actions #cancelGptIssue[\s\S]*?-webkit-text-fill-color:#273244!important/);
  assert.match(html,/document\.addEventListener\("keydown",event=>\{if\(event\.key!=="Escape"\|\|!els\.gptIssueConfirm\.open\)return;event\.preventDefault\(\);event\.stopImmediatePropagation\(\)/);
  assert.match(html,/function latestUnregisteredGptSessionId\(\)[\s\S]*Math\.max\(gptIssueSequence,\.\.\.sequences\)[\s\S]*record\?\.issueSequence===latestIssueSequence/);
  assert.match(html,/function resetGptIssueUi\(\)[\s\S]*els\.gptIssueConfirm\.close\("reset"\);els\.makeSession\.hidden=false;[\s\S]*els\.gptPromptPreview\.hidden=true;[\s\S]*els\.openChatGpt\.hidden=true/);
  assert.match(html,/els\.settingsPanel\.addEventListener\("click",event=>\{if\(event\.target===els\.settingsPanel\)els\.settingsPanel\.close\(\)\}\)/);
  assert.match(html,/els\.gptPanel\.addEventListener\("click",event=>\{if\(!els\.gptIssueConfirm\.open&&event\.target===els\.gptPanel\)els\.gptPanel\.close\(\)\}\)/);
  assert.match(html,/id="saveListTitle"[^>]*aria-label="タイトルを保存"/);
  assert.match(html,/id="cancelListTitle"[^>]*aria-label="編集を取り消す"/);
  assert.match(html,/\.home-study-heading\{position:relative;display:flex;[^}]*min-height:44px/);
  assert.match(html,/\.home-title-editor\{position:absolute;inset:0/);
  assert.match(html,/\.home-title-editor button\{display:grid;place-items:center;flex:0 0 34px/);
  assert.match(html,/function pendingStudyTransitionNeedsConfirmation\(message\)\{[\s\S]*hideExplanationPopup\(\);[\s\S]*StudyCore\.approvePendingStudyTransition\(activeSession,\(\)=>confirm\(message\)\)/);
  assert.match(html,/function orderChangeNeedsConfirmation\(\)\{return pendingStudyTransitionNeedsConfirmation\("現在の学習結果を確定して、学習順序を切り替えますか？"\)\}/);
  assert.match(html,/excludeStreak\.addEventListener\("change",\(\)=>\{[\s\S]*pendingStudyTransitionNeedsConfirmation\("現在の学習結果を確定して、習得済み除外の設定を切り替えますか？"\)[\s\S]*els\.excludeStreak\.checked=excludeStreak/);
  assert.match(html,/if\(!restartViewSession\(\{\.\.\.currentView\(\),excludeStreak:els\.excludeStreak\.checked\}\)\)\{[\s\S]*els\.excludeStreak\.checked=excludeStreak/);
  assert.match(html,/normalOrder\.addEventListener\("click",\(\)=>\{[\s\S]*?if\(sortMode==="normal"\)return;if\(!orderChangeNeedsConfirmation\(\)\)return;[\s\S]*?viewForOrderResume\("normal",nextOrderResume\)/);
  assert.match(html,/randomOrder\.addEventListener\("click",\(\)=>\{[\s\S]*?if\(!orderChangeNeedsConfirmation\(\)\)return;/);
  assert.match(html,/els\.closeSettings\.addEventListener\("click",\(\)=>els\.settingsPanel\.close\(\)\)/);
  assert.match(html,/els\.closeGpt\.addEventListener\("click",\(\)=>els\.gptPanel\.close\(\)\)/);
  const resetSettingsHandler=html.match(/els\.resetSettings\.addEventListener\("click",\(\)=>\{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(resetSettingsHandler,'settings reset has an isolated handler');
  assert.match(resetSettingsHandler,/if\(pageSize===10&&masteryThreshold===3&&defaultAnswer==="wrong"\)return/);
  assert.doesNotMatch(resetSettingsHandler,/gptWordCount/);
  assert.match(resetSettingsHandler,/changeDisplaySettings\(10,3,"wrong"\)/);
  assert.match(html,/answer\.type="button";answer\.className="answer-toggle"/);
  assert.match(html,/cc\.className="row-actions"/);
  assert.match(html,/answer\.addEventListener\("click",\(\)=>toggleAnswer\(w\.id\)\)/);
  assert.match(html,/if\(!changed\)\{renderAnswerControlFor\(id\);return\}\s*renderAnswerControlFor\(id\);saveActiveSession\(true\)/);
  assert.match(html,/button\.setAttribute\("aria-pressed",String\(revealed&&correct\)\)/);
  assert.match(html,/button\.disabled=!revealed\|\|!!activeSession\?\.finalizedIds\?\.includes\(id\)/,'evaluation controls remain disabled until the individual mask is opened');
  const toggle=html.match(/function toggleAnswer\(id\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.match(toggle,/if\(!rowDisclosed\(id\)\|\|activeSession\?\.finalizedIds\?\.includes\(id\)\)return/);
  assert.doesNotMatch(toggle,/markStudied/,'answer button cannot disclose an unopened row');
  assert.match(html,/初回露出時のデフォルト評価/);
  const header=html.match(/<header class="app-header">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header);
  assert.doesNotMatch(header,/CSV形式:/);
  const study=html.match(/<main class="study-shell">([\s\S]*?)<\/main>/)?.[1];
  assert.ok(study,'all study controls and list should share one study region');
  const progressHeading=study.match(/<div class="progress-overview-heading">([\s\S]*?)<\/div>/)?.[1];
  assert.match(progressHeading,/<svg class="medal-icon progress-overview-medal"[^>]*viewBox="0 0 20 24">([\s\S]*?)<\/svg><span class="progress-overview-label">習得率<\/span>/);
  const settingsMedal=study.match(/<label class="mastery-switch">\s*(<svg class="medal-icon"[\s\S]*?<\/svg>)/)?.[1];
  const progressMedal=progressHeading?.match(/(<svg[^>]*>)([\s\S]*?)<\/svg>/)?.slice(1);
  assert.ok(settingsMedal&&progressMedal,'progress heading reuses the mastery medal artwork');
  assert.equal(settingsMedal.match(/viewBox="([^"]+)"/)?.[1],progressMedal[0].match(/viewBox="([^"]+)"/)?.[1]);
  assert.equal(settingsMedal.replace(/^[\s\S]*?>/,'').replace(/<\/svg>$/,''),progressMedal[1]);
  assert.match(html,/\.progress-overview\{display:grid;grid-template-columns:auto auto minmax\(0,1fr\) 42px;grid-template-rows:minmax\(52px,auto\);align-items:start;[\s\S]*?border-bottom:1px solid var\(--border\)\}/);
  assert.match(html,/\.progress-overview-heading\{grid-column:1;grid-row:1/);
  assert.match(html,/\.progress-overview #studyMasteryRing\{grid-column:2;grid-row:1\}/);
  assert.match(html,/\.progress-overview \.progress-overview-medal\{width:14px;height:17px\}/);
  assert.match(html,/\.progress-overview-label\{color:var\(--text\);font-size:\.88rem;font-weight:650\}/);
  assert.match(html,/\.progress-open-button\{grid-column:4;grid-row:1;align-self:end/);
  assert.match(html,/\.distribution-legend\{display:flex;flex-wrap:wrap;align-content:flex-start;gap:5px 14px;[\s\S]*?line-height:1\.4;min-height:calc\(2 \* 1\.4em \+ 6px\)\}/);
  assert.match(html,/\.study-controls\{display:flex;[\s\S]*?border-bottom:1px solid var\(--border\)\}/);
  assert.match(study,/<div class="study-controls"[\s\S]*id="normalOrder"[\s\S]*id="randomOrder"[\s\S]*id="excludeStreak" type="checkbox" role="switch"/);
  assert.doesNotMatch(study,/非正答あり|data-filter=/);
  assert.equal((study.match(/class="medal-icon/g)||[]).length,3);
  assert.equal((html.match(/class="medal-icon/g)||[]).length,4);
  assert.match(html,/aria-checked="false"/);
  assert.ok(study.indexOf('id="listWrap"')<study.indexOf('class="study-actions study-footer"'));
  const actions=study.match(/<div class="study-actions study-footer"[\s\S]*?<\/div>/)?.[0];
  assert.match(actions,/id="repeatStudy"/);
  assert.match(actions,/id="normalNext"/);
  assert.match(actions,/id="randomNext"/);
  assert.match(actions,/id="reshuffle"/);
  assert.doesNotMatch(html,/id="resetCurtain"|function resetCurtain\(|els\.resetCurtain/);
  assert.doesNotMatch(html,/CSV登録順を.*固定範囲に分けてからフィルタします/);
  assert.match(html,/通常順ではCSV登録順の固定範囲をタブに分け/);
  assert.match(html,/page\.start\}–\$\{page\.end\} · 残\$\{page\.entries\.length\}/);
  assert.match(html,/id="curtainLockToggle" class="curtain-lock-button hidden"[^>]*aria-label="カーテンをロック"/);
  assert.match(html,/function updateLockedCurtain\(\{suppressRevealProcessing=false\}=\{\}\)[\s\S]*?effectiveY=Math\.max\(lockedY,firstClientY\)[\s\S]*?advanced&&!suppressRevealProcessing&&!processRevealProgress\(g\)[\s\S]*?querySelectorAll\("\.word-row"\)[\s\S]*?window\.scrollY>=naturalScrollMax&&Math\.abs\(lastBottom-\(footerTop-12\)\)<=2/);
  assert.match(html,/const rows=els\.words\.querySelectorAll\("\.word-row"\),last=rows\[rows\.length-1\],footerTop=els\.studyActions\.getBoundingClientRect\(\)\.top/);
  assert.match(html,/function beginCurtainLock\(\)[\s\S]*?syncStudyFooterSpacer\(\);[\s\S]*?const footerTop=els\.studyActions\.getBoundingClientRect\(\)\.top,clearance=54[\s\S]*?boundary\+clearance>footerTop-1/);
  assert.doesNotMatch(html,/lockBaselineViewportY|ensureLockBaseline|boundary<baseline-1/);
  assert.match(html,/function beginCurtainLock\(\)\{\s*if\(pageSize===10\)\{releaseCurtainLock\(\);return false\}/);
  assert.match(html,/function setLockButtonState\(g\)\{\s*const button=els\.curtainLockToggle;if\(!g\|\|pageSize===10\)/);
  assert.match(html,/function effectiveLockedY\(first=els\.words\.querySelector\("\.meaning-cell"\)\)[\s\S]*?Math\.max\(lockedY,first\.getBoundingClientRect\(\)\.top\)/);
  assert.match(html,/\.word-meta \.recent\{display:inline-grid;grid-template-columns:repeat\(5,minmax\(0,1fr\)\);align-items:center;flex:0 0 5em;width:5em/);
  assert.match(html,/\.history-slot\{display:block;min-width:0;text-align:center;color:#9299a3\}/);
  assert.doesNotMatch(html,/lockRunway|setLockRunwayForTarget/);
  assert.match(html,/\.meaning-curtain\.is-curtain-locked,\.curtain-handle\.is-curtain-locked,\.curtain-controls\.is-curtain-locked\{position:fixed\}/);
  assert.match(html,/\.curtain-controls\{position:absolute;z-index:22;display:flex;align-items:center;gap:8px\}/);
  assert.match(html,/\.curtain-lock-button\{display:grid;place-items:center;width:38px;height:34px;min-height:34px/);
  assert.match(html,/function releaseCurtainLock\(preserveViewportBoundary=false\)[\s\S]*?curtainLocked=false;lockedY=null/);
  assert.match(html,/const didJump=!!draft\.jump\?\.canJump;\s*const changedPage=draft\.transition\?\.kind==="jump"&&didJump;\s*if\(didJump&&curtainLocked\)\{releaseCurtainLock\(\)\}/);
  assert.match(html,/if\(curtainLocked&&draft\.samePage&&!draft\.jump\?\.canJump&&draft\.activeSession\?\.gptRevealTargetId\)\{\s*draft\.activeSession\.gptRevealTargetId=null/);
  assert.match(html,/if\(curtainLocked\)endCurtainLock\(\);else beginCurtainLock\(\)/);
  assert.match(html,/window\.addEventListener\("scroll",scheduleLockedCurtainUpdate,\{passive:true\}\)/);
  assert.match(html,/els\.curtainHandle\.addEventListener\("pointerdown"/);
  assert.match(html,/els\.curtainHandle\.addEventListener\("pointermove"/);
  assert.match(html,/els\.openSettings\.addEventListener\("click"/);
  assert.match(html,/els\.openGpt\.addEventListener\("click"/);
});
test('home and study screen switching preserves the active study session without finalizing it', () => {
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/<section id="homeScreen"[^>]*hidden>/);
  assert.match(html,/#homeScreen\[hidden\],#studyScreen\[hidden\]\{display:none!important\}/);
  assert.match(html,/#homeRegistrationCard\[hidden\],#homeStudyCard\[hidden\]\{display:none!important\}/);
  const registrationCard=html.match(/<div id="homeRegistrationCard"[\s\S]*?(?=\n    <div id="homeStudyCard")/)?.[0]||'';
  assert.match(registrationCard,/class="home-panel registration" hidden/);
  assert.match(registrationCard,/学習データを登録[\s\S]*?CSVを選択[\s\S]*?id="homeCsvFile"/);
  assert.match(html,/<div id="homeStudyCard" class="home-panel study" hidden>[\s\S]*?id="homeListTitle"[\s\S]*?id="editListTitle"[\s\S]*?id="homeTitleEditor"[\s\S]*?id="homeQuestionCount"[\s\S]*?<button id="startStudy"[^>]*>学習する<\/button>[\s\S]*?<\/div>/);
  assert.match(html,/<div id="studyScreen">[\s\S]*?<header class="app-header">[\s\S]*?<main class="study-shell">[\s\S]*?<dialog id="gptPanel"/);
  assert.match(html,/<button id="goHome" class="icon-button"[^>]*aria-label="ホーム"[^>]*><svg/);
  assert.match(html,/function showHome\(\)\{([\s\S]*?)\n  \}/);
  const showHome=html.match(/function showHome\(\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(showHome.indexOf('saveActiveSession(false,[{key:STORAGE_SCREEN,value:"home"}])')<showHome.indexOf('els.studyScreen.hidden=true'));
  assert.doesNotMatch(showHome,/transitionView|finalizeStudySession|finalizeSession\(/);
  assert.match(html,/function showStudy\(\)\{([\s\S]*?)\n  \}/);
  const showStudy=html.match(/function showStudy\(\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.match(showStudy,/startSession\(false,\[\{key:STORAGE_SCREEN,value:"study"\}\]\)/);
  assert.match(showStudy,/revealY=Number\(activeSession\?\.revealY\|\|0\)/);
  assert.ok(showStudy.indexOf('els.homeScreen.hidden=true')<showStudy.indexOf('els.studyScreen.hidden=false'));
  assert.doesNotMatch(showStudy,/finalizeStudySession|finalizeSession\(/);
  assert.match(html,/const STORAGE_SCREEN="wordlist\.screen\.v1"/);
  assert.match(html,/screenStorage=window\.localStorage;screenState=StudyCore\.inspectInitialScreen\(screenStorage,STORAGE_SCREEN,words\.length>0\)/);
  assert.match(html,/function saveActiveSession\(touch=false,writes=\[\],clearGptRevealAnchor=false\)/);
  assert.match(html,/function startSession\(forceNew=false,extraWrites=\[\]\)/);
  assert.match(html,/if\(!forceNew&&tryRestoreSession\(extraWrites\)\)return/);
  assert.match(html,/typeof restored\.gptRevealTargetId==="string"\?\{gptRevealTargetId:restored\.gptRevealTargetId\}:\{\}/);
  assert.match(html,/els\.homeScreen\.hidden=initialScreen!=="home";els\.studyScreen\.hidden=initialScreen!=="study"/);
  assert.match(html,/if\(initialScreen==="study"\)startSession\(false\)/);
  assert.doesNotMatch(html,/SESSION_TTL_MS|sessionExpired/);
  const updateHome=html.match(/function updateHome\(\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.match(updateHome,/els\.homeRegistrationCard\.hidden=available/);
  assert.match(updateHome,/els\.homeStudyCard\.hidden=!available/);
  assert.match(html,/els\.goHome\.addEventListener\("click",showHome\)/);
  assert.match(html,/els\.startStudy\.addEventListener\("click",showStudy\)/);
  assert.match(html,/if\(screenState\.readFailed\)\{[\s\S]*?return;[\s\S]*?\}/);
  const screenReadFailure=html.match(/if\(screenState\.readFailed\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.doesNotMatch(screenReadFailure,/startSession|saveActiveSession|localStorage\.setItem/);
  assert.match(html,/StudyCore\.persistInitialScreen\(screenStorage,STORAGE_SCREEN,screenState\)/);
  assert.match(html,/if\(!screenSave\.ok\)\{[\s\S]*?return;[\s\S]*?\}/);
  const startupRecovery=html.match(/\}catch\(error\)\{\n    initialScreen="home";([\s\S]*?)\n  \}\n\}\)\(\);/)?.[1];
  assert.ok(startupRecovery);
  assert.doesNotMatch(startupRecovery,/localStorage\.setItem/);
});
test('home CSV registration reuses the existing validated import and reports failure without routing to study', () => {
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const importCsv=html.match(/function importCsv\(text,fileName=""\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(importCsv);
  assert.match(importCsv,/StudyCore\.parseWordCsv\(text\)/);
  assert.match(importCsv,/return requestViewTransition\(nextView,\{nextWords,nextState,nextRandomIds,writeWords:true,writeListTitle:!oldIds\.length,nextListTitle,finalize:true\}\)/);
  assert.match(html,/els\.homeCsvFile\.addEventListener\("change",async e=>\{[\s\S]*?importCsv\(await file\.text\(\),file\.name\)[\s\S]*?CSVを保存できませんでした。既存の学習データは変更されていません。[\s\S]*?e\.target\.value=""/);
  const homeHandler=html.match(/els\.homeCsvFile\.addEventListener\("change",async e=>\{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(homeHandler);
  assert.ok(homeHandler.indexOf('if(words.length)')<homeHandler.indexOf('importCsv(await file.text(),file.name)'));
  assert.match(homeHandler,/登録済みCSVの差し替えは、学習画面の設定から行ってください。/);
  assert.match(html,/els\.csvFile\.addEventListener\("change",async e=>\{[\s\S]*?importCsv\(await file\.text\(\),file\.name\)/);
  assert.doesNotMatch(homeHandler,/showStudy\(/);
  const requestViewTransition=html.match(/function requestViewTransition\(view,options\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(requestViewTransition);
  assert.match(requestViewTransition,/try\{transitionView\(view,options\);return true\}/);
  assert.match(requestViewTransition,/catch\(error\)\{alert\([\s\S]*?\);return false\}/);
  assert.equal((requestViewTransition.match(/return true/g)||[]).length,1);
  assert.equal((requestViewTransition.match(/return false/g)||[]).length,1);
  assert.match(html,/writeListTitle:!oldIds\.length/);
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
test('preferences persist GPT word count with existing settings and normalize old or invalid values', () => {
  const store=memoryStorage();
  const value={pageSize:20,masteryThreshold:4,defaultAnswer:'correct',gptWordCount:30};store.setItem('preferences',JSON.stringify(value));
  assert.deepEqual(C.normalizePreferences(JSON.parse(store.getItem('preferences'))),value);
  assert.deepEqual(C.normalizePreferences({pageSize:20,masteryThreshold:4},{}),{pageSize:20,masteryThreshold:4,defaultAnswer:'wrong',gptWordCount:20});
  assert.deepEqual(C.normalizePreferences({},{}),{pageSize:10,masteryThreshold:3,defaultAnswer:'wrong',gptWordCount:20});
  assert.deepEqual(C.normalizePreferences({pageSize:17,masteryThreshold:8,defaultAnswer:'unknown',gptWordCount:25},{excludeStreakN:4}),{pageSize:10,masteryThreshold:4,defaultAnswer:'wrong',gptWordCount:20});
  for(const count of [5,10,20,30,50])assert.equal(C.normalizePreferences({gptWordCount:count},{}).gptWordCount,count);
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/id="gptWordCount"[\s\S]*?<option value="5">5問<\/option>[\s\S]*?<option value="10">10問<\/option>[\s\S]*?<option value="20">20問<\/option>[\s\S]*?<option value="30">30問<\/option>[\s\S]*?<option value="50">50問<\/option>/);
  assert.match(html,/id="gptStartPosition"[\s\S]*?<option value="page">ページの先頭から<\/option><option value="continue">現在の続きから<\/option>/);
  assert.match(html,/id="gptStartPosition"[^>]*>[\s\S]*?<option value="page">/);
  assert.match(html,/const STORAGE_GPT_START_POSITION="wordlist\.gptStartPosition\.v1"/);
  assert.match(html,/let gptStartPosition=savedGptStartPosition==="continue"\?"continue":"page"/);
  assert.match(html,/els\.gptStartPosition\.addEventListener\("change",\(\)=>\{[\s\S]*localStorage\.setItem\(STORAGE_GPT_START_POSITION,next\);gptStartPosition=next/);
  assert.match(html,/if\(next!=="page"&&next!=="continue"\)\{els\.gptStartPosition\.value=gptStartPosition;return\}/);
  assert.match(html,/STORAGE_LIST_TITLE,STORAGE_GPT_START_POSITION\]\)localStorage\.removeItem\(key\)/);
  assert.match(html,/gptWordCount=20;gptStartPosition="page";els\.gptStartPosition\.value=gptStartPosition/);
  assert.match(html,/if\(!current\.length&&!continueFromProgress\)/);
  assert.match(html,/resolveGptContinuationStart\(words,studyProgress,\{sortMode,randomIds,fallbackStartId:current\[0\]\?\.id\}\)/);
  assert.match(html,/createGptIssueContext\(words,\{sortMode,randomIds,startId:start\.startId/);
  assert.match(html,/GPT出題対象の問題がありません/);
  assert.match(html,/gptWordCount:gptCount/);
  assert.match(html,/gptWordCount:nextGptWordCount/);
  assert.doesNotMatch(html,/gptWordCount===20\)return/);
  assert.match(html,/localStorage\.removeItem\(key\)/);
  for(const size of [10,20,50,100])assert.equal(C.normalizePreferences({pageSize:size},{}).pageSize,size);
});
test('GPT selector walks normal and saved random order from the displayed page start across page boundaries', () => {
  const words=Array.from({length:12},(_,index)=>({id:String(index+1),question:`word${index+1}`}));
  assert.deepEqual(C.selectGptWords(words,{}, {startId:'9',count:5}).map(w=>w.id),['9','10','11','12']);
  const randomIds=['4','9','2','8','1','3','7','6','5','10','11','12'];
  const selected=C.selectGptWords(words,{}, {sortMode:'random',randomIds,startId:'8',count:5});
  assert.deepEqual(selected.map(w=>w.id),['8','1','3','7','6']);
  const payload=C.makeGptPayload('session',selected);
  assert.deepEqual(payload.words.map(w=>w.id),selected.map(w=>w.id));
  const thirty=Array.from({length:30},(_,index)=>({id:String(index+1)}));
  assert.equal(C.buildPageModel(thirty,{}, {pageSize:10}).pages[0].entries.length,10);
  assert.equal(C.selectGptWords(thirty,{}, {startId:'1',count:20}).length,20);
});
test('GPT selector skips mastered words to fill, starts at the first visible word, and never wraps', () => {
  const words=Array.from({length:14},(_,index)=>({id:String(index+1)}));
  const state={'1':{currentStreak:3},'2':{currentStreak:3},'3':{currentStreak:3},'5':{currentStreak:3},'6':{currentStreak:3},'7':{currentStreak:3},'8':{currentStreak:3},'9':{currentStreak:3}};
  assert.deepEqual(C.selectGptWords(words,state,{startId:'4',count:5,excludeStreak:false,masteryThreshold:3}).map(w=>w.id),['4','5','6','7','8']);
  assert.deepEqual(C.selectGptWords(words,state,{startId:'4',count:5,excludeStreak:true,masteryThreshold:3}).map(w=>w.id),['4','10','11','12','13']);
  assert.deepEqual(C.selectGptWords(words,state,{startId:'10',count:5,excludeStreak:true,masteryThreshold:3}).map(w=>w.id),['10','11','12','13','14']);
  assert.deepEqual(C.selectGptWords(words,{}, {startId:'12',count:20}).map(w=>w.id),['12','13','14']);
  assert.deepEqual(C.selectGptWords(words,{}, {startId:'missing',count:5}),[]);
  assert.deepEqual(C.selectGptWords([],{}, {count:5}),[]);
  assert.throws(()=>C.selectGptWords([{id:'a'},{id:'a'}],{}, {startId:'a'}),/一意/);
  assert.throws(()=>C.selectGptWords(words,{}, {sortMode:'random',randomIds:['1','1'],startId:'1'}),/重複/);
});
test('GPT continuation resolves the next ID only for a matching mode and order, with explicit end and fallback',()=>{
  const words=Array.from({length:12},(_,index)=>({id:String(index+1),question:`q${index+1}`,answer:`a${index+1}`}));
  const fallbackStartId='4';
  const normalProgress=C.recordStudyDisclosure({},words,'normal',[], '5');
  assert.deepEqual(C.resolveGptContinuationStart(words,normalProgress,{sortMode:'normal',fallbackStartId}),{startId:'6',source:'continuation',reason:'ok'});
  const atEnd=C.recordStudyDisclosure({},words,'normal',[],'12');
  assert.deepEqual(C.resolveGptContinuationStart(words,atEnd,{sortMode:'normal',fallbackStartId}),{startId:null,source:'continuation',reason:'end'});
  assert.deepEqual(C.resolveGptContinuationStart(words,{}, {sortMode:'normal',fallbackStartId}),{startId:fallbackStartId,source:'page-start',reason:'invalid-cursor'});
  assert.deepEqual(C.resolveGptContinuationStart(words,normalProgress,{sortMode:'random',randomIds:words.map(word=>word.id),fallbackStartId}),{startId:fallbackStartId,source:'page-start',reason:'invalid-cursor'});
  const badCursor={...normalProgress,normal:{...normalProgress.normal,contentFingerprint:'0000000000000000'}};
  assert.deepEqual(C.resolveGptContinuationStart(words,badCursor,{sortMode:'normal',fallbackStartId}),{startId:fallbackStartId,source:'page-start',reason:'invalid-cursor'});
  const randomIds=['4','9','2','8','1','3','7','6','5','10','11','12'];
  const randomProgress=C.recordStudyDisclosure({},words,'random',randomIds,'1');
  assert.deepEqual(C.resolveGptContinuationStart(words,randomProgress,{sortMode:'random',randomIds,fallbackStartId}),{startId:'3',source:'continuation',reason:'ok'});
  assert.deepEqual(C.resolveGptContinuationStart(words,randomProgress,{sortMode:'random',randomIds:[...randomIds].reverse(),fallbackStartId}),{startId:fallbackStartId,source:'page-start',reason:'invalid-cursor'});
});
test('GPT continuation preserves mastered filtering and count fill in normal and random order',()=>{
  const words=Array.from({length:10},(_,index)=>({id:String(index+1)}));
  const state={'6':{currentStreak:3},'7':{currentStreak:3}};
  const normalStart=C.resolveGptContinuationStart(words,C.recordStudyDisclosure({},words,'normal',[],'5'),{sortMode:'normal',fallbackStartId:'1'});
  assert.deepEqual(C.selectGptWords(words,state,{startId:normalStart.startId,count:5,excludeStreak:true,masteryThreshold:3}).map(word=>word.id),['8','9','10']);
  assert.deepEqual(C.selectGptWords(words,state,{startId:normalStart.startId,count:5,excludeStreak:false,masteryThreshold:3}).map(word=>word.id),['6','7','8','9','10']);
  const randomIds=['4','9','2','8','1','3','7','6','5','10'];
  const randomStart=C.resolveGptContinuationStart(words,C.recordStudyDisclosure({},words,'random',randomIds,'1'),{sortMode:'random',randomIds,fallbackStartId:'4'});
  assert.equal(randomStart.startId,'3');
  assert.deepEqual(C.selectGptWords(words,state,{sortMode:'random',randomIds,startId:randomStart.startId,count:5,excludeStreak:true,masteryThreshold:3}).map(word=>word.id),['3','5','10']);
  const finalStart=C.resolveGptContinuationStart(words,C.recordStudyDisclosure({},words,'random',randomIds,'10'),{sortMode:'random',randomIds,fallbackStartId:'4'});
  assert.deepEqual(C.selectGptWords(words,state,{sortMode:'random',randomIds,startId:finalStart.startId,count:5}).map(word=>word.id),[]);
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
test('CSV replacement keeps id-keyed history available and accepts the legacy format', () => {
  const state={x:{studyCount:7,correctCount:5,currentStreak:2}};
  const imported=C.parseWordCsv('id,word,meaning\nx,new word,new meaning\ny,another,other');
  assert.deepEqual(imported,[{id:'x',question:'new word',answer:'new meaning',explanation:''},{id:'y',question:'another',answer:'other',explanation:''}]);
  assert.equal(state.x.studyCount,7);assert.equal(state.x.correctCount,5);
  assert.throws(()=>C.parseWordCsv('id,word\nx,missing meaning'));
  assert.throws(()=>C.parseWordCsv('id,word,meaning\nx,one,a\nx,two,b'));
});

test('generic CSV supports optional explanation, quoting, Unicode, and multiline fields',()=>{
  const rows=C.parseWordCsv('id,question,answer,explanation\n1,apple,りんご,果物\n2,"HTTPとは？","Hypertext, Transfer Protocol","Web通信で\n使うプロトコル"\n3,CPU,Central Processing Unit,');
  assert.deepEqual(rows,[
    {id:'1',question:'apple',answer:'りんご',explanation:'果物'},
    {id:'2',question:'HTTPとは？',answer:'Hypertext, Transfer Protocol',explanation:'Web通信で\n使うプロトコル'},
    {id:'3',question:'CPU',answer:'Central Processing Unit',explanation:''}
  ]);
  assert.deepEqual(C.parseWordCsv('id,question,answer\na,Q,A'),[{id:'a',question:'Q',answer:'A',explanation:''}]);
  assert.deepEqual(C.parseWordCsv('\uFEFFid,answer,question\na,A,Q'),[{id:'a',question:'Q',answer:'A',explanation:''}]);
});

test('generic CSV rejects missing required values, duplicate IDs or headers, malformed headers, and unclosed quotes',()=>{
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,,A'),/question/);
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,Q,'),/answer/);
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,Q,A\n1,Q2,A2'),/重複/);
  assert.throws(()=>C.parseWordCsv('id,id,question,answer\n1,1,Q,A'),/重複した列名/);
  assert.throws(()=>C.parseWordCsv('id,question\n1,Q'),/ヘッダー/);
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,"Q,A'),/引用符/);
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,ab"cd,A'),/引用符の位置/);
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,"Q"x,A'),/閉じ引用符/);
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,Q,A,'),/列数が多く/);
});

test('CSV parser accepts whitespace after a closing quote and escaped quotes, but rejects malformed quote placement',()=>{
  assert.deepEqual(C.parseWordCsv('id,question,answer,explanation\r\n1,"  Q, ""quoted""" \t,A,"line 1\r\nline 2"'),[
    {id:'1',question:'Q, "quoted"',answer:'A',explanation:'line 1\r\nline 2'}
  ]);
  // Space and tab after a closing quote are accepted as insignificant field padding.
  assert.deepEqual(C.parseWordCsv('id,question,answer\n1," Q " \t," A "'),[{id:'1',question:'Q',answer:'A',explanation:''}]);
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,"Q"x,A'),/閉じ引用符/);
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,ab"cd,A'),/引用符の位置/);
  assert.throws(()=>C.parseWordCsv('id,question,answer\n1,"Q,A'),/引用符が閉じられていません/);
});

test('legacy saved rows normalize to the canonical model without changing ID-keyed state',()=>{
  const legacy=[{id:1,word:'apple',meaning:'りんご'}];
  const canonical=C.normalizeWords(legacy);
  assert.deepEqual(canonical,[{id:'1',question:'apple',answer:'りんご',explanation:''}]);
  assert.deepEqual(C.normalizeWords(JSON.parse(JSON.stringify(canonical))),canonical);
  const next=C.studyOrderIdentity(canonical,'normal',[]);
  assert.equal(next.contentFingerprint,C.studyOrderIdentity([{id:'1',question:'apple',answer:'りんご',explanation:'別解説'}]).contentFingerprint);
});

test('explanation-only edits do not invalidate study content identity',()=>{
  const before=[{id:'1',question:'Q',answer:'A',explanation:'old'}];
  const after=[{...before[0],explanation:'new'}];
  assert.equal(C.studyOrderIdentity(before).contentFingerprint,C.studyOrderIdentity(after).contentFingerprint);
});

test('home cards, title persistence, filename title, and import transaction are wired to the generic model',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const registrationCard=html.match(/<div id="homeRegistrationCard"[\s\S]*?(?=\n    <div id="homeStudyCard")/)?.[0]||'';
  assert.match(registrationCard,/class="home-panel registration" hidden/);
  assert.match(registrationCard,/home-registration-heading[\s\S]*?学習データを登録[\s\S]*?CSVを選択[\s\S]*?id="homeCsvFile"/);
  assert.match(html,/<div id="homeStudyCard" class="home-panel study" hidden>[\s\S]*?id="homeListTitle"[\s\S]*?id="editListTitle"[\s\S]*?id="homeTitleEditor"[\s\S]*?id="homeQuestionCount"[\s\S]*?学習する/);
  assert.match(html,/#homeTitleEditor\[hidden\],#editListTitle\[hidden\]\{display:none!important\}/);
  assert.match(html,/\.home-panel\.study\{grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(html,/\.home-panel\.study\{grid-template-columns:minmax\(0,1fr\) auto auto/);
  assert.match(html,/\.home-start-study\{grid-column:3;grid-row:1 \/ span 2;justify-self:end/);
  assert.match(html,/\.home-study-mastery\{grid-column:2;grid-row:1 \/ span 2/);
  assert.match(html,/\.home-panel\.registration\{grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(html,/function titleFromFileName\(fileName\)[\s\S]*?replace\(\/\\\.csv\$\/i/);
  assert.match(html,/STORAGE_LIST_TITLE="wordlist\.listTitle\.v1"/);
  assert.match(html,/let words=StudyCore\.normalizeWords\(storedWords\)/);
  assert.match(html,/if\(wordsNeedMigration\)try\{localStorage\.setItem\(STORAGE_WORDS,JSON\.stringify\(words\)\)\}catch/);
  assert.match(html,/writeListTitle:!oldIds\.length,nextListTitle,finalize:true/);
  assert.match(html,/if\(writeListTitle\)writes\.push\(\{key:STORAGE_LIST_TITLE/);
  assert.match(html,/els\.editListTitle\.addEventListener\("click",editListTitle\)/);
  assert.match(html,/els\.saveListTitle\.addEventListener\("click",saveListTitleEdit\)/);
  assert.match(html,/els\.cancelListTitle\.addEventListener\("click",cancelListTitleEdit\)/);
  assert.match(html,/event\.key==="Enter"\)\{event\.preventDefault\(\);saveListTitleEdit\(\)\}/);
  assert.match(html,/event\.key==="Escape"\)\{event\.preventDefault\(\);cancelListTitleEdit\(\)\}/);
  assert.match(html,/els\.homeTitleInput\.focus\(\);els\.homeTitleInput\.select\(\)/);
  assert.match(html,/const next=els\.homeTitleInput\.value\.trim\(\)/);
  assert.match(html,/if\(!next\)\{els\.homeStatus\.textContent="タイトルは空欄にできません/);
  assert.match(html,/catch\(error\)\{cancelListTitleEdit\(\);els\.homeStatus\.textContent=`タイトルを保存できませんでした/);
  assert.match(html,/els\.homeListTitle\.textContent=listTitle\|\|"学習データ"/);
  assert.match(html,/textContent=w\.question/);assert.match(html,/textContent=w\.answer/);
  assert.match(html,/localStorage\.removeItem\(key\)/);
  assert.match(html,/STORAGE_PREFERENCES,STORAGE_LIST_TITLE/);
});
test('title editor functions save, cancel, reject blanks, and restore the prior title on storage failure',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const functions=html.match(/function setTitleEditing\(editing\)\{[\s\S]*?(?=\n  function showHome\()/)?.[0];
  assert.ok(functions);
  function harness(throws=false){
    const writes=[];
    const localStorage={setItem:(key,value)=>{if(throws)throw new Error('quota');writes.push([key,value])}};
    const els={
      homeListTitle:{hidden:false,textContent:'Initial'},editListTitle:{hidden:false},homeTitleEditor:{hidden:true},
      homeTitleInput:{hidden:false,value:'',focused:false,selected:false,focus(){this.focused=true},select(){this.selected=true}},
      homeStatus:{textContent:'',className:''}
    };
    const execute=new Function('els','localStorage','writes',`const STORAGE_LIST_TITLE='wordlist.listTitle.v1';let listTitle='Initial';function updateHome(){els.homeListTitle.textContent=listTitle||'学習データ'};${functions};return{begin:editListTitle,save:saveListTitleEdit,cancel:cancelListTitleEdit,getTitle:()=>listTitle}`);
    return{...execute(els,localStorage,writes),els,writes};
  }
  const saved=harness();saved.begin();
  assert.deepEqual([saved.els.homeListTitle.hidden,saved.els.editListTitle.hidden,saved.els.homeTitleEditor.hidden,saved.els.homeTitleInput.focused,saved.els.homeTitleInput.selected],[true,true,false,true,true]);
  saved.els.homeTitleInput.value='  Updated title  ';assert.equal(saved.save(),true);
  assert.equal(saved.getTitle(),'Updated title');assert.deepEqual(saved.writes,[['wordlist.listTitle.v1','"Updated title"']]);
  assert.equal(saved.els.homeListTitle.textContent,'Updated title');assert.equal(saved.els.homeTitleEditor.hidden,true);
  const cancelled=harness();cancelled.begin();cancelled.els.homeTitleInput.value='not saved';cancelled.cancel();
  assert.equal(cancelled.getTitle(),'Initial');assert.equal(cancelled.writes.length,0);assert.equal(cancelled.els.homeTitleInput.value,'Initial');
  const blank=harness();blank.begin();blank.els.homeTitleInput.value='  ';assert.equal(blank.save(),false);
  assert.equal(blank.getTitle(),'Initial');assert.equal(blank.writes.length,0);assert.equal(blank.els.homeTitleEditor.hidden,false);
  const failed=harness(true);failed.begin();failed.els.homeTitleInput.value='Changed';assert.equal(failed.save(),false);
  assert.equal(failed.getTitle(),'Initial');assert.equal(failed.els.homeListTitle.textContent,'Initial');assert.equal(failed.els.homeTitleEditor.hidden,true);
  assert.match(failed.els.homeStatus.textContent,/保存できませんでした.*quota/);
});
test('CSV import function normalizes new and legacy rows, derives only first-import titles, and rejects invalid data atomically',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const source=html.match(/function importCsv\(text,fileName=""\)\{[\s\S]*?\n  \}/)?.[0];assert.ok(source);
  function harness(initialWords=[],initialTitle=''){
    const execute=new Function('StudyCore','initialWords','initialTitle',`let words=initialWords,listTitle=initialTitle,state={},randomIds=[],sortMode='normal',randomStart=0,transitionResult=true,captured=null;const defaultAnswer='wrong';function sameIdSet(a,b){return a.length===b.length&&a.every(id=>b.includes(id))}function currentView(){return{filter:'all',excludeStreak:false,pageIndex:2,sortMode,randomStart}}function normalizeState(raw){return StudyCore.normalizeState(raw)}function defaultState(){return StudyCore.defaultState()}function titleFromFileName(name){return String(name||'').split(/[\\\\/]/).pop().replace(/\\.csv$/i,'').trim()||'学習データ'}function requestViewTransition(view,options){captured={view,options};return transitionResult}${source};return{run:(text,name)=>importCsv(text,name),get:()=>({words,listTitle,captured,state}),setResult:value=>transitionResult=value}`);
    return execute(C,initialWords,initialTitle);
  }
  const generic=harness();assert.equal(generic.run('id,question,answer,explanation\n1,Q,A,Note','review-list.csv'),true);
  assert.deepEqual(generic.get().captured.options.nextWords,[{id:'1',question:'Q',answer:'A',explanation:'Note'}]);
  assert.equal(generic.get().captured.options.nextListTitle,'review-list');assert.equal(generic.get().captured.options.writeListTitle,true);
  const legacy=harness();assert.equal(legacy.run('id,word,meaning\na,cat,猫','legacy.csv'),true);
  assert.deepEqual(legacy.get().captured.options.nextWords,[{id:'a',question:'cat',answer:'猫',explanation:''}]);
  const replacement=harness([{id:'1',question:'old',answer:'old answer',explanation:''}],'Custom name');
  replacement.run('id,question,answer\n1,new,new answer','replacement.csv');
  assert.equal(replacement.get().captured.options.writeListTitle,false);assert.equal(replacement.get().captured.options.nextListTitle,'Custom name');
  const invalid=harness();assert.throws(()=>invalid.run('id,question,answer\n1,,missing','bad.csv'),/question/);assert.equal(invalid.get().captured,null);assert.deepEqual(invalid.get().words,[]);
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
test('first exposure applies default answer once without changing finalized history', () => {
  const correctState=C.defaultState(),wrongState=C.defaultState();
  const correct={studiedIds:[],checkedIds:[],finalizedIds:[]},wrong={studiedIds:[],checkedIds:[],finalizedIds:[]};
  assert.equal(C.recordStudy(correct,'a',correctState,'t','correct'),true);
  assert.equal(C.recordStudy(wrong,'b',wrongState,'t','wrong'),true);
  assert.deepEqual(correct.checkedIds,['a']);assert.deepEqual(wrong.checkedIds,[]);
  assert.deepEqual([correctState.studyCount,correctState.correctCount,correctState.recentResults,correctState.currentStreak],[1,0,[],0]);
  assert.equal(C.recordStudy(correct,'a',correctState,'later','wrong'),false);
  assert.deepEqual(correct.checkedIds,['a']);
  C.setSessionAnswer(correct,'a',false);C.finalizeStudySession(correct,()=>correctState);
  C.finalizeStudySession(wrong,()=>wrongState);
  assert.deepEqual([correctState.correctCount,correctState.recentResults],[0,[false]]);
  assert.deepEqual([wrongState.correctCount,wrongState.recentResults],[0,[false]]);
  const retainedState=C.defaultState(),retained={studiedIds:[],checkedIds:[],finalizedIds:[]};
  C.recordStudy(retained,'retained',retainedState,'t','correct');C.finalizeStudySession(retained,()=>retainedState);
  assert.deepEqual([retainedState.studyCount,retainedState.correctCount,retainedState.recentResults,retainedState.currentStreak],[1,1,[true],1]);
});
test('individual mask disclosure applies the configured default evaluation for both settings', () => {
  for(const defaultAnswer of ['wrong','correct']) {
    const state=C.defaultState(),session={studiedIds:[],checkedIds:[],finalizedIds:[]};
    assert.equal(C.recordStudy(session,'masked',state,'t',defaultAnswer),true);
    assert.deepEqual(session.studiedIds,['masked']);
    assert.deepEqual(session.checkedIds,defaultAnswer==='correct'?['masked']:[]);
    assert.equal(state.studyCount,1);
    assert.deepEqual(state.recentResults,[]);
    C.finalizeStudySession(session,()=>state);
    assert.deepEqual(state.recentResults,[defaultAnswer==='correct']);
    assert.equal(state.correctCount,defaultAnswer==='correct'?1:0);
  }
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
test('first answer-control click starts opposite the default, then alternates and persists', () => {
  for(const defaultAnswer of ['wrong','correct']) {
    const state=C.defaultState(),session={studiedIds:[],checkedIds:[],finalizedIds:[]};
    const first=C.initialAnswerForToggle(defaultAnswer);
    assert.equal(first,defaultAnswer==='wrong'?'correct':'wrong');
    C.recordStudy(session,'a',state,'t',first);
    assert.deepEqual(session.checkedIds,first==='correct'?['a']:[]);
    const answers=[first];
    for(let i=0;i<4;i++) {
      const next=!session.checkedIds.includes('a');
      assert.equal(C.setSessionAnswer(session,'a',next),true);
      answers.push(next?'correct':'wrong');
    }
    assert.deepEqual(answers,defaultAnswer==='wrong'
      ?['correct','wrong','correct','wrong','correct']
      :['wrong','correct','wrong','correct','wrong']);
    assert.deepEqual([state.studyCount,state.correctCount,state.recentResults],[1,0,[]]);
    C.finalizeStudySession(session,()=>state);
    const storage=memoryStorage();
    C.saveCore(storage,'ledger',{state:{a:state},activeSession:session,gptSessions:{}});
    const restored=C.loadCore(storage,'ledger',{stateKey:'state',activeSessionKey:'active',gptSessionsKey:'gpt'});
    assert.equal(restored.state.a.studyCount,1);
    assert.equal(restored.state.a.correctCount,answers.at(-1)==='correct'?1:0);
    assert.deepEqual(restored.state.a.recentResults,[answers.at(-1)==='correct']);
  }
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
test('pending study result detection follows studied and finalized IDs without mutating the session',()=>{
  assert.equal(C.hasPendingStudyResults(null),false);
  assert.equal(C.hasPendingStudyResults({studiedIds:[],finalizedIds:[]}),false);
  assert.equal(C.hasPendingStudyResults({studiedIds:['a'],finalizedIds:['a']}),false);
  const session={studiedIds:['a','b'],finalizedIds:['a']},before=structuredClone(session);
  assert.equal(C.hasPendingStudyResults(session),true);
  assert.deepEqual(session,before);
});
test('pending study transition asks once when needed and cancellation leaves session unchanged',()=>{
  let calls=0;
  const pending={studiedIds:['a','b'],checkedIds:['b'],finalizedIds:['a']},before=structuredClone(pending);
  assert.equal(C.approvePendingStudyTransition(pending,()=>{calls++;return false}),false);
  assert.equal(calls,1);assert.deepEqual(pending,before);
  assert.equal(C.approvePendingStudyTransition(pending,()=>{calls++;return true}),true);
  assert.equal(calls,2);
  assert.equal(C.approvePendingStudyTransition({studiedIds:['a'],finalizedIds:['a']},()=>{calls++;return false}),true);
  assert.equal(calls,2);
  assert.equal(C.approvePendingStudyTransition(null,undefined),true);
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
  const restored=C.tryRestoreSession(restoredSnapshot.activeSession,{currentKey:next.key,currentPageIds:['a']});
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
test('GPT result review summary separates JSON outcomes, missing issued IDs, replay extras, and applied targets',()=>{
  const summary=C.summarizeGptResults([
    {id:'a',result:'correct'},{id:'b',result:'wrong'},{id:'c',result:'uncertain'},{id:'d',result:'skipped'},{id:'outside',result:'correct'}
  ],['a','b','c','d','e'],3);
  assert.deepEqual(summary,{issuedCount:5,resultCount:5,missingCount:1,outsideIssuedCount:1,counts:{correct:2,wrong:1,uncertain:1,skipped:1},appliedCount:3});
  const empty=C.summarizeGptResults([],['a','b'],0);
  assert.deepEqual([empty.issuedCount,empty.resultCount,empty.missingCount,empty.appliedCount],[2,0,2,0]);
  const unknown=C.summarizeGptResults([{id:'x',result:'correct'}],null,1);
  assert.deepEqual([unknown.issuedCount,unknown.missingCount,unknown.outsideIssuedCount],[null,null,null]);
});
test('GPT review targets match normal, skipped, active-study, empty, and replay integration outcomes',()=>{
  const words=Array.from({length:4},(_,i)=>({id:String(i+1),question:`word-${i+1}`,answer:`meaning-${i+1}`}));
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,2),updatedAt:1,revealY:1,targetIds:['1','2'],viewState:{...view,pageSize:2},studiedIds:['2'],checkedIds:[],finalizedIds:[],pendingId:'2'};
  const results=[{id:'1',result:'correct'},{id:'2',result:'wrong'},{id:'3',result:'skipped'},{id:'4',result:'uncertain'}];
  const normal=prepareIntegration({version:1,sessionId:'pending',results},{sessions:{pending:{ids:words.map(word=>word.id)}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:active,currentView:view,pageSize:2,randomIds:[],gptSkipped:null,now:'2026-10-12T00:00:00.000Z'});
  assert.deepEqual(normal.resultTargets,[
    {id:'1',target:true,reason:null},
    {id:'2',target:false,reason:'study'},
    {id:'3',target:false,reason:null},
    {id:'4',target:true,reason:null}
  ]);
  assert.deepEqual(normal.appliedIds,['1','4']);
  assert.equal(normal.resultTargets.filter(item=>item.target).length,normal.applied,'the result list target count matches applied history results');
  assert.equal(normal.gptSkipped.ids.includes('3'),false,'out-of-range skipped does not become a target');

  const explicitSkip=prepareIntegration({version:1,sessionId:'pending-skip',results:[{id:'1',result:'skipped'}]},
    {sessions:{'pending-skip':{ids:['1']}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:active,currentView:view,pageSize:2,randomIds:[],gptSkipped:null,now:'2026-10-12T00:00:00.000Z'});
  assert.deepEqual(explicitSkip.resultTargets,[{id:'1',target:false,reason:null}]);
  assert.equal(explicitSkip.applied,0,'explicit skipped is excluded from the history target count');
  assert.deepEqual(explicitSkip.gptSkipped.ids,['1']);

  const skippedOnly=prepareIntegration({version:1,sessionId:'skipped-only',results:[{id:'2',result:'skipped'}]},
    {sessions:{'skipped-only':{ids:['2']}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,currentView:view,pageSize:2,randomIds:[],gptSkipped:null,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(skippedOnly.applied,0);
  assert.deepEqual(skippedOnly.resultTargets,[{id:'2',target:false,reason:null}]);
  assert.equal(skippedOnly.resultTargets.filter(item=>item.target).length,skippedOnly.applied);

  const empty=prepareIntegration({version:1,sessionId:'empty',results:[]},
    {sessions:{empty:{ids:['1','2']}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:active,currentView:view,pageSize:2,randomIds:[],gptSkipped:null,now:'2026-10-12T00:00:00.000Z'});
  assert.deepEqual(empty.resultTargets,[]);

  const replay=prepareIntegration({version:1,sessionId:'done',results},
    {sessions:{},registeredIds:['done'],knownIds:words.map(word=>word.id),words,state:{},activeSession:active,currentView:view,pageSize:2,randomIds:[],gptSkipped:null,now:'2026-10-12T00:00:00.000Z'});
  assert.deepEqual(replay.resultTargets,normal.resultTargets,'replay extras retain existing acceptance while pending active overlaps and out-of-range skipped remain excluded');
  assert.deepEqual(replay.appliedIds,['1','4']);
  assert.equal(replay.resultTargets.filter(item=>item.target).length,replay.applied);
});
test('legacy individual keys migrate when no integrated snapshot exists', () => {
  const legacy={state:{a:{studyCount:3}},gptSessions:{g:{applied:false}},active:{key:'all',updatedAt:50,studiedIds:['a'],checkedIds:[],finalizedIds:[],revealY:80}};
  const store=memoryStorage({oldState:JSON.stringify(legacy.state),oldGpt:JSON.stringify(legacy.gptSessions),oldActive:JSON.stringify(legacy.active)});
  const loaded=C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'});
  assert.deepEqual(loaded,{state:legacy.state,gptSessions:{g:{createdAt:null,ids:[]}},registeredGptSessionIds:[],activeSession:legacy.active,gptSkipped:{contentFingerprint:null,ids:[]}});
  C.saveCore(store,'ledger',loaded);
  assert.deepEqual(C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'}),{state:legacy.state,gptSessions:{g:{createdAt:null,ids:[]}},registeredGptSessionIds:[],activeSession:legacy.active,gptSkipped:{contentFingerprint:null,ids:[]}});
});
test('integrated snapshot wins over stale legacy keys and preserves session progress', () => {
  const store=memoryStorage({oldState:JSON.stringify({a:{studyCount:90}}),oldGpt:JSON.stringify({old:{applied:false}}),oldActive:'null'});
  const snapshot={state:{a:{studyCount:2,correctCount:1,recentResults:[true],currentStreak:1}},gptSessions:{g:{ids:['a'],applied:false}},activeSession:{key:'all:off:normal:0',updatedAt:100,revealY:140,studiedIds:['a'],checkedIds:['a'],finalizedIds:['a']}};
  C.saveCore(store,'ledger',snapshot);
  const loaded=C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'});
  assert.deepEqual(loaded,{state:snapshot.state,gptSessions:{g:{createdAt:null,ids:['a']}},registeredGptSessionIds:[],activeSession:snapshot.activeSession,gptSkipped:{contentFingerprint:null,ids:[]}});
  const st=loaded.state.a, session=loaded.activeSession;
  assert.equal(C.recordStudy(session,'a',st),false);
  assert.equal(C.setSessionAnswer(session,'a',true),false);
  assert.deepEqual([st.studyCount,st.correctCount,st.recentResults],[2,1,[true]]);
});
test('legacy snapshots load with an empty GPT skipped state and new snapshots round-trip it',()=>{
  const words=[{id:'a',question:'Q A',answer:'A A'},{id:'b',question:'Q B',answer:'A B'}];
  const store=memoryStorage({ledger:JSON.stringify({state:{},gptSessions:{},registeredGptSessionIds:[],activeSession:null})});
  const keys={stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'};
  const legacy=C.loadCore(store,'ledger',keys);
  assert.deepEqual(legacy.gptSkipped,{contentFingerprint:null,ids:[]});
  const marked=C.setGptSkippedState(legacy.gptSkipped,words,'b');
  C.saveCore(store,'ledger',{...legacy,gptSkipped:marked});
  assert.deepEqual(C.loadCore(store,'ledger',keys).gptSkipped,marked);
  // Existing callers that omit this optional field must not erase it.
  const {gptSkipped:ignored,...legacyCall}=legacy;
  C.saveCore(store,'ledger',{...legacyCall,state:{a:C.defaultState()}});
  assert.deepEqual(C.loadCore(store,'ledger',keys).gptSkipped,marked);
});
test('GPT skipped state is distinct from missing outcomes and does not mutate study data',()=>{
  const words=[{id:'a',question:'Q A',answer:'A A'},{id:'b',question:'Q B',answer:'A B'}];
  const state={a:{...C.defaultState(),studyCount:2,correctCount:1,currentStreak:1,recentResults:[true,false]}};
  const progress={normal:{id:'a',sortMode:'normal',wordCount:2,orderFingerprint:'1111111111111111',csvOrderFingerprint:'2222222222222222',contentFingerprint:'3333333333333333'},random:null};
  const before=JSON.stringify({state,progress,words});
  const skipped=C.setGptSkippedState(null,words,'a',true);
  assert.deepEqual(skipped.ids,['a']);
  assert.equal(skipped.ids.includes('b'),false); // no result is not persisted as skipped
  assert.equal(JSON.stringify({state,progress,words}),before);
  assert.equal(Object.hasOwn(skipped,'unansweredIds'),false);
  assert.equal(Object.hasOwn(skipped,'missingIds'),false);
});
test('GPT skipped registration is idempotent, removable by ID, and rejects unknown or malformed input',()=>{
  const words=[{id:'a',question:'Q A',answer:'A A'},{id:'b',question:'Q B',answer:'A B'}];
  const once=C.setGptSkippedState(null,words,'a');
  const twice=C.setGptSkippedState(once,words,'a');
  assert.deepEqual(twice.ids,['a']);
  assert.deepEqual(C.setGptSkippedState(twice,words,'missing'),twice);
  assert.deepEqual(C.setGptSkippedState(twice,words,'a',false),{contentFingerprint:C.studyContentFingerprint(words),ids:[]});
  assert.deepEqual(C.normalizeGptSkippedState({contentFingerprint:'bad',ids:['a']},words),{contentFingerprint:C.studyContentFingerprint(words),ids:[]});
  assert.deepEqual(C.normalizeGptSkippedState({contentFingerprint:C.studyContentFingerprint(words),ids:['a',3,'', 'a','unknown']},words),{contentFingerprint:C.studyContentFingerprint(words),ids:['a']});
  assert.deepEqual(C.normalizeGptSkippedState({contentFingerprint:C.studyContentFingerprint(words),ids:['a']},words.slice(0,1)),{contentFingerprint:C.studyContentFingerprint(words.slice(0,1)),ids:[]});
});
test('GPT skipped fingerprint ignores presentation order and explanation but rejects reused IDs with changed content',()=>{
  const words=[{id:'a',question:'Q A',answer:'A A',explanation:'old'},{id:'b',question:'Q B',answer:'A B'}];
  const marked=C.setGptSkippedState(null,words,'a');
  assert.equal(marked.contentFingerprint,C.studyOrderIdentity(words,'normal',[]).contentFingerprint);
  assert.deepEqual(C.normalizeGptSkippedState(marked,[{...words[1]},{...words[0],explanation:'new'}]),marked);
  const reused=[{...words[0],question:'Different question'},words[1]];
  assert.deepEqual(C.normalizeGptSkippedState(marked,reused),{contentFingerprint:C.studyContentFingerprint(reused),ids:[]});
});
test('a failed snapshot write leaves the previous committed snapshot intact', () => {
  const prior={state:{a:{studyCount:1}},gptSessions:{},activeSession:null,gptSkipped:{contentFingerprint:'1234567890abcdef',ids:['a']}};
  const store=memoryStorage({ledger:JSON.stringify(prior)});
  const broken={...store,setItem(){throw new Error('write interrupted')}};
  assert.throws(()=>C.saveCore(broken,'ledger',{state:{a:{studyCount:2}},gptSessions:{},activeSession:null}));
  assert.deepEqual(JSON.parse(store.getItem('ledger')),prior);
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
test('failed screen and session transition rolls the persisted screen back with the core snapshot', () => {
  const original={state:{a:{...C.defaultState(),studyCount:1}},gptSessions:{},registeredGptSessionIds:[],activeSession:{sessionId:'s',key:'k',updatedAt:1,revealY:20,targetIds:['a'],studiedIds:['a'],checkedIds:[],finalizedIds:[]}};
  const durable=memoryStorage({ledger:JSON.stringify(original),screen:'study'});
  const failing={getItem:durable.getItem,removeItem:durable.removeItem,setItem(key,value){if(key==='ledger')throw new Error('snapshot unavailable');durable.setItem(key,value)}};
  assert.throws(()=>C.saveCoreTransition(failing,'ledger',{...original,activeSession:{...original.activeSession,revealY:80}},[
    {key:'screen',value:'home'}
  ]),/snapshot unavailable/);
  assert.equal(durable.getItem('screen'),'study');
  assert.deepEqual(C.loadCore(durable,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'}),{...original,gptSkipped:{contentFingerprint:null,ids:[]}});
});
test('corrupt or incomplete snapshot falls back to legacy migration inputs', () => {
  const legacy={state:{a:{studyCount:4}},gptSessions:{g:{applied:false}},activeSession:null};
  const seed={ledger:'{"state":{"a":{"studyCount":99}}',oldState:JSON.stringify(legacy.state),oldGpt:JSON.stringify(legacy.gptSessions),oldActive:'null'};
  const store=memoryStorage(seed);
  assert.deepEqual(C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'}),{state:legacy.state,gptSessions:{g:{createdAt:null,ids:[]}},registeredGptSessionIds:[],activeSession:null,gptSkipped:{contentFingerprint:null,ids:[]}});
  store.setItem('ledger',JSON.stringify({state:{a:{studyCount:99}},gptSessions:{}}));
  assert.deepEqual(C.loadCore(store,'ledger',{stateKey:'oldState',gptSessionsKey:'oldGpt',activeSessionKey:'oldActive'}),{state:legacy.state,gptSessions:{g:{createdAt:null,ids:[]}},registeredGptSessionIds:[],activeSession:null,gptSkipped:{contentFingerprint:null,ids:[]}});
});
test('long-inactive session reload restores pending state without finalizing it', () => {
  const s={sessionId:'s1',key:'same',updatedAt:1000,revealY:75,targetIds:['a','b'],studiedIds:['a','b'],checkedIds:['a'],finalizedIds:['b']};
  const state={a:C.defaultState(),b:C.defaultState()};
  state.a.studyCount=1;state.b.studyCount=1;state.b.recentResults=[false];
  const store=memoryStorage();
  C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:s});
  const restored=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'}).activeSession;
  assert.deepEqual(restored,s);
  const restoredAfterDays=C.tryRestoreSession(s,{currentKey:'same',currentPageIds:['a','b']});
  assert.deepEqual(restoredAfterDays,s);
  assert.deepEqual([state.a.studyCount,state.a.correctCount,state.a.recentResults],[1,0,[]]);
  C.finalizeStudySession(restoredAfterDays,id=>state[id]);
  assert.deepEqual([state.a.studyCount,state.a.correctCount,state.a.recentResults],[1,1,[true]]);
  C.finalizeStudySession(restoredAfterDays,id=>state[id]);
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
  const saved={sessionId:'legacy-random',key:'hasMiss:off:random:0',updatedAt:1000,revealY:33,targetIds:['a','b'],studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:saved});
  const model=C.buildPageModel(words,state,{pageSize:50,sortMode:'random',randomIds,filter:'hasMiss'});
  const restored=runRestore(store,{currentKey:'hasMiss:off:random:50:0',legacyKey:saved.key,filter:'hasMiss',sortMode:'random',pageIndex:0,pageSize:50,words,state,randomIds,currentPageIds:model.pages[0].entries.map(w=>w.id)},1001);
  assert.equal(restored.activeSession.sessionId,'legacy-random');assert.equal(restored.activeSession.revealY,33);
  assert.deepEqual(restored.activeSession.checkedIds,['a']);assert.equal(restored.state.a.correctCount,0);
});
test('legacy normal filtered session restores when old and new ordered targets match', () => {
  const words=Array.from({length:50},(_,i)=>({id:String(i+1)}));
  const state=Object.fromEntries(words.map(w=>[w.id,{...C.defaultState(),studyCount:1,correctCount:0}]));
  const saved={sessionId:'legacy-filtered-same',key:'hasMiss:off:normal:0',updatedAt:1000,revealY:24,targetIds:words.map(w=>w.id),studiedIds:['1'],checkedIds:[],finalizedIds:[]};
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
  const saved={sessionId:'legacy-filtered-mismatch',key:'hasMiss:off:normal:0',updatedAt:1000,revealY:90,targetIds:['1','51'],studiedIds:['1'],checkedIds:['1'],finalizedIds:[]};
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
test('legacy filtered session with no exposed words starts fresh without adding history', () => {
  const words=Array.from({length:50},(_,i)=>({id:String(i+1)}));
  const state=Object.fromEntries(words.map(w=>[w.id,C.defaultState()]));
  state['1']={...C.defaultState(),studyCount:1,correctCount:0};
  const saved={sessionId:'legacy-empty-progress',key:'hasMiss:off:normal:0',updatedAt:1000,revealY:0,targetIds:['1'],studiedIds:[],checkedIds:[],finalizedIds:[]};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:saved});
  const model=C.buildPageModel(words,state,{pageSize:50,filter:'hasMiss'});
  const result=runRestore(store,{currentKey:'all:off:normal:50:normal:0',legacyKey:'all:off:normal:0',filter:'all',sortMode:'normal',pageIndex:0,pageSize:50,words,state,randomIds:[],currentPageIds:model.pages[0].entries.map(w=>w.id)},1001);
  assert.equal(result.activeSession.sessionId,'new-session');
  assert.deepEqual([result.state['1'].studyCount,result.state['1'].correctCount,result.state['1'].recentResults,result.state['1'].currentStreak],[1,0,[],0]);
  assert.deepEqual(result.state['2'],C.defaultState());
});
test('legacy restore rejects order mismatch, unreconstructable, and inconsistent sessions but ignores age', () => {
  const words=['a','b'].map(id=>({id})),state={a:{...C.defaultState(),studyCount:1},b:{...C.defaultState(),studyCount:1}};
  const base={sessionId:'legacy',key:'all:off:random:0',updatedAt:1000,revealY:40,studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  const args={currentKey:'all:off:random:50:0',legacyKey:base.key,filter:'all',sortMode:'random',pageIndex:0,words,state,randomIds:['a','b'],currentPageIds:['a','b']};
  assert.equal(C.tryRestoreSession(base,{...args,currentPageIds:['b','a']}),null);
  assert.equal(C.tryRestoreSession({...base,updatedAt:0},args).sessionId,'legacy');
  assert.equal(C.tryRestoreSession({...base,updatedAt:undefined},args).sessionId,'legacy');
  assert.equal(C.tryRestoreSession(base,{...args,randomIds:['a']}),null);
  assert.equal(C.tryRestoreSession(base,{...args,masteryThreshold:4,legacyThreshold:3,excludeStreak:true}),null);
  assert.equal(C.tryRestoreSession({...base,studiedIds:['unknown']},args),null);
  assert.equal(C.tryRestoreSession({...base,revealY:'invalid'},args),null);
  assert.equal(C.tryRestoreSession({...base,key:args.currentKey},args),null);
  const current={...base,key:args.currentKey,targetIds:['a','b']};
  assert.equal(C.tryRestoreSession(current,args).sessionId,'legacy');
  assert.equal(C.tryRestoreSession(current,{...args,currentPageIds:['b','a']}),null);
  assert.equal(C.tryRestoreSession({...base,key:'all:off:random:50:1'},args),null);
});
test('current random session restoration requires the same saved position and ordered target IDs', () => {
  const words=['a','b','c','d'].map(id=>({id})),randomIds=['c','a','b','d'];
  const page=C.buildRandomFixedPage(words,{}, {pageSize:2,randomIds,startIndex:2});
  const view={filter:'all',sortMode:'random',excludeStreak:false,masteryThreshold:3,pageIndex:9,randomStart:2};
  const key=C.studySessionKey(view,2);
  const session={sessionId:'random-page',key,updatedAt:1000,revealY:42,targetIds:page.entries.map(word=>word.id),viewState:C.serializeView(view),studiedIds:['b'],checkedIds:['b'],finalizedIds:[]};
  const args={currentKey:key,currentPageIds:['b','d']};
  assert.equal(C.tryRestoreSession(session,args).sessionId,'random-page');
  assert.equal(C.tryRestoreSession(session,{...args,currentKey:C.studySessionKey({...view,randomStart:0},2)}),null);
  assert.equal(C.tryRestoreSession(session,{...args,currentPageIds:['d','b']}),null);
  assert.equal(C.tryRestoreSession({...session,targetIds:['b','b']},args),null);
});
test('legacy session from days ago restores without finalizing its pending result', () => {
  const words=[{id:'a'}],state={a:{...C.defaultState(),studyCount:1}};
  const saved={sessionId:'expired-legacy',key:'all:off:normal:0',updatedAt:1000,revealY:20,studiedIds:['a'],checkedIds:['a'],finalizedIds:[]};
  const store=memoryStorage();C.saveCore(store,'ledger',{state,gptSessions:{},activeSession:saved});
  const model=C.buildPageModel(words,state,{pageSize:50});
  const config={currentKey:'all:off:normal:50:0',legacyKey:saved.key,filter:'all',sortMode:'normal',pageIndex:0,words,state,randomIds:[],currentPageIds:model.pages[0].entries.map(w=>w.id)};
  const result=runRestore(store,config,7*24*60*60*1000+1000);
  assert.equal(result.activeSession.sessionId,'expired-legacy');
  assert.deepEqual([result.state.a.studyCount,result.state.a.correctCount,result.state.a.recentResults],[1,0,[]]);
  const again=runRestore(store,config,7*24*60*60*1000+2000);
  assert.equal(again.activeSession.sessionId,'expired-legacy');
  assert.deepEqual([again.state.a.studyCount,again.state.a.correctCount,again.state.a.recentResults],[1,0,[]]);
});
test('initial screen defaults to home and only restores study when words exist', () => {
  assert.equal(C.resolveInitialScreen(null,true),'home');
  assert.equal(C.resolveInitialScreen('home',true),'home');
  assert.equal(C.resolveInitialScreen('study',true),'study');
  assert.equal(C.resolveInitialScreen('invalid',true),'home');
  assert.equal(C.resolveInitialScreen('study',false),'home');
});
test('initial screen storage read failure is distinct from missing or invalid state', () => {
  const missing=C.inspectInitialScreen(memoryStorage(), 'screen', true);
  assert.deepEqual({screen:missing.screen,readFailed:missing.readFailed,needsSave:missing.needsSave},
    {screen:'home',readFailed:false,needsSave:true});
  const invalid=C.inspectInitialScreen(memoryStorage({screen:'other'}), 'screen', true);
  assert.deepEqual({screen:invalid.screen,readFailed:invalid.readFailed,needsSave:invalid.needsSave},
    {screen:'home',readFailed:false,needsSave:true});
  const saved=C.inspectInitialScreen(memoryStorage({screen:'study'}), 'screen', true);
  assert.deepEqual({screen:saved.screen,readFailed:saved.readFailed,needsSave:saved.needsSave},
    {screen:'study',readFailed:false,needsSave:false});
  const failure=C.inspectInitialScreen({getItem(){throw new Error('storage unavailable')}}, 'screen', true);
  assert.equal(failure.screen,'home');
  assert.equal(failure.readFailed,true);
  assert.equal(failure.needsSave,false);
  assert.match(failure.error.message,/storage unavailable/);
});
test('initial screen correction save failure is reported once without retry', () => {
  const state=C.inspectInitialScreen(memoryStorage(), 'screen', true);
  let writes=0;
  const unavailable={setItem(){writes++;throw new Error('quota exceeded')}};
  const result=C.persistInitialScreen(unavailable,'screen',state);
  assert.deepEqual({ok:result.ok,attempted:result.attempted,writes},{ok:false,attempted:true,writes:1});
  assert.match(result.error.message,/quota exceeded/);
  const readFailure=C.inspectInitialScreen({getItem(){throw new Error('denied')}},'screen',true);
  const notAttempted=C.persistInitialScreen(unavailable,'screen',readFailure);
  assert.deepEqual({ok:notAttempted.ok,attempted:notAttempted.attempted,writes},{ok:false,attempted:false,writes:1});
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

test('GPT payload carries a complete result URL contract and string word IDs', () => {
  const payload=C.makeGptPayload('issued-id',[{id:17,question:'word / 雨☂',answer:'意味, 記号 ✓'}]);
  assert.equal(payload.version,1);assert.equal(payload.sessionId,'issued-id');assert.equal(payload.mode,'en-to-ja');
  assert.deepEqual(payload.words,[{id:'17',word:'word / 雨☂',meaning:'意味, 記号 ✓'}]);
  const legacyContract=[
    '学習結果はJSONのみで出力してください。説明文やMarkdownのコードフェンスは付けないでください。',
    '形式: {"version":1,"sessionId":"発行されたsessionId","results":[{"id":"単語ID","result":"correct|wrong|uncertain|skipped"}]}',
    'versionは数値1、sessionIdは変更せず、idは渡された単語IDを文字列のまま使ってください。',
    'resultはcorrect、wrong、uncertain、skippedのみ。incorrectやunknownなどは禁止です。',
    'resultsのIDはこのURLで渡された単語だけにし、重複させないでください。'
  ].join(' ');
  assert.equal(payload.outputInstructions,legacyContract);
  assert.doesNotMatch(payload.outputInstructions,/\?result=/);
  const legacyStudyUrl=new URL('https://soccermasatoshi12-ctrl.github.io/word-list-study/');
  legacyStudyUrl.searchParams.set('study',Buffer.from(JSON.stringify(payload),'utf8').toString('base64'));
  const decodedStudyPayload=JSON.parse(Buffer.from(legacyStudyUrl.searchParams.get('study'),'base64').toString('utf8'));
  assert.deepEqual(decodedStudyPayload,payload);
  const prompt=C.makeGptPrompt(payload),url=C.makeChatGptUrl(payload);
  assert.equal(url,`https://chatgpt.com/?prompt=${encodeURIComponent(prompt)}`);
  assert.equal(decodeURIComponent(url.slice(url.indexOf('=')+1)),prompt);
  assert.match(prompt,/^Word List Study 学習データ\nversion: 1\nsessionId: issued-id\nmode: en-to-ja\n\nid,word,meaning\n/);
  assert.deepEqual(parsePromptWords(prompt,payload.words.length),payload.words);
  assert.match(prompt,/一問ずつ提示/);assert.match(prompt,/全問題の学習が終わるまで結果JSONや結果リンクを出さない/);
  assert.match(prompt,/soccermasatoshi12-ctrl\.github\.io\/word-list-study\/\?result=/);
  assert.doesNotMatch(prompt,/incorrectやunknownなどは禁止です/);
});

test('GPT issue record and ChatGPT prompt share the issued session ID and exact word ID order',()=>{
  const words=[{id:'id/1',question:'café ☕',answer:'コーヒー／意味'},{id:'id?2',question:'word',answer:'訳'}];
  const selected=C.selectGptWords(words,{}, {startId:'id/1',count:2});
  const sessionId='issued-日本語-42',payload=C.makeGptPayload(sessionId,selected),prompt=C.makeGptPrompt(payload);
  const url=C.makeChatGptUrl(payload),promptFromUrl=new URL(url).searchParams.get('prompt');
  const issuedRecord={ids:selected.map(word=>String(word.id))};
  assert.match(promptFromUrl,new RegExp(`^Word List Study 学習データ\\nversion: 1\\nsessionId: ${sessionId}\\nmode: en-to-ja`));
  assert.deepEqual(parsePromptWords(promptFromUrl,payload.words.length).map(word=>word.id),issuedRecord.ids);
  assert.deepEqual(selected.map(word=>String(word.id)),issuedRecord.ids);
  const legacy=new URL('https://example.test/');legacy.searchParams.set('study',Buffer.from(JSON.stringify(payload),'utf8').toString('base64'));
  const legacyPayload=JSON.parse(Buffer.from(legacy.searchParams.get('study'),'base64').toString('utf8'));
  assert.equal(legacyPayload.sessionId,sessionId);
  assert.deepEqual(legacyPayload.words.map(word=>word.id),issuedRecord.ids);
  assert.doesNotMatch(legacyPayload.outputInstructions,/\?result=/);
  assert.match(promptFromUrl,/\?result=/);
});

test('ChatGPT prompt URL preserves all 49 issued words and Unicode through encodeURIComponent',()=>{
  const selected=Array.from({length:49},(_,index)=>({id:`id/${index+1}`,question:`単語${index+1} ☂`,answer:`意味${index+1}・✓`}));
  const payload=C.makeGptPayload('session-49',selected),prompt=C.makeGptPrompt(payload),url=C.makeChatGptUrl(payload);
  const parsed=new URL(url),decoded=parsed.searchParams.get('prompt');
  const data=parsePromptWords(decoded,payload.words.length);
  assert.equal(parsed.origin,'https://chatgpt.com');assert.equal(parsed.pathname,'/');
  assert.match(decoded,/^Word List Study 学習データ\nversion: 1\nsessionId: session-49\nmode: en-to-ja/);
  assert.equal(data.length,49);
  assert.deepEqual(data.map(word=>word.id),selected.map(word=>word.id));
  assert.deepEqual(data.map(word=>word.meaning),selected.map(word=>word.answer));
  assert.ok(decoded.includes('単語49 ☂'));assert.ok(decoded.includes('意味49・✓'));
  assert.equal(url,`https://chatgpt.com/?prompt=${encodeURIComponent(prompt)}`);
});

test('ChatGPT prompt CSV preserves URL and CSV special characters after URLSearchParams decoding',()=>{
  const selected=[
    {id:'%20&+?',question:'100%20 & + ?',answer:'日本語, "引用"'},
    {id:'line\n2',question:'first line\nsecond line',answer:'訳\r\n続き\n\n学習指示：data-like text'}
  ];
  const payload=C.makeGptPayload('特殊/session?&+',selected),url=C.makeChatGptUrl(payload);
  const prompt=new URL(url).searchParams.get('prompt');
  assert.match(prompt,/^Word List Study 学習データ\nversion: 1\nsessionId: 特殊\/session\?&\+\nmode: en-to-ja/);
  assert.deepEqual(parsePromptWords(prompt,selected.length),selected.map(word=>({id:String(word.id),word:word.question,meaning:word.answer})));
  assert.match(prompt,/結果返却指示：/);
  assert.match(prompt,/https:\/\/soccermasatoshi12-ctrl\.github\.io\/word-list-study\/\?result=/);
  assert.match(prompt,/URLエンコード/);
});

test('GPT UI gates one prompt per modal, confirms replacing the latest pending session, and copies the exact prompt body',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/id="openChatGpt"[^>]*>ChatGPTで開く/);
  assert.match(html,/id="makeSession"[^>]*>プロンプトを発行/);
  assert.match(html,/id="gptPromptPreview"[^>]*hidden/);
  assert.match(html,/els\.gptPromptText\.textContent=lastChatGptPrompt;els\.gptPromptCopyFeedback\.textContent="";els\.gptPromptPreview\.hidden=false/);
  assert.match(html,/id="copyChatGpt"[^>]*><svg/);
  assert.doesNotMatch(html,/id="copySession"|id="sessionUrl"|id="chatGptUrl"/);
  assert.match(html,/StudyCore\.makeChatGptUrl\(payload\)/);
  assert.match(html,/lastChatGptPrompt=StudyCore\.makeGptPrompt\(payload\)/);
  assert.match(html,/window\.open\(lastChatGptUrl,"_blank","noopener,noreferrer"\)/);
  assert.match(html,/copyText\(lastChatGptPrompt\)/);
  assert.match(html,/const label=await copyText\(lastChatGptPrompt\)\?"コピーしました":"コピーできませんでした";els\.gptPromptCopyFeedback\.textContent=label;els\.copyChatGpt\.setAttribute\("aria-label",label\)/);
  assert.match(html,/els\.makeSession\.addEventListener\("click",requestGptSessionIssue\)/);
  assert.match(html,/if\(latestUnregisteredGptSessionId\(\)\)\{[\s\S]*els\.gptIssueConfirm\.showModal\(\)/);
  assert.match(html,/els\.cancelGptIssue\.addEventListener\("click",event=>\{event\.stopPropagation\(\);if\(gptIssueConfirmationPending&&els\.gptIssueConfirm\.open\)els\.gptIssueConfirm\.close\("cancel"\)\}\)/);
  assert.match(html,/els\.gptIssueConfirm\.addEventListener\("click",event=>\{event\.stopPropagation\(\);if\(event\.target===els\.gptIssueConfirm&&gptIssueConfirmationPending\)els\.gptIssueConfirm\.close\("cancel"\)\}\)/);
  assert.match(html,/els\.gptIssueConfirm\.addEventListener\("close",\(\)=>\{if\(!gptIssueConfirmationPending\)return;gptIssueConfirmationPending=false;els\.makeSession\.disabled=false/);
  assert.match(html,/els\.confirmGptIssue\.addEventListener\("click",event=>\{event\.stopPropagation\(\);if\(!gptIssueConfirmationPending\|\|gptIssueInProgress\)return;gptIssueConfirmationPending=false;els\.gptIssueConfirm\.close\("confirm"\);[\s\S]*makeGptSession\(\)/);
  assert.match(html,/\.gpt-prompt-preview\{[^}]*width:100%/);
  assert.match(html,/els\.gptPanel\.addEventListener\("close",\(\)=>\{removeGptResultParamFromUrl\(\);resetGptIssueUi\(\)\}\)/);
  assert.match(html,/url\.searchParams\.set\("study",/);
});

test('result URL prefill retains the query until the registration dialog closes or persistence succeeds',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const start=html.indexOf('function receiveGptResultFromUrl()'),helperStart=html.indexOf('function removeGptResultParamFromUrl()'),end=html.indexOf('\n  function restartViewSession',start);
  assert.notEqual(start,-1);assert.notEqual(helperStart,-1);assert.notEqual(end,-1);
  const receiver=html.slice(start,helperStart),helper=html.slice(helperStart,end);
  assert.match(receiver,/url\.searchParams\.has\("result"\)/);
  assert.match(receiver,/url\.searchParams\.get\("result"\)/);
  assert.doesNotMatch(receiver,/decodeURIComponent|applyGptResults|inspectGptResults|prepareGptIntegration|searchParams\.delete|replaceState/);
  assert.match(receiver,/els\.resultJson\.value=result/);
  assert.match(receiver,/els\.gptPanel\.showModal\(\)/);
  assert.match(helper,/url\.searchParams\.has\("result"\)/);
  assert.match(helper,/url\.searchParams\.delete\("result"\)/);
  assert.match(helper,/history\.replaceState\(history\.state/);
  assert.match(helper,/url\.pathname\}\$\{url\.search\}\$\{url\.hash/);
  assert.match(html,/receiveGptResultFromUrl\(\);/);
  assert.match(html,/els\.gptPanel\.addEventListener\("close",\(\)=>\{removeGptResultParamFromUrl\(\);resetGptIssueUi\(\)\}\)/);
  const applyStart=html.indexOf('function applyGptResults()'),confirmStart=html.indexOf('function confirmGptResultRegistration()',applyStart),apply=html.slice(applyStart,confirmStart),confirmEnd=html.indexOf('\n  function receiveGptResultFromUrl()',confirmStart),confirm=html.slice(confirmStart,confirmEnd);
  assert.ok(apply.indexOf('StudyCore.prepareGptIntegration')<apply.indexOf('els.gptResultConfirm.showModal()'));
  assert.doesNotMatch(apply,/saveCoreTransition|removeGptResultParamFromUrl|state=draft\.state|finally\{els\.resultJson\.value/);
  assert.doesNotMatch(apply,/confirm\(/,'replay confirmation is part of the custom dialog, not a second window.confirm');
  assert.match(apply,/const rawJson=els\.resultJson\.value,obj=JSON\.parse\(rawJson\)/);
  assert.match(apply,/StudyCore\.summarizeGptResults/);
  assert.match(confirm,/StudyCore\.saveCoreTransition/);
  assert.ok(confirm.indexOf('StudyCore.saveCoreTransition')<confirm.indexOf('removeGptResultParamFromUrl()'));
  assert.ok(confirm.indexOf('StudyCore.saveCoreTransition')<confirm.indexOf('els.resultJson.value=""'));
  assert.match(confirm,/gptResultReviewContextSignature\(\)!==review\.contextSignature/);
  assert.match(confirm,/gptResultRegistrationInProgress=true;els\.confirmGptResult\.disabled=true/);
  assert.match(confirm,/catch\(err\)\{[\s\S]*els\.gptResultConfirmError\.textContent=err\.message\|\|String\(err\)/);
  assert.match(confirm,/finally\{[\s\S]*gptResultRegistrationInProgress=false/);
  const closeStart=html.indexOf('function closeGptResultReview('),closeEnd=html.indexOf('\n  function confirmGptResultRegistration()',closeStart),close=html.slice(closeStart,closeEnd);
  assert.doesNotMatch(close,/saveCoreTransition|resultJson\.value=/,'editing or cancelling a review never writes storage or clears input');
  assert.match(html,/els\.editGptResultJson\.addEventListener\("click",\(\)=>closeGptResultReview\("edit"\)\)/);
  assert.match(html,/els\.confirmGptResult\.addEventListener\("click",confirmGptResultRegistration\)/);
  assert.match(html,/els\.confirmGptResult\.textContent=checked\.isReplay\?"確認して再登録":"確認して登録"/);
  assert.match(html,/function closeGptResultReview\(returnValue="edit"\)[\s\S]*?if\(returnValue==="edit"\)requestAnimationFrame\(\(\)=>els\.resultJson\.focus\(\)\)/);
  assert.match(html,/els\.gptResultConfirm\.addEventListener\("cancel",event=>\{event\.preventDefault\(\)/);
  assert.match(html,/このセッションの結果は過去に登録されています/);
  assert.match(html,/結果のない\$\{summary\.missingCount\}語は学習履歴に反映されません/);
  assert.match(html,/登録しても学習履歴は増えず、この操作でセッションが終了します/);
  assert.match(html,/textContent=title;body\.textContent=message/);
  assert.doesNotMatch(html,/gptResultWarning\.innerHTML/);
});

test('GPT result review dialog clearly labels counts and preserves confirmation actions for mobile layouts',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8'),start=html.indexOf('<dialog id="gptResultConfirm"'),end=html.indexOf('</dialog>',start),dialog=html.slice(start,end);
  assert.match(dialog,/aria-labelledby="gptResultConfirmTitle" aria-describedby="gptResultConfirmDescription"/);
  for(const label of ['発行単語数','結果あり','結果なし','正解','不正解','曖昧','スキップ','JSONを修正','確認して登録'])assert.ok(dialog.includes(label),`dialog includes ${label}`);
  assert.match(dialog,/id="gptResultConfirmError"[^>]*role="alert"/);
  assert.match(html,/dialog\.gpt-result-confirm-dialog\{[^}]*max-height:calc\(100dvh - 24px\)[^}]*overflow:auto/);
  assert.match(html,/@media\(max-width:380px\)\{\.gpt-result-confirm/);
  assert.match(html,/\.gpt-result-stat-value\{[^}]*font-size:1\.3rem[^}]*white-space:nowrap/);
  assert.match(html,/@media\(max-width:380px\)\{[^]*?\.gpt-result-stat-value\{font-size:1\.15rem\}/);
  const applied=dialog.slice(dialog.indexOf('id="gptResultAppliedSummary"'));
  assert.match(applied,/id="toggleGptResultList"[^>]*aria-expanded="false" aria-controls="gptResultListPanel"/);
  assert.match(applied,/id="gptResultListPanel"[^>]*hidden/);
  assert.match(applied,/<th scope="col">単語<\/th><th scope="col">GPT判定<\/th><th scope="col">登録対象<\/th>/);
  assert.match(applied,/学習中の単語にはGPTの結果を反映しません。学習を確定してから登録してください。/);
  assert.match(html,/function renderGptResultList\(review\)[\s\S]*?word\.question\|\|""/);
  assert.match(html,/target=targetsById\.get\(String\(result\.id\)\)/);
  assert.match(html,/rows\.sort\(\(a,b\)=>\(a\.word\?\.index\?\?Number\.MAX_SAFE_INTEGER\)-\(b\.word\?\.index\?\?Number\.MAX_SAFE_INTEGER\)\|\|a\.index-b\.index\)/);
  assert.match(html,/els\.gptResultListBody\.replaceChildren\(\)/);
  assert.match(html,/function renderGptResultReview\(review\)[\s\S]*?renderGptResultList\(review\);setGptResultListOpen\(false\)/);
  assert.match(html,/function setGptResultListOpen\(open\)[\s\S]*?gptResultListPanel\.hidden=!isOpen;els\.toggleGptResultList\.setAttribute\("aria-expanded",String\(isOpen\)\)/);
  const toggleStart=html.indexOf('function setGptResultListOpen('),toggleEnd=html.indexOf('\n  function renderGptResultList(',toggleStart),toggle=html.slice(toggleStart,toggleEnd);
  assert.doesNotMatch(toggle,/saveCoreTransition|localStorage|state\s*=|activeSession\s*=/,'opening the read-only list never changes study state');
  assert.match(html,/els\.toggleGptResultList\.addEventListener\("click",\(\)=>setGptResultListOpen\(els\.gptResultListPanel\.hidden\)\)/);
  assert.match(html,/targetLabel\.textContent=target\?\.target\?"対象"/);
  assert.doesNotMatch(html,/gptResultListBody\.innerHTML|gptResultListPanel\.innerHTML/);
});

test('result URL removal preserves unrelated query, hash, and existing history state',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8'),start=html.indexOf('function removeGptResultParamFromUrl()'),end=html.indexOf('\n  function restartViewSession',start);
  const helper=html.slice(start,end),historyState={marker:'keep'},calls=[];
  let href='https://example.test/study?keep=one&result=%7B%22x%22%3A1%7D&other=two#section';
  const window={get location(){return{href}}},history={state:historyState,replaceState(state,title,next){calls.push({state,title,next});href=new URL(next,href).href}};
  const remove=new Function('window','history',`${helper};return removeGptResultParamFromUrl`)(window,history);
  assert.equal(remove(),true);assert.equal(new URL(href).searchParams.has('result'),false);
  assert.equal(new URL(href).searchParams.get('keep'),'one');assert.equal(new URL(href).searchParams.get('other'),'two');assert.equal(new URL(href).hash,'#section');
  assert.equal(calls.length,1);assert.equal(calls[0].state,historyState);
  assert.equal(remove(),false);assert.equal(calls.length,1);
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

test('GPT issue context survives save/load while legacy records keep their old shape',()=>{
  const words=Array.from({length:35},(_,i)=>({id:String(i+1),question:`word${i+1}`,answer:`意味${i+1}`}));
  const ids=['11','12','13'],context=C.createGptIssueContext(words,{startId:'11',pageSize:10,ids});
  const store=memoryStorage();C.saveCore(store,'ledger',{state:{},activeSession:null,gptSessions:{fresh:{createdAt:'t',ids,context},legacy:{createdAt:'old',ids:['a']}}});
  const loaded=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(loaded.gptSessions.fresh.context,context);
  assert.deepEqual(loaded.gptSessions.legacy,{createdAt:'old',ids:['a']});
  const malformed=C.normalizeGptSessionRecords({bad:{ids:['1'],context:{version:1}}});
  assert.equal(malformed.gptSessions.bad.context,null);
  assert.equal(C.evaluateGptJump(malformed.gptSessions.bad,words,jumpView({sortMode:'normal'},10,[]),[{id:'1',result:'correct'}]).reason,'invalid-context');
  const forged={ids:['1'],context:{...context,targetPositions:[2]}};
  assert.equal(C.evaluateGptJump(forged,words,jumpView({sortMode:'normal',filter:'all'},10,[]),[{id:'1',result:'correct'}]).reason,'invalid-context');
});

test('GPT jump uses the furthest returned result including skipped and computes normal page across boundary',()=>{
  const words=Array.from({length:35},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const ids=['9','10','11','12'],context=C.createGptIssueContext(words,{startId:'9',pageSize:10,ids});
  const record={ids,context};
  const result=C.evaluateGptJump(record,words,jumpView({sortMode:'normal',filter:'all',pageIndex:0,randomStart:0,excludeStreak:false,masteryThreshold:3},10,[]),[
    {id:'12',result:'skipped'},{id:'9',result:'correct'},{id:'11',result:'uncertain'}
  ]);
  assert.equal(result.canJump,true);assert.equal(result.lastResultId,'12');assert.equal(result.orderPreserved,true);
  assert.deepEqual(result.candidatePosition,{sortMode:'normal',pageIndex:1,randomStart:null,wordIndex:11});
  assert.deepEqual(Object.keys(jumpView()).sort(),['excludeStreak','excludeStreakN','filter','masteryThreshold','pageIndex','pageSize','randomIds','randomStart','sortMode'].sort());
});

test('GPT jump refuses a changed display order while retaining result order metadata',()=>{
  const words=Array.from({length:30},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const randomIds=['4','2','1',...words.map(w=>w.id).filter(id=>!['4','2','1'].includes(id))];
  const ids=['2','1','5'],context=C.createGptIssueContext(words,{sortMode:'random',randomIds,startId:'2',pageSize:10,ids});
  const result=C.evaluateGptJump({ids,context},words,jumpView({filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0},10,randomIds),[
    {id:'5',result:'wrong'},{id:'1',result:'correct'}
  ]);
  assert.equal(result.canJump,false);assert.equal(result.reason,'order-mismatch');assert.equal(result.issuedMode,'random');assert.equal(result.currentMode,'normal');
  assert.equal(result.orderPreserved,true);assert.equal(result.lastResultId,'5');
  const returnedToRandom=C.evaluateGptJump({ids,context},words,jumpView({sortMode:'random'},10,randomIds),[{id:'5',result:'wrong'}]);
  assert.equal(returnedToRandom.canJump,true);assert.equal(returnedToRandom.requiresModeRestore,false);
  const normalIds=['11','12'],normalContext=C.createGptIssueContext(words,{startId:'11',pageSize:10,ids:normalIds});
  const normalResult=C.evaluateGptJump({ids:normalIds,context:normalContext},words,jumpView({filter:'all',sortMode:'random',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0},10,randomIds),[{id:'12',result:'correct'}]);
  assert.equal(normalResult.canJump,false);assert.equal(normalResult.reason,'order-mismatch');assert.equal(normalResult.orderPreserved,true);
});

test('GPT jump suppresses changed CSV, content, random order, and missing legacy context',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const randomIds=words.map(w=>w.id),ids=['1','2'],context=C.createGptIssueContext(words,{sortMode:'random',randomIds,startId:'1',pageSize:10,ids});
  const record={ids,context},view=jumpView({filter:'all',sortMode:'random',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0},10,randomIds);
  const results=[{id:'2',result:'correct'}];
  assert.equal(C.evaluateGptJump(record,words.slice().reverse(),view,results).reason,'csv-order-changed');
  const edited=words.map(w=>w.id==='3'?{...w,answer:'changed'}:w);
  assert.equal(C.evaluateGptJump(record,edited,view,results).reason,'content-changed');
  const reshuffled=[...randomIds].reverse();
  assert.equal(C.evaluateGptJump(record,words,{...view,randomIds:reshuffled},results).reason,'order-changed');
  assert.equal(C.evaluateGptJump(record,words,jumpView({sortMode:'random'},10,null),results).reason,'invalid-order');
  assert.equal(C.evaluateGptJump(record,words.slice(0,-1),view,results).reason,'dataset-changed');
  assert.equal(C.evaluateGptJump({ids},words,view,results).reason,'legacy-no-context');
  assert.equal(C.evaluateGptJump(record,words,view,[]).reason,'no-practical-result');
  const skipped=C.evaluateGptJump(record,words,view,[{id:'2',result:'skipped'}]);
  assert.equal(skipped.canJump,true);assert.equal(skipped.lastResultId,'2');
});

test('GPT jump rejects filtered targets and recalculates candidate for current page size',()=>{
  const words=Array.from({length:30},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const ids=['11'],context=C.createGptIssueContext(words,{startId:'11',pageSize:10,ids}),record={ids,context},results=[{id:'11',result:'correct'}];
  assert.equal(C.evaluateGptJump(record,words,jumpView({sortMode:'normal',filter:'all'},20,[]),results).candidatePosition.pageIndex,0);
  assert.equal(C.evaluateGptJump(record,words,jumpView({sortMode:'normal',filter:'all',excludeStreak:true,masteryThreshold:3,pageIndex:1},10,[]),results,{'11':{currentStreak:3}}).reason,'target-filtered');
});

test('GPT integration finalizes the departed normal page, keeps destination results provisional, and uses issue order',()=>{
  const words=Array.from({length:30},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const ids=words.slice(7,17).map(w=>w.id),context=C.createGptIssueContext(words,{startId:'8',pageSize:10,ids});
  const record={createdAt:'t',ids,context},sessions={s:record},registered=[];
  const state={};for(const id of ['2','9','10'])state[id]={...C.defaultState(),studyCount:1};
  const view={filter:'all',sortMode:'normal',excludeStreak:false,excludeStreakN:3,masteryThreshold:3,pageIndex:0,randomStart:0};
  const active={sessionId:'old',key:C.studySessionKey(view,10),updatedAt:123,revealY:40,targetIds:words.slice(0,10).map(w=>w.id),viewState:{...view,pageSize:10},studiedIds:['2','9','10'],checkedIds:['2'],finalizedIds:[],pendingId:null};
  const obj={version:1,sessionId:'s',results:[{id:'17',result:'correct'},{id:'16',result:'skipped'},{id:'13',result:'uncertain'},{id:'10',result:'wrong'},{id:'9',result:'correct'},{id:'8',result:'correct'},{id:'12',result:'wrong'}]};
  const progress=C.recordStudyDisclosure({},words,'normal',[],'10');
  const result=prepareIntegration(obj,{sessions,registeredIds:registered,knownIds:words.map(w=>w.id),words,state,activeSession:active,currentView:view,pageSize:10,randomIds:[],studyProgress:progress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(result.jump.canJump,true);assert.equal(result.jump.lastResultId,'17');assert.equal(result.transition.kind,'jump');assert.equal(result.samePage,false);
  assert.deepEqual(result.ignoredOverlapIds,['9','10']);assert.deepEqual(result.provisionalIds,['12','13','17']);assert.equal(result.formalApplied,1);assert.equal(result.applied,4);
  assert.equal(result.activeSession.sessionId,'gpt-s');assert.deepEqual(result.activeSession.targetIds,words.slice(10,20).map(w=>w.id));
  assert.deepEqual(result.activeSession.studiedIds,['12','13','17']);assert.deepEqual(result.activeSession.checkedIds,['17']);assert.deepEqual(result.activeSession.finalizedIds,[]);
  assert.equal(result.activeSession.furthestProgressId,'17');
  assert.deepEqual(result.state['8'].recentResults,[true]);assert.equal(result.state['8'].studyCount,1);
  assert.deepEqual(result.state['2'].recentResults,[true]);assert.deepEqual(result.state['9'].recentResults,[false]);assert.deepEqual(result.state['10'].recentResults,[false]);
  assert.equal(result.state['17'].studyCount,1);assert.equal(result.state['17'].correctCount,0);assert.deepEqual(result.state['17'].recentResults,[]);
  const finalized=C.finalizeSessionDraft(result.state,result.activeSession);
  assert.equal(finalized.state['17'].studyCount,1);assert.equal(finalized.state['17'].correctCount,1);assert.deepEqual(finalized.state['17'].recentResults,[true]);
  assert.deepEqual(sessions,{s:record});assert.deepEqual(registered,[]);assert.equal(state['8'],undefined);
});

test('GPT landing targetIds reflect mastery exclusions created while finalizing the departed session',()=>{
  const words=Array.from({length:30},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const randomIds=['11','12','13','14','15','16','17','18','19','1','22','20',...words.map(w=>w.id).filter(id=>!['11','12','13','14','15','16','17','18','19','1','22','20'].includes(id))];
  const ids=['1','22'],context=C.createGptIssueContext(words,{sortMode:'random',randomIds,startId:'1',pageSize:10,excludeStreak:true,masteryThreshold:2,ids});
  const record={createdAt:'t',ids,context},view={filter:'all',sortMode:'random',excludeStreak:true,masteryThreshold:2,pageIndex:0,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,10),updatedAt:1000,revealY:33,targetIds:randomIds.slice(0,10),
    viewState:{...view,pageSize:10},studiedIds:['1'],checkedIds:['1'],finalizedIds:[],pendingId:null};
  const state={'1':{...C.defaultState(),studyCount:2,correctCount:1,recentResults:[true],currentStreak:1}};
  const progress=C.recordStudyDisclosure({},words,'random',randomIds,'1');
  const result=prepareIntegration({version:1,sessionId:'s',results:[{id:'22',result:'correct'},{id:'1',result:'wrong'}]},
    {sessions:{s:record},registeredIds:[],knownIds:words.map(w=>w.id),words,state,activeSession:active,currentView:view,pageSize:10,randomIds,studyProgress:progress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(result.jump.canJump,true);assert.equal(result.samePage,false);assert.deepEqual(result.ignoredOverlapIds,['1']);
  assert.deepEqual(result.provisionalIds,['22']);assert.equal(result.formalApplied,0);
  assert.deepEqual(result.state['1'].recentResults,[true,true]);assert.equal(result.state['1'].studyCount,2);
  assert.equal(result.state['1'].correctCount,2);assert.equal(result.state['1'].currentStreak,2);
  const beforeFinalize=C.buildRandomFixedPage(words,state,{pageSize:10,randomIds,excludeStreak:true,masteryThreshold:2,startIndex:0}).entries.map(w=>w.id);
  assert.ok(beforeFinalize.includes('1'));
  const visible=C.buildRandomFixedPage(words,result.state,{pageSize:10,randomIds,excludeStreak:true,masteryThreshold:2,startIndex:10}).entries.map(w=>w.id);
  const departedVisible=C.buildRandomFixedPage(words,result.state,{pageSize:10,randomIds,excludeStreak:true,masteryThreshold:2,startIndex:0}).entries.map(w=>w.id);
  assert.ok(beforeFinalize.includes('1'));assert.ok(!departedVisible.includes('1'));assert.deepEqual(result.activeSession.targetIds,visible);
  const restored=C.tryRestoreSession(result.activeSession,{
    currentKey:C.studySessionKey(result.activeSession.viewState,10),filter:'all',sortMode:'random',excludeStreak:true,masteryThreshold:2,
    words,state:result.state,randomIds,currentPageIds:visible});
  assert.ok(restored);assert.deepEqual(restored.studiedIds,['22']);
  const restoredAfterLongAbsence=C.tryRestoreSession(result.activeSession,{
    currentKey:C.studySessionKey(result.activeSession.viewState,10),currentPageIds:visible});
  assert.ok(restoredAfterLongAbsence);assert.deepEqual(restoredAfterLongAbsence.studiedIds,['22']);
  const finalized=C.finalizeSessionDraft(result.state,restored);
  assert.deepEqual(finalized.state['1'].recentResults,[true,true]);assert.deepEqual(finalized.state['22'].recentResults,[true]);
  assert.equal(finalized.state['22'].studyCount,1);assert.equal(finalized.state['22'].correctCount,1);
  const idempotentState=JSON.parse(JSON.stringify(result.state));
  const finalizedSession={...restored,studiedIds:[...restored.studiedIds],checkedIds:[...restored.checkedIds],finalizedIds:[...restored.finalizedIds]};
  const getState=id=>idempotentState[id]=C.normalizeState(idempotentState[id]||C.defaultState());
  C.finalizeStudySession(finalizedSession,getState);const first=JSON.stringify(idempotentState);
  C.finalizeStudySession(finalizedSession,getState);
  assert.equal(JSON.stringify(idempotentState),first);assert.deepEqual(idempotentState['22'].recentResults,[true]);assert.equal(idempotentState['22'].studyCount,1);
});

test('GPT integration merges destination results into the same active page without disturbing existing answers',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),ids=['1','2','3','4','5'];
  const context=C.createGptIssueContext(words,{startId:'1',pageSize:10,ids}),record={createdAt:'t',ids,context},view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const state={'2':{...C.defaultState(),studyCount:1}},active={sessionId:'app',key:C.studySessionKey(view,10),updatedAt:123,revealY:77,targetIds:words.slice(0,10).map(w=>w.id),viewState:{...view,pageSize:10},studiedIds:['2'],checkedIds:['2'],finalizedIds:[],pendingId:'2'};
  const result=prepareIntegration({version:1,sessionId:'s',results:[{id:'5',result:'correct'},{id:'2',result:'wrong'},{id:'3',result:'uncertain'}]},
    {sessions:{s:record},registeredIds:[],knownIds:words.map(w=>w.id),words,state,activeSession:active,currentView:view,pageSize:10,randomIds:[],studyProgress:C.recordStudyDisclosure({},words,'normal',[],'2'),now:'2026-10-12T00:00:00.000Z'});
  assert.equal(result.jump.canJump,true);assert.equal(result.samePage,true);assert.equal(result.transition.kind,'stay');
  assert.deepEqual(result.ignoredOverlapIds,['2']);assert.deepEqual(result.provisionalIds,['3','5']);assert.equal(result.formalApplied,0);
  assert.equal(result.activeSession.sessionId,'app');assert.equal(result.activeSession.revealY,77);assert.equal(result.activeSession.pendingId,'2');
  assert.deepEqual(result.activeSession.studiedIds,['2','3','5']);assert.deepEqual(result.activeSession.checkedIds,['2','5']);
  assert.equal(result.state['2'].studyCount,1);assert.deepEqual(result.state['2'].recentResults,[]);
  assert.equal(result.state['3'].studyCount,1);assert.equal(result.state['5'].correctCount,0);
  const restored=C.tryRestoreSession(result.activeSession,{currentKey:active.key,legacyKey:'legacy',
    filter:'all',sortMode:'normal',pageIndex:0,pageSize:10,words,state:result.state,randomIds:[],currentPageIds:active.targetIds});
  assert.ok(restored);const finalized=C.finalizeSessionDraft(result.state,restored);
  assert.equal(finalized.state['2'].studyCount,1);assert.equal(finalized.state['3'].studyCount,1);assert.equal(finalized.state['5'].studyCount,1);
  assert.equal(finalized.state['3'].currentStreak,0);assert.equal(finalized.state['5'].currentStreak,1);
});

test('GPT integration keeps finalized active-session overlaps on the formal history path',()=>{
  const words=Array.from({length:10},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),ids=['2'];
  const context=C.createGptIssueContext(words,{startId:'2',pageSize:10,ids}),record={createdAt:'t',ids,context},view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,10),updatedAt:1,revealY:0,targetIds:words.map(w=>w.id),viewState:{...view,pageSize:10},studiedIds:['2'],checkedIds:['2'],finalizedIds:['2'],pendingId:null};
  const state={'2':{...C.defaultState(),studyCount:1,correctCount:1,recentResults:[true],currentStreak:1}};
  const result=prepareIntegration({version:1,sessionId:'s',results:[{id:'2',result:'wrong'}]},
    {sessions:{s:record},registeredIds:[],knownIds:words.map(w=>w.id),words,state,activeSession:active,currentView:view,pageSize:10,randomIds:[],now:'2026-10-12T00:00:00.000Z'});
  assert.deepEqual(result.ignoredOverlapIds,[]);assert.deepEqual(result.provisionalIds,[]);assert.equal(result.formalApplied,1);
  assert.equal(result.state['2'].studyCount,2);assert.deepEqual(result.state['2'].recentResults,[true,false]);assert.equal(result.state['2'].currentStreak,0);
});

test('random GPT integration crosses fixed page boundaries and preserves skipped or missing outcomes',()=>{
  const words=Array.from({length:25},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const randomIds=['4','2','1',...words.map(w=>w.id).filter(id=>!['4','2','1'].includes(id))],ids=randomIds.slice(8,16);
  const context=C.createGptIssueContext(words,{sortMode:'random',randomIds,startId:ids[0],pageSize:10,ids}),record={createdAt:'t',ids,context};
  const view={filter:'all',sortMode:'random',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const result=prepareIntegration({version:1,sessionId:'r',results:[{id:ids[7],result:'wrong'},{id:ids[2],result:'skipped'},{id:ids[0],result:'correct'}]},
    {sessions:{r:record},registeredIds:[],knownIds:words.map(w=>w.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds,
      studyProgress:C.recordStudyDisclosure({},words,'random',randomIds,randomIds[7]),now:'2026-10-12T00:00:00.000Z'});
  assert.equal(result.transition.kind,'jump');assert.equal(result.transition.view.sortMode,'random');assert.equal(result.transition.view.randomStart,10);
  assert.deepEqual(result.provisionalIds,ids.slice(2,8).filter(id=>id===ids[7]));
  assert.deepEqual(result.activeSession.studiedIds,[ids[7]]);assert.deepEqual(result.activeSession.checkedIds,[]);
  assert.equal(result.state[ids[0]].correctCount,1);assert.equal(result.state[ids[0]].studyCount,1);
  assert.equal(result.state[ids[2]],undefined);
});

test('GPT jump uses displayed page positions rather than study-progress continuity',()=>{
  const words=Array.from({length:70},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const progress=C.recordStudyDisclosure({},words,'normal',[],'35');
  const ids=words.slice(35,50).map(word=>word.id),context=C.createGptIssueContext(words,{startId:ids[0],pageSize:50,ids});
  const record={createdAt:'t',ids,context},results=[...ids].reverse().map(id=>({id,result:id==='50'?'skipped':'wrong'}));
  const contiguous=prepareIntegration({version:1,sessionId:'contiguous',results},
    {sessions:{contiguous:record},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,currentView:view,pageSize:50,randomIds:[],studyProgress:progress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(contiguous.jump.canJump,true);assert.equal(contiguous.jump.firstResultId,'36');assert.equal(contiguous.jump.lastResultId,'50');
  assert.equal(contiguous.activeSession.gptRevealTargetId,'50');assert.equal(contiguous.studyProgress.normal.id,'50');
  assert.equal(contiguous.state['50'],undefined);assert.deepEqual(contiguous.gptSkipped.ids,['50']);

  const gapIds=words.slice(39,50).map(word=>word.id),gapContext=C.createGptIssueContext(words,{startId:gapIds[0],pageSize:50,ids:gapIds});
  const gapRecord={createdAt:'t',ids:gapIds,context:gapContext},gapResults=gapIds.map(id=>({id,result:'wrong'}));
  const active={sessionId:'app',key:C.studySessionKey(view,50),updatedAt:9,revealY:321,targetIds:words.slice(0,50).map(word=>word.id),
    viewState:{...view,pageSize:50},studiedIds:['35'],checkedIds:[],finalizedIds:[],pendingId:null};
  const suppressed=prepareIntegration({version:1,sessionId:'gap',results:gapResults},
    {sessions:{gap:gapRecord},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:active,currentView:view,pageSize:50,randomIds:[],studyProgress:progress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(suppressed.jump.canJump,true);assert.equal(suppressed.jump.reason,'start-undisclosed-confirmation-required');
  assert.equal(suppressed.jump.firstResultPosition,39);assert.equal(suppressed.jump.needsStartConfirmation,true);
  assert.equal(suppressed.transition.kind,'stay');assert.equal(suppressed.studyProgress.normal.id,'50');
  assert.equal(suppressed.activeSession.revealY,321);assert.deepEqual(suppressed.activeSession.studiedIds,['35','40','41','42','43','44','45','46','47','48','49','50']);
  assert.equal(C.sessionFurthestProgressId(suppressed.activeSession),'50');
  const suppressedStore=memoryStorage();
  C.saveCore(suppressedStore,'ledger',suppressed);
  const restoredSuppressedSession=C.loadCore(suppressedStore,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'}).activeSession;
  assert.equal(C.sessionFurthestProgressId(restoredSuppressedSession),'50');
  assert.equal(restoredSuppressedSession.gptRevealTargetId,'50');
  assert.equal(suppressed.formalApplied,0);assert.equal(suppressed.provisionalIds.length,11);assert.equal(suppressed.state['40'].studyCount,1);

  const earlierIds=words.slice(19,40).map(word=>word.id),earlierContext=C.createGptIssueContext(words,{startId:earlierIds[0],pageSize:50,ids:earlierIds});
  const earlier=prepareIntegration({version:1,sessionId:'overlap',results:[...earlierIds].reverse().map(id=>({id,result:'wrong'}))},
    {sessions:{overlap:{ids:earlierIds,context:earlierContext}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,
      currentView:view,pageSize:50,randomIds:[],studyProgress:progress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(earlier.jump.canJump,true);assert.equal(earlier.jump.firstResultId,'20');assert.equal(earlier.jump.lastResultId,'40');
  assert.equal(earlier.studyProgress.normal.id,'40');

  const skippedOnly=prepareIntegration({version:1,sessionId:'gap-skipped',results:[{id:'40',result:'skipped'}]},
    {sessions:{'gap-skipped':{ids:gapIds,context:gapContext}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:active,
      currentView:view,pageSize:50,randomIds:[],studyProgress:progress,gptSkipped:null,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(skippedOnly.jump.canJump,true);assert.equal(skippedOnly.jump.needsStartConfirmation,true);
  assert.deepEqual(skippedOnly.gptSkipped.ids,['40']);assert.equal(skippedOnly.state['40'],undefined);assert.equal(skippedOnly.studyProgress.normal.id,'40');
});

test('GPT result positions include skipped outcomes and gaps without disclosing missing IDs',()=>{
  const words=Array.from({length:70},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const progress=C.recordStudyDisclosure({},words,'normal',[],'35');
  const ids=['36','37','38','39','40'],context=C.createGptIssueContext(words,{startId:'36',pageSize:50,ids});
  const partial=prepareIntegration({version:1,sessionId:'partial',results:[{id:'40',result:'wrong'},{id:'38',result:'skipped'},{id:'36',result:'correct'}]},
    {sessions:{partial:{ids,context}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,currentView:view,pageSize:50,randomIds:[],studyProgress:progress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(partial.jump.canJump,true);assert.equal(partial.jump.firstResultId,'36');assert.equal(partial.jump.lastResultId,'40');
  assert.deepEqual(partial.gptSkipped.ids,['38']);assert.equal(partial.state['37'],undefined);assert.equal(partial.state['39'],undefined);

  const spanningIds=words.slice(35,60).map(word=>word.id),spanningContext=C.createGptIssueContext(words,{startId:spanningIds[0],pageSize:50,ids:spanningIds});
  const spanning=prepareIntegration({version:1,sessionId:'spanning',results:spanningIds.map(id=>({id,result:'wrong'}))},
    {sessions:{spanning:{ids:spanningIds,context:spanningContext}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,currentView:view,pageSize:50,randomIds:[],studyProgress:progress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(spanning.jump.canJump,true);assert.equal(spanning.jump.lastResultId,'60');assert.equal(spanning.transition.view.pageIndex,1);

  const gapSpanIds=words.slice(40,60).map(word=>word.id),gapSpanContext=C.createGptIssueContext(words,{startId:gapSpanIds[0],pageSize:50,ids:gapSpanIds});
  const gapSpan=prepareIntegration({version:1,sessionId:'gap-span',results:gapSpanIds.map(id=>({id,result:'wrong'}))},
    {sessions:{'gap-span':{ids:gapSpanIds,context:gapSpanContext}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,
      currentView:view,pageSize:50,randomIds:[],studyProgress:progress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(gapSpan.jump.canJump,true);assert.equal(gapSpan.jump.reason,'start-undisclosed-confirmation-required');assert.equal(gapSpan.transition.kind,'jump');
  assert.equal(gapSpan.studyProgress.normal.id,'60');assert.equal(gapSpan.state['41'].studyCount,1);
});

test('GPT jump handles absent or invalid progress from the displayed page and actual random order',()=>{
  const words=Array.from({length:25},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const ids=['2','3'],context=C.createGptIssueContext(words,{startId:'2',pageSize:10,ids});
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const missingCursor=prepareIntegration({version:1,sessionId:'late-start',results:[{id:'2',result:'wrong'}]},
    {sessions:{'late-start':{ids,context}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds:[],studyProgress:{},now:'2026-10-12T00:00:00.000Z'});
  assert.equal(missingCursor.jump.canJump,true);assert.equal(missingCursor.jump.needsStartConfirmation,true);
  assert.equal(missingCursor.state['2'].studyCount,1);assert.deepEqual(missingCursor.state['2'].recentResults,[]);

  const randomIds=['9','3','20',...words.map(word=>word.id).filter(id=>!['9','3','20'].includes(id))],randomWords=randomIds.slice(5,8);
  const randomContext=C.createGptIssueContext(words,{sortMode:'random',randomIds,startId:randomWords[0],pageSize:10,ids:randomWords});
  const randomView={...view,sortMode:'random'},randomProgress=C.recordStudyDisclosure({},words,'random',randomIds,randomIds[4]);
  const random=prepareIntegration({version:1,sessionId:'random-gap',results:[{id:randomWords[2],result:'skipped'},{id:randomWords[0],result:'wrong'}]},
    {sessions:{'random-gap':{ids:randomWords,context:randomContext}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,
      currentView:randomView,pageSize:10,randomIds,studyProgress:randomProgress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(random.jump.canJump,true);assert.equal(random.jump.firstResultId,randomWords[0]);assert.equal(random.jump.lastResultId,randomWords[2]);
  assert.equal(random.studyProgress.random.id,randomWords[2]);assert.equal(random.studyProgress.normal,null);
  const invalidProgress={normal:{...C.recordStudyDisclosure({},words,'normal',[],'1').normal,id:'999'}};
  const invalidCursor=prepareIntegration({version:1,sessionId:'invalid-cursor',results:[{id:'2',result:'wrong'}]},
    {sessions:{'invalid-cursor':{ids,context}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,
      currentView:view,pageSize:10,randomIds:[],studyProgress:invalidProgress,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(invalidCursor.jump.canJump,true);assert.equal(invalidCursor.jump.needsStartConfirmation,true);
});

test('GPT integration formally records results when a reshuffle makes the saved jump position unsafe',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),issuedOrder=words.map(w=>w.id),ids=['11','12'];
  const context=C.createGptIssueContext(words,{sortMode:'random',randomIds:issuedOrder,startId:'11',pageSize:10,ids}),record={createdAt:'t',ids,context};
  const currentOrder=[...issuedOrder].reverse(),view={filter:'all',sortMode:'random',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,10),updatedAt:1,revealY:9,targetIds:currentOrder.slice(0,10),viewState:{...view,pageSize:10},studiedIds:['20'],checkedIds:['20'],finalizedIds:[],pendingId:null};
  const state={'20':{...C.defaultState(),studyCount:1}};
  const result=prepareIntegration({version:1,sessionId:'s',results:[{id:'11',result:'wrong'}]},
    {sessions:{s:record},registeredIds:[],knownIds:words.map(w=>w.id),words,state,activeSession:active,currentView:view,pageSize:10,randomIds:currentOrder,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(result.jump.canJump,false);assert.equal(result.jump.reason,'order-changed');assert.equal(result.transition.kind,'stay');
  assert.equal(result.formalApplied,1);assert.deepEqual(result.provisionalIds,[]);assert.deepEqual(result.state['11'].recentResults,[false]);
  assert.deepEqual(result.activeSession,{...active,preserveTargetIds:true});assert.deepEqual(result.state['20'].recentResults,[]);
});

test('GPT integration keeps active session on no-jump, legacy, zero, skipped-only, and all-overlap outcomes',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,10),updatedAt:1,revealY:12,targetIds:words.slice(0,10).map(w=>w.id),viewState:{...view,pageSize:10},studiedIds:['1'],checkedIds:['1'],finalizedIds:[],pendingId:null};
  const state={'1':{...C.defaultState(),studyCount:1}};
  const cases=[
    {record:{ids:['1','2']},results:[{id:'1',result:'wrong'},{id:'2',result:'correct'}],expectedApplied:1,reason:'legacy-no-context'},
    {record:{ids:['1','2'],context:null},results:[{id:'2',result:'correct'}],expectedApplied:1,reason:'invalid-context'},
    {record:{ids:['1','2']},results:[],expectedApplied:0,reason:'legacy-no-context'},
    {record:{ids:['1','2']},results:[{id:'2',result:'skipped'}],expectedApplied:0,reason:'legacy-no-context'},
    {record:{ids:['1']},results:[{id:'1',result:'wrong'}],expectedApplied:0,reason:'legacy-no-context'}
  ];
  for(let i=0;i<cases.length;i++) {
    const {record,results,expectedApplied,reason}=cases[i],sessionId=`s${i}`,sessions={[sessionId]:record};
    const result=prepareIntegration({version:1,sessionId,results},{sessions,registeredIds:[],knownIds:words.map(w=>w.id),words,state,activeSession:active,currentView:view,pageSize:10,randomIds:[],now:'2026-10-12T00:00:00.000Z'});
    assert.equal(result.applied,expectedApplied);assert.equal(result.jump.reason,reason);assert.equal(result.transition.kind,'stay');
    assert.deepEqual(result.activeSession,expectedApplied?{...active,preserveTargetIds:true}:active);assert.deepEqual(result.registeredGptSessionIds,[sessionId]);
  }
});

test('GPT replay is formal-only and preserves the current unconfirmed study session',()=>{
  const words=Array.from({length:10},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,10),updatedAt:1,revealY:0,targetIds:words.map(w=>w.id),viewState:{...view,pageSize:10},studiedIds:['1'],checkedIds:[],finalizedIds:[],pendingId:null};
  const result=prepareIntegration({version:1,sessionId:'done',results:[{id:'2',result:'correct'}]},
    {sessions:{},registeredIds:['done'],knownIds:words.map(w=>w.id),words,state:{'1':{...C.defaultState(),studyCount:1}},activeSession:active,currentView:view,pageSize:10,randomIds:[],now:'2026-10-12T00:00:00.000Z'});
  assert.equal(result.isReplay,true);assert.equal(result.mode,'formal-replay');assert.equal(result.jump.canJump,false);assert.deepEqual(result.provisionalIds,[]);
  assert.equal(result.state['2'].recentResults.at(-1),true);assert.deepEqual(result.activeSession.studiedIds,['1']);assert.deepEqual(result.activeSession.finalizedIds,[]);
  assert.equal(result.activeSession.preserveTargetIds,true);
});

test('GPT integration draft is immutable and failed persistence leaves stored state intact',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),ids=['11'];
  const context=C.createGptIssueContext(words,{startId:'11',pageSize:10,ids}),record={createdAt:'t',ids,context},sessions={s:record},state={},view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,10),updatedAt:1,revealY:0,targetIds:words.slice(0,10).map(w=>w.id),viewState:{...view,pageSize:10},studiedIds:['1'],checkedIds:[],finalizedIds:[],pendingId:null};
  const before=JSON.stringify({sessions,state,active});
  const draft=prepareIntegration({version:1,sessionId:'s',results:[{id:'11',result:'correct'}]},
    {sessions,registeredIds:[],knownIds:words.map(w=>w.id),words,state,activeSession:active,currentView:view,pageSize:10,randomIds:[],now:'2026-10-12T00:00:00.000Z'});
  assert.equal(JSON.stringify({sessions,state,active}),before);
  const store=memoryStorage({ledger:JSON.stringify({state,gptSessions:sessions,registeredGptSessionIds:[],activeSession:active})}),broken={...store,setItem(){throw new Error('quota/write failure')}};
  assert.throws(()=>C.saveCoreTransition(broken,'ledger',{state:draft.state,gptSessions:draft.gptSessions,registeredGptSessionIds:draft.registeredGptSessionIds,activeSession:draft.activeSession},[]),/quota\/write failure/);
  const persisted=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(persisted.state,state);assert.deepEqual(persisted.gptSessions,sessions);assert.deepEqual(persisted.activeSession,active);
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

test('advanceStudyProgress moves to GPT reach without moving a valid cursor backward',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),randomIds=[...words].reverse().map(word=>word.id);
  let progress=C.recordStudyDisclosure({},words,'normal',randomIds,'15');
  progress=C.recordStudyDisclosure(progress,words,'random',randomIds,'4');
  const earlier=C.advanceStudyProgress(progress,words,'normal',randomIds,'8');
  assert.equal(earlier.normal.id,'15');assert.equal(earlier.random.id,'4');
  const later=C.advanceStudyProgress(progress,words,'normal',randomIds,'18');
  assert.equal(later.normal.id,'18');assert.equal(later.random.id,'4');
});

test('GPT integration advances to furthest returned skipped result while masking missing and skipped rows',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),ids=['1','2','3','4','5','6'];
  const context=C.createGptIssueContext(words,{startId:'1',pageSize:10,ids}),record={createdAt:'t',ids,context};
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const result=prepareIntegration({version:1,sessionId:'s',results:[{id:'1',result:'correct'},{id:'4',result:'skipped'},{id:'5',result:'wrong'}]},
    {sessions:{s:record},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds:[],studyProgress:{},gptSkipped:null,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(result.jump.lastResultId,'5');assert.equal(result.activeSession.gptRevealTargetId,'5');
  assert.deepEqual(result.activeSession.studiedIds,['1','5']);assert.deepEqual(result.gptSkipped.ids,['4']);
  assert.equal(result.gptSkipped.ids.includes('3'),false);assert.equal(result.gptSkipped.ids.includes('6'),false);
  assert.equal(result.state['4'],undefined);assert.equal(result.state['3'],undefined);
  assert.equal(result.state['1'].studyCount,1);assert.equal(result.state['5'].studyCount,1);
  assert.equal(result.studyProgress.normal.id,'5');
});

test('GPT result beginning after the displayed page registers without moving the cover',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),ids=['11','12'];
  const context=C.createGptIssueContext(words,{startId:'11',pageSize:10,ids}),record={createdAt:'t',ids,context};
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const result=prepareIntegration({version:1,sessionId:'skip-only',results:[{id:'11',result:'skipped'}]},
    {sessions:{'skip-only':record},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds:[],
      studyProgress:C.recordStudyDisclosure({},words,'normal',[],'10'),gptSkipped:null,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(result.transition.kind,'stay');assert.equal(result.jump.reason,'first-after-current-page');
  assert.equal(result.activeSession,null);
  assert.equal(result.state['11'],undefined);assert.deepEqual(result.gptSkipped.ids,[],'GPT skipped rows outside the current displayed target are not recorded');assert.equal(result.studyProgress.normal.id,'10');
});
test('GPT skipped is limited to the current displayed target while formal outcomes still apply outside it',()=>{
  const words=Array.from({length:30},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),ids=['11','12'];
  const context=C.createGptIssueContext(words,{startId:'11',pageSize:10,ids}),record={createdAt:'t',ids,context};
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const result=prepareIntegration({version:1,sessionId:'late-range',results:[{id:'11',result:'skipped'},{id:'12',result:'wrong'}]},
    {sessions:{'late-range':record},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds:[],studyProgress:{},gptSkipped:null,now:'2026-10-12T00:00:00.000Z'});
  assert.deepEqual(result.gptSkipped.ids,[]);assert.equal(result.state['11'],undefined);
  assert.equal(result.state['12'].studyCount,1);assert.deepEqual(result.state['12'].recentResults,[false]);
  assert.equal(result.formalApplied,1,'non-skipped outcomes retain existing out-of-range history behavior');
});

test('GPT result for an already disclosed active row preserves its session state and does not overwrite it',()=>{
  const words=Array.from({length:10},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),ids=['2'];
  const context=C.createGptIssueContext(words,{startId:'2',pageSize:10,ids}),record={createdAt:'t',ids,context};
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,10),updatedAt:1,revealY:34,targetIds:words.map(word=>word.id),viewState:{...view,pageSize:10},studiedIds:['2'],checkedIds:['2'],finalizedIds:[],pendingId:'2'};
  const state={'2':{...C.defaultState(),studyCount:1}};
  const result=prepareIntegration({version:1,sessionId:'s',results:[{id:'2',result:'skipped'}]},
    {sessions:{s:record},registeredIds:[],knownIds:words.map(word=>word.id),words,state,activeSession:active,currentView:view,pageSize:10,randomIds:[],gptSkipped:C.setGptSkippedState(null,words,'2'),studyProgress:{},now:'2026-10-12T00:00:00.000Z'});
  assert.deepEqual(result.activeSession.studiedIds,['2']);assert.deepEqual(result.activeSession.checkedIds,['2']);
  assert.deepEqual(result.gptSkipped.ids,[]);assert.equal(result.state['2'].studyCount,1);
  assert.deepEqual(result.ignoredOverlapIds,[]);assert.equal(result.jump.canJump,false);
});

test('last disclosure tracks the latest newly opened position independently for normal and random order',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),randomIds=[...words].reverse().map(word=>word.id);
  let progress=C.normalizeStudyProgress();
  progress=C.recordStudyDisclosure(progress,words,'normal',randomIds,'18');
  progress=C.recordStudyDisclosure(progress,words,'random',randomIds,'4');
  progress=C.recordStudyDisclosure(progress,words,'normal',randomIds,'3');
  assert.equal(progress.normal.id,'3');assert.equal(progress.random.id,'4');
  assert.equal(progress.normal.orderFingerprint,C.studyOrderIdentity(words,'normal',randomIds).orderFingerprint);
  const reshuffled=[...randomIds].reverse(),afterShuffle=C.recordStudyDisclosure({...progress,random:null},words,'random',reshuffled,'4');
  assert.notEqual(afterShuffle.random.orderFingerprint,progress.random.orderFingerprint);
  assert.equal(C.recordStudyDisclosure(progress,words,'random',['1'],'4').random,null);
});

test('last disclosure progress survives core persistence while legacy snapshots remain readable',()=>{
  const words=Array.from({length:10},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const progress=C.recordStudyDisclosure({},words,'normal',[],'7'),store=memoryStorage();
  C.saveCore(store,'ledger',{state:{},gptSessions:{},registeredGptSessionIds:[],activeSession:null,studyProgress:progress});
  const restored=C.loadCore(store,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.deepEqual(restored.studyProgress,progress);
  assert.deepEqual(C.resolveGptContinuationStart(words,restored.studyProgress,{sortMode:'normal',fallbackStartId:'1'}),{startId:'8',source:'continuation',reason:'ok'});
  const legacy=memoryStorage({ledger:JSON.stringify({state:{},gptSessions:{},registeredGptSessionIds:[],activeSession:null})});
  assert.equal(Object.hasOwn(C.loadCore(legacy,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'}),'studyProgress'),false);
});

test('GPT progress comparison uses the matching issued order and rejects stale identity',()=>{
  const words=Array.from({length:30},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),randomIds=[...words].reverse().map(word=>word.id);
  const ids=words.slice(10,13).map(word=>word.id),context=C.createGptIssueContext(words,{sortMode:'normal',startId:ids[0],pageSize:10,ids}),record={ids,context};
  const progress=C.recordStudyDisclosure({},words,'normal',randomIds,'20');
  assert.equal(C.compareStudyProgress(progress,words,'normal',randomIds,record,'12').relation,'ahead');
  progress.normal=C.recordStudyDisclosure(progress,words,'normal',randomIds,'12').normal;
  assert.equal(C.compareStudyProgress(progress,words,'normal',randomIds,record,'12').relation,'same');
  assert.equal(C.compareStudyProgress(progress,words,'random',randomIds,record,'12').relation,'unknown');
  assert.equal(C.compareStudyProgress(progress,words.slice(1),'normal',randomIds,record,'12').relation,'unknown');
});

test('preserved current target page survives mastery changes only while dataset and fixed range match',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),view={sortMode:'normal',pageIndex:0,randomStart:0},identity=C.studyOrderIdentity(words,'normal',[]);
  const pinned=C.preservedTargetPage(words,[],view,10,['1','2','3'],identity);
  assert.deepEqual(pinned.ids,['1','2','3']);assert.deepEqual(pinned.entries.map(word=>word.displayNumber),[1,2,3]);
  assert.equal(C.preservedTargetPage(words.map(word=>({...word,answer:`changed ${word.answer}`})),[],view,10,['1','2','3'],identity),null);
  assert.equal(C.preservedTargetPage(words,[],{...view,pageIndex:1},10,['1','2','3'],identity),null);
});

test('formal-only GPT import preserves pending answers and pins the current page when mastery changes',()=>{
  const words=Array.from({length:20},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`})),ids=['12','13'];
  const context=C.createGptIssueContext(words,{startId:'12',pageSize:10,excludeStreak:true,masteryThreshold:2,ids}),record={ids,context};
  const view={filter:'all',sortMode:'normal',excludeStreak:true,masteryThreshold:2,pageIndex:1,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,10),updatedAt:10,revealY:32,targetIds:words.slice(10,20).map(word=>word.id),viewState:{...view,pageSize:10},studiedIds:['12'],checkedIds:[],finalizedIds:[],pendingId:'12'};
  const state={'12':{...C.defaultState(),studyCount:1},'13':{...C.defaultState(),studyCount:1,correctCount:1,currentStreak:1,recentResults:[true]}};
  const result=prepareIntegration({version:1,sessionId:'s',results:[{id:'12',result:'correct'},{id:'13',result:'correct'}]},
    {sessions:{s:record},registeredIds:[],knownIds:words.map(word=>word.id),words,state,activeSession:active,currentView:view,pageSize:10,randomIds:[],forceFormalOnly:'study-already-ahead',now:'2026-10-12T00:00:00.000Z'});
  assert.deepEqual(result.ignoredOverlapIds,['12']);assert.deepEqual(result.activeSession.checkedIds,[]);assert.deepEqual(result.activeSession.studiedIds,['12']);
  assert.equal(result.state['12'].studyCount,1);assert.equal(result.state['13'].currentStreak,2);assert.deepEqual(result.activeSession.targetIds,words.slice(10,20).map(word=>word.id));
  assert.equal(result.activeSession.preserveTargetIds,true);
  const identity=C.studyOrderIdentity(words,'normal',[]),pinned=C.preservedTargetPage(words,[],view,10,result.activeSession.targetIds,identity);
  assert.deepEqual(pinned.ids,active.targetIds);
  const restored=C.tryRestoreSession({...result.activeSession,preservedTargetIdentity:identity},{currentKey:active.key,currentPageIds:pinned.ids});
  assert.ok(restored);assert.deepEqual(C.finalizeSessionDraft(result.state,restored).state['12'].recentResults,[false]);
});

test('GPT registration UI uses the integration draft and commits view only after approved jump',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/StudyCore\.prepareGptIntegration\(obj/);
  assert.match(html,/latestIssueSequence:gptIssueSequence/);
  assert.doesNotMatch(html,/StudyCore\.compareStudyProgress\(/);
  assert.match(html,/saveCoreTransition\(localStorage,STORAGE_LEDGER,\{state:draft\.state/);
  assert.doesNotMatch(html,/prepareGptImport\(obj,gptSessions/);
  assert.match(html,/if\(!confirm\(prompt\)\)draft=prepare\(\{forceFormalOnly:"user-declined-jump"\}\)/);
  assert.match(html,/GPT結果の末尾まで解答カバーを移動しますか/);
  assert.match(html,/if\(didJump&&curtainLocked\)\{releaseCurtainLock\(\)\}/);
  assert.match(html,/curtainLocked&&draft\.samePage&&!draft\.jump\?\.canJump&&draft\.activeSession\?\.gptRevealTargetId/);
  assert.match(html,/resultStatus\.dataset\.reasonCode=notice\.reasonCode/);
});

test('GPT issue sequence persists independently of pending records and rejects older or legacy sessions for jumps',()=>{
  const words=Array.from({length:30},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const oldIds=['1','2'],latestIds=['1','2'],oldContext=C.createGptIssueContext(words,{startId:'1',pageSize:10,ids:oldIds}),latestContext=C.createGptIssueContext(words,{startId:'1',pageSize:10,ids:latestIds});
  const storage=memoryStorage();
  C.saveCore(storage,'ledger',{state:{},activeSession:null,gptSessions:{old:{ids:oldIds,context:oldContext,issueSequence:1},latest:{ids:latestIds,context:latestContext,issueSequence:3}},registeredGptSessionIds:['between'],gptIssueSequence:3});
  const loaded=C.loadCore(storage,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.equal(loaded.gptIssueSequence,3);assert.equal(loaded.gptSessions.old.issueSequence,1);assert.deepEqual(loaded.registeredGptSessionIds,['between']);
  const result=(sessionId,record,otherRecords={})=>C.prepareGptIntegration({version:1,sessionId,results:[{id:'1',result:'correct'}]},
    {sessions:{...otherRecords,[sessionId]:record},registeredIds:[],knownIds:words.map(w=>w.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds:[],latestIssueSequence:3,now:'2026-10-12T00:00:00.000Z'});
  const older=result('old',loaded.gptSessions.old,{latest:loaded.gptSessions.latest});assert.equal(older.jump.reason,'older-issue');assert.equal(older.jump.canJump,false);assert.equal(older.formalApplied,1);
  assert.equal(result('latest',loaded.gptSessions.latest,{old:loaded.gptSessions.old}).jump.canJump,true);
  C.saveCore(storage,'ledger',{...loaded,gptSessions:{old:loaded.gptSessions.old},gptIssueSequence:3});
  const afterRegisteredRemoval=C.loadCore(storage,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.equal(afterRegisteredRemoval.gptIssueSequence,3);
  const onlyPendingAfterLatestRegistration=result('old',afterRegisteredRemoval.gptSessions.old);
  assert.equal(onlyPendingAfterLatestRegistration.jump.canJump,false);
  assert.equal(onlyPendingAfterLatestRegistration.jump.reason,'older-issue');
  const duplicateSequence=C.prepareGptIntegration({version:1,sessionId:'latest',results:[{id:'1',result:'correct'}]},
    {sessions:{latest:{ids:latestIds,context:latestContext,issueSequence:3},duplicate:{ids:latestIds,context:latestContext,issueSequence:3}},registeredIds:[],knownIds:words.map(w=>w.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds:[],latestIssueSequence:3,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(duplicateSequence.jump.reason,'ambiguous-issue-order');assert.equal(duplicateSequence.formalApplied,1);
  const legacy=C.prepareGptIntegration({version:1,sessionId:'legacy',results:[{id:'1',result:'correct'}]},
    {sessions:{legacy:{ids:oldIds,context:oldContext}},registeredIds:[],knownIds:words.map(w=>w.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds:[],now:'2026-10-12T00:00:00.000Z'});
  assert.equal(legacy.jump.reason,'missing-issue-order');assert.equal(legacy.applied,1);
  const upgradedLegacy=C.prepareGptIntegration({version:1,sessionId:'new',results:[{id:'1',result:'correct'}]},
    {sessions:{old:{ids:oldIds,context:oldContext,issueSequence:0},new:{ids:latestIds,context:latestContext,issueSequence:1}},registeredIds:[],knownIds:words.map(w=>w.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds:[],latestIssueSequence:1,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(upgradedLegacy.jump.canJump,true,'a newly issued, sequenced session is newer than migrated legacy pending records');
});

test('only the last issued GPT session can jump after a newer session has been registered and removed',()=>{
  const words=Array.from({length:30},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:0,randomStart:0};
  const ids=['1','2'],context=C.createGptIssueContext(words,{startId:'1',pageSize:10,ids});
  const A={ids,context,issueSequence:1},B={ids,context,issueSequence:2};
  const storage=memoryStorage();
  C.saveCore(storage,'ledger',{state:{},activeSession:null,gptSessions:{A,B},registeredGptSessionIds:[],gptIssueSequence:2});
  const args={knownIds:words.map(word=>word.id),words,state:{},activeSession:null,currentView:view,pageSize:10,randomIds:[],studyProgress:{},gptSkipped:null,latestIssueSequence:2,now:'2026-10-12T00:00:00.000Z'};
  const Bdraft=C.prepareGptIntegration({version:1,sessionId:'B',results:[{id:'1',result:'correct'}]},
    {...args,sessions:{A,B},registeredIds:[]});
  assert.equal(Bdraft.jump.canJump,true,'B is the last issued session and remains eligible to jump');
  assert.equal(Bdraft.formalApplied+Bdraft.provisionalIds.length,1);
  C.saveCore(storage,'ledger',{state:Bdraft.state,activeSession:Bdraft.activeSession,gptSessions:Bdraft.gptSessions,
    registeredGptSessionIds:Bdraft.registeredGptSessionIds,gptSkipped:Bdraft.gptSkipped,studyProgress:Bdraft.studyProgress});

  const afterB=C.loadCore(storage,'ledger',{stateKey:'state',gptSessionsKey:'gpt',activeSessionKey:'active'});
  assert.equal(afterB.gptIssueSequence,2,'the global issuance high-water mark survives B record removal');
  assert.deepEqual(Object.keys(afterB.gptSessions),['A']);
  assert.deepEqual(afterB.registeredGptSessionIds,['B']);
  const Adraft=C.prepareGptIntegration({version:1,sessionId:'A',results:[{id:'2',result:'wrong'}]},
    {...args,sessions:afterB.gptSessions,registeredIds:afterB.registeredGptSessionIds,latestIssueSequence:afterB.gptIssueSequence});
  assert.equal(Adraft.formalApplied,1,'A result is still registered');
  assert.equal(Adraft.jump.canJump,false);
  assert.equal(Adraft.jump.reason,'older-issue');
  assert.deepEqual(Adraft.registeredGptSessionIds,['B','A']);
  assert.equal(Adraft.activeSession?.gptRevealTargetId,undefined,'A does not move the active reveal target');
});

test('GPT result page-position classifier covers first and last position rules',()=>{
  const words=Array.from({length:100},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const view={...jumpView({sortMode:'normal',pageIndex:1},20,[]),disclosedIds:['25','26','27','28','29','30','31','32','33','34','35','36','37','38','39','40']};
  const run=(ids,disclosed=view.disclosedIds)=>{
    const context=C.createGptIssueContext(words,{startId:ids[0],pageSize:20,ids}),record={ids,context};
    return C.evaluateGptJump(record,words,{...view,disclosedIds:disclosed},ids.map(id=>({id,result:'correct'})),{});
  };
  assert.equal(run(['25','26','61']).canJump,true); // First is current and disclosed; end is after.
  const undisclosed=run(['26','27','61'],[]);assert.equal(undisclosed.canJump,true);assert.equal(undisclosed.needsStartConfirmation,true);
  assert.equal(run(['10','25','61']).canJump,true); // First is before the page.
  assert.equal(run(['41','61']).reason,'first-after-current-page');
  assert.equal(run(['10','20']).reason,'last-before-current-page');
  assert.equal(run(['10','25']).reason,'last-already-disclosed');
  assert.equal(run(['10','40'],[]).canJump,true); // End is current page, undisclosed.
});

test('21–25 disclosed, finalization resets the cover, and latest GPT results 26–70 can reach 70',()=>{
  const words=Array.from({length:120},(_,i)=>({id:String(i+1),question:`w${i+1}`,answer:`m${i+1}`}));
  const ids=words.slice(25,70).map(word=>word.id),context=C.createGptIssueContext(words,{startId:'26',pageSize:20,ids});
  const view={filter:'all',sortMode:'normal',excludeStreak:false,masteryThreshold:3,pageIndex:1,randomStart:0};
  const active={sessionId:'app',key:C.studySessionKey(view,20),updatedAt:4,revealY:0,targetIds:words.slice(20,40).map(word=>word.id),viewState:{...view,pageSize:20},studiedIds:[],checkedIds:[],finalizedIds:[],pendingId:null};
  const results=ids.map(id=>({id,result:['30','44','59'].includes(id)?'skipped':'correct'}));
  const draft=C.prepareGptIntegration({version:1,sessionId:'issue',results},{sessions:{issue:{ids,context,issueSequence:4}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:active,currentView:view,pageSize:20,randomIds:[],studyProgress:C.recordStudyDisclosure({},words,'normal',[],'25'),gptSkipped:null,latestIssueSequence:4,now:'2026-10-12T00:00:00.000Z'});
  assert.equal(draft.applied,42);assert.equal(draft.jump.canJump,true);assert.equal(draft.jump.reason,'start-undisclosed-confirmation-required');
  assert.equal(draft.jump.needsStartConfirmation,true);assert.equal(draft.jump.firstResultId,'26');assert.equal(draft.jump.lastResultId,'70');
  assert.equal(draft.transition.kind,'jump');assert.equal(draft.transition.view.pageIndex,3);assert.equal(draft.activeSession.gptRevealTargetId,'70');
  assert.deepEqual(draft.gptSkipped.ids,['30'],'only the skipped row inside the current 21–40 display target is retained');assert.equal(draft.state['26'].studyCount,1);assert.equal(draft.state['70'].studyCount,1);
  assert.equal(C.gptIntegrationNotice(draft).text,'GPT結果を42件登録しました。解答カバーを70番まで移動しました。');
  const declined=C.prepareGptIntegration({version:1,sessionId:'issue',results},{sessions:{issue:{ids,context,issueSequence:4}},registeredIds:[],knownIds:words.map(word=>word.id),words,state:{},activeSession:active,currentView:view,pageSize:20,randomIds:[],studyProgress:C.recordStudyDisclosure({},words,'normal',[],'25'),gptSkipped:null,latestIssueSequence:4,forceFormalOnly:'user-declined-jump',now:'2026-10-12T00:00:00.000Z'});
  assert.equal(declined.applied,42);assert.equal(declined.jump.reason,'user-declined-jump');assert.equal(declined.transition.kind,'stay');
  assert.equal(declined.activeSession.revealY,0);assert.deepEqual(declined.activeSession.studiedIds,[]);assert.equal(declined.studyProgress.normal.id,'25');
  assert.equal(C.gptIntegrationNotice(declined).text,'GPT結果を42件登録しました。現在の学習位置を維持しました。');
});

test('GPT import reasons are visible and distinguish stale, replay, position, and declined movement',()=>{
  assert.equal(C.gptIntegrationNotice({applied:42,jump:{canJump:false,reason:'older-issue'}}).reasonCode,'older-issue');
  assert.match(C.gptIntegrationNotice({applied:42,jump:{canJump:false,reason:'older-issue'}}).text,/以前に発行したGPT連携結果/);
  assert.equal(C.gptIntegrationNotice({isReplay:true}).reasonCode,'replay');
  assert.match(C.gptIntegrationNotice({applied:42,jump:{canJump:false,reason:'first-after-current-page'}}).text,/開始位置が現在のページより後ろ/);
  assert.match(C.gptIntegrationNotice({applied:42,jump:{canJump:false,reason:'last-already-disclosed'}}).text,/末尾はすでに開示/);
  assert.match(C.gptIntegrationNotice({applied:42,jump:{canJump:false,reason:'user-declined-jump'}}).text,/現在の学習位置を維持/);
  assert.doesNotMatch(C.gptIntegrationNotice({applied:1,jump:{canJump:false,reason:'unknown'}}).text,/カーテン/);
});

test('footer spacer uses normal-flow extent and page-size changes synchronize after curtain controls are positioned',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const spacer=html.match(/function syncStudyFooterSpacer\(\)\{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(spacer,'footer spacer synchronization exists');
  assert.match(spacer,/flowContainer=els\.studyFooterSpacer\.closest\("\.app"\)/);
  assert.match(spacer,/flowBottom=flowContainer\.getBoundingClientRect\(\)\.bottom\+window\.scrollY/);
  assert.match(spacer,/if\(!Number\.isFinite\(flowBottom\)\)return;[\s\S]*?flowMax=Math\.max\(0,flowBottom-innerHeight\)/);
  assert.match(spacer,/currentHeight\+targetMax-flowMax/);
  assert.doesNotMatch(spacer,/currentMax|document\.documentElement\.scrollHeight/,
    'absolute curtain-control overflow is not counted as normal-flow spacer');

  const pageSizeChange=html.match(/function changePageSizePreservingLearningPosition\(nextPageSize\)\{([\s\S]*?)\n  \}\n  function scrollToCurtainResumePosition/)?.[1];
  assert.ok(pageSizeChange,'page-size preserving transition exists');
  assert.match(pageSizeChange,/requestAnimationFrame\(\(\)=>\{positionCurtain\(\);syncStudyFooterSpacer\(\);requestAnimationFrame\(scrollToCurtainResumePosition\)\}\)/,
    'new curtain/control positions are measured before spacer sizing and resume scrolling');
});
