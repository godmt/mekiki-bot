# RUNBOOK — 運用手順書

## 1. 設計思想

- Botは**常時稼働しない前提**。必要なときに起動し、使い終わったら止めてよい
- 再起動時は RSS cursor + grace window で中断箇所から再開。dedupeにより重複投稿なし
- 多重起動は `data/mekiki.lock` で自動防止
- 起動モード: 常駐 / `--once`（一括実行→終了） / `--test-sync`（テスト→終了）

---

## 2. 初期セットアップ

### 2.1 前提
- Node.js 20+
- Discord Bot Token（Message Content Intent 有効化済み）
- LLM API Key（最低1つ: OpenAI / Anthropic / Google のいずれか）

### 2.2 手順

```bash
npm install
cp .env.example .env   # テンプレがない場合は手動作成
```

`.env` に必要な環境変数:

| 変数名 | 必須 | 説明 |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Discord Bot Token |
| `OPENAI_API_KEY` | 推奨 | summarize_feed, serve_judge で使用 |
| `GOOGLE_API_KEY` | 推奨 | extract_signals で使用 |
| `ANTHROPIC_API_KEY` | 任意 | library_writeup で使用 |

未設定のプロバイダのタスクは `llm_config.json` の activeProvider にフォールバックする。

### 2.3 設定ファイルの調整

| ファイル | 何を設定するか |
|---|---|
| `spec/ux/channels.yaml` | チャンネル名、runtime設定 (manual_sync_only, run_on_start) |
| `spec/rss/rss_sources.json` | RSSフィード（id, feed_url, enabled, default_signals） |
| `spec/llm/llm_config.json` | アクティブLLMプロバイダ/モデル、language ("ja") |
| `spec/llm/task_routing.json` | タスク別モデルルーティング |
| `spec/serving/serving_policy.yaml` | 投稿選抜ポリシー（max_posts_per_cycle 等） |
| `spec/learning/profile_update.yaml` | 学習スケジューラ設定 (interval, min_events, expire_hours) |

---

## 3. 起動・停止

### 起動モード

| フラグ | 動作 | 用途 |
|---|---|---|
| (なし) | 常駐モード。スケジューラ有効、コマンド受付 | 通常運用 |
| `--once` | sync→learn→expire→自動終了 | 外部スケジューラ連携 |
| `--test-sync` | 1ソース×3件のみ同期→自動終了 | 動作確認テスト |

```bash
# 開発モード（ts直接実行）
npm run dev

# 本番モード
npm run build && node dist/index.js

# バックグラウンド起動（ログをファイルへ）
node dist/index.js > logs/bot.output 2>&1 &

# 一括実行（外部スケジューラ用）
node dist/index.js --once
```

正常起動時のログ:

```
[mekiki-bot] Starting...
[spec] All 8 schema validations passed.
[mekiki-bot] Spec loaded and validated.
[ollama] Detected N models: ...
[mekiki-bot] Database initialized.
[discord] Logged in as あいきき#5098
[commands] Registered 7 slash commands to guild XXXX.
[discord] Channels resolved: { feedAi: '#feed-ai', ops: '#ops-bot', ... }
[tags] All 10 forum tags already exist.
[scheduler] Sync: disabled (manual_sync_only=true)
[scheduler] Learning: enabled (every 360 min)
[scheduler] Proposal expire: enabled (check every 30 min)
```

### 停止

Ctrl+C またはプロセスkill。ロックファイルは自動解除される。
クラッシュでロックが残った場合は `data/mekiki.lock` を手動削除。

---

## 4. 日常運用

### 4.1 RSS同期（/sync）

```
/sync
```

処理フロー:
1. **Phase 1: RSS取得 → DB ingest** — 全ソースからRSS取得、LLMで要約+シグナル抽出、evidenceテーブルに格納
2. **Phase 2: Serving Pipeline** — 候補フィルタ → Preselect (top K) → LLM Judge → Portfolio配分 + MMR多様性 + 探索枠
3. **Phase 3: 投稿** — 選抜された最大8件を #feed-ai にカード投稿

選抜レポートが `#ops-bot` に投稿される（例）:

```
📊 Serving Report — candidates: 12, LLM judged: 8, cached: 4, skipped: 0
Selected 8 items:
• `source:hash` — タイトル | score=0.85 final=0.92 bucket=AI_LLM
```

> **初回実行時の注意:** 過去14日分のRSSを取得するため LLM 呼び出しが多くなる（数百回）。テスト時は `spec/rss/rss_sources.json` で `enabled: false` にして1フィードだけ有効にすると安全。

### 4.2 カード操作（#feed-ai）

| ボタン | 動作 |
|---|---|
| Keep | #library にForum投稿を作成/更新。学習データとして記録 |
| Unsure | #library にForum投稿を作成/更新（Keepより弱い学習シグナル） |
| Discard | アーカイブせず。学習データとして記録 |
| Open | 元URLを返信 |
| Note | モーダルでメモを追加 |

### 4.3 手動投入

| 方法 | 説明 |
|---|---|
| `#inbox-manual` にURLを貼る | 自動でEvidence化 → #feed-ai にカード投稿 |
| `/ingest input:<URL or テキスト>` | スラッシュコマンドで投入 |
| Bot に DM | #inbox-manual と同じ動作 |

手動投入はServing Pipelineをバイパスし、即座に #feed-ai に投稿される。

### 4.4 目利き学習（/learn）

```
/learn run       # 学習バッチ実行 → Taste Profile 更新案を #ops-bot に投稿
/learn profile   # 現在の Taste Profile を表示
```

学習の流れ:
1. Keep/Unsure/Discard の履歴を集計
2. LLM が Taste Profile の更新案（Proposal）を生成
3. `#ops-bot` に Approve / Reject / Edit ボタン付きで投稿
4. Approve → Profile更新、以降の Serving Pipeline (serve_judge) に反映

### 4.5 設定変更（/config, /model）

```
/config show                    # 現在の設定一覧
/config set key:<項目> value:<値>  # 設定変更

/model show                     # 現在のアクティブモデル
/model list                     # プロバイダ別モデル一覧（APIキー状態付き）
/model set provider:<名> model:<ID>  # モデル切替
```

`/config set` で変更可能な項目: `language`, `min_new_events_to_run`, `lookback_days`, `manual_boost`, `half_life_days`, `proposal_expire_hours`

### 4.6 一時停止・再開

```
/pause    # RSS取り込み停止（ボタン操作は引き続き可能）
/resume   # 再開
```

### 4.7 スケジューラ（Bot内定期実行）

Bot起動中に自動で以下のタスクが定期実行される。設定OFFなら手動コマンドのみ。

| タスク | 間隔 | 有効条件 | 設定箇所 |
|---|---|---|---|
| RSS同期 | 60分 | `channels.yaml` の `manual_sync_only: false` | `spec/ux/channels.yaml` |
| 学習バッチ | 360分 | `profile_update.yaml` の `mode` に `"interval"` を含む | `spec/learning/profile_update.yaml` |
| Proposal期限切れ | 30分 | 常に有効 | `profile_update.yaml` の `expire_hours` |

**現在のデフォルト:**
- Sync: **無効** (`manual_sync_only: true`)
- Learning: **有効** (6時間ごと、`min_new_events_to_run: 20` 未満ならスキップ)
- Proposal expire: **有効** (72時間で期限切れ → `#ops-bot` に通知)

**自動Syncを有効にするには:**

`spec/ux/channels.yaml` を編集:

```yaml
runtime:
  manual_sync_only: false    # ← true → false に変更
```

**起動直後に実行させたい場合 (`run_on_start`):**

```yaml
runtime:
  run_on_start: true    # 起動直後に sync + learn を1回実行
```

**二重実行防止:** 前回のsyncや学習がまだ実行中の場合、次のインターバルはスキップされる。`/sync` コマンドとの同時実行も防止される。

---

## 5. Serving Policy（投稿選抜）

全RSSアイテムを投稿するのではなく、Taste Profileに基づいて選抜する。

### パイプライン概要

| Stage | 処理 | 設定ファイル |
|---|---|---|
| Stage 0 | 候補生成: lookback 72h、フィルタ（投稿済み除外、Discard除外、鮮度、ソース偏り制限） | `serving_policy.yaml` → candidates, filters |
| Stage 1 | Preselect: recency×0.35 + signal×0.55 + diversity×0.10 でスコア → top 20 | → preselect |
| Stage 2 | LLM Judge: Taste Profile + 記事情報でpost_score (0-1) + bucket判定。結果はDBに30日間キャッシュ | → llm_judge |
| Stage 3 | Portfolio配分: bucket別target_shareに対する不足分を deficit_boost で加点 | → portfolio |
| Stage 4 | MMR多様性: 類似記事の連投を token Jaccard で抑制。15%は探索枠 | → diversity, exploration |

### 主要パラメータ

| パラメータ | デフォルト | 説明 |
|---|---|---|
| `max_posts_per_cycle` | 8 | 1回の /sync で最大何件投稿するか |
| `top_k_for_llm` | 20 | LLM Judge に渡す候補数 |
| `explore_share` | 0.15 | 探索枠の割合 |
| `lambda` (MMR) | 0.75 | 1.0寄り=関連性優先、0寄り=多様性優先 |
| `cache.ttl_days` | 30 | LLM判定結果のキャッシュ有効期間 |

---

## 6. Cursor と RSS 同期

### cursor の仕組み

```
since = max(last_fetch_at - grace_hours, now - max_catchup_days)
```

- `last_fetch_at`: 前回の取得日時（`rss_cursors` テーブルに保存）
- `grace_hours`: 遅延配信に備えた安全マージン（デフォルト: channels.yaml で設定）
- `max_catchup_days`: 初回または長期停止後の最大遡り日数（デフォルト: 14日）
- dedupe: URL の SHA256 ハッシュで重複排除（`seen_items` テーブル）

### RSS cursor をリセットしたい場合

```bash
sqlite3 data/mekiki.db "DELETE FROM rss_cursors WHERE source_id = 'xxx';"
sqlite3 data/mekiki.db "DELETE FROM rss_cursors;"   # 全リセット
```

---

## 7. データベース

SQLite ファイル: `data/mekiki.db`（`.gitignore` 済み）

### 主要テーブル

| テーブル | 内容 |
|---|---|
| `evidence` | 全記事/投入物。state (NEW/KEPT/UNSURE/DISCARDED), feed_message_id, library_thread_id |
| `actions_log` | Keep/Unsure/Discard等の全操作履歴（学習の入力データ） |
| `rss_cursors` | ソース別の最終取得日時 |
| `seen_items` | URL hash による重複排除 |
| `taste_profile_versions` | Taste Profile の全バージョン履歴 |
| `taste_profile_proposals` | LLM生成の更新提案 (pending/approved/rejected/expired) |
| `learning_runs` | 学習バッチの実行履歴 |
| `serve_judgement_cache` | LLM Judge の結果キャッシュ（TTL付き） |

### リセット・バックアップ

```bash
rm data/mekiki.db                                      # 次回起動時に再作成
cp data/mekiki.db data/mekiki_backup_$(date +%Y%m%d).db  # バックアップ
```

---

## 8. トラブルシュート

| 症状 | 原因・対処 |
|---|---|
| "Spec validation failed" | spec/ のファイルが壊れている。エラーメッセージにフィールド名が表示される |
| "Could not resolve channel" | Discord サーバーのチャンネル名が channels.yaml と不一致 |
| "Another instance is already running" | `data/mekiki.lock` を手動削除 |
| コマンドが出ない / 2重表示 | グローバルコマンドが残っている → DEVELOPERS.md のクリア手順を参照。Ctrl+Rで再読込 |
| LLM エラー | `.env` の API キー確認。`/model show` で現在のプロバイダ確認 |
| /sync が長い | 初回は数百件×2回のLLM呼出が走る。RSSソースを絞ってテスト推奨 |
| editReply タイムアウト | 15分超のsyncではinteraction期限切れだが、投稿自体は完了する。結果は #ops-bot で確認 |

---

## 9. ログ

ログ出力先: `logs/bot.output`

```bash
tail -f logs/bot.output           # リアルタイム監視
grep "\[serving\]" logs/bot.output  # Serving Pipeline のログだけ抽出
grep "\[sync\]" logs/bot.output     # Sync フローのログだけ抽出
grep "\[scheduler\]" logs/bot.output # スケジューラのログだけ抽出
grep "\[once\]" logs/bot.output     # --once モードのログだけ抽出
grep "error\|Error" logs/bot.output # エラーだけ抽出
```

---

## 10. 外部スケジューラで定時起動する（Bot非常駐運用）

Botを常時起動しない運用では、外部スケジューラから `--once` フラグで起動し、sync→learn→expire を一括実行して自動終了させる。

### --once モード（run-once: 起動→sync→learn→expire→終了）

```bash
node dist/index.js --once
```

処理の流れ:
1. Bot起動 → Discord接続
2. Proposal期限切れチェック
3. RSS同期（全ソース + Serving Pipeline で選抜投稿）
4. 学習バッチ（`min_new_events_to_run` 未満ならスキップ）
5. `#ops-bot` に完了レポート投稿
6. 3秒後に安全終了（Discord切断 + DB close + ロック解除）

### Windowsタスクスケジューラに登録（推奨）

**1) バッチスクリプト: `scripts/run-once.bat`**（同梱済み）

```bat
@echo off
cd /d D:\Program\mekiki-bot
call node dist/index.js --once >> logs\scheduled.log 2>&1
```

**2) タスクスケジューラに登録**

1. `taskschd.msc` を開く
2. 「タスクの作成」→ 以下を設定:
   - **全般:** 名前「mekiki-bot run-once」、「ユーザーがログオンしているかどうかに関わらず実行」
   - **トリガー:** 毎日、開始時刻を設定、「繰り返し間隔 2時間」「継続時間 無期限」
   - **操作:** プログラム `cmd.exe`、引数 `/c D:\Program\mekiki-bot\scripts\run-once.bat`
   - **設定:** 「タスクが既に実行中の場合: 新しいインスタンスを開始しない」

> ロックファイルにより、常駐Botが動いている間は `--once` が起動しても即終了する（二重起動防止）。

### cron（WSL / Linux）

```bash
0 */2 * * * cd /mnt/d/Program/mekiki-bot && node dist/index.js --once >> logs/cron.log 2>&1
```
