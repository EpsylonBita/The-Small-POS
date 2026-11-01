import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CheckRows,
  DirtyFooter,
  SegmentedControl,
  SettingsDirtyProvider,
  StatusLine,
  TechDisclosure,
  solidButton,
  useReportSettingsDirty,
  useSettingsDirtyRegistry,
} from '../SettingsKit';

afterEach(cleanup);

describe('SettingsKit', () => {
  it('segmented control is one radio group: tap or arrow keys pick one option', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        ariaLabel="Paper width"
        value="80"
        onChange={onChange}
        options={[{ value: '58', label: '58 mm' }, { value: '80', label: '80 mm' }, { value: '112', label: '112 mm' }]}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Paper width' });
    const radios = screen.getAllByRole('radio');
    expect(group).toBeInTheDocument();
    expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios[1]).toHaveAttribute('tabindex', '0');
    fireEvent.click(radios[2]);
    expect(onChange).toHaveBeenLastCalledWith('112');
    fireEvent.keyDown(radios[1], { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('58');
  });

  it('check rows toggle several choices and expose checkbox state', () => {
    const Harness = () => {
      const [selected, setSelected] = useState<string[]>(['receipt']);
      return (
        <CheckRows
          ariaLabel="What it prints"
          selected={selected}
          onToggle={(value, checked) => setSelected(prev => (checked ? [...prev, value] : prev.filter(v => v !== value)))}
          items={[{ value: 'receipt', label: 'Receipts' }, { value: 'kitchen', label: 'Kitchen' }]}
        />
      );
    };
    render(<Harness />);
    const kitchen = screen.getByRole('checkbox', { name: 'Kitchen' });
    expect(kitchen).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(kitchen);
    expect(kitchen).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Receipts' }));
    expect(screen.getByRole('checkbox', { name: 'Receipts' })).toHaveAttribute('aria-checked', 'false');
  });

  it('the footer appears only when something changed, with one primary save', () => {
    const onSave = vi.fn();
    const { rerender, container } = render(
      <DirtyFooter visible={false} saveLabel="Save" cancelLabel="Cancel" onSave={onSave} onCancel={() => {}} />,
    );
    expect(container.querySelector('[data-dirty-footer]')).toBeNull();
    rerender(<DirtyFooter visible note="1 change" saveLabel="Save" cancelLabel="Cancel" onSave={onSave} onCancel={() => {}} />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.className).toContain('pos-solid-btn--primary');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).not.toContain('pos-solid-btn--primary');
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('the technicians disclosure is closed by default and announces its state', () => {
    render(<TechDisclosure title="Settings for technicians"><span>Code page</span></TechDisclosure>);
    const toggle = screen.getByRole('button', { name: 'Settings for technicians' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Code page')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Code page')).toBeInTheDocument();
  });

  it('status is a coloured dot plus plain words, and buttons have three variants', () => {
    const { container } = render(<StatusLine tone="bad">Not responding</StatusLine>);
    expect(container.querySelector('.pos-status--bad .pos-status__dot')).not.toBeNull();
    expect(screen.getByText('Not responding')).toBeInTheDocument();
    expect(solidButton('primary')).toContain('pos-solid-btn--primary');
    expect(solidButton('danger', 'sm')).toContain('pos-solid-btn--danger');
    expect(solidButton('secondary')).not.toMatch(/--primary|--danger/);
  });

  it('sections report unsaved drafts to the shell and stop reporting when they close', () => {
    const seen: boolean[] = [];
    const Section = ({ dirty }: { dirty: boolean }) => { useReportSettingsDirty('waiter-devices', dirty); return null; };
    const Shell = ({ dirty, open }: { dirty: boolean; open: boolean }) => {
      const registry = useSettingsDirtyRegistry();
      seen.push(registry.anyDirty);
      return <SettingsDirtyProvider report={registry.report}>{open && <Section dirty={dirty} />}</SettingsDirtyProvider>;
    };
    const { rerender } = render(<Shell dirty={false} open />);
    expect(seen.at(-1)).toBe(false);
    act(() => { rerender(<Shell dirty open />); });
    expect(seen.at(-1)).toBe(true);
    act(() => { rerender(<Shell dirty open={false} />); });
    expect(seen.at(-1)).toBe(false);
  });
});
