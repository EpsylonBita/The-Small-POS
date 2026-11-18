export interface OrderSyncNotice {
  orderId: string;
  orderNumber: string;
  kind: 'customer_correction_refused' | 'change_refused' | 'payment_not_on_server';
  queueId: string;
  since: string;
  state: 'refused' | 'pending' | 'waiting';
  actions: string[];
  failedAgain?: boolean;
  automatic?: boolean;
  unavailableReason?: 'offline' | 'busy' | null;
}
