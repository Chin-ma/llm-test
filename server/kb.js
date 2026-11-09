// Knowledge base: small enough to put entirely in the prompt (see README for when this stops working).
export const KNOWLEDGE_BASE = [
  ['Shipping', 'Orders ship within 24 hours, Monday to Saturday. Delivery takes 3-5 business days in metro cities and 5-8 business days elsewhere in India.'],
  ['Address change', 'The delivery address can be changed only before the order has shipped, and only if the customer contacts us within 12 hours of placing it. After shipping, the address cannot be changed.'],
  ['Cancellation', 'An order can be cancelled before it ships. After it ships, the customer can refuse delivery and a refund is issued once the parcel returns to us.'],
  ['Returns', 'Returns are accepted within 7 days of delivery for unopened, unused products. Opened products are accepted only if damaged or if the wrong item was sent.'],
  ['Refunds', 'Approved refunds go back to the original payment method within 5-7 business days after we receive the returned parcel.'],
  ['Cash on delivery', 'Cash on delivery is available for orders under ₹3,000, with a ₹50 fee.'],
  ['Ingredients', 'All Verdant & Co products are fragrance-free and vegan.'],
];

export const kbAsText = () => KNOWLEDGE_BASE.map(([t, p]) => `- ${t}: ${p}`).join('\n');
