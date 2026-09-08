-- Inventory truth: finalized order shipments deplete on-hand (Ian 2026-09-07).
--
-- Until now v_address_inventory = received − transferred, so packing
-- individual orders from a box left the Receiving side reading full: Paige
-- could open Ian's dashboard and see a sealed KPV30 box of 54 that had been
-- emptied into customer orders. Order shipments record their ship-from
-- address (a transfer-origin group id, exactly like transfers debit the
-- origin) and their per-line quantities, so the view now subtracts them:
--
--   on_hand = received − transferred − shipped
--
-- Which shipments count: finalized only (drafts reserve nothing here — the
-- fulfillment reservation system owns that), refund_status SUCCESS excluded
-- (a provably-refunded label means the box never left; units return, the
-- same rule transfers follow), and NULL ship_from excluded (adopted
-- upstream shipments have no local ship-from — those units were never in a
-- local box this view tracks).
--
-- shipped_qty is APPENDED as a sixth column (CREATE OR REPLACE VIEW allows
-- appending). The transfer fns' group on-hand gates read this view, so
-- they automatically stop offering stock that was already packed out —
-- stricter, and correct.

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
  WHERE t.finalized_at IS NOT NULL AND COALESCE(t.refund_status, '') <> 'SUCCESS'
  GROUP BY t.from_address_id, ti.product_id
), shp AS (
  SELECT s.ship_from_address_id AS receive_address_id, gbp.product_id, sum(si.qty) AS shipped_qty
  FROM shipment_items si
  JOIN shipments s ON s.id = si.shipment_id
  JOIN order_items oi ON oi.id = si.order_item_id
  JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
  WHERE s.finalized_at IS NOT NULL AND COALESCE(s.refund_status, '') <> 'SUCCESS'
    AND s.ship_from_address_id IS NOT NULL
  GROUP BY s.ship_from_address_id, gbp.product_id
)
SELECT COALESCE(rcv.receive_address_id, xfr.receive_address_id, shp.receive_address_id) AS receive_address_id,
       COALESCE(rcv.product_id, xfr.product_id, shp.product_id) AS product_id,
       COALESCE(rcv.received_qty, 0::numeric) AS received_qty,
       COALESCE(xfr.transferred_qty, 0::numeric) AS transferred_qty,
       COALESCE(rcv.received_qty, 0::numeric)
         - COALESCE(xfr.transferred_qty, 0::numeric)
         - COALESCE(shp.shipped_qty, 0::numeric) AS on_hand_qty,
       COALESCE(shp.shipped_qty, 0::numeric) AS shipped_qty
FROM rcv
FULL JOIN xfr ON xfr.receive_address_id = rcv.receive_address_id AND xfr.product_id = rcv.product_id
FULL JOIN shp ON shp.receive_address_id = COALESCE(rcv.receive_address_id, xfr.receive_address_id)
             AND shp.product_id = COALESCE(rcv.product_id, xfr.product_id);
