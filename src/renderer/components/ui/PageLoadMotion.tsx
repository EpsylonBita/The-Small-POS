import React, { memo } from 'react';
import {
  motion,
  stagger,
  useAnimate,
  useReducedMotion,
  type HTMLMotionProps,
  type Transition,
  type Variants,
} from 'framer-motion';
import { cn } from '../../utils/cn';
import {
  pageMotionEase,
  POS_MOTION_BASE_S,
  POS_MOTION_FAST_S,
  POS_MOTION_SLOW_S,
  POS_MOTION_STAGGER_S,
} from './page-motion';

type PageLoadMotionProps = HTMLMotionProps<'div'> & {
  children: React.ReactNode;
  animationKey?: string;
};

// The shared till timings (page-motion.ts): a page enters in 240 ms and leaves in 150 ms.
const pageTransition: Transition = {
  duration: POS_MOTION_SLOW_S,
  ease: pageMotionEase,
};

const pageVariants: Variants = {
  initial: {
    opacity: 0,
    y: 8,
    scale: 0.99,
  },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      ...pageTransition,
      when: 'beforeChildren',
      staggerChildren: POS_MOTION_STAGGER_S,
    },
  },
  exit: {
    opacity: 0,
    y: -4,
    scale: 0.99,
    transition: {
      duration: POS_MOTION_FAST_S,
      ease: pageMotionEase,
    },
  },
};

// "Reduce motion": the page swaps at once (no fade, no wait for an exit).
const reducedMotionVariants: Variants = {
  initial: { opacity: 1 },
  animate: { opacity: 1, transition: { duration: 0 } },
  exit: { opacity: 0, transition: { duration: 0 } },
};

const ELEMENT_SKIP_SELECTOR = '.fixed, [role="dialog"], [data-page-motion-skip="true"]';

const getPageLoadTargets = (root: HTMLElement): HTMLElement[] => {
  const topLevelChildren = Array.from(root.children).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      !element.matches(ELEMENT_SKIP_SELECTOR) &&
      element.offsetParent !== null
  );

  const nestedChildren = topLevelChildren.flatMap((element) =>
    Array.from(element.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        !child.matches(ELEMENT_SKIP_SELECTOR) &&
        child.offsetParent !== null
    )
  );

  // At most 8 steps: the rest of the page is already there.
  return (nestedChildren.length > 1 ? nestedChildren : topLevelChildren).slice(0, 8);
};

export const PageLoadMotion = memo<PageLoadMotionProps>(({ children, className, animationKey, ...props }) => {
  const shouldReduceMotion = useReducedMotion();
  const [scope, animate] = useAnimate<HTMLDivElement>();

  React.useEffect(() => {
    if (shouldReduceMotion || !scope.current) {
      return;
    }

    const targets = getPageLoadTargets(scope.current);
    if (targets.length === 0) {
      return;
    }

    const controls = animate(
      targets,
      {
        opacity: [0, 1],
        y: [6, 0],
      },
      {
        duration: POS_MOTION_BASE_S,
        ease: pageMotionEase,
        delay: stagger(POS_MOTION_STAGGER_S),
      }
    );

    return () => controls.stop();
  }, [animate, animationKey, scope, shouldReduceMotion]);

  return (
    <motion.div
      ref={scope}
      initial="initial"
      animate="animate"
      exit="exit"
      data-page-load-motion="true"
      variants={shouldReduceMotion ? reducedMotionVariants : pageVariants}
      className={cn('will-change-transform', className)}
      {...props}
    >
      {children}
    </motion.div>
  );
});

PageLoadMotion.displayName = 'PageLoadMotion';

export default PageLoadMotion;
