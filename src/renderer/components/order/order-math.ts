export function calculateSubtotalFromItems(items: any[]): number {
  if (!Array.isArray(items) || items.length === 0) {
    return 0;
  }

  return items.reduce((sum: number, item: any) => {
    const quantity = item.quantity || 1;

    if (typeof item.total_price === 'number' && item.total_price > 0) {
      return sum + item.total_price;
    }

    if (typeof item.totalPrice === 'number' && item.totalPrice > 0) {
      return sum + item.totalPrice;
    }

    const unitPrice = typeof item.unit_price === 'number'
      ? item.unit_price
      : typeof item.price === 'number'
        ? item.price
        : 0;

    return sum + (unitPrice * quantity);
  }, 0);
}
