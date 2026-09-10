export interface PickupCustomerDraft {
  name: string;
  phone: string;
  notes: string;
}

type Customer = Record<string, any> | null | undefined;

export function readPickupCustomerDraft(customer: Customer): PickupCustomerDraft {
  return {
    name: customer?.name ?? customer?.full_name ?? customer?.customer_name ?? '',
    phone: customer?.phone_number ?? customer?.phone ?? '',
    notes: customer?.notes ?? '',
  };
}

// Object identity is unstable in the caller, so reopening or changing the
// customer resets the form while ordinary parent renders preserve typing.
export function pickupCustomerIdentity(customer: Customer): string {
  const id = customer?.id ?? customer?.customer_id ?? customer?.customerId;
  if (id) return `id:${id}`;
  if (!customer) return '';
  const { name, phone } = readPickupCustomerDraft(customer);
  return JSON.stringify([name, phone]);
}

export function buildPickupOrderDetails(
  customer: Customer,
  draft: PickupCustomerDraft,
  checkoutNotes = '',
) {
  const name = draft.name.trim();
  const phone = draft.phone.trim();
  const notes = draft.notes.trim();
  return {
    customer: !customer && !name && !phone && !notes ? null : {
      ...customer,
      name,
      phone,
      phone_number: phone,
      notes,
      // Keep legacy aliases consistent so downstream readers cannot restore
      // the old name after the operator clears the field.
      ...(customer && 'full_name' in customer ? { full_name: name } : {}),
      ...(customer && 'customer_name' in customer ? { customer_name: name } : {}),
    },
    notes: [...new Set([checkoutNotes.trim(), notes].filter(Boolean))].join('\n'),
  };
}
