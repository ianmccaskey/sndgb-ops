-- A SUCCESS refund at Shippo means the carrier confirmed the label was
-- NEVER USED (USPS/UPS only refund unused labels): the shipment did not
-- move, so its items must return to on-hand instead of understating
-- inventory forever. The Re-check reconcile flow records Shippo's real
-- refund status, so SUCCESS arrives verified — earlier states
-- (REQUESTING/REFUNDPENDING/QUEUED/PENDING) keep counting as transferred
-- until the carrier actually settles.
CREATE OR REPLACE VIEW v_address_inventory AS
WITH rcv AS (
  SELECT p.receive_address_id, i.product_id, sum(i.qty) AS received_qty
  FROM inbound_package_items i
  JOIN inbound_packages p ON p.id = i.package_id
  WHERE p.received_at IS NOT NULL
  GROUP BY p.receive_address_id, i.product_id
), xfr AS (
  SELECT t.from_address_id AS receive_address_id, ti.product_id, sum(ti.qty) AS transferred_qty
  FROM transfer_items ti
  JOIN transfers t ON t.id = ti.transfer_id
  WHERE t.finalized_at IS NOT NULL
    AND COALESCE(t.refund_status, '') <> 'SUCCESS'
  GROUP BY t.from_address_id, ti.product_id
)
SELECT COALESCE(rcv.receive_address_id, xfr.receive_address_id) AS receive_address_id,
       COALESCE(rcv.product_id, xfr.product_id) AS product_id,
       COALESCE(rcv.received_qty, 0::numeric) AS received_qty,
       COALESCE(xfr.transferred_qty, 0::numeric) AS transferred_qty,
       COALESCE(rcv.received_qty, 0::numeric) - COALESCE(xfr.transferred_qty, 0::numeric) AS on_hand_qty
FROM rcv
FULL JOIN xfr ON xfr.receive_address_id = rcv.receive_address_id AND xfr.product_id = rcv.product_id;
