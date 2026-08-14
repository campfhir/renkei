/**
 * The Luhn check digit, as used by every major card network.
 *
 * This is what makes payment-card detection usable: length and issuer prefix
 * alone match plenty of internal identifiers, and requiring the checksum cuts
 * accidental matches by roughly a factor of ten. It is a formatting check, not
 * a validity one — it says "this could be a card number", never "this is a
 * live card".
 */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 12) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    // Safe: the regex above proved every character is a digit.
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
