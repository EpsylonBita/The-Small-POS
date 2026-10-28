// zod 4 compiles object parsers with `new Function` unless `jitless` is set, and
// decides that when each object schema is defined. The renderer CSP has no
// 'unsafe-eval', so the probe would be reported as a securitypolicyviolation on
// every load. index.tsx imports this first, before any module defines a schema.
import { z } from "zod";

z.config({ jitless: true });
