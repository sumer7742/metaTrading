export const fmtNum = (v, decimals = 2) => {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};
export const fmtMoney = (v) => `$${fmtNum(v, 2)}`;
export const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '-');
