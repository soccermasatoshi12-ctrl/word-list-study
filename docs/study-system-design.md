# 学習システム設計書

## 1. この文書について

本書はWord List Studyの現行構造と動作を説明する設計資料である。記述時点の基準はHEAD `54ad36a6eb2b19858ccc5940268723459ec81b94`（2026-10-19）とする。コード変更後は、関連コードと回帰テストを確認して必要な箇所を更新する。

記述は次のように区別する。

- **現行実装**：コード上で確認できる状態・処理・画面動作。
- **テストで確認された契約**：自動テストが期待値として固定している動作。ブラウザ・端末での表示品質まで保証する意味ではない。
- **意図・仕様判断**：明示された要件や根拠がある場合に限って記載する。コードだけでは理由を確定できない場合は実装動作と分ける。
- **未決事項**：複数の妥当な仕様があり、現行実装だけでは今後の望ましい動作を判断できない点。

この文書は現在の実装を説明し、過去の実装状態や変更希望を履歴として列挙するものではない。問題の可能性がある挙動を記載する場合は、現行動作と懸念・未決判断を明確に分ける。

## 2. 全体構造

### 2.1 問題集、順序、ページ

`words`配列の各要素は文字列`id`、`question`、`answer`、任意の`explanation`を持つ。IDは履歴state、セッション、GPT結果の照合に使う。

- 通常順はCSV順。ページ境界はフィルター適用前の元配列の固定範囲で、フィルター後の表示行数が減っても番号・範囲は詰めない。
- ランダム順は永続化された`randomIds`を使う。ページ境界は固定random順上で先に切り、その後に表示条件を適用する。
- 表示数は10、20、50、100。習得除外を含む表示条件はページ範囲内に適用する。
- `view`には現在の順序・ページ・除外条件が入り、`preferences`には表示数などの設定が入る。学習到達位置は`studyProgress.normal`と`studyProgress.random`に分けて保持する。

### 2.2 処理の概略

```text
CSV / localStorage
  ├─ words, state, preferences, view, random order, screen/title
  └─ studyLedger (activeSession / studyProgress / GPT issue & replay / gptSkipped)
       ├─ 通常学習: カーテン・個別マスク → studiedIds / 暫定評価 / 到達ID
       │             → 遷移時等に確定履歴へ反映
       ├─ 表示数変更: 旧frontier取得 → 現セッション確定 → 新ページ/新session
       │             → ID frontierからカーテン復元・スクロール
       ├─ GPT発行: 順序・開始位置・除外条件 → payload / issue context / issue sequence
       └─ GPT結果: 検証・重複/開示保護 → formal/provisional結果・skipped
                     → 必要な場合のみ確認済みjump → snapshot保存後に画面反映
```

`study-core.js`はDOMに依存しない状態正規化、ページモデル、学習履歴、セッション判定、GPT結果検証・統合などを提供する。`index.html`は画面状態、DOM、ブラウザイベント、localStorage接続、表示とモーダルを管理する。

### 2.3 主な実装箇所

| 対象 | 主な参照 |
|---|---|
| 状態・履歴・保存・CSV/GPTロジック | `study-core.js`: `normalizeState`, `recordStudy`, `finalizeStudySession`, `saveCoreTransition`, `parseWordCsv`, `buildPageModel`, `tryRestoreSession`, `prepareGptIntegration` |
| ページ/表示/学習状態 | `index.html`: `buildTarget`, `transitionView`, `changePageSizePreservingLearningPosition`, `markStudied`, `toggleAnswer`, `render` |
| カーテン・行境界 | `index.html`: `geometry`, `processRevealProgress`, `positionCurtain`, `positionCurtainControls`, `attachCurtainDrag`, `releaseCurtainLock`, `returnToSessionFrontier` |
| フッター余白 | `index.html`: `.study-actions.study-footer`, `#studyFooterSpacer`, `syncStudyFooterSpacer` |
| GPT UI・URL | `index.html`: `makeGptSession`, `applyGptResults`, `receiveGptResultFromUrl`, `removeGptResultParamFromUrl`; `study-core.js`: `makeGptPayload`, `makeGptPrompt`, `makeChatGptUrl` |
| 回帰テスト | `test/study-core.test.js`: display-size/frontier、empty page、curtain lock/unlock、footer spacer、CSV、session restore、GPT integrationなど |

この文書では関数名・状態名を参照単位とし、行番号はコード改訂で変化するため固定しない。

## 3. 学習状態データモデル

### 3.1 問題ごとの確定履歴

`state[id]`は`normalizeState()`で次の形に正規化される。

| フィールド | 意味・更新 |
|---|---|
| `studyCount` | 累積の開示・学習回数。通常学習では新規開示時に増える。GPTの`correct`・`wrong`・`uncertain`は正式履歴または現在ページの暫定登録時に増える。`skipped`と結果なしでは増えない。 |
| `correctCount` | 確定正解数。通常学習の○×確定時、またはGPT正解結果の正式履歴反映時に正解なら増える。 |
| `recentResults` | 確定した正誤の直近最大10件。通常の暫定評価はここへ直ちに追加されない。 |
| `currentStreak` | 末尾連続正解数。正解で増え、誤答で0になる。 |
| `lastStudiedAt` | 通常学習の開示、またはGPTの結果反映時刻。 |

`appendResult()`が履歴と連続正解数を更新する。状態未登録の問題は`defaultState()`から開始する。過去の結果の出所（通常学習かGPTか）はこの状態に保存しない。

### 3.2 現在の通常学習セッション

`activeSession`は`studyLedger`内の現在画面セッションで、ページ／表示対象単位の状態を持つ。

| フィールド | 意味 |
|---|---|
| `sessionId` | セッション識別子。 |
| `key`, `viewState`, `targetIds` | 表示モード・ページ・対象ID列との整合確認に使う。復元時に現在の対象と順序を照合する。 |
| `studiedIds` | このセッションで開示を記録したID。通常ドラッグ、個別開示、GPTジャンプ先ページで暫定反映された結果が含まれる。単なるカーテン通過範囲ではない。 |
| `checkedIds` | 暫定評価が○のID。未登録は暫定×として扱う。 |
| `finalizedIds` | このセッション中に確定済みのID。再確定を防ぐ。 |
| `pendingId` | 最近操作した問題のID。 |
| `revealY` | 現在ページのカーテン先端位置。`geometry()`が作る先頭meaning cell基準の局所座標で保存する。 |
| `furthestProgressId` | active session内の表示順上での到達位置。現在の行を調べる候補の一つ。 |
| `curtainFrontierId`, `curtainFrontierIdentity` | 表示数変更後もカーテンの進行境界をIDで再構成するためのfrontier。identityが現在の単語順と一致する場合にだけ使う。 |
| `gptRevealTargetId` | GPT由来の到達先ID。ページ内寸法が変わっても再計測できるアンカー。GPT jump用で、表示数変更用のcurtain frontierとは別の状態。 |
| `preserveTargetIds`, `preservedTargetIdentity` | GPT結果に伴う結果確定後の対象再評価で、条件が一致する場合に限り現在の対象ID列を一時保持する情報。 |

`revealY`は画面描画に使うページ内pixel値で、永続的な順序位置の代用ではない。表示数変更ではfrontier IDとorder identityから新しいページの境界を測り直す。

`recordStudy()`は`studiedIds`に既にあるIDなら何も加算しない。初回だけ`studyCount`と`lastStudiedAt`を更新してIDを追加する。`defaultAnswer`がcorrectの場合は初期の`checkedIds`にも追加する。

### 3.3 表示位置と進捗カーソル

- `revealY`はactive session内の現在ページの表示座標であり、到達順序を示す永続カーソルではない。
- `studyProgress.normal`と`studyProgress.random`はそれぞれの順序における最後の新規開示・GPT到達IDと、`wordCount`、order/CSV-order/content fingerprintを持つ。
- `recordStudyDisclosure()`は通常の新規開示IDを記録する。`advanceStudyProgress()`はGPT到達用で、有効なカーソルが対象より後ろなら後退させない。
- `gptRevealTargetId`はGPT jump後の現在セッション行境界を再計測するアンカー。`curtainFrontierId`は表示数変更後の境界復元に使うIDであり、`studyProgress`はモード別の到達位置である。3者は値や保存目的を混同しない。
- `resolveDisplayFrontier()`はセッション内の到達IDと有効なcurtain frontierを順序上で比較し、開示先端を選ぶ。先端がないときは変更前ページ先頭をfallbackにする。

### 3.4 GPT状態・順序identity

- `gptSessions[sessionId]`は未登録の発行記録。`ids`は実際に発行した問題IDの順序、`context`は発行時のモード・開始位置・ページサイズ・除外条件・閾値・位置列・fingerprintを保持し、`issueSequence`は発行順を表す。ledgerの`gptIssueSequence`は発行済みの最大連番を保持し、登録済み記録を削除した後も最新発行を識別できる。
- 登録済みsession IDは`registeredGptSessionIds`で追跡され、再登録は確認フローへ進む。
- `gptSkipped`は`{contentFingerprint, ids}`。明示的なskippedだけを記録し、`setGptSkippedState()`でID単位に追加・解除する。
- `studyOrderIdentity()`は順序fingerprint、CSV ID順fingerprint、ID/問題/解答のcontent fingerprint、件数を算出する。`gptSkipped`用content fingerprintは問題の表示順・解説・タイトルを含まないが、問題ID・問題文・解答の変更を検出する。
- `normalizeGptIssueContext()`、`normalizeStudyProgress()`、`normalizeGptSkippedState()`は不正・不整合なidentityを無効扱いにする。古いledgerは任意フィールドがなくても読み込める。

### 3.5 localStorage配置

`index.html`は次のキーを使う。

| キー | 内容 |
|---|---|
| `wordlist.words.v2` | 正規化された問題集。 |
| `wordlist.state.v2` | 旧形式移行用の問題状態。現行snapshotではstateはledgerにも含まれる。 |
| `wordlist.gptSessions.v2` | 旧形式移行用のGPT発行記録。 |
| `wordlist.activeStudySession.v2` | 旧形式移行用のactive session。 |
| `wordlist.studyLedger.v1` | 現行snapshot。state、GPT session records、registered IDs、activeSession、`gptSkipped`、存在する場合の`studyProgress`、GPT発行順の`gptIssueSequence`を格納する。 |
| `wordlist.randomOrder.v1` | 保存されたランダムID順。 |
| `wordlist.view.v1` | 表示モード・ページ・除外などのview。 |
| `wordlist.preferences.v1` | ページサイズ、習得閾値、初期評価、GPT出題数。 |
| `wordlist.gptStartPosition.v1` | GPT出題開始方法（`page`または`continue`）。preferencesとは別に保存。 |
| `wordlist.csvHelpOpen.v1` | CSV形式ヘルプの開閉状態（`open`/`closed`）。 |
| `wordlist.screen.v1` | ホーム／学習画面の復帰先。 |
| `wordlist.listTitle.v1` | ホームに表示する問題集タイトル。 |

`StudyCore.loadCore()`は現行ledgerがない・不完全な場合に旧state/sessionキーを読む。現行の画面更新は`saveCore()`または`saveCoreTransition()`を通じてledgerを保存する。

## 4. 通常学習とカーテン

### 4.1 行、評価ボタン、個別マスク

1行は`.word-row`内に問題・履歴/習得表示・`.answer-toggle`・`.explanation-button`・`.meaning-cell`を持つ。`activeSession.studiedIds`が現在セッションでの開示状態を示し、確定履歴だけでは現在セッションの意味開示状態にならない。

- 未開示時、解答テキストは`is-undisclosed`で隠され、評価ボタンは「－」表示かつdisabled。`toggleAnswer()`も未開示IDなら何もせず、開示・評価・履歴・カーテン位置を変更しない。
- 未開示の`.meaning-cell`をクリックし、`canIndividuallyDisclose()`が許可した場合は、そのIDだけ`markStudied()`で開示する。設定中の`defaultAnswer`を適用し、通常学習の開示として`studyCount`とセッションを更新する。
- 開示後、評価ボタンは○/×を切り替える。○×は`checkedIds`に保持され、通常はsession確定まで正誤履歴へ追加されない。未選択は暫定×として確定される。
- 解説ボタンは解説文があり、かつ開示済みの場合だけ利用できる。ポップアップ表示中の内容は保存しない。
- 各行の履歴表示は5つの等幅スロットで、確定済みの直近結果を右寄せし、空きは未記録記号で埋める。開示中の暫定評価がある場合は確定履歴4件と今回の評価を表示し、`aria-label`で確定履歴と暫定値を区別する。`recentResults`の保存上限（最大10件）と、画面表示数（5枠）は別である。

### 4.2 カーテンの境界とドラッグ

`#listWrap`には`#words`、`#emptyState`、`#meaningCurtain`、`#curtainHandle`、`#curtainControls`、lock feedback、解説popupがある。ドラッグハンドルはカーテン境界を動かす専用要素で、先端復帰/lockのボタンとは別である。

`geometry()`は各meaning cellの矩形を測り、先頭セルからの相対`top`/`bottom`閾値とリスト寸法を返す。`revealY`は先頭meaning cell基準の局所CSS pixel位置である。`positionCurtain()`はこの値からカーテンとハンドルの位置を描画するが、単独では学習履歴を記録しない。

ハンドルのpointer操作はpointer captureを使う。ドラッグ中の境界を`processRevealProgress()`から`StudyCore.processRevealThresholds()`へ渡し、閾値を越えた未開示IDだけ`markStudied()`で記録する。保存失敗時は直前に保存された境界へ戻す。GPT `skipped` IDおよび表示数変更後の保護frontierまでにあるマスク行は、自動開示対象から除外する。カーテン通過範囲と`studiedIds`は同じものではない。

ドラッグ境界を逆方向へ動かしても、すでに`studiedIds`へ記録された開示や、`state[id]`に確定済みとなった履歴を取り消す処理はない。境界を戻すと意味欄はカーテン下に視覚的に覆われ得るが、保存済み学習履歴は残り、セッション上の開示記録も自動で削除されない。境界の見た目と学習記録は別状態である。

### 4.3 カーテンロック、解除、操作ボタン

`#curtainControls`は先端復帰とロック/解除ボタンを同じ配置基準で保持する。横並びは先端復帰が左、lockが右で、間隔はCSS gapで設定する。`#curtainHandle`はこのcontrols groupに含まれない。

- 通常時、`.curtain-controls`は`.list-wrap`を基準にabsolute配置される。`positionCurtainControls()`はカーテン境界の下20pxを縦位置基準とし、右端をリスト幅に合わせる。文書スクロール時は通常レイアウトによりcontrols全体が一緒に移動する。ロック中は同じグループが`position:fixed`へ切り替わり、viewport上の境界に配置される。
- `#curtainControls`内は先端復帰が左、ロック/解除が右で、gapは8px。ボタンは各38×34px。`#curtainHandle`は独立したドラッグ要素であり、両ボタンのグループに含まれない。ボタン同士も別々のclick handlerを持ち、先端復帰とlock toggleは別操作である。
- 10問表示ではロックボタンだけを隠し、先端復帰ボタンは表示対象に応じて通常どおり有効/無効を更新する。20/50/100問表示では両ボタンを表示する。10問表示ではロック開始自体も拒否される。
- ロック中はカーテン、ドラッグハンドル、controls groupに`is-curtain-locked`を付け、fixed配置へ切り替える。scroll eventは`requestAnimationFrame`で`updateLockedCurtain()`を呼び、文書の動きに合わせて固定境界・進行量を更新する。保存可能な新しい開示閾値だけを学習記録へ反映する。
- `beginCurtainLock()`はロック時のハンドル中心のviewport Yを`lockedY`に記録する。`effectiveLockedY()`はこの位置と先頭meaning cellのviewport上端の大きい方を返す。このため通常は画面Yを固定するが、先頭行より上へ境界が入らないよう先頭行位置へクランプされる場合がある。ロック開始可否の54px条件は、ハンドル中心と固定フッター上端の間に操作スペースが残るかを調べる条件であり、カーテン全体のドラッグ可能範囲を54pxに制限する指定ではない。ドラッグ中の通常境界は`0..g.height`にクランプされる。
- `endCurtainLock()`は`releaseCurtainLock(true)`を呼ぶ。解除前の有効viewport境界を記録し、解除後の行位置から`revealY`へ変換して`positionCurtain(...,{preserveBoundary:true})`を使う。これにより解除時にGPT anchorや学習frontier anchorで境界を上書きしない。解除自体は追加開示・評価を行わず、通常ドラッグへ戻す。
- 先端復帰ボタンは`returnToSessionFrontier()`を実行する。通常の非ロック経路では表示中のセッションfrontier/GPT到達位置に境界を合わせて`revealY`を保存し、開示・評価履歴を直接変更しない。ロック中に保留中のscroll animation frameがあれば、先にそのframeをキャンセルし、現在のviewport位置で`updateLockedCurtain()`を同期実行する。この判定は先端復帰の`window.scrollTo()`より前なので、そこで記録されるのは復帰前のスクロールによって既に越えていた開示thresholdであり、記録が遅れていた場合の反映である。その後、先端復帰が行うスクロール後の更新は`{suppressRevealProcessing:true}`で呼び、`lockLastRevealY`を更新するため、復帰スクロールだけで新たな開示記録を作らない。`test/study-core.test.js`の`locked return flushes pre-return scroll disclosures before its own scroll and suppresses new thresholds`は、実コードから抽出した両関数を使いこの順序を検証する。
- ロック中にスクロールが自然終端へ達すると、`updateLockedCurtain()`は文書の最大scroll位置と最終行下端がfooter上端-12pxに達した条件で`endCurtainLock()`を呼ぶ。ロック中の先端復帰では、その更新結果が`natural-end`なら解除後に目標IDの行境界を再計測して`revealY`へ設定する分岐がある。コード上は自然終端で先に解除し、その後に目標位置を設定する経路である。自動テストはこの分岐の構造・境界維持を確認するが、実ブラウザでの全自然終端タイミングを網羅するものではない。

### 4.4 GPT anchorと表示数変更frontier

`gptRevealTargetId`はGPT結果jumpの目標ID、`curtainFrontierId`と`curtainFrontierIdentity`は表示数変更後の境界復元情報。`positionCurtain()`はidentityが一致する場合にIDから行境界を再計算する。手動ドラッグ保存はGPT anchorを解除する。

表示数変更では旧セッションの開示先端を確定前に取得し、対象範囲を切り替えた後に未確定評価を確定し、新しい空のactive sessionを作る。旧frontier IDと順序identityを次sessionへ渡し、カーテン境界だけを復元する。境界より手前のIDは自動開示から保護されるが、新sessionで開示済みや評価済みにはならない。再描画後にカーテンを配置し、`syncStudyFooterSpacer()`を更新してから`scrollToCurtainResumePosition()`を呼ぶ。

### 4.5 固定footerとスクロール余白

`.study-actions.study-footer`は画面下部固定で、safe-area insetを考慮する。DOM上の`#studyFooterSpacer`は通常フロー末尾にあり、固定footerに最終行を隠されないスクロール余裕を補う。

`syncStudyFooterSpacer()`は`document.scrollHeight`を余白の基準にせず、`.app`の通常フロー下端、最終行の文書位置、固定footerの上端から必要量を計算する。カーテン操作ボタンは別レイヤーに絶対配置されるため、通常フロー下端とスクロール可能overflowを同一視しない。表示数変更後はcontrolsの位置が更新された後に余白を再同期する。この計算のDOM依存性は`test/study-core.test.js`のfooter spacer関連テストで契約を確認するが、各ブラウザ/端末の寸法保証ではない。

### 4.6 履歴確定

評価確定は`StudyCore.finalizeStudySession()`/`finalizeSessionDraft()`が担当する。同一active session内で再確定を避けるため`finalizedIds`を用いる。ページ・順序・設定変更の確定確認は呼び出し操作ごとに異なる。通常のページタブ遷移に常にconfirmが出るとは限らない。

## 5. GPT出題

### 5.1 候補選択

`makeGptSession()`は開始位置を選ぶ。

- 「ページの先頭から」：現在表示ページの先頭IDから。
- 「現在の続きから」：選択中モードの`studyProgress`が現在のwords/order fingerprintと一致するとき、最後に新規開示・到達したIDの次から。履歴がない・identity不一致なら表示ページ先頭へfallbackする。全体末尾なら対象なし。

`selectGptWords()`は現在の順序を走査し、最大指定件数を選択する。習得済み除外がONなら`currentStreak >= masteryThreshold`の候補を飛ばし、件数に達するまで後続へ進む。全体末尾では循環しない。

### 5.2 発行記録、payload、ユーザー向けUI

`makeGptPayload()`は`version:1`、`sessionId`、`mode`、`words`（文字列ID・word・meaning）と`outputInstructions`を作る。`createGptIssueContext()`は発行時の順序・位置・ページサイズ・除外条件・fingerprintなどを記録する。`makeGptSession()`は`issueSequence`を増やし、発行記録と連番をstudy ledgerへ保存する。

アプリ内セッションURLは`?study=`にBase64化したpayloadを付けて内部生成し、`lastSessionUrl`に保持する。現在の起動時処理に`?study=`を取り込む処理はない。また、現行GPT画面にsession URLやChatGPT URLの表示・コピー欄はないため、内部生成と画面上の提供機能を区別する。

ユーザーが見るのは発行したプロンプト全文のpreview、同じ本文をコピーするボタン、`makeChatGptUrl()`が作るChatGPTへの起動ボタンである。preview/コピー/ChatGPT起動が共有する本文は`makeGptPrompt(payload)`の結果。プロンプトにはsessionIdとID順を含め、CSVの特殊文字はエスケープする。モーダルを閉じると発行前UIへ戻るが、保存済みの発行記録は維持される。最新発行が未登録なら、独立した確認dialogで新規発行の継続を確認する。

GPT結果は`?result=<URLエンコードされたJSON>`から受け取る。`receiveGptResultFromUrl()`は結果JSONを登録欄へprefillしてモーダルを開くが自動登録しない。登録確認・検証・保存は通常の`applyGptResults()`経路を使う。成功時は保存後に`result` parameterを削除する。登録前にモーダルを閉じた場合もclose eventで削除する。登録失敗や確認拒否の直後はparameterを保持するが、その後モーダルを閉じればclose処理で削除される。他のquery、hash、history stateは維持する。

`?result=`を受け取るブラウザのlocalStorageが発行元と共有される保証はない。セッション記録が見つからない場合は、通常のsession validationにより処理される。

## 6. GPT結果登録（中心処理）

画面経路は`applyGptResults()` → `inspectGptResults()` → `prepareGptIntegration()` → 結果確認dialog → 必要なページ移動確認 → `saveCoreTransition()` → state/view/session反映 → `render()`。純粋な判定・draft生成は`study-core.js`にあり、DOM・dialog・localStorage適用は`index.html`にある。

### 6.1 検証・照合

1. UIは入力JSONをparseし、`inspectGptResults()`を呼ぶ。
2. version=1、session ID、results配列、IDの型・一意性、既知問題ID、未登録時の発行対象ID、許可result値を検証する。
3. 許可値は`correct`、`wrong`、`uncertain`、`skipped`。`uncertain`は現行コードで受理され、通常の正答以外として履歴へ反映される。出力指示と将来変更時にこの語彙を照合する。
4. 未登録セッションは発行記録のID列とcontextを使い、発行ID以外を拒否する。登録済みsession IDの再適用は結果確認dialog内に重複注意を表示し、同じdialogの「確認して再登録」で承認する。別の再適用用`window.confirm`は使わない。再生済み記録は通常session記録から除かれるため、再生時に発行ID列が残っていないケースでは、既知IDとresult値は検証するが、過去の発行ID集合との照合はできない。
5. 初回登録ではGPT発行記録に含まれないID、未知ID、重複ID、未知のresultを拒否する。登録済みsession IDの再適用では発行ID集合を照合できない場合があり、既知IDが受理され得る。結果JSONにない発行IDは単に「結果なし」で、検証エラーやskippedではない。

有効な入力の検証後、`applyGptResults()`はdraftを作り、`StudyCore.summarizeGptResults()`で確認用件数を算出して`#gptResultConfirm`を開く。この段階ではdraftをlocalStorageへ保存せず、アプリの学習状態も差し替えない。不正JSON・不正結果・不正IDはdialogを開かずエラーにする。

確認dialogでは発行単語数、JSONの結果あり件数、結果なし件数と、正解・不正解・曖昧・明示的スキップの内訳を表示する。発行単語数が正確に得られない再適用では「不明」、結果なしは「算出不可」とし、推測値を出さない。結果内訳は入力JSONを数えた値であり、重複保護やskipped除外などを反映した実適用件数とは区別する。「今回の結果適用対象」はdraftの`applied`件数を示す。発行対象外の既知IDが再適用で受理された場合は、サマリでも別件数として示す。

部分結果では、結果にない発行単語が学習履歴に反映されないことを注意表示する。欠落IDは履歴にも`gptSkipped`にも加えない。`results: []`も有効な結果として確認後に登録でき、結果適用件数0・学習履歴の加算なしでpending発行記録を登録済みにする。明示的な`skipped`は結果内訳に数え、既存の`gptSkipped`ルールで処理する。

「JSONを修正」、Escape、dialogの外側クリックは確認を取り消して入力を保持し、可能な場合はJSON欄へフォーカスを戻す。「確認して登録」または「確認して再登録」は、レビュー時のJSONと現在のアプリ状態・関連保存値が変わっていないことを確認してから登録する。状態が変化していれば古いdraftを適用しない。別画面でlocalStorageが更新されてアプリ内状態と一致しなくなった場合は、二重更新を避けるため登録を停止し、JSONを保持したまま再読み込みを案内する。ページ移動の確認は別の目的なので既存の確認処理を維持し、再適用警告の二重確認にはしない。

`saveCoreTransition()`が失敗した場合はdialogを開いたままエラーを表示し、JSONを保持する。保存成功直後にJSON欄をクリアして確認dialogを閉じ、その後に画面stateを反映・描画する。保存後の画面更新に失敗した場合は保存済みであることを別のメッセージで示し、再読み込みを案内する。二重クリックは処理中フラグで抑止する。確認文・外部JSONに由来する表示文字列は`textContent`で出力し、HTMLとして解釈しない。

### 6.2 開示保護・重複

`prepareGptIntegration()`は現在セッションの`studiedIds`と`finalizedIds`から、未確定の開示ID (`pendingDisclosed`) を作る。未確定開示IDに重なるcorrect/wrong/uncertainは`ignoredOverlapIds`としてGPT学習結果から除外し、現在の暫定○×を守る。skippedは履歴候補ではない。

既に確定済みの同一問題は`pendingDisclosed`ではないため、GPT結果がformal履歴へ追加される経路がある。現在開示済みの暫定状態を守る規則と、過去の確定履歴への追加は別の判定である。再登録時は登録済みsession IDに対する明示的な確認を行う。

### 6.3 結果種別と状態遷移

| 現在セッション | GPT結果 | 解答表示／マスク | `studiedIds`・`checkedIds` | 学習状態・履歴 | `gptSkipped` |
|---|---|---|---|---|---|
| 未開示 | correct | ジャンプ先ページに結果を暫定登録した場合は表示。formal-onlyなら現在行の開示状態は変えない。 | provisional対象ならstudiedに追加、correctならcheckedに追加。formal-onlyなら追加なし。 | provisionalはstudyCountを1増やし、履歴確定は後続セッション確定時。formalはstudyCount・correctCount・recentResults・streakを即時更新。 | IDを解除（skippedではない）。 |
| 未開示 | wrong | correctと同様に、provisional対象なら表示。formal-onlyでは現在表示を開示しない。 | provisionalではstudied追加、checkedから除外。 | provisionalのstudyCountを1増やし、○なしは後続確定時に誤答扱い。formalはstudyCountと誤答履歴を即時反映。 | IDを解除。 |
| 未開示 | uncertain | 現行実装ではwrongと同じく○ではない評価として扱われ、provisionalなら表示。 | provisionalではstudied追加、checkedから除外。 | formalなら誤答(false)履歴として更新。 | IDを解除。 |
| 未開示 | skipped | 解答は個別マスク。 | 追加しない。 | studyCount・正誤履歴を変更しない。 | 明示的にIDを追加。 |
| 未開示 | 結果なし | 未開示状態。結果登録それ自体は開示しない。 | 追加しない。 | 変更しない。 | 追加・解除しない。 |
| 現在セッションで未確定開示 | correct/wrong/uncertain | 現在の開示と暫定評価を保護し、GPT結果の重複分を無視する。 | 既存studied/checkedを維持。 | GPT分の重複加算なし。 | 現在studied IDは保護集合によりskippedを解除する。 |
| 現在セッションで未確定開示 | skipped | 開示済み表示を維持し、評価を書き換えない。 | 維持。 | 追加変更なし。 | 保護IDなのでskipped状態を解除。 |
| 現在セッションで未確定開示 | 結果なし | 現状態維持。 | 維持。 | 変更なし。 | 変更なし。 |
| 現在セッションで確定済み開示 | correct/wrong/uncertain | activeSession上の確定済み評価表示をその場でGPT結果に置き換えない。GPT結果は別の確定履歴へ追加される経路がある。 | 既存配列を保持。 | GPTの正誤結果をformal履歴として追加する場合がある。 | IDを解除。 |
| 現在セッションで確定済み開示 | skipped | 開示済みのまま。 | 維持。 | 変更なし。 | `studiedIds`保護によりskipped状態を付けない。 |
| 現在セッションで確定済み開示 | 結果なし | 現状態維持。 | 維持。 | 変更なし。 | 変更なし。 |
| 過去履歴あり・現在未開示 | correct/wrong/uncertain | ジャンプ/provisional条件による。過去履歴だけでは現在行の開示済みにはならない。 | provisionalの時だけactive sessionに追加。 | 新たな結果として履歴・studyCountを追加する場合がある。履歴出所は区別されない。 | IDを解除。 |
| 過去履歴あり・現在未開示 | skipped | 未開示・個別マスク。 | 追加しない。 | 過去履歴もstudyCountも変更しない。 | IDを追加。 |
| 過去履歴あり・現在未開示 | 結果なし | 現在未開示のまま。 | 追加しない。 | 変更なし。 | 変更なし。 |

表中の「provisional対象」は、ジャンプが許可され、結果IDが候補ページに含まれ、未確定開示重複ではなく、既に確定済みの同一ページ結果でもない場合を指す。ジャンプをしない結果は通常formal履歴として登録され、現在のactive sessionのstudy/checked/reveal状態へ結果を一括追加しない。

### 6.4 draft生成の実際の順序

`prepareGptIntegration()`の未登録session経路は、概ね次の順で処理する。

1. 結果を検証し、入力state/sessionをコピーしてdraftを作る。
2. active sessionの未確定開示IDを求め、正誤結果の重複をeligible集合から除く。位置判定では、結果が返された全ID（skippedを含む）を使い、開示済みIDを結果順の端点から除外しない。
3. 結果が未登録であること、発行記録の連番がledgerの`gptIssueSequence`と一致すること、かつその連番を持つpending記録が一意であることを確認する。発行履歴全体でより新しいセッションが存在する場合、そのセッションが登録済みで発行記録から削除済みでも、古い結果はjump対象外とする。最新判定情報が不整合な場合も結果登録のみとする。登録済み結果の再取り込みは既存の再登録確認へ進み、jumpは行わない。
4. 発行contextと現在表示順・ページ・active sessionの開示IDから、実結果の先頭と末尾を評価する。order/content fingerprintや現在のページ位置を確認し、整合しない場合はjumpを抑止する。`studyProgress`の連続性だけを理由に、ページ位置ルールで許可されたjumpを抑止しない。
5. 先頭が現在ページ内で未開示なら確認を求める。承認後は末尾位置に進む。先頭・末尾のページ位置と開示状況からjump候補を決め、候補ページに入らない結果はformal結果になる。
6. formal結果をstateへ適用する。別ページを離れる場合は、現在ページの未確定結果を保護する既存確認を行う。確認拒否なら結果のみ登録するformal-only draftに作り直す。
7. jump可能な結果のうち候補ページに表示されるものだけをactive sessionへ登録する。studyCountは対象IDにだけ加算し、correctだけcheckedIdsに追加する。skippedはこの経路に入らない。
8. 発行sessionを登録済みにし、`gptSkipped`を明示結果だけで更新する。jump成立時だけ`studyProgress`を最遠実結果IDへ進め、`advanceStudyProgress()`が後退を防ぐ。
9. 最終draftを`saveCoreTransition()`で保存してから、画面state・view・解答カバーを更新する。結果登録件数と移動結果は分けて通知し、`resultStatus.dataset.reasonCode`に内部理由コードを設定する。

この順序により「GPT結果を履歴に記録すること」「active pageで暫定的に表示すること」「学習位置を移すこと」は別々の判定になる。

### 6.5 発行順・現在ページと結果位置

`evaluateGptJump()`は、発行時の`record.ids`順に沿って結果IDの有無を走査する。JSON配列の順序やIDの数値大小を使用しない。実結果の最初を`firstResultPosition`、最後を`lastResultId`・候補位置とする。skippedも実際の結果なので両端判定に含まれ、結果なしは含まれない。

`gptIssueSequence`はセッション発行ごとに増え、登録済みセッションの発行記録が消えた後も発行順を保持する。発行履歴全体で最後に発行された正の連番を持つ、未登録かつ一意な記録だけがジャンプ判定の対象になる。したがってA発行→B発行→B登録（B記録削除）→A登録の順でも、Aは古い発行として結果登録のみとなる。登録済みセッション自体の再取り込みもjumpしない。連番のない旧pending記録は次の発行時に0へ移行し、結果登録のみとなる。0の旧記録が残っていても、その後に発行された正の連番を妨げない。ID文字列や`createdAt`の大小比較はしない。

`evaluateGptJump()`は現在表示中の同じ順序を検証し、現在ページの位置範囲を現在のページサイズから求める。通常順では`pageIndex * pageSize`、ランダム順では`randomStart`が範囲の起点となる。フィルター・習得除外で表示行が減ってもページの固定範囲を保ち、結果IDの位置は発行時contextから照合する。ページサイズ変更後も現在のページ範囲を使う。順序・単語内容・ページ位置が確かめられない場合はjumpしない。

判定は次のとおり。位置は現在の表示順における0始まりindexで比較する。

| 先頭結果 | 末尾結果 | 判定 |
|---|---|---|
| 現在ページ内・開示済み | 現在ページ内・開示済み | jumpしない。`last-already-disclosed`。 |
| 現在ページ内・未開示 | 任意の結果末尾 | 確認する。承認なら末尾へjump、拒否なら位置維持。 |
| 現在ページより前 | 現在ページより前 | jumpしない。`last-before-current-page`。 |
| 現在ページより前 | 現在ページ内・未開示 | 末尾へjump。 |
| 現在ページより前 | 現在ページ内・開示済み | jumpしない。`last-already-disclosed`。 |
| 現在ページより前 | 現在ページより後ろ | 末尾へjump。 |
| 現在ページより後ろ | 任意 | jumpしない。`first-after-current-page`。 |

端点は発行ID順で返却された結果から求める。skippedは位置判定に含み、結果配列にないIDは含めない。途中の欠番は開示済みにならず、既存の個別マスクを維持する。`studyProgress`はjump成立時の最遠位置を保存し、既存カーソルより後退させないが、jump候補の連続性ゲートには使わない。

### 6.6 ページ確認、jumpなし、履歴反映の分岐

これらは別理由であり、同じ処理とみなさない。

- **古い発行・発行順不明**：`older-issue`または`missing-issue-order`でjumpしない。履歴登録は続ける。
- **現在ページより後ろから始まる結果**：`first-after-current-page`でjumpしない。
- **現在ページより前で終わる結果**：`last-before-current-page`でjumpしない。
- **末尾がすでに開示済み**：`last-already-disclosed`で移動せず、結果登録を続ける。
- **順序・内容の不一致**：`order-mismatch`、`csv-order-changed`、`content-changed`などの理由コードでjumpしない。
- **ページ移動・モード復元の確認拒否**：最初のdraftがjumpを提案しても、ユーザーが拒否した後に`prepareGptIntegration(...forceFormalOnly:"user-declined-jump")`を再実行する。結果登録は続け、画面遷移を取り消す。
- **先頭未開示の確認拒否**：同じ`user-declined-jump`理由で、結果登録のみを行い現在位置を保つ。
- **現在ページの未確定開示との重複**：該当correct/wrong/uncertainを`ignoredOverlapIds`へ入れ、active暫定状態を維持し、GPT重複分を加算しない。
- **発行済み結果の再登録**：登録済みsession IDには重複確認。拒否すれば登録せず終了。承認後はreplay formal経路を使うが、未確定active IDとの正誤重複は除外する。
- **現在ページ内でjump先が同一**：対象ページに入るeligible結果をactiveSessionへ暫定反映する。別ページへ移動する場合は、現在active sessionを確定し、候補ページを再計算してから新しいセッションを作る。

formal-only時、active sessionの`studiedIds`、`checkedIds`、`revealY`と`studyProgress`をjump結果で書き換えない。ただしformal結果が表示対象の構成を変える可能性があるとき、復元用の`preserveTargetIds`情報が付加されることがある。これは既存セッションの暫定評価を置き換える操作ではない。

移動確認は、現在ページの未開示先頭から始まる結果の場合、または別ページへ移り未確定学習結果に影響する場合に表示される。両方必要なら一つの確認文にまとめる。拒否は結果JSONを破棄する意味ではなく、結果のみ登録して現画面に留まる経路である。登録件数は従来どおり`applied`（skippedと未確定開示との重複を除く）であり、通知は移動成否・理由を別に示す。

### 6.7 到達位置・カーテン・保存

ジャンプが成立すると、結果最遠IDが`gptRevealTargetId`となる。画面側は実際にレンダーされた行を`geometry()`で測り、`positionCurtain()`がtarget行のbottomを`revealY`へ反映する。別ページjumpでは候補view/sessionを作る。同一ページでは既存revealYよりターゲットが手前にならないよう、アンカーを境界に合わせて調整する。

`studyProgress`はjump成立時に最遠結果IDまで進めるが、その区間の中間問題を`studiedIds`に一括登録しない。active page内のprovisionalな結果IDだけがstudied/checkedとstudyCountに追加される。GPTカーテン移動では通常`processRevealProgress()`を呼ばない。

`updateGptSkippedResults()`は結果IDだけを扱い、未返却IDを推定しない。`prepareGptIntegration()`はskippedを現在の表示対象ID内に限定し、現在active sessionで開示済みのIDを保護する。表示数変更では旧表示対象から退出したIDのskippedだけ解除し、共通対象のskippedは保持する。解除済みIDを後で再表示してもskippedを復元しない。

snapshotは`saveCoreTransition()`経由でstate、session、registered GPT IDs、`studyProgress`、`gptSkipped`をまとめて保存する。関連するview/preferences書き込みは失敗時にrollbackを試みる。保存成功後にメモリ状態を差し替えてrenderする。結果取り込みそのものは通常stayで、承認されたjumpがある場合だけviewを変更する。

## 7. `skipped`と結果なし

| 状態 | 定義 | 永続化 | 到達/表示への作用 |
|---|---|---|---|
| `skipped` | JSONに明示されたresult | `gptSkipped:{contentFingerprint,ids}`。現在対象のIDに限って追加し、開示済み保護対象はmask解除。 | GPT jump端点には実結果として含む。カーテン自動開示からblockedになる。 |
| 結果なし | 発行IDがresultsに含まれない | 独立状態を保存しない。 | 到達端点に含めず、GPT取込だけで開示・studyCountを変えない。 |

結果なしIDは後続の通常カーテンドラッグで閾値を越えると通常開示される場合がある。一方、明示`skipped` IDは`processRevealThresholds()`のblocked IDに入る。どちらも個別マスク上の開示操作は`markStudied()`へ進むが、表示数変更後に保護されたfrontier以前の行は追加で自動開示しない。この差は現行コードの動作として記述し、理由や今後の望ましさをコードだけで断定しない。

表示数変更では旧targetから退出するIDの`gptSkipped`を解除し、変更前後に共通するIDは維持する。解除後に表示範囲へ戻ってもskippedは復活しない。

## 8. ページ遷移と復元

### 8.1 通常のページ・表示更新

`requestViewTransition()`は`transitionView()`を呼び、既定ではactive sessionを確定して新しいtarget/sessionを保存する。確認ダイアログの有無は個々のイベント側で決まる。通常ページタブは空でない固定ページを選択でき、前後ページ操作は利用可能なページへ進む。フィルターや閾値の再評価で現在ページが空になっても、通常描画は固定pageIndexを維持する。

習得除外中に、単語データがあり固定ページ内の単語がすべて習得済みで表示0件の場合、`makeMedalIcon()`と「このページの単語をすべて習得しました！」を表示する。CSV未登録など習得完了とは異なる空状態は通常の空表示を使う。空ページは固定範囲のindexとviewで保存され、再読み込み時も保持される。通常タブでは空ページボタンはdisabledだがactive位置は表せる。空ページから離れた後に、過去の空ページを特別に再挿入する仕組みはない。

### 8.2 表示数変更

`changePageSizePreservingLearningPosition()`は通常設定変更用`changeDisplaySettings()`と異なる専用経路である。

1. 確定前に`resolveDisplayFrontier()`で現在順序の開示先端を取得する。先端がなければ変更前ページ先頭IDをfallbackとする。
2. `pagePositionForId()`でそのIDを含む新しい固定範囲を決める。通常順では元配列順、ランダム順では既存`randomIds`順を使い、表示数変更で再シャッフルしない。
3. `transitionView(finalize:true, resetCurtain:true, curtainFrontier:...)`で旧active sessionの未確定評価を一度確定し、新しい空sessionを作る。開示済み/暫定評価は移さず、frontier IDとorder identityだけを持ち越す。
4. 退出した旧target IDの`gptSkipped`を解除し、共通target IDの状態は維持する。GPT発行記録自体は引き続き結果照合に使える。
5. DOM再構築後にIDからカーテン境界を測り直し、footer spacerを同期してから境界の次に表示される行へスクロールする。

表示数は10/20/50/100。ページ範囲内で習得フィルターが空ページを作ることがあり、page indexの補正には`buildTarget()`の`keepEmptyPage`条件が関わる。

### 8.3 保存・復元、順序切替、データ差替え

`tryRestoreSession()`はsession key、ordered `targetIds`、`studiedIds`/`checkedIds`/`finalizedIds`の包含・一意性を照合する。対象が一致すれば開示・評価・`revealY`を復元し、`curtainFrontierId`/identityおよび`gptRevealTargetId`も妥当な形で引き継ぐ。不整合時には保存された開示結果を確定して新しいsessionへ進む経路がある。`studyProgress`、`gptSkipped`、order/content fingerprintsは独立に保存・検証する。

通常/ランダム順の切替は`STORAGE_ORDER_RESUME`（`wordlist.orderResume.v1`）に保存するモード別復帰記録を使う。各記録は`sortMode`、`anchorId`、`learnedId`、および`studyOrderIdentity()`が作るidentity（語数、順序fingerprint、CSV順fingerprint、内容fingerprint）を持つ。記録は`transitionView()`の遷移保存と一緒に書き込み、再読み込み時に正規化して読み込む。切替先ではidentityとIDの存在を検証し、`pagePositionForId()`で現在の表示件数に合わせたページへ戻す。記録がない、またはidentityが一致しない場合は先頭を使う。ランダム順のページ計算には保存済み`randomIds`を使い、通常順へ切り替えただけでは再シャッフルしない。

切替前の記録は、現在のページ先頭をfallbackとして`resolveDisplayFrontier()`を使って作る。学習先端がある場合はそのIDと境界を記録する。学習先端がなく、ページを開いただけの場合は現在ページの先頭IDを`anchorId`とし、`learnedId`はnullにする。このため、古い`studyProgress`があっても、未開示の現在ページから離れた操作を以前の学習位置へ引き戻さない。未確定結果の確認・確定は順序切替ハンドラーが行い、承認後に復帰情報を捕捉して遷移する。取消時は捕捉・保存へ進まない。

復帰ページの選択と、そのページ内のカーテン境界は別の情報である。復帰先セッションには、復元した境界を`curtainFrontierId`/`curtainFrontierIdentity`で持たせ、`curtainFrontierResumeOnly`を設定する。この境界はカーテン再構成と過去行の自動再開示防止に使う一方、`resolveDisplayFrontier()`はresume-only境界を新たな学習先端として扱わない。したがって復帰後に未開示のまま表示件数を変更した場合、現在ページ先頭を新しいページ選択fallbackにでき、復帰境界は個別マスク保護として引き継げる。実際に新たな単語を学習すると`markStudied()`がresume-onlyフラグを解除し、その後は通常のセッション進捗になる。

identity不一致の記録は復帰先として利用しない。明示的な再シャッフルは新しい`randomIds`を書き、`transitionView()`でランダム順の`studyProgress`と復帰記録を無効化して先頭から始める。CSV差替えや単語内容・順序の変更時もidentity照合で古い復帰記録を使わない。復帰記録は無効時に必ず物理削除されるわけではなく、将来同一identityに戻った場合に再び有効となり得る。これは保存動作上の事実であり、意図の判断とは区別する。

共通IDの確定履歴は従来どおりIDをキーに維持される。`studyProgress`は順序ごとの学習/GPT到達記録、`orderResume`は順序切替後の表示位置、`curtainFrontierId`は現在セッションでのカーテン境界を担い、相互に代替しない。CSV差替えは既存の専用経路で新しいリストの先頭を選び、ID集合変更時は通常順に戻してランダム順を作り直す。

ホーム画面への切替はsessionをそのまま確定する操作ではなく、現在状態を保存してscreenを切り替える。再開時に`tryRestoreSession()`を試す。

### 8.4 表示更新ごとの移動範囲

| 操作 | ページ位置の扱い（実装） |
|---|---|
| 習得除外・閾値などの再評価 | 現在の固定ページを保持する。空になっても別の非空ページへ自動補正しない。 |
| 通常学習の確定・GPT結果のstay反映 | 現在のviewを維持する。表示行が変化しても勝手なページjumpはしない。 |
| 表示数変更 | 開示frontierを含む新ページへ移動する。 |
| GPT結果jump | 判定後、必要な確認でユーザーが承認した場合のみ候補viewへ移動。 |
| タブ/前後ページ | 明示選択した有効ページへ移動。 |
| 通常/ランダム切替、reshuffle、CSV差替え | それぞれの専用既存経路を使う。 |

ページ内スクロールはview/pageIndexの変更とは別である。表示数変更時の学習再開位置スクロールは、ページ移動後に実行する。

## 9. 進捗可視化

`buildProgressSummary()`は全登録問題から習得済み数・習得率を計算し、`currentStreak >= masteryThreshold`で習得を判定する。分布は`studyCount`を使い、all/unmasteredを切り替える。active sessionの暫定評価を履歴から差し引かない。画面側`renderProgressSummary()`はホーム、学習画面、詳細dialogで同じ習得率summaryを表示し、解答開示後は分布も更新する。

これは表示用集計で、習得除外設定やページの表示範囲に習得率母数は依存しない。分布対象切替は画面内stateのみで、学習保存状態の変更ではない。

## 10. 主要な不変条件と根拠

以下は実装・テストで確認できる性質であり、根拠のない一般的な設計理念を追加したものではない。

1. 同じactive session内で同じIDを二重開示しても`recordStudy()`は再加算しない。
2. GPTのskippedと結果なしは別。skippedだけが`gptSkipped`へ入り、どちらもGPT import自体ではstudyCountを増やさない。
3. GPTの発行順・内容identityが現行wordsと合わない場合、jumpを許可しない。
4. `advanceStudyProgress()`は有効な同モードcursorを後退させない。
5. GPT結果登録と画面jumpは別判定である。ジャンプ対象は最新かつ未登録の発行セッションに限り、現在表示ページに対する結果先頭・末尾の位置で移動を決める。抑止時も適格な結果は履歴へ登録する。
6. 未確定active disclosed IDへのGPT正誤重複を無視し、暫定状態を守る。既に確定した履歴があることだけでは現在session開示を意味しない。
7. GPTの結果範囲・カーテン位置は、すべての間のIDを学習済みにする根拠ではない。
8. `gptSkipped`と`studyProgress`は別データであり、前者はID mask、後者はモード別到達カーソル。
9. データ保存が成功する前に画面側のdraftを本状態へ置き換えない。`saveCoreTransition()`は関連キー書き込みに失敗した場合のrollbackを試みる。

主要テスト名は`test/study-core.test.js`の`GPT jump uses displayed page positions rather than study-progress continuity`、`GPT result positions include skipped outcomes and gaps without disclosing missing IDs`、`GPT integration keeps active session on no-jump...`、`GPT result for an already disclosed active row...`、`GPT issue sequence persists independently of pending records...`、`GPT result page-position classifier covers first and last position rules`等を参照する。

## 11. 設計意図の根拠と限界

- **コードで確認できる事実**：`study-core.js`は状態・履歴・GPT処理をDOMから分離する。`index.html`がDOMとbrowser storage/eventsを接続する。各自動テストは指定状態の入力と期待値を検証する。
- **テストで確認された契約**：GPT skippedと結果なしの区別、最新issue順、active-session重複保護、ページサイズ変更時のfrontier、empty page、footer spacer順序、unlock boundary、個別mask default evaluationなどは`test/study-core.test.js`のテストで固定されている。
- **意図を断定しない点**：コードの分岐が存在することは、その動作が将来も望ましいという証明ではない。特に結果なしIDが通常dragで開示される点、session URLを内部生成する一方で現UIに表示しない点、空ページからの再訪可能性の細部は実装事実として記載し、理由や将来要件を推測しない。
- **テスト範囲の限界**：ソース構造を検査する単体テストは実DOM描画、すべてのブラウザ寸法、実機Safariの挙動を保証しない。固定要素・safe-area・スクロール寸法の変更時はブラウザ/端末での確認も必要。

## 12. 補足設計と未決事項

### 12.1 CSVとデータ差替え

`StudyCore.parseWordCsv()`はUTF-8 CSVを解析し、`id,question,answer`（`explanation`任意）およびlegacyの`id,word,meaning`を受け付ける。汎用形式ではanswer必須。重複ヘッダー/ID、必須値不足、引用符不整合、列数超過をエラーにする。CSV parserは引用符、改行、Unicode等を扱う。

`importCsv()`はまずparseし、次状態/view/orderを用意してから`requestViewTransition()`へ渡す。失敗時は既存リストを入れ替えない。初回登録はファイル名からタイトルを作り、差替えでは既存タイトルを維持する。ID集合が同じ場合はID別学習履歴とrandom orderを継続し、異なる場合は通常順・先頭から始める。

### 12.2 設定・UI・モバイル

学習設定は1ページ表示数、デフォルト評価、習得判定閾値。設定初期化はこの3項目だけを初期値に戻し、GPT問題数/開始位置、履歴、GPT session、CSVヘルプ開閉状態を初期化しない。GPT出題数は`preferences`、GPT開始位置は`wordlist.gptStartPosition.v1`に独立保存する。CSV説明の開閉状態は`wordlist.csvHelpOpen.v1`に保存する。

設定dialog、GPT dialog、結果確認dialog、進捗詳細dialogは`<dialog>`を使う。狭幅用CSSは主に560px以下、短い画面用調整は560px以下かつ高さ420px以下に定義される。学習行、モーダル、GPT prompt preview、ボタンなどの寸法はコード上のCSSで定義されるが、ここに書くことは実機Safariのレイアウト保証を意味しない。

### 12.3 保存・エラー処理

`saveCoreTransition()`は複数localStorageキーの関連更新について書き込み前の値を取り、失敗時にrollbackを試みる。画面側は保存成功後にdraft stateを差し替える経路を使う。localStorageの読込失敗、CSV parse失敗、セッション復元不整合、書込失敗はそれぞれ画面メッセージや操作中断へ分岐する。すべてのブラウザストレージ障害やrollback障害を回復できるとは限らず、rollback自体の失敗はエラー内容へ付記される。

### 12.4 未決事項

1. GPTの「結果なし」と明示`skipped`で通常ドラッグの自動開示条件が異なる。この差を将来も維持するか統一するかは、コードだけでは決めない。
2. `?study=` URLは発行時に内部生成されるが、現在のアプリ起動処理で読み取られず、現UIにも表示されない。後方互換・将来利用などの意図は不明である。
3. 履歴stateは通常学習/GPTの出所を記録しない。source別履歴を追加する決定は確認できない。
4. 空ページやページタブの細かな再訪UXは固定ページ/disabled tabの実装が根拠。異なるUXを望む場合は別途仕様判断が必要。
5. 過去に合意された「カーテンの下側54px制限」が移動範囲そのものを指す場合、現行実装とは一致しない。コード中の54pxは`beginCurtainLock()`でロックを開始できるか判定するためのハンドル中心―固定footer間clearanceであり、通常ドラッグは`0..g.height`まで動ける。下側移動をfooter基準で制限する意図だったかは、コードだけでは判断できない。
6. 先端復帰時の保留frame処理は、先端復帰スクロールより前の現在位置で開示判定し、その後の復帰スクロール後はthreshold処理を抑制する。追加回帰テストでこの順序を確認した。ブラウザ固有のscroll event/rAFスケジューリング全般を単体テストで保証するものではないため、実機でのイベント順序保証が必要になった場合は別途ブラウザ検証を行う。
7. 「全体・各回のステータス表示」が行内の直近5件履歴以外のUIを指す場合、対象要素を特定できていない。現在確認できる行内履歴は等幅5枠で整列している。

これらは現行動作の説明と将来の仕様判断を分けるための項目であり、未実装機能を予定として約束するものではない。

### 12.5 GPT連携のセキュリティ上の既知の制約

- **登録済みセッションの再適用**：初回登録では結果IDを発行記録のID集合に限定する。再適用では登録済みsession IDへの明示確認後、既知の単語IDであれば元の発行対象外でも受け入れ得る。再適用結果は履歴へ追加されるため、発行対象との対応を追えず履歴の整合性を弱める制約がある。現時点では修正を見送っている。検証経路の詳細は6.1節を参照。
- **特殊な単語ID**：`__proto__`など通常のJavaScriptオブジェクトで特殊な意味を持つCSV IDでは、学習結果が期待どおり保存されない場合がある。グローバルなprototype汚染や任意コード実行が確認されたわけではない。ID制約または安全な状態格納方式は将来の改善候補である。
- **プロンプトインジェクション**：CSV由来の単語・意味はGPT用プロンプトに含まれるため、そこに命令文があれば固定指示と同じ入力へ混入し得る。GPTがその命令に従うか、結果を改変するかは未検証である。主に第三者由来のCSVを使う場合のリスクとして認識し、現時点では対策を保留している。

## 13. 根拠ファイル

- `study-core.js`: `normalizeWords`, `normalizeState`, `recordStudy`, `setSessionAnswer`, `finalizeStudySession`, `finalizeSessionDraft`, `saveCore`, `saveCoreTransition`, `studyOrderIdentity`, `resolveDisplayFrontier`, `curtainFrontierBoundary`, `clearGptSkippedOutsideTarget`, `buildPageModel`, `buildRandomFixedPage`, `safePageIndex`, `tryRestoreSession`, `parseCsv`, `parseWordCsv`, `prepareGptIntegration`, `updateGptSkippedResults`, `buildProgressSummary`, `makeGptPayload`, `makeGptPrompt`, `makeChatGptUrl`。
- `index.html`: storage keysと初期化、`importCsv`, `buildTarget`, `tryRestoreSession`, `transitionView`, `markStudied`, `canIndividuallyDisclose`, `toggleAnswer`, `render`, `geometry`, `processRevealProgress`, `syncStudyFooterSpacer`, `positionCurtainControls`, `releaseCurtainLock`, `beginCurtainLock`, `endCurtainLock`, `updateLockedCurtain`, `scheduleLockedCurtainUpdate`, `positionCurtain`, `returnToSessionFrontier`, `attachCurtainDrag`, `makeGptSession`, `applyGptResults`, `receiveGptResultFromUrl`, `removeGptResultParamFromUrl`, `changePageSizePreservingLearningPosition`, `scrollToCurtainResumePosition`。
- `test/study-core.test.js`: display-size/frontier/skipped、session restore、empty page、resume scroll、curtain controls/unlock、footer spacer、CSV、default evaluation、GPT payload/result/jump/duplicate handling、storage rollbackのテスト群。
- `README.md`: 必要ファイル、起動、CSV、学習・GPT連携の利用者向け概要。
