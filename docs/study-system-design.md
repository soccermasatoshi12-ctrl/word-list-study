# 学習システム設計書

## 1. この文書について

この文書は、Word List Study の学習状態、通常学習、GPT出題・結果登録、保存復元の現行実装を説明する。将来の変更時に、似た名前の状態を混同したり、GPT結果を通常学習状態へ誤って一括反映したりしないための参照資料とする。

記述は次の区分を使う。

- **現行仕様**：HEAD `e06bf6414f7c30f0dee2b7fd63fadfa9ea33e6d9` のコード・テストで確認できた動作。
- **実装構造**：その動作を実現するデータ、関数、画面処理。
- **設計意図の根拠**：コメント、ガード条件、テスト名・期待値、または明示された合意から確認できる意図。理由をコードから確定できない場合は推測しない。
- **変更候補・未解決事項**：まだ実装されていない機能や、動作統一を検討中の点。

この文書はカーテンロックや先端復帰が既に存在するとは扱わない。コードを変更した際は、関係する関数名と契約を照合して更新する。

## 2. 全体構造

### 2.1 問題集、順序、ページ

問題集は `words` 配列で、各問題は文字列ID、`question`、`answer`、任意の`explanation`を持つ。旧CSV列`word`・`meaning`は正規化時に`question`・`answer`へ移される。IDは状態マップのキー、GPT payloadとの照合キー、セッションの問題参照に使う。

- 通常順はCSV登録順。ページは問題集上の固定範囲で分割され、習得済み除外などの表示条件をページ内に適用する。
- ランダム順は保存されたID順を使う。ランダムページは順序上の固定範囲を先に切り、表示条件を適用する。
- 表示順・ページ・除外設定は現在の画面状態。通常順とランダム順の学習到達カーソルは別々に保持する。

### 2.2 処理の概略

```text
CSV / localStorage
       │
       ├─ words・state・preferences・view・random order
       └─ studyLedger (activeSession / studyProgress / GPT records / gptSkipped)
                    │
                    ├─ 通常学習: カーテンドラッグまたは個別開示
                    │             → studiedIds・studyCount・studyProgress
                    │             → ○×は暫定、遷移時等に確定履歴へ
                    │
                    ├─ GPT出題: 表示順・開始位置・除外条件でID列を選択
                    │             → payload + 発行時contextを保存
                    │
                    └─ GPT結果登録: JSON/ID検証 → 重複・開示保護
                                  → ジャンプ連続性 → 確認要否
                                  → 結果の正式履歴または現在ページの暫定状態
                                  → gptSkipped / studyProgress / view/session保存
```

ホーム画面と学習画面の習得率・学習回数分布は`StudyCore.buildProgressSummary()`から算出する。進捗表示は保存状態を読む表示処理であり、分布の対象切替は学習対象やカーソルを書き換えない。

### 2.3 主な実装箇所

| 対象 | 主な参照箇所 |
|---|---|
| 純粋な状態・履歴・GPT処理 | `study-core.js`: `normalizeState`, `recordStudy`, `finalizeStudySession`, `inspectGptResults`, `evaluateGptJump`, `prepareGptIntegration` |
| 画面状態とlocalStorage接続 | `index.html`: 初期化、`writeCoreSnapshot`, `transitionView`, `markStudied`, `applyGptResults` |
| カーテン・行表示 | `index.html`: `geometry`, `positionCurtain`, `processRevealProgress`, `syncMeaningDisclosure`, `syncAnswerControl` |
| GPT発行・結果登録UI | `index.html`: `makeGptSession`, `applyGptResults` |
| 進捗可視化 | `study-core.js`: `buildProgressSummary`; `index.html`: `renderProgressSummary` |
| 仕様回帰テスト | `test/study-core.test.js`: GPT integration、jump continuity、session persistence、reveal threshold関連の各テスト |

以下では行番号を固定参照にせず、関数名・状態名を主な参照単位とする。

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
| `gptRevealTargetId` | GPT由来の到達先を示す問題ID。ページ内の実寸法が変わっても再計測できるアンカー。手動ドラッグ保存時には解除される。 |
| `preserveTargetIds`, `preservedTargetIdentity` | GPT結果反映による習得状態変化で対象ページが変わる場合、データ・順序・固定範囲が一致する間だけ現在対象を保つための一時的な復元情報。 |

`recordStudy()`は`studiedIds`に既にあるIDなら何も加算しない。初回だけ`studyCount`と`lastStudiedAt`を更新してIDを追加する。`defaultAnswer`がcorrectの場合は初期の`checkedIds`にも追加する。

### 3.3 表示位置と進捗カーソル

- `revealY`はactive session内の現在ページの表示座標であり、到達順序を示す永続カーソルではない。
- `studyProgress.normal`と`studyProgress.random`はそれぞれの順序における最後の新規開示・GPT到達IDと、`wordCount`、order/CSV-order/content fingerprintを持つ。
- `recordStudyDisclosure()`は通常の新規開示IDを記録する。`advanceStudyProgress()`はGPT到達用で、有効なカーソルが対象より後ろなら後退させない。
- `gptRevealTargetId`は現在セッションの行境界を再計測するアンカー。`studyProgress`はモード別の順序位置であり、両者は同じ値・同じ保存目的ではない。

### 3.4 GPT状態・順序identity

- `gptSessions[sessionId]`は未登録の発行記録。`ids`は実際に発行した問題IDの順序、`context`は発行時のモード・開始位置・ページサイズ・除外条件・閾値・位置列・fingerprintを保持する。
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
| `wordlist.studyLedger.v1` | 現行snapshot。state、GPT session records、registered IDs、activeSession、`gptSkipped`、存在する場合の`studyProgress`を格納する。 |
| `wordlist.randomOrder.v1` | 保存されたランダムID順。 |
| `wordlist.view.v1` | 表示モード・ページ・除外などのview。 |
| `wordlist.preferences.v1` | ページサイズ、習得閾値、初期評価、GPT出題数。 |
| `wordlist.screen.v1` | ホーム／学習画面の復帰先。 |
| `wordlist.listTitle.v1` | ホームに表示する問題集タイトル。 |

`StudyCore.loadCore()`は現行ledgerがない・不完全な場合に旧state/sessionキーを読む。現行の画面更新は`saveCore()`または`saveCoreTransition()`を通じてledgerを保存する。

## 4. 通常学習とカーテン

### 4.1 DOMと座標

`index.html`の`#listWrap`内に`#words`、`#meaningCurtain`、`#curtainHandle`がある。`geometry()`は各`.meaning-cell`の`getBoundingClientRect()`を計り、先頭meaning cellからの相対`top`・`bottom`、`listWrap`内の先頭位置・幅・全高を返す。

`revealY`はmeaning cell先頭を0としたページ内のCSS pixel値。表示時は`positionCurtain()`が`listWrap`内の`top = geometry.top + revealY`へカーテンとハンドルを置く。画面座標自体を保存していないため、スクロール位置とは独立して再計測できる。

### 4.2 通常ドラッグから開示まで

1. `curtainHandle`のpointerdownが開始位置・pointer IDを保持し、pointer captureを取る。
2. pointermoveごとに`geometry()`を取得し、`clientY`差分で`revealY`を更新して`positionCurtain()`を呼ぶ。
3. `processRevealProgress()`が`StudyCore.processRevealThresholds()`へ行のbottom閾値、`revealY`、`studiedIds`、`gptSkipped.ids`を渡す。
4. 閾値を越え、未開示かつblockedでない行だけ`markStudied(id, threshold.bottom)`へ渡す。
5. `markStudied()`はdraftを作り、`recordStudy()`で一度だけ加算し、`studyProgress`とledgerを保存してからメモリ・DOM表示を更新する。保存失敗時には開示を確定せず、ドラッグ位置を直前の保存位置へ戻す。

`positionCurtain()`自体は学習記録を作らない。GPT由来のカーテン位置更新も通常の`processRevealProgress()`を通らない。これにより到達位置と行ごとの開示記録は別に保たれる。

### 4.3 評価と確定

開示時は`studiedIds`へ入る。○×操作は`setSessionAnswer()`で`checkedIds`を切り替えるだけで、まだ確定履歴へ追加しない。`finalizeStudySession()`は未確定の`studiedIds`について、`checkedIds`にあるものを正解、ないものを誤答として確定し、`correctCount`、`recentResults`、`currentStreak`、`finalizedIds`を更新する。

ページ遷移、順序・表示設定変更などの経路で確認・確定されるかは操作ごとに異なる。次・繰返し等は専用確認を行う一方、通常ページタブは`requestViewTransition()`へ直接進む。したがって「どのページ移動にも必ず確認が出る」と一般化しない。

### 4.4 個別マスクと「－」

`syncMeaningDisclosure()`は`activeSession.studiedIds`にない解答テキストを`is-undisclosed`として隠し、`aria-hidden=true`にする。`syncAnswerControl()`は未開示なら「－」を表示する。`canIndividuallyDisclose()`は、現在ページの行閾値が`revealY`内にある場合だけ有効とする。

「－」を押すと`toggleAnswer()`から`markStudied(id, revealY, true)`へ進む。対象IDのみを開示・加算し、もし`gptSkipped`に含まれるならそのIDだけ解除する。開示後は通常の○×評価・確定フローへ合流する。

**現行の差異**：通常ドラッグの`processRevealThresholds()`は`gptSkipped.ids`をblocked IDとして除外する。しかし結果なしIDはblocked集合に入らない。したがって同じく画面上「－」に見える未回答行でも、カーテンが通過すれば通常ドラッグで開示される場合があり、明示的skipped行は自動開示されない。これは現行コードの条件差であり、この文書作成では変更しない。

## 5. GPT出題

### 5.1 候補選択

`makeGptSession()`は開始位置を選ぶ。

- 「ページの先頭から」：現在表示ページの先頭IDから。
- 「現在の続きから」：選択中モードの`studyProgress`が現在のwords/order fingerprintと一致するとき、最後に新規開示・到達したIDの次から。履歴がない・identity不一致なら表示ページ先頭へfallbackする。全体末尾なら対象なし。

`selectGptWords()`は現在の順序を走査し、最大指定件数を選択する。習得済み除外がONなら`currentStreak >= masteryThreshold`の候補を飛ばし、件数に達するまで後続へ進む。全体末尾では循環しない。

### 5.2 発行記録とpayload

`makeGptPayload()`は文字列IDを含む結果JSON契約を作る。`createGptIssueContext()`は発行時の順序で各IDの位置を保存する。発行記録を`gptSessions[sessionId]`として保存した後、既存のアプリ内セッションURL（`?study=`）を生成し、新たに`makeGptPrompt()`・`makeChatGptUrl()`でChatGPT向けの`https://chatgpt.com/?prompt=...`も作る。GPT画面には両方のURLと、それぞれのコピー操作を表示し、ChatGPTを開く操作を提供する。既存のセッションURL生成・コピーは互換用に維持する。

従来の`?study=` payloadに含む`outputInstructions`は、JSONのみを返す既存契約（`version`・`sessionId`・`results`、IDと許容result値）を維持する。ChatGPT向けpromptは同じpayloadの`version`・`sessionId`・`mode`・出題単語を順序を保ったCSV形式で示し、CSVのカンマ・引用符・改行はCSV規則でエスケープする。ChatGPT固有の学習進行指示と、全問題の学習後にJSONを直接URLエンコードした結果リンクを作る指示はprompt側で別途構成し、従来の`outputInstructions`には混ぜない。結果値は`correct`、`wrong`、`uncertain`、`skipped`とする。`?result=`の受信・自動入力・自動登録はこのStepでは実装しない。受信側は引き続き既存の手動JSON登録UIを使う。

発行contextはモード、開始位置、ページサイズ、習得除外条件・閾値、問題件数、CSV ID順・出題順・内容fingerprint、発行IDごとの位置を持つ。JSONの結果配列順やIDの辞書順ではなく、この発行ID順で位置を比較できる。

## 6. GPT結果登録（中心処理）

画面経路は`applyGptResults()` → `inspectGptResults()` → `prepareGptIntegration()` → 必要な確認 → `saveCoreTransition()` → state/view/session反映 → `render()`。純粋な判定・draft生成は`study-core.js`にあり、DOM・confirm・localStorage適用は`index.html`にある。

### 6.1 検証・照合

1. UIは入力JSONをparseし、`inspectGptResults()`を呼ぶ。
2. version=1、session ID、results配列、IDの型・一意性、既知問題ID、未登録時の発行対象ID、許可result値を検証する。
3. 許可値は`correct`、`wrong`、`uncertain`、`skipped`。`uncertain`は現行コードで受理され、通常の正答以外として履歴へ反映される。出力指示と将来変更時にこの語彙を照合する。
4. 未登録セッションは発行記録のID列とcontextを使い、発行ID以外を拒否する。登録済みsession IDの再生は確認なしに進めず、重複登録confirmを要求する。再生済み記録は通常session記録から除かれるため、再生時に発行ID列が残っていないケースでは、既知IDとresult値は検証するが、過去の発行ID集合との照合はできない。
5. GPT発行記録に含まれないID、未知ID、重複ID、未知のresultは拒否する。結果JSONにない発行IDは単に「結果なし」で、検証エラーやskippedではない。

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
2. active sessionの未確定開示IDを求め、正誤結果の重複をeligible集合から除く。位置判定用結果からも未確定開示IDを除く。
3. 発行contextと結果を`evaluateGptJump()`へ渡し、発行順で最前・最遠の実結果位置を得る。
4. `studyProgress`のモード・順序・内容identityを検証し、最前結果からの連続性を確認する。UIから渡されたformal-only理由があればjumpを無効化する。
5. jump可能なら候補ページ・samePageを計算し、そのページで暫定保持できる結果IDを決める。候補ページに入らない結果はformal結果になる。
6. formal結果をstateへ適用する。別ページを離れる場合は現在のactive sessionを確定し、その結果を反映したstateで候補ページを再計算する。再計算後に見えなくなった結果はformal側へ移す。
7. jump可能な結果のうち候補ページに表示されるものだけを結果ページのactive sessionへ登録する。studyCountは対象IDにだけ加算し、correctだけcheckedIdsに追加する。skippedはこの経路に入らない。
8. 発行sessionを登録済みにし、`gptSkipped`を明示結果だけで更新する。jump成立時だけ`studyProgress`を最遠実結果IDへ進め、`advanceStudyProgress()`が後退を防ぐ。
9. UIは必要なページ移動確認を行う。拒否時にはformal-only draftを作り直す。最終draftを`saveCoreTransition()`で保存してから、画面state・view・カーテンを更新する。

この順序により「GPT結果を履歴に記録すること」「active pageで暫定的に表示すること」「学習位置を移すこと」は別々の判定になる。

### 6.5 最前・最遠結果位置と連続性

`evaluateGptJump()`は、発行時の`record.ids`順に沿って結果IDの有無を走査する。JSON配列の順序やIDの数値大小を使用しない。実結果の最初を`firstResultPosition`、最後を`lastResultId`・候補位置とする。skippedも実際の結果なので両端判定に含まれ、結果なしは含まれない。

次に`prepareGptIntegration()`が、発行モードのidentityに一致する`studyProgress`カーソルを検証し、最初の結果がカーソルの次位置を飛び越えるか調べる。カーソルが有効なら必要位置は`cursorIndex + 1`、無効・未設定なら連続性の起点を先頭位置(index 0)とする。`firstResultPosition`が必要位置より後ろなら`reason: "study-progress-gap"`でjumpを抑止する。連続性を満たせば、実結果の最遠IDまで既存jump候補を作る。

UI側の`applyGptResults()`はさらに`compareStudyProgress()`で既存カーソルが結果より先行するかを調べる。カーソル先行ならformal-only、identity不明で既存学習がある場合も安全側にformal-onlyを指定する。既存位置が結果より先でも、20〜60のように結果の発行列が既存位置以前から始まる場合は連続性判定を通る余地があり、`advanceStudyProgress()`がカーソルを後退させない。

| 現在カーソル（例） | 発行順で結果がある位置 | 判定 |
|---|---|---|
| 35 | 36〜50 | 直後から開始。jump可能（他のjump条件・確認を満たす場合）。 |
| 35 | 40〜50 | 先頭結果が直後を飛び越す。jump抑止、結果はformal反映。 |
| 35 | 41〜60 | 同様にjump抑止。ページ・画面位置は維持。 |
| 35 | 20〜60 | 結果開始は現在位置以前。連続性条件を満たし得る。既存到達位置は後退しない。 |
| 35 | 36, 38, 40 | 発行順で最前36・最遠40。穴の37・39は到達結果にも履歴にも自動追加しない。 |
| 35 | 37〜40 | 先頭が直後より後ろ。jump抑止、受理可能な結果だけformal反映。 |
| 35 | 返却結果なし | 実結果なしでjumpしない。 |

カーソル未設定・無効時は、位置0の結果から始まる連続性だけをjump候補とする。ランダム順も発行contextに保存した順序位置で比較する。ページ境界候補はその位置から通常ページまたはランダム固定範囲を算出する。

### 6.6 ページ確認、jumpなし、履歴反映の分岐

これらは別理由であり、同じ処理とみなさない。

- **連続性不足**：`prepareGptIntegration()`がjump不可にする。`eligible`なcorrect/wrong/uncertainはformal履歴へ反映し、skippedは`gptSkipped`へ記録。active session・revealY・view・studyProgressは通常のjump更新を受けない。formal履歴が現在対象に影響し得るときは対象ID保持用情報が付く。
- **既存カーソルが結果より先**：UIで`forceFormalOnly`を与える。履歴のみ反映し、現在ページへ移動しない。
- **ページ移動・モード復元の確認拒否**：最初のdraftがjumpを提案しても、ユーザーが拒否した後に`prepareGptIntegration(...forceFormalOnly:"user-declined-jump")`を再実行する。結果登録は続け、画面遷移を取り消す。
- **現在ページの未確定開示との重複**：該当correct/wrong/uncertainを`ignoredOverlapIds`へ入れ、active暫定状態を維持し、GPT重複分を加算しない。
- **発行済み結果の再登録**：登録済みsession IDには重複確認。拒否すれば登録せず終了。承認後はreplay formal経路を使うが、未確定active IDとの正誤重複は除外する。
- **現在ページ内でjump先が同一**：対象ページに入るeligible結果をactiveSessionへ暫定反映する。別ページへ移動する場合は、現在active sessionを確定し、候補ページを再計算してから新しいセッションを作る。

formal-only時、active sessionの`studiedIds`、`checkedIds`、`revealY`と`studyProgress`をjump結果で書き換えない。ただしformal結果が表示対象の構成を変える可能性があるとき、復元用の`preserveTargetIds`情報が付加されることがある。これは既存セッションの暫定評価を置き換える操作ではない。

別ページ移動確認は、モード切替が必要な場合、または現在ページを離れることで未確定結果を確定する必要がある場合に表示される。確認拒否は結果JSONを破棄する意味ではなく、結果のみ登録して現画面に留まる経路である。

### 6.7 到達位置・カーテン・保存

ジャンプが成立すると、結果最遠IDが`gptRevealTargetId`となる。画面側は実際にレンダーされた行を`geometry()`で測り、`positionCurtain()`がtarget行のbottomを`revealY`へ反映する。別ページjumpでは候補view/sessionを作る。同一ページでは既存revealYよりターゲットが手前にならないよう、アンカーを境界に合わせて調整する。

`studyProgress`はjump成立時に最遠結果IDまで進めるが、その区間の中間問題を`studiedIds`に一括登録しない。active page内のprovisionalな結果IDだけがstudied/checkedとstudyCountに追加される。GPTカーテン移動では通常`processRevealProgress()`を呼ばない。

`updateGptSkippedResults()`は結果IDだけを扱い、未返却IDを推定しない。現在active sessionで開示済みのIDを保護し、そのIDのGPT結果でスキップマスクを付けない。snapshotは`saveCoreTransition()`経由でstudy state、session、registered GPT IDs、`studyProgress`、`gptSkipped`をまとめて保存する。関連するview書き込みは失敗時にrollbackされる。保存成功後にメモリ状態を差し替えてrenderする。

## 7. `skipped`と結果なし

| 状態 | 定義 | 永続化 | 到達位置 |
|---|---|---|---|
| `skipped` | 結果JSONに明示されたresult | `gptSkipped.ids`に保存。ただし現在セッションで開示済みのIDは保護され、スキップ状態を解除。 | 実結果として最前・最遠位置の対象。 |
| 結果なし | 発行IDが結果JSONにない | 専用のunanswered状態は保存しない。 | 位置判定に含めない。 |

GPTによる到達位置移動のみでは、中間の結果なし問題を`studiedIds`へ加えたり、`studyCount`を増やしたりしない。ただし、現行実装では後続の**通常ドラッグ**で結果なしIDが通常閾値により開示される場合がある。一方、明示的skipped IDは`processRevealThresholds()`のblocked IDとして自動開示を防ぐ。同じ「－」表示でもこの操作差がある。統一は未実装の変更候補であり、この章は現行挙動を記録する。

この自動開示の差は、「－」から個別開示する操作の差ではない。現在のカーテン内で「－」が有効なら、skippedと結果なしのどちらも同じ個別開示処理へ進む。カーテンをドラッグして通過する場合の条件だけが異なる。

## 8. ページ遷移と復元

- `requestViewTransition()`は`transitionView()`を呼び、既定ではactive sessionの暫定結果を確定して次の対象・sessionを保存する。confirmの有無は呼び出すUI操作側で決まる。
- 通常順・ランダム順の切替、習得除外切替、閾値・ページサイズ変更はそれぞれイベント側の確認・再構築規則を使う。ランダム再シャッフル時にはrandomカーソルを無効化する。
- `activeSession.viewState`は再読み込み時の保存view設定補助に使われる。`tryRestoreSession()`はsession key、target ID列、studied/checked/finalizedの整合を検査する。
- active sessionが現在の対象と一致して復元できる場合は暫定状態とrevealYを復元する。安全に復元できない場合は、保存済み露出結果を確定して新しいsessionを開始する経路がある。
- `gptRevealTargetId`はactiveSessionに保存され、再描画時にDOMの実測境界へ変換される。手動カーテンドラッグ位置を保存する際にアンカーは解除される。
- `studyProgress`はsnapshot内に独立保存される。`resolveGptContinuationStart()`は選択中モードと全identityが一致しなければカーソルを使わず、現在ページ先頭へfallbackする。
- `gptSkipped`は問題ID・問題文・解答のfingerprint一致が必要。問題や解答の変更・IDの別内容再利用は古いmask集合を無効にする。問題順やタイトルだけの変更ではそのcontent fingerprintを変えない。別のorder cursorは順序fingerprintで検証する。

## 9. 進捗可視化

`buildProgressSummary()`は全登録問題から習得済み数・習得率を計算し、`currentStreak >= masteryThreshold`で習得を判定する。分布は`studyCount`を使い、all/unmasteredを切り替える。active sessionの暫定評価を履歴から差し引かない。画面側`renderProgressSummary()`はホーム、学習画面、詳細dialogで同じ習得率summaryを表示し、解答開示後は分布も更新する。

これは表示用集計で、習得除外設定やページの表示範囲に習得率母数は依存しない。分布対象切替は画面内stateのみで、学習保存状態の変更ではない。

## 10. 主要な不変条件と根拠

以下は実装・テストで確認できる性質であり、根拠のない一般的な設計理念を追加したものではない。

1. 同じactive session内で同じIDを二重開示しても`recordStudy()`は再加算しない。
2. GPTのskippedと結果なしは別。skippedだけが`gptSkipped`へ入り、どちらもGPT import自体ではstudyCountを増やさない。
3. GPTの発行順・内容identityが現行wordsと合わない場合、jumpを許可しない。
4. `advanceStudyProgress()`は有効な同モードcursorを後退させない。
5. GPTの結果位置が連続性の許容位置より先なら、画面jumpを抑止する。formalizableな結果登録と画面遷移の可否は別である。
6. 未確定active disclosed IDへのGPT正誤重複を無視し、暫定状態を守る。既に確定した履歴があることだけでは現在session開示を意味しない。
7. GPTの結果範囲・カーテン位置は、すべての間のIDを学習済みにする根拠ではない。
8. `gptSkipped`と`studyProgress`は別データであり、前者はID mask、後者はモード別到達カーソル。
9. データ保存が成功する前に画面側のdraftを本状態へ置き換えない。`saveCoreTransition()`は関連キー書き込みに失敗した場合のrollbackを試みる。

主要テスト名は`test/study-core.test.js`の`GPT jump blocks outcomes beyond the cursor successor...`、`GPT gap check uses returned issue positions...`、`GPT jump with absent or invalid cursor...`、`GPT integration keeps active session on no-jump...`、`GPT result for an already disclosed active row...`、`processRevealThresholds does not auto-disclose explicitly GPT-skipped rows`、`last disclosure progress survives core persistence...`等を参照する。

## 11. 設計意図の根拠と限界

- **コード・テストで確認できる根拠**：`study-core.js`の冒頭コメントはこのモジュールを学習履歴・GPT結果の純粋処理と位置付ける。ガード条件は重複開示を抑え、コメントは旧フィルターからの安全な移行を説明する。テストはskippedと結果なし、カーソル連続性、jump抑止、履歴不変を明示的に検証する。
- **過去の合意として確認できる意図**：GPT結果は発行順の連続性を守り、結果のない中間問題を学習済みにしない。到達カーソルは後退させず、未確定の通常学習結果はGPT結果から保護する。
- **断定しないこと**：履歴出所を保存しない理由や、どの理由で現在の仕様差が選ばれたかはコードだけから確定できない。本書ではその理由を推定しない。

## 12. 変更候補・未解決事項

### 12.1 「－」表示と開示動作

#### 現行実装

- GPTから明示された`skipped`は`gptSkipped`へ保存され、通常ドラッグによる自動開示対象から除外される。
- 結果なしIDは独立状態として保存されず、通常ドラッグで開示対象になる場合がある。
- GPT結果によってカーテンが進んでも、その中間の未開示問題を自動的に`studiedIds`へ加えたり、`studyCount`を増やしたりしない。
- カーテンが通過した範囲で有効になった「－」から個別開示する操作は、skippedと結果なしで共通している。対象問題だけを通常学習として開示・記録する。

#### 合意済み変更方針

- カーテン通過後の「－」表示では、明示的skippedか結果なしかによって個別開示操作を分けない。
- 通常モードと今後のカーテンロックモードで、解答を開示し、対象問題だけを学習記録へ反映する基本ルールを共通にする。
- GPT結果の到達位置計算では、明示的`skipped`を実結果として含め、結果なしを含めない。この区別は維持する。

#### 未確定の実装詳細

- 通常ドラッグ時の自動開示条件をどう整理すれば上記方針と整合するかは、現行コードと照合して詳細を決める必要がある。
- この方針はまだ未実装である。現行コードの動作として扱わない。

### 12.2 下部操作フッター

#### 現行実装

- 「もう一度学習」「次へ」等の操作は、リストの後にある`.study-actions`領域に配置されている。学習途中でも常時画面下部に固定表示する共通フッターではない。
- カーテンロックモードは未実装。

#### 合意済み変更方針

- 「もう一度学習」「次へ」を通常モード・カーテンロックモード共通で使える下部操作フッターとして扱う。
- 学習途中でも操作できるよう画面下部に表示する。

#### 未確定の実装詳細

- 既存のリスト末尾ボタンを残すか、フッターへ一本化するかは未決定。
- DOM構造、配置、画面サイズごとの表示方法・スクロール制御も未決定。
- フッターは未実装であり、現行機能として案内しない。

### 12.3 その他の変更候補

- **カーテンロック**：リストをスクロールしながら固定境界で開示する方式。具体的な実装詳細は未確定。
- **先端復帰**：現在の到達IDへスクロールして戻る操作。具体的な実装詳細は未確定。
- **履歴出所**：過去の正誤・studyCountが通常学習かGPTかを識別するsource履歴は存在しない。保存方式を追加する合意はない。
- **結果語彙**：コードは`uncertain`を受理し、正答以外として扱う。UI/payload契約を変更する場合は現行実装と既存記録との互換を確認する。

新機能の実装前には、該当状態の永続性、順序fingerprint、activeSessionの復元条件、および結果JSONが発行sessionへ結び付いているかを先に確認する。

## 13. 根拠ファイル

- `study-core.js`: `normalizeGptSessionRecords`, `normalizeStudyProgress`, `studyContentFingerprint`, `normalizeGptSkippedState`, `saveCore`, `saveCoreTransition`, `resolveGptContinuationStart`, `selectGptWords`, `studyOrderIdentity`, `recordStudyDisclosure`, `advanceStudyProgress`, `compareStudyProgress`, `createGptIssueContext`, `evaluateGptJump`, `processRevealThresholds`, `tryRestoreSession`, `normalizeState`, `recordStudy`, `setSessionAnswer`, `finalizeStudySession`, `inspectGptResults`, `prepareGptIntegration`, `buildProgressSummary`.
- `index.html`: storage constants and initialization; `writeCoreSnapshot`, `saveActiveSession`, `tryRestoreSession`, `transitionView`, `markStudied`, `canIndividuallyDisclose`, `syncAnswerControl`, `syncMeaningDisclosure`, `toggleAnswer`, `renderProgressSummary`, `geometry`, `processRevealProgress`, `positionCurtain`, `attachCurtainDrag`, `makeGptSession`, `applyGptResults`.
- `test/study-core.test.js`: pure logic contracts, snapshot migration/rollback, GPT issue context and result validation, jump/continuity/formal-only branches, skipped/missing distinction, active-session overlap protection, disclosure and restoration contracts.

本書の基準コードは`e06bf6414f7c30f0dee2b7fd63fadfa9ea33e6d9`。後続commitで契約が変わった場合は、基準を更新して本書も改訂する。
