export type PrintQueueMutationResponse = {
  success?: boolean;
  affected?: number;
  activeStopsRequested?: number;
  error?: string;
};

export const requireSuccessfulPrintQueueMutation = (
  result: PrintQueueMutationResponse | null | undefined,
  fallbackMessage: string,
): PrintQueueMutationResponse => {
  if (result?.success !== true) {
    throw new Error(result?.error || fallbackMessage);
  }
  return result;
};
