# mekiki-bot 開発メモ

## 前提

- Node.js 20+
- `.env` に `DISCORD_TOKEN` が設定済みであること
- LLM を使う場合は `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` も必要

## セットアップ

```bash
npm install
```

## 起動

```bash
npm run dev          # 開発モード（tsx で直接実行）
npm run build        # 本番ビルド（dist/ に出力）
node dist/index.js   # 本番起動
```

### 起動モード

| フラグ | 動作 |
|---|---|
| (なし) | 常駐モード。スケジューラ有効、スラッシュコマンド受付 |
| `--once` | sync→learn→expire を一括実行し自動終了 |
| `--test-sync` | 1ソース×3件のみ同期し自動終了（テスト用） |

正常なら以下のログが出る:

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

Discord の `#ops-bot` に起動メッセージが届く。

多重起動は `data/mekiki.lock` ファイルで防止される。前回クラッシュしてロックファイルが残っている場合は自動で除去される。

## 型チェック / Lint

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/
```

## スラッシュコマンド（Discord上で実行）

| コマンド | 説明 |
|---|---|
| `/sync` | RSS取得 → Serving Pipeline → 選抜投稿 |
| `/pause` | RSS取り込み一時停止（ボタンは動く） |
| `/resume` | 再開 |
| `/model show` | 現在のLLMプロバイダ/モデルを表示 |
| `/model list` | プロバイダ別モデル一覧（APIキー状態付き） |
| `/model set provider:<名前> model:<ID>` | LLMモデルを切り替え |
| `/ingest input:<URL or テキスト>` | 手動でURLやテキストを投入 |
| `/learn run` | 学習バッチ実行 → Taste Profile 更新案を `#ops-bot` に投稿 |
| `/learn profile` | 現在の Taste Profile を表示 |
| `/config show` | 現在の設定一覧 |
| `/config set key:<項目> value:<値>` | 設定変更 |

> **注意:** `/sync` は初回実行時、過去14日分のRSSを取得するため LLM 呼び出しが多くなる。テスト時は `spec/rss/rss_sources.json` で `enabled: false` にして1フィードだけ有効にすると安全。

## 手動投入（#inbox-manual）

`#inbox-manual` チャンネルにURLやテキストを貼ると、Bot が自動で LLM 要約して `#feed-ai` にカード投稿する。成功時は ✅、失敗時は ❌ のリアクションが付く。

Bot への DM でも同様に動作する。

`spec/ux/channels.yaml` で `inbox_manual.auto_label: "keep"` が設定されている場合、投入と同時に自動で KEEP 状態になり `#library` にも投稿される。

## スケジューラ

Bot内で以下のタスクが定期実行される（設定次第）:

| タスク | 間隔 | 有効条件 |
|---|---|---|
| RSS同期 | 60分 | `channels.yaml` の `manual_sync_only: false` |
| 学習バッチ | 360分 | `profile_update.yaml` の `mode` に `"interval"` を含む |
| Proposal期限切れ | 30分 | 常に有効（72時間で expired） |

`runtime.run_on_start: true` で起動直後にも sync + learn を1回実行する。

## 目利き学習 (Taste Profile)

### 学習の流れ

1. ユーザーが `#feed-ai` のカードに Keep / Unsure / Discard をつける（＝学習データ）
2. `/learn run` またはスケジューラが学習バッチを実行
3. LLM が Taste Profile の更新案（Proposal）を生成
4. `#ops-bot` に Approve / Reject / Edit ボタン付きで投稿
5. Approve → Profile更新 → 以降の Serving Pipeline (serve_judge) に反映
6. 72時間応答がなければ Proposal は自動で expired

### 学習結果の確認方法

| 方法 | コマンド / 場所 | 内容 |
|---|---|---|
| **現在の Profile** | `/learn profile` | 現在有効な Taste Profile (Markdown) を表示 |
| **Proposal 履歴** | `#ops-bot` チャンネル | 過去の Proposal と承認/却下の記録が残る |
| **DB 直接参照** | `data/mekiki.db` | `taste_profile_versions` に全バージョン、`taste_profile_proposals` に全提案 |

## データベース

SQLite ファイルは `data/mekiki.db` に保存される（`.gitignore` 済み）。

### テーブル一覧

| テーブル | 内容 |
|---|---|
| `evidence` | 全記事/投入物 (state, feed_message_id, library_thread_id, origin) |
| `actions_log` | Keep/Unsure/Discard等の全操作履歴 |
| `rss_cursors` | ソース別の最終取得日時 |
| `seen_items` | URL hash による重複排除 |
| `taste_profile_versions` | Taste Profile の全バージョン履歴 |
| `taste_profile_proposals` | LLM生成の更新提案 (pending/approved/rejected/expired) |
| `learning_runs` | 学習バッチの実行履歴 |
| `serve_judgement_cache` | LLM Judge の結果キャッシュ（TTL付き） |

---

## リセット方法

### フルリセット（DB 全削除）

Bot を停止してから実行:

```bash
rm data/mekiki.db
rm -f data/mekiki.lock
# 次回起動時に空のDBが再作成される。Taste Profile は seed に戻る。
```

### 部分リセット

Bot を停止してから `sqlite3 data/mekiki.db` で実行（または任意の SQLite クライアント）:

```sql
-- RSS カーソルのみリセット（次回 /sync で過去14日分を再取得）
DELETE FROM rss_cursors;

-- 重複排除キャッシュをクリア（同じ記事を再取得可能にする）
DELETE FROM seen_items;

-- Serving Pipeline の LLM Judge キャッシュをクリア（全記事を再判定）
DELETE FROM serve_judgement_cache;

-- 学習データのみリセット（Keep/Discard の操作履歴を消す）
DELETE FROM actions_log;

-- Taste Profile を seed に戻す（全バージョン・全 Proposal を消す）
DELETE FROM taste_profile_versions;
DELETE FROM taste_profile_proposals;
DELETE FROM learning_runs;
-- → 次回起動時に taste_profile_seed.md が再読み込みされる

-- 全 Evidence を消す（#feed-ai のメッセージは Discord 上に残る）
DELETE FROM evidence;
DELETE FROM actions_log;
DELETE FROM seen_items;
DELETE FROM serve_judgement_cache;
```

> **注意:** DB を変更する前に必ず Bot を停止すること。SQLite の WAL モードで同時アクセスすると壊れる可能性がある。

### Discord 側のクリーンアップ

DB をリセットしても Discord 上の既存メッセージは残る。チャンネルごと消したい場合:

1. `#feed-ai` のメッセージを手動で一括削除（または チャンネル削除→再作成）
2. `#library` の Forum スレッドを手動で削除
3. チャンネルを再作成した場合は `spec/ux/channels.yaml` の `id` を更新

---

## コードを触らずに調整できる箇所

以下はすべて `spec/` 配下の設定ファイルで、コード変更なしに挙動を調整できる。変更後は Bot の再起動が必要（起動時にスキーマ検証される）。

### 1. RSS ソース管理 — `spec/rss/rss_sources.json`

```jsonc
{
  "id": "4gamer",
  "title": "4Gamer.net",
  "feed_url": "https://www.4gamer.net/rss/index.xml",
  "enabled": true,              // false にすると取得スキップ
  "default_signals": ["#ニュース", "#実務直結"],  // 記事に付くデフォルトシグナル
  "grace_hours": 6,             // カーソル巻き戻し幅（取りこぼし防止）
  "max_catchup_days": 14        // 初回 or 長期停止後の最大遡り日数
}
```

- フィードの追加・削除・無効化はここだけで完結する
- `default_signals` は LLM が抽出したシグナルに追加される（上書きではない）
- テスト時は1フィードだけ `enabled: true` にして他を `false` にすると LLM コスト節約

### 2. LLM モデル選択 — `spec/llm/`

#### `llm_config.json` — グローバル設定

| キー | 説明 |
|---|---|
| `language` | LLM 出力言語（`"ja"` / `"en"`）。プロンプトに渡される |
| `activeProvider` / `activeModel` | デフォルトのプロバイダ/モデル（task_routing で上書きされないタスク用） |
| `defaults.temperature` | デフォルト temperature（現在 0.2）|
| `defaults.maxOutputTokens` | デフォルト最大出力トークン（現在 450） |

#### `task_routing.json` — タスク別モデル振り分け

各 LLM タスクに異なるプロバイダ/モデルを割り当てられる:

| タスク名 | 用途 | 呼ばれる頻度 |
|---|---|---|
| `summarize_feed` | RSS 記事の要約生成 | 毎 /sync × 記事数 |
| `extract_signals` | 記事からシグナルタグ抽出 | 毎 /sync × 記事数 |
| `serve_judge` | 投稿選抜の LLM 判定 | 毎 /sync × preselect 通過数 |
| `library_writeup` | #library 投稿の長文生成 | Keep/Unsure 時のみ |
| `taste_profile_propose` | Taste Profile 更新案の生成 | /learn run 時のみ |

```jsonc
{
  "summarize_feed": { "provider": "openai", "model": "gpt-4o-mini" },
  "serve_judge":    { "provider": "google", "model": "gemini-2.5-flash" }
  // コスト重視: 頻度の高いタスクに安いモデルを割り当て
  // 品質重視: serve_judge や taste_profile_propose に高性能モデルを割り当て
}
```

#### `model_registry.json` — 利用可能モデル一覧

`/model list` で表示される。Ollama モデルは起動時に自動検出されて追加される。

### 3. Serving Policy（投稿選抜）— `spec/serving/serving_policy.yaml`

投稿の質と量を最も直接的に制御するファイル。

#### 投稿量の調整

| パラメータ | 現在値 | 説明 |
|---|---|---|
| `posting.max_posts_per_cycle` | 8 | 1回の /sync で最大何件投稿するか |
| `candidates.lookback_hours` | 72 | 候補として何時間前までの記事を対象にするか |
| `candidates.max_candidates` | 200 | 候補の上限数 |
| `filters.recency.max_age_hours` | 168 (7日) | これより古い記事は候補から除外 |
| `filters.per_source_cap.max_per_cycle` | 3 | 1ソースあたりの投稿上限（偏り防止） |

#### LLM Judge の設定

| パラメータ | 現在値 | 説明 |
|---|---|---|
| `preselect.top_k_for_llm` | 20 | ヒューリスティック選抜後、LLM に渡す件数 |
| `llm_judge.timeout_ms` | 25000 | LLM 判定のタイムアウト |
| `llm_judge.cache.ttl_days` | 30 | 判定キャッシュの有効期間 |

#### Preselect（粗選別）の重み

| パラメータ | 現在値 | 説明 |
|---|---|---|
| `preselect.scoring.recency_weight` | 0.35 | 新しい記事ほど高スコア |
| `preselect.scoring.signal_weight` | 0.55 | シグナルの多い記事ほど高スコア |
| `preselect.scoring.source_diversity_bonus` | 0.10 | ソースが偏らないボーナス |

#### Portfolio（カテゴリ配分）

```yaml
portfolio:
  target_share:
    DEVTOOLS: 0.20        # 開発ツール系を20%
    AI_LLM: 0.20          # AI/LLM系を20%
    XR_VTUBER: 0.10       # XR/VTuber系を10%
    GAME_INDUSTRY: 0.15
    ECON_POLICY: 0.10
    GENERAL_NEWS: 0.10
    SERENDIPITY: 0.15     # 意外な発見枠
  deficit_boost: 0.35     # 不足カテゴリの優先度ブースト（0〜1）
```

- bucket 名は LLM Judge の出力 (`serve_judgement.schema.json` の `bucket`) と一致させる
- `deficit_boost` を上げると不足カテゴリがより積極的に選ばれる
- 新しいカテゴリを追加する場合は `serve_judgement.schema.json` の `bucket` enum にも追加が必要

#### 多様性と探索

| パラメータ | 現在値 | 説明 |
|---|---|---|
| `diversity.lambda` | 0.75 | 1.0 = 関連性重視、0.0 = 多様性重視 |
| `exploration.explore_share` | 0.15 | 投稿枠の15%を探索枠に割り当て |
| `exploration.uncertain_score_range` | [0.35, 0.65] | この範囲のスコアを「不確実」と見なして探索対象にする |

### 4. Serving Prompt — `spec/serving/serving_prompt.md`

LLM Judge に渡すシステムプロンプト。`post_score` の付け方の基準や、`bucket` の分類方針を自然言語で指示する。選抜結果の品質に最も影響する。

### 5. 学習パラメータ — `spec/learning/`

#### `learning_config.yaml` — スコアリング重み

| パラメータ | 現在値 | 説明 |
|---|---|---|
| `time_decay.half_life_days` | 21 | 古い操作ほど影響が薄れる（半減期） |
| `fatigue.window_days` | 14 | 連続 Discard を検出する期間 |
| `fatigue.discard_streak_threshold` | 3 | 何連続 Discard でペナルティ発動 |
| `fatigue.penalty_multiplier` | 0.80 | ペナルティ係数（1.0 未満で減衰） |
| `scoring.keep_weight` | 1.0 | Keep 操作の重み |
| `scoring.unsure_weight` | 0.2 | Unsure 操作の重み |
| `scoring.discard_weight` | -1.0 | Discard 操作の重み |
| `scoring.manual_boost` | 1.5 | 手動投入（inbox/DM）由来のスコア倍率 |

#### `profile_update.yaml` — 学習バッチ設定

| パラメータ | 現在値 | 説明 |
|---|---|---|
| `scheduler.interval_minutes` | 360 | 自動学習の間隔（分） |
| `scheduler.min_new_events_to_run` | 20 | 新規イベントがこれ未満ならスキップ |
| `sampling.lookback_days` | 60 | 学習データの遡り日数 |
| `sampling.max_events` | 300 | 1回の学習に使う最大イベント数 |
| `sampling.origins.USER_SEEDED.weight` | 2.0 | 手動投入由来の重み倍率 |
| `proposal.expire_hours` | 72 | 未応答 Proposal の自動失効時間 |
| `proposal.max_proposals_per_day` | 4 | 1日あたりの最大 Proposal 生成数 |
| `proposal.change_limits.max_added_bullets` | 6 | 1回の提案で追加できる最大箇条書き数 |

#### `profile_update_prompt.md` — Taste Profile 更新プロンプト

学習バッチで LLM に渡すシステムプロンプト。Profile の書式ルール（H1/H2/箇条書き構造）、diff_summary の必須ルール、confidence の付け方を定義。Taste Profile の更新品質に直結する。

#### `taste_profile_seed.md` — 初期 Taste Profile

DB が空のとき（初回起動 or フルリセット後）に使われる初期プロファイル。「Like / Dislike / Drift」の3セクション。運用前に自分の好みに合わせて書き換えると初期の選抜精度が上がる。

### 6. シグナル語彙 — `spec/learning/signals.yaml`

LLM が記事から抽出するシグナルタグの語彙。増やすと分類が細かくなるが、LLM の出力ブレも増える。

### 7. タグマッピング — `spec/learning/tag_map.yaml` + `spec/forum/forum_tags.yaml`

- `tag_map.yaml`: シグナル（例: `#LLM`）→ Forum タグキー（例: `LLM`）のマッピング
- `forum_tags.yaml`: Forum タグキー → Discord 上の表示ラベルの定義

新しいシグナルを追加したら、対応する Forum タグも両ファイルに追加する。起動時に Discord Forum のタグが自動同期される。

### 8. カード/Library テンプレート — `spec/templates/`

- `feed_card.template.md` — `#feed-ai` に投稿されるカードの書式。`{title}`, `{one_liner}`, `{signals_inline}` 等のプレースホルダーが使える
- `library_post.template.md` — `#library` Forum に投稿される長文の書式

### 9. ボタン・モーダル定義 — `spec/ux/components.yaml`

ボタンのラベル・絵文字・custom_id を定義。`reason_menu` の設定で Keep 後に理由選択メニューを出す確率（`probability: 0.10` = 10%）を調整できる。

### 10. 状態遷移 — `spec/ux/state_machine.yaml`

Evidence の状態遷移ルール（new → kept / unsure / discarded）と、各状態での Library upsert ポリシー。

### 11. チャンネル設定 — `spec/ux/channels.yaml`

| パラメータ | 現在値 | 説明 |
|---|---|---|
| `runtime.grace_hours_default` | 6 | RSS カーソル巻き戻し時間 |
| `runtime.max_catchup_days_default` | 14 | 初回取得時の最大遡り日数 |
| `runtime.manual_sync_only` | true | true = 起動時に自動投稿しない（/sync 必須） |
| `inbox_manual.auto_label` | `"keep"` | 手動投入時に自動で付けるラベル（`"keep"` / `null`） |
| `posting.feed_card_max_signals` | 8 | カードに表示するシグナルの最大数 |

---

## 設定ファイル一覧

| ファイル | 主な調整内容 |
|---|---|
| `spec/rss/rss_sources.json` | RSS フィードの追加・削除・有効/無効 |
| `spec/llm/llm_config.json` | デフォルト LLM、temperature、出力言語 |
| `spec/llm/task_routing.json` | タスク別のモデル振り分け |
| `spec/serving/serving_policy.yaml` | 投稿量・選抜基準・カテゴリ配分・多様性 |
| `spec/serving/serving_prompt.md` | LLM Judge のプロンプト（選抜品質に最も影響） |
| `spec/learning/learning_config.yaml` | time decay・fatigue・スコアリング重み |
| `spec/learning/profile_update.yaml` | 学習バッチ頻度・サンプリング・Proposal 設定 |
| `spec/learning/profile_update_prompt.md` | Taste Profile 更新 LLM プロンプト |
| `spec/learning/taste_profile_seed.md` | 初期 Taste Profile |
| `spec/learning/signals.yaml` | シグナルタグ語彙 |
| `spec/learning/tag_map.yaml` | シグナル → Forum タグのマッピング |
| `spec/forum/forum_tags.yaml` | Forum タグ定義 |
| `spec/templates/feed_card.template.md` | #feed-ai カードの書式 |
| `spec/templates/library_post.template.md` | #library 投稿の書式 |
| `spec/ux/channels.yaml` | チャンネル設定・runtime パラメータ |
| `spec/ux/components.yaml` | ボタン・モーダル・理由選択メニュー |
| `spec/ux/state_machine.yaml` | 状態遷移ルール |

---

## よくあるトラブル

### "Spec validation failed"
→ `spec/` 配下のファイルが壊れている。エラーメッセージにどのファイルのどのフィールドが不正か表示される。

### "Could not resolve channel"
→ Discord サーバーのチャンネル名が `spec/ux/channels.yaml` と一致しているか確認。

### スラッシュコマンドが出てこない / 2重表示される

コマンドはギルド単位で登録される（即時反映）。もし以前グローバル登録したコマンドが残っていると、ギルドコマンドと重複して2重表示になる。

**解消方法:**

1. グローバルコマンドをクリアするスクリプトを実行:
   ```bash
   npx tsx -e "
   import 'dotenv/config';
   import { REST, Routes } from 'discord.js';
   const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
   const app = await rest.get(Routes.oauth2CurrentApplication());
   await rest.put(Routes.applicationCommands(app.id), { body: [] });
   console.log('Global commands cleared.');
   "
   ```
2. Discord クライアントを `Ctrl+R` で再読み込み

> **背景:** Discord のスラッシュコマンドには「グローバル登録」と「ギルド登録」の2種類がある。グローバルは反映に最大1時間かかるが、ギルドは即時反映。本Botはギルド登録を使用している。

### "Another instance is already running"
→ 多重起動防止のロックファイル。前回のプロセスが正常終了しなかった場合は `data/mekiki.lock` を手動削除して再起動。

### LLM エラー
→ `.env` の API キーが正しいか確認。`/model show` で現在のプロバイダを確認。
