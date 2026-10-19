/**
 * GIF constants (Phase 4; docs/archive/PHASE4_PLAN.md "Product decisions"). Pure module.
 */
import type { KlipyContentFilter } from './klipy.ts';

/** Klipy `content_filter` sent with every request unless `opts.rating` overrides it. A constant, not a UI setting. */
export const GIF_CONTENT_RATING: KlipyContentFilter = 'medium';

/** Which Klipy gif variant is sent as `url` (fallback order follows: hd -> md -> sm). hd averages ~4 MB; md ~2 MB. */
export const GIF_SEND_VARIANT: 'hd' | 'md' | 'sm' = 'hd';

/** Hosts whose https images the timeline will render inline from a `dev.matrixpoc.gif` field (plus own-origin `/gif-fixtures/`). */
export const GIF_IMAGE_HOSTS: readonly string[] = ['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com'];

/** Largest dimension accepted from the wire (anything bigger is treated as garbage). */
export const GIF_MAX_DIMENSION = 2000;

/** Default Klipy API origin; `VITE_GIF_API_BASE` overrides it (QA `page.route` stubs). */
export const KLIPY_DEFAULT_BASE = 'https://api.klipy.com';

/** localStorage key forcing a provider (`'klipy'` | `'mock'`) regardless of keys (QA flips per test). */
export const GIF_PROVIDER_STORAGE_KEY = 'matrix-poc.gifProvider';
/** localStorage key holding the runtime Klipy key override ('' / absent = use the build-time key). */
export const GIF_API_KEY_STORAGE_KEY = 'matrix-poc.gifApiKey';
/** localStorage key holding the stable per-user `customer_id` sent with every Klipy request (generated on first use). */
export const GIF_CUSTOMER_ID_STORAGE_KEY = 'matrix-poc.gifCustomerId';
