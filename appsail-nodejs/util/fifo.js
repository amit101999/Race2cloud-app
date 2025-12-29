export const runFifoEngine = (
  transactions = [],
  bonuses = [],
  splits = [],
  card = false
) => {
  let holdings = 0;
  const buyQueue = []; // FIFO lots (OPEN ONLY)
  const output = [];

  /* ---------------- DATE NORMALIZATION ---------------- */
  const normalizeDate = (rawDate) => {
    if (!rawDate) return null;
    const [y, m, d] = rawDate.split("-").map(Number);
    const fullYear = y < 100 ? 2000 + y : y;
    return `${fullYear}-${String(m).padStart(2, "0")}-${String(d).padStart(
      2,
      "0"
    )}`;
  };

  /* ---------------- MERGE EVENTS ---------------- */
  const events = [
    ...transactions.map((t) => ({
      type: "TXN",
      date: normalizeDate(t.TRANDATE || t.trandate),
      data: {
        tranType: t.Tran_Type || t.tranType,
        qty: t.QTY || t.qty,
        netrate: t.NETRATE || t.netrate,
        netAmount: t.NETAMOUNT || t.netAmount,
        trandate: t.TRANDATE || t.trandate,
      },
    })),
    ...bonuses.map((b) => ({
      type: "BONUS",
      date: normalizeDate(b.ExDate || b.exDate),
      data: {
        bonusShare: b.BonusShare || b.bonusShare,
        exDate: b.ExDate || b.exDate,
      },
    })),
    ...splits.map((s) => ({
      type: "SPLIT",
      date: normalizeDate(s.issueDate),
      data: {
        ratio1: s.ratio1,
        ratio2: s.ratio2,
        issueDate: s.issueDate,
      },
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  /* ---------------- HELPERS ---------------- */
  const isBuy = (t) => /^BY-|SQB|OPI/.test(String(t).toUpperCase());
  const isSell = (t) => /^SL\+|SQS|OPO|NF-/.test(String(t).toUpperCase());

  const getCostOfHoldings = () =>
    buyQueue.reduce((sum, lot) => sum + lot.qty * lot.price, 0);

  const getWAP = () => (holdings > 0 ? getCostOfHoldings() / holdings : 0);

  /* ---------------- PROCESS EVENTS ---------------- */
  for (const e of events) {
    /* ========== BUY / SELL ========== */
    if (e.type === "TXN") {
      const t = e.data;
      const qty = Math.abs(Number(t.qty) || 0);
      if (!qty) continue;

      const price =
        Number(t.netrate) || (t.netAmount && qty ? t.netAmount / qty : 0);

      let profitLoss = null;

      /* ---- BUY ---- */
      if (isBuy(t.tranType)) {
        buyQueue.push({
          qty,
          price,
          buyDate: normalizeDate(t.trandate),
        });

        holdings += qty;
      }

      /* ---- SELL ---- */
      if (isSell(t.tranType)) {
        let remaining = qty;
        let fifoCost = 0;

        while (remaining > 0 && buyQueue.length) {
          const lot = buyQueue[0];
          const used = Math.min(lot.qty, remaining);

          fifoCost += used * lot.price;
          lot.qty -= used;
          remaining -= used;

          if (lot.qty === 0) buyQueue.shift(); // 🔥 remove closed lot
        }

        profitLoss = qty * price - fifoCost;
        holdings -= qty;
      }

      output.push({
        trandate: t.trandate,
        tranType: t.tranType,
        qty,
        price,
        netAmount: t.netAmount,
        holdings,
        costOfHoldings: getCostOfHoldings(),
        averageCostOfHoldings: getWAP(),
        profitLoss,
      });
    }

    /* ========== BONUS ========== */
    if (e.type === "BONUS") {
      const qty = Number(e.data.bonusShare) || 0;
      if (!qty) continue;

      buyQueue.push({
        qty,
        price: 0,
        buyDate: normalizeDate(e.data.exDate),
      });

      holdings += qty;

      output.push({
        trandate: e.data.exDate,
        tranType: "BONUS",
        qty,
        price: 0,
        netAmount: 0,
        holdings,
        costOfHoldings: getCostOfHoldings(),
        averageCostOfHoldings: getWAP(),
        profitLoss: null,
      });
    }

    /* ========== SPLIT (LINE-LEVEL, BACKDATED) ========== */
    if (e.type === "SPLIT") {
      if (!buyQueue.length) continue;

      const ratio1 = Number(e.data.ratio1);
      const ratio2 = Number(e.data.ratio2);
      if (!ratio1 || !ratio2) continue;

      const multiplier = ratio2 / ratio1;
      const splitDate = normalizeDate(e.data.issueDate);

      for (const lot of buyQueue) {
        // 🔥 APPLY ONLY TO LOTS BOUGHT BEFORE SPLIT DATE
        if (lot.buyDate > splitDate) continue;

        const oldQty = lot.qty;
        const oldPrice = lot.price;

        const newQty = oldQty * multiplier;
        const newPrice = oldPrice / multiplier;

        // 🔥 INSERT SPLIT ROW AT BUY DATE
        output.push({
          trandate: lot.buyDate,
          tranType: "SPLIT",
          qty: newQty,
          price: newPrice,
          netAmount: 0,
          holdings: null,
          costOfHoldings: null,
          averageCostOfHoldings: null,
          profitLoss: null,
        });

        // mutate FIFO lot
        lot.qty = newQty;
        lot.price = newPrice;
      }

      holdings *= multiplier;
    }
  }

  /* ---------------- CARD MODE ---------------- */
  if (card) {
    const last = output[output.length - 1] || {};
    return {
      holdingValue: last.costOfHoldings || 0,
      averageCostOfHoldings: last.averageCostOfHoldings || 0,
    };
  }

  return output.sort((a, b) => new Date(a.trandate) - new Date(b.trandate));
};
