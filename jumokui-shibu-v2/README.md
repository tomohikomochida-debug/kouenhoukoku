# 樹木医会神奈川県支部 支部管理システム v2

第1段階：総務（正本・会員の異動）＋会計（会費台帳・年度追加・送金記録）

- `コード.gs` … Apps Script に貼り付ける本体（1ファイルのみ）
- `test_logic.js` … 判定・計画部分のテスト
- `test_glue.js` … シート操作部分を模擬環境で通しで動かすテスト

テストの実行：

```
cp コード.gs /tmp/code.js
node test_logic.js /tmp/code.js
node test_glue.js /tmp/code.js
```

スプレッドシート（Google ドライブ「支部管理システム_v2（Claude作成）」フォルダ）

- 総務_正本_v2
- 会計_会費台帳_v2（会費台帳は「会費台帳_2026」など年度ごとのシート）
