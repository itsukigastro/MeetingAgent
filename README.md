# MeetingAgent

> 商談AI — Google Meet に参加するAIアシスタント

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#動作環境)

**MeetingAgent** は [Meetron](https://github.com/bb8ad8/meetron) のフォークです。元の Meetron は ChatGPT Web Voice を Google Meet / Zoom に接続する macOS 向けの実験的ツールでした。私たちはその **音声・会議参加の仕組み** をそのまま使い、**AI の頭脳部分** を Gastrobrain（自社ナレッジベース + MCP + RAG）に置き換えています。

## 概要

 MeetingAgent は Google Meet の **通常参加者** として AI を会議に参加させます。

```
Google Meet の参加者 → [Meetron の仮想音声デバイス経由] → AI（/voice ページ）
                                                            ↓
                                                      RAG / MCP 検索
                                                            ↓
                                                      回答音声 → Meet に返す
```

### 特徴

- **Meet の通常参加者として参加** — ボット API を使わず、Playwright でブラウザを操作
- **仮想音声デバイスで双方向通信** — Meet の音声を AI に、AI の応答を Meet に
- **名前を呼ばれたときだけ応答** — ウェイクワード（「商談AI」「ガストロブレイン」）で応答をゲート
- **Gastrobrain のナレッジベースから回答** — NotePM 等の社内ドキュメントを RAG で検索
- **会議後は Slack に報告** — サマリーとアクションアイテムを自動送信

## アーキテクチャ

```
Meetron（このリポジトリ）          Gastrobrain（別リポジトリ）
┌─────────────────────────┐      ┌──────────────────────────┐
│ Chrome + Playwright     │      │ /voice ページ             │
│  ├─ Meet タブ           │ ←→  │  ├─ Realtime API          │
│  │   (参加者として入室)  │ 音声 │  ├─ RAG / MCP             │
│  └─ Agent タブ          │      │  ├─ ウェイクワードゲート   │
│      (音声入出力)        │      │  └─ 会議モード             │
│                         │      │                           │
│ 仮想音声デバイス x2      │      │ Slack 連携                │
│  Meetron: Meeting to AI │      └──────────────────────────┘
│  Meetron: AI to Meeting │
└─────────────────────────┘
```

### Meetron の管轄（このリポジトリ）

| コンポーネント | 概要 |
|---|---|
| `scripts/prepare-meet.mjs` | Meet の参加前画面を自動操作（マイク/スピーカー選択、カメラオフ、参加要求） |
| `scripts/prepare-agent.mjs` | Agent タブの起動と音声デバイスの設定 |
| `scripts/open-agent.sh` | 専用 Chrome を起動し、Meet と Agent を開く |
| `scripts/meet-captions.mjs` | Meet の字幕（発言者ラベル付き）をキャプチャ |
| `src/providers/google-meet/` | Meet プロバイダ（参加/退出/マイク制御） |
| `src/audio/` | 仮想音声デバイスの選択・ルーティング |
| `src/core/` | セッション管理、プロトコル、状態管理 |
| `extension/` | Chrome 拡張（パネル UI） |

### Gastrobrain の管轄（`../gastro`）

- `/voice` ページ — Realtime API 接続、RAG、MCP
- ウェイクワードマッチャ — `web/src/lib/wake-word.ts`
- 会議モード — `web/src/lib/meeting-mode.ts`
- Slack 連携 — サマリー送信

## 動作環境

- macOS 13 以降（Apple Silicon 推奨）
- Google Chrome 公式ビルド
- Node.js 22 または 24 LTS
- Google Meet に参加できる Google アカウント
- Gastrobrain にログインできるアカウント（Slack OAuth）

## セットアップ

### 1. リポジトリのクローン

```bash
git clone https://github.com/itsukigastro/MeetingAgent.git
cd MeetingAgent
```

### 2. 依存関係のインストール

```bash
npm ci
```

### 3. 環境確認

```bash
./scripts/check-env.sh
```

### 4. Meetron Audio のインストール

[GitHub Releases](https://github.com/bb8ad8/meetron/releases) から最新の `MeetronAudio-*.pkg` をダウンロードし、インストールします。インストール後は Mac を再起動してください。

### 5. 環境変数の設定

```bash
cp .meeting-copilot.env.example .meeting-copilot.env
```

`.meeting-copilot.env` を編集して、CDP ポートなどを設定します。

## 使い方

### Meet に参加させる

```bash
./scripts/open-gpt-participant.sh --auto-prepare --join \
  "https://meet.google.com/xxx-yyyy-zzz"
```

### Agent タブを開くだけ

```bash
./scripts/open-agent.sh
```

### マイクの制御

```bash
./scripts/set-meet-mic.sh mute
./scripts/set-meet-mic.sh unmute
./scripts/set-meet-mic.sh toggle
```

### テスト

```bash
npm test          # 137 チェック
```

## プロジェクトの構成

```
MeetingAgent/
├── src/
│   ├── audio/              # 仮想音声デバイスのルーティング
│   ├── browser/            # Chrome / CDP 接続
│   ├── core/               # セッション管理
│   ├── platform/macos/     # macOS パス設定
│   └── providers/
│       └── google-meet/    # Meet 参加/退出/マイク制御
├── scripts/
│   ├── prepare-meet.mjs    # Meet の参加前自動操作
│   ├── prepare-agent.mjs   # Agent タブの起動
│   ├── open-agent.sh       # 専用 Chrome 起動
│   ├── meet-captions.mjs   # Meet 字幕キャプチャ
│   ├── native-host.mjs     # ローカルデーモン
│   └── ...                 # その他ユーティリティ
├── extension/              # Chrome 拡張（Meetron Controls）
├── native/
│   ├── audio-driver/       # CoreAudio 仮想デバイスドライバ (C)
│   └── audio-control/      # 音声制御 CLI (Swift)
├── tests/                  # テストスイート
└── package.json
```

## 開発の方向性

### Stage A — macOS でのデモ（完了）

この Mac で動作するデモ版。 Meetron の音声 shell を使い、Gastrobrain の `/voice` ページを Agent として接続します。

### Stage B — Linux VPS への移行（予定）

- PulseAudio の null sink で仮想音声デバイスを実現
- Chrome を `xvfb` で起動
- Native Messaging Host → HTTP ジョブキューに置き換え
- 従業員は一切インストール不要

### Stage C — Slack 報告（予定）

会議終了後に Slack へサマリーとアクションアイテムを自動送信。

## ライセンス

[GNU General Public License v3.0](LICENSE)

このプロジェクトは [Meetron](https://github.com/bb8ad8/meetron) のフォークです。元のプロジェクトの GPL-3.0 ライセンスを継承しています。

## クレジット

- [Meetron](https://github.com/bb8ad8/meetron) — bb8ad8
- 仮想音声ドライバ — Apple の Audio Server Plug-in 公式サンプルに基づく
