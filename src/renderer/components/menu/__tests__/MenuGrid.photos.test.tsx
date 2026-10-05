import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuGrid } from '../MenuGrid';
import { getPosMenuImageUrl } from '../../../utils/menuImages';
import { OptimizedImg } from '../../ui/OptimizedImg';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../utils/format', () => ({ formatCurrency: (value: number) => `€${value}` }));
afterEach(cleanup);
const photo = 'https://images.example.test/coffee.jpg';

describe('actual Windows ordering photo grid', () => {
  it.each([[true, true], [true, false], [false, true], [false, false]])(
    'POS=%s kiosk=%s keeps product tap and price while controlling the photo', (pos, kiosk) => {
      const onItemClick = vi.fn();
      const photoFields = { image_url: photo, show_image_in_pos: pos, show_image_in_kiosk: kiosk };
      const item = { id: 'coffee', name: 'Coffee', description: '', price: 3, category_id: 'drinks', preparationTime: 0,
        image: getPosMenuImageUrl(photoFields) ?? undefined };
      render(<MenuGrid items={[item]} selectedCategory="drinks" categories={[]} onCategoryChange={() => {}} onItemClick={onItemClick} />);
      expect(Boolean(screen.queryByRole('img', { name: 'Coffee' }))).toBe(pos);
      fireEvent.click(screen.getByText('Coffee'));
      expect(onItemClick).toHaveBeenCalledWith(item);
    }
  );

  it('an image load error does not conceal a subsequently replaced photo', () => {
    const view = render(<OptimizedImg src={photo} alt="Coffee" />);
    fireEvent.error(screen.getByRole('img', { name: 'Coffee' }));
    expect(screen.getByRole('img', { name: 'Coffee' }).tagName).toBe('DIV');
    const replacement = 'https://images.example.test/replacement.jpg';
    view.rerender(<OptimizedImg src={replacement} alt="Coffee" />);
    expect(screen.getByRole('img', { name: 'Coffee' })).toHaveAttribute('src', replacement);
  });

  it('explicit null cannot fall back to an older camel URL', () => {
    expect(getPosMenuImageUrl({ image_url: null, imageUrl: photo })).toBeNull();
  });
});
