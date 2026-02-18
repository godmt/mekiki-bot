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

DB をリセットしたい場合:

```bash
rm data/mekiki.db    # 次回起動時に再作成
```

### 設定ファイル

- `spec/learning/profile_update.yaml` — 学習スケジューラ、サンプリング、Proposal 設定
- `spec/learning/learning_config.yaml` — スコアリング重み（time_decay, fatigue, manual_boost）
- `spec/learning/taste_profile_seed.md` — 初期 Taste Profile
- `spec/learning/profile_update_prompt.md` — LLM に渡すプロンプトテンプレート

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
