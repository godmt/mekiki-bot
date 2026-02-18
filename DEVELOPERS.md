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
npm run dev
```

正常なら以下のログが出る:

```
[mekiki-bot] Starting...
[spec] All 7 schema validations passed.
[mekiki-bot] Spec loaded and validated.
[mekiki-bot] Database initialized.
[discord] Logged in as あいきき#5098
[commands] Registered 6 slash commands to guild XXXX.
[discord] Channels resolved: { feedAi: '#feed-ai', ops: '#ops-bot', ... }
```

Discord の `#ops-bot` に起動メッセージが届く。

多重起動は `data/mekiki.lock` ファイルで防止される。既にBotが動いている状態で再起動しようとするとエラーで終了する。前回クラッシュしてロックファイルが残っている場合は自動で除去される。

## 型チェック / Lint

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/
```

## スラッシュコマンド（Discord上で実行）

| コマンド | 説明 |
|---|---|
| `/sync` | RSS取得 → LLM要約 → #feed-ai にカード投稿 |
| `/pause` | RSS取り込み一時停止（ボタンは動く） |
| `/resume` | 再開 |
| `/model show` | 現在のLLMプロバイダ/モデルを表示 |
| `/model set provider:<名前> model:<ID>` | LLMモデルを切り替え |
| `/ingest input:<URL or テキスト>` | 手動でURLやテキストを投入 |
| `/learn run` | 目利き学習バッチを実行し、Taste Profile 更新案を `#ops-bot` に投稿 |
| `/learn profile` | 現在の Taste Profile を表示 |

> **注意:** `/sync` は初回実行時、過去14日分のRSSを取得するため LLM 呼び出しが多くなる。テスト時は `spec/rss/rss_sources.json` で `enabled: false` にして1フィードだけ有効にすると安全。

## 手動投入（#inbox-manual）

`#inbox-manual` チャンネルにURLやテキストを貼ると、Bot が自動で LLM 要約して `#feed-ai` にカード投稿する。成功時は ✅、失敗時は ❌ のリアクションが付く。

Bot への DM でも同様に動作する。

`spec/ux/channels.yaml` で `inbox_manual.auto_label: "keep"` が設定されている場合、投入と同時に自動で KEEP 状態になり `#library` にも投稿される。

## 目利き学習 (Taste Profile)

### 学習の流れ

1. ユーザーが `#feed-ai` のカードに Keep / Unsure / Discard をつける（＝学習データ）
2. `/learn run` を実行すると、Bot がラベル履歴を集計し LLM に Taste Profile の更新案を生成させる
3. 更新案（Proposal）が `#ops-bot` に投稿される。Approve / Reject / Edit ボタンつき
4. Approve すると Profile が更新され、以降の情報収集・評価に反映される

### 学習結果の確認方法

| 方法 | コマンド / 場所 | 内容 |
|---|---|---|
| **現在の Profile** | `/learn profile` | 現在有効な Taste Profile (Markdown) を表示 |
| **Proposal 履歴** | `#ops-bot` チャンネル | 過去の Proposal と承認/却下の記録が残る |
| **DB 直接参照** | `data/mekiki.db` | `taste_profile_versions` テーブルに全バージョン履歴、`taste_profile_proposals` に全提案履歴 |

### DB テーブル（学習関連）

```
taste_profile_versions  — Profile の全バージョン履歴
  id, profile_md, source ("seed" / "approved" / "edited"), proposal_id, created_at

taste_profile_proposals — LLM が生成した更新提案
  id, status ("pending" / "approved" / "rejected"), new_profile_md, diff_summary,
  risks, confidence, notes, stats_used, ops_message_id, created_at, resolved_at

learning_runs           — 学習バッチの実行履歴
  id, started_at, finished_at, status, events_processed, proposal_id

actions_log             — Keep/Unsure/Discard 等の全アクション履歴（学習の入力データ）
  id, evidence_id, action, actor, created_at, metadata
```

### 設定ファイル

- `spec/learning/profile_update.yaml` — 学習スケジューラ、サンプリング、Proposal 設定
- `spec/learning/learning_config.yaml` — スコアリング重み（time_decay, fatigue, manual_boost）
- `spec/learning/taste_profile_seed.md` — 初期 Taste Profile（初回 `/learn run` 時に自動投入）
- `spec/learning/profile_update_prompt.md` — LLM に渡すプロンプトテンプレート

## データベース

SQLite ファイルは `data/mekiki.db` に保存される（`.gitignore` 済み）。

DB をリセットしたい場合:

```bash
rm data/mekiki.db
```

次回起動時に再作成される。

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

> **背景:** Discord のスラッシュコマンドには「グローバル登録」と「ギルド登録」の2種類がある。グローバルは反映に最大1時間かかるが、ギルドは即時反映。本Botはギルド登録を使用している。両方に同じコマンドが登録されると候補が2重に表示される。

### "Another instance is already running"
→ 多重起動防止のロックファイル。前回のプロセスが正常終了しなかった場合は `data/mekiki.lock` を手動削除して再起動。

### LLM エラー
→ `.env` の API キーが正しいか確認。`/model show` で現在のプロバイダを確認。
