import { action } from '@uibakery/data';

function listRailRecon() {
  return action('listRailRecon', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT rr.payment_rail, rr.order_count, rr.billed_usd, rr.received_usd, rr.gap_usd,
             ws.wallet_name, ws.wallet_balance_usd, ws.taken_at AS snapshot_at, ws.wallet_count,
             vpo.vendor_paid_usd, vpo.vendor_paid_asof_usd,
             rfo.refunded_usd, rfo.refunded_asof_usd
      FROM v_rail_reconciliation rr
      -- ALL wallets on the rail, each at its latest snapshot, summed — the
      -- same scope as the payout sum below, so expected-vs-snapshot drift
      -- compares like with like even with multiple wallets per chain.
      -- taken_at reports the OLDEST of the latest snapshots (the staleness
      -- bound of the combined figure).
      LEFT JOIN LATERAL (
        SELECT string_agg(x.name, ' + ') FILTER (WHERE x.balance_usd IS NOT NULL) AS wallet_name,
               SUM(x.balance_usd) AS wallet_balance_usd,
               MIN(x.taken_at) AS taken_at,
               -- counts EVERY wallet mapped to the rail, snapshotted or not:
               -- the expected-vs-snapshot drift is only a coherent claim when
               -- the rail has exactly ONE wallet (one balance, one moment,
               -- one as-of payout figure) AND that wallet has a snapshot —
               -- the UI suppresses the drift line otherwise. A snapshot-only
               -- count would misread a two-wallet rail with one unsnapshotted
               -- wallet as single-wallet and fabricate drift.
               COUNT(*) AS wallet_count
        FROM (
          SELECT w.name, ls.balance_usd, ls.taken_at
          FROM wallets w
          LEFT JOIN LATERAL (
            SELECT s.balance_usd, s.taken_at
            FROM wallet_snapshots s
            WHERE s.wallet_id = w.id
            ORDER BY s.taken_at DESC
            LIMIT 1
          ) ls ON true
          WHERE w.chain::text = rr.payment_rail::text
             OR (rr.payment_rail = 'cash' AND w.chain = 'fiat')
        ) x
      ) ws ON true
      -- money paid OUT of this rail's wallet(s) to vendors for this campaign:
      -- lets the card explain a lower wallet balance instead of it reading
      -- like missing customer money
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(vp.amount_usd), 0) AS vendor_paid_usd,
               -- only payouts already reflected in the observed balances
               -- participate in the expected-vs-snapshot math, judged PER
               -- PAYING WALLET against that wallet's own latest snapshot.
               -- The cutoff compares the payout row's created_at (timestamp,
               -- when it was recorded) to the snapshot's taken_at — full
               -- precision, so same-day ordering is provable for the normal
               -- flow (pay → record → refresh snapshot). A payout recorded
               -- after the snapshot shows as drift until the next snapshot
               -- proves it — conservative and self-healing.
               COALESCE(SUM(vp.amount_usd) FILTER (WHERE wsnap.taken_at IS NOT NULL AND vp.created_at <= wsnap.taken_at), 0) AS vendor_paid_asof_usd
        FROM vendor_payments vp
        JOIN wallets w2 ON w2.id = vp.wallet_id
        LEFT JOIN LATERAL (
          SELECT s.taken_at
          FROM wallet_snapshots s
          WHERE s.wallet_id = w2.id
          ORDER BY s.taken_at DESC
          LIMIT 1
        ) wsnap ON true
        WHERE vp.group_buy_id = {{params.group_buy_id}}::bigint
          AND (w2.chain::text = rr.payment_rail::text
               OR (rr.payment_rail = 'cash' AND w2.chain = 'fiat'))
      ) vpo ON true
      -- money RETURNED to customers out of this rail's wallet(s): same shape
      -- and cutoff semantics as the vendor payouts above, so a refund never
      -- reads as missing customer money on the wallet card. Only
      -- wallet-linked refunds participate (a refund with no wallet has no
      -- observable balance to explain).
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(orf.amount_usd), 0) AS refunded_usd,
               COALESCE(SUM(orf.amount_usd) FILTER (WHERE rsnap.taken_at IS NOT NULL AND orf.created_at <= rsnap.taken_at), 0) AS refunded_asof_usd
        FROM order_refunds orf
        JOIN orders o3 ON o3.id = orf.order_id AND o3.group_buy_id = {{params.group_buy_id}}::bigint
        JOIN wallets w3 ON w3.id = orf.wallet_id
        LEFT JOIN LATERAL (
          SELECT s.taken_at
          FROM wallet_snapshots s
          WHERE s.wallet_id = w3.id
          ORDER BY s.taken_at DESC
          LIMIT 1
        ) rsnap ON true
        WHERE (w3.chain::text = rr.payment_rail::text
               OR (rr.payment_rail = 'cash' AND w3.chain = 'fiat'))
      ) rfo ON true
      WHERE rr.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY rr.payment_rail
    `,
  });
}

export default listRailRecon;
