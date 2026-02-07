/**
 * Utility function for combining class names
 * Filters out falsy values and joins the remaining strings
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
} 