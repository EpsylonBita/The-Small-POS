export interface ParsedSpecialAddressInput {
  rawInput: string;
  trimmedInput: string;
  normalizedAddress: string;
  isSpecialLabelInput: boolean;
  shouldSkipZoneValidation: boolean;
}

export const parseSpecialAddressInput = (input: string): ParsedSpecialAddressInput => {
  const rawInput = typeof input === 'string' ? input : '';
  const trimmedInput = rawInput.trim();
  const isSpecialLabelInput = trimmedInput.startsWith('#');
  const normalizedAddress = isSpecialLabelInput
    ? trimmedInput.slice(1).trim()
    : trimmedInput;

  return {
    rawInput,
    trimmedInput,
    normalizedAddress,
    isSpecialLabelInput,
    shouldSkipZoneValidation: isSpecialLabelInput && normalizedAddress.length > 0,
  };
};
