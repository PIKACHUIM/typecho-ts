export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Table prefix, mirrors Typecho's config.inc.php $db->addPrefix(). */
  DB_PREFIX?: string;
  /** Optional site URL override (like __TYPECHO_SITE_URL__). */
  SITE_URL?: string;
}
