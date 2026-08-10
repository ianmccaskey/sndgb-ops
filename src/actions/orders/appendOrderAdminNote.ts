import { action } from '@uibakery/data';

/**
 * Append a line to an order's admin notes without touching status/hold —
 * used for system-generated trail entries (e.g. "pushed tx refs upstream").
 * Returns the full new admin_note so the UI can sync its editor state and a
 * later manual note-save doesn't overwrite the appended line.
 */
function appendOrderAdminNote() {
  return action('appendOrderAdminNote', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE orders SET
          admin_note = CASE
            WHEN admin_note IS NULL OR admin_note = '' THEN {{params.note}}
            ELSE admin_note || E'\\n' || {{params.note}}
          END
        WHERE id = {{params.order_id}}::bigint
        RETURNING id, admin_note
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'orders', upd.id::text, 'admin_note_appended', {{params.actor}},
               jsonb_build_object('note', {{params.note}}, 'detail', {{params.detail}}::jsonb)
        FROM upd
        RETURNING row_pk
      )
      SELECT id, admin_note FROM upd
    `,
  });
}

export default appendOrderAdminNote;
