# TAKEAWAYS

このドキュメントは、mekiki-bot のMVP開発で得た要点・調整ポイント・残課題を「次に再開するとき迷子にならない」ために記録する。

---

## 0. 現状サマリ（完成したこと）

MVPとして必要だった主要機能は揃っている、という認識でOK。

### 実装済み（動作確認済み）
- RSS取得（cursor/grace/dedupe）: `/sync` で実行
- 取得記事の要約 + シグナル抽出 + #feed-aiカード投稿
- Keep/Unsure/Discard ボタン + #library（Forum）upsert
- 手動投入: `#inbox-manual` / DM / `/ingest`
- Taste Profile（嗜好プロファイル: 好みルールを文章として保持; なぜこの名: 監査・編集しやすい）提案 → 承認フロー
- 学習バッチ: `/learn run`（および interval）
- Serving Policy（投稿選抜ポリシー; なぜこの名: “全件投稿”を止め学習を推薦に反映するため）
  - Stage 0: 候補生成 + フィルタ
  - Stage 1: Preselect（軽量スコアでtopK）
  - Stage 2: LLM Judge（Taste Profileを使って post_score/bucket/reason を出す、キャッシュあり）
  - Stage 3: Portfolio配分 + MMR多様性 + 探索枠
  - Stage 4: #feed-aiに最大N件だけ投稿（opsに選抜レポート）
- P1 Scheduler（定期実行器; なぜこの名: “起動中は自動で回る”を実現）
  - RSS同期（manual_sync_only=false のとき）
  - 学習（profile_update.yaml の scheduler.mode に interval が含まれるとき）
  - Proposal期限切れ（expire_hours）
- run_on_start: 起動直後に sync/learn を即1回（任意）
- `--once` モード: `node dist/index.js --once` で expire→sync→learn→安全終了（外部スケジューラ向け）
- Windows タスクスケジューラ用 `scripts/run-once.bat`

---

## 1. 運用の基本ループ（何がどう回っているか）

### 1) 記事の供給（RSS→候補）
- RSSから記事を取り込み、dedupe後に候補を作る。

### 2) 投稿の選抜（Serving Policy）
- “全件投稿”はしない。候補から最大N件だけ #feed-ai に投稿。
- topKだけ LLM Judge を使い、post_score/bucket/reason を得る（再判定はキャッシュで回避）。
- ポートフォリオ（カテゴリ配分）+ MMR（類似抑制）+ 探索枠で最終選抜。

### 3) ユーザー行動ログ（Action Events）
- #feed-aiカードへの Keep/Unsure/Discard は軽量ログ（即時学習しない）。
- 手動投入（#inbox-manual）は USER_SEEDED として別レーンで保存（重みが濃い前提）。

### 4) Taste Profile 学習（承認式）
- `/learn run` または interval で、行動ログをまとめてサンプルしてLLMに渡し、Taste Profile更新案（Proposal）を生成。
- #ops-bot に Proposal（Preview）が投稿される。
- ✅Approve/🗑Reject/📝Edit により ACTIVE な Taste Profile が決まる。
- ACTIVE Taste Profile は Serving Policy の LLM Judge 入力として使われ、推薦に反映される。

---

## 2. コードを触らずに調整できる箇所（重要）

以下は基本的に `spec/` や `docs/` 変更で調整できる（実装変更が不要な範囲）。

1) RSS ソース管理
- `spec/rss/rss_source.json` など（追加/削除/有効化）

2) LLM モデル選択（タスク別）
- `spec/llm/task_routing.json`
- temperature / 出力言語 / token上限はタスク実装側の設定も要確認

3) Serving Policy（投稿量・バランスの中枢）
- `spec/serving/serving_policy.yaml`
  - max_posts_per_cycle
  - preselect重み
  - portfolio配分
  - diversity(MMR)
  - exploration（探索枠）

4) Serving Prompt（選抜品質に最も影響）
- `spec/serving/serving_prompt.md`

5) 学習パラメータ（time decay / fatigue / 重み）
- `spec/learning/*`（学習ロジックが参照する設定）

6) 学習バッチ設定（頻度・サンプリング・提案ルール）
- `spec/learning/profile_update.yaml`

7) Profile更新プロンプト / Seed
- `spec/learning/profile_update_prompt.md`
- `spec/learning/taste_profile_seed.md`

8) シグナル語彙（抽出の語彙・辞書）
- `spec/learning/...` or `spec/signals/...`（プロジェクトの配置に従う）

9) タグマッピング / Forum タグ
- `spec/learning/tag_map.yaml`
- `spec/forum/forum_tags.yaml`

10) カード・Libraryテンプレート
- `spec/templates/feed_card.template.md`
- `spec/templates/library_post.template.md`

11) チャンネル設定 / UIコンポーネント / 状態遷移
- `spec/ux/channels.yaml`
- `spec/ux/components.yaml`
- `spec/ux/state_machine.yaml`

---

## 3. リセット方法（テストで頻繁に使う）

### フルリセット（最も確実）
- DBを削除して再生成
  - 例: `rm data/mekiki.db`（実際のパスはRUNBOOK準拠）

### 部分リセット（SQLでピンポイント）
用途に応じて個別削除する（例）
- RSSカーソルだけ戻す（再取得したい）
- dedupeキャッシュだけ消す（重複判定やり直し）
- serve_judgement_cache だけ消す（LLM Judgeやり直し）
- actions_log / learning_runs を消す（学習材料をリセット）
- taste_profile_versions / proposals を消す（プロファイルを初期化）
- evidence を消す（取り込みからやり直し）

※具体SQLは DEVELOPERS.md / RUNBOOK を参照（更新済み）。

### Discord側クリーンアップ（必要時）
- #feed-ai の投稿が多すぎる/混ざった場合、手動削除やチャンネル整理。
- Forum #library の投稿整理（必要ならタグでフィルタして削除）。

---

## 4. 残っている懸念点と改善方針

### 4.1 Serving Prompt / Judge品質
懸念:
- “なぜ選ばれた/落ちた”が納得できないと、運用が辛い。

改善（推奨）:
- opsレポートを固定観点にする（採用理由/落選理由/効いたシグナル上位3つ）。
- Judge出力にスコア内訳を増やす（novelty/actionability/trust/time_sensitivity など）。
- “境界例”を少数入れて serving_prompt.md を育てる（Keep/Discardの代表例3〜5件）。

### 4.2 Portfolio bucket名の同期（重要）
懸念:
- bucketは文字列一致前提。LLMが逸脱すると配分制御が効かない。

改善（推奨）:
- schema enum逸脱時は「bucketだけ選び直して再出力」を1回リトライ。
- 最終的に OTHER にフォールバック。
- 将来: `spec/serving/buckets.yaml` を単一真実源にして、policy/prompt/schemaを同期。

### 4.3 duel / reason_menu の扱い
懸念:
- duel（A/B比較）は未実装。
- reason_menu の有用性は不明。

改善（推奨）:
- デフォルトOFF（確率0）で運用開始し、必要になったら段階導入。
- duelをやるなら4択（A/B/両方/どっちも無し）にして心理負担を下げる。

### 4.4 min_new_events_to_run が初期に重い
懸念:
- 初期は学習が走りにくい。

改善（推奨）:
- 初期は min_new_events_to_run を一時的に下げる（例: 5）。
- もしくは /learn run を手動で回す。
- 将来: `/learn run --force` の導入も検討。

### 4.5 Discord 2000文字制限
懸念:
- #feed-aiカードが長すぎると投稿失敗。

改善（推奨）:
- 投稿前に必ず clamp（要約文字数・signals個数・末尾truncated）。
- 将来: Embed利用で安全域を増やす。

### 4.6 Ollamaフォールバックが手動
懸念:
- プロバイダ障害時に /model set が必要。

改善（推奨）:
- タスク別に fallback chain（OpenAI→Anthropic→Ollama等）を設計。
- Circuit Breaker（遮断器; なぜこの名: 連続失敗時の待ち時間地獄を避ける）を検討。

---

## 5. プロンプト改善の方針（最小の当てどころ）

### Taste Profile更新（学習）
- 編集対象: `spec/learning/profile_update_prompt.md`
- 改善ポイント:
  - diff_summary を空にしない（変更なしでも "No material changes"）
  - Drift を “最近のDiscard傾向” から具体的に育てる
  - ルールは抽象ではなく判定可能な形に寄せる
  - 過学習（好きカテゴリ固定化）を避けるガードレールを明示

### Serving Judge（推薦）
- 編集対象: `spec/serving/serving_prompt.md`
- 改善ポイント:
  - bucket定義を短文で渡す（新規bucketを作りにくくする）
  - “採用/不採用の境界”を少数の具体例で固定する
  - reason は短く具体（後で人間が読める）

---

## 6. 再開時チェックリスト（5分で状況を掴む）
- `node dist/index.js --once` が最後まで完走するか
- #ops-bot に「選抜理由レポート」が出るか
- #ops-bot の Proposal Preview が `/learn profile` と一致するか
- serving_policy.yaml の max_posts_per_cycle / explore_share を適切な量に調整したか
- bucketが enum から逸脱していないか（opsログで確認）
