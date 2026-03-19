const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocalDateMatch(value: string): Date | null {
  const match = LOCAL_DATE_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function coerceDate(value: Date | string | number): Date {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (typeof value === 'string') {
    const localDate = parseLocalDateMatch(value);
    if (localDate) {
      return localDate;
    }
  }

  return new Date(value);
}

export function parseLocalDateString(value: string): Date {
  return parseLocalDateMatch(value) ?? new Date(Number.NaN);
}

export function startOfLocalDay(value: Date | string | number = new Date()): Date {
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) {
    return date;
  }

  date.setHours(0, 0, 0, 0);
  return date;
}

export function toLocalDateString(value: Date | string | number = new Date()): string {
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addLocalDays(value: Date | string | number, days: number): Date {
  const date = startOfLocalDay(value);
  if (Number.isNaN(date.getTime())) {
    return date;
  }

  date.setDate(date.getDate() + days);
  return date;
}
