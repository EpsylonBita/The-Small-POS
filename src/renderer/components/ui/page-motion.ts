import type { Transition, Variants } from 'framer-motion';

export const pageMotionEase = [0.22, 1, 0.36, 1] as const;

export const pageMotionContainer: Variants = {
  hidden: { opacity: 1 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.055,
      delayChildren: 0.04,
    },
  },
};

export const pageMotionItem: Variants = {
  hidden: {
    opacity: 0,
    y: 20,
  },
  show: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.34,
      ease: pageMotionEase,
    },
  },
};

export const createPageMotionTransition = (index = 0): Transition => ({
  duration: 0.34,
  ease: pageMotionEase,
  delay: Math.min(index * 0.055, 0.45),
});
