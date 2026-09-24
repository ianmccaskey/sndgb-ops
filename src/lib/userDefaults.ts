/**
 * Per-admin ship-from default (Ian: "when I'm logged in it defaults to
 * Ian PMB 1, when Paige is logged in hers defaults to Paige PMB 1").
 * Stored in app_settings keyed by the signed-in name so it follows the
 * LOGIN across devices; the global is_default_ship_from flag remains the
 * fallback for anyone without a personal default.
 */
export const myShipFromKey = (userName: string) =>
  `default_ship_from:${String(userName ?? '').trim().toLowerCase()}`;

export const myShipFromId = (settings: Record<string, string>, userName: string): string =>
  settings[myShipFromKey(userName)] || '';
