// ── License Key List ───────────────────────────────────────────────────
// Each school you sell to gets one of these keys, sent manually by you
// (WhatsApp/email). When you sell to a new school, generate a fresh batch
// below, rebuild the installer, and give out only the new keys.
//
// This is intentionally simple: no server, no internet check, no per-machine
// locking. It's a reasonable deterrent for a typical school admin, not
// protection against someone deliberately extracting these from the app
// files. That tradeoff is appropriate for this product and price point.

const VALID_KEYS = [
  'IFLB-CBT-AG8W-Z4Z2',
  'IFLB-CBT-R7UC-B2YT',
  'IFLB-CBT-9XFW-QQ75',
  'IFLB-CBT-EXHB-43WC',
  'IFLB-CBT-BN9E-F9QQ',
  'IFLB-CBT-MXEW-PV8H',
  'IFLB-CBT-HDD3-JKVK',
  'IFLB-CBT-9QJ9-H64S',
  'IFLB-CBT-RQE5-VRB8',
  'IFLB-CBT-94DC-YDPJ',
  'IFLB-CBT-SRCC-YUT4',
  'IFLB-CBT-3A2R-DJ8N',
  'IFLB-CBT-HGFM-FJR9',
  'IFLB-CBT-M8H7-HHBB',
  'IFLB-CBT-DQ5V-EHH9',
  'IFLB-CBT-PWK4-88MX',
  'IFLB-CBT-VBVU-SUQ9',
  'IFLB-CBT-GQSS-TUGR',
  'IFLB-CBT-MNBK-CURK',
  'IFLB-CBT-FRYR-GDXB',
  'IFLB-CBT-BAHT-VHZF',
  'IFLB-CBT-JVHQ-3U6K',
  'IFLB-CBT-C9VA-SQ6B',
  'IFLB-CBT-ADCY-4XPD',
  'IFLB-CBT-NXXP-Q83S',
  // Add more keys here as you sell to more schools.
  // Keep a spreadsheet mapping each key to the school it was sold to.
];

function isValidKey(key) {
  if (!key) return false;
  return VALID_KEYS.includes(key.trim().toUpperCase());
}

module.exports = { isValidKey, VALID_KEYS };
