# Mekiki Bot — Project Map (v0.6)

## Big picture

- `#feed-ai` — **高速判断レーン**: 短いカード + ボタン (Keep / Unsure / Discard / Open / Note)
- `#library` — **アーカイブ**: Forum投稿 + タグ。Keep/Unsure時のみ作成
- `#inbox-manual` — **手動投入口**: URL/テキストを投げると Evidence化 → #feed-ai にカード投稿
- `#ops-bot` — **運用チャンネル**: Sync結果・学習Proposal・エラー通知
- Botは常時稼働しない前提。`--once` モードで外部スケジューラ連携も可能

## Architecture

```
RSS Feeds ──→ fetcher.ts ──→ DB (evidence) ──→ servingPipeline.ts ──→ #feed-ai
                                                    ↑ Taste Profile
#inbox-manual ──→ ingestHandler.ts ──→ DB ──→ #feed-ai (bypass serving)
User buttons ──→ buttonHandler.ts ──→ actions_log ──→ #library (Keep/Unsure)
/learn run ──→ batchLearner.ts ──→ LLM ──→ Taste Profile Proposal ──→ #ops-bot
scheduler.ts ──→ 定期実行: sync / learn / proposal expire
```

---

## src/ — アプリケーションコード

### src/index.ts
エントリポイント。ロックファイルガード、spec読込、DB初期化、Ollama検出、Discord接続、コマンド登録、スケジューラ起動。`--once` / `--test-sync` モード対応。

### src/scheduler.ts
定期実行スケジューラ。RSS同期 (60min) / 学習バッチ (360min) / Proposal期限切れ (30min) を管理。`run_on_start` オプション、`runOnce()` で一括実行→終了も可能。

### src/config/
| ファイル | 役割 |
|---|---|
| `specLoader.ts` | spec/ 配下の全YAML/JSON/テンプレートを読込み、Ajv (draft-2020-12) で8スキーマ検証。`MekikiSpec` 型を公開 |

### src/db/
| ファイル | 役割 |
|---|---|
| `database.ts` | SQLite (better-sqlite3, WAL) アダプタ。テーブル: `rss_cursors`, `seen_items`, `actions_log`, `evidence`, `taste_profile_versions`, `taste_profile_proposals`, `learning_runs`, `serve_judgement_cache` |

### src/discord/
| ファイル | 役割 |
|---|---|
| `botContext.ts` | `BotContext` インターフェース定義 (client, spec, db, channels, paused) |
| `client.ts` | Discord.js クライアント生成 + チャンネル解決 |
| `commands.ts` | スラッシュコマンド定義・ルーティング: `/sync`, `/pause`, `/resume`, `/model` (show/list/set), `/ingest`, `/learn` (run/profile), `/config` (show/set) |
| `buttonHandler.ts` | ボタン操作ハンドラ。Evidence操作 (Keep/Unsure/Discard/Open/Note) + Proposal操作 (Approve/Reject/Edit) |
| `feedCard.ts` | #feed-ai カードのレンダリングとボタン付き投稿 |
| `ingestHandler.ts` | #inbox-manual / /ingest / DM からの手動投入。Evidence生成→要約→カード投稿 |
| `libraryPost.ts` | #library Forum へのupsert。LLM writeup + signal→tag マッピング |
| `syncHandler.ts` | `/sync` のメインフロー: RSS取得→DB ingest→Serving Pipeline→選抜投稿。二重実行防止フラグ内蔵 |
| `proposalPost.ts` | Taste Profile Proposal を #ops-bot に投稿 (Approve/Reject/Edit ボタン付き) |
| `ensureTags.ts` | 起動時に #library Forum のタグを spec から同期 |

### src/llm/
| ファイル | 役割 |
|---|---|
| `client.ts` | Vercel AI SDK ラッパー。provider自動選択 (OpenAI/Anthropic/Google/Ollama) + task_routing.json によるモデルルーティング + フォールバック |
| `tasks.ts` | LLMタスク: `summarizeFeed`, `extractSignals`, `libraryWriteup` |
| `ollamaProbe.ts` | 起動時に `ollama list` 実行→利用可能モデルを model_registry に動的反映 |

### src/rss/
| ファイル | 役割 |
|---|---|
| `fetcher.ts` | rss-parser でRSS取得。cursor + grace window + dedupe (SHA256 URL hash) |

### src/serving/
| ファイル | 役割 |
|---|---|
| `servingPipeline.ts` | **投稿選抜パイプライン** (5段階): Stage 0 候補生成 → Stage 1 Preselect → Stage 2 LLM Judge (キャッシュ付き) → Stage 3+4 Portfolio配分 + MMR多様性 + 探索枠 |

### src/learning/
| ファイル | 役割 |
|---|---|
| `scorer.ts` | シグナルスコア計算: time decay (半減期) + fatigue (連続Discard) + manual boost |
| `batchLearner.ts` | 学習バッチ: アクション集計→LLMでTaste Profile更新提案→#ops-botに投稿 |

### src/templates/
| ファイル | 役割 |
|---|---|
| `renderer.ts` | `{key}` プレースホルダーをコンテキスト値に置換するテンプレートエンジン |

### src/utils/
| ファイル | 役割 |
|---|---|
| `fetchPage.ts` | URL→HTML取得→タイトル・本文抽出 (手動投入用) |

---

## spec/ — 設定・テンプレート・スキーマ

### spec/templates/
- `feed_card.template.md` — #feed-ai カードのテンプレート
- `library_post.template.md` — #library Forum投稿のテンプレート

### spec/ux/
- `channels.yaml` — チャンネル名/ID、runtime設定 (grace, max_catchup, manual_sync_only, run_on_start)
- `components.yaml` — ボタン定義 (Keep/Unsure/Discard/Open/Note, Approve/Reject/Edit)、モーダル定義
- `state_machine.yaml` — 状態遷移ルール + library upsertポリシー

### spec/rss/
- `rss_sources.json` — RSSフィード定義 (id, feed_url, default_signals, grace_hours)

### spec/llm/
- `llm_config.json` — アクティブプロバイダ/モデル、接続設定、language設定
- `model_registry.json` — プロバイダ別の利用可能モデル一覧
- `task_routing.json` — タスク別モデルルーティング (summarize_feed, extract_signals, library_writeup, taste_profile_propose, serve_judge)

### spec/learning/
- `learning_config.yaml` — time decay, fatigue, scoring重み
- `signals.yaml` — シグナルタグ語彙
- `tag_map.yaml` — シグナル→Forumタグ マッピング
- `profile_update.yaml` — 学習スケジューラ設定 (interval, mode, min_events, expire_hours)
- `profile_update_prompt.md` — Profile更新LLMプロンプト
- `taste_profile_seed.md` — 初期Taste Profile

### spec/serving/
- `serving_policy.yaml` — Serving Policy設定 (投稿上限, 候補フィルタ, preselect重み, LLM judge, portfolio配分, MMR多様性, 探索枠)
- `serving_prompt.md` — serve_judge LLMプロンプト
- `serve_judgement.schema.json` — LLM judge出力スキーマ

### spec/forum/
- `forum_tags.yaml` — #library Forumタグ定義

### spec/schemas/
起動時に Ajv で検証されるスキーマ (8件):
`rss_sources`, `llm_config`, `model_registry`, `task_routing`, `learning`, `ux_components`, `state_machine`, `serving_policy`

---

## docs/
- `PROJECT_MAP.md` — 本ファイル
- `CLAUDE_CODE_BRIEF.md` — 実装規約 (ハードコード禁止, LLM単一経路, スキーマ検証必須)
- `RUNBOOK.md` — 運用手順 (起動モード, /sync, スケジューラ, 外部スケジューラ連携)
- `SERVING_POLICY_SPEC.md` — Serving Policyの詳細仕様 (6段階パイプライン)

## scripts/
- `run-once.bat` — Windowsタスクスケジューラ用バッチスクリプト

---

## データ・ランタイム

- `data/mekiki.db` — SQLite データベース
- `data/mekiki.lock` — 多重起動防止ロックファイル (PID記録)
- `logs/bot.output` — Botログ出力先
- `logs/scheduled.log` — 外部スケジューラ実行ログ
