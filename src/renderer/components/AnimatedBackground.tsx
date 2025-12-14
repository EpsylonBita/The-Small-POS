'use client'

import { motion } from 'framer-motion'
import { useTheme } from '../contexts/theme-context'

export default function AnimatedBackground() {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  return (
    <div className={`fixed inset-0 overflow-hidden ${isDark ? 'bg-black' : 'bg-white'}`}>
      {/* Light Theme Orbs - Black core with blue edges */}
      {!isDark && (
        <>
        {/* Lava lamp blob 1 */}
        <motion.div
          className="absolute w-[700px] h-[700px] rounded-full blur-[100px] opacity-70"
          style={{
            background: 'radial-gradient(circle, #000000 0%, #1e40af 35%, #3b82f6 55%, #60a5fa 70%, transparent 100%)',
            left: '-10%',
            top: '-10%',
          }}
          animate={{
            x: ['0vw', '70vw', '20vw', '50vw', '0vw'],
            y: ['0vh', '60vh', '30vh', '80vh', '0vh'],
            scale: [1, 1.4, 0.9, 1.2, 1],
          }}
          transition={{
            duration: 25,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 2 */}
        <motion.div
          className="absolute w-[600px] h-[600px] rounded-full blur-[90px] opacity-65"
          style={{
            background: 'radial-gradient(circle, #000000 0%, #1e40af 35%, #3b82f6 55%, #60a5fa 70%, transparent 100%)',
            right: '-10%',
            bottom: '-10%',
          }}
          animate={{
            x: ['0vw', '-60vw', '-20vw', '-40vw', '0vw'],
            y: ['0vh', '-50vh', '-70vh', '-30vh', '0vh'],
            scale: [1, 0.8, 1.3, 0.95, 1],
          }}
          transition={{
            duration: 22,
            delay: 2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 3 */}
        <motion.div
          className="absolute w-[550px] h-[550px] rounded-full blur-[85px] opacity-60"
          style={{
            background: 'radial-gradient(circle, #000000 0%, #1e40af 35%, #3b82f6 55%, #60a5fa 70%, transparent 100%)',
            left: '50%',
            top: '-10%',
          }}
          animate={{
            x: ['0vw', '-30vw', '20vw', '-10vw', '0vw'],
            y: ['0vh', '70vh', '40vh', '80vh', '0vh'],
            scale: [1, 1.2, 0.85, 1.1, 1],
          }}
          transition={{
            duration: 28,
            delay: 4,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 4 */}
        <motion.div
          className="absolute w-[650px] h-[650px] rounded-full blur-[95px] opacity-55"
          style={{
            background: 'radial-gradient(circle, #000000 0%, #1e40af 35%, #3b82f6 55%, #60a5fa 70%, transparent 100%)',
            left: '70%',
            bottom: '30%',
          }}
          animate={{
            x: ['0vw', '-50vw', '10vw', '-30vw', '0vw'],
            y: ['0vh', '40vh', '-20vh', '60vh', '0vh'],
            scale: [1, 1.3, 0.9, 1.15, 1],
          }}
          transition={{
            duration: 24,
            delay: 1,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 5 */}
        <motion.div
          className="absolute w-[500px] h-[500px] rounded-full blur-[80px] opacity-65"
          style={{
            background: 'radial-gradient(circle, #000000 0%, #1e40af 35%, #3b82f6 55%, #60a5fa 70%, transparent 100%)',
            left: '10%',
            bottom: '-10%',
          }}
          animate={{
            x: ['0vw', '60vw', '30vw', '80vw', '0vw'],
            y: ['0vh', '-60vh', '-30vh', '-50vh', '0vh'],
            scale: [1, 0.9, 1.25, 0.95, 1],
          }}
          transition={{
            duration: 26,
            delay: 3,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 6 */}
        <motion.div
          className="absolute w-[580px] h-[580px] rounded-full blur-[88px] opacity-60"
          style={{
            background: 'radial-gradient(circle, #000000 0%, #1e40af 35%, #3b82f6 55%, #60a5fa 70%, transparent 100%)',
            right: '30%',
            top: '40%',
          }}
          animate={{
            x: ['0vw', '40vw', '-35vw', '25vw', '0vw'],
            y: ['0vh', '-45vh', '55vh', '-25vh', '0vh'],
            scale: [1, 1.15, 0.95, 1.3, 1],
          }}
          transition={{
            duration: 27,
            delay: 5,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
        </>
      )}

      {/* Dark Theme Orbs - White core with blue edges */}
      {isDark && (
        <>
        {/* Lava lamp blob 1 */}
        <motion.div
          className="absolute w-[700px] h-[700px] rounded-full blur-[100px] opacity-50"
          style={{
            background: 'radial-gradient(circle, #ffffff 0%, #60a5fa 35%, #3b82f6 55%, #1e40af 70%, transparent 100%)',
            left: '-10%',
            top: '-10%',
          }}
          animate={{
            x: ['0vw', '70vw', '20vw', '50vw', '0vw'],
            y: ['0vh', '60vh', '30vh', '80vh', '0vh'],
            scale: [1, 1.4, 0.9, 1.2, 1],
          }}
          transition={{
            duration: 25,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 2 */}
        <motion.div
          className="absolute w-[600px] h-[600px] rounded-full blur-[90px] opacity-45"
          style={{
            background: 'radial-gradient(circle, #ffffff 0%, #60a5fa 35%, #3b82f6 55%, #1e40af 70%, transparent 100%)',
            right: '-10%',
            bottom: '-10%',
          }}
          animate={{
            x: ['0vw', '-60vw', '-20vw', '-40vw', '0vw'],
            y: ['0vh', '-50vh', '-70vh', '-30vh', '0vh'],
            scale: [1, 0.8, 1.3, 0.95, 1],
          }}
          transition={{
            duration: 22,
            delay: 2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 3 */}
        <motion.div
          className="absolute w-[550px] h-[550px] rounded-full blur-[85px] opacity-40"
          style={{
            background: 'radial-gradient(circle, #ffffff 0%, #60a5fa 35%, #3b82f6 55%, #1e40af 70%, transparent 100%)',
            left: '50%',
            top: '-10%',
          }}
          animate={{
            x: ['0vw', '-30vw', '20vw', '-10vw', '0vw'],
            y: ['0vh', '70vh', '40vh', '80vh', '0vh'],
            scale: [1, 1.2, 0.85, 1.1, 1],
          }}
          transition={{
            duration: 28,
            delay: 4,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 4 */}
        <motion.div
          className="absolute w-[650px] h-[650px] rounded-full blur-[95px] opacity-35"
          style={{
            background: 'radial-gradient(circle, #ffffff 0%, #60a5fa 35%, #3b82f6 55%, #1e40af 70%, transparent 100%)',
            left: '70%',
            bottom: '30%',
          }}
          animate={{
            x: ['0vw', '-50vw', '10vw', '-30vw', '0vw'],
            y: ['0vh', '40vh', '-20vh', '60vh', '0vh'],
            scale: [1, 1.3, 0.9, 1.15, 1],
          }}
          transition={{
            duration: 24,
            delay: 1,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 5 */}
        <motion.div
          className="absolute w-[500px] h-[500px] rounded-full blur-[80px] opacity-45"
          style={{
            background: 'radial-gradient(circle, #ffffff 0%, #60a5fa 35%, #3b82f6 55%, #1e40af 70%, transparent 100%)',
            left: '10%',
            bottom: '-10%',
          }}
          animate={{
            x: ['0vw', '60vw', '30vw', '80vw', '0vw'],
            y: ['0vh', '-60vh', '-30vh', '-50vh', '0vh'],
            scale: [1, 0.9, 1.25, 0.95, 1],
          }}
          transition={{
            duration: 26,
            delay: 3,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Lava lamp blob 6 */}
        <motion.div
          className="absolute w-[580px] h-[580px] rounded-full blur-[88px] opacity-40"
          style={{
            background: 'radial-gradient(circle, #ffffff 0%, #60a5fa 35%, #3b82f6 55%, #1e40af 70%, transparent 100%)',
            right: '30%',
            top: '40%',
          }}
          animate={{
            x: ['0vw', '40vw', '-35vw', '25vw', '0vw'],
            y: ['0vh', '-45vh', '55vh', '-25vh', '0vh'],
            scale: [1, 1.15, 0.95, 1.3, 1],
          }}
          transition={{
            duration: 27,
            delay: 5,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
        </>
      )}

      {/* Theme-based gradient overlay */}
      <div className={`absolute inset-0 bg-gradient-to-br ${isDark ? 'from-black/30 via-black/10 to-black/20' : 'from-white/30 via-white/10 to-white/20'}`} />

      {/* Glass blur effect */}
      <div className="absolute inset-0 backdrop-blur-[1px]" />

      {/* Grain/Noise Effect */}
      <div
        className={`absolute inset-0 pointer-events-none mix-blend-overlay ${isDark ? 'opacity-[0.12]' : 'opacity-[0.15]'}`}
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'repeat',
        }}
      />
    </div>
  )
}

