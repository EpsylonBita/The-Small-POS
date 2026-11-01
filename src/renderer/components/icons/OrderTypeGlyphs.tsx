import React from 'react';

interface OrderTypeGlyphProps {
  className?: string;
}

// Founder 31/10 («για διανομή το πρώτο και για παραλαβή το δεύτερο», his references): the order rows'
// delivery and pickup glyphs. Traced in the references' own pixels, so the numbers line up with them;
// drawn in currentColor, a touch heavier than the 9 px reference lines so they hold at row size.
// The same outlines live in POSSystemMobile's OrderTypeGlyphs.

/** Delivery: a rider in a helmet on a scooter, the box behind the seat, two speed lines. */
export const DeliveryScooterIcon: React.FC<OrderTypeGlyphProps> = ({ className }) => (
  <svg viewBox="30.5 15 244 244" fill="none" stroke="currentColor" strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    <path d="M61.5 25 H124.5 M37.5 41.5 H84.5" />
    <path d="M152.5 67 C157 71 162 72.5 167 72.5 C177.5 72.5 186 64 186 51 V47 C186 35 176 26 164 26 C152 26 142.5 35 142.5 47 V51 C142.5 55 145 57.5 149 57.5 H157 C161 57.5 163.5 55 164.5 51 C165.5 47.5 167 46 171 46 H186" />
    <path d="M114 161.5 C105 161.5 100 157 99.5 148 L99 132 C99 110 106 93 116 85 C121 81 127 79 133 79 C144 79 152 85 158 93 L166 104 C168.5 107.5 171.5 109.5 176 110 L202.5 113.5 C207.5 114 211 117 211 121 C211 125.5 207.5 128.5 203 128.5 L170 126 C165 125.5 161 123.5 158 120 L138.5 97" />
    <path d="M209 121.5 C213.5 123.5 218.5 126.5 220.5 131.5 L231.5 194" />
    <rect x="223" y="98.5" width="23.5" height="21" rx="9" />
    <path d="M140.5 121.5 L138 137.5 C150 139 165 141 175 144.5 C183 147.5 188.5 152 188.5 160 V202" />
    <path d="M85 161.5 V106 H37.5 V161.5 H140 C152 162 162 164 165 168 C166.5 172 167 176 167.5 180 L172.5 210 C173.5 219 178 226 186 226" />
    <path d="M52 120.5 H85" />
    <path d="M44.5 226 L53 197 C57 184 66 174 78 168 C86 164 93 162 100 161.5" />
    <path d="M128 161.5 C135.5 161.5 140.5 166.5 140.5 174 V208 C140.5 218 147 226 157 226" />
    <path d="M76 201 H110" />
    <path d="M205 145.5 V208 C205 218 200 226 190 226 H44.5" />
    <path d="M72 236.5 A21.5 21.5 0 0 0 114 228.5" />
    <path d="M225 236.5 A23.5 23.5 0 1 0 265 213.5" />
    <path d="M213 225 C213 206 229 193.5 244 193.5 C254 193.5 262 196 266 200 C258 211 243 225 213 225 Z" />
  </svg>
);

/** Pickup: a hand holding a folded paper bag by its top, a fork and a knife on the front. */
export const PickupHandBagIcon: React.FC<OrderTypeGlyphProps> = ({ className }) => (
  <svg viewBox="31 28 250 250" fill="none" stroke="currentColor" strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    <rect x="241" y="33" width="31.5" height="51" rx="3" />
    <path d="M241 40 H150.5 L106 64" />
    <path d="M158.5 87.5 H56.5 A7.5 7.5 0 0 1 49 80 V71.5 A7.5 7.5 0 0 1 56.5 64 H182 L154 92 C149.5 96.5 149 103 151.5 108 C154.5 113.5 160 115.5 166 114 C168.5 113.3 171 112 173 110.5 L190 98.5 C194 95.5 198 94 204 93.5 C213 93 219 90 222 85 C224 81.5 224.5 78 226 75.5 C227.5 73.5 229 73 232 73 H241" />
    <path d="M60 91 L40.5 155 V268 Q40.5 272 44.5 272 H220 V153 L200.5 96.5 L181 153 V272" />
    <path d="M200.5 163.5 V251 M181 270 L200.5 251 L220 270" />
    <path d="M72.5 157.5 V172 M89 157.5 V172 M104.5 157.5 V172" />
    <path d="M73.5 172 H104 L97 189 H80.5 Z" />
    <path d="M80.5 189 L77.5 233 Q77 243 87 243 H91 Q101 243 100.5 233 L97 189" />
    <path d="M140.5 205 V160 C140.5 156.5 137.5 155.5 134.5 157.5 C124 164 118.5 176 117 190 L116.5 195 L123.5 205 Z" />
    <path d="M123.5 205 L121.5 236 Q121 243 128.5 243 H136 Q143.5 243 143 236 L141 205" />
  </svg>
);
