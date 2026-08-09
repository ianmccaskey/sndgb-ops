/**
 * Client-side integration with the ordering app (a custom base44 app at
 * ratcartelgroupbuy.shop). base44 exposes every entity as REST:
 *
 *   GET https://base44.app/api/apps/{appId}/entities/{Entity}?sort=..&limit=..&q={"field":"value"}
 *   Authorization: Bearer <JWT>
 *
 * The app id and JWT are entered on the Settings page (app_settings keys
 * `base44_app_id` / `base44_token`) — same pattern as the Moralis/Helius keys.
 *
 * Entity shapes were confirmed against the live admin dashboard:
 *  - GroupBuy: title, abbreviation, status ('active'|'closed'), admin_fee,
 *    shipping_fee, start_date, end_date, description, …
 *  - Order: order_number ('2026-MB5-193'), group_buy_id, items[] of
 *    {product_id, product_name, price, quantity}, payment/shipping fields, …
 *  - Product: fetched as Product?sort=-sort_order&limit=1000; exact fields are
 *    surfaced in the sync preview, so scoping stays defensive (see below).
 */

export const B44_DEFAULT_APP_ID = '69157b827c06411f4ed6bf0f';

export type B44Config = { appId: string; token: string };

export type B44GroupBuy = {
  id: string;
  title?: string;
  abbreviation?: string;
  status?: string;
  admin_fee?: number;
  shipping_fee?: number;
  start_date?: string;
  end_date?: string;
  created_date?: string;
};

/** Products are kept loose on purpose — the entity's schema is app-defined. */
export type B44Product = {
  id: string;
  name?: string;
  price?: number;
  [key: string]: unknown;
};

async function b44Get(cfg: B44Config, path: string): Promise<unknown> {
  const appId = cfg.appId.trim() || B44_DEFAULT_APP_ID;
  let res: Response;
  try {
    res = await fetch(`https://base44.app/api/apps/${appId}${path}`, {
      headers: { Authorization: `Bearer ${cfg.token.trim()}`, accept: 'application/json' },
    });
  } catch {
    throw new Error('Could not reach the ordering app API — check your network connection.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    if (res.status === 401 || res.status === 403) {
      throw new Error(body?.message || 'Ordering app rejected the token — re-check the JWT in Settings.');
    }
    throw new Error(body?.message || `Ordering app request failed (HTTP ${res.status}).`);
  }
  return res.json();
}

export async function listB44GroupBuys(cfg: B44Config): Promise<B44GroupBuy[]> {
  const data = await b44Get(cfg, '/entities/GroupBuy?sort=-created_date&limit=1000');
  return Array.isArray(data) ? data as B44GroupBuy[] : [];
}

export async function listB44Products(cfg: B44Config): Promise<B44Product[]> {
  const data = await b44Get(cfg, '/entities/Product?sort=-sort_order&limit=1000');
  return Array.isArray(data) ? data as B44Product[] : [];
}

export type B44OrderItem = {
  product_id?: string;
  product_name?: string;
  price?: number;
  quantity?: number;
  [key: string]: unknown;
};

export type B44Order = {
  id: string;
  order_number?: string;
  group_buy_id?: string;
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  discord_username?: string;
  shipping_address_line1?: string;
  shipping_address_line2?: string;
  shipping_city?: string;
  shipping_state?: string;
  shipping_zip_code?: string;
  payment_method?: string;
  subtotal?: number;
  tip?: number;
  admin_fee?: number;
  shipping_fee?: number;
  total?: number;
  transaction_hashtags?: string;
  customer_notes?: string | null;
  notes?: string | null;
  status?: string;
  created_date?: string;
  items?: B44OrderItem[];
  [key: string]: unknown;
};

/** All orders for one group buy, filtered server-side and paginated. */
export async function listB44Orders(cfg: B44Config, gbExternalId: string): Promise<B44Order[]> {
  const out: B44Order[] = [];
  const limit = 1000;
  const q = encodeURIComponent(JSON.stringify({ group_buy_id: gbExternalId }));
  for (let skip = 0; ; skip += limit) {
    const batch = await b44Get(cfg, `/entities/Order?q=${q}&sort=-created_date&limit=${limit}&skip=${skip}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch as B44Order[]);
    if (batch.length < limit) break;
  }
  return out;
}

/**
 * Scope products to one group buy without assuming the linking field's name.
 * Checks the common base44 shapes (`group_buy_id` string, `group_buy_ids`
 * array — PaymentConfig in this app uses the latter). Returns null when no
 * linking field exists so the caller can fall back to showing everything.
 */
export function scopeProductsToGroupBuy(products: B44Product[], gbExternalId: string): B44Product[] | null {
  const hasSingle = products.some(p => typeof p.group_buy_id === 'string');
  const hasMulti = products.some(p => Array.isArray(p.group_buy_ids));
  if (!hasSingle && !hasMulti) return null;
  return products.filter(p =>
    (typeof p.group_buy_id === 'string' && p.group_buy_id === gbExternalId) ||
    (Array.isArray(p.group_buy_ids) && (p.group_buy_ids as unknown[]).includes(gbExternalId))
  );
}
