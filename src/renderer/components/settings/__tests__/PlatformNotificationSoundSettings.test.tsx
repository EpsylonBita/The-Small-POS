import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  enabled: true,
  snapshot: { loaded: true, selectedId: 'default', importedName: null as string | null, hasImportedClip: false, storageUnavailable: false, previewingId: null as string | null },
  select: vi.fn(), custom: vi.fn(), importFile: vi.fn(), preview: vi.fn(), stop: vi.fn(),
}));
vi.mock('../../../services/appAudio', () => ({ useAppAudioEnabled: () => mock.enabled }));
vi.mock('../../../services/platformNotificationSound', () => ({
  PLATFORM_SOUND_PRESETS: [
    { id: 'default', labelKey: 'default', defaultLabel: 'Incoming order (default)' },
    { id: 'spiderman', labelKey: 'spiderman', defaultLabel: 'Spider-Man' },
    { id: 'one_piece', labelKey: 'one_piece', defaultLabel: 'One Piece' },
    { id: 'super_mario', labelKey: 'super_mario', defaultLabel: 'Super Mario' },
  ],
  usePlatformNotificationSoundSelection: () => mock.snapshot,
  selectPlatformSoundPreset: mock.select, selectImportedPlatformSound: mock.custom,
  importPlatformSoundFile: mock.importFile, previewPlatformSound: mock.preview, stopPlatformSoundPreview: mock.stop,
}));
vi.mock('react-i18next', () => ({useTranslation: () => ({t: (key: string, options?: any) => typeof options === 'string' ? options : options?.defaultValue?.replace('{{name}}', options.name) ?? key})}));
import { PlatformNotificationSoundSettings } from '../PlatformNotificationSoundSettings';
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.enabled = true;
  mock.snapshot = { loaded: true, selectedId: 'default', importedName: null, hasImportedClip: false, storageUnavailable: false, previewingId: null };
  mock.select.mockResolvedValue({ok:true}); mock.custom.mockResolvedValue({ok:true}); mock.importFile.mockResolvedValue({ok:true});
});
it('offers four bundled choices and persists the selected preset', async () => {
  render(<PlatformNotificationSoundSettings/>);
  expect(screen.getAllByRole('radio')).toHaveLength(4);
  expect(screen.getByRole('radio',{name:'Incoming order (default)'})).toBeChecked();
  fireEvent.click(screen.getByRole('radio',{name:'One Piece'}));
  await waitFor(() => expect(mock.select).toHaveBeenCalledWith('one_piece'));
});
it('keeps all mutation controls disabled while saving and displays failure without changing the selected choice', async () => {
  let finish!: (value:any)=>void;
  mock.select.mockImplementation(() => new Promise(resolve => {finish=resolve;}));
  const {container}=render(<PlatformNotificationSoundSettings/>);
  fireEvent.click(screen.getByRole('radio',{name:'Super Mario'}));
  for(const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  expect(container.querySelector('input[type=file]')).toBeDisabled();
  await act(async()=>finish({ok:false,error:'Could not save'}));
  expect(screen.getByText('Could not save')).toBeInTheDocument();
  expect(screen.getByRole('radio',{name:'Incoming order (default)'})).toBeChecked();
});
it('cancelled file selection does not import or replace the selected sound', () => {
  const {container}=render(<PlatformNotificationSoundSettings/>);
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[]}});
  expect(mock.importFile).not.toHaveBeenCalled();
});
it('imports the selected file and cancels unfinished validation when the screen unmounts', () => {
  mock.importFile.mockImplementation(()=>new Promise(()=>{}));
  const {container,unmount}=render(<PlatformNotificationSoundSettings/>);
  const file=new File(['audio'],'my-sound.mp3',{type:'audio/mpeg'});
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[file]}});
  expect(mock.importFile.mock.calls[0][0]).toBe(file);
  const signal=mock.importFile.mock.calls[0][1] as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  expect(mock.stop).toHaveBeenCalled();
});
it('supports retained custom audio and stops preview on mute and unmount', () => {
  mock.snapshot={...mock.snapshot,hasImportedClip:true,importedName:'my-sound.mp3',previewingId:'custom'};
  const {rerender,unmount}=render(<PlatformNotificationSoundSettings/>);
  expect(screen.getByRole('radio',{name:'Imported: my-sound.mp3'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Stop'}));
  expect(mock.stop).toHaveBeenCalled();
  mock.enabled=false; rerender(<PlatformNotificationSoundSettings/>);
  for(const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  unmount(); expect(mock.stop.mock.calls.length).toBeGreaterThanOrEqual(3);
});
it('routes preview to the selected option', () => {
  render(<PlatformNotificationSoundSettings/>);
  fireEvent.click(screen.getAllByRole('button',{name:'Preview'})[2]);
  expect(mock.preview).toHaveBeenCalledWith('one_piece');
});
