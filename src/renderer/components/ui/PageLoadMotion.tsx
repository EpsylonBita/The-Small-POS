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

type PageLoadMotionProps = HTMLMotionProps<'div'> & {
  children: React.ReactNode;
  animationKey?: string;
};

const pageTransition: Transition = {
  duration: 0.36,
  ease: [0.22, 1, 0.36, 1],
};

const pageVariants: Variants = {
  initial: {
    opacity: 0,
    y: 18,
    scale: 0.985,
  },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      ...pageTransition,
      when: 'beforeChildren',
      staggerChildren: 0.035,
      delayChildren: 0.04,
    },
  },
  exit: {
    opacity: 0,
    y: -10,
    scale: 0.99,
    transition: {
      duration: 0.16,
      ease: 'easeOut',
    },
  },
};

const reducedMotionVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.16 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
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

  return (nestedChildren.length > 1 ? nestedChildren : topLevelChildren).slice(0, 18);
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
        y: [12, 0],
      },
      {
        duration: 0.34,
        ease: [0.22, 1, 0.36, 1],
        delay: stagger(0.035, { startDelay: 0.06 }),
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
