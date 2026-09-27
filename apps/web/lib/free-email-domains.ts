/**
 * Free/consumer webmail domains that cannot self-service register an
 * organization: registration keys a tenant to a domain nobody but its owner
 * can receive mail at, and a gmail.com/outlook.com/etc. address proves
 * nothing about which company (if any) its holder belongs to — anyone could
 * claim the "acme" tenant by signing up as a private individual. Letting
 * these domains through `home-realm/create` would let a stranger stand up a
 * tenant that isn't tied to any real organization at all.
 *
 * Not a disposable/throwaway-email blocklist — that is a different, much
 * longer list. This is deliberately the short list of mainstream personal
 * webmail providers the product description calls out (Gmail, Yahoo,
 * Outlook.com, ...).
 */
const FREE_EMAIL_DOMAINS = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Yahoo
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.ca',
  'yahoo.com.au',
  'yahoo.co.in',
  'yahoo.fr',
  'yahoo.de',
  'ymail.com',
  'rocketmail.com',
  // Microsoft consumer webmail — distinct from a company's Microsoft 365
  // domain, which is always the company's own custom domain, never these.
  'outlook.com',
  'outlook.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'hotmail.de',
  'live.com',
  'live.co.uk',
  'msn.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Other mainstream consumer providers
  'aol.com',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'web.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'daum.net',
  'rediffmail.com',
  'fastmail.com',
  'tutanota.com',
  'hushmail.com',
  'inbox.com',
]);

/** Case-insensitive: `domain` is expected pre-trimmed, as callers already do. */
export function isFreeEmailDomain(domain: string): boolean {
  return FREE_EMAIL_DOMAINS.has(domain.toLowerCase());
}

export const FREE_EMAIL_DOMAIN_ERROR =
  "Personal email domains like gmail.com, yahoo.com, and outlook.com can't register an organization — use your company's work email domain instead.";
