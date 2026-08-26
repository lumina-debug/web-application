// 資料の分類カテゴリ定義。
// keywords はAPIキーが無い環境で動くルールベース分類器が使う手がかり。
export const CATEGORIES = [
  {
    id: 'equipment',
    label: '装置・機器の使い方',
    emoji: '🔬',
    color: '#3b82f6',
    description: '実験装置・測定機器・PC周辺機器の起動手順や操作方法、予約ルールなど',
    keywords: ['装置', '機器', '測定', '顕微鏡', 'SEM', 'TEM', 'XRD', 'NMR', 'GC', 'HPLC', 'レーザー', 'スパッタ', '真空', 'ポンプ', '電源', '起動', '立ち上げ', '立上げ', 'シャットダウン', '予約', 'メンテナンス', '校正', 'キャリブレーション', '恒温槽', 'オーブン', '天秤', 'クリーンルーム'],
  },
  {
    id: 'protocol',
    label: '実験手順・プロトコル',
    emoji: '🧪',
    color: '#10b981',
    description: '試料作製・測定条件・実験レシピなど、再現するための手順書',
    keywords: ['手順', 'プロトコル', '実験', '試料', 'サンプル', '作製', '合成', '培養', '前処理', '条件', 'レシピ', '濃度', '試薬', '溶液', '滴定', '洗浄', '仕込み', '検量線', '再現'],
  },
  {
    id: 'safety',
    label: '安全・注意事項',
    emoji: '⚠️',
    color: '#ef4444',
    description: '薬品管理、危険物、事故対応、法令・講習など安全にかかわること',
    keywords: ['安全', '危険', '事故', '劇物', '毒物', '薬品', '廃液', '廃棄', '保護', 'ゴーグル', '手袋', '白衣', '換気', 'ドラフト', '高圧', 'ガス', 'ボンベ', '感電', '火傷', '火災', '地震', '緊急', '講習', '法令', 'MSDS', 'SDS', '注意'],
  },
  {
    id: 'analysis',
    label: 'データ解析・ソフトウェア',
    emoji: '💻',
    color: '#8b5cf6',
    description: '解析コード、ソフトの使い方、データの保存場所や命名規則',
    keywords: ['解析', 'データ', 'ソフト', 'プログラム', 'コード', 'スクリプト', 'Python', 'MATLAB', 'Origin', 'Excel', 'ImageJ', 'LabVIEW', 'R言語', 'Git', 'サーバ', 'サーバー', '計算', 'シミュレーション', 'フィッティング', 'グラフ', '可視化', 'ライセンス', 'インストール', '命名規則', 'バックアップ'],
  },
  {
    id: 'admin',
    label: '事務・手続き',
    emoji: '📋',
    color: '#f59e0b',
    description: '発注、旅費、学会申込、経費精算、書類の出し方',
    keywords: ['事務', '手続', '申請', '発注', '購入', '見積', '納品', '請求', '経費', '精算', '旅費', '出張', '学会', '投稿', '締切', '書類', '提出', '予算', '科研費', '報告書', '許可', 'ハンコ', '押印'],
  },
  {
    id: 'lablife',
    label: '研究室の運営・生活',
    emoji: '🏠',
    color: '#14b8a6',
    description: 'ゼミ運営、当番、鍵、掃除、備品の場所、連絡手段など日々のルール',
    keywords: ['ゼミ', 'ミーティング', '当番', '掃除', '清掃', '鍵', '入室', 'カード', '備品', '文房具', '発注リスト', '連絡', 'Slack', 'メール', '歓迎会', '新歓', '席', '部屋', '冷蔵庫', 'ゴミ', '共用', 'ルール', '慣習', '年間', 'スケジュール'],
  },
  {
    id: 'troubleshoot',
    label: 'トラブル対応',
    emoji: '🛠️',
    color: '#f43f5e',
    description: '「動かない時」「エラーが出た時」の対処法、過去にハマった事例',
    keywords: ['トラブル', 'エラー', '不具合', '故障', '動かない', '直し', '修理', '再起動', '対処', '原因', 'ハマ', '失敗', 'うまくいかない', '止まる', '落ちる', 'ノイズ', '異音', '漏れ', '業者', '問い合わせ'],
  },
  {
    id: 'other',
    label: 'その他',
    emoji: '📦',
    color: '#64748b',
    description: '上のどれにも当てはまらない資料',
    keywords: [],
  },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const DEFAULT_CATEGORY = 'other';

export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES.find((c) => c.id === DEFAULT_CATEGORY);
}

export function isValidCategory(id) {
  return CATEGORY_IDS.includes(id);
}
