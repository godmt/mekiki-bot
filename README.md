# mekiki-bot

Discord Bot for AI-powered information curation. RSS フィードや手動投入された記事を LLM で要約・選抜し、Discord チャンネルに投稿します。ユーザーのフィードバック（Keep / Discard）を学習し、選抜精度を継続的に改善します。

## 必要なもの

- **Node.js 20+**
- **Discord Bot** — [Discord Developer Portal](https://discord.com/developers/applications) で作成
  - Bot の Privileged Gateway Intents で **Message Content Intent** を有効にする
  - OAuth2 で `bot` + `applications.commands` スコープ、権限: `Send Messages`, `Manage Messages`, `Read Message History`, `Use Slash Commands`, `Create Public Threads`, `Manage Threads`, `Add Reactions`
- **LLM API キー** — 以下のいずれか1つ以上:
  - OpenAI (`OPENAI_API_KEY`)
  - Anthropic (`ANTHROPIC_API_KEY`)
  - Google Gemini (`GOOGLE_API_KEY`)
  - Ollama（ローカル、キー不要）

## セットアップ

```bash
git clone <repo-url>
cd mekiki-bot
npm install
```

### 環境変数

`.env` ファイルをプロジェクトルートに作成:

```env
DISCORD_TOKEN=your-discord-bot-token
OPENAI_API_KEY=sk-...          # 使うプロバイダのみ
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AI...
```

### Discord サーバー準備

以下のチャンネルを作成し、`spec/ux/channels.yaml` の `id` フィールドにチャンネル ID を設定:

| チャンネル | 種類 | 用途 |
|---|---|---|
| `#feed-ai` | テキスト | LLM 選抜カードの投稿先 |
| `#library` | フォーラム | Keep/Unsure 記事のアーカイブ |
| `#inbox-manual` | テキスト | 手動 URL/テキスト投入口 |
| `#ops-bot` | テキスト | 運用通知・学習 Proposal |

### LLM モデル設定

`spec/llm/llm_config.json` でアクティブなプロバイダとモデルを設定。起動後に `/model set` コマンドでも切り替え可能。

## 起動

```bash
npm run dev              # 開発モード (tsx)
npm run build && node dist/index.js   # 本番
```

### CLI フラグ

| フラグ | 動作 |
|---|---|
| (なし) | 常駐モード。スケジューラ有効、スラッシュコマンド受付 |
| `--once` | sync → learn → expire を一括実行し自動終了 |
| `--test-sync` | 1ソース×3件のみ同期し自動終了（テスト用） |

## 主なコマンド (Discord)

| コマンド | 説明 |
|---|---|
| `/sync` | RSS 取得 → 選抜 → 投稿 |
| `/pause` / `/resume` | RSS 取り込み一時停止/再開 |
| `/model show` / `/model list` / `/model set` | LLM モデル管理 |
| `/ingest input:<URL or テキスト>` | 手動投入 |
| `/learn run` / `/learn profile` | 学習バッチ実行 / Taste Profile 表示 |
| `/config show` / `/config set` | 設定表示・変更 |

## 開発

```bash
npm run typecheck   # 型チェック
npm run lint        # ESLint
```

## 詳細ドキュメント

- [DEVELOPERS.md](DEVELOPERS.md) — 開発メモ、DB テーブル、トラブルシューティング
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — 運用手順、スケジューラ設定、外部スケジューラ連携
- [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md) — ソースコード構成と各ファイルの役割
