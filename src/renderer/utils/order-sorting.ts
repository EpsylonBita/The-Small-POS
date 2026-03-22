import type { Order } from '../../shared/types/orders';

type SortableOrder = Pick<
  Order,
  'id' | 'created_at' | 'createdAt' | 'updated_at' | 'updatedAt' | 'order_number' | 'orderNumber'
>;

const toTimestamp = (value: string | undefined): number => {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const getOrderNumber = (order: SortableOrder): string => {
  return String(order.order_number || order.orderNumber || '').trim();
};

export const compareOrdersOldestFirst = <T extends SortableOrder>(left: T, right: T): number => {
  const createdDiff =
    toTimestamp(left.created_at || left.createdAt) -
    toTimestamp(right.created_at || right.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }

  const updatedDiff =
    toTimestamp(left.updated_at || left.updatedAt) -
    toTimestamp(right.updated_at || right.updatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  const orderNumberCompare = getOrderNumber(left).localeCompare(getOrderNumber(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (orderNumberCompare !== 0) {
    return orderNumberCompare;
  }

  return String(left.id || '').localeCompare(String(right.id || ''));
};

export const sortOrdersOldestFirst = <T extends SortableOrder>(orders: T[]): T[] => {
  return [...orders].sort(compareOrdersOldestFirst);
};
