/**
 * Which of a notification's links lives outside Renkei. Pure — shared by
 * the push payload (decided when the push is sent) and the open route
 * (decided again when the banner is clicked), so the two never disagree
 * about what "the source application" means.
 *
 * A `ref_url` is either a path on this origin (`/acme/chat/…` — a chat, an
 * agent) or the provider's own link: `https://….atlassian.net/browse/…`,
 * `webexteams://im?space=…`. Anything with a scheme is the provider's;
 * the act receipts that produce these (packages/tool-outcomes) allow only
 * `https:` and `webexteams:`, so there is no third case to worry about.
 */
export function isExternalNotificationUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  if (url.startsWith('/')) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

/**
 * A link a browser can be sent to with a redirect. A custom scheme
 * (`webexteams://`) is opened from a page instead, since a 302 to it is
 * not something every browser follows.
 */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
