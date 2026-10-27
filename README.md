# mcp-headless-browser

macOS 向けの MCP サーバー。Playwright + Chromium で Web ページの取得・認証付き操作・対話的なフォーム操作を行う。Cookie セッションは `$HEADLESS_BROWSER_STATE_DIR/sessions/` に永続化され、認証情報は macOS Keychain から取得できる。

## 設定

| 環境変数 | 必須 | 内容 |
|---|---|---|
| `HEADLESS_BROWSER_STATE_DIR` | 必須 | ログインの状態（`sessions/`）とスクリーンショット（`screenshots/`）を置く絶対パスのディレクトリ。未設定・空・相対パスだと、理由を stderr に出して終了コード 1 で起動を止める |
| `SANDBOX_RUNTIME` / `CODEX_SANDBOX` | 任意 | どちらかが設定されている時だけ、Chromium を `--single-process` 付きで起動する（sandbox の中では必要）。`HTTPS_PROXY` 等が設定されていれば、Chromium の proxy オプションとして渡す（Chromium は環境変数を読まないため） |

登録例:

```bash
claude mcp add -s user headless-browser -e HEADLESS_BROWSER_STATE_DIR=/abs/path/to/state -- node /abs/path/to/mcp-headless-browser/dist/index.js
```

## ツール一覧

### Stateless（一発実行）

| ツール | 用途 |
|---|---|
| `fetch_page` | 認証不要のページからテキスト/HTML を取得 |
| `browse_action` | 保存済みセッションを使って認証済みページにアクセスし、actions 配列を一発実行 |
| `browse_screenshot` | 保存済みセッションを使ってスクリーンショット取得 |
| `browse_status` | 保存済みセッションの状態を確認 |

### Login（headed・自動入力）

| ツール | 用途 |
|---|---|
| `browse_login` | headed Chrome を起動し、Keychain の認証情報（`kurosuke.<service>` プレフィックス）でログインフォームを自動入力。ユーザーがブラウザを閉じたらセッションを保存 |

### 持続セッション（headed・対話操作）

複数の tool call にまたがって headed Chrome を保持し、Claude が対話的にフォームを操作するためのツール群。会員登録など複雑なフローを意識して設計されている。

| ツール | 用途 |
|---|---|
| `browse_open` | headed Chrome を起動して URL を開き、`browser_id` を返す |
| `browse_inspect` | 現在ページの構造（フォームフィールド一覧など）を取得 |
| `browse_fill` | 複数フィールドを一括入力。Keychain 参照対応 |
| `browse_click` | 要素クリック、ナビゲーション待ちオプションあり |
| `browse_goto` | 同一セッション内で別 URL へ遷移 |
| `browse_handoff` | ユーザー操作モードに移行（CAPTCHA 解決などをユーザーに委ねる） |
| `browse_close` | セッションを明示的に閉じる |
| `browse_list` | アクティブな全セッションを一覧表示 |

## 持続セッションのライフサイクル

### browser_id の寿命

- `browse_open` で発行され、`browse_close` または以下のタイミングで失効する:
  - **idle timeout**（デフォルト 15 分、`browse_open` の `idle_timeout_minutes` で 1〜60 分に変更可）
  - **ユーザーが手動で headed Chrome を閉じた**とき（disconnected hook で検知）
  - **MCP プロセス終了**時（SIGTERM/SIGINT で全セッションに対し best-effort 保存 → close）
- 同時に保持できるセッション数の上限は **3**。超過時 `browse_open` が throw する
- handoff 中（`state === "handoff"`）は idle timer が停止する

### handoff の polling 仕様

`browse_handoff` は **同期的な長時間 block を行わない**。Claude Code を含む MCP クライアントは tool call timeout が概ね 60 秒であり、長時間 block すると切断されるためである。

代わりに **short-poll 方式**を採用している:

- `browse_handoff(browser_id, max_wait_seconds?)` を呼ぶと、最大 `max_wait_seconds`（デフォルト 50 秒、最大 55 秒）待機する
- ユーザーがその間にブラウザを閉じれば `{ status: "completed", reason, final_url, session_saved }` を返す
- 待機時間内に閉じられなければ `{ status: "waiting", elapsed_seconds }` を返す
- Claude は `status === "completed"` になるまで `browse_handoff` を繰り返し呼ぶ
- 完了時にはセッション cookie が自動保存され、Registry から除去される

### 他ツール呼び出しと state

`state === "handoff"` 中に `browse_inspect` などの他ツールを呼ぶとエラーになる（ユーザー操作待ちのため）。`browse_close` のみ強制クローズとして許可されている。

## ツール選択ガイド

| ユースケース | 使うツール |
|---|---|
| 認証不要なページのテキストが欲しい | `fetch_page` |
| 既にログイン済みのページから情報を取得したい | `browse_action`（actions=[]） |
| 既にログイン済みのページで決まった操作を一発実行したい | `browse_action` |
| まだログインしていないサービスにログインしたい | `browse_login` |
| 会員登録など、複数フィールドの動的フォームを Claude に埋めさせたい | 持続セッション群（`browse_open` → `browse_inspect` → `browse_fill` → `browse_handoff`） |
| CAPTCHA 突破が必要 | 持続セッション群で `browse_handoff` 経由でユーザーに引き継ぎ |

## Keychain 連携

### `browse_login` の自動入力

`kurosuke.<service>` というサービス名で `security` コマンド経由で Keychain に登録された認証情報を自動入力する。

```bash
security add-generic-password -s "kurosuke.example" -a "user@example.com" -w "password" -U
```

### `browse_action` / `browse_fill` の任意 Keychain 参照

`fill` アクションで `value` の代わりに `keychain: { service, account }` を指定すると、任意の service/account の Keychain エントリからパスワードを取得して入力する。Claude Code のセッションログにパスワード値が露出しない。

```json
{
  "type": "fill",
  "selector": "#password",
  "keychain": { "service": "abeke-password", "account": "abeke_1" }
}
```

入力後のログは `[fill] #password (keychain: abeke-password/abeke_1)` のみで、パスワード値は記録されない。

## 会員登録ユースケースのサンプル

会員登録ページに遷移 → フォームを自動解析 → 必要な項目を埋める → CAPTCHA をユーザーに引き継ぐ流れ。

```text
1. browse_open(service="example", url="https://example.com/signup")
   → browser_id: "sess_example_a1b2c3"

2. browse_inspect(browser_id, mode="forms")
   → fields: [
       { name: "email", id: "Email", css_selector: "#Email", label: "メールアドレス", ... },
       { name: "password", id: "Password", css_selector: "#Password", label: "パスワード", ... },
       { name: "name", id: "FullName", css_selector: "#FullName", label: "氏名", ... },
       ...
     ]

3. browse_fill(browser_id, fields=[
     { selector: "#Email", value: "user@example.com" },
     { selector: "#Password", keychain: { service: "abeke-password", account: "abeke_1" } },
     { selector: "#FullName", value: "山田太郎" },
   ])

4. browse_inspect(browser_id, mode="forms")
   // 動的に現れた追加フィールドを再確認

5. browse_fill(browser_id, fields=[ ... ])

6. browse_handoff(browser_id, message="CAPTCHA を解いて submit してください")
   → { status: "waiting", elapsed_seconds: 50 }

7. browse_handoff(browser_id)  // ポーリングを継続
   → { status: "waiting", elapsed_seconds: 100 }

8. browse_handoff(browser_id)  // ユーザーがブラウザを閉じた
   → { status: "completed", reason: "page_closed", final_url: "https://example.com/signup/complete", session_saved: true }
```

## セッションファイル

`$HEADLESS_BROWSER_STATE_DIR/sessions/<service>.json` に Playwright の `storageState` 形式で保存される。
- `cookies`: ブラウザの全 Cookie
- `origins`: localStorage / sessionStorage

サービス名は `^[a-z0-9_-]+$` の正規表現を満たす必要がある（パストラバーサル防止）。

## 開発

Node.js は Brotli の CVE-2026-111497 を修正した 24.22.1 LTS を使用する。
`process.versions.brotli` の表示だけでは修正の有無を判定できない。
Node.js 24.22.1 は Brotli の版表示が 1.2.0 のまま、修正コミットを取り込んでいる。
根拠は [Node.js のリリースノート](https://nodejs.org/en/blog/release/v24.22.1)。

```bash
npm ci
npm run build
npx tsx tests/test-unit.ts   # ユニットテスト（ブラウザ不要）
```

`src/` のソースは TypeScript ESM。`dist/` にビルド成果物が出る。MCP クライアントは `node dist/index.js` を起動する。

### 稼働先への更新反映

merge だけでは稼働先の `node_modules` と `dist` は更新されない。
稼働先に更新コミットを反映後、次のスクリプトに稼働先の絶対パスと
Node.js 24.22.1 の実行ファイルの絶対パスを渡す。

```bash
bash scripts/update-runtime.sh /abs/path/to/mcp-headless-browser /abs/path/to/node
```

依存関係の再作成、Chromium のインストール、ビルドを順に実行し、失敗した時点で停止する。
インストール時は `PLAYWRIGHT_SKIP_BROWSER_GC=1` で共有キャッシュ内の他のブラウザの自動削除を止める。
ブラウザは起動中の他用途と共有されるため、キャッシュ全体を削除しない。

処理後は MCP クライアントで headless-browser 接続を再接続する。
新しいサーバーで `browse_open` に `url: "about:blank"`、`headless: true`、
`auto_login: false`、`load_session: false`、検証専用の `service` を指定して起動を確かめ、
`browse_close` で閉じる。接続を再起動するまでは、既存サーバーが更新前のコードを保持する。

## アーキテクチャ

- `src/index.ts` — MCP サーバーエントリ。各ツールを登録し、SIGTERM/SIGINT で `BrowserSessionRegistry.shutdown()` を呼ぶ
- `src/session-manager.ts` — Cookie/storageState の永続化
- `src/keychain-adapter.ts` — macOS Keychain アクセス（`security` コマンド経由）
- `src/browser-registry.ts` — 持続セッション用の `BrowserSessionRegistry`
- `src/tools/_browser-helpers.ts` — 共通ロジック（USER_AGENT、autoFill、ログインリダイレクト検出など）
- `src/tools/*.ts` — 各 MCP ツールの登録関数
