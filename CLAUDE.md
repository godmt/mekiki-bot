あなたはこのリポジトリ `mekiki-bot` を実装するエージェントです。ルートの CLAUDE.md をシステム規約として厳守してください。

最初にやること:
1) docs/PROJECT_MAP.md / docs/CLAUDE_CODE_BRIEF.md / docs/RUNBOOK.md を読んで、MVPの完成条件を箇条書きで再掲。
2) spec/ 配下（templates, ux, rss, llm, learning, forum, schemas）を読み、起動時スキーマ検証（spec/schemas）を必須要件として実装計画に入れる。
3) 以降は「計画→小さな差分→実行で検証→報告」のループで進める。

MVP要件（守ること）:
- Node.js 20+ / TypeScript / discord.js / SQLite。
- LLMは Vercel AI SDK 経由で統一（OpenAI/Anthropic/Google Gemini/Ollama）。LLM呼び出しは src/llm/* のみ。
- #feed-ai（通常チャンネル）に短いカードを投稿し、ボタン（Keep/Unsure/Discard/Open/Note）を付ける。文面は spec/templates/feed_card.template.md からレンダリング（ハードコード禁止）。
- Keep/Unsure 時のみ #library（Forum）に投稿を upsert（テンプレは spec/templates/library_post.template.md）。タグは spec/forum/forum_tags.yaml と spec/learning/tag_map.yaml を利用。
- Botは常時稼働しない前提。再起動時のRSS同期は last_fetch_at から（grace を引いて）取得し、dedupeで重複排除。/sync コマンドで同期できる（manual_sync_only=true なら起動時は投稿しない）。
- 目利き学習は時間を必ず考慮（time decay + fatigue）。learning と publishing/archiving を混ぜない。

実装の進め方（推奨順）:
A) repo scaffold: package.json / tsconfig / src/ の骨格 / 起動コマンド
B) spec loader + schema validation（失敗時はわかりやすく終了）
C) sqlite adapter（cursor・seen・actions_log を保存できる最小テーブル）
D) Discord接続 + /sync /pause /resume /model show,set（必要最小）
E) RSS ingestion + cursor/grace + dedupe
F) #feed-ai 投稿 + ボタン処理（状態遷移は spec/ux/state_machine.yaml）
G) Keep/Unsure -> #library Forum upsert + tags
H) LLMClient（AI SDK）と tasks（summarize / extract_signals / library_writeup）を作り、task_routing.json を参照してモデル選択
I) learning v0（rule-based: time decay + fatigue）を実装し、ActionEventを受けてスコア更新できる形にする（まずはログ/スコア計算でOK）

Logging policy (project-local)：
- 実行ログはプロジェクト外の一時領域（例: `~/AppData/Local/Temp/claude/**`）に出さない。
- バックグラウンド実行するコマンドは必ず `./logs/` にログを出す。
  - stdout/stderr（標準出力/標準エラー: 実行ログの出力先; なぜ: どこに吐くかを固定するため）は `./logs/*.output` へリダイレクトする。
  - 例:
    - `mkdir -p logs`
    - `cd /d/Program/mekiki-bot && nohup npx tsx src/index.ts > ./logs/bot.output 2>&1 & disown`

重要:
- Discord API制約などで spec が足りず詰まったら、最小の spec/ 変更案を作って私に承認を求めてください（承認なく変更しない）。
- 破壊的操作（git reset --hard など）はしない。
- 変更ごとに「変更点・実行コマンド・結果」を短く報告する。

まずはA〜Cまで着手し、ローカルで `npm test` または最低限の `npm run lint` / `npm run typecheck` / `npm run dev` のどれかで検証できる状態にしてください。

追加の最重要要件:
- 手動投入口 #inbox-manual を実装する。ここに投げられた URL/ファイル/テキスト断片を Evidence 化し、#feed-ai にカードを投稿する。
- #inbox-manual が作られていない/ID未設定の場合のフォールバックを用意:
  - BotへのDM、または /ingest コマンドで同等の投入を可能にする（spec変更なしで可）。
- Discordの Message Content Intent が必要になる可能性が高い。導入手順と、discord.js 側 intents 設定をRUNBOOKに追記する。


---

