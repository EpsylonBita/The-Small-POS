import type { Transition, Variants } from 'framer-motion';

// Shared till motion (UI audit wave 5): the same ease-out and timings as the CSS tokens
// --pos-ease and --pos-motion-* in styles/glassmorphism.css. Short, no overshoot.
export const pageMotionEase = [0.2, 0.8, 0.2, 1] as const;
export const POS_MOTION_FAST_S = 0.15;
export const POS_MOTION_BASE_S = 0.18;
export const POS_MOTION_SLOW_S = 0.24;
/** Items of a list appear 30 ms apart, at most 8 steps (210 ms). */
export const POS_MOTION_STAGGER_S = 0.03;
export const POS_MOTION_STAGGER_MAX_S = 0.21;

export const pageMotionContainer: Variants = {
  hidden: { opacity: 1 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: POS_MOTION_STAGGER_S,
    },
  },
};

export const pageMotionItem: Variants = {
  hidden: {
    opacity: 0,
    y: 6,
  },
  show: {
    opacity: 1,
    y: 0,
    transition: {
      duration: POS_MOTION_BASE_S,
      ease: pageMotionEase,
    },
  },
};

export const createPageMotionTransition = (index = 0): Transition => ({
  duration: POS_MOTION_BASE_S,
  ease: pageMotionEase,
  delay: Math.min(index * POS_MOTION_STAGGER_S, POS_MOTION_STAGGER_MAX_S),
});
