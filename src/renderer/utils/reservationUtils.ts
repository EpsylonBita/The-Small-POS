/**
 * Reservation Utility Functions
 * 
 * Pure utility functions for reservation operations.
 * These functions have no external dependencies and can be easily tested.
 * 
 * Requirements:
 * - 4.6: Generate unique reservation number in format RES-YYYYMMDD-XXXX
 * 
 * **Feature: pos-tables-reservations-sync, Property 5: Reservation Number Format**
 * **Validates: Requirements 4.6**
 */

/**
 * Generate a reservation number in the format RES-YYYYMMDD-XXXX
 * 
 * **Feature: pos-tables-reservations-sync, Property 5: Reservation Number Format**
 * **Validates: Requirements 4.6**
 * 
 * @param date - The date for the reservation (defaults to current date)
 * @param sequenceNumber - The sequential number for the day (1-9999)
 * @returns Formatted reservation number string
 */
export function generateReservationNumber(date: Date = new Date(), sequenceNumber: number = 1): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const sequence = String(Math.min(Math.max(sequenceNumber, 1), 9999)).padStart(4, '0');
  
  return `RES-${year}${month}${day}-${sequence}`;
}

/**
 * Validate that a reservation number matches the expected format
 * 
 * **Feature: pos-tables-reservations-sync, Property 5: Reservation Number Format**
 * **Validates: Requirements 4.6**
 * 
 * @param reservationNumber - The reservation number to validate
 * @returns true if the format is valid
 */
export function validateReservationNumberFormat(reservationNumber: string): boolean {
  // Pattern: RES-YYYYMMDD-XXXX
  const pattern = /^RES-\d{4}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])-\d{4}$/;
  return pattern.test(reservationNumber);
}

/**
 * Parse a reservation number to extract its components
 * 
 * @param reservationNumber - The reservation number to parse
 * @returns Object with year, month, day, and sequence, or null if invalid
 */
export function parseReservationNumber(reservationNumber: string): {
  year: number;
  month: number;
  day: number;
  sequence: number;
} | null {
  if (!validateReservationNumberFormat(reservationNumber)) {
    return null;
  }
  
  const match = reservationNumber.match(/^RES-(\d{4})(\d{2})(\d{2})-(\d{4})$/);
  if (!match) {
    return null;
  }
  
  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10),
    day: parseInt(match[3], 10),
    sequence: parseInt(match[4], 10),
  };
}

/**
 * Check if a reservation time is within a specified number of minutes from now
 * 
 * **Feature: pos-tables-reservations-sync, Property 6: Near-Time Reservation Table Status**
 * **Validates: Requirements 4.4**
 * 
 * @param reservationTime - The reservation datetime
 * @param minutesThreshold - The threshold in minutes (default 30)
 * @param currentTime - The current time (defaults to now, useful for testing)
 * @returns true if the reservation is within the threshold
 */
export function isReservationWithinMinutes(
  reservationTime: Date,
  minutesThreshold: number = 30,
  currentTime: Date = new Date()
): boolean {
  const diffMs = reservationTime.getTime() - currentTime.getTime();
  const diffMinutes = diffMs / (1000 * 60);
  
  // Reservation is within threshold if it's in the future and within the minutes threshold
  // Also include reservations that are slightly in the past (up to 5 minutes) to handle edge cases
  return diffMinutes >= -5 && diffMinutes <= minutesThreshold;
}

/**
 * Check if a reservation is late (past scheduled time by more than specified minutes)
 * 
 * **Feature: pos-tables-reservations-sync, Property 10: Late Reservation Warning**
 * **Validates: Requirements 7.5**
 * 
 * @param reservationTime - The reservation datetime
 * @param lateThresholdMinutes - Minutes past scheduled time to consider late (default 15)
 * @param currentTime - The current time (defaults to now, useful for testing)
 * @returns true if the reservation is late
 */
export function isReservationLate(
  reservationTime: Date,
  lateThresholdMinutes: number = 15,
  currentTime: Date = new Date()
): boolean {
  const diffMs = currentTime.getTime() - reservationTime.getTime();
  const diffMinutes = diffMs / (1000 * 60);
  
  return diffMinutes > lateThresholdMinutes;
}
