// Phone numbers: North American (NANP) only, as E.164 digits ("16135550123"),
// which is what the line dials (the sub-account's dial mode is E.164).
// Emergency, N11 and premium-rate numbers are refused: Jarvis never dials them.

export class NumberError extends Error {}

/** "613-555-0123", "+1 (613) 555 0123", "16135550123" → "16135550123". Throws NumberError. */
export function toE164(input: string): string {
  const raw = input.trim()
  if (/^\+?\s*(1[\s.-]*)?9[\s.-]*1[\s.-]*1\s*$/.test(raw) || raw.replace(/\D/g, '') === '911') throw new NumberError('Jarvis never calls 911: call it yourself from your phone.')
  let digits = raw.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) {
    digits = digits.slice(1)
    if (!digits.startsWith('1')) throw new NumberError('Only North American numbers (+1) can be called: international calls are off.')
  } else if (digits.startsWith('011')) {
    throw new NumberError('International calls are off.')
  }
  digits = digits.replace(/\D/g, '')
  if (digits.length === 10) digits = `1${digits}`
  if (digits.length !== 11 || !digits.startsWith('1')) throw new NumberError(`"${input}" isn't a 10-digit North American number.`)
  const area = digits.slice(1, 4)
  const exchange = digits.slice(4, 7)
  if (/^[01]/.test(area) || /^[01]/.test(exchange)) throw new NumberError(`"${input}" isn't a valid North American number.`)
  if (/^\d11$/.test(area) || /^\d11$/.test(exchange)) throw new NumberError(`"${input}" isn't a number Jarvis can call (N11 service codes are refused).`)
  if (area === '900' || area === '976' || exchange === '976') throw new NumberError('Premium-rate numbers are refused.')
  return digits
}

/** "16135550123" → "+1 613-555-0123"; anything else as it is. */
export function display(number: string): string {
  const m = /^1?(\d{3})(\d{3})(\d{4})$/.exec(number)
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : number || 'unknown'
}

/** The same number, whatever the format (for matching the owner's cell). */
export function sameNumber(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return Boolean(a && b) && norm(a) === norm(b)
}
