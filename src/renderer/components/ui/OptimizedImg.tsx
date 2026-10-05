import React, { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';

export type OptimizedImgProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  fallbackSrc?: string;
};

// Lightweight <img> wrapper for the desktop renderer
// - Defaults: loading="lazy", decoding="async"
// - Graceful fallback when src is missing or fails
export const OptimizedImg: React.FC<OptimizedImgProps> = ({
  src,
  alt = '',
  className,
  style,
  loading = 'lazy',
  decoding = 'async',
  onError,
  fallbackSrc,
  ...rest
}) => {
  const [failedFor, setFailedFor] = useState<{ src: typeof src } | null>(null);
  useEffect(() => setFailedFor(null), [src, fallbackSrc]);
  const failed = failedFor !== null && failedFor.src === src;

  const effectiveSrc = !failed ? src : fallbackSrc;

  if (!effectiveSrc) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500 ${className ?? ''}`}
        style={style}
        role="img"
        aria-label={alt}
      >
        <ImageOff className="w-6 h-6" aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      key={typeof effectiveSrc === 'string' ? effectiveSrc : undefined}
      src={effectiveSrc}
      alt={alt}
      className={className}
      style={style}
      loading={loading as any}
      decoding={decoding as any}
      onError={(e) => { setFailedFor({ src }); onError?.(e as any); }}
      {...rest}
    />
  );
};
