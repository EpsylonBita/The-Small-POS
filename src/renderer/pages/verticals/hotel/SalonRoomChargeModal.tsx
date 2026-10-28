import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../../../components/ui/pos-glass-components';
import type { RoomChargeContext } from '../../../components/modals/PaymentModal';
import { getRoomEffectiveStatus, roomsService, type Room } from '../../../services/RoomsService';
import { canChargeFolio } from '../../../utils/folio-currency';
import { getStoreCurrency } from '../../../utils/store-currency';

/** New service carts only. The server revalidates the pinned folio on posting. */
export function SalonRoomChargeModal({ branchId, organizationId, onSelect, onClose }: {
  branchId: string;
  organizationId: string;
  onSelect: (context: RoomChargeContext | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [roomId, setRoomId] = useState('');
  useEffect(() => {
    let current = true;
    setLoading(true);
    setRoomId('');
    setRooms([]);
    roomsService.setContext(branchId, organizationId);
    void roomsService.fetchRooms({}).then(values => {
      if (current) setRooms(values.filter(room =>
        room.organizationId === organizationId && room.branchId === branchId &&
        getRoomEffectiveStatus(room) === 'occupied' && room.activeFolio?.id &&
        canChargeFolio(room.activeFolio.currency, getStoreCurrency())));
    }).catch(() => { if (current) setRooms([]); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [branchId, organizationId]);

  const selected = rooms.find(room => room.id === roomId);
  return <LiquidGlassModal isOpen onClose={onClose} title={t('hotelDeskService.title')} className="max-w-lg!">
    <div className="space-y-4 p-1">
      <label htmlFor="service-room-charge" className="liquid-glass-modal-text block text-sm">
        {t('hotelDeskService.room')}
      </label>
      <select id="service-room-charge" value={roomId} onChange={event => setRoomId(event.target.value)} disabled={loading}
        className="w-full rounded-xl border border-slate-300 bg-white p-3 text-slate-950 dark:border-white/20 dark:bg-slate-900 dark:text-white">
        <option value="">{t('hotelDeskService.chooseRoom')}</option>
        {rooms.map(room => <option key={room.id} value={room.id}>
          {room.roomNumber}{room.activeFolio?.guestName ? ` · ${room.activeFolio.guestName}` : ''}
        </option>)}
      </select>
      <p role="status" className="liquid-glass-modal-text-muted text-sm">
        {loading ? t('hotelDeskService.loading') : !rooms.length ? t('hotelDeskService.noRooms') : t('hotelDeskService.hint')}
      </p>
      <div className="flex gap-3">
        <button type="button" className="liquid-glass-modal-button flex-1 rounded-xl p-3" onClick={() => onSelect(null)}>
          {t('hotelDeskService.collectNow')}
        </button>
        <button type="button" className="liquid-glass-modal-button flex-1 rounded-xl p-3" disabled={!selected || loading}
          onClick={() => {
            if (!selected?.activeFolio?.id || !canChargeFolio(selected.activeFolio.currency, getStoreCurrency())) return;
            onSelect({ roomId: selected.id, roomNumber: selected.roomNumber,
              activeFolioId: selected.activeFolio.id, guestName: selected.activeFolio.guestName,
              currency: selected.activeFolio.currency });
          }}>
          {t('hotelDeskService.useRoom')}
        </button>
      </div>
    </div>
  </LiquidGlassModal>;
}
