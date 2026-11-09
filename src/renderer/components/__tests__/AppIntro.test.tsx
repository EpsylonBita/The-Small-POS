import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Props = Record<string, unknown> & { children?: React.ReactNode };
const strip = ({ initial: _i, animate: _a, transition: _t, ...props }: Props) => props;

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: Props) => <div {...(strip(props) as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>,
    img: (props: Props) => (
      <img
        {...(strip(props) as React.ImgHTMLAttributes<HTMLImageElement>)}
        data-initial={JSON.stringify(props.initial)}
        data-animate={JSON.stringify(props.animate)}
      />
    ),
    video: React.forwardRef<HTMLVideoElement, Props>((props, ref) => (
      <video ref={ref} {...(strip(props) as React.VideoHTMLAttributes<HTMLVideoElement>)} />
    )),
  },
}));

import AppIntro, {
  INTRO_GLIDE_S,
  INTRO_HANDOVER_S,
  INTRO_LAND_AT_S,
  INTRO_MAX_MS,
  INTRO_SETTLE_S,
  INTRO_START_MAX_MS,
  handoverRect,
  introFrame,
  shouldPlayAppIntro,
} from '../AppIntro';
import { logoArtMatch } from '../../../../../shared/pos/intro-logo-art';

/**
 * Founder 31/10: the clip plays as the till starts, then its logo goes to its place on the sign-in card.
 * Bounded timers only: a clip that never starts, or a key/tap, lands it; the sign-in logo stays hidden until
 * the moving one is on it.
 */
describe('AppIntro', () => {
  let play: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => new Promise<void>(() => undefined));
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    delete document.documentElement.dataset.appIntro;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function signInLogo() {
    const logo = document.createElement('img');
    logo.setAttribute('data-login-logo', '');
    logo.getBoundingClientRect = () => ({ left: 600, top: 40, width: 112, height: 112, right: 712, bottom: 152, x: 600, y: 40, toJSON: () => ({}) });
    document.body.appendChild(logo);
  }

  it('plays the clip muted at once and keeps the sign-in logo hidden while it shows', () => {
    const onGone = vi.fn();
    render(<AppIntro onGone={onGone} />);
    const clip = screen.getByTestId('app-intro-clip') as HTMLVideoElement;
    expect(clip.muted).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.appIntro).toBe('on');
    expect(screen.queryByTestId('app-intro-logo')).toBeNull();
  });

  it('lands when the pearl has settled, shows the real logo once the moving one is on it, then leaves', () => {
    signInLogo();
    const onGone = vi.fn();
    render(<AppIntro onGone={onGone} />);
    const clip = screen.getByTestId('app-intro-clip') as HTMLVideoElement;
    act(() => { clip.dispatchEvent(new Event('playing')); });
    act(() => { vi.advanceTimersByTime(INTRO_LAND_AT_S * 1000 - 1); });
    expect(screen.queryByTestId('app-intro-logo')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    const moving = screen.getByTestId('app-intro-logo');
    // It flies in the sign-in logo's own box.
    expect(moving.style.left).toBe('600px');
    expect(moving.style.width).toBe('112px');
    act(() => { vi.advanceTimersByTime((INTRO_HANDOVER_S + INTRO_GLIDE_S) * 1000 - 1); });
    expect(document.documentElement.dataset.appIntro).toBe('on');
    act(() => { vi.advanceTimersByTime(1); });
    expect(document.documentElement.dataset.appIntro).toBeUndefined();
    expect(onGone).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(INTRO_SETTLE_S * 1000 + 50); });
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  // Founder's phone, 07/11/2026: on the way to the light sign-in logo the dark logo fades into the light one, which
  // draws the logo about 3% smaller; for a moment two logos showed at different sizes.
  it('in the light theme the fading logos share one artwork, and the light one ends at the sign-in size', () => {
    signInLogo();
    render(<AppIntro onGone={vi.fn()} />);
    act(() => { screen.getByTestId('app-intro-clip').dispatchEvent(new Event('playing')); });
    act(() => { vi.advanceTimersByTime(INTRO_LAND_AT_S * 1000); });
    const motionOf = (testId: string) => {
      const image = screen.getByTestId(testId);
      return { initial: JSON.parse(image.dataset.initial ?? '{}'), animate: JSON.parse(image.dataset.animate ?? '{}') };
    };
    const still = { x: 0, y: 0, scale: 1 };
    const dark = motionOf('app-intro-logo-dark');
    const light = motionOf('app-intro-logo-light');
    expect(dark.initial).toMatchObject({ opacity: 1, ...still });
    expect(dark.animate).toMatchObject({ opacity: 0, ...logoArtMatch('dark', 'light', 112) });
    expect(light.initial).toMatchObject({ opacity: 0, ...logoArtMatch('light', 'dark', 112) });
    expect(light.animate).toMatchObject({ opacity: 1, ...still });
  });

  it('a clip that never starts never holds the till', () => {
    signInLogo();
    const onGone = vi.fn();
    render(<AppIntro onGone={onGone} />);
    act(() => { vi.advanceTimersByTime(INTRO_START_MAX_MS); });
    expect(screen.getByTestId('app-intro-logo')).toBeTruthy();
    act(() => { vi.advanceTimersByTime((INTRO_HANDOVER_S + INTRO_GLIDE_S + INTRO_SETTLE_S) * 1000 + 50); });
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(INTRO_MAX_MS).toBeLessThan(10_000);
  });

  it('a key skips to the landing and never reaches the sign-in keypad', () => {
    signInLogo();
    const keypad = vi.fn();
    window.addEventListener('keydown', keypad);
    render(<AppIntro onGone={vi.fn()} />);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', cancelable: true })); });
    expect(keypad).not.toHaveBeenCalled();
    expect(screen.getByTestId('app-intro-logo')).toBeTruthy();
    // Once it is landing, keys go through again.
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' })); });
    expect(keypad).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', keypad);
  });

  it('a tap skips to the landing', () => {
    signInLogo();
    render(<AppIntro onGone={vi.fn()} />);
    act(() => { screen.getByTestId('app-intro').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(screen.getByTestId('app-intro-logo')).toBeTruthy();
  });

  it('with no sign-in screen (a restored session) it only fades away over the till', () => {
    const onGone = vi.fn();
    render(<AppIntro onGone={onGone} />);
    const clip = screen.getByTestId('app-intro-clip') as HTMLVideoElement;
    act(() => { clip.dispatchEvent(new Event('error')); });
    expect(document.documentElement.dataset.appIntro).toBeUndefined();
    act(() => { vi.advanceTimersByTime((INTRO_HANDOVER_S + INTRO_GLIDE_S) * 1000 + 50); });
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('the logo image takes over the clip where the clip shows the logo, scaled with the clip', () => {
    const rect = handoverRect({ left: 100, top: 50, size: 1000 });
    expect(rect.size).toBeCloseTo(873);
    expect(rect.left).toBeCloseTo(164);
    expect(rect.top).toBeCloseTo(120.2);
  });

  it('starts covering the whole window, then pulls back to a square that shows the whole logo', () => {
    // Founder 31/10: «δεν είναι σε όλη την οθόνη».
    const { clip, cover } = introFrame(1280, 800);
    expect(clip).toEqual({ left: 272, top: 32, size: 736 });
    expect(clip.size * cover).toBe(1280);
  });

  it('reduce motion gets no intro', () => {
    const win = { matchMedia: (query: string) => ({ matches: query.includes('reduce') }) } as unknown as Window;
    expect(shouldPlayAppIntro(win)).toBe(false);
    const calm = { matchMedia: () => ({ matches: false }) } as unknown as Window;
    expect(shouldPlayAppIntro(calm)).toBe(true);
  });
});
