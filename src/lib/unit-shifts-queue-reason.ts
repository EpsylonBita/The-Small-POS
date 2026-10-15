import type { TFunction } from "i18next";

/**
 * A queued Z the server holds while phone shifts of the unit are open
 * (founder rule 13/10/2026). The native queue stores its reason as the code
 * and the names the refusal carried, never an English sentence
 * (`Z_REPORT_UNIT_SHIFTS_OPEN: Maria (Phone 1), Nikos (Phone 2)`), so Sync
 * health and the closeout blockers say it in the store's language
 * (coordinator review 14/10/2026).
 */
export const Z_REPORT_UNIT_SHIFTS_OPEN_REASON = "Z_REPORT_UNIT_SHIFTS_OPEN";

/** The names a held Z's reason carries (`""` when none), or `null` for any other reason. */
export function unitShiftsQueueReasonNames(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed.startsWith(Z_REPORT_UNIT_SHIFTS_OPEN_REASON)) {
    return null;
  }
  let names = trimmed.slice(Z_REPORT_UNIT_SHIFTS_OPEN_REASON.length).replace(/^\s*:\s*/, "").trim();
  // A reason stored with the server's English sentence names the shifts after it.
  const sentenceEnd = names.indexOf("before the Z:");
  if (sentenceEnd >= 0) {
    names = names.slice(sentenceEnd + "before the Z:".length).trim();
  }
  return names;
}

/** The operator's sentence for a held Z, or `null` for any other reason. */
export function formatUnitShiftsQueueReason(
  reason: string | null | undefined,
  t: TFunction,
): string | null {
  const names = unitShiftsQueueReasonNames(reason);
  if (names === null) {
    return null;
  }
  return names
    ? t("sync.blockerReasons.zReportUnitShiftsOpen", {
      shifts: names,
      defaultValue:
        "The Z waits: phone shifts are still open: {{shifts}}. Close them on the phone, or from Staff on this register; the Z is sent by itself afterwards.",
    })
    : t("sync.blockerReasons.zReportUnitShiftsOpenUnnamed", {
      defaultValue:
        "The Z waits: a phone shift is still open. Close it on the phone, or from Staff on this register; the Z is sent by itself afterwards.",
    });
}
