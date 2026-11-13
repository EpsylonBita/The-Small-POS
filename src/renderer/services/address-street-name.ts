const genericStreetWords = new Set([
  'οδοσ', 'οδ', 'λεωφοροσ', 'λεωφ', 'λ', 'πλατεια', 'πλ',
  'street', 'st', 'road', 'rd', 'avenue', 'ave', 'rue', 'via', 'viale',
  'piazza', 'strasse', 'str', 'rruga', 'rr',
]);

function streetNameTokens(value: string): string[] {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/ς/g, 'σ').replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/)
    .filter(token => token && !/\p{N}/u.test(token) && !genericStreetWords.has(token));
}

/** Compare names conservatively so abbreviated map routes do not produce a warning. */
export function streetNamesDiffer(formText: string, mapRoute: string | undefined): boolean {
  if (!mapRoute) return false;
  const form = streetNameTokens(formText);
  const route = streetNameTokens(mapRoute);
  if (!form.length || !route.length) return false;
  const [shorter, longer] = form.length <= route.length ? [form, route] : [route, form];
  return !shorter.every(token => longer.some(other => token === other
    || (Math.min(token.length, other.length) >= 3 && (other.startsWith(token) || token.startsWith(other)))));
}
