import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import introClip from '../assets/intro/the-small-intro.mp4';
import logoBlack from '../assets/logo-black.png';
import logoWhite from '../assets/logo-white.png';
import { logoArtMatch } from '../../../../shared/pos/intro-logo-art';

/**
 * Founder 31/10: «αυτό το βίντεο να μπαίνει μόλις τρέχει η εφαρμογή και μετά να πηγαίνει εκεί στη θέση του
 * στο login modal».
 *
 * The clip plays once when the till starts, on its own background: the silver rings come together and the
 * gold pearl drops into them. The clip is square, so it starts filling the whole window («σε όλη την οθόνη»)
 * and pulls back as the logo forms until all of it shows; its edges fade into a background of the clip's own
 * colour, so no square ever shows. Once the pearl has settled (INTRO_LAND_AT_S; the rest of the clip stands
 * still), the clip hands over to the logo image at exactly the same size and place, and that image glides
 * to the sign-in logo while the background fades and the sign-in card appears around it. A tap or a key
 * skips to the landing. Reduce motion and the customer/kitchen display windows get no intro.
 *
 * Never waits on the clip: bounded timers move it on even when the clip does not start or stalls (the motion
 * rule: nothing waits for an animation or a media event that may not come).
 */
export const INTRO_BACKGROUND = '#080a0b';
export const INTRO_LAND_AT_S = 6.4;
export const INTRO_HANDOVER_S = 0.18;
export const INTRO_GLIDE_S = 1.0;
export const INTRO_SETTLE_S = 0.3;
/** A clip that has not started by then is skipped. */
export const INTRO_START_MAX_MS = 2500;
/** The intro never holds the till longer than this before it lands. */
export const INTRO_MAX_MS = 9000;
/** Once pulled back, the clip's square fills this share of the window's shorter side. */
const CLIP_SIZE = 0.92;
/** Until the logo forms, the clip fills the whole window; then it pulls back to CLIP_SIZE. */
export const INTRO_PULL_BACK_AT_S = 3.0;
export const INTRO_PULL_BACK_S = 2.4;
/** The clip's edges fade out, so it melts into the background at every size. */
const CLIP_EDGE_MASK = 'radial-gradient(closest-side, #000 84%, transparent 100%)';
/**
 * Where the dark logo image goes over the clip's settled frame, as shares of the clip's side (measured 31/10).
 * They are two renders of the logo: matched on the outer rings, the image's pearl sits 4 px lower, and matched
 * on the pearl, the rings move 4 px. These split it, so neither is off by more than about 2 px:
 * - clip: rings 0.795 wide centred at (0.499, 0.499), pearl 0.206 wide centred at (0.4985, 0.494);
 * - image: rings 0.902, centred at (0.498, 0.4854); pearl 0.238, centred at (0.498, 0.4912).
 */
const HANDOVER = { left: 0.064, top: 0.0702, size: 0.873 } as const;

type Rect = { left: number; top: number; size: number };
type Landing = { from: Rect; to: Rect | null; dark: boolean };

/** While the intro shows, the sign-in logo stays hidden (globals.css: html[data-app-intro]). */
const INTRO_FLAG = 'appIntro';

export function shouldPlayAppIntro(win: Window = window): boolean {
    try {
        if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    } catch {
        // No media queries: play it.
    }
    return true;
}

/** The clip's square once pulled back, and how much larger it starts so that it covers the whole window. */
export function introFrame(width: number, height: number): { clip: Rect; cover: number } {
    const size = Math.min(width, height) * CLIP_SIZE;
    return { clip: { left: (width - size) / 2, top: (height - size) / 2, size }, cover: Math.max(width, height) / size };
}

/** The clip's background colour as this window draws it (its corner), so its square never shows. */
function clipBackground(video: HTMLVideoElement): string | null {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 4;
        canvas.height = 4;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(video, 0, 0, 4, 4, 0, 0, 4, 4);
        const pixels = context.getImageData(0, 0, 4, 4).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < pixels.length; i += 4) {
            sum[0] += pixels[i];
            sum[1] += pixels[i + 1];
            sum[2] += pixels[i + 2];
        }
        const [r, g, b] = sum.map((value) => Math.round(value / 16));
        // Only a dark corner is the clip's background; anything else keeps the measured colour.
        return r + g + b < 90 ? `rgb(${r}, ${g}, ${b})` : null;
    } catch {
        return null;
    }
}

/** The dark logo image's box that shows its logo where the clip shows it. */
export function handoverRect(clip: Rect): Rect {
    return {
        left: clip.left + HANDOVER.left * clip.size,
        top: clip.top + HANDOVER.top * clip.size,
        size: HANDOVER.size * clip.size,
    };
}

export default function AppIntro({ onGone }: { onGone: () => void }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const timersRef = useRef<number[]>([]);
    const landedRef = useRef(false);
    /** A tap anywhere skips to the landing. */
    const skipRef = useRef<(() => void) | null>(null);
    const [landing, setLanding] = useState<Landing | null>(null);
    const [{ clip, cover }] = useState(() => introFrame(window.innerWidth, window.innerHeight));
    const [playing, setPlaying] = useState(false);
    const [background, setBackground] = useState(INTRO_BACKGROUND);

    useEffect(() => {
        const root = document.documentElement;
        root.dataset[INTRO_FLAG] = 'on';
        const at = (ms: number, run: () => void) => {
            timersRef.current.push(window.setTimeout(run, Math.max(0, ms)));
        };
        const land = () => {
            if (landedRef.current) return;
            landedRef.current = true;
            videoRef.current?.pause();
            const dark = root.classList.contains('dark');
            const logo = document.querySelector<HTMLElement>('[data-login-logo]')?.getBoundingClientRect();
            const to = logo && logo.width > 0 ? { left: logo.left, top: logo.top, size: logo.width } : null;
            // Handed over as the dark logo, which is the clip's own picture; the light theme turns it into
            // the light logo on the way, as the background brightens.
            setLanding({ from: handoverRect(clip), to, dark });
            if (to) {
                // The image is on the sign-in logo: show the real one under it, then let the image go.
                at((INTRO_HANDOVER_S + INTRO_GLIDE_S) * 1000, () => delete root.dataset[INTRO_FLAG]);
                at((INTRO_HANDOVER_S + INTRO_GLIDE_S + INTRO_SETTLE_S) * 1000 + 50, onGone);
            } else {
                // No sign-in screen (a session was restored): the intro only fades away over the till.
                delete root.dataset[INTRO_FLAG];
                at((INTRO_HANDOVER_S + INTRO_GLIDE_S) * 1000 + 50, onGone);
            }
        };

        const video = videoRef.current;
        let started = false;
        const onPlaying = () => {
            if (started) return;
            started = true;
            setPlaying(true);
            const drawn = video ? clipBackground(video) : null;
            if (drawn) setBackground(drawn);
            at((INTRO_LAND_AT_S - (video?.currentTime ?? 0)) * 1000, land);
        };
        video?.addEventListener('playing', onPlaying);
        video?.addEventListener('error', land);
        video?.play()?.catch(land);
        at(INTRO_START_MAX_MS, () => {
            if (!started) land();
        });
        at(INTRO_MAX_MS, land);

        // A key skips to the landing and never reaches the sign-in keypad underneath.
        const onKey = (event: KeyboardEvent) => {
            if (landedRef.current) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            land();
        };
        window.addEventListener('keydown', onKey, true);
        skipRef.current = land;

        return () => {
            timersRef.current.forEach((timer) => window.clearTimeout(timer));
            timersRef.current = [];
            video?.removeEventListener('playing', onPlaying);
            video?.removeEventListener('error', land);
            window.removeEventListener('keydown', onKey, true);
            delete root.dataset[INTRO_FLAG];
        };
        // One run per launch.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const total = INTRO_HANDOVER_S + INTRO_GLIDE_S + INTRO_SETTLE_S;
    const to = landing?.to;
    const from = landing?.from;

    return (
        <div
            data-testid="app-intro"
            aria-hidden="true"
            className="fixed inset-0"
            style={{ zIndex: 2147483000, pointerEvents: landing ? 'none' : 'auto', cursor: 'default', overflow: 'hidden' }}
            onPointerDown={() => skipRef.current?.()}
        >
            <motion.div
                className="absolute inset-0"
                style={{ background }}
                initial={false}
                animate={{ opacity: landing ? 0 : 1 }}
                // Starts once the clip has gone, so its square never shows against a brightening window.
                transition={{ delay: landing ? INTRO_HANDOVER_S + 0.03 : 0, duration: INTRO_GLIDE_S * 0.9, ease: 'easeInOut' }}
            />
            <motion.video
                ref={videoRef}
                data-testid="app-intro-clip"
                src={introClip}
                muted
                playsInline
                preload="auto"
                disablePictureInPicture
                className="absolute"
                style={{
                    left: clip.left,
                    top: clip.top,
                    width: clip.size,
                    height: clip.size,
                    objectFit: 'contain',
                    maskImage: CLIP_EDGE_MASK,
                    WebkitMaskImage: CLIP_EDGE_MASK,
                    willChange: 'transform',
                }}
                initial={false}
                // Fills the window, then pulls back as the logo forms. The logo image fades in over it first (no
                // dip in brightness); the clip leaves once covered.
                animate={{ opacity: landing ? 0 : 1, scale: playing || landing ? 1 : cover }}
                transition={{
                    opacity: { delay: landing ? INTRO_HANDOVER_S : 0, duration: 0.01, ease: 'linear' },
                    scale: landing
                        ? { duration: INTRO_HANDOVER_S, ease: 'easeOut' }
                        : { delay: INTRO_PULL_BACK_AT_S, duration: INTRO_PULL_BACK_S, ease: [0.45, 0, 0.25, 1] },
                }}
            />
            {landing && from && (
                <motion.div
                    data-testid="app-intro-logo"
                    className="absolute"
                    style={
                        to
                            ? { left: to.left, top: to.top, width: to.size, height: to.size, transformOrigin: '0 0', willChange: 'transform' }
                            : { left: from.left, top: from.top, width: from.size, height: from.size }
                    }
                    initial={
                        to
                            ? { opacity: 0, x: from.left - to.left, y: from.top - to.top, scale: from.size / to.size }
                            : { opacity: 0 }
                    }
                    animate={
                        to
                            ? {
                                // Takes over from the clip in place, glides to the sign-in logo, then the real one shows.
                                opacity: [0, 1, 1, 0],
                                x: [from.left - to.left, from.left - to.left, 0, 0],
                                y: [from.top - to.top, from.top - to.top, 0, 0],
                                scale: [from.size / to.size, from.size / to.size, 1, 1],
                                transition: {
                                    duration: total,
                                    times: [0, INTRO_HANDOVER_S / total, (INTRO_HANDOVER_S + INTRO_GLIDE_S) / total, 1],
                                    ease: ['linear', [0.25, 0.8, 0.3, 1], 'linear'],
                                },
                            }
                            : {
                                opacity: [0, 1, 0],
                                transition: { duration: INTRO_HANDOVER_S + INTRO_GLIDE_S, times: [0, 0.2, 1], ease: 'easeInOut' },
                            }
                    }
                >
                    {[logoBlack, ...(landing.dark ? [] : [logoWhite])].map((src, index) => {
                        // The light image draws the logo about 3% smaller: while one fades into the other, each moves
                        // onto the other's artwork, so one logo shows, never two of different sizes (founder, 07/11/2026).
                        const box = (to ?? from).size;
                        const fadingIn = index === 1;
                        const moved = fadingIn ? logoArtMatch('light', 'dark', box) : logoArtMatch('dark', 'light', box);
                        const still = { x: 0, y: 0, scale: 1 };
                        const fades = !landing.dark;
                        const [start, end] = fadingIn ? [moved, still] : [still, fades ? moved : still];
                        return (
                            <motion.img
                                key={src}
                                src={src}
                                alt=""
                                data-testid={fadingIn ? 'app-intro-logo-light' : 'app-intro-logo-dark'}
                                className="absolute inset-0 w-full h-full object-contain"
                                initial={{ opacity: index === 0 ? 1 : 0, ...start }}
                                animate={{ opacity: landing.dark || index === 1 ? 1 : 0, ...end }}
                                transition={{ delay: INTRO_HANDOVER_S + INTRO_GLIDE_S * 0.15, duration: INTRO_GLIDE_S * 0.7, ease: 'easeInOut' }}
                            />
                        );
                    })}
                </motion.div>
            )}
        </div>
    );
}
